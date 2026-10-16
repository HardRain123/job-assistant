import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Application, Job } from "../../../packages/contracts/src/index.ts";
import { Store } from "../../../packages/storage/src/index.ts";
import { canonicalJobUrl } from "./automation.ts";
import { equal } from "./security.ts";

const lifetimeMs = 5 * 60_000;
const prefix = "chatDiagnostic.";
const applicationSchema = z.object({ applicationId: z.string().uuid() }).strict();
const evidenceText = z.string().min(1).max(48).refine(
  (value) => value.trim().length > 0 && !/[\p{Cc}\p{Cf}<>]/u.test(value),
  "诊断字段仅允许不含控制字符或标记的简短文字",
);
const headerEvidenceSchema = z.object({
  names: z.array(evidenceText).max(3),
  roles: z.array(evidenceText).max(3),
}).strict();
const resultSchema = z.object({
  id: z.string().uuid(),
  applicationId: z.string().uuid(),
  leaseToken: z.string().uuid(),
  outcome: z.enum(["observed", "not-found", "ambiguous", "unavailable"]),
  headerEvidence: headerEvidenceSchema.optional(),
}).strict().refine(
  (value) => (value.outcome === "observed") === (value.headerEvidence !== undefined),
  "仅已观察到的聊天标题可以包含诊断字段",
);

type DiagnosticJob = Pick<Job, "url" | "title" | "company" | "companyAliases" | "location" | "salaryMin" | "salaryMax" | "salaryMonths">;
type DiagnosticResult = Pick<z.infer<typeof resultSchema>, "outcome" | "headerEvidence">;
interface DiagnosticRecord {
  id: string;
  applicationId: string;
  status: "pending" | "leased" | "completed" | "expired" | "invalidated";
  createdAt: string;
  expiresAt: string;
  applicationFingerprint: string;
  job: DiagnosticJob;
  leaseHash?: string;
  result?: DiagnosticResult;
}
interface Options {
  store: Store;
  status: () => { paired: boolean; lastSeen: string | null; version: string | null };
  now?: () => number;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const signature = (application: Application) => digest(JSON.stringify(application));
const active = (record: DiagnosticRecord | null) => record?.status === "pending" || record?.status === "leased";
const publicRecord = (record: DiagnosticRecord | null) => record ? {
  id: record.id,
  applicationId: record.applicationId,
  status: record.status,
  createdAt: record.createdAt,
  expiresAt: record.expiresAt,
  ...(record.result ? { result: record.result } : {}),
} : null;

// This channel is deliberately separate from the application task queue. Its
// observations never update an Application, action, quota, or send permission.
export function registerChatDiagnostics(app: FastifyInstance, o: Options) {
  const { store } = o;
  const now = o.now ?? Date.now;
  const recordKey = (id: string) => `${prefix}record:${id}`;
  const applicationKey = (id: string) => `${prefix}application:${id}`;
  const currentKey = `${prefix}current`;
  const ready = () => {
    const status = o.status();
    const numbers = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(status.version ?? "")
      ? status.version!.split(".").map(Number) : [];
    const recent = status.lastSeen ? Date.parse(status.lastSeen) : Number.NaN;
    const supported = numbers.length === 3 && (numbers[0]! > 0 || numbers[1]! > 4 || (numbers[1] === 4 && numbers[2]! >= 11));
    return status.paired && supported && Number.isFinite(recent) && now() - recent <= 90_000 && recent <= now();
  };
  const busy = () => {
    if (store.get("takeover", false)) return true;
    if (store.tasks().some((task) => task.kind === "apply" && ["queued", "leased"].includes(task.status))) return true;
    const automation = store.get<{ state: string } | null>("automation.current", null);
    const workflow = store.get<{ state: string } | null>("bulkWorkflow.current", null);
    const bulk = store.get<{ state: string } | null>("bulk.current", null);
    return !!((automation && ["running", "paused", "blocked"].includes(automation.state)) ||
      (workflow && ["running", "paused"].includes(workflow.state)) || bulk?.state === "running");
  };
  const subject = (applicationId: string) => {
    const application = store.application(applicationId);
    if (!application || application.executor !== "extension" || application.status !== "needs-review" ||
      application.job.source !== "boss" || application.job.id !== application.jobId) return null;
    try { canonicalJobUrl(application.job.url); } catch { return null; }
    return application;
  };
  const read = (id: string | null) => {
    if (!id) return null;
    const record = store.get<DiagnosticRecord | null>(recordKey(id), null);
    if (record && active(record)) {
      const application = subject(record.applicationId);
      const next = Date.parse(record.expiresAt) <= now() ? "expired" :
        !application || signature(application) !== record.applicationFingerprint ? "invalidated" : null;
      if (next) {
        record.status = next;
        store.set(recordKey(id), record);
        store.audit(`chatDiagnostic.${next}`, { id, applicationId: record.applicationId });
      }
    }
    return record;
  };

  app.post("/api/extension-application/diagnose", (req) => {
    const { applicationId } = applicationSchema.parse(req.body);
    return store.transaction(() => {
      if (!ready()) throw new Error("只读诊断需要连接 0.4.11 或更新版本的浏览器扩展");
      if (busy()) throw new Error("请等待采集、批次或投递任务结束，并退出浏览器接管后再诊断");
      const application = subject(applicationId);
      if (!application) throw new Error("仅能诊断待核验的 BOSS 扩展投递记录");
      const current = read(store.get<string | null>(currentKey, null));
      if (active(current)) {
        if (current!.applicationId !== applicationId) throw new Error("已有另一条只读诊断等待完成");
        return { diagnostic: publicRecord(current) };
      }
      const job = application.job;
      const record: DiagnosticRecord = {
        id: randomUUID(), applicationId, status: "pending",
        createdAt: new Date(now()).toISOString(),
        expiresAt: new Date(now() + lifetimeMs).toISOString(),
        applicationFingerprint: signature(application),
        job: { url: canonicalJobUrl(job.url), title: job.title, company: job.company,
          companyAliases: job.companyAliases, location: job.location,
          salaryMin: job.salaryMin, salaryMax: job.salaryMax, salaryMonths: job.salaryMonths },
      };
      store.set(recordKey(record.id), record);
      store.set(applicationKey(applicationId), record.id);
      store.set(currentKey, record.id);
      store.audit("chatDiagnostic.requested", { id: record.id, applicationId });
      return { diagnostic: publicRecord(record) };
    });
  });

  app.get("/api/extension-application/diagnose/:applicationId", (req) => {
    const { applicationId } = applicationSchema.parse(req.params);
    return store.transaction(() => ({ diagnostic: publicRecord(read(store.get<string | null>(applicationKey(applicationId), null))) }));
  });

  app.post("/extension/v1/application/diagnostic-claim", (req) => {
    z.object({}).strict().parse(req.body);
    return store.transaction(() => {
      const record = read(store.get<string | null>(currentKey, null));
      if (!ready() || busy() || record?.status !== "pending") return { task: null };
      const leaseToken = randomUUID();
      record.status = "leased";
      record.leaseHash = digest(leaseToken);
      store.set(recordKey(record.id), record);
      store.audit("chatDiagnostic.claimed", { id: record.id, applicationId: record.applicationId });
      return { task: { id: record.id, applicationId: record.applicationId, leaseToken, job: record.job } };
    });
  });

  app.post("/extension/v1/application/diagnostic-result", (req) => {
    const body = resultSchema.parse(req.body);
    return store.transaction(() => {
      const record = read(body.id);
      if (!record || record.applicationId !== body.applicationId || !record.leaseHash ||
        !equal(record.leaseHash, digest(body.leaseToken)) || Date.parse(record.expiresAt) <= now() ||
        !["leased", "completed"].includes(record.status)) throw new Error("只读诊断租约无效或已过期");
      if (!ready() || busy()) throw new Error("浏览器未就绪或已有任务，不能接受本次诊断");
      const result: DiagnosticResult = { outcome: body.outcome,
        ...(body.headerEvidence ? { headerEvidence: body.headerEvidence } : {}) };
      if (record.status === "completed") {
        if (JSON.stringify(record.result) !== JSON.stringify(result)) throw new Error("只读诊断结果已保存，不能覆盖");
        return { ok: true };
      }
      record.status = "completed";
      record.result = result;
      store.set(recordKey(record.id), record);
      store.audit("chatDiagnostic.completed", { id: record.id, applicationId: record.applicationId, outcome: result.outcome });
      return { ok: true };
    });
  });
}

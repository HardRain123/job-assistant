import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  Application,
  Assessment,
  Job,
  MatchPolicy,
} from "../../../packages/contracts/src/index.ts";
import { Store } from "../../../packages/storage/src/index.ts";

interface Options {
  store: Store;
  attachmentsDir: string;
  status: () => {
    paired: boolean;
    lastSeen: string | null;
    version: string | null;
  };
  draft: (ids: string[], manualReviewedId?: string) => Application[];
  assessment: (job: Job) => Assessment | null;
  policy: () => MatchPolicy;
  configurationKey: () => string;
}

type AttachmentManifest = { name: string; size: number; sha256: string };
function safeAttachment(
  attachmentsDir: string,
  name: string,
): { manifest: AttachmentManifest; buffer: Buffer } {
  if (name !== basename(name) || !/^[a-f0-9-]+\.(docx|pdf)$/.test(name))
    throw new Error("简历附件名称无效");
  try {
    const path = join(attachmentsDir, name);
    const file = lstatSync(path);
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.size <= 0 ||
      file.size > 10 * 1024 * 1024
    )
      throw new Error("简历附件无效");
    const buffer = readFileSync(path);
    if (buffer.length !== file.size) throw new Error("简历附件已变化");
    return {
      manifest: {
        name,
        size: buffer.length,
        sha256: createHash("sha256").update(buffer).digest("hex"),
      },
      buffer,
    };
  } catch {
    throw new Error("简历附件不可用或已变化");
  }
}
export function attachmentManifest(
  attachmentsDir: string,
  name: string | null,
): AttachmentManifest | null {
  return name ? safeAttachment(attachmentsDir, name).manifest : null;
}

const selectionSchema = z
  .object({
    jobId: z.string().uuid(),
    expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
    acceptReview: z.boolean(),
  })
  .strict();
const startSchema = selectionSchema.extend({
  expectedConfigurationKey: z.string().regex(/^[a-f0-9]{64}$/),
});
const leaseSchema = z
  .object({
    taskId: z.string().uuid(),
    leaseToken: z.string().uuid(),
  })
  .strict();
const identitySchema = leaseSchema.extend({ applicationId: z.string().uuid() });
const evidenceSchema = z.enum([
  "before-action",
  "new-message",
  "new-attachment",
  "existing-contact",
  "recipient-mismatch",
  "page-unrecognized",
  "login-required",
  "verification-required",
  "send-unconfirmed",
  "attachment-pending",
  "cancelled",
]);
const actionSchema = identitySchema.extend({
  actionId: z.string().uuid(),
  state: z.enum([
    "started",
    "confirmed",
    "unknown",
    "failed",
    "awaiting-acceptance",
    "skipped",
  ]),
  evidence: evidenceSchema,
});

export function registerExtensionApplication(app: FastifyInstance, o: Options) {
  const { store } = o;
  const configKey = (id: string) => `extensionApplication.configuration:${id}`;
  const attachmentKey = (id: string) => `extensionApplication.attachment:${id}`;
  const receiptKey = (id: string) => `extensionApplication.receipt:${id}`;
  const versionAtLeast = (version: string | null, minimum: number[]) => {
    const numbers = version?.split(".").map(Number);
    if (
      !numbers ||
      numbers.length !== 3 ||
      numbers.some((n) => !Number.isInteger(n))
    )
      return false;
    for (let i = 0; i < 3; i++) {
      if (numbers[i]! > minimum[i]!) return true;
      if (numbers[i]! < minimum[i]!) return false;
    }
    return true;
  };
  const requireConnection = () => {
    const status = o.status();
    if (
      !status.paired ||
      !versionAtLeast(status.version, [0, 3, 0]) ||
      !status.lastSeen ||
      Date.now() - Date.parse(status.lastSeen) > 90000
    )
      throw new Error("请先连接并启用最新版浏览器扩展");
  };
  const requireReady = () => {
    if (
      store.get("paused", false) ||
      store.get("takeover", false) ||
      store.get("browserUncertain", false)
    )
      throw new Error("队列已暂停或浏览器正在人工接管");
    const run = store.get<{ state?: string; phase?: string } | null>(
      "automation.current",
      null,
    );
    if (run?.state === "running" && run.phase === "collecting")
      throw new Error("请等待当前岗位采集结束");
    if (
      store
        .tasks()
        .some(
          (t) => t.kind === "apply" && ["queued", "leased"].includes(t.status),
        )
    )
      throw new Error("已有投递任务等待完成");
  };
  const prepare = (body: z.infer<typeof selectionSchema>) => {
    const job = store.job(body.jobId);
    if (
      !job ||
      job.contentHash !== body.expectedContentHash ||
      job.status !== "active"
    )
      throw new Error("岗位内容已变化，请重新核对");
    const assessment = o.assessment(job);
    const manualReview = assessment?.decision === "review";
    if (manualReview && !body.acceptReview)
      throw new Error("复核岗位需要明确确认");
    const draft = o.draft(
      [body.jobId],
      manualReview && body.acceptReview ? body.jobId : undefined,
    )[0]!;
    return { draft, manualReview };
  };
  const requireExtensionLease = (body: z.infer<typeof identitySchema>) => {
    const task = store.requireLease(body.taskId, body.leaseToken);
    if (
      task.kind !== "apply" ||
      (task.payload as Application).executor !== "extension" ||
      (task.payload as Application).id !== body.applicationId
    )
      throw new Error("投递任务不匹配");
    const application = store.application(body.applicationId);
    if (
      !application ||
      application.executor !== "extension" ||
      application.status !== "running"
    )
      throw new Error("投递记录不在运行中");
    return application;
  };
  const requireConfig = (application: Application) => {
    if (
      store.get<string | null>(configKey(application.id), null) !==
      o.configurationKey()
    )
      throw new Error("简历、话术或策略已变化，请人工核对");
    const frozen = store.get<AttachmentManifest | null>(
      attachmentKey(application.id),
      null,
    );
    const current = attachmentManifest(
      o.attachmentsDir,
      application.resumeAttachment,
    );
    if (JSON.stringify(frozen) !== JSON.stringify(current))
      throw new Error("简历附件已变化，请人工核对");
  };
  const requireFrozenJob = (application: Application) => {
    const current = store.job(application.jobId);
    if (
      !current ||
      current.status !== "active" ||
      current.contentHash !== application.job.contentHash
    )
      throw new Error("岗位内容已变化，请人工核对");
  };
  const requireBeginReady = (application: Application) => {
    if (
      store.get("paused", false) ||
      store.get("takeover", false) ||
      store.get("browserUncertain", false)
    )
      throw new Error("队列已暂停或浏览器状态不确定");
    requireConfig(application);
    requireFrozenJob(application);
  };

  app.post("/api/extension-application/preview", (req) => {
    const body = selectionSchema.parse(req.body);
    const { draft } = prepare(body);
    return { application: draft, configurationKey: o.configurationKey() };
  });
  app.post("/api/extension-application/start", (req) => {
    const body = startSchema.parse(req.body);
    requireConnection();
    const { draft, manualReview } = prepare(body);
    if (body.expectedConfigurationKey !== o.configurationKey())
      throw new Error("简历、话术或策略已变化，请重新预览");
    store.transaction(() => {
      requireReady();
      const latest = store.job(body.jobId);
      if (!latest || latest.contentHash !== body.expectedContentHash)
        throw new Error("岗位内容已变化，请重新核对");
      // Re-evaluate against the current resume, policy and cached assessment inside the lock.
      prepare(body);
      if (body.expectedConfigurationKey !== o.configurationKey())
        throw new Error("简历、话术或策略已变化，请重新预览");
      draft.executor = "extension";
      store.insertApplication(draft);
      store.set(configKey(draft.id), body.expectedConfigurationKey);
      store.set(
        attachmentKey(draft.id),
        attachmentManifest(o.attachmentsDir, draft.resumeAttachment),
      );
      store.enqueue("apply", draft);
      if (manualReview)
        store.audit("extensionApplication.manualReviewAccepted", {
          jobId: draft.jobId,
          contentHash: draft.job.contentHash,
          policyVersion: o.policy().version,
        });
    });
    return { applicationId: draft.id };
  });
  app.post("/extension/v1/application/claim", () => {
    requireConnection();
    const candidate = store
      .tasks()
      .find(
        (t) =>
          t.status === "queued" &&
          t.kind === "apply" &&
          (t.payload as Application).executor === "extension",
      );
    if (candidate) {
      const application = store.application(
        (candidate.payload as Application).id,
      );
      let current = false;
      try {
        if (application) {
          requireConfig(application);
          requireFrozenJob(application);
          current = true;
        }
      } catch {
        /* A changed job or configuration cannot be claimed. */
      }
      if (!current) {
        store.transaction(() => {
          store.db
            .prepare(
              "UPDATE tasks SET status='needs-review' WHERE id=? AND status='queued'",
            )
            .run(candidate.id);
          if (application) {
            application.status = "needs-review";
            store.updateApplication(application);
          }
        });
        return { task: null };
      }
    }
    const task = store.claim("extension");
    if (!task) return { task: null };
    const application = store.application((task.payload as Application).id)!;
    return { task: { id: task.id, leaseToken: task.leaseToken, application } };
  });
  app.post("/extension/v1/application/heartbeat", (req) => {
    const body = leaseSchema.parse(req.body);
    const task = store.requireLease(body.taskId, body.leaseToken);
    if (
      task.kind !== "apply" ||
      (task.payload as Application).executor !== "extension"
    )
      throw new Error("投递任务不匹配");
    store.heartbeat(body.taskId, body.leaseToken);
    return {
      paused:
        store.get("paused", false) || store.get("browserUncertain", false),
      takeover: store.get("takeover", false),
    };
  });
  app.post("/extension/v1/application/authorize", (req) => {
    const body = identitySchema
      .extend({ actionId: z.string().uuid() })
      .parse(req.body);
    const application = requireExtensionLease(body);
    requireBeginReady(application);
    const action = application.actions.find(
      (item) => item.id === body.actionId,
    );
    if (
      !action ||
      (action.state !== "started" &&
        !(
          action.kind === "native-greeting" &&
          action.state === "skipped" &&
          action.evidence === "existing-contact"
        ))
    )
      throw new Error("动作尚未获准");
    return { allowed: true, expiresAt: Date.now() + 1500 };
  });
  app.post("/extension/v1/application/action", (req) => {
    const body = actionSchema.parse(req.body);
    const application = requireExtensionLease(body);
    const old = application.actions.find((a) => a.id === body.actionId);
    if (!old) throw new Error("动作不属于当前投递");
    if (body.state === "started") {
      requireBeginReady(application);
      if (body.evidence !== "before-action")
        throw new Error("动作开始前证据不匹配");
    }
    if (
      body.state === "skipped" &&
      (old.kind !== "native-greeting" || body.evidence !== "existing-contact")
    )
      throw new Error("只有既有联系人招呼动作可以跳过");
    if (
      body.state === "confirmed" &&
      body.evidence !==
        (old.kind === "attachment" ? "new-attachment" : "new-message")
    )
      throw new Error("发送确认需要新消息或新附件证据");
    let execute = false;
    const updated = store.recordAction(
      body.taskId,
      body.leaseToken,
      body.applicationId,
      {
        ...old,
        state: body.state,
        evidence: body.evidence,
        updatedAt: new Date().toISOString(),
      },
      (changed) => {
        execute = changed && body.state === "started";
      },
    );
    return { execute, application: updated };
  });
  app.post("/extension/v1/application/attachment", (req) => {
    const body = identitySchema
      .extend({ actionId: z.string().uuid() })
      .parse(req.body);
    const application = requireExtensionLease(body);
    requireConfig(application);
    const action = application.actions.find((a) => a.id === body.actionId);
    if (
      !action ||
      action.kind !== "attachment" ||
      action.state !== "started" ||
      application.actions.some(
        (a) =>
          a.index < action.index && !["confirmed", "skipped"].includes(a.state),
      )
    )
      throw new Error("附件动作尚未获准");
    const name = application.resumeAttachment;
    if (!name) throw new Error("简历附件不存在");
    const { manifest, buffer } = safeAttachment(o.attachmentsDir, name);
    if (
      JSON.stringify(manifest) !==
      JSON.stringify(
        store.get<AttachmentManifest | null>(
          attachmentKey(application.id),
          null,
        ),
      )
    )
      throw new Error("简历附件已变化，请人工核对");
    return {
      name,
      mimeType:
        extname(name) === ".pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      base64: buffer.toString("base64"),
      sha256: manifest.sha256,
    };
  });
  app.post("/extension/v1/application/result", (req) => {
    const body = identitySchema
      .extend({
        reason: z
          .enum([
            "recipient-mismatch",
            "page-unrecognized",
            "login-required",
            "verification-required",
            "send-unconfirmed",
            "attachment-pending",
            "cancelled",
          ])
          .optional(),
      })
      .parse(req.body);
    const identity = createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex");
    const receipt = store.get<{ identity: string; status: string } | null>(
      receiptKey(body.taskId),
      null,
    );
    if (receipt) {
      if (receipt.identity !== identity) throw new Error("重复回调身份不一致");
      return { ok: true, status: receipt.status };
    }
    const application = requireExtensionLease(body);
    let status: Application["status"] = "needs-review";
    store.transaction(() => {
      application.actions = application.actions.map((a) =>
        a.state === "started"
          ? {
              ...a,
              state: "unknown" as const,
              updatedAt: new Date().toISOString(),
            }
          : a,
      );
      status = application.actions.every((a) =>
        ["confirmed", "skipped"].includes(a.state),
      )
        ? "completed"
        : "needs-review";
      application.status = status;
      if (body.reason && status !== "completed")
        application.stopReason = body.reason;
      store.updateApplication(application);
      store.finishTask(
        body.taskId,
        body.leaseToken,
        { status },
        status === "completed" ? "completed" : "needs-review",
      );
      store.set(receiptKey(body.taskId), { identity, status });
    });
    return { ok: true, status };
  });
}

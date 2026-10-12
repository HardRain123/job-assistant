import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  Application,
  Assessment,
  BulkRun,
  Job,
  MatchPolicy,
  Resume,
} from "../../../packages/contracts/src/index.ts";
import { Store } from "../../../packages/storage/src/index.ts";
import { evaluateGates } from "../../../packages/matching/src/index.ts";

const key = "bulk.current";
const configSchema = z
  .object({
    dailyLimit: z.number().int().min(1).max(150),
    target: z.number().int().min(1).max(150),
    intervalSeconds: z.number().int().min(15).max(300),
  })
  .strict();
interface Options {
  store: Store;
  draft: (
    ids: string[],
    manualReviewedId?: string,
    messagesOnly?: boolean,
  ) => Application[];
  assessment: (job: Job) => Assessment | null;
  policy: () => MatchPolicy;
  resume: () => Resume | null;
  configurationKey: () => string;
  status: () => {
    paired: boolean;
    version: string | null;
    lastSeen: string | null;
  };
}
type SavedRun = BulkRun & {
  configurationKey: string;
  acknowledgedReviewIds?: string[];
};
type Preview = {
  config: z.infer<typeof configSchema>;
  applications: Application[];
  configurationKey: string;
  expiresAt: string;
};
const companyKey = (value: string) =>
  value
    .replace(/\s+/g, "")
    .toLowerCase()
    .replace(/(?:股份有限公司|有限责任公司|有限公司)$/, "");
const companies = (job: Job) =>
  [job.company, ...job.companyAliases].map(companyKey).filter(Boolean);
const urlKey = (job: Job) => {
  try {
    const u = new URL(job.url);
    return u.origin + u.pathname;
  } catch {
    return job.url;
  }
};
const blankCounts = () => ({
  queued: 0,
  running: 0,
  completed: 0,
  review: 0,
  skipped: 0,
  cancelled: 0,
});

export function createBulkApplication(o: Options) {
  const { store } = o;
  const save = (run: SavedRun) => {
    run.updatedAt = new Date().toISOString();
    store.set(key, run);
  };
  const publicRun = (run: SavedRun | null): BulkRun | null => {
    if (!run) return null;
    const {
      configurationKey: _private,
      acknowledgedReviewIds: _ack,
      ...result
    } = run;
    return result;
  };
  const connection = () => {
    const status = o.status();
    const [major = 0, minor = 0] = (status.version ?? "")
      .split(".")
      .map(Number);
    if (
      !status.paired ||
      !(major > 0 || minor >= 4) ||
      !status.lastSeen ||
      Date.now() - Date.parse(status.lastSeen) > 90000
    )
      throw new Error("请连接并刷新浏览器扩展到 0.4.0 或更新版本");
  };
  const idle = () => {
    if (
      store.get("paused", false) ||
      store.get("takeover", false) ||
      store.get("browserUncertain", false)
    )
      throw new Error("请先恢复队列并结束浏览器接管");
    const collecting = store.get<{ state: string; phase: string } | null>(
      "automation.current",
      null,
    );
    if (collecting?.state === "running" && collecting.phase === "collecting")
      throw new Error("请等待岗位采集完成");
  };
  const reconcile = () => {
    const run = store.get<SavedRun | null>(key, null);
    if (!run) return null;
    store.recoverExpired();
    const applications = store
      .applications()
      .filter((a) => a.bulkRunId === run.id);
    run.counts = blankCounts();
    for (const a of applications) {
      if (a.stopReason === "existing-contact") run.counts.skipped++;
      else if (a.status === "needs-review" || a.status === "failed")
        run.counts.review++;
      else if (a.status === "queued") run.counts.queued++;
      else if (a.status === "running") run.counts.running++;
      else if (a.status === "completed") run.counts.completed++;
      else if (a.status === "cancelled") run.counts.cancelled++;
    }
    if (
      run.state === "running" &&
      applications.some(
        (a) =>
          ["needs-review", "failed"].includes(a.status) &&
          !run.acknowledgedReviewIds?.includes(a.id),
      )
    ) {
      run.state = "paused";
      run.message = "存在待核对的投递结果，批量已暂停；不会自动重发。";
    }
    if (run.state === "running" && !run.counts.queued && !run.counts.running) {
      run.state = "completed";
      run.message =
        "本批岗位处理结束，请分别查看已确认发送、待核对和跳过数量。";
    }
    store.set(key, run);
    return run;
  };
  const pause = (message: string) => {
    const run = reconcile();
    if (run && run.state !== "cancelled" && run.state !== "completed") {
      run.state = "paused";
      run.message = message;
      save(run);
    }
  };
  const selection = (config: z.infer<typeof configSchema>) => {
    const resume = o.resume();
    if (!resume) throw new Error("请先导入简历并评估岗位");
    const summary = {
      eligible: 0,
      selected: 0,
      shortfall: 0,
      unassessed: 0,
      review: 0,
      excluded: 0,
      duplicates: 0,
    };
    const known = store
      .applications()
      .filter(
        (application) => !store.reusableCancelledApplication(application),
      );
    const usedUrls = new Set(known.map((a) => urlKey(a.job)));
    const usedCompanies = new Set(known.flatMap((a) => companies(a.job)));
    const candidates: Job[] = [];
    const jobs = store
      .jobs()
      .sort(
        (a, b) =>
          (o.assessment(b)?.score ?? -1) - (o.assessment(a)?.score ?? -1),
      );
    for (const job of jobs) {
      const names = companies(job);
      if (
        usedUrls.has(urlKey(job)) ||
        known.some((a) => a.jobId === job.id) ||
        names.some((name) => usedCompanies.has(name))
      ) {
        summary.duplicates++;
        continue;
      }
      if (
        job.source !== "boss" ||
        job.status !== "active" ||
        evaluateGates(job, resume, o.policy()).some(
          (gate) => gate.status === "fail",
        )
      ) {
        summary.excluded++;
        continue;
      }
      const assessment = o.assessment(job);
      if (!assessment || assessment.decision === "unavailable") {
        summary.unassessed++;
        continue;
      }
      if (assessment.decision === "skip") {
        summary.excluded++;
        continue;
      }
      if (
        assessment.decision === "review" ||
        evaluateGates(job, resume, o.policy()).some(
          (gate) => gate.status !== "pass",
        )
      ) {
        summary.review++;
        continue;
      }
      if (
        assessment.decision !== "eligible" ||
        !assessment.gates.length ||
        assessment.gates.some((gate) => gate.status !== "pass")
      ) {
        summary.excluded++;
        continue;
      }
      candidates.push(job);
      usedUrls.add(urlKey(job));
      names.forEach((name) => usedCompanies.add(name));
    }
    summary.eligible = candidates.length;
    const room = store.dailyQuota(new Date(), config.dailyLimit).remaining;
    const selected = candidates.slice(0, Math.min(config.target, room));
    summary.selected = selected.length;
    summary.shortfall = Math.max(0, config.target - selected.length);
    return { summary, jobs: selected };
  };
  const canClaim = (application: Application) => {
    if (!application.bulkRunId) return true;
    const run = reconcile();
    if (!run || run.id !== application.bulkRunId || run.state !== "running")
      return false;
    try {
      idle();
    } catch {
      return false;
    }
    if (run.configurationKey !== o.configurationKey()) {
      pause("简历、话术或筛选条件已变化，请重新创建批次。");
      return false;
    }
    if (!currentlyEligible(application)) {
      pause("岗位评分或筛选结果已变化，请重新评估后继续。");
      return false;
    }
    if (run.nextRunAt && Date.parse(run.nextRunAt) > Date.now()) return false;
    if (store.dailyQuota().remaining <= 0) {
      pause("今日配置名额已用完，剩余岗位保留；次日可手动继续。");
      return false;
    }
    return true;
  };
  const allowedDuringAction = (application: Application) => {
    if (!application.bulkRunId) return true;
    const run = store.get<SavedRun | null>(key, null);
    try {
      idle();
    } catch {
      return false;
    }
    return (
      run?.id === application.bulkRunId &&
      run.state === "running" &&
      currentlyEligible(application)
    );
  };
  const currentlyEligible = (application: Application) => {
    const current = store.job(application.jobId);
    const resume = o.resume();
    const assessment = current ? o.assessment(current) : null;
    return Boolean(
      current &&
        resume &&
        current.status === "active" &&
        current.contentHash === application.job.contentHash &&
        assessment?.decision === "eligible" &&
        assessment.gates.length &&
        assessment.gates.every((gate) => gate.status === "pass") &&
        evaluateGates(current, resume, o.policy()).every(
          (gate) => gate.status === "pass",
        ),
    );
  };
  const afterResult = (application: Application, reason?: string) => {
    if (!application.bulkRunId) return;
    const run = store.get<SavedRun | null>(key, null);
    if (!run || run.id !== application.bulkRunId) return;
    run.nextRunAt = new Date(
      Date.now() + run.intervalSeconds * 1000,
    ).toISOString();
    if (
      run.state === "running" &&
      application.status !== "completed" &&
      reason !== "existing-contact"
    ) {
      run.state = "paused";
      run.message =
        reason === "platform-limit"
          ? "平台提示沟通次数限制，批量已暂停。"
          : reason === "daily-limit"
            ? "今日配置名额已用完，批量已暂停。"
            : "当前岗位需要核对，批量已暂停；不会重发已尝试动作。";
    }
    save(run);
    reconcile();
  };
  const register = (app: FastifyInstance) => {
    app.get("/api/bulk-application", () => ({
      run: publicRun(reconcile()),
      today: store.dailyQuota(),
      extension: o.status(),
    }));
    app.post("/api/bulk-application/preview", (req) => {
      const config = configSchema.parse(req.body);
      const { summary, jobs } = selection(config);
      const applications = jobs.length
        ? o.draft(
            jobs.map((job) => job.id),
            undefined,
            true,
          )
        : [];
      const previewId = randomUUID();
      const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
      store.set(`bulk.preview:${previewId}`, {
        config,
        applications,
        configurationKey: o.configurationKey(),
        expiresAt,
      } satisfies Preview);
      return { previewId, expiresAt, applications, summary };
    });
    app.post("/api/bulk-application/start", (req) => {
      const { previewId } = z
        .object({ previewId: z.string().uuid() })
        .strict()
        .parse(req.body);
      connection();
      idle();
      return store.transaction(() => {
        const current = store.get<SavedRun | null>(key, null);
        if (current && ["running", "paused"].includes(current.state))
          throw new Error("已有批量任务，请先继续或结束它");
        if (
          store
            .tasks()
            .some(
              (t) =>
                t.kind === "apply" && ["queued", "leased"].includes(t.status),
            )
        )
          throw new Error("已有投递任务尚未结束");
        const preview = store.get<Preview | null>(
          `bulk.preview:${previewId}`,
          null,
        );
        if (!preview || Date.parse(preview.expiresAt) < Date.now())
          throw new Error("预览已过期，请重新预览");
        if (preview.configurationKey !== o.configurationKey())
          throw new Error("配置已变化，请重新预览");
        if (!preview.applications.length)
          throw new Error("没有符合条件且可投递的岗位，请先采集和评估");
        const selected = selection(preview.config).jobs;
        for (const a of preview.applications)
          if (
            !selected.some(
              (job) =>
                job.id === a.jobId && job.contentHash === a.job.contentHash,
            )
          )
            throw new Error("岗位、评分或今日名额已变化，请重新预览");
        const stamp = new Date().toISOString();
        const run: SavedRun = {
          id: randomUUID(),
          state: "running",
          ...preview.config,
          configurationKey: preview.configurationKey,
          message: "批量已创建，等待扩展依次发送话术。",
          createdAt: stamp,
          updatedAt: stamp,
          counts: { ...blankCounts(), queued: preview.applications.length },
        };
        if (current) store.set(`bulk.history:${current.id}`, current);
        store.set("bulk.dailyLimit", run.dailyLimit);
        store.set(key, run);
        for (const application of preview.applications) {
          for (const previous of store
            .applications()
            .filter((a) => a.jobId === application.jobId))
            store.archiveCancelledApplication(previous);
          application.bulkRunId = run.id;
          application.executor = "extension";
          store.insertApplication(application);
          store.set(
            `extensionApplication.configuration:${application.id}`,
            preview.configurationKey,
          );
          store.set(`extensionApplication.attachment:${application.id}`, null);
          store.enqueue("apply", application);
        }
        store.set(`bulk.preview:${previewId}`, null);
        store.audit("bulk.started", {
          id: run.id,
          target: run.target,
          selected: preview.applications.length,
          dailyLimit: run.dailyLimit,
        });
        return { run: publicRun(run) };
      });
    });
    app.post("/api/bulk-application/control", (req) => {
      const { action } = z
        .object({ action: z.enum(["pause", "resume", "cancel"]) })
        .strict()
        .parse(req.body);
      const run = reconcile();
      if (!run || ["completed", "cancelled"].includes(run.state))
        throw new Error("没有可控制的批量任务");
      if (action === "resume") {
        connection();
        idle();
        if (run.configurationKey !== o.configurationKey())
          throw new Error("配置已变化，请结束旧批次并重新预览");
        if (store.dailyQuota().remaining <= 0)
          throw new Error("今日配置名额已用完");
        run.acknowledgedReviewIds = store
          .applications()
          .filter(
            (a) =>
              a.bulkRunId === run.id &&
              ["needs-review", "failed"].includes(a.status),
          )
          .map((a) => a.id);
        run.state = "running";
        run.message = "继续尚未执行的岗位；待核对岗位保留，不会重发。";
      } else if (action === "pause") {
        run.state = "paused";
        run.message = "批量已暂停，已开始的发送仍可能完成。";
      } else {
        run.state = "cancelled";
        run.message = "批量已结束，已执行动作和待核对记录保留。";
        store.transaction(() => {
          for (const application of store
            .applications()
            .filter((a) => a.bulkRunId === run.id && a.status === "queued")) {
            application.status = "cancelled";
            store.updateApplication(application);
            store.db
              .prepare(
                "UPDATE tasks SET status='failed' WHERE status='queued' AND json_extract(payload,'$.id')=?",
              )
              .run(application.id);
          }
        });
      }
      save(run);
      store.audit(`bulk.${action}`, { id: run.id });
      return { run: publicRun(reconcile()) };
    });
  };
  return { register, canClaim, allowedDuringAction, afterResult, pause };
}
export type BulkApplication = ReturnType<typeof createBulkApplication>;

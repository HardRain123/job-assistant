import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  Application,
  BulkRun,
} from "../../../packages/contracts/src/index.ts";
import { Store } from "../../../packages/storage/src/index.ts";

const runKey = "bulkWorkflow.current";
const configSchema = z
  .object({
    dailyLimit: z.number().int().min(1).max(150),
    target: z.number().int().min(1).max(150),
    intervalSeconds: z.number().int().min(15).max(300),
    continueOnJobFailure: z.boolean().default(true),
    keywords: z.array(z.string().trim().min(1).max(80)).min(1).max(5),
    city: z.enum(["上海", "全国"]),
    maxJobsPerRound: z.number().int().min(1).max(100).default(50),
    maxPages: z.number().int().min(1).max(10).default(2),
    maxRounds: z.number().int().min(1).max(5).default(3),
  })
  .strict();
export type BulkWorkflowConfig = z.infer<typeof configSchema>;

export interface AutomationSummary {
  id: string;
  state: "running" | "paused" | "blocked" | "completed" | "cancelled";
  phase: "collecting" | "scoring" | "done";
  imported: number;
  eligible: number;
  failed: number;
  message: string;
}
export interface BulkPreview {
  previewId: string;
  applications: Application[];
  summary: unknown;
}
export interface BulkWorkflowPorts {
  store: Pick<Store, "get" | "set" | "transaction" | "audit">;
  configurationKey: () => string;
  messageTemplates: () => string[];
  applications?: () => Application[];
  status: () => {
    paired: boolean;
    version: string | null;
    lastSeen: string | null;
  };
  quota: (limit?: number) => { remaining: number; date: string };
  bulk: {
    state: () => BulkRun | null;
    preview: (config: {
      dailyLimit: number;
      target: number;
      intervalSeconds: number;
      continueOnJobFailure: boolean;
    }) => BulkPreview;
    start: (previewId: string, insideTransaction?: boolean, inheritedJobFailures?: number) => { run: BulkRun };
    control: (
      action: "pause" | "resume" | "cancel",
      insideTransaction?: boolean,
    ) => { run: BulkRun };
  };
  automation: {
    state: () => AutomationSummary | null;
    start: (config: {
      keywords: [string];
      city: "上海" | "全国";
      maxJobs: number;
      maxPages: number;
      autoAssess: true;
      intervalSeconds: number;
    }) => { run: AutomationSummary };
    control: (body: { action: "pause" | "resume" | "cancel" }) => {
      run: AutomationSummary;
    };
  };
  now?: () => number;
}

type ChildTotals = {
  bulkId?: string;
  planned: number;
  completed: number;
  review: number;
  skipped: number;
};
type InternalRun = {
  id: string;
  state: "running" | "paused" | "completed" | "cancelled";
  phase: "collecting" | "sending" | "done";
  config: BulkWorkflowConfig;
  target: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  rounds: number;
  noGrowthRounds: number;
  consecutiveJobFailures?: number;
  resetFailureStreakChildId?: string;
  budgetUsed: number;
  counts: {
    planned: number;
    completed: number;
    review: number;
    skipped: number;
    queued: number;
  };
  configurationKey: string;
  shanghaiDay: string;
  manualPaused: boolean;
  childBulkId: string | null;
  childAutomationId: string | null;
  childTotals: ChildTotals[];
  currentPreviewId: string | null;
  currentAutomationImported: number;
  keywordIndex: number;
};
type Preview = {
  id: string;
  config: BulkWorkflowConfig;
  configurationKey: string;
  shanghaiDay: string;
  expiresAt: string;
  bulkPreviewId: string;
  applications: Application[];
  summary: unknown;
  messageTemplates: string[];
};

const stamp = (now: () => number) => new Date(now()).toISOString();
export function createBulkWorkflow(o: BulkWorkflowPorts) {
  const now = o.now ?? Date.now;
  let pumping: Promise<void> | null = null;
  const load = () => o.store.get<InternalRun | null>(runKey, null);
  const save = (run: InternalRun) => {
    run.updatedAt = stamp(now);
    o.store.set(runKey, run);
  };
  const visibleCounts = (run: InternalRun) => {
    if (!o.applications) return run.counts;
    const owned = new Set([...run.childTotals.map((child) => child.bulkId), run.childBulkId].filter(Boolean));
    const applications = o.applications().filter((application) => owned.has(application.bulkRunId));
    return {
      planned: run.counts.planned,
      completed: applications.filter((application) => application.status === "completed").length,
      review: applications.filter((application) => ["needs-review", "failed"].includes(application.status) && application.stopReason !== "existing-contact").length,
      skipped: applications.filter((application) => application.stopReason === "existing-contact").length,
      queued: applications.filter((application) => ["queued", "running"].includes(application.status)).length,
    };
  };
  const publicRun = (run: InternalRun | null) =>
    run && {
      id: run.id,
      state: run.state,
      phase: run.phase,
      config: run.config,
      target: run.target,
      message: run.message,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      rounds: run.rounds,
      budgetUsed: run.budgetUsed,
      counts: visibleCounts(run),
    };
  const pause = (run: InternalRun, message: string) => {
    o.store.transaction(() => {
      let childPauseFailed = false;
      if (run.childBulkId) {
        const child = o.bulk.state();
        if (child?.id === run.childBulkId && child.state === "running") {
          try {
            o.bulk.control("pause", true);
          } catch {
            childPauseFailed = true;
          }
        }
      }
      if (run.childAutomationId) {
        const child = o.automation.state();
        if (child?.id === run.childAutomationId && child.state === "running") {
          try {
            o.automation.control({ action: "pause" });
          } catch {
            childPauseFailed = true;
          }
        }
      }
      run.state = "paused";
      if (childPauseFailed) o.store.set("paused", true);
      run.message = childPauseFailed
        ? `${message} 子任务暂停状态未能确认，请立即核对浏览器；工作流不会继续。`
        : message;
      save(run);
    });
  };
  const restoreLegacyFailureStreak = (run: InternalRun): boolean => {
    if (run.consecutiveJobFailures !== undefined) {
      if (Number.isInteger(run.consecutiveJobFailures) && run.consecutiveJobFailures >= 0) return true;
      pause(run, "批次的连续失败计数需要核对，已暂停；请检查后手动继续。");
      return false;
    }
    type LegacyChild = BulkRun & { acknowledgedReviewIds?: string[]; isolatedReviewIds?: string[] };
    try {
      let streak = 0;
      const current = o.store.get<LegacyChild | null>("bulk.current", null);
      if (run.childTotals.some((child) => !child.bulkId && child.planned > 0)) throw new Error("missing-child-identity");
      const ids = [...new Set([...run.childTotals.map((child) => child.bulkId), run.childBulkId].filter((id): id is string => Boolean(id)))];
      for (const id of ids) {
        const child = current?.id === id ? current : o.store.get<LegacyChild | null>(`bulk.history:${id}`, null);
        if (child && Number.isInteger(child.consecutiveJobFailures) && child.consecutiveJobFailures! >= 0) {
          const localFailures = child.isolatedReviewIds?.length ?? child.counts.review;
          const reset = child.counts.completed > 0 || child.acknowledgedReviewIds !== undefined || child.consecutiveJobFailures! < localFailures;
          streak = reset ? child.consecutiveJobFailures! : streak + child.consecutiveJobFailures!;
          continue;
        }
        // Older archives may lack the counter. Uniform persisted outcomes are
        // unambiguous; mixed success/failure order needs manual review.
        const applications = o.applications?.().filter((application) => application.bulkRunId === id) ?? [];
        if (!applications.length) throw new Error("missing-child-history");
        const outcomes = applications.filter((application) =>
          application.status === "completed" || ["needs-review", "failed"].includes(application.status));
        const hasSuccess = outcomes.some((application) => application.status === "completed");
        const hasFailure = outcomes.some((application) => application.status !== "completed");
        if (hasSuccess && hasFailure) throw new Error("ambiguous-outcome-order");
        for (const application of outcomes) {
          if (application.status === "completed") streak = 0;
          else if (["recipient-mismatch", "page-unrecognized", "send-unconfirmed", "attachment-pending"].includes(application.stopReason ?? "")) streak++;
          else throw new Error("unclassified-legacy-outcome");
        }
      }
      o.store.transaction(() => {
        run.consecutiveJobFailures = streak;
        if (run.childBulkId && current?.id === run.childBulkId)
          o.store.set("bulk.current", { ...current, consecutiveJobFailures: streak });
        save(run);
        o.store.audit("bulkWorkflow.failure-streak-restored", { id: run.id, consecutiveJobFailures: streak });
      });
      return true;
    } catch {
      pause(run, "旧批次的连续失败记录无法完整还原，已暂停；请核对历史结果后手动继续，未知发送不会重试。");
      return false;
    }
  };
  const globalBlock = (dailyLimit: number, currentBulk = false): string | null => {
    if (o.store.get("paused", false))
      return "工作台队列已暂停，请恢复队列后继续。";
    if (o.store.get("takeover", false))
      return "浏览器正在人工接管，请结束接管后继续。";
    if (o.store.get("browserUncertain", false))
      return "浏览器状态需要核对，请检查后继续。";
    const status = o.status();
    const version = status.version?.split(".").map(Number);
    if (!version || version.length !== 3 || version.some((part) => !Number.isInteger(part) || part < 0) ||
        !(version[0]! > 0 || version[1]! > 4 || (version[1] === 4 && version[2]! >= 8)))
      return "自动补充批次需要 0.4.8 或更新的浏览器扩展。";
    if (
      !status.paired ||
      !status.lastSeen ||
      now() - Date.parse(status.lastSeen) > 90000
    )
      return "浏览器扩展离线，请恢复连接后继续。";
    if (!currentBulk && o.quota(dailyLimit).remaining <= 0)
      return "今日配置额度已用完，批次已暂停。";
    return null;
  };
  const guard = (run: InternalRun, allowManualPause = false) => {
    if (run.configurationKey !== o.configurationKey()) {
      pause(run, "简历、筛选、话术或评分配置已变化；请取消旧批次并重新预览。");
      return false;
    }
    if (run.shanghaiDay !== o.quota(run.config.dailyLimit).date) {
      pause(
        run,
        "已跨到新的上海日期；请取消旧批次并重新预览启动，未知发送不会重试。",
      );
      return false;
    }
    const block = globalBlock(run.config.dailyLimit, Boolean(run.childBulkId));
    if (block) {
      pause(run, block);
      return false;
    }
    if (!allowManualPause && run.manualPaused) return false;
    return true;
  };
  const childOwned = (run: InternalRun) => {
    if (run.childBulkId) return o.bulk.state()?.id === run.childBulkId;
    if (run.childAutomationId)
      return o.automation.state()?.id === run.childAutomationId;
    return true;
  };
  const beginBulk = (run: InternalRun, preview: BulkPreview) => {
    if (!preview.applications.length) return false;
    o.store.transaction(() => {
      const latest = load();
      if (!latest || latest.id !== run.id || latest.state !== "running")
        throw new Error("批次已暂停或结束");
      const started = o.bulk.start(preview.previewId, true, latest.consecutiveJobFailures ?? 0).run;
      latest.childBulkId = started.id;
      latest.childAutomationId = null;
      latest.currentPreviewId = null;
      latest.phase = "sending";
      latest.noGrowthRounds = 0;
      delete latest.resetFailureStreakChildId;
      latest.counts.planned += started.counts.queued + started.counts.running;
      latest.counts.queued = started.counts.queued + started.counts.running;
      latest.message =
        "正在按冻结候选顺序处理投递；未知结果会保留占额且不会重发。";
      save(latest);
    });
    return true;
  };
  const beginCollection = (run: InternalRun) => {
    if (run.rounds >= run.config.maxRounds || run.budgetUsed >= 300) {
      run.state = "completed";
      run.phase = "done";
      run.message = `补采上限已到；已规划 ${run.counts.planned}/${run.target}，话术完成 ${run.counts.completed}，待核验 ${run.counts.review}。未降低筛选门槛。`;
      save(run);
      return;
    }
    const maxJobs = Math.min(run.config.maxJobsPerRound, 300 - run.budgetUsed);
    if (maxJobs <= 0) {
      run.state = "completed";
      run.phase = "done";
      run.message = "本批总采集预算已用完，保留当前进度和缺额。";
      save(run);
      return;
    }
    const keyword =
      run.config.keywords[run.keywordIndex % run.config.keywords.length]!;
    o.store.transaction(() => {
      const latest = load();
      if (!latest || latest.id !== run.id || latest.state !== "running")
        throw new Error("批次已暂停或结束");
      const started = o.automation.start({
        keywords: [keyword],
        city: run.config.city,
        maxJobs,
        maxPages: run.config.maxPages,
        autoAssess: true,
        intervalSeconds: 3,
      }).run;
      latest.childAutomationId = started.id;
      latest.childBulkId = null;
      latest.phase = "collecting";
      latest.rounds++;
      latest.currentAutomationImported = 0;
      latest.keywordIndex =
        (latest.keywordIndex + 1) % latest.config.keywords.length;
      latest.message = `正在采集并评分第 ${latest.rounds} 轮候选。`;
      save(latest);
    });
  };
  const refreshCounts = (run: InternalRun, bulk: BulkRun) => {
    // Each child starts with this workflow's streak, so its persisted value is
    // authoritative unless the user reset it after that child had finished.
    run.consecutiveJobFailures = run.resetFailureStreakChildId === bulk.id
      ? 0 : bulk.consecutiveJobFailures ?? 0;
    const old = run.childTotals.reduce(
      (a, b) => ({
        planned: a.planned + b.planned,
        completed: a.completed + b.completed,
        review: a.review + b.review,
        skipped: a.skipped + b.skipped,
      }),
      { planned: 0, completed: 0, review: 0, skipped: 0 },
    );
    run.counts = {
      planned: run.counts.planned,
      completed: old.completed + bulk.counts.completed,
      review: old.review + bulk.counts.review,
      skipped: old.skipped + bulk.counts.skipped,
      queued: bulk.counts.queued + bulk.counts.running,
    };
  };
  function pumpOne() {
    const run = load();
    if (!run || run.state !== "running") return;
    if (!restoreLegacyFailureStreak(run)) return;
    if ((run.consecutiveJobFailures ?? 0) >= 3) {
      pause(run, "连续 3 个岗位需要核对，工作流已暂停；请检查后手动继续，未知发送不会重试。");
      return;
    }
    if (!guard(run)) return;
    if (!childOwned(run)) {
      pause(run, "当前子任务已被替换或接管；为避免控制无关任务，批次已暂停。");
      return;
    }
    if (run.childBulkId) {
      const child = o.bulk.state();
      if (!child || child.id !== run.childBulkId) {
        pause(run, "批量子任务已被替换或无法核对，批次已暂停。");
        return;
      }
      refreshCounts(run, child);
      if (child.state === "paused") {
        pause(run, "投递子任务已暂停，请核对后手动恢复工作流。");
        return;
      }
      if (child.state === "cancelled") {
        pause(run, "投递子任务已结束，工作流已暂停并保留进度。");
        return;
      }
      if (child.state === "completed") {
        run.childTotals.push({
          bulkId: child.id,
          planned: Math.max(
            0,
            run.counts.planned -
              run.childTotals.reduce((n, v) => n + v.planned, 0),
          ),
          completed: child.counts.completed,
          review: child.counts.review,
          skipped: child.counts.skipped,
        });
        run.childBulkId = null;
        run.counts.queued = 0;
        save(run);
        if (run.counts.planned >= run.target) {
          run.state = "completed";
          run.phase = "done";
          run.message = `已规划 ${run.counts.planned}/${run.target}；已确认发送 ${run.counts.completed}，待核验 ${run.counts.review}，跳过 ${run.counts.skipped}。未知结果保留核验状态，不会自动补投。`;
          save(run);
          return;
        }
        try {
          const preview = o.bulk.preview({
            dailyLimit: run.config.dailyLimit,
            target: run.target - run.counts.planned,
            intervalSeconds: run.config.intervalSeconds,
            continueOnJobFailure: run.config.continueOnJobFailure,
          });
          if (preview.applications.length) {
            if (beginBulk(run, preview)) return;
          }
        } catch {
          pause(
            run,
            "无法安全预览下一批候选，请检查队列和每日额度后手动恢复。",
          );
          return;
        }
        if (o.quota(run.config.dailyLimit).remaining <= 0) {
          pause(run, "今日配置额度已用完，剩余候选未处理。");
          return;
        }
        if (run.noGrowthRounds >= 2 && run.rounds >= Math.min(run.config.keywords.length, run.config.maxRounds)) {
          run.state = "completed";
          run.phase = "done";
          run.message = `连续两轮没有新增合格候选；已规划 ${run.counts.planned}/${run.target}，已确认发送 ${run.counts.completed}，待核验 ${run.counts.review}，跳过 ${run.counts.skipped}。未降低筛选门槛。`;
          save(run);
          return;
        }
        beginCollection(run);
        return;
      }
      save(run);
      return;
    }
    if (run.childAutomationId) {
      const child = o.automation.state();
      if (!child || child.id !== run.childAutomationId) {
        pause(run, "采集子任务已被替换或无法核对，批次已暂停。");
        return;
      }
      run.budgetUsed = Math.min(
        300,
        run.budgetUsed +
          Math.max(0, child.imported - run.currentAutomationImported),
      );
      run.currentAutomationImported = child.imported;
      if (child.state === "blocked" || child.state === "paused") {
        pause(run, `采集或评分暂停：${child.message}`);
        return;
      }
      if (child.state === "cancelled") {
        pause(run, "采集子任务已结束，工作流已暂停并保留进度。");
        return;
      }
      if (child.state === "completed") {
        run.childAutomationId = null;
        save(run);
        try {
          const preview = o.bulk.preview({
            dailyLimit: run.config.dailyLimit,
            target: run.target - run.counts.planned,
            intervalSeconds: run.config.intervalSeconds,
            continueOnJobFailure: run.config.continueOnJobFailure,
          });
          if (preview.applications.length) {
            run.noGrowthRounds = 0;
            if (beginBulk(run, preview)) return;
          } else {
            run.noGrowthRounds++;
          }
        } catch {
          pause(run, "评分后无法安全预览候选，请检查配置并手动恢复。");
          return;
        }
        if (
          (run.noGrowthRounds >= 2 && run.rounds >= Math.min(run.config.keywords.length, run.config.maxRounds)) ||
          run.rounds >= run.config.maxRounds ||
          run.budgetUsed >= 300
        ) {
          run.state = "completed";
          run.phase = "done";
          run.message = `补采结束；已规划 ${run.counts.planned}/${run.target}，已确认发送 ${run.counts.completed}，待核验 ${run.counts.review}，跳过 ${run.counts.skipped}。未降低筛选门槛。`;
          save(run);
          return;
        }
        save(run);
        beginCollection(run);
        return;
      }
      save(run);
      return;
    }
    try {
      const preview = o.bulk.preview({
        dailyLimit: run.config.dailyLimit,
        target: run.target - run.counts.planned,
        intervalSeconds: run.config.intervalSeconds,
        continueOnJobFailure: run.config.continueOnJobFailure,
      });
      if (preview.applications.length && beginBulk(run, preview)) return;
      beginCollection(run);
    } catch {
      pause(run, "无法预览或启动子任务，请检查浏览器连接和队列后手动恢复。");
    }
  }
  const pump = () => {
    if (pumping) return pumping;
    pumping = Promise.resolve()
      .then(pumpOne)
      .catch(() => {
        const run = load();
        if (run?.state === "running")
          pause(run, "工作流遇到可恢复错误，已暂停并保留进度。");
      })
      .finally(() => {
        pumping = null;
      });
    return pumping;
  };
  const register = (app: FastifyInstance) => {
    app.get("/api/bulk-workflow", () => ({ run: publicRun(load()) }));
    app.post("/api/bulk-workflow/preview", (req) => {
      const config = configSchema.parse(req.body);
      if (new Set(config.keywords).size !== config.keywords.length)
        throw new Error("关键词不能重复");
      const childPreview = o.bulk.preview({
        dailyLimit: config.dailyLimit,
        target: config.target,
        intervalSeconds: config.intervalSeconds,
        continueOnJobFailure: config.continueOnJobFailure,
      });
      const id = randomUUID();
      const expiresAt = new Date(now() + 15 * 60000).toISOString();
      const saved: Preview = {
        id,
        config,
        configurationKey: o.configurationKey(),
        shanghaiDay: o.quota(config.dailyLimit).date,
        expiresAt,
        bulkPreviewId: childPreview.previewId,
        applications: childPreview.applications,
        summary: childPreview.summary,
        messageTemplates: [...o.messageTemplates()],
      };
      o.store.set(`bulkWorkflow.preview:${id}`, saved);
      return {
        previewId: id,
        expiresAt,
        applications: childPreview.applications,
        summary: childPreview.summary,
        messageTemplates: saved.messageTemplates,
        target: config.target,
        collectionPlan: {
          maxRounds: config.maxRounds,
          maxJobsPerRound: config.maxJobsPerRound,
          maxPages: config.maxPages,
          totalJobBudget: 300,
        },
      };
    });
    app.post("/api/bulk-workflow/start", (req) => {
      const { previewId } = z
        .object({ previewId: z.string().uuid() })
        .strict()
        .parse(req.body);
      const preview = o.store.get<Preview | null>(
        `bulkWorkflow.preview:${previewId}`,
        null,
      );
      if (
        !preview ||
        preview.id !== previewId ||
        Date.parse(preview.expiresAt) < now()
      )
        throw new Error("预览已过期，请重新预览");
      if (preview.configurationKey !== o.configurationKey())
        throw new Error("配置已变化，请重新预览");
      if (preview.shanghaiDay !== o.quota(preview.config.dailyLimit).date)
        throw new Error("预览已跨日，请重新预览");
      const previous = load();
      if (previous && ["running", "paused"].includes(previous.state))
        throw new Error("已有工作流，请先继续或结束当前批次");
      if (
        o.bulk.state() &&
        ["running", "paused"].includes(o.bulk.state()!.state)
      )
        throw new Error("已有批量投递任务，请先完成或结束");
      if (
        o.automation.state() &&
        ["running", "paused", "blocked"].includes(o.automation.state()!.state)
      )
        throw new Error("已有岗位采集任务，请先完成或结束");
      const block = globalBlock(preview.config.dailyLimit);
      if (block) throw new Error(block);
      const run: InternalRun = {
        id: randomUUID(),
        state: "running",
        phase: "sending",
        config: preview.config,
        target: preview.config.target,
        message: "工作流已启动。",
        createdAt: stamp(now),
        updatedAt: stamp(now),
        rounds: 0,
        noGrowthRounds: 0,
        consecutiveJobFailures: 0,
        budgetUsed: 0,
        counts: { planned: 0, completed: 0, review: 0, skipped: 0, queued: 0 },
        configurationKey: preview.configurationKey,
        shanghaiDay: preview.shanghaiDay,
        manualPaused: false,
        childBulkId: null,
        childAutomationId: null,
        childTotals: [],
        currentPreviewId: preview.bulkPreviewId,
        currentAutomationImported: 0,
        keywordIndex: 0,
      };
      try {
        o.store.transaction(() => {
          if (previous) o.store.set(`bulkWorkflow.history:${previous.id}`, previous);
          o.store.set(runKey, run);
          if (preview.applications.length) {
            const child = o.bulk.start(preview.bulkPreviewId, true).run;
            run.childBulkId = child.id;
            run.phase = "sending";
            run.counts.planned = child.counts.queued + child.counts.running;
            run.counts.queued = run.counts.planned;
            run.message = "正在按预览冻结的候选和话术依次投递。";
          } else {
            const keyword = run.config.keywords[run.keywordIndex]!;
            const child = o.automation.start({
              keywords: [keyword],
              city: run.config.city,
              maxJobs: Math.min(run.config.maxJobsPerRound, 300),
              maxPages: run.config.maxPages,
              autoAssess: true,
              intervalSeconds: 3,
            }).run;
            run.childAutomationId = child.id;
            run.rounds = 1;
            run.keywordIndex =
              (run.keywordIndex + 1) % run.config.keywords.length;
            run.phase = "collecting";
            run.message = "没有现成合格候选，正在开始第一轮采集和评分。";
          }
          save(run);
          o.store.set(`bulkWorkflow.preview:${previewId}`, null);
          o.store.audit("bulkWorkflow.started", {
            id: run.id,
            target: run.target,
          });
        });
      } catch {
        throw new Error("无法安全启动批次，请检查已有任务和浏览器状态");
      }
      return { run: publicRun(load()) };
    });
    app.post("/api/bulk-workflow/control", (req) => {
      const { action } = z
        .object({ action: z.enum(["pause", "resume", "cancel"]) })
        .strict()
        .parse(req.body);
      const run = load();
      if (!run || ["completed", "cancelled"].includes(run.state))
        throw new Error("没有可控制的批量工作流");
      if (action === "pause") {
        run.manualPaused = true;
        pause(run, "工作流已暂停；不会自动恢复或重放未知发送。");
      } else if (action === "cancel") {
        o.store.transaction(() => {
          const bulkChild = o.bulk.state();
          if (run.childBulkId && bulkChild?.id === run.childBulkId && ["running", "paused"].includes(bulkChild.state))
            o.bulk.control("cancel", true);
          if (
            run.childAutomationId &&
            o.automation.state()?.id === run.childAutomationId &&
            ["running", "paused", "blocked"].includes(o.automation.state()!.state)
          )
            o.automation.control({ action: "cancel" });
          run.state = "cancelled";
          run.phase = "done";
          run.message = "工作流已取消；已执行动作和待核对记录保留。";
          run.manualPaused = false;
          save(run);
        });
      } else {
        if (run.configurationKey !== o.configurationKey())
          throw new Error("配置已变化，请取消旧批次并重新预览");
        if (run.shanghaiDay !== o.quota(run.config.dailyLimit).date)
          throw new Error("已跨日，请取消旧批次并重新预览启动");
        const block = globalBlock(run.config.dailyLimit);
        if (block) throw new Error(block);
        if (!childOwned(run))
          throw new Error("子任务已被替换，不能接续此工作流");
        o.store.transaction(() => {
          run.manualPaused = false;
          run.state = "running";
          run.consecutiveJobFailures = 0;
          if (run.childBulkId) {
            const child = o.bulk.state();
            if (child?.id !== run.childBulkId)
              throw new Error("投递子任务已被替换，不能继续");
            if (["running", "paused"].includes(child.state)) o.bulk.control("resume", true);
            else if (child.state === "completed") run.resetFailureStreakChildId = child.id;
          }
          if (run.childAutomationId) {
            const child = o.automation.state();
            if (child?.id !== run.childAutomationId)
              throw new Error("采集子任务已被替换，不能继续");
            if (["paused", "blocked"].includes(child.state))
              o.automation.control({ action: "resume" });
          }
          run.message = "工作流已人工恢复，将继续处理尚未执行的阶段。";
          save(run);
        });
      }
      o.store.audit(`bulkWorkflow.${action}`, { id: run.id });
      return { run: publicRun(load()) };
    });
    const timer = setInterval(() => {
      void pump();
    }, 1000);
    timer.unref();
    app.addHook("onClose", async () => {
      clearInterval(timer);
      await pumping;
    });
  };
  // This predicate also runs at claim/start/authorize boundaries. The timer is
  // for progress and status updates, never the sole authority to permit a send.
  // Keep it read-only: authorization may already be inside a SQLite transaction.
  const permitsApplication = (application: Application): boolean => {
    const run = load();
    if (!run) return true;
    if (!run.childBulkId || run.childBulkId !== application.bulkRunId)
      return !["running", "paused"].includes(run.state);
    return run.state === "running" && !run.manualPaused &&
      run.consecutiveJobFailures !== undefined && run.consecutiveJobFailures < 3 &&
      run.configurationKey === o.configurationKey() &&
      run.shanghaiDay === o.quota(run.config.dailyLimit).date &&
      !globalBlock(run.config.dailyLimit, true);
  };
  return { register, pump, permitsApplication };
}

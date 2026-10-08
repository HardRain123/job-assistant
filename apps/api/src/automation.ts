import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Store } from "../../../packages/storage/src/index.ts";
import type { Assessment } from "../../../packages/contracts/src/index.ts";

const key = "automation.current";
const configSchema = z
  .object({
    keywords: z.array(z.string().trim().min(1).max(80)).min(1).max(5),
    city: z.enum(["上海", "全国"]),
    maxJobs: z.number().int().min(1).max(50),
    maxPages: z.number().int().min(1).max(10),
    autoAssess: z.boolean(),
    intervalSeconds: z.number().int().min(3).max(30),
  })
  .strict();
type Config = z.infer<typeof configSchema>;
const supportsAutomation = (version: string | null) => {
  if (!version) return false;
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return major > 0 || minor > 2 || (minor === 2 && patch >= 4);
};
type State = "running" | "paused" | "blocked" | "completed" | "cancelled";
interface Command {
  id: string;
  runId: string;
  leaseToken: string;
  kind: "search" | "next" | "detail";
  url: string;
  searchUrl?: string;
  previousSignature?: string;
  intervalSeconds: number;
}
interface Run {
  id: string;
  state: State;
  phase: "collecting" | "scoring" | "done";
  config: Config;
  discovered: number;
  visited: number;
  imported: number;
  scored: number;
  failed: number;
  unreadableJobs?: { url: string; reason: string }[];
  fieldReadings?: { url: string; reading: z.infer<typeof fieldReadingSchema>; message: string }[];
  consecutiveUnreadable?: number;
  eligible: number;
  review: number;
  skipped: number;
  currentUrl: string | null;
  message: string;
  createdAt: string;
  updatedAt: string;
  // Private server state. Never expose leases, resume/config fingerprints or queues to UI.
  configurationKey: string;
  keywordIndex: number;
  page: number;
  hasNext: boolean;
  searchUrl: string | null;
  signature: string;
  pendingUrls: string[];
  seenUrls: string[];
  jobIds: string[];
  scoredIds: string[];
  receipts: string[];
  lease: { command: Command; expiresAt: number } | null;
}
interface Options {
  store: Store;
  extensionStatus: () => {
    paired: boolean;
    lastSeen: string | null;
    version: string | null;
  };
  importJobs: (
    body: unknown,
    withinTransaction?: boolean,
  ) => { count: number; jobIds: string[] };
  configurationKey: () => string;
  ensureReady: (autoAssess: boolean) => void;
  scoreJob: (id: string, signal: AbortSignal) => Promise<Assessment>;
  now?: () => number;
}
export function canonicalJobUrl(value: string) {
  const u = new URL(value);
  if (
    u.origin !== "https://www.zhipin.com" ||
    u.username ||
    u.password ||
    !/^\/job_detail\/[a-zA-Z0-9_-]+\.html$/.test(u.pathname)
  )
    throw new Error("岗位链接不符合 BOSS 详情页格式");
  u.search = "";
  u.hash = "";
  return u.href;
}
const reasons: Record<string, string> = {
  "login-required": "BOSS 登录已失效，请在自动任务标签页登录后继续。",
  "verification-required": "BOSS 需要人工验证，请在自动任务标签页完成后继续。",
  "page-unrecognized": "没有识别到完整岗位或列表，请检查任务标签页。",
  "navigation-failed": "岗位页面加载失败，请检查浏览器后继续。",
  "tab-closed": "自动任务标签页已关闭或发生变化，继续后将重新打开。",
  "page-repeated": "翻页后仍是相同岗位，已暂停以避免重复采集。",
};
const diagnosticStages = {
  "status-check": "检查任务状态",
  "opening-tab": "打开标签页",
  navigating: "导航到页面",
  "waiting-page": "等待页面加载",
  "reading-page": "读取页面",
  "advancing-page": "翻页",
  reporting: "提交回执",
} as const;
const diagnosticCodes = {
  "permission-denied": "扩展权限不足",
  "script-error": "页面脚本执行失败",
  "tab-unavailable": "任务标签页不可用",
  "url-mismatch": "页面地址与任务不一致",
  "document-loading": "页面仍在加载",
  "dom-unrecognized": "页面内容未识别",
  "card-missing": "卡片未找到",
  "card-incomplete": "卡片标题或公司不完整",
  "panel-missing": "详情面板未找到",
  "panel-incomplete": "详情标题或正文未识别",
  "identity-mismatch": "详情与目标岗位身份不一致",
  "detail-unchanged": "点击后详情未更新",
  "request-failed": "请求失败",
  "unknown-error": "未知错误",
} as const;
const diagnosticTabStates = {
  loading: "加载中",
  complete: "加载完成",
  unknown: "状态未知",
} as const;
const diagnosticSchema = z.object({
  stage: z.enum(Object.keys(diagnosticStages) as [keyof typeof diagnosticStages, ...(keyof typeof diagnosticStages)[]]),
  code: z.enum(Object.keys(diagnosticCodes) as [keyof typeof diagnosticCodes, ...(keyof typeof diagnosticCodes)[]]),
  tabState: z.enum(["loading", "complete", "unknown"]).optional(),
}).strict();
function diagnosticMessage(diagnostic: z.infer<typeof diagnosticSchema>) {
  const tabState = diagnostic.tabState
    ? `；标签页：${diagnosticTabStates[diagnostic.tabState]}`
    : "";
  return `诊断：${diagnosticStages[diagnostic.stage]}；${diagnosticCodes[diagnostic.code]}${tabState}。`;
}
const fieldReadingSchema = z.object({
  route: z.enum(["split", "standalone", "supplement"]),
  merge: z.enum(["not-needed", "merged", "conflict", "title-mismatch", "company-mismatch", "detail-unavailable", "standalone-selected"]),
  salary: z.enum(["readable", "encoded", "unrecognized", "missing", "unchecked"]),
  location: z.enum(["readable", "missing", "unchecked"]),
  industry: z.enum(["readable", "employer-unknown", "company-mismatch", "unrecognized", "section-missing", "conflict", "unchecked"]),
  finalSalary: z.boolean(),
  finalLocation: z.boolean(),
  finalIndustry: z.boolean(),
}).strict();
function fieldReadingMessage(value: z.infer<typeof fieldReadingSchema>) {
  const route = { split: "右侧详情", standalone: "独立详情", supplement: "右侧详情及独立详情补读" }[value.route];
  const merge = { "not-needed": "", merged: "已核对并合并", conflict: "两处字段冲突，冲突字段保持未知", "title-mismatch": "两处职位名称不一致，未合并", "company-mismatch": "两处公司名称不一致，未合并", "detail-unavailable": "独立详情未能完整读取，保留右侧详情", "standalone-selected": "两处公司名称不同，已核对岗位链接和标题，采用独立详情完整记录" }[value.merge];
  const salary = { readable: "读到薪资文本", encoded: "薪资含不可解析字符", unrecognized: "薪资文本格式未识别", missing: "未找到薪资文字", unchecked: "未检查独立页薪资" }[value.salary];
  const industry = { readable: "读到行业", "employer-unknown": "客户公司行业无法确认", "company-mismatch": "公司信息区名称未对应", unrecognized: "行业字段位置未识别", "section-missing": "未找到公司信息区", conflict: "行业值存在冲突", unchecked: "未检查独立页行业" }[value.industry];
  const missing = [!value.finalSalary && "薪资", !value.finalLocation && "地点", !value.finalIndustry && "行业"].filter(Boolean);
  return [route, merge, salary, industry, value.location === "missing" ? "未识别地点" : "", missing.length ? `入库仍缺：${missing.join("、")}` : "入库字段齐全（薪资金额仍需解析）"].filter(Boolean).join("；");
}
const resultSchema = z
  .object({
    commandId: z.string().uuid(),
    runId: z.string().uuid(),
    leaseToken: z.string().uuid(),
    outcome: z.enum(["ok", "blocked", "error"]),
    url: z.string().max(2000),
    jobs: z.array(z.unknown()).max(1).optional(),
    links: z.array(z.string().max(2000)).max(30).optional(),
    hasNext: z.boolean().optional(),
    signature: z.string().max(20000).optional(),
    reason: z
      .enum([
        "login-required",
        "verification-required",
        "page-unrecognized",
        "navigation-failed",
        "tab-closed",
        "page-repeated",
      ])
      .optional(),
    diagnostic: diagnosticSchema.optional(),
    fieldReading: fieldReadingSchema.optional(),
    detailContext: z.object({
      jobUrl: z.string().max(2000),
      title: z.string().trim().min(1).max(500),
      company: z.string().trim().min(1).max(500),
    }).strict().optional(),
  })
  .strict();

export function createAutomation(o: Options) {
  const now = o.now ?? Date.now;
  let scoring: AbortController | null = null;
  let pumping: Promise<void> | null = null;
  const load = () => o.store.get<Run | null>(key, null);
  const save = (r: Run) => {
    r.updatedAt = new Date(now()).toISOString();
    o.store.set(key, r);
  };
  const publicRun = (r: Run | null) =>
    r && {
      id: r.id,
      state: r.state,
      phase: r.phase,
      config: r.config,
      discovered: r.discovered,
      visited: r.visited,
      imported: r.imported,
      scored: r.scored,
      failed: r.failed,
      unreadableJobs: r.unreadableJobs ?? [],
      fieldReadings: r.fieldReadings ?? [],
      eligible: r.eligible,
      review: r.review,
      skipped: r.skipped,
      currentUrl: r.currentUrl,
      message: r.message,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  function block(r: Run, message: string) {
    r.state = "blocked";
    r.message = message;
    r.lease = null;
    save(r);
    scoring?.abort();
  }
  function reconcile() {
    const r = load();
    if (r?.state === "running") {
      if (r.configurationKey !== o.configurationKey())
        block(
          r,
          "匹配策略、简历或模型配置发生变化，请停止本次任务并重新开始。",
        );
      else if (!o.extensionStatus().paired)
        block(r, "扩展连接已失效，请重新配对后继续。");
      else if (r.lease && r.lease.expiresAt <= now())
        block(r, "扩展执行回执超时，已保留进度；检查浏览器后继续。");
    }
    return r;
  }
  function finishCollection(r: Run) {
    r.lease = null;
    r.currentUrl = null;
    if (r.config.autoAssess && r.jobIds.length) {
      r.phase = "scoring";
      r.message = "采集结束，正在自动筛选和评分。";
    } else {
      r.phase = "done";
      r.state = "completed";
      r.message = r.imported
        ? "采集完成，岗位已进入岗位库。"
        : "搜索结束，没有采集到完整岗位。";
    }
    save(r);
  }
  function makeSearch(r: Run) {
    const url = new URL("https://www.zhipin.com/web/geek/jobs");
    url.searchParams.set("query", r.config.keywords[r.keywordIndex]!);
    url.searchParams.set(
      "city",
      r.config.city === "上海" ? "101020100" : "100010000",
    );
    return url.href;
  }
  function claim() {
    const r = reconcile();
    if (!r || r.state !== "running" || r.phase !== "collecting" || r.lease)
      return { command: null };
    if (r.imported >= r.config.maxJobs) {
      finishCollection(r);
      return { command: null };
    }
    let kind: Command["kind"], url: string;
    if (r.pendingUrls.length) {
      kind = "detail";
      url = r.pendingUrls[0]!;
    } else if (!r.page) {
      kind = "search";
      url = makeSearch(r);
    } else if (r.hasNext && r.page < r.config.maxPages) {
      kind = "next";
      url = r.searchUrl!;
    } else {
      r.keywordIndex++;
      r.page = 0;
      r.signature = "";
      r.hasNext = false;
      if (r.keywordIndex >= r.config.keywords.length) {
        finishCollection(r);
        return { command: null };
      }
      kind = "search";
      url = makeSearch(r);
    }
    const command: Command = {
      id: randomUUID(),
      runId: r.id,
      leaseToken: randomUUID(),
      kind,
      url,
      ...(kind === "detail" && r.searchUrl ? { searchUrl: r.searchUrl } : {}),
      ...(kind === "next" ? { previousSignature: r.signature } : {}),
      intervalSeconds: r.config.intervalSeconds,
    };
    r.lease = { command, expiresAt: now() + 180000 };
    r.currentUrl = url;
    r.message =
      kind === "detail"
        ? "正在读取完整岗位详情。"
        : kind === "next"
          ? "正在读取下一页岗位。"
          : `正在搜索：${r.config.keywords[r.keywordIndex]}`;
    save(r);
    return { command };
  }
  function result(body: unknown) {
    const b = resultSchema.parse(body);
    const r = reconcile();
    if (!r || r.id !== b.runId)
      throw new Error("任务已结束或已替换，忽略旧回执");
    if (r.receipts.includes(b.commandId)) return { ok: true };
    const cmd = r.lease?.command;
    if (
      r.state !== "running" ||
      !cmd ||
      cmd.id !== b.commandId ||
      cmd.leaseToken !== b.leaseToken
    )
      throw new Error("任务已暂停或命令租约已失效");
    if (b.outcome !== "ok") {
      const message = reasons[b.reason ?? "page-unrecognized"]!;
      if (cmd.kind === "detail" && b.outcome === "error" && b.reason === "page-unrecognized" &&
          b.diagnostic?.code === "card-incomplete" && (r.consecutiveUnreadable ?? 0) < 2) {
        const actual = new URL(b.url);
        const search = cmd.searchUrl ? new URL(cmd.searchUrl) : null;
        const boundPage = actual.origin === "https://www.zhipin.com" && !actual.username && !actual.password &&
          (actual.pathname === new URL(cmd.url).pathname ||
            (search && /^\/web\/geek\/jobs?\/?$/.test(actual.pathname) &&
              actual.searchParams.get("query") === search.searchParams.get("query") &&
              actual.searchParams.get("city") === search.searchParams.get("city")));
        if (!boundPage) throw new Error("不完整详情不属于当前任务页面");
        o.store.transaction(() => {
          (r.unreadableJobs ??= []).push({ url: cmd.url, reason: "标题或公司信息不完整，未导入" });
          r.consecutiveUnreadable = (r.consecutiveUnreadable ?? 0) + 1;
          r.visited++;
          r.pendingUrls.shift();
          r.receipts.push(cmd.id);
          r.lease = null;
          r.message = "一个岗位信息不完整，已记录原因，继续其他候选。";
          save(r);
        });
        return { ok: true };
      }
      block(r, b.diagnostic ? `${message} ${diagnosticMessage(b.diagnostic)}` : message);
      return { ok: true };
    }
    const actual = new URL(b.url);
    if (
      actual.origin !== "https://www.zhipin.com" ||
      actual.username ||
      actual.password
    )
      throw new Error("页面来源发生变化");
    o.store.transaction(() => {
      if (cmd.kind === "detail") {
        if (b.jobs?.length !== 1)
          throw new Error("岗位详情与当前任务不一致");
        const job = b.jobs[0] as { url?: unknown; detail?: unknown; title?: unknown; company?: unknown } | null;
        if (
          !job ||
          typeof job.url !== "string" ||
          canonicalJobUrl(job.url) !== cmd.url ||
          job.detail !== true
        )
          throw new Error("只接受当前任务的完整岗位详情");
        if (b.detailContext) {
          if (!cmd.searchUrl || !/^\/web\/geek\/jobs?\/?$/.test(actual.pathname))
            throw new Error("同页详情缺少对应的搜索页面");
          const expected = new URL(cmd.searchUrl);
          if (actual.searchParams.get("query") !== expected.searchParams.get("query") ||
              actual.searchParams.get("city") !== expected.searchParams.get("city") ||
              canonicalJobUrl(b.detailContext.jobUrl) !== cmd.url ||
              b.detailContext.title !== job.title || b.detailContext.company !== job.company)
            throw new Error("同页详情与目标卡片或搜索条件不一致");
        } else if (canonicalJobUrl(b.url) !== cmd.url) {
          throw new Error("岗位详情与当前任务不一致");
        }
        const imported = o.importJobs({ jobs: b.jobs }, true);
        if (b.fieldReading) {
          (r.fieldReadings ??= []).push({ url: cmd.url, reading: b.fieldReading, message: fieldReadingMessage(b.fieldReading) });
          r.fieldReadings = r.fieldReadings.slice(-50);
        }
        r.jobIds = [...new Set([...r.jobIds, ...imported.jobIds])];
        r.imported = r.jobIds.length;
        r.visited++;
        r.consecutiveUnreadable = 0;
        r.pendingUrls.shift();
      } else {
        if (!/^\/web\/geek\/jobs?\/?$/.test(actual.pathname))
          throw new Error("结果不是 BOSS 搜索页面");
        const expected = new URL(makeSearch(r));
        if (
          actual.searchParams.get("query") !==
            expected.searchParams.get("query") ||
          actual.searchParams.get("city") !== expected.searchParams.get("city")
        )
          throw new Error("搜索关键词或城市发生变化");
        if (!b.links || b.hasNext === undefined)
          throw new Error("搜索结果缺少翻页状态");
        const links = [...new Set(b.links.map(canonicalJobUrl))];
        const signature = [...links].sort().join("|");
        if (cmd.kind === "next" && signature && signature === r.signature) {
          block(r, reasons["page-repeated"]!);
          return;
        }
        r.pendingUrls.push(...links.filter((url) => !r.seenUrls.includes(url)));
        r.seenUrls = [...new Set([...r.seenUrls, ...links])];
        r.discovered = r.seenUrls.length;
        r.page = cmd.kind === "search" ? 1 : r.page + 1;
        r.hasNext = b.hasNext;
        r.signature = signature;
        r.searchUrl = b.url;
      }
      r.receipts.push(cmd.id);
      r.lease = null;
      r.message = "正在准备下一步。";
      save(r);
      if (r.imported >= r.config.maxJobs) finishCollection(r);
    });
    return { ok: true };
  }
  async function pumpOne() {
    const r = reconcile();
    if (!r || r.state !== "running" || r.phase !== "scoring") return;
    const id = r.jobIds.find((id) => !r.scoredIds.includes(id));
    if (!id) {
      r.state = "completed";
      r.phase = "done";
      r.message = r.failed
        ? `采集和评分流程结束，${r.failed} 个岗位评分失败，可在岗位库重试。`
        : "采集与评分完成，请在岗位库查看匹配结果。";
      save(r);
      return;
    }
    const abort = new AbortController();
    scoring = abort;
    let outcome: Assessment["decision"] = "unavailable";
    try {
      outcome = (await o.scoreJob(id, abort.signal)).decision;
    } catch {
      /* Public error text is deliberately fixed below. */
    } finally {
      if (scoring === abort) scoring = null;
    }
    const current = reconcile();
    if (
      abort.signal.aborted ||
      !current ||
      current.id !== r.id ||
      current.state !== "running" ||
      current.scoredIds.includes(id)
    )
      return;
    current.scoredIds.push(id);
    if (outcome === "unavailable") current.failed++;
    else {
      current.scored++;
      if (outcome === "eligible") current.eligible++;
      else if (outcome === "review") current.review++;
      else current.skipped++;
    }
    current.message =
      outcome === "unavailable"
        ? "有岗位评分暂不可用，将继续处理其他岗位。"
        : "正在自动筛选和评分。";
    save(current);
  }
  function pump() {
    if (pumping) return pumping;
    pumping = pumpOne().finally(() => {
      pumping = null;
    });
    return pumping;
  }
  function register(app: FastifyInstance) {
    app.get("/api/automation", () => ({
      run: publicRun(reconcile()),
      extension: o.extensionStatus(),
    }));
    app.post("/api/automation/start", (req) => {
      const config = configSchema.parse(req.body);
      config.keywords = [...new Set(config.keywords)];
      const previous = reconcile();
      if (previous && !["completed", "cancelled"].includes(previous.state))
        throw new Error("已有任务，请先继续或停止当前任务");
      const extension = o.extensionStatus();
      if (!extension.paired) throw new Error("请先在浏览器扩展中完成配对");
      if (!supportsAutomation(extension.version))
        throw new Error(
          "请刷新升级到 0.2.4 或更新的扩展，并在扩展中检查自动任务",
        );
      o.ensureReady(config.autoAssess);
      if (previous) o.store.set(`automation.history:${previous.id}`, previous);
      const stamp = new Date(now()).toISOString();
      const r: Run = {
        id: randomUUID(),
        state: "running",
        phase: "collecting",
        config,
        discovered: 0,
        visited: 0,
        imported: 0,
        scored: 0,
        failed: 0,
        eligible: 0,
        review: 0,
        skipped: 0,
        currentUrl: null,
        message: "任务已创建，等待浏览器扩展接收（通常 30 秒内）。",
        createdAt: stamp,
        updatedAt: stamp,
        configurationKey: o.configurationKey(),
        keywordIndex: 0,
        page: 0,
        hasNext: false,
        searchUrl: null,
        signature: "",
        pendingUrls: [],
        seenUrls: [],
        jobIds: [],
        scoredIds: [],
        receipts: [],
        lease: null,
      };
      save(r);
      o.store.audit("automation.started", { id: r.id, config });
      return { run: publicRun(r) };
    });
    app.post("/api/automation/control", (req) => {
      const { action } = z
        .object({ action: z.enum(["pause", "resume", "cancel"]) })
        .strict()
        .parse(req.body);
      const r = reconcile();
      if (!r || ["completed", "cancelled"].includes(r.state))
        throw new Error("没有可操作的进行中任务");
      scoring?.abort();
      r.lease = null;
      if (action === "resume") {
        if (r.configurationKey !== o.configurationKey())
          throw new Error("任务配置已变化，请停止并重新开始");
        if (!o.extensionStatus().paired) throw new Error("请先恢复扩展连接");
        if (!supportsAutomation(o.extensionStatus().version))
          throw new Error("请先刷新升级到 0.2.4 或更新的扩展");
        o.ensureReady(r.config.autoAssess);
        // Restart this keyword if the search tab was lost; seen URLs keep
        // previously imported jobs from being revisited.
        if (r.phase === "collecting") {
          r.page = 0;
          r.signature = "";
          r.hasNext = false;
        }
        r.state = "running";
        r.message = "任务继续，等待扩展接收。";
      } else {
        r.state = action === "pause" ? "paused" : "cancelled";
        r.message =
          action === "pause"
            ? "任务已暂停，已开始的只读导航可能仍会完成。"
            : "任务已停止，已采集的岗位和评分保留。";
      }
      save(r);
      return { run: publicRun(r) };
    });
    app.post("/extension/v1/claim", claim);
    app.post("/extension/v1/result", (req) => result(req.body));
    // No personal data, provider credentials or write commands are returned.
    app.post("/extension/v1/automation-status", () => {
      const r = reconcile();
      return { run: r ? { id: r.id, state: r.state, phase: r.phase } : null };
    });
    const timer = setInterval(() => {
      void pump().catch(() => {});
    }, 1000);
    timer.unref();
    app.addHook("onClose", async () => {
      clearInterval(timer);
      scoring?.abort();
      await pumping;
    });
  }
  return { register, pump };
}

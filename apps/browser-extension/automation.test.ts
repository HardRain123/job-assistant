import assert from "node:assert/strict";
import test from "node:test";

type NodeLike = { innerText?: string; href?: string; title?: string; disabled?: boolean; parentElement?: NodeLike | null; getClientRects(): unknown[]; getAttribute(name: string): string | null; classList: { contains(name: string): boolean }; closest(selector: string): NodeLike | null; click(): void };
const listeners = { addListener() {} };
const store: Record<string, unknown> = {};
let tab = { id: 7, url: "https://www.zhipin.com/web/geek/job?city=101010100", status: "complete" };
let scriptResult: unknown = null;
let scriptNames: string[] = [];
let scriptResults: Record<string, unknown> | null = null;
let scriptError: Error | null = null;

(globalThis as Record<string, unknown>).chrome = {
  alarms: { create() {}, onAlarm: listeners },
  runtime: { onStartup: listeners, onInstalled: listeners, onMessage: listeners },
  storage: {
    local: { async get() { return { jobAssistantToken: "token" }; }, async set(value: Record<string, unknown>) { Object.assign(store, value); } },
    session: { async get(key: string) { return { [key]: store[key] ?? {} }; }, async set(value: Record<string, unknown>) { Object.assign(store, value); } },
  },
  tabs: {
    async get() { return tab; },
    async create() { return tab; },
    async update(_id: number, value: { url: string }) { tab = { ...tab, url: value.url }; return tab; },
  },
  scripting: { async executeScript(options: { func: { name: string } }) { scriptNames.push(options.func.name); if (scriptError) throw scriptError; return [{ result: scriptResults ? scriptResults[options.func.name] : scriptResult }]; } },
};

// @ts-expect-error The shipped MV3 module is deliberately plain JavaScript.
const worker = await import("./automation.mjs");

function node(text = "", extra: Partial<NodeLike> = {}): NodeLike {
  return { innerText: text, getClientRects: () => [1], getAttribute: () => null, classList: { contains: () => false }, closest: () => null, click() {}, ...extra };
}
function installDom(nodes: Record<string, NodeLike[]>, path = "/web/geek/job") {
  Object.assign(globalThis, {
    location: { pathname: path, href: `https://www.zhipin.com${path}` },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    document: { querySelectorAll: (selector: string) => nodes[selector] ?? [] },
  });
}
function response(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}
const command = { id: "c", runId: "r", leaseToken: "l", kind: "next" as const, url: "https://www.zhipin.com/web/geek/job?city=101010100", previousSignature: "https://www.zhipin.com/job_detail/a.html", intervalSeconds: 0 };

test("footer login text does not block, while visible login and verification controls do", () => {
  installDom({ "a[href*='/job_detail/']": [], "button, a": [], ".job-list-box, [class*='job-list'], [class*='empty']": [] });
  assert.equal(worker.inspectSearch().login, false);
  installDom({ ".login-dialog form": [node()], "a[href*='/job_detail/']": [], "button, a": [], ".job-list-box, [class*='job-list'], [class*='empty']": [] });
  assert.equal(worker.inspectSearch().login, true);
  installDom({ ".verify-dialog": [node()], "a[href*='/job_detail/']": [], "button, a": [], ".job-list-box, [class*='job-list'], [class*='empty']": [] });
  assert.equal(worker.inspectSearch().challenge, true);
  installDom({ "a[href*='/job_detail/']": [], "button, a": [], ".job-list-box, [class*='job-list'], [class*='empty']": [] }, "/web/user/");
  assert.equal(worker.inspectSearch().login, true);
});

test("search URL matching permits BOSS normalization but rejects a changed query or city", () => {
  const intended = "https://www.zhipin.com/web/geek/job?query=frontend&city=101010100&degree=203";
  assert.equal(worker.matchesIntendedUrl("https://www.zhipin.com/web/geek/jobs?city=101010100&query=frontend&ka=search_list", intended, "search"), true);
  assert.equal(worker.matchesIntendedUrl("https://www.zhipin.com/web/geek/jobs?query=AI%E5%BA%94%E7%94%A8%E5%BC%80%E5%8F%91&city=101020100", "https://www.zhipin.com/web/geek/job?city=101020100&query=AI%E5%BA%94%E7%94%A8%E5%BC%80%E5%8F%91", "search"), true);
  assert.equal(worker.matchesIntendedUrl("https://www.zhipin.com/web/geek/job?city=101010100&query=backend", intended, "search"), false);
  assert.equal(worker.matchesIntendedUrl("https://www.zhipin.com/web/geek/job?query=frontend&city=101020100", intended, "search"), false);
});

test("observed BOSS pagination icon is accepted only through its enabled control", () => {
  let clicks = 0;
  const control = node("", { click: () => { clicks += 1; } });
  const icon = node("", { parentElement: control, closest: () => control });
  installDom({ "a[href*='/job_detail/']": [], "button, a": [], ".ui-icon-arrow-right": [icon], ".job-list-box, [class*='job-list'], [class*='empty']": [] });
  assert.equal(worker.inspectSearch().hasNext, true);
  assert.deepEqual(worker.advanceSearch(), { clicked: true });
  assert.equal(clicks, 1);
  const disabled = node("", { classList: { contains: (name) => name === "disabled" } });
  installDom({ "a[href*='/job_detail/']": [], "button, a": [], ".ui-icon-arrow-right": [node("", { parentElement: disabled, closest: () => control })], ".job-list-box, [class*='job-list'], [class*='empty']": [] });
  assert.equal(worker.inspectSearch().hasNext, false);
  installDom({ "a[href*='/job_detail/']": [], "button, a": [], ".ui-icon-arrow-right": [node("", { getClientRects: () => [], parentElement: control, closest: () => control })], ".job-list-box, [class*='job-list'], [class*='empty']": [] });
  assert.equal(worker.inspectSearch().hasNext, false);
});

test("waitForUrl requires a completed tab and recognized rendered list", async () => {
  const originalTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => { queueMicrotask(fn); return 1 as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout;
  try {
    tab = { ...tab, status: "loading" };
    scriptResult = { recognized: true, links: ["https://www.zhipin.com/job_detail/a.html"] };
    const pending = worker.waitForUrl(7, tab.url, "search", "token", "r");
    queueMicrotask(() => { tab = { ...tab, status: "complete" }; });
    assert.deepEqual(await pending, { ok: true });
  } finally { globalThis.setTimeout = originalTimeout; }
});

test("waitForUrl reports a completed login redirect before matching the requested URL", async () => {
  tab = { ...tab, url: "https://www.zhipin.com/web/user/?ka=header-login", status: "complete" };
  scriptResult = { login: true, challenge: false, recognized: false, links: [] };
  assert.deepEqual(await worker.waitForUrl(7, "https://www.zhipin.com/web/geek/job?city=101010100", "search", "token", "r"), { blocked: scriptResult });
});

test("waitForUrl distinguishes an opened but unrecognized matching page", async () => {
  const originalTimeout = globalThis.setTimeout;
  const originalFetch = globalThis.fetch;
  globalThis.setTimeout = ((fn: () => void) => { queueMicrotask(fn); return 1 as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout;
  globalThis.fetch = (async () => response({ run: { id: "r", state: "running" } })) as typeof fetch;
  try {
  tab = { ...tab, url: "https://www.zhipin.com/web/geek/jobs?query=frontend&city=101010100", status: "complete" };
  scriptResult = { login: false, challenge: false, recognized: false, links: [] };
  assert.deepEqual(await worker.waitForUrl(7, tab.url, "search", "token", "r"), { unrecognized: true, failure: { code: "dom-unrecognized", tabState: "complete" } });
  } finally { globalThis.setTimeout = originalTimeout; globalThis.fetch = originalFetch; }
});

test("waitForUrl waits for delayed SPA content after the tab completes", async () => {
  const originalTimeout = globalThis.setTimeout;
  let waits = 0;
  try {
    tab = { ...tab, url: "https://www.zhipin.com/web/geek/jobs?query=AI&city=101020100", status: "complete" };
    scriptResult = { recognized: false, links: [], pageUrl: tab.url, readyState: "complete" };
    globalThis.setTimeout = ((fn: () => void) => {
      waits++;
      scriptResult = { recognized: true, links: ["https://www.zhipin.com/job_detail/a.html"], pageUrl: tab.url, readyState: "complete" };
      queueMicrotask(fn);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    assert.deepEqual(await worker.waitForUrl(7, tab.url, "search", "token", "r"), { ok: true });
    assert.equal(waits, 1);
  } finally { globalThis.setTimeout = originalTimeout; }
});

test("inline details report the actual search URL and bound identity, rejecting a mismatched panel", async () => {
  const originalFetch = globalThis.fetch;
  const reports: Array<Record<string, unknown>> = [];
  const url = "https://www.zhipin.com/job_detail/a.html";
  const searchUrl = "https://www.zhipin.com/web/geek/jobs?query=AI&city=101020100";
  const job = { url, title: "AI工程师", company: "示例公司", description: "开发企业AI应用", detail: true, salaryText: "25-35K", location: "上海", industry: "软件" };
  try {
    globalThis.fetch = (async (path: string, options: RequestInit) => {
      if (path.endsWith("/result")) { reports.push(JSON.parse(String(options.body))); return response({ ok: true }); }
      return response({ run: { id: "r", state: "running" } });
    }) as typeof fetch;
    store.jobAssistantAutomationTabs = { runId: "r", searchTabId: 7 };
    tab = { ...tab, url: searchUrl, status: "complete" };
    scriptResults = {
      inspectSearch: { recognized: true, links: [url] },
      inspectSplitSearch: { recognized: true, links: [url] },
      clickAndReadSplitDetail: { ok: true, job, detailContext: { jobUrl: url, title: job.title, company: job.company } },
    };
    const detailCommand = { ...command, kind: "detail", url, searchUrl };
    await worker.execute(detailCommand, "token");
    assert.equal(reports[0]?.outcome, "ok");
    assert.equal(reports[0]?.url, searchUrl);
    assert.deepEqual(reports[0]?.jobs, [job]);
    assert.deepEqual(reports[0]?.detailContext, { jobUrl: url, title: job.title, company: job.company });
    scriptResults.clickAndReadSplitDetail = { ok: true, job, detailContext: { jobUrl: url, title: "其他岗位", company: job.company } };
    await worker.execute(detailCommand, "token");
    assert.equal(reports[1]?.outcome, "error");
    assert.equal(reports[1]?.reason, "page-unrecognized");
    assert.equal(tab.url, searchUrl);
    // A refreshed extension loses its session tab IDs but retains the API queue.
    store.jobAssistantAutomationTabs = {};
    scriptResults.clickAndReadSplitDetail = { ok: true, job, detailContext: { jobUrl: url, title: job.title, company: job.company } };
    await worker.execute(detailCommand, "token");
    assert.equal(reports[2]?.outcome, "ok");
    assert.equal(reports[2]?.url, searchUrl);
    assert.equal(tab.url, searchUrl);
    scriptResults.clickAndReadSplitDetail = { ok: false, failureCode: "panel-missing" };
    await worker.execute(detailCommand, "token");
    assert.deepEqual(reports[3]?.diagnostic, { stage: "reading-page", code: "panel-missing" });
  } finally { globalThis.fetch = originalFetch; scriptResults = null; }
});

test("同页缺字段时核验独立详情，保留完整雇主记录，拒绝错误链接或标题", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = globalThis.setTimeout;
  const url = "https://www.zhipin.com/job_detail/a.html";
  const searchUrl = "https://www.zhipin.com/web/geek/jobs?query=AI&city=101020100";
  const base = { url, title: "AI工程师", company: "示例公司", description: "企业 AI 应用开发", detail: true, location: "上海", salaryText: "", industry: "" };
  const detail = { ...base, company: "示例公司有限公司", salaryText: "25-35K", industry: "计算机软件" };
  const evidence = { title: base.title, company: base.company, descriptionPresent: true, clientLabelSeen: false, clientNames: [], headerLines: ["25-35K"], companySections: [] };
  const reports: Array<Record<string, any>> = [];
  try {
    globalThis.setTimeout = ((fn: () => void) => { queueMicrotask(fn); return 1 as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout;
    globalThis.fetch = (async (path: string, options: RequestInit) => {
      if (path.endsWith("/result")) { reports.push(JSON.parse(String(options.body))); return response({ ok: true }); }
      return response({ run: { id: "r", state: "running" } });
    }) as typeof fetch;
    const run = async (inlineJob: typeof base, standalone: typeof detail, page = {}, extractedUrl = url) => {
      reports.length = 0;
      scriptNames = [];
      store.jobAssistantAutomationTabs = { runId: "r", searchTabId: 7 };
      tab = { ...tab, url: searchUrl, status: "complete" };
      scriptResults = {
        inspectSearch: { recognized: true, links: [url] },
        inspectSplitSearch: { recognized: true, links: [url] },
        clickAndReadSplitDetail: { ok: true, job: inlineJob, detailContext: { jobUrl: url, title: inlineJob.title, company: inlineJob.company } },
        inspectDetail: { recognized: true, ...page },
        extractJobs: { pageUrl: extractedUrl, pageEvidence: evidence, jobs: standalone ? [standalone] : [], fieldReading: { salary: "encoded", industry: "section-missing", location: "readable", private: "should-not-leak" } },
      };
      await worker.execute({ ...command, kind: "detail", url, searchUrl }, "token");
      assert.equal(reports.length, 1);
      assert.equal(scriptNames.filter((name) => name === "clickAndReadSplitDetail").length, 1);
      return reports[0];
    };
    const supplemented = await run(base, detail);
    assert.equal(supplemented.outcome, "ok");
    assert.equal(supplemented.url, searchUrl);
    assert.deepEqual(supplemented.detailContext, { jobUrl: url, title: base.title, company: base.company });
    assert.equal(supplemented.jobs[0].salaryText, "25-35K");
    assert.equal(supplemented.jobs[0].location, "上海");
    assert.equal(supplemented.jobs[0].industry, "计算机软件");
    assert.equal(scriptNames.filter((name) => name === "extractJobs").length, 1);
    assert.deepEqual(supplemented.fieldReading, { route: "supplement", merge: "merged", salary: "encoded", industry: "section-missing", location: "readable", finalSalary: true, finalLocation: true, finalIndustry: true });
    assert.ok(!JSON.stringify(supplemented).includes("should-not-leak"));
    assert.deepEqual(supplemented.pageEvidence, evidence);
    const wrongEvidence = await run(base, detail, {}, "https://www.zhipin.com/job_detail/other.html");
    assert.equal(wrongEvidence.pageEvidence, undefined);
    const conflict = await run({ ...base, salaryText: "20-30K", industry: "保险", location: "" }, detail);
    assert.equal(conflict.outcome, "ok");
    assert.equal(conflict.jobs[0].salaryText, "");
    assert.equal(conflict.jobs[0].industry, "");
    assert.equal(conflict.fieldReading.merge, "conflict");
    const wrongCompany = await run(base, { ...detail, company: "另一公司" });
    assert.equal(wrongCompany.outcome, "ok");
    assert.deepEqual(wrongCompany.jobs, [{ ...detail, company: "另一公司" }]);
    assert.equal(wrongCompany.url, url);
    assert.equal(wrongCompany.detailContext, undefined);
    assert.equal(wrongCompany.fieldReading.merge, "standalone-selected");
    const keepLocation = await run(base, { ...detail, company: "另一公司", location: "", companyAliases: ["公开品牌"] } as typeof detail);
    assert.equal(keepLocation.jobs[0].location, "上海");
    assert.deepEqual(keepLocation.jobs[0].companyAliases, ["公开品牌"]);
    assert.equal(keepLocation.fieldReading.finalLocation, true);
    const wrongTitle = await run(base, { ...detail, title: "另一职位" });
    assert.equal(wrongTitle.fieldReading.merge, "title-mismatch");
    const missing = await run(base, null as unknown as typeof detail);
    assert.equal(missing.outcome, "ok");
    assert.equal(missing.jobs[0].salaryText ?? "", "");
    assert.deepEqual(missing.pageEvidence, evidence);
    const wrongUrl = await run(base, { ...detail, url: "https://www.zhipin.com/job_detail/b.html" });
    assert.equal(wrongUrl.outcome, "error");
    assert.equal(wrongUrl.jobs, undefined);
    assert.equal(wrongUrl.pageEvidence, undefined);
    const login = await run(base, detail, { login: true });
    assert.equal(login.outcome, "blocked");
  } finally { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout; scriptResults = null; }
});

test("unchanged inline detail falls back once to the exact standalone URL with the same checks", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = globalThis.setTimeout;
  const url = "https://www.zhipin.com/job_detail/a.html";
  const searchUrl = "https://www.zhipin.com/web/geek/jobs?query=AI&city=101020100";
  const job = { url, title: "AI工程师", company: "示例公司", description: "企业AI应用开发", detail: true, salaryText: "25-35K", industry: "计算机软件" };
  const reports: Array<Record<string, unknown>> = [];
  try {
    globalThis.setTimeout = ((fn: () => void) => { queueMicrotask(fn); return 1 as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout;
    globalThis.fetch = (async (path: string, options: RequestInit) => {
      if (path.endsWith("/result")) { reports.push(JSON.parse(String(options.body))); return response({ ok: true }); }
      return response({ run: { id: "r", state: "running" } });
    }) as typeof fetch;
    for (const scenario of ["ok", "login", "challenge", "wrong-job", "identity-mismatch"]) {
      reports.length = 0;
      scriptNames = [];
      store.jobAssistantAutomationTabs = { runId: "r", searchTabId: 7 };
      tab = { ...tab, url: searchUrl, status: "complete" };
      scriptResults = {
        inspectSearch: { recognized: true, links: [url] },
        inspectSplitSearch: { recognized: true, links: [url] },
        clickAndReadSplitDetail: { ok: false, failureCode: scenario === "identity-mismatch" ? "identity-mismatch" : "detail-unchanged" },
        inspectDetail: { recognized: true, login: scenario === "login", challenge: scenario === "challenge" },
        extractJobs: { jobs: [{ ...job, url: scenario === "wrong-job" ? url.replace("a.html", "b.html") : url }] },
      };
      await worker.execute({ ...command, kind: "detail", url, searchUrl }, "token");
      assert.equal(reports.length, 1);
      assert.equal(scriptNames.filter((name) => name === "clickAndReadSplitDetail").length, 1);
      if (scenario === "ok") {
        assert.equal(reports[0]?.outcome, "ok");
        assert.equal(reports[0]?.url, url);
        assert.deepEqual(reports[0]?.jobs, [job]);
        assert.equal(reports[0]?.detailContext, undefined);
        assert.equal(scriptNames.filter((name) => name === "extractJobs").length, 1);
      } else if (scenario === "identity-mismatch") {
        assert.equal(tab.url, searchUrl);
        assert.equal(reports[0]?.outcome, "error");
        assert.equal(scriptNames.includes("inspectDetail"), false);
      } else if (scenario === "wrong-job") {
        assert.equal(reports[0]?.outcome, "error");
        assert.equal(reports[0]?.jobs, undefined);
      } else {
        assert.equal(reports[0]?.outcome, "blocked");
        assert.equal(reports[0]?.reason, scenario === "login" ? "login-required" : "verification-required");
        assert.equal(scriptNames.includes("extractJobs"), false);
      }
    }
  } finally { globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout; scriptResults = null; }
});

test("next never advances when paused, missing, or changed away from the commanded search", async () => {
  const originalFetch = globalThis.fetch;
  try {
    scriptNames = [];
    globalThis.fetch = (async () => response({ run: { id: "other", state: "running" } })) as typeof fetch;
    await worker.execute(command, "token");
    assert.deepEqual(scriptNames, []);

    scriptNames = [];
    store.jobAssistantAutomationTabs = { runId: "r" };
    globalThis.fetch = (async () => response({ run: { id: "r", state: "running" } })) as typeof fetch;
    await worker.execute(command, "token");
    assert.deepEqual(scriptNames, []);

    scriptNames = [];
    store.jobAssistantAutomationTabs = { runId: "r", searchTabId: 7 };
    tab = { ...tab, url: "https://www.zhipin.com/web/geek/job?city=999999999", status: "complete" };
    scriptResult = { recognized: true, links: ["https://www.zhipin.com/job_detail/a.html"], signature: "https://www.zhipin.com/job_detail/a.html" };
    await worker.execute(command, "token");
    assert.deepEqual(scriptNames, ["inspectSearch"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("a rejected initial status check is a POST and is reported with a fixed failure", async () => {
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  const reports: Array<Record<string, unknown>> = [];
  try {
    globalThis.fetch = (async (_url: string, options: RequestInit) => {
      methods.push(String(options.method));
      if (methods.length === 1) throw new Error("network unavailable");
      reports.push(JSON.parse(String(options.body)));
      return response({ ok: true });
    }) as typeof fetch;
    await worker.execute(command, "token");
    assert.deepEqual(methods, ["POST", "POST"]);
    assert.deepEqual(reports[0]?.outcome, "error");
    assert.deepEqual(reports[0]?.reason, "navigation-failed");
    assert.deepEqual(reports[0]?.diagnostic, { stage: "status-check", code: "request-failed" });
    assert.deepEqual(store.jobAssistantAutomationDiagnostic, { phase: "failed", status: "failed", reason: "navigation-failed" });
  } finally { globalThis.fetch = originalFetch; }
});

test("failed injection is classified without exposing the raw exception", async () => {
  const originalTimeout = globalThis.setTimeout;
  const originalFetch = globalThis.fetch;
  const reports: Array<Record<string, unknown>> = [];
  try {
    globalThis.setTimeout = ((fn: () => void) => { queueMicrotask(fn); return 1 as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout;
    globalThis.fetch = (async (path: string, options: RequestInit) => {
      if (path.endsWith("/result")) { reports.push(JSON.parse(String(options.body))); return response({ ok: true }); }
      return response({ run: { id: "r", state: "running" } });
    }) as typeof fetch;
    store.jobAssistantAutomationTabs = { runId: "r", searchTabId: 7 };
    tab = { ...tab, url: command.url, status: "complete" };
    scriptError = new Error("Cannot access contents of url https://private.example/?token=secret; missing host permission");
    await worker.execute({ ...command, kind: "search" }, "token");
    assert.deepEqual(reports[0]?.diagnostic, { stage: "waiting-page", code: "permission-denied", tabState: "complete" });
    assert.equal(JSON.stringify(reports).includes("private.example"), false);
    assert.equal(JSON.stringify(reports).includes("secret"), false);
    assert.equal(worker.classifyFailure(new Error("TypeError: value is not a function")), "script-error");
  } finally { globalThis.setTimeout = originalTimeout; globalThis.fetch = originalFetch; scriptError = null; }
});

test("an empty poll preserves the last fixed failure diagnostic", async () => {
  const originalFetch = globalThis.fetch;
  try {
    store.jobAssistantAutomationDiagnostic = { phase: "failed", status: "failed", reason: "page-unrecognized" };
    globalThis.fetch = (async () => response({ command: null })) as typeof fetch;
    await worker.wake();
    assert.deepEqual(store.jobAssistantAutomationDiagnostic, { phase: "failed", status: "failed", reason: "page-unrecognized" });
  } finally { globalThis.fetch = originalFetch; }
});

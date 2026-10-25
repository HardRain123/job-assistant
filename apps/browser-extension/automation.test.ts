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
    async update(_id: number, value: { url?: string; active?: boolean }) { tab = { ...tab, ...(value.url ? { url: value.url } : {}) }; return tab; },
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

test("自动任务请求沿用配对端口，连接被替换后不发送旧令牌", async () => {
  const browser = (globalThis as Record<string, any>).chrome;
  const originalGet = browser.storage.local.get, originalFetch = globalThis.fetch;
  const requests: string[] = [];
  try {
    browser.storage.local.get = async () => ({ jobAssistantToken: "token", jobAssistantPort: 3003 });
    globalThis.fetch = (async (url: string) => { requests.push(url); return response({ command: null, task: null }); }) as typeof fetch;
    await worker.wake();
    assert.ok(requests.length > 0);
    assert.ok(requests.every((url) => url.startsWith("http://127.0.0.1:3003/extension/")));
    requests.length = 0;
    let reads = 0;
    browser.storage.local.get = async () => ({ jobAssistantToken: ++reads === 1 ? "token" : "new-token", jobAssistantPort: 3004 });
    await worker.wake();
    assert.equal(requests.length, 0);
  } finally { browser.storage.local.get = originalGet; globalThis.fetch = originalFetch; }
});

function fakeClock(autoSleep = true) {
  const original = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now };
  let time = 1_000_000, nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock = {
    onSleep: () => {},
    now: () => time,
    advance(ms: number) {
      const end = time + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      time = end;
    },
    restore() { globalThis.setTimeout = original.setTimeout; globalThis.clearTimeout = original.clearTimeout; Date.now = original.now; },
  };
  Date.now = () => time;
  globalThis.setTimeout = ((callback: () => void, ms = 0) => {
    const id = ++nextId;
    timers.set(id, { at: time + Number(ms), callback });
    if (autoSleep && ms <= 500) queueMicrotask(async () => {
      // Let immediately resolved browser calls clear their deadline timers;
      // only genuinely pending short waits advance this synthetic clock.
      for (let turn = 0; turn < 12; turn++) await Promise.resolve();
      if (timers.has(id)) { clock.onSleep(); clock.advance(Number(ms)); }
    });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => { timers.delete(Number(id)); }) as typeof clearTimeout;
  return clock;
}
async function settle() { for (let turn = 0; turn < 100; turn++) await Promise.resolve(); }

async function executionFixture(action: (fixture: {
  browser: any; clock: ReturnType<typeof fakeClock>; reports: Array<Record<string, any>>;
  requests: string[]; scripts: string[]; navigations: unknown[]; searchUrl: string;
}) => Promise<void>) {
  const browser = (globalThis as Record<string, any>).chrome;
  const originalFetch = globalThis.fetch;
  const original = { tabs: { ...browser.tabs }, local: { ...browser.storage.local },
    session: { ...browser.storage.session }, scripting: { ...browser.scripting } };
  const clock = fakeClock();
  const reports: Array<Record<string, any>> = [], requests: string[] = [], scripts: string[] = [], navigations: unknown[] = [];
  const searchUrl = "https://www.zhipin.com/web/geek/jobs?query=Java&city=101020100";
  try {
    tab = { ...tab, url: searchUrl, status: "complete" };
    store.jobAssistantAutomationTabs = { runId: "r", searchTabId: 7, detailTabId: 7 };
    browser.tabs.update = async (_id: number, options: { url?: string }) => {
      navigations.push(options); if (options.url) tab = { ...tab, url: options.url }; return tab;
    };
    browser.scripting.executeScript = async (options: { func: { name: string } }) => {
      scripts.push(options.func.name);
      if (options.func.name === "advanceSearch") return [{ result: { clicked: false } }];
      if (options.func.name === "inspectSearchContinuation") return [{ result: null }];
      return [{ result: { recognized: true, links: [command.previousSignature], pageUrl: tab.url, hasNext: false } }];
    };
    globalThis.fetch = (async (path: string, options: RequestInit) => {
      requests.push(path);
      if (path.endsWith("/result")) { reports.push(JSON.parse(String(options.body))); return response({ ok: true }); }
      if (path.endsWith("/claim") || path.endsWith("diagnostic-claim")) return response({ command: null });
      return response({ run: { id: "r", state: "running" } });
    }) as typeof fetch;
    await action({ browser, clock, reports, requests, scripts, navigations, searchUrl });
  } finally {
    Object.assign(browser.tabs, original.tabs); Object.assign(browser.storage.local, original.local);
    Object.assign(browser.storage.session, original.session); Object.assign(browser.scripting, original.scripting);
    globalThis.fetch = originalFetch; clock.restore();
  }
}

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
  const clock = fakeClock();
  try {
    tab = { ...tab, status: "loading" };
    scriptResult = { recognized: true, links: ["https://www.zhipin.com/job_detail/a.html"] };
    const pending = worker.waitForUrl(7, tab.url, "search", "token", "r");
    queueMicrotask(() => { tab = { ...tab, status: "complete" }; });
    assert.deepEqual(await pending, { ok: true });
  } finally { clock.restore(); }
});

test("waitForUrl reports a completed login redirect before matching the requested URL", async () => {
  tab = { ...tab, url: "https://www.zhipin.com/web/user/?ka=header-login", status: "complete" };
  scriptResult = { login: true, challenge: false, recognized: false, links: [] };
  assert.deepEqual(await worker.waitForUrl(7, "https://www.zhipin.com/web/geek/job?city=101010100", "search", "token", "r"), { blocked: scriptResult });
});

test("waitForUrl distinguishes an opened but unrecognized matching page", async () => {
  const clock = fakeClock();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response({ run: { id: "r", state: "running" } })) as typeof fetch;
  try {
  tab = { ...tab, url: "https://www.zhipin.com/web/geek/jobs?query=frontend&city=101010100", status: "complete" };
  scriptResult = { login: false, challenge: false, recognized: false, links: [] };
  assert.deepEqual(await worker.waitForUrl(7, tab.url, "search", "token", "r"), { unrecognized: true, failure: { code: "dom-unrecognized", tabState: "complete" } });
  } finally { clock.restore(); globalThis.fetch = originalFetch; }
});

test("waitForUrl waits for delayed SPA content after the tab completes", async () => {
  const clock = fakeClock();
  let waits = 0;
  try {
    tab = { ...tab, url: "https://www.zhipin.com/web/geek/jobs?query=AI&city=101020100", status: "complete" };
    scriptResult = { recognized: false, links: [], pageUrl: tab.url, readyState: "complete" };
    clock.onSleep = () => {
      waits++;
      scriptResult = { recognized: true, links: ["https://www.zhipin.com/job_detail/a.html"], pageUrl: tab.url, readyState: "complete" };
    };
    assert.deepEqual(await worker.waitForUrl(7, tab.url, "search", "token", "r"), { ok: true });
    assert.equal(waits, 1);
  } finally { clock.restore(); }
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
  const clock = fakeClock();
  const url = "https://www.zhipin.com/job_detail/a.html";
  const searchUrl = "https://www.zhipin.com/web/geek/jobs?query=AI&city=101020100";
  const base = { url, title: "AI工程师", company: "示例公司", description: "企业 AI 应用开发", detail: true, location: "上海", salaryText: "", industry: "", status: "active" };
  const detail = { ...base, company: "示例公司有限公司", salaryText: "25-35K", industry: "计算机软件" };
  const evidence = { title: base.title, company: base.company, registeredCompany: "示例公司有限公司", descriptionPresent: true, clientLabelSeen: false, clientNames: [], headerLines: ["25-35K"], companySections: [] };
  const reports: Array<Record<string, any>> = [];
  try {
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
    assert.equal(supplemented.jobs[0].status, "active");
    const closed = await run(base, { ...detail, status: "closed" });
    assert.equal(closed.jobs[0].status, "closed");
    assert.equal((await run({ ...base, status: "closed" }, detail)).jobs[0].status, "closed");
    assert.equal((await run(base, { ...detail, status: "unknown" })).jobs[0].status, "unknown");
    assert.equal((await run(base, { ...detail, status: "unexpected" })).jobs[0].status, "unknown");
    assert.equal((await run(base, { ...detail, company: "另一公司", status: "closed" })).jobs[0].status, "closed");
    assert.equal((await run(base, { ...detail, title: "另一职位", status: "closed" })).jobs[0].status, "closed");
    const wrongEvidence = await run(base, detail, {}, "https://www.zhipin.com/job_detail/other.html");
    assert.equal(wrongEvidence.pageEvidence, undefined);
    const conflict = await run({ ...base, salaryText: "20-30K", industry: "保险", location: "" }, detail);
    assert.equal(conflict.outcome, "ok");
    assert.equal(conflict.jobs[0].salaryText, "");
    assert.equal(conflict.jobs[0].industry, "");
    assert.equal(conflict.fieldReading.merge, "conflict");
    for (const [inlineLocation, detailLocation, expected] of [
      ["上海·闵行区", "上海", "上海·闵行区"],
      ["上海", "上海·闵行区·虹桥", "上海·闵行区·虹桥"],
      ["上海·闵行区·虹桥", "上海·闵行区", "上海·闵行区·虹桥"],
      ["上海 · 闵行区", "上海", "上海 · 闵行区"],
      ["上海·闵行区", "杭州", ""],
      ["上海·闵行区", "上海·徐汇区", ""],
      ["上海·杭州市", "上海", ""],
      ["上海·闵行区·虹桥", "上海·闵行区·七宝", ""],
      ["上海·闵行区", "上", ""],
    ]) {
      const locationResult = await run({ ...base, location: inlineLocation }, { ...detail, location: detailLocation });
      assert.equal(locationResult.jobs[0].location, expected, `${inlineLocation} / ${detailLocation}`);
      assert.equal(locationResult.fieldReading.finalLocation, Boolean(expected));
      assert.equal(locationResult.fieldReading.merge, expected ? "merged" : "conflict");
    }
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
  } finally { globalThis.fetch = originalFetch; clock.restore(); scriptResults = null; }
});

test("unchanged inline detail falls back once to the exact standalone URL with the same checks", async () => {
  const originalFetch = globalThis.fetch;
  const clock = fakeClock();
  const url = "https://www.zhipin.com/job_detail/a.html";
  const searchUrl = "https://www.zhipin.com/web/geek/jobs?query=AI&city=101020100";
  const job = { url, title: "AI工程师", company: "示例公司", description: "企业AI应用开发", detail: true, salaryText: "25-35K", industry: "计算机软件" };
  const reports: Array<Record<string, unknown>> = [];
  try {
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
  } finally { globalThis.fetch = originalFetch; clock.restore(); scriptResults = null; }
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

test("search reports read-only continuation evidence even at the final page and never treats absent next as successful advance", async () => {
  const originalFetch = globalThis.fetch;
  const browser = (globalThis as Record<string, any>).chrome;
  const originalScript = browser.scripting.executeScript;
  const reports: Array<Record<string, any>> = [];
  const url = "https://www.zhipin.com/web/geek/jobs?query=Java&city=101020100";
  const evidence = { version: 1, linkCount: 1,
    pagination: { matched: 0, visible: 0, enabled: 0, disabled: 0, ambiguous: false, truncated: false },
    lists: { matched: 1, visible: 1, truncated: false }, scrollContainers: [], truncated: false };
  const calls: Array<{ name: string; args?: unknown[] }> = [];
  let diagnosticFails = false;
  try {
    globalThis.fetch = (async (path: string, options: RequestInit) => {
      if (path.endsWith("/result")) { reports.push(JSON.parse(String(options.body))); return response({ ok: true }); }
      return response({ run: { id: "r", state: "running" } });
    }) as typeof fetch;
    store.jobAssistantAutomationTabs = { runId: "r", searchTabId: 7 };
    tab = { ...tab, url, status: "complete" };
    browser.scripting.executeScript = async (options: { func: { name: string }; args?: unknown[] }) => {
      calls.push({ name: options.func.name, args: options.args });
      if (options.func.name === "inspectSearchContinuation") {
        if (diagnosticFails) throw new Error("private diagnostic failure");
        return [{ result: evidence }];
      }
      if (options.func.name === "advanceSearch") return [{ result: { clicked: false } }];
      return [{ result: { recognized: true, links: [command.previousSignature], pageUrl: url, hasNext: false } }];
    };
    await worker.execute({ ...command, kind: "search", url }, "token");
    assert.equal(reports[0].outcome, "ok");
    assert.equal(reports[0].hasNext, false);
    assert.deepEqual(reports[0].searchDiagnostic, evidence);
    assert.equal(calls.some((call) => call.name === "advanceSearch"), false);
    assert.deepEqual(calls.find((call) => call.name === "inspectSearchContinuation")?.args, [url]);

    await worker.execute({ ...command, url }, "token");
    assert.equal(reports[1].outcome, "error");
    assert.equal(reports[1].reason, "page-repeated");
    assert.deepEqual(reports[1].searchDiagnostic, evidence);
    assert.equal(reports[1].links, undefined);
    assert.equal(calls.filter((call) => call.name === "advanceSearch").length, 1);

    diagnosticFails = true;
    await worker.execute({ ...command, kind: "search", url }, "token");
    assert.equal(reports[2].outcome, "ok");
    assert.equal(reports[2].searchDiagnostic, undefined);
    assert.equal(JSON.stringify(reports).includes("private diagnostic failure"), false);
  } finally { globalThis.fetch = originalFetch; browser.scripting.executeScript = originalScript; }
});

test("first-screen links are reported before scrolling, including a tall list with truncated control diagnostics", async () => {
  await executionFixture(async ({ browser, reports, scripts, searchUrl }) => {
    const links = Array.from({ length: 14 }, (_, i) => `https://www.zhipin.com/job_detail/first-${i}.html`);
    const original = browser.scripting.executeScript;
    browser.scripting.executeScript = async (options: { func: { name: string } }) => {
      scripts.push(options.func.name);
      if (options.func.name === "inspectSearchContinuation") return [{ result: {
        version: 1, linkCount: 14, pagination: { matched: 0, visible: 0, enabled: 0, disabled: 0, ambiguous: false, truncated: true },
        lists: { matched: 1, visible: 1, truncated: false }, truncated: true,
        scrollContainers: [{ kind: "document", depth: 0, clientHeight: 825, scrollHeight: 3103, scrollTop: 0, remaining: 2278, canScroll: true, atEnd: false }],
      } }];
      if (options.func.name === "advanceSearchList") throw new Error("first-screen collection must not scroll");
      return [{ result: { recognized: true, links, pageUrl: searchUrl, hasNext: false } }];
    };
    await worker.execute({ ...command, kind: "search", url: searchUrl }, "token");
    assert.equal(reports.length, 1);
    assert.equal(reports[0].outcome, "ok");
    assert.deepEqual(reports[0].links, links);
    assert.equal(reports[0].hasNext, true);
    assert.equal(reports[0].continuationEnded, undefined);
    assert.ok(!scripts.includes("advanceSearchList"));
    browser.scripting.executeScript = original;
  });
});

test("scroll continuation reports new links and an explicit unchanged end, stopping on limits or changed pages", async () => {
  const originalFetch = globalThis.fetch;
  const browser = (globalThis as Record<string, any>).chrome;
  const originalScript = browser.scripting.executeScript;
  const originalUpdate = browser.tabs.update;
  let activations = 0;
  const reports: Array<Record<string, any>> = [];
  const url = "https://www.zhipin.com/web/geek/jobs?query=Java&city=101020100";
  const oldLink = "https://www.zhipin.com/job_detail/a.html", newLink = "https://www.zhipin.com/job_detail/b.html";
  const evidence = { version: 1, linkCount: 1, pagination: { matched: 0, visible: 0, enabled: 0, disabled: 0, ambiguous: false, truncated: false },
    lists: { matched: 1, visible: 1, truncated: false }, scrollContainers: [{ kind: "document", depth: 0, clientHeight: 825, scrollHeight: 2434, scrollTop: 0, remaining: 1609, canScroll: true, atEnd: false }], truncated: false };
  try {
    browser.tabs.update = async (tabId: number, update: { active?: boolean; url?: string }) => {
      assert.equal(tabId, 7);
      if (update.active !== undefined) {
        assert.deepEqual(update, { active: true });
        activations++;
      }
      return originalUpdate(tabId, update);
    };
    let running = true;
    globalThis.fetch = (async (path: string, options: RequestInit) => {
      if (path.endsWith("/result")) { reports.push(JSON.parse(String(options.body))); return response({ ok: true }); }
      return response({ run: { id: "r", state: running ? "running" : "paused" } });
    }) as typeof fetch;
    for (const scenario of ["changed", "next-changed", "next-control", "end", "limit", "wrong-query", "verification", "paused"]) {
      reports.length = 0;
      activations = 0;
      running = true;
      let clicked = 0, scrolled = 0;
      store.jobAssistantAutomationTabs = { runId: "r", searchTabId: 7 };
      tab = { ...tab, url, status: "complete" };
      browser.scripting.executeScript = async (options: { func: { name: string }; args?: unknown[] }) => {
        if (options.func.name === "inspectSearchContinuation") return [{ result: evidence }];
        if (options.func.name === "advanceSearch") { clicked++; return [{ result: { clicked: scenario === "next-control" } }]; }
        if (options.func.name === "advanceSearchList") {
          scrolled++;
          assert.deepEqual(options.args, [url, oldLink]);
          if (scenario === "paused") running = false;
          const outcome = scenario === "end" ? "end" : scenario === "limit" ? "limit" : scenario === "verification" ? "blocked" : scenario === "next-control" ? "next-control" : "changed";
          return [{ result: { outcome, reason: scenario === "verification" ? "verification-required" : scenario === "limit" ? "time-limit" : undefined,
            pageUrl: scenario === "wrong-query" ? url.replace("query=Java", "query=Python") : url,
            links: outcome === "end" ? [oldLink] : [oldLink, newLink], hasNext: outcome !== "end" } }];
        }
        return [{ result: { recognized: true, links: clicked ? [oldLink, newLink] : [oldLink], pageUrl: url, hasNext: false } }];
      };
      await worker.execute({ ...command, kind: "next", url, previousSignature: oldLink }, "token");
      assert.equal(scrolled, 1, scenario);
      assert.equal(activations, 1, scenario);
      assert.equal(clicked, scenario === "next-control" ? 1 : 0, scenario);
      if (scenario === "paused") { assert.equal(reports.length, 0); continue; }
      assert.equal(reports.length, 1);
      if (["changed", "next-changed"].includes(scenario)) {
        assert.equal(reports[0].outcome, "ok");
        assert.deepEqual(reports[0].links, [oldLink, newLink]);
        assert.equal(reports[0].hasNext, true);
        assert.equal(reports[0].continuationEnded, undefined);
      } else if (scenario === "next-control") {
        assert.equal(reports[0].outcome, "ok");
        assert.deepEqual(reports[0].links, [oldLink, newLink]);
      } else if (scenario === "end") {
        assert.equal(reports[0].outcome, "ok");
        assert.deepEqual(reports[0].links, [oldLink]);
        assert.equal(reports[0].hasNext, false);
        assert.equal(reports[0].continuationEnded, true);
      } else {
        assert.equal(reports[0].links, undefined);
        if (scenario === "verification") assert.equal(reports[0].reason, "verification-required");
        else assert.equal(reports[0].diagnostic.code, scenario === "limit" ? "continuation-time-limit" : "url-mismatch");
      }
    }
  } finally { globalThis.fetch = originalFetch; browser.scripting.executeScript = originalScript; browser.tabs.update = originalUpdate; }
});

test("pagination accepts new links only from the same search, retaining login and verification stops", async () => {
  const originalFetch = globalThis.fetch;
  const clock = fakeClock();
  const browser = (globalThis as Record<string, any>).chrome;
  const originalScript = browser.scripting.executeScript;
  const reports: Array<Record<string, any>> = [];
  const url = "https://www.zhipin.com/web/geek/jobs?query=Java&city=101020100";
  const otherQuery = url.replace("query=Java", "query=Python");
  const otherCity = url.replace("city=101020100", "city=101010100");
  const oldLink = "https://www.zhipin.com/job_detail/a.html";
  const newLink = "https://www.zhipin.com/job_detail/b.html";
  try {
      globalThis.fetch = (async (path: string, options: RequestInit) => {
      if (path.endsWith("/result")) { reports.push(JSON.parse(String(options.body))); return response({ ok: true }); }
      return response({ run: { id: "r", state: "running" } });
    }) as typeof fetch;
    for (const scenario of ["same-search", "query", "city", "document-query", "login", "challenge"]) {
      reports.length = 0;
      let advanced = false;
      store.jobAssistantAutomationTabs = { runId: "r", searchTabId: 7 };
      tab = { ...tab, url, status: "complete" };
      browser.scripting.executeScript = async (options: { func: { name: string } }) => {
        if (options.func.name === "inspectSearchContinuation") return [{ result: { version: 1, linkCount: advanced ? 2 : 1,
          pagination: { matched: 0, visible: 0, enabled: 0, disabled: 0, ambiguous: false, truncated: false },
          lists: { matched: 1, visible: 1, truncated: false }, scrollContainers: [], truncated: false } }];
        if (options.func.name === "advanceSearch") {
          advanced = true;
          if (scenario === "query") tab = { ...tab, url: otherQuery };
          if (scenario === "city") tab = { ...tab, url: otherCity };
          if (scenario === "login") tab = { ...tab, url: "https://www.zhipin.com/web/user/" };
          return [{ result: { clicked: true } }];
        }
        return [{ result: { recognized: true, links: [advanced ? newLink : oldLink], pageUrl: advanced && scenario === "document-query" ? otherQuery : tab.url,
          login: advanced && scenario === "login", challenge: advanced && scenario === "challenge" } }];
      };
      await worker.execute({ ...command, url, previousSignature: oldLink }, "token");
      assert.equal(advanced, true);
      assert.equal(reports.length, 1);
      if (scenario === "same-search") {
        assert.equal(reports[0].outcome, "ok");
        assert.deepEqual(reports[0].links, [newLink]);
        assert.equal(reports[0].searchDiagnostic.linkCount, 2);
      } else {
        assert.equal(reports[0].links, undefined);
        if (scenario === "login" || scenario === "challenge") {
          assert.equal(reports[0].outcome, "blocked");
          assert.equal(reports[0].reason, scenario === "login" ? "login-required" : "verification-required");
          assert.equal(reports[0].searchDiagnostic, undefined);
        } else {
          assert.equal(reports[0].outcome, "error");
          assert.equal(reports[0].diagnostic.code, "url-mismatch");
          assert.equal(reports[0].searchDiagnostic, undefined);
        }
      }
    }
  } finally { globalThis.fetch = originalFetch; clock.restore(); browser.scripting.executeScript = originalScript; }
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
  const clock = fakeClock();
  const originalFetch = globalThis.fetch;
  const reports: Array<Record<string, unknown>> = [];
  try {
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
  } finally { clock.restore(); globalThis.fetch = originalFetch; scriptError = null; }
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

test("collection call deadlines prevent invocation after budget expiry and discard late completion", async () => {
  const clock = fakeClock(false);
  try {
    let calls = 0;
    await assert.rejects(worker.boundedCollectionCall(() => { calls++; }, { deadline: clock.now() }), { code: "command-timeout" });
    assert.equal(calls, 0);
    let release: (value: unknown) => void = () => {};
    const pending = worker.boundedCollectionCall(() => { calls++; return new Promise((resolve) => { release = resolve; }); }, { deadline: clock.now() + 60_000 });
    const rejected = assert.rejects(pending, { code: "browser-timeout" });
    clock.advance(3000);
    await rejected;
    release("late success"); await settle();
    assert.equal(calls, 1);
  } finally { clock.restore(); }
});

test("an unresolved detail injection reports one timeout and its late result cannot navigate or import", async () => {
  await executionFixture(async ({ browser, clock, reports, scripts, navigations, searchUrl }) => {
    const originalScript = browser.scripting.executeScript;
    let release: (value: unknown) => void = () => {};
    browser.scripting.executeScript = (options: { func: { name: string } }) => {
      if (options.func.name === "clickAndReadSplitDetail") {
        scripts.push(options.func.name);
        return new Promise((resolve) => { release = resolve; });
      }
      return originalScript(options);
    };
    const pending = worker.execute({ ...command, kind: "detail", url: command.previousSignature, searchUrl }, "token");
    await settle();
    assert.equal(scripts.filter((name) => name === "clickAndReadSplitDetail").length, 1);
    clock.advance(10_000); await pending;
    assert.equal(reports.length, 1);
    assert.equal(reports[0].diagnostic.code, "browser-timeout");
    assert.equal(reports[0].diagnostic.stage, "reading-page");
    release([{ result: { ok: true, job: { url: command.previousSignature, title: "Java", company: "甲", description: "开发职责", detail: true },
      detailContext: { jobUrl: command.previousSignature, title: "Java", company: "甲" } } }]);
    await settle();
    assert.equal(reports.length, 1);
    assert.equal(navigations.length, 0);
    assert.equal(scripts.includes("extractJobs"), false);
    assert.equal(reports[0].jobs, undefined);
  });
});

test("an unresolved tab query exits instead of opening a replacement tab", async () => {
  await executionFixture(async ({ browser, clock, reports, navigations, searchUrl }) => {
    let creates = 0;
    browser.tabs.get = () => new Promise(() => {});
    browser.tabs.create = async () => { creates++; return tab; };
    const pending = worker.execute({ ...command, kind: "search", url: searchUrl }, "token");
    await settle(); clock.advance(3000); await pending;
    assert.equal(creates, 0);
    assert.equal(navigations.length, 0);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].diagnostic.code, "browser-timeout");
  });
});

test("a hung diagnostic storage write cannot prevent collection completion", async () => {
  await executionFixture(async ({ browser, clock, reports, searchUrl }) => {
    browser.storage.local.set = () => new Promise(() => {});
    let done = false;
    const pending = worker.execute({ ...command, kind: "search", url: searchUrl }, "token").finally(() => { done = true; });
    for (let step = 0; step < 15 && !done; step++) { await settle(); clock.advance(1000); }
    await pending;
    assert.equal(done, true);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].outcome, "ok");
  });
});

test("slow resolved browser reads consume actual page-wait time instead of a fixed iteration allowance", async () => {
  await executionFixture(async ({ browser, clock, searchUrl }) => {
    let reads = 0;
    const began = clock.now();
    browser.tabs.get = async () => { reads++; clock.advance(1000); return tab; };
    browser.scripting.executeScript = async () => {
      clock.advance(1000);
      return [{ result: { recognized: false, links: [], pageUrl: searchUrl } }];
    };
    const result = await worker.waitForUrl(7, searchUrl, "search", "token", "r");
    assert.equal(result.ok, undefined);
    assert.ok(clock.now() - began <= 19_000);
    assert.ok(reads <= 7, `only ${reads} iterations fit the actual 18-second page budget`);
  });
});

test("slow pagination reads stop at their real deadline without a second click or false success", async () => {
  await executionFixture(async ({ browser, clock, reports, searchUrl }) => {
    let advanced = false, clicks = 0, afterClick = 0;
    browser.scripting.executeScript = async (options: { func: { name: string } }) => {
      if (options.func.name === "advanceSearch") { advanced = true; clicks++; afterClick = clock.now(); return [{ result: { clicked: true } }]; }
      if (options.func.name === "inspectSearchContinuation") return [{ result: null }];
      if (advanced) clock.advance(2000);
      return [{ result: { recognized: true, links: [command.previousSignature], pageUrl: searchUrl, hasNext: true } }];
    };
    await worker.execute({ ...command, url: searchUrl }, "token");
    assert.equal(clicks, 1);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].outcome, "error");
    assert.ok(clock.now() - afterClick <= 20_000);
  });
});

test("a command shares one 60-second budget across restored search and standalone detail fallback", async () => {
  await executionFixture(async ({ browser, clock, reports, navigations, searchUrl }) => {
    store.jobAssistantAutomationTabs = {};
    const originalFetch = globalThis.fetch;
    let statusReads = 0;
    const began = clock.now();
    globalThis.fetch = (async (path: string, options: RequestInit) => {
      if (path.endsWith("/automation-status")) { statusReads++; clock.advance(Math.min(9000, Math.max(0, began + 60_000 - clock.now()))); }
      return originalFetch(path, options);
    }) as typeof fetch;
    const job = { url: command.previousSignature, title: "Java", company: "甲", description: "完整开发职责", detail: true };
    browser.scripting.executeScript = async (options: { func: { name: string } }) => {
      if (options.func.name === "clickAndReadSplitDetail") return [{ result: { ok: true, job,
        detailContext: { jobUrl: job.url, title: job.title, company: job.company } } }];
      if (options.func.name === "extractJobs") return [{ result: { pageUrl: tab.url, jobs: [job] } }];
      return [{ result: { recognized: true, links: [job.url], pageUrl: tab.url } }];
    };
    await worker.execute({ ...command, kind: "detail", url: job.url, searchUrl }, "token");
    assert.ok(statusReads >= 7);
    assert.equal(clock.now() - began, 60_000);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].outcome, "error");
    assert.equal(reports[0].diagnostic.code, "command-timeout");
    assert.equal(navigations.length, 2);
  });
});

test("a pause between tab creation and navigation stops all following browser actions", async () => {
  await executionFixture(async ({ browser, reports, navigations, searchUrl }) => {
    store.jobAssistantAutomationTabs = {};
    let creates = 0, statusReads = 0;
    browser.tabs.create = async () => { creates++; return tab; };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (path: string, options: RequestInit) => {
      if (path.endsWith("/automation-status")) return response({ run: { id: "r", state: ++statusReads < 3 ? "running" : "paused" } });
      return originalFetch(path, options);
    }) as typeof fetch;
    await worker.execute({ ...command, kind: "search", url: searchUrl }, "token");
    assert.equal(creates, 1);
    assert.equal(navigations.length, 0);
    assert.equal(reports.length, 0);
  });
});

test("wake remains single-flight while blocked and releases after a token-read timeout without accepting its late value", async () => {
  await executionFixture(async ({ browser, clock, requests }) => {
    const originalGet = browser.storage.local.get;
    let release: (value: unknown) => void = () => {};
    browser.storage.local.get = () => new Promise((resolve) => { release = resolve; });
    const first = worker.wake(); await settle();
    await worker.wake();
    assert.equal(requests.length, 0);
    clock.advance(3000); await first;
    release({ jobAssistantToken: "late-token" }); await settle();
    assert.equal(requests.length, 0);
    browser.storage.local.get = originalGet;
    await worker.wake();
    assert.ok(requests.some((path) => path.endsWith("diagnostic-claim")));
    assert.ok(requests.some((path) => path.endsWith("/extension/v1/claim")));
  });
});

test("alarms during a stalled collection do not claim concurrently and its timeout releases the next wake", async () => {
  await executionFixture(async ({ browser, clock, reports, scripts, searchUrl }) => {
    const originalFetch = globalThis.fetch, originalScript = browser.scripting.executeScript;
    let claims = 0, release: (value: unknown) => void = () => {};
    globalThis.fetch = (async (path: string, options: RequestInit) => {
      if (path.endsWith("/extension/v1/claim")) return response({ command: ++claims === 1 ? { ...command, kind: "detail", url: command.previousSignature, searchUrl } : null });
      return originalFetch(path, options);
    }) as typeof fetch;
    browser.scripting.executeScript = (options: { func: { name: string } }) => {
      if (options.func.name === "clickAndReadSplitDetail") {
        scripts.push(options.func.name);
        return new Promise((resolve) => { release = resolve; });
      }
      return originalScript(options);
    };
    const first = worker.wake(); await settle(); await settle();
    assert.equal(scripts.filter((name) => name === "clickAndReadSplitDetail").length, 1);
    await worker.wake();
    assert.equal(claims, 1);
    clock.advance(10_000); await first;
    assert.equal(reports.length, 1);
    assert.equal(reports[0].diagnostic.code, "browser-timeout");
    release([{ result: { ok: false } }]); await settle();
    assert.equal(reports.length, 1);
    const before = claims;
    await worker.wake();
    assert.equal(claims, before + 1);
  });
});

test("a task paused during detail extraction cannot submit a successful import afterward", async () => {
  await executionFixture(async ({ browser, reports }) => {
    const originalFetch = globalThis.fetch;
    let extracted = false;
    globalThis.fetch = (async (path: string, options: RequestInit) => {
      if (path.endsWith("/automation-status")) return response({ run: { id: "r", state: extracted ? "paused" : "running" } });
      return originalFetch(path, options);
    }) as typeof fetch;
    browser.scripting.executeScript = async (options: { func: { name: string } }) => {
      if (options.func.name === "extractJobs") {
        extracted = true;
        return [{ result: { pageUrl: tab.url, jobs: [{ url: command.previousSignature, title: "Java", company: "甲", description: "完整职责", detail: true }] } }];
      }
      return [{ result: { recognized: true, pageUrl: tab.url } }];
    };
    await worker.execute({ ...command, kind: "detail", url: command.previousSignature }, "token");
    assert.equal(extracted, true);
    assert.equal(reports.length, 0);
  });
});

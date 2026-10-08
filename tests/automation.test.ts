import test from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { Store } from "../packages/storage/src/index.ts";
import { createExtensionAccess } from "../apps/api/src/extension.ts";
import { createAutomation } from "../apps/api/src/automation.ts";
import type { Assessment } from "../packages/contracts/src/index.ts";

const origin = `chrome-extension://${"a".repeat(32)}`;
const url = (id: string) => `https://www.zhipin.com/job_detail/${id}.html`;
const job = (id: string) => ({ url: url(id), title: "工程师", company: "公司", description: "完整岗位要求", detail: true });
const config = { keywords: ["前端", "后端"], city: "上海", maxJobs: 10, maxPages: 2, autoAssess: false, intervalSeconds: 3 };

async function fixture(scoreJob: (id: string, signal: AbortSignal) => Promise<Assessment> = async () => ({ decision: "eligible" }) as Assessment) {
  const store = new Store(":memory:");
  let time = Date.UTC(2026, 0, 1), fingerprint = "private-resume-provider-key";
  const access = createExtensionAccess(store, () => time);
  let app: FastifyInstance;
  let automation: ReturnType<typeof createAutomation>;
  const mount = () => {
    app = Fastify();
    app.setErrorHandler((error, _req, reply) => {
      reply.code(400).send({ error: error instanceof z.ZodError ? "回执格式不正确" : error instanceof Error ? error.message : "请求失败" });
    });
    app.addHook("onRequest", async (req, reply) => { if (req.url.startsWith("/extension/")) return access.guard(req, reply); });
    access.register(app);
    automation = createAutomation({ store, extensionStatus: access.status, importJobs: access.importJobs,
      configurationKey: () => fingerprint, ensureReady() {}, scoreJob, now: () => time });
    automation.register(app);
  };
  mount();
  const code = (await app!.inject({ method: "POST", url: "/api/extension/pair-code" })).json().code;
  const token = (await app!.inject({ method: "POST", url: "/extension/v1/pair", headers: { origin }, payload: { code } })).json().token;
  const request = (path: string, payload?: any, headers = {}) => app!.inject({ method: path === "/api/automation" ? "GET" : "POST", url: path,
    headers: { origin, authorization: `Bearer ${token}`, "x-extension-version": "0.2.4", ...headers }, payload });
  await request("/extension/v1/status");
  const state = async () => (await request("/api/automation")).json().run;
  const claim = async () => (await request("/extension/v1/claim", {})).json().command;
  const result = (command: any, extra: any = {}) => request("/extension/v1/result", {
    commandId: command.id, runId: command.runId, leaseToken: command.leaseToken, outcome: "ok", url: command.url, ...extra });
  return { store, request, state, claim, result,
    start: (extra = {}) => request("/api/automation/start", { ...config, ...extra }),
    control: (action: string) => request("/api/automation/control", { action }),
    advance: (ms: number) => { time += ms; }, drift: () => { fingerprint = "changed-private-key"; },
    pump: () => automation!.pump(), restart: async () => { await app!.close(); mount(); },
    close: async () => { await app!.close(); store.close(); } };
}

test("自动采集依次搜索、读取详情、翻页与第二关键词，并跨页面去重", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.start()).statusCode, 200);
    const search = await f.claim(); assert.equal(search.kind, "search");
    assert.equal(new URL(search.url).pathname, "/web/geek/jobs");
    assert.equal(new URL(search.url).searchParams.get("query"), "前端");
    assert.equal(await f.claim(), null);
    assert.equal((await f.result(search, { links: [url("a"), url("a") + "?tracking=1"], hasNext: true })).statusCode, 200);
    const detail = await f.claim(); assert.equal(detail.kind, "detail");
    assert.equal((await f.result(detail, { jobs: [job("a")] })).statusCode, 200);
    assert.equal((await f.result(detail, { jobs: [job("a")] })).statusCode, 200);
    const next = await f.claim(); assert.equal(next.kind, "next"); assert.equal(next.previousSignature, url("a"));
    await f.result(next, { links: [url("a"), url("b")], hasNext: true });
    await f.result(await f.claim(), { jobs: [job("b")] });
    const second = await f.claim(); assert.equal(new URL(second.url).searchParams.get("query"), "后端");
    await f.result(second, { links: [url("a"), url("c")], hasNext: false });
    await f.result(await f.claim(), { jobs: [job("c")] });
    assert.equal(await f.claim(), null);
    const run = await f.state(); assert.equal(run.state, "completed"); assert.equal(run.discovered, 3); assert.equal(run.visited, 3); assert.equal(run.imported, 3);
    assert.equal(f.store.jobs().length, 3);
  } finally { await f.close(); }
});

test("字段诊断仅接受固定状态、绑定岗位回执，持久化且重复回执不重复记录", async () => {
  const f = await fixture();
  const reading = { route: "supplement", merge: "title-mismatch", salary: "encoded", location: "missing", industry: "company-mismatch", finalSalary: false, finalLocation: false, finalIndustry: false };
  try {
    await f.start({ maxJobs: 1 });
    await f.result(await f.claim(), { links: [url("a")], hasNext: false });
    const detail = await f.claim();
    for (const fieldReading of [{ ...reading, raw: "private-page" }, { ...reading, salary: "private-data" }, { ...reading, route: "unknown" }]) {
      assert.equal((await f.result(detail, { jobs: [job("a")], fieldReading })).statusCode, 400);
    }
    assert.equal((await f.result(detail, { jobs: [job("b")], fieldReading: reading })).statusCode, 400);
    assert.equal((await f.state()).fieldReadings.length, 0);
    assert.equal((await f.result(detail, { jobs: [job("a")], fieldReading: reading })).statusCode, 200);
    assert.equal((await f.result(detail, { jobs: [job("a")], fieldReading: reading })).statusCode, 200);
    await f.restart();
    const values = (await f.state()).fieldReadings;
    assert.equal(values.length, 1);
    assert.equal(values[0].url, url("a"));
    assert.deepEqual(values[0].reading, reading);
    assert.ok(values[0].message.includes("两处职位名称不一致"));
    assert.ok(values[0].message.includes("不可解析字符"));
    assert.ok(!JSON.stringify(values).includes("private"));
  } finally { await f.close(); }
});

test("岗位上限与自动评分统计覆盖可投、复核、跳过和不可用，错误不泄露配置", async () => {
  const decisions = ["eligible", "review", "skip"];
  const f = await fixture(async () => { const decision = decisions.shift(); if (!decision) throw new Error("private-provider-secret"); return { decision } as Assessment; });
  try {
    await f.start({ maxJobs: 4, autoAssess: true });
    await f.result(await f.claim(), { links: ["a", "b", "c", "d", "e"].map(url), hasNext: true });
    for (const id of ["a", "b", "c", "d"]) await f.result(await f.claim(), { jobs: [job(id)] });
    assert.equal(await f.claim(), null); assert.equal((await f.state()).phase, "scoring");
    for (let i = 0; i < 5; i++) await f.pump();
    const run = await f.state(); assert.equal(run.state, "completed"); assert.equal(run.imported, 4); assert.equal(run.scored, 3);
    assert.equal(run.eligible, 1); assert.equal(run.review, 1); assert.equal(run.skipped, 1); assert.equal(run.failed, 1);
    const exposed = JSON.stringify(run); for (const secret of ["private-provider-secret", "private-resume-provider-key", "leaseToken", "pendingUrls", "jobIds"]) assert.ok(!exposed.includes(secret));
    assert.deepEqual(Object.keys((await f.request("/extension/v1/automation-status")).json().run).sort(), ["id", "phase", "state"]);
  } finally { await f.close(); }
});

test("暂停、继续、超时与取消使旧租约失效，保留已导入进度", async () => {
  const f = await fixture();
  try {
    await f.start(); const old = await f.claim();
    await f.control("pause"); assert.equal(await f.claim(), null);
    assert.ok((await f.result(old, { links: [], hasNext: false })).statusCode >= 400);
    await f.control("resume"); const search = await f.claim(); assert.notEqual(search.leaseToken, old.leaseToken);
    await f.result(search, { links: [url("a"), url("b")], hasNext: false });
    await f.result(await f.claim(), { jobs: [job("a")] });
    const expired = await f.claim(); f.advance(180001); assert.equal((await f.state()).state, "blocked");
    assert.ok((await f.result(expired, { jobs: [job("b")] })).statusCode >= 400);
    await f.control("resume"); const retry = await f.claim(); assert.equal(retry.url, url("b"));
    await f.control("cancel"); assert.ok((await f.result(retry, { jobs: [job("b")] })).statusCode >= 400);
    assert.equal((await f.state()).imported, 1); assert.equal(f.store.jobs().length, 1);
  } finally { await f.close(); }
});

test("拒绝错误来源、关键词与岗位身份，失败回执不污染岗位库", async () => {
  const f = await fixture();
  try {
    await f.start();
    assert.equal((await f.request("/extension/v1/claim", {}, { origin: `chrome-extension://${"b".repeat(32)}` })).statusCode, 401);
    const search = await f.claim();
    for (const actual of ["https://evil.example/web/geek/job", search.url.replace("101020100", "100010000")]) assert.ok((await f.result(search, { url: actual, links: [], hasNext: false })).statusCode >= 400);
    await f.result(search, { links: [url("a")], hasNext: false }); const detail = await f.claim();
    for (const extra of [{ url: url("b"), jobs: [job("b")] }, { jobs: [job("b")] }, { jobs: [{ ...job("a"), detail: false }] }]) assert.ok((await f.result(detail, extra)).statusCode >= 400);
    assert.equal(f.store.jobs().length, 0); assert.equal((await f.state()).imported, 0);
    assert.equal((await f.result(detail, { jobs: [job("a")] })).statusCode, 200);
  } finally { await f.close(); }
});

test("配置变化阻止继续；重启保留命令与采集队列", async () => {
  const f = await fixture();
  try {
    await f.start(); const search = await f.claim(); await f.restart(); assert.equal(await f.claim(), null);
    await f.result(search, { links: [url("a"), url("b")], hasNext: false });
    await f.result(await f.claim(), { jobs: [job("a")] }); await f.restart();
    assert.equal((await f.claim()).url, url("b")); assert.equal((await f.state()).imported, 1);
    f.drift(); assert.equal((await f.state()).state, "blocked");
    assert.ok((await f.control("resume")).statusCode >= 400); await f.control("cancel");
    assert.equal((await f.start()).statusCode, 200);
  } finally { await f.close(); }
});

test("重复页阻止循环，人工验证暂停并可继续", async () => {
  const f = await fixture();
  try {
    await f.start(); await f.result(await f.claim(), { links: [url("a")], hasNext: true });
    await f.result(await f.claim(), { jobs: [job("a")] });
    await f.result(await f.claim(), { links: [url("a")], hasNext: true });
    assert.equal((await f.state()).state, "blocked"); await f.control("resume");
    await f.result(await f.claim(), { outcome: "blocked", reason: "verification-required" });
    assert.match((await f.state()).message, /人工验证/); assert.equal(await f.claim(), null);
    await f.control("resume"); assert.equal((await f.claim()).kind, "search");
  } finally { await f.close(); }
});

test("失败回执只展示固定诊断中文，拒绝任意诊断文本与原始字段", async () => {
  const f = await fixture();
  try {
    await f.start();
    const search = await f.claim();
    const diagnostic = { stage: "waiting-page", code: "document-loading", tabState: "loading" };
    for (const invalid of [
      { ...diagnostic, stage: "private-stage" },
      { ...diagnostic, code: "private-error" },
      { ...diagnostic, tabState: "private-tab" },
      { ...diagnostic, raw: "private-url-and-dom" },
    ]) {
      assert.equal((await f.result(search, { outcome: "error", reason: "navigation-failed", diagnostic: invalid })).statusCode, 400);
    }
    assert.equal((await f.state()).state, "running");
    assert.equal((await f.result(search, { outcome: "error", reason: "navigation-failed", diagnostic })).statusCode, 200);
    const run = await f.state();
    assert.equal(run.state, "blocked");
    assert.equal(run.message, "岗位页面加载失败，请检查浏览器后继续。 诊断：等待页面加载；页面仍在加载；标签页：加载中。");
    assert.ok(!JSON.stringify(run).includes("private-"));

    await f.control("resume");
    const retry = await f.claim();
    assert.equal((await f.result(retry, { outcome: "blocked", reason: "verification-required" })).statusCode, 200);
    assert.equal((await f.state()).message, "BOSS 需要人工验证，请在自动任务标签页完成后继续。");
  } finally { await f.close(); }
});

test("详情失败细分代码均显示固定中文", async () => {
  const f = await fixture();
  const cases = [
    ["card-missing", "卡片未找到"],
    ["card-incomplete", "卡片标题或公司不完整"],
    ["panel-missing", "详情面板未找到"],
    ["panel-incomplete", "详情标题或正文未识别"],
    ["identity-mismatch", "详情与目标岗位身份不一致"],
    ["detail-unchanged", "点击后详情未更新"],
  ] as const;
  try {
    await f.start();
    await f.result(await f.claim(), { links: [url("a")], hasNext: false });
    for (const [code, label] of cases) {
      const detail = await f.claim();
      assert.equal(detail.kind, "detail");
      assert.equal((await f.result(detail, {
        outcome: "blocked", reason: "page-unrecognized",
        diagnostic: { stage: "reading-page", code },
      })).statusCode, 200);
      assert.equal((await f.state()).message, `没有识别到完整岗位或列表，请检查任务标签页。 诊断：读取页面；${label}。`);
      await f.control("resume");
    }
  } finally { await f.close(); }
});

test("单个详情缺少公司时记录失败继续，回执幂等且连续缺失暂停", async () => {
  const f = await fixture();
  try {
    await f.start();
    await f.result(await f.claim(), { links: [url("a"), url("b"), url("c"), url("d")], hasNext: false });
    const first = await f.claim();
    const failure = { outcome: "error", reason: "page-unrecognized", diagnostic: { stage: "reading-page", code: "card-incomplete" } };
    assert.equal((await f.result(first, { ...failure, url: "https://evil.example/job_detail/a.html" })).statusCode, 400);
    await f.result(first, failure);
    await f.result(first, failure);
    assert.equal((await f.state()).unreadableJobs.length, 1);
    assert.equal((await f.state()).visited, 1);
    assert.equal((await f.state()).imported, 0);
    await f.result(await f.claim(), failure);
    assert.equal((await f.state()).state, "running");
    const third = await f.claim();
    await f.result(third, failure);
    assert.equal((await f.state()).state, "blocked");
    assert.equal((await f.state()).unreadableJobs.length, 2);
    await f.control("resume");
    const retried = await f.claim();
    assert.equal(retried.url, url("c"));
    await f.result(retried, { jobs: [job("c")] });
    await f.result(await f.claim(), failure);
    assert.equal((await f.state()).state, "running");
    assert.equal((await f.state()).imported, 1);
    assert.equal(f.store.jobs().length, 1);
  } finally { await f.close(); }
});

test("评分暂停会中止在途请求，迟到结果不计入统计，继续后重新处理", async () => {
  let finish: (value: Assessment) => void = () => {};
  let signal: AbortSignal | undefined;
  let calls = 0;
  const f = await fixture(async (_id, currentSignal) => {
    calls++; signal = currentSignal;
    if (calls === 1) return new Promise(resolve => { finish = resolve; });
    return { decision: "review" } as Assessment;
  });
  try {
    await f.start({ maxJobs: 1, autoAssess: true });
    await f.result(await f.claim(), { links: [url("a")], hasNext: false });
    await f.result(await f.claim(), { jobs: [job("a")] });
    const pending = f.pump(); assert.equal(calls, 1);
    await f.control("pause"); assert.equal(signal?.aborted, true);
    finish({ decision: "eligible" } as Assessment); await pending;
    assert.equal((await f.state()).scored, 0);
    await f.control("resume"); await f.pump(); await f.pump();
    const run = await f.state(); assert.equal(run.state, "completed"); assert.equal(run.review, 1); assert.equal(run.eligible, 0);
    assert.equal(calls, 2);
  } finally { await f.close(); }
});

test("旧版扩展可查询状态，但不能启动或继续自动任务", async () => {
  const f = await fixture();
  try {
    const old = { "x-extension-version": "0.2.0" };
    assert.equal((await f.request("/extension/v1/status", undefined, old)).statusCode, 200);
    assert.ok((await f.start()).statusCode >= 400);
    assert.equal((await f.request("/extension/v1/status")).statusCode, 200);
    assert.equal((await f.start()).statusCode, 200);
    await f.control("pause");
    assert.equal((await f.request("/extension/v1/status", undefined, old)).statusCode, 200);
    assert.ok((await f.control("resume")).statusCode >= 400);
  } finally { await f.close(); }
});

test("同页详情只接受当前搜索和目标卡片身份，保留独立岗位链接", async () => {
  const f = await fixture();
  try {
    await f.start({ maxJobs: 1 });
    const search = await f.claim();
    await f.result(search, { links: [url("inline")], hasNext: false });
    const detail = await f.claim();
    assert.equal(detail.searchUrl, search.url);
    const context = { jobUrl: url("inline"), title: job("inline").title, company: job("inline").company };
    const payload = { url: search.url, jobs: [job("inline")], detailContext: context };
    for (const altered of [
      { ...payload, detailContext: undefined },
      { ...payload, url: search.url.replace("101020100", "100010000") },
      { ...payload, url: "https://www.zhipin.com/web/chat" },
      { ...payload, detailContext: { ...context, jobUrl: url("other") } },
      { ...payload, detailContext: { ...context, company: "另一家公司" } },
      { ...payload, detailContext: { ...context, title: "不同岗位" } },
    ]) assert.ok((await f.result(detail, altered)).statusCode >= 400);
    assert.equal(f.store.jobs().length, 0);
    assert.equal((await f.result(detail, payload)).statusCode, 200);
    assert.equal((await f.state()).imported, 1);
    assert.equal(f.store.jobs()[0]!.url, url("inline"));
  } finally { await f.close(); }
});

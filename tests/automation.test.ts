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

const searchDiagnostic = {
  version: 1, linkCount: 15,
  pagination: { matched: 1, visible: 1, enabled: 0, disabled: 1, ambiguous: false, truncated: false },
  lists: { matched: 1, visible: 1, truncated: false },
  scrollContainers: [{ kind: "list", depth: 0, clientHeight: 800, scrollHeight: 2400, scrollTop: 0, remaining: 1600, canScroll: true, atEnd: false }],
  truncated: false,
};
test("首屏没有翻页入口时保留有界列表诊断，重复和重启不丢失且不改变岗位事实", async () => {
  const f = await fixture();
  try {
    await f.start();
    const search = await f.claim();
    const payload = { links: [url("diagnostic-job")], hasNext: false, searchDiagnostic };
    assert.equal((await f.result(search, payload)).statusCode, 200);
    assert.equal((await f.result(search, payload)).statusCode, 200);
    await f.restart();
    const run = await f.state();
    assert.equal(run.searchReadings.length, 1);
    assert.equal(run.searchReadings[0].page, 1);
    assert.deepEqual(run.searchReadings[0].diagnostic, searchDiagnostic);
    assert.equal(run.discovered, 1);
    assert.equal(f.store.applications().length, 0);
    const detail = await f.claim();
    assert.equal((await f.result(detail, { jobs: [job("diagnostic-job")], searchDiagnostic })).statusCode, 400);
    assert.equal((await f.result(detail, { jobs: [job("diagnostic-job")] })).statusCode, 200);
    assert.equal(JSON.stringify(f.store.jobs()).includes("scrollContainers"), false);
  } finally { await f.close(); }
});
test("列表诊断拒绝越界、任意内容、错误来源和验证页，不消耗有效命令", async () => {
  const f = await fixture();
  try {
    await f.start();
    const search = await f.claim();
    for (const invalid of [
      { ...searchDiagnostic, html: "private" },
      { ...searchDiagnostic, linkCount: 101 },
      { ...searchDiagnostic, pagination: { ...searchDiagnostic.pagination, label: "private" } },
      { ...searchDiagnostic, scrollContainers: Array(7).fill(searchDiagnostic.scrollContainers[0]) },
      { ...searchDiagnostic, scrollContainers: [{ ...searchDiagnostic.scrollContainers[0], scrollTop: -1 }] },
      { ...searchDiagnostic, scrollContainers: [{ ...searchDiagnostic.scrollContainers[0], scrollHeight: 10000001 }] },
      { ...searchDiagnostic, scrollContainers: [{ ...searchDiagnostic.scrollContainers[0], kind: "private" }] },
    ]) assert.equal((await f.result(search, { links: [], hasNext: false, searchDiagnostic: invalid })).statusCode, 400);
    for (const wrongUrl of [search.url.replace("city=101020100", "city=101010100"), "https://evil.example/web/geek/jobs"]) {
      assert.equal((await f.result(search, { links: [], hasNext: false, searchDiagnostic, url: wrongUrl })).statusCode, 400);
    }
    assert.equal((await f.result(search, { outcome: "blocked", reason: "verification-required", searchDiagnostic })).statusCode, 400);
    assert.equal((await f.state()).searchReadings.length, 0);
    const accepted = await f.result(search, { outcome: "error", reason: "page-unrecognized", diagnostic: { stage: "reading-page", code: "dom-unrecognized" }, searchDiagnostic });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal((await f.state()).searchReadings.length, 1);
    assert.equal(f.store.jobs().length, 0);
    assert.equal(f.store.applications().length, 0);
  } finally { await f.close(); }
});

test("滚动列表超过30个链接仍完整排队，超过300个拒绝", async () => {
  const f = await fixture();
  try {
    await f.start({ maxJobs: 300 });
    const search = await f.claim();
    const links = Array.from({ length: 300 }, (_, i) => url(`scroll-${i}`));
    assert.equal((await f.result(search, { links: [...links, url("overflow")], hasNext: true })).statusCode, 400);
    assert.equal((await f.result(search, { links, hasNext: true })).statusCode, 200);
    assert.equal((await f.state()).discovered, 300);
    assert.equal(f.store.applications().length, 0);
  } finally { await f.close(); }
});

test("滚动到底无新增可以结束续载，结束标记不得隐藏新列表或伪装首屏", async () => {
  const f = await fixture();
  try {
    await f.start({ keywords: ["Java"], maxJobs: 10, maxPages: 2 });
    const search = await f.claim();
    assert.equal((await f.result(search, { links: [url("a")], hasNext: false, continuationEnded: true })).statusCode, 400);
    await f.result(search, { links: [url("a")], hasNext: true });
    const detail = await f.claim();
    await f.result(detail, { jobs: [job("a")] });
    const next = await f.claim();
    assert.equal(next.kind, "next");
    for (const payload of [{ links: [url("b")], hasNext: false }, { links: [], hasNext: false }, { links: [url("a")], hasNext: true }])
      assert.equal((await f.result(next, { ...payload, continuationEnded: true })).statusCode, 400);
    assert.equal((await f.result(next, { links: [url("a")], hasNext: false, continuationEnded: true })).statusCode, 200);
    assert.equal(await f.claim(), null);
    assert.equal((await f.state()).state, "completed");
    assert.equal((await f.state()).discovered, 1);
    assert.equal(f.store.applications().length, 0);
  } finally { await f.close(); }
});

test("批量候选可采集至300个，超界请求被拒绝且不启动投递", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.start({ maxJobs: 301 })).statusCode, 400);
    assert.equal((await f.start({ maxJobs: 300 })).statusCode, 200);
    assert.equal((await f.state()).config.maxJobs, 300);
    assert.equal(f.store.applications().length, 0);
  } finally { await f.close(); }
});

test("只读复核只打开已入库的一个 BOSS 岗位，不搜索、不评分或投递", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request("/api/automation/start", { inspectJobId: "00000000-0000-4000-8000-000000000000" })).statusCode, 400);
    const imported = await f.request("/extension/v1/jobs", { jobs: [job("inspection")] });
    assert.equal(imported.statusCode, 200, imported.body);
    const id = f.store.jobs()[0]!.id;
    assert.equal((await f.request("/api/automation/start", { inspectJobId: id, url: "https://evil.example" })).statusCode, 400);
    const started = await f.request("/api/automation/start", { inspectJobId: id });
    assert.equal(started.statusCode, 200);
    assert.equal(started.json().run.inspectionJobId, undefined);
    assert.equal(f.store.get<any>("automation.current", null).inspectionJobId, id);
    const detail = await f.claim();
    assert.equal(detail.kind, "detail"); assert.equal(detail.url, url("inspection")); assert.equal(detail.searchUrl, undefined);
    assert.equal((await f.result(detail, { jobs: [job("inspection")] })).statusCode, 200);
    assert.equal(await f.claim(), null);
    const run = await f.state(); assert.equal(run.state, "completed"); assert.equal(run.scored, 0);
    assert.equal(f.store.applications().length, 0);
  } finally { await f.close(); }
});

test("采集被阻塞时可结束本轮并评分已有岗位，旧租约失效且重启保留评分进度", async () => {
  let scored = 0;
  const f = await fixture(async () => { scored++; return { decision: "eligible" } as Assessment; });
  try {
    await f.start({ autoAssess: true });
    const search = await f.claim();
    await f.result(search, { links: [url("partial-a"), url("partial-b")], hasNext: true });
    await f.result(await f.claim(), { jobs: [job("partial-a")] });
    const blockedDetail = await f.claim();
    await f.result(blockedDetail, { outcome: "error", reason: "page-unrecognized" });
    assert.equal((await f.state()).state, "blocked");
    const response = await f.control("finish-collection");
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().run.phase, "scoring");
    assert.equal(response.json().run.imported, 1);
    assert.equal(await f.claim(), null);
    assert.equal((await f.result(blockedDetail, { jobs: [job("partial-b")] })).statusCode, 400);
    await f.restart();
    await f.pump(); await f.pump();
    const run = await f.state();
    assert.equal(run.state, "completed");
    assert.equal(run.scored, 1); assert.equal(run.eligible, 1); assert.equal(scored, 1);
    assert.equal(f.store.jobs().length, 1);
    assert.equal(f.store.applications().length, 0);
    assert.equal((await f.control("finish-collection")).statusCode, 400);
  } finally { await f.close(); }
});

test("评分已有岗位拒绝空结果、未启用自动评分及配置变化，不清除仍有效的采集命令", async () => {
  const f = await fixture();
  try {
    await f.start({ autoAssess: true });
    const emptySearch = await f.claim();
    assert.equal((await f.control("finish-collection")).statusCode, 400);
    assert.equal((await f.result(emptySearch, { links: [url("a")], hasNext: false })).statusCode, 200);
    await f.result(await f.claim(), { jobs: [job("a")] });
    f.drift();
    assert.equal((await f.control("finish-collection")).statusCode, 400);
    assert.equal((await f.state()).phase, "collecting");
    await f.control("cancel");
    await f.start({ autoAssess: false });
    await f.result(await f.claim(), { links: [url("b")], hasNext: false });
    await f.result(await f.claim(), { jobs: [job("b")] });
    const next = await f.claim();
    assert.equal((await f.control("finish-collection")).statusCode, 400);
    assert.equal((await f.result(next, { links: [], hasNext: false })).statusCode, 200);
    assert.equal((await f.state()).scored, 0);
  } finally { await f.close(); }
});

test("最后一个搜索页未识别时只重开一次，记录缺口并自动评分已有岗位", async () => {
  const f = await fixture();
  const failure = { outcome: "error", reason: "page-unrecognized", diagnostic: { stage: "waiting-page", code: "dom-unrecognized", tabState: "complete" } };
  try {
    await f.start({ autoAssess: true });
    await f.result(await f.claim(), { links: [url("a")], hasNext: false });
    await f.result(await f.claim(), { jobs: [job("a")] });
    const failedSearch = await f.claim();
    assert.equal(new URL(failedSearch.url).searchParams.get("query"), "后端");
    assert.equal((await f.result(failedSearch, failure)).statusCode, 200);
    assert.equal((await f.result(failedSearch, failure)).statusCode, 200);
    assert.equal((await f.state()).state, "running");
    assert.equal((await f.state()).unreadableSearches.length, 0);
    await f.restart();
    const retry = await f.claim();
    assert.equal(retry.url, failedSearch.url);
    assert.notEqual(retry.id, failedSearch.id);
    await f.result(retry, failure);
    assert.equal((await f.state()).phase, "scoring");
    assert.equal((await f.state()).unreadableSearches.length, 1);
    assert.equal(await f.claim(), null);
    await f.pump(); await f.pump();
    const run = await f.state();
    assert.equal(run.state, "completed"); assert.equal(run.scored, 1);
    assert.match(run.message, /搜索页面未能读取/);
    assert.match(run.unreadableSearches[0].reason, /不代表没有岗位/);
    assert.equal(f.store.applications().length, 0);
  } finally { await f.close(); }
});

test("翻页后无法识别不再次点击翻页，跳过该词保留岗位，登录和验证仍阻塞", async () => {
  const f = await fixture();
  const failure = { outcome: "error", reason: "page-unrecognized", diagnostic: { stage: "reading-page", code: "dom-unrecognized" } };
  try {
    await f.start();
    const search = await f.claim();
    await f.result(search, { links: [url("a")], hasNext: true });
    await f.result(await f.claim(), { jobs: [job("a")] });
    const next = await f.claim(); assert.equal(next.kind, "next");
    for (const actualUrl of ["https://evil.example/web/geek/jobs", next.url.replace("101020100", "100010000"), next.url.replace("query=", "query=changed")]) {
      assert.equal((await f.result(next, { ...failure, url: actualUrl })).statusCode, 400);
    }
    await f.result(next, failure);
    const second = await f.claim();
    assert.equal(second.kind, "search");
    assert.equal(new URL(second.url).searchParams.get("query"), "后端");
    assert.equal((await f.state()).imported, 1);
    await f.result(second, { ...failure, outcome: "blocked", reason: "verification-required" });
    assert.equal((await f.state()).state, "blocked");
    assert.equal((await f.state()).unreadableSearches.length, 1);
    await f.control("resume");
    await f.result(await f.claim(), { outcome: "blocked", reason: "login-required" });
    assert.equal((await f.state()).state, "blocked");
    assert.match((await f.state()).message, /登录已失效/);
  } finally { await f.close(); }
});

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

test("页面字段证据严格限量并绑定详情回执，重复及重启不丢失或扩大记录", async () => {
  const f = await fixture();
  const reading = { route: "supplement", merge: "standalone-selected", salary: "readable", location: "missing", industry: "company-mismatch", finalSalary: true, finalLocation: true, finalIndustry: false };
  const evidence = { title: "工程师", company: "公司", descriptionPresent: true, clientLabelSeen: false, clientNames: [], headerLines: ["工程师", "25-35K"], companySections: [{ lines: ["公司基本信息", "展示名"], links: [{ text: "展示名", path: "/gongsi/example.html" }] }] };
  try {
    await f.start({ maxJobs: 1 });
    const search = await f.claim();
    assert.equal((await f.result(search, { links: [url("a")], fieldReading: reading, pageEvidence: evidence })).statusCode, 400);
    await f.result(search, { links: [url("a")], hasNext: false });
    const detail = await f.claim();
    for (const bad of [
      { ...evidence, rawHtml: "private" },
      { ...evidence, headerLines: Array(21).fill("line") },
      { ...evidence, company: "x".repeat(161) },
      { ...evidence, companySections: [{ lines: [], links: [{ text: "bad", path: "https://evil.example" }] }] },
      { ...evidence, companySections: [{ lines: [], links: [{ text: "bad", path: "/gongsi/example.html?token=secret" }] }] },
    ]) assert.equal((await f.result(detail, { jobs: [job("a")], fieldReading: reading, pageEvidence: bad })).statusCode, 400);
    assert.equal((await f.result(detail, { jobs: [job("a")], pageEvidence: evidence })).statusCode, 400);
    assert.equal((await f.result(detail, { jobs: [job("b")], fieldReading: reading, pageEvidence: evidence })).statusCode, 400);
    assert.equal((await f.state()).fieldReadings.length, 0);
    const payload = { jobs: [job("a")], fieldReading: reading, pageEvidence: evidence };
    assert.equal((await f.result(detail, payload)).statusCode, 200);
    assert.equal((await f.result(detail, payload)).statusCode, 200);
    await f.restart();
    const records = (await f.state()).fieldReadings;
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].evidence, evidence);
    assert.ok(!JSON.stringify(f.store.jobs()).includes("展示名"));
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

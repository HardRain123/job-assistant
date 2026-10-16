import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/api/src/app.ts";
import type { Application, Job } from "../packages/contracts/src/index.ts";
import { Store } from "../packages/storage/src/index.ts";

const origin = `chrome-extension://${"a".repeat(32)}`;
const startPath = "/api/extension-application/diagnose";
const claimPath = "/extension/v1/application/diagnostic-claim";
const resultPath = "/extension/v1/application/diagnostic-result";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "chat-diagnostic-"));
  let store = new Store(join(dir, "db.sqlite"));
  const addApplication = () => {
    const jobId = randomUUID(), timestamp = new Date().toISOString();
    const job = store.upsertJob({
      id: jobId, source: "boss", sourceId: "extension", sourceJobId: jobId,
      url: `https://www.zhipin.com/job_detail/${jobId}.html?tracking=private#detail`,
      title: "JAVA开发工程师", company: "诊断测试公司", companyAliases: ["诊断测试公司有限公司"],
      industry: "计算机软件", location: "上海·青浦区", remote: false,
      salaryMin: 20000, salaryMax: 35000, salaryMonths: 13,
      experienceMin: 3, description: "不得返回的岗位详情", skills: ["Java"], education: "本科",
      firstSeen: timestamp, lastSeen: timestamp, contentHash: "pending", status: "active",
    } satisfies Job);
    const application: Application = {
      id: randomUUID(), executor: "extension", status: "needs-review", stopReason: "send-unconfirmed",
      batchId: randomUUID(), jobId, job, resumeId: randomUUID(), resumeAttachment: "private-resume.pdf",
      templateVersion: 4, frozenMessages: ["私人话术一", "私人话术二"], attachmentPolicy: "message-only",
      actions: [
        { id: randomUUID(), kind: "native-greeting", index: 0, text: null, state: "unknown", evidence: "send-unconfirmed", updatedAt: timestamp },
        { id: randomUUID(), kind: "message", index: 1, text: "私人话术一", state: "pending", evidence: null, updatedAt: timestamp },
        { id: randomUUID(), kind: "message", index: 2, text: "私人话术二", state: "pending", evidence: null, updatedAt: timestamp },
      ], createdAt: timestamp,
    };
    store.insertApplication(application);
    const taskId = store.enqueue("apply", application);
    store.db.prepare("UPDATE tasks SET status='needs-review' WHERE id=?").run(taskId);
    store.dailyQuota(); // Seed the existing uncertain action's occupied quota.
    return application;
  };
  const application = addApplication();
  store.set("paused", true);
  const options = () => ({ store, password: "password", key: "key", internalToken: "internal", dataDir: dir, attachmentsDir: join(dir, "attachments") });
  let app = await createApp(options());
  const login = async () => String((await app.inject({ method: "POST", url: "/api/login", payload: { password: "password" } })).headers["set-cookie"]).split(";")[0];
  let cookie = await login();
  const workbench = (url: string, payload?: Record<string, unknown>) => app.inject({ method: payload === undefined ? "GET" : "POST", url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
  const code = (await workbench("/api/extension/pair-code", {})).json().code;
  const token = (await app.inject({ method: "POST", url: "/extension/v1/pair", headers: { origin }, payload: { code } })).json().token;
  const headers = { origin, authorization: `Bearer ${token}`, "x-extension-version": "0.4.11" };
  const extension = (url: string, payload: Record<string, unknown> = {}, extra: Record<string, string> = {}) => app.inject({ method: "POST", url, headers: { ...headers, ...extra }, payload });
  await extension("/extension/v1/status");
  const start = (applicationId = application.id) => workbench(startPath, { applicationId });
  const state = (applicationId = application.id) => workbench(`${startPath}/${applicationId}`);
  const claim = () => extension(claimPath);
  const claimed = async () => {
    const requested = await start();
    assert.equal(requested.statusCode, 200, requested.body);
    const response = await claim();
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(response.json().task);
    return response.json().task;
  };
  const payload = (task: any, extra: Record<string, unknown> = {}) => ({
    id: task.id, applicationId: task.applicationId, leaseToken: task.leaseToken,
    outcome: "observed", headerEvidence: { names: ["陈文"], roles: ["招聘者"] }, ...extra,
  });
  const databaseEvidence = () => JSON.stringify({
    applications: store.db.prepare("SELECT * FROM applications ORDER BY id").all(),
    tasks: store.db.prepare("SELECT * FROM tasks ORDER BY id").all(),
    quota: store.db.prepare("SELECT * FROM contact_quota ORDER BY action_id").all(),
    jobs: store.db.prepare("SELECT * FROM jobs ORDER BY id").all(),
    settings: store.db.prepare("SELECT * FROM settings WHERE key NOT LIKE 'chatDiagnostic.%' AND key != 'browserExtension.connection' ORDER BY key").all(),
  });
  return {
    get app() { return app; }, get store() { return store; }, get cookie() { return cookie; },
    application, addApplication, workbench, extension, start, state, claim, claimed, payload, headers, databaseEvidence,
    restart: async () => { await app.close(); store.close(); store = new Store(join(dir, "db.sqlite")); app = await createApp(options()); cookie = await login(); },
    close: async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("只读诊断沿用工作台会话与精确扩展来源鉴权，旧扩展不能领取", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject({ method: "POST", url: startPath, payload: { applicationId: f.application.id } })).statusCode, 401);
    assert.equal((await f.app.inject({ method: "GET", url: `${startPath}/${f.application.id}` })).statusCode, 401);
    assert.equal((await f.app.inject({ method: "POST", url: startPath, headers: { cookie: f.cookie, origin: "https://example.com" }, payload: { applicationId: f.application.id } })).statusCode, 403);
    assert.equal((await f.extension(claimPath, {}, { authorization: "Bearer " + "f".repeat(64) })).statusCode, 401);
    assert.equal((await f.extension(claimPath, {}, { origin: `chrome-extension://${"b".repeat(32)}` })).statusCode, 401);
    assert.equal((await f.extension(resultPath, {}, { origin: "https://www.zhipin.com" })).statusCode, 403);
    assert.equal((await f.extension(claimPath + "/extra")).statusCode, 403);
    assert.equal((await f.app.inject({ method: "GET", url: claimPath, headers: f.headers })).statusCode, 405);
    const preflight = await f.app.inject({ method: "OPTIONS", url: claimPath, headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,x-extension-version" } });
    assert.equal(preflight.statusCode, 204);
    await f.extension("/extension/v1/status", {}, { "x-extension-version": "0.4.10" });
    assert.equal((await f.start()).statusCode, 400);
    await f.extension("/extension/v1/status");
    assert.equal((await f.start()).statusCode, 200);
    assert.equal((await f.extension(claimPath, {}, { "x-extension-version": "0.4.10" })).json().task, null);
    assert.equal((await f.extension(claimPath, { url: "https://example.com" })).statusCode, 400);
    assert.ok((await f.claim()).json().task);
  } finally { await f.close(); }
});

test("诊断任务只返回固定岗位字段，同一应用复用且每个任务仅领取一次，重启不会重新派发", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.state()).json().diagnostic, null);
    const first = await f.start();
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual((await f.start()).json(), first.json());
    const other = f.addApplication();
    assert.equal((await f.start(other.id)).statusCode, 400);
    const claims = await Promise.all([f.claim(), f.claim()]);
    assert.equal(claims.filter((response) => response.json().task !== null).length, 1);
    const task = claims.find((response) => response.json().task)?.json().task;
    assert.deepEqual(Object.keys(task).sort(), ["applicationId", "id", "job", "leaseToken"]);
    assert.deepEqual(Object.keys(task.job).sort(), ["company", "companyAliases", "location", "salaryMax", "salaryMin", "salaryMonths", "title", "url"]);
    assert.equal(task.job.url, f.application.job.url.split("?")[0]);
    const json = JSON.stringify(task);
    for (const secret of ["private-resume", "私人话术", "不得返回的岗位详情", "resumeId", "actions", "sourceId"]) assert.equal(json.includes(secret), false);
    assert.equal((await f.start()).json().diagnostic.id, task.id);
    assert.equal((await f.state()).json().diagnostic.status, "leased");
    assert.equal((await f.state()).body.includes(task.leaseToken), false);
    assert.equal((await f.state()).body.includes("leaseHash"), false);
    await f.restart();
    assert.equal((await f.claim()).json().task, null);
    assert.equal((await f.state()).json().diagnostic.id, task.id);
    assert.equal((await f.extension(resultPath, f.payload(task))).statusCode, 200);
  } finally { await f.close(); }
});

test("待领取和已领取诊断均在五分钟失效，只能显式创建新任务而不会自动重试", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture();
  try {
    const requested = (await f.start()).json().diagnostic;
    t.mock.timers.tick(300_000);
    assert.equal((await f.claim()).json().task, null);
    assert.equal((await f.state()).json().diagnostic.status, "expired");
    const task = await f.claimed();
    assert.notEqual(task.id, requested.id);
    t.mock.timers.tick(300_000);
    assert.equal((await f.extension(resultPath, f.payload(task))).statusCode, 400);
    assert.equal((await f.claim()).json().task, null);
    assert.equal((await f.state()).json().diagnostic.status, "expired");
  } finally { await f.close(); }
});

test("诊断结果严格限定证据长度和范围，错误租约、应用、任意正文或重复覆盖均被拒绝", async () => {
  const f = await fixture();
  try {
    const task = await f.claimed();
    const invalid = [
      { id: randomUUID() }, { applicationId: randomUUID() }, { leaseToken: randomUUID() },
      { html: "<div>正文</div>" }, { url: "https://example.com" }, { outcome: "sent" },
      { outcome: "unavailable" }, { outcome: "not-found" }, { outcome: "ambiguous" },
      { headerEvidence: undefined },
      { headerEvidence: { names: ["甲", "乙", "丙", "丁"], roles: [] } },
      { headerEvidence: { names: [], roles: ["甲", "乙", "丙", "丁"] } },
      { headerEvidence: { names: ["姓".repeat(49)], roles: [] } },
      { headerEvidence: { names: [], roles: ["职".repeat(49)] } },
      { headerEvidence: { names: [""], roles: [] } },
      { headerEvidence: { names: ["   "], roles: [] } },
      { headerEvidence: { names: ["陈\n文"], roles: [] } },
      { headerEvidence: { names: ["陈\u0000文"], roles: [] } },
      { headerEvidence: { names: ["陈\u200b文"], roles: [] } },
      { headerEvidence: { names: ["<陈文>"], roles: [] } },
      { headerEvidence: { names: ["陈文"], roles: [], body: "任意正文" } },
    ];
    for (const extra of invalid) {
      const response = await f.extension(resultPath, f.payload(task, extra));
      assert.equal(response.statusCode, 400, `${JSON.stringify(extra)}: ${response.body}`);
    }
    const valid = f.payload(task);
    const accepted = await f.extension(resultPath, valid);
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal((await f.extension(resultPath, valid)).body, accepted.body);
    assert.equal((await f.extension(resultPath, f.payload(task, { headerEvidence: { names: ["另一人"], roles: [] } }))).statusCode, 400);
    assert.equal((await f.extension(resultPath, f.payload(task, { leaseToken: randomUUID() }))).statusCode, 400);
    const view = (await f.state()).json().diagnostic;
    assert.equal(view.status, "completed");
    assert.deepEqual(view.result, { outcome: "observed", headerEvidence: { names: ["陈文"], roles: ["招聘者"] } });
    assert.equal(f.store.db.prepare("SELECT count(*) AS count FROM audit WHERE event='chatDiagnostic.completed'").get()?.count, 1);
  } finally { await f.close(); }
});

test("字段未读到时可提交空数组，非观察结果不携带任何标题证据", async () => {
  const f = await fixture();
  try {
    const task = await f.claimed();
    assert.equal((await f.extension(resultPath, f.payload(task, { headerEvidence: { names: [], roles: [] } }))).statusCode, 200);
    for (const outcome of ["not-found", "ambiguous", "unavailable"]) {
      const next = await f.claimed();
      const result = await f.extension(resultPath, f.payload(next, { outcome, headerEvidence: undefined }));
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual((await f.state()).json().diagnostic.result, { outcome });
    }
  } finally { await f.close(); }
});

test("只读诊断绑定原应用，状态或冻结内容变化会作废待领取及已领取任务", async () => {
  const f = await fixture();
  try {
    const original = f.application;
    for (const patch of [{ status: "completed" }, { executor: "worker" }, { job: { ...original.job, source: "official" } }, { job: { ...original.job, url: "https://example.com/job" } }]) {
      f.store.updateApplication({ ...original, ...patch } as Application);
      assert.equal((await f.start()).statusCode, 400);
    }
    f.store.updateApplication(original);
    await f.start();
    f.store.updateApplication({ ...original, status: "cancelled" });
    assert.equal((await f.claim()).json().task, null);
    assert.equal((await f.state()).json().diagnostic.status, "invalidated");
    f.store.updateApplication(original);
    const task = await f.claimed();
    f.store.updateApplication({ ...original, job: { ...original.job, company: "已改变公司" } });
    assert.equal((await f.extension(resultPath, f.payload(task))).statusCode, 400);
    assert.equal((await f.state()).json().diagnostic.status, "invalidated");
    assert.equal((await f.claim()).json().task, null);
  } finally { await f.close(); }
});

test("采集、批次、投递或人工接管时不能创建、领取或提交诊断，全局暂停本身不阻止只读检查", async () => {
  const f = await fixture();
  try {
    const blockers: [string, unknown][] = [
      ["takeover", true],
      ["automation.current", { state: "running" }],
      ["automation.current", { state: "paused" }],
      ["automation.current", { state: "blocked" }],
      ["bulkWorkflow.current", { state: "running" }],
      ["bulkWorkflow.current", { state: "paused" }],
      ["bulk.current", { state: "running" }],
    ];
    const requested = await f.start();
    assert.equal(requested.statusCode, 200, requested.body);
    for (const [key, value] of blockers) {
      f.store.set(key, value);
      assert.equal((await f.start()).statusCode, 400, key);
      assert.equal((await f.claim()).json().task, null, key);
      f.store.set(key, key === "takeover" ? false : null);
    }
    const queuedId = f.store.enqueue("apply", f.application);
    for (const status of ["queued", "leased"]) {
      f.store.db.prepare("UPDATE tasks SET status=? WHERE id=?").run(status, queuedId);
      assert.equal((await f.start()).statusCode, 400, status);
      assert.equal((await f.claim()).json().task, null, status);
    }
    f.store.db.prepare("UPDATE tasks SET status='failed' WHERE id=?").run(queuedId);
    const task = (await f.claim()).json().task;
    assert.ok(task);
    for (const [key, value] of blockers) {
      f.store.set(key, value);
      assert.equal((await f.extension(resultPath, f.payload(task))).statusCode, 400, key);
      f.store.set(key, key === "takeover" ? false : null);
    }
    f.store.db.prepare("UPDATE tasks SET status='queued' WHERE id=?").run(queuedId);
    assert.equal((await f.extension(resultPath, f.payload(task))).statusCode, 400);
    f.store.db.prepare("UPDATE tasks SET status='failed' WHERE id=?").run(queuedId);
    assert.equal(f.store.get("paused", false), true);
    assert.equal((await f.extension(resultPath, f.payload(task))).statusCode, 200);
  } finally { await f.close(); }
});

test("诊断不能改写应用、任务、批次或配额，其租约不能用于消息发送授权", async () => {
  const f = await fixture();
  try {
    f.store.set("bulk.current", { id: randomUUID(), state: "completed", counts: { review: 1, completed: 0 } });
    f.store.set("bulkWorkflow.current", { id: randomUUID(), state: "completed", counts: { review: 1, completed: 0 } });
    const before = f.databaseEvidence();
    const task = await f.claimed();
    assert.equal(f.databaseEvidence(), before);
    assert.equal((await f.extension(resultPath, f.payload(task))).statusCode, 200);
    assert.equal(f.databaseEvidence(), before);
    const forged = { taskId: task.id, applicationId: task.applicationId, leaseToken: task.leaseToken, actionId: f.application.actions[1].id };
    assert.equal((await f.extension("/extension/v1/application/authorize", forged)).statusCode, 400);
    assert.equal((await f.extension("/extension/v1/application/action", { ...forged, state: "started", evidence: "before-action" })).statusCode, 400);
    assert.equal(f.databaseEvidence(), before);
    const audit = f.store.db.prepare("SELECT body FROM audit WHERE event LIKE 'chatDiagnostic.%'").all();
    assert.equal(JSON.stringify(audit).includes(task.leaseToken), false);
    assert.equal(JSON.stringify(audit).includes("陈文"), false);
    assert.equal(JSON.stringify(f.store.get(`chatDiagnostic.record:${task.id}`, null)).includes(task.leaseToken), false);
  } finally { await f.close(); }
});

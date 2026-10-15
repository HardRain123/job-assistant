import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/api/src/app.ts";
import { encrypt } from "../apps/api/src/security.ts";
import { Store } from "../packages/storage/src/index.ts";
import { fingerprint } from "../packages/templates/src/index.ts";
import { evaluateGates } from "../packages/matching/src/index.ts";
import { DEFAULT_POLICY, type Assessment, type Job, type ProviderConfig, type Resume } from "../packages/contracts/src/index.ts";

// Real application services and SQLite transactions; only extension DOM/action
// evidence is submitted by the test. This does not exercise a real BOSS browser.
const workflowConfig = {
  dailyLimit: 150, target: 1, intervalSeconds: 30, continueOnJobFailure: true,
  keywords: ["Java"], city: "上海", maxJobsPerRound: 1, maxPages: 1, maxRounds: 1,
};

async function waitFor<T>(read: () => Promise<T>, matches: (value: T) => boolean, description: string) {
  const until = Date.now() + 6000;
  let value = await read();
  while (!matches(value) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    value = await read();
  }
  assert.ok(matches(value), `${description}: ${JSON.stringify(value)}`);
  return value;
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bulk-workflow-real-"));
  let store = new Store(join(dir, "db.sqlite"));
  const resume: Resume = { id: randomUUID(), name: "测试候选人", text: "Java Spring 后端开发及企业AI平台研发", skills: ["Java"], years: 7, attachmentName: null, createdAt: new Date().toISOString() };
  const policy = { ...DEFAULT_POLICY, cities: ["上海"], salaryMin: 16000, excludedCompanies: ["暖哇"], excludedIndustries: ["保险"] };
  // No request reaches this provider: the collection test seeds the exact
  // persisted model cache before enabling scoring of its imported job.
  const providers: ProviderConfig[] = [{ id: "cache-only", name: "测试缓存", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", model: "cache-only", protocol: "chat-completions", enabled: true, priority: 0, timeoutMs: 1000 }];
  store.set("resume", resume);
  store.set("policy", policy);
  store.set("providers", encrypt(providers, "key"));
  store.set("template", { id: "default", version: 1, name: "测试话术", segments: ["您好，申请{{title}}。", "目前状态：离职，期待沟通。"], attachmentPolicy: "message-only" });
  const seedScore = (job: Job) => store.set("assessment:" + fingerprint({
    job: job.contentHash, resume, policy,
    providers: providers.map(({ id, model, baseUrl, enabled, priority }) => ({ id, model, url: baseUrl, enabled, priority })),
  }), { jobId: job.id, resumeId: resume.id, policyVersion: policy.version, score: 95, decision: "eligible", gates: evaluateGates(job, resume, policy), dimensions: {}, reasons: [], provider: "cache-only", model: "cache-only", createdAt: new Date().toISOString() } satisfies Assessment);
  const addJob = (company: string) => {
    const id = randomUUID(), now = new Date().toISOString();
    const job = store.upsertJob({ id, source: "boss", sourceId: "extension", sourceJobId: id,
      url: `https://www.zhipin.com/job_detail/${id}.html`, company, companyAliases: [], industry: "计算机软件", title: "Java开发工程师", location: "上海", remote: false,
      salaryMin: 18000, salaryMax: 30000, salaryMonths: 12, experienceMin: 3, description: "负责Java微服务研发及平台工程建设", skills: ["Java"], education: "本科", firstSeen: now, lastSeen: now, contentHash: "pending", status: "active" });
    seedScore(job);
    return job;
  };
  let app = await createApp({ store, password: "password", key: "key", internalToken: "internal", dataDir: dir, attachmentsDir: join(dir, "attachments") });
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "password" } });
  let cookie = String(login.headers["set-cookie"]).split(";")[0];
  const workbench = (url: string, payload?: Record<string, unknown>) => app.inject({ method: payload === undefined ? "GET" : "POST", url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
  const code = (await workbench("/api/extension/pair-code", {})).json().code;
  const origin = `chrome-extension://${"a".repeat(32)}`;
  const paired = await app.inject({ method: "POST", url: "/extension/v1/pair", headers: { origin }, payload: { code } });
  assert.equal(paired.statusCode, 200, paired.body);
  const token = paired.json().token;
  const extension = (url: string, payload: Record<string, unknown> = {}) => app.inject({ method: "POST", url, headers: { origin, authorization: `Bearer ${token}`, "x-extension-version": "0.4.8" }, payload });
  await extension("/extension/v1/status");
  const start = async (extra: Record<string, unknown> = {}) => {
    const preview = await workbench("/api/bulk-workflow/preview", { ...workflowConfig, ...extra });
    assert.equal(preview.statusCode, 200, preview.body);
    const response = await workbench("/api/bulk-workflow/start", { previewId: preview.json().previewId });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().run;
  };
  const state = async () => (await workbench("/api/bulk-workflow")).json().run;
  const claim = async () => {
    const response = await extension("/extension/v1/application/claim");
    assert.equal(response.statusCode, 200, response.body);
    return response.json().task;
  };
  const action = async (task: any, index: number, state: string, evidence: string) => {
    const response = await extension("/extension/v1/application/action", { taskId: task.id, leaseToken: task.leaseToken, applicationId: task.application.id, actionId: task.application.actions[index].id, state, evidence });
    assert.equal(response.statusCode, 200, response.body);
    return response;
  };
  const authorize = async (task: any, index: number) => {
    const response = await extension("/extension/v1/application/authorize", { taskId: task.id, leaseToken: task.leaseToken, applicationId: task.application.id, actionId: task.application.actions[index].id });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().allowed, true);
  };
  const result = async (task: any, reason?: string) => {
    const response = await extension("/extension/v1/application/result", { taskId: task.id, leaseToken: task.leaseToken, applicationId: task.application.id, ...(reason ? { reason } : {}) });
    assert.equal(response.statusCode, 200, response.body);
    return response;
  };
  return { get app() { return app; }, get store() { return store; }, addJob, seedScore, workbench, extension, start, state, claim, action, authorize, result,
    restart: async () => {
      await app.close();
      store.close();
      store = new Store(join(dir, "db.sqlite"));
      app = await createApp({ store, password: "password", key: "key", internalToken: "internal", dataDir: dir, attachmentsDir: join(dir, "attachments") });
      const loggedIn = await app.inject({ method: "POST", url: "/api/login", payload: { password: "password" } });
      cookie = String(loggedIn.headers["set-cookie"]).split(";")[0];
      const status = await extension("/extension/v1/status");
      assert.equal(status.statusCode, 200, status.body);
    },
    close: async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("真实工作流端口启动、暂停、恢复、取消使用同一事务，旧子任务入口不能绕过暂停", async () => {
  const f = await fixture();
  try {
    f.addJob("真实端口测试甲公司");
    const run = await f.start();
    assert.equal(run.counts.planned, 1);
    const child = (await f.workbench("/api/bulk-application")).json().run;
    assert.equal(child.state, "running");
    const paused = await f.workbench("/api/bulk-workflow/control", { action: "pause" });
    assert.equal(paused.statusCode, 200, paused.body);
    assert.equal((await f.workbench("/api/bulk-application")).json().run.state, "paused");
    const bypass = await f.workbench("/api/bulk-application/control", { action: "resume" });
    assert.equal(bypass.statusCode, 400, bypass.body);
    assert.equal(await f.claim(), null);
    const resumed = await f.workbench("/api/bulk-workflow/control", { action: "resume" });
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal((await f.workbench("/api/bulk-application")).json().run.state, "running");
    const cancelled = await f.workbench("/api/bulk-workflow/control", { action: "cancel" });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().run.state, "cancelled");
    assert.equal((await f.workbench("/api/bulk-application")).json().run.state, "cancelled");
    assert.equal(f.store.applications()[0].status, "cancelled");
    assert.equal(await f.claim(), null);
    assert.ok(f.store.tasks().every((task) => !["queued", "leased"].includes(task.status)));
  } finally { await f.close(); }
});

test("真实工作流最后一个沟通名额占用后仍允许本岗位两段话术并幂等收尾", async () => {
  const f = await fixture();
  try {
    f.addJob("最后名额测试公司");
    await f.start({ dailyLimit: 1, target: 1 });
    const task = await f.claim();
    assert.ok(task);
    assert.deepEqual(task.application.actions.map((action: any) => action.kind), ["native-greeting", "message", "message"]);
    await f.action(task, 0, "started", "before-action");
    await f.authorize(task, 0);
    await f.action(task, 0, "confirmed", "new-conversation");
    assert.equal(f.store.dailyQuota().remaining, 0);
    // Allow the real workflow timer to inspect the exhausted daily quota.
    await new Promise((resolve) => setTimeout(resolve, 1150));
    assert.equal((await f.state()).state, "running");
    assert.equal((await f.workbench("/api/bulk-application")).json().run.state, "running");
    for (const index of [1, 2]) {
      await f.action(task, index, "started", "before-action");
      await f.authorize(task, index);
      await f.action(task, index, "confirmed", "new-message");
    }
    const first = await f.result(task);
    const repeated = await f.result(task);
    assert.equal(first.body, repeated.body);
    const run = await waitFor(f.state, (run) => run.state === "completed", "最后一个名额投递完成后工作流收尾");
    assert.equal(run.counts.planned, 1);
    assert.equal(run.counts.completed, 1);
    assert.equal(run.counts.review, 0);
    assert.equal(f.store.dailyQuota().occupied, 1);
    assert.equal(f.store.dailyQuota().completed, 1);
    assert.equal(f.store.applications().length, 1);
    assert.equal(await f.claim(), null);
  } finally { await f.close(); }
});

test("真实工作流全局暂停和配置变化同步暂停实际投递子任务", async () => {
  for (const trigger of ["queue", "configuration"]) {
    const f = await fixture();
    try {
      f.addJob(`暂停测试${trigger}公司`);
      await f.start();
      if (trigger === "queue") f.store.set("paused", true);
      else {
        const policy = f.store.get<any>("policy", null);
        f.store.set("policy", { ...policy, salaryMin: 17000, version: policy.version + 1 });
      }
      await waitFor(f.state, (run) => run.state === "paused", `${trigger}使工作流暂停`);
      const child = (await f.workbench("/api/bulk-application")).json().run;
      assert.equal(child.state, "paused");
      assert.equal(await f.claim(), null);
      assert.equal(f.store.applications()[0].actions[0].state, "pending");
      assert.equal(f.store.dailyQuota().occupied, 0);
    } finally { await f.close(); }
  }
});

test("父批次跨日或仅向量配置变化，在定时巡检前也不能领取、开始或授权发送", async () => {
  for (const trigger of ["day", "embedding"]) {
    for (const boundary of ["claim", "started", "authorize"]) {
      const f = await fixture();
      try {
        f.addJob(`边界测试${trigger}${boundary}公司`);
        await f.start();
        const task = boundary === "claim" ? null : await f.claim();
        if (boundary === "authorize") await f.action(task, 0, "started", "before-action");
        if (trigger === "day") {
          const workflow = f.store.get<any>("bulkWorkflow.current", null);
          f.store.set("bulkWorkflow.current", { ...workflow, shanghaiDay: "2000-01-01" });
        } else {
          f.store.set("embedding", encrypt({ enabled: false, baseUrl: "https://api.openai.com/v1", model: "changed" }, "key"));
        }
        // No wait or timer pump here: the send boundary itself must reject.
        if (boundary === "claim") assert.equal(await f.claim(), null);
        else {
          const response = await f.extension(`/extension/v1/application/${boundary === "started" ? "action" : "authorize"}`, {
            taskId: task.id, leaseToken: task.leaseToken, applicationId: task.application.id,
            actionId: task.application.actions[0].id,
            ...(boundary === "started" ? { state: "started", evidence: "before-action" } : {}),
          });
          assert.equal(response.statusCode, 400, response.body);
        }
        const action = f.store.applications()[0].actions[0];
        assert.equal(action.state, boundary === "authorize" ? "started" : "pending");
        assert.equal(f.store.dailyQuota().completed, 0);
      } finally { await f.close(); }
    }
  }
});

test("零候选真实采集回执入库，自动评分缓存后启动投递子任务并完成", async () => {
  const f = await fixture();
  try {
    const workflow = await f.start();
    assert.equal(workflow.phase, "collecting");
    const paused = await f.workbench("/api/bulk-workflow/control", { action: "pause" });
    assert.equal(paused.statusCode, 200, paused.body);
    assert.equal((await f.workbench("/api/automation")).json().run.state, "paused");
    assert.equal((await f.workbench("/api/automation/control", { action: "resume" })).statusCode, 400);
    assert.equal((await f.workbench("/api/bulk-workflow/control", { action: "resume" })).statusCode, 200);
    const search = (await f.extension("/extension/v1/claim")).json().command;
    assert.equal(search.kind, "search");
    const jobUrl = `https://www.zhipin.com/job_detail/${randomUUID()}.html`;
    const report = (command: any, payload: Record<string, unknown>) => f.extension("/extension/v1/result", { commandId: command.id, runId: command.runId, leaseToken: command.leaseToken, outcome: "ok", url: command.url, ...payload });
    const list = await report(search, { links: [jobUrl], hasNext: false });
    assert.equal(list.statusCode, 200, list.body);
    const detail = (await f.extension("/extension/v1/claim")).json().command;
    const imported = await report(detail, { jobs: [{ url: jobUrl, title: "Java开发工程师", company: "采集评分真实端口测试公司", description: "负责Java平台与微服务的研发及工程化工作。", location: "上海", salaryText: "18-30K", industry: "计算机软件", education: "本科", detail: true, status: "active" }] });
    assert.equal(imported.statusCode, 200, imported.body);
    const job = f.store.jobs()[0];
    assert.ok(job);
    f.seedScore(job);
    await f.extension("/extension/v1/claim");
    await waitFor(f.state, (run) => run.phase === "sending", "真实采集评分后自动启动投递");
    const automation = (await f.workbench("/api/automation")).json().run;
    assert.equal(automation.state, "completed");
    assert.equal(automation.scored, 1);
    const task = await f.claim();
    assert.ok(task);
    for (const index of [0, 1, 2]) {
      await f.action(task, index, "started", "before-action");
      await f.authorize(task, index);
      await f.action(task, index, "confirmed", index === 0 ? "new-conversation" : "new-message");
    }
    await f.result(task);
    const completed = await waitFor(f.state, (run) => run.state === "completed", "采集到发送的真实端口工作流完成");
    assert.equal(completed.counts.completed, 1);
    assert.equal(completed.budgetUsed, 1);
    assert.equal(f.store.applications().length, 1);
  } finally { await f.close(); }
});

test("同一工作流跨三个单岗位子批次累计失败，SQLite 重启保留，人工继续才重置", async () => {
  const f = await fixture();
  const child = async () => (await f.workbench("/api/bulk-application")).json().run;
  try {
    f.addJob("跨批失败第一公司");
    await f.start({ target: 4 });
    for (let index = 0; index < 3; index++) {
      const current = await child();
      assert.equal(current.consecutiveJobFailures, index);
      assert.equal(current.counts.queued, 1);
      if (index === 1) {
        // Simulate the deployed pre-inheritance schema: archived child 1 has
        // one failure, while the newly created active child still starts at 0.
        const legacyWorkflow = f.store.get<any>("bulkWorkflow.current", null);
        delete legacyWorkflow.consecutiveJobFailures;
        f.store.set("bulkWorkflow.current", legacyWorkflow);
        const legacyChild = f.store.get<any>("bulk.current", null);
        f.store.set("bulk.current", { ...legacyChild, consecutiveJobFailures: 0 });
        await f.restart();
        if (f.store.get<any>("bulkWorkflow.current", null).consecutiveJobFailures === undefined)
          assert.equal(await f.claim(), null, "旧父批次迁移前不允许领取发送");
        await waitFor(async () => f.store.get<any>("bulkWorkflow.current", null), (run) => run.consecutiveJobFailures === 1, "从旧归档恢复失败计数");
        assert.equal((await child()).id, current.id);
        assert.equal((await child()).consecutiveJobFailures, 1);
        assert.equal(f.store.get<any>("bulkWorkflow.current", null).consecutiveJobFailures, 1);
      }
      const task = await f.claim();
      assert.ok(task);
      await f.action(task, 0, "started", "before-action");
      await f.authorize(task, 0);
      await f.action(task, 0, "unknown", "send-unconfirmed");
      f.addJob(`跨批失败下一公司${index}`);
      await f.result(task, "send-unconfirmed");
      await f.result(task, "send-unconfirmed");
      if (index < 2) {
        await waitFor(f.state, (run) => run.counts.planned === index + 2, "下一单岗位子批次启动");
        assert.notEqual((await child()).id, current.id);
      }
    }
    const paused = await waitFor(f.state, (run) => run.state === "paused", "第三次连续失败暂停工作流");
    assert.equal(paused.counts.planned, 3);
    assert.equal(paused.counts.review, 3);
    assert.equal((await child()).consecutiveJobFailures, 3);
    assert.match((await child()).message, /连续 3 个岗位/);
    assert.equal(f.store.get<any>("bulkWorkflow.current", null).consecutiveJobFailures, 3);
    assert.equal(await f.claim(), null);
    assert.equal(f.store.applications().length, 3);
    assert.equal(f.store.dailyQuota().occupied, 3);
    assert.ok(f.store.applications().every((application) =>
      application.status === "needs-review" &&
      application.actions[0].state === "unknown" &&
      application.actions.slice(1).every((action) => action.state === "pending")));

    const continued = await f.workbench("/api/bulk-workflow/control", { action: "resume" });
    assert.equal(continued.statusCode, 200, continued.body);
    await waitFor(f.state, (run) => run.counts.planned === 4, "人工继续后启动第四个岗位");
    assert.equal((await child()).consecutiveJobFailures, 0);
    const fourth = await f.claim();
    await f.result(fourth, "page-unrecognized");
    const completed = await waitFor(f.state, (run) => run.state === "completed", "第四个岗位单次失败保留核验并收尾");
    assert.equal((await child()).consecutiveJobFailures, 1);
    assert.equal(completed.counts.review, 4);
  } finally { await f.close(); }
});

test("跨子批次失败期间有完整成功，后续连续失败从零重新累计", async () => {
  const f = await fixture();
  const child = async () => (await f.workbench("/api/bulk-application")).json().run;
  try {
    f.addJob("跨批成功重置第一公司");
    await f.start({ target: 4 });
    for (let index = 0; index < 4; index++) {
      const task = await f.claim();
      assert.ok(task);
      if (index < 3) f.addJob(`跨批成功重置下一公司${index}`);
      if (index === 1) {
        assert.equal((await child()).consecutiveJobFailures, 1);
        for (const actionIndex of [0, 1, 2]) {
          await f.action(task, actionIndex, "started", "before-action");
          await f.authorize(task, actionIndex);
          await f.action(task, actionIndex, "confirmed", actionIndex === 0 ? "new-conversation" : "new-message");
        }
        await f.result(task);
      } else await f.result(task, "recipient-mismatch");
      if (index < 3) {
        await waitFor(f.state, (run) => run.counts.planned === index + 2, "下一子批次继承更新的失败计数");
        assert.equal((await child()).consecutiveJobFailures, index === 1 ? 0 : 1);
      }
    }
    const completed = await waitFor(f.state, (run) => run.state === "completed", "中途成功后其余两次失败不触发三连败");
    assert.equal(completed.counts.completed, 1);
    assert.equal(completed.counts.review, 3);
    assert.equal((await child()).consecutiveJobFailures, 2);
  } finally { await f.close(); }
});

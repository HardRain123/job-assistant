import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/api/src/app.ts";
import { Store, shanghaiDate } from "../packages/storage/src/index.ts";
import {
  DEFAULT_POLICY,
  type Application,
  type Assessment,
  type Job,
  type Resume,
} from "../packages/contracts/src/index.ts";
import { fingerprint } from "../packages/templates/src/index.ts";

const config = { dailyLimit: 150, target: 150, intervalSeconds: 30 };
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bulk-apply-"));
  const store = new Store(join(dir, "db.sqlite"));
  const resume: Resume = {
    id: randomUUID(),
    name: "示例候选人",
    text: "Java AI 研发",
    skills: ["Java"],
    years: 7,
    attachmentName: null,
    createdAt: new Date().toISOString(),
  };
  const policy = {
    ...DEFAULT_POLICY,
    excludedCompanies: ["禁止公司"],
    excludedIndustries: ["保险"],
  };
  store.set("resume", resume);
  store.set("policy", policy);
  // Bulk must ignore the deferred attachment policy without changing it globally.
  store.set("template", {
    id: "default",
    version: 1,
    name: "话术",
    segments: ["您好，申请{{title}}", "目前状态：离职"],
    attachmentPolicy: "send-after-messages",
  });
  const addJob = (
    company: string,
    decision: Assessment["decision"] | null = "eligible",
    fields: Partial<Job> = {},
  ) => {
    const id = randomUUID();
    const now = new Date().toISOString();
    const job = store.upsertJob({
      id,
      source: "boss",
      sourceId: "extension",
      sourceJobId: id,
      url: `https://www.zhipin.com/job_detail/${id}.html`,
      company,
      companyAliases: [],
      industry: "软件",
      title: "AI开发工程师",
      location: "上海",
      remote: false,
      salaryMin: 22000,
      salaryMax: 30000,
      salaryMonths: 12,
      experienceMin: 3,
      description: "Java AI 研发",
      skills: ["Java"],
      education: null,
      firstSeen: now,
      lastSeen: now,
      contentHash: "pending",
      status: "active",
      ...fields,
    });
    if (decision)
      store.set(
        "assessment:" +
          fingerprint({ job: job.contentHash, resume, policy, providers: [] }),
        {
          jobId: id,
          resumeId: resume.id,
          policyVersion: policy.version,
          score: 95,
          decision,
          gates: [{ field: "location", status: "pass", reason: "ok" }],
          dimensions: {},
          reasons: [],
          provider: null,
          model: null,
          createdAt: now,
        } satisfies Assessment,
      );
    return job;
  };
  const app = await createApp({
    store,
    password: "password",
    key: "key",
    internalToken: "internal",
    dataDir: dir,
    attachmentsDir: join(dir, "attachments"),
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { password: "password" },
  });
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  const workbench = (url: string, payload?: any) =>
    app.inject({
      method: payload === undefined ? "GET" : "POST",
      url,
      headers: { cookie },
      ...(payload === undefined ? {} : { payload }),
    });
  const code = (await workbench("/api/extension/pair-code", {})).json().code;
  const origin = `chrome-extension://${"a".repeat(32)}`;
  const token = (
    await app.inject({
      method: "POST",
      url: "/extension/v1/pair",
      headers: { origin },
      payload: { code },
    })
  ).json().token;
  const extension = (url: string, payload: any = {}, version = "0.4.0") =>
    app.inject({
      method: "POST",
      url,
      headers: {
        origin,
        authorization: `Bearer ${token}`,
        "x-extension-version": version,
      },
      payload,
    });
  await extension("/extension/v1/status");
  const preview = async (custom = config) => {
    const result = await workbench("/api/bulk-application/preview", custom);
    assert.equal(result.statusCode, 200, result.body);
    return result.json();
  };
  const start = async (custom = config) => {
    const p = await preview(custom);
    const result = await workbench("/api/bulk-application/start", {
      previewId: p.previewId,
    });
    assert.equal(result.statusCode, 200, result.body);
    return result.json().run;
  };
  const claim = async () =>
    (await extension("/extension/v1/application/claim")).json().task;
  const action = async (
    task: any,
    index: number,
    state: string,
    evidence: string,
  ) =>
    extension("/extension/v1/application/action", {
      taskId: task.id,
      leaseToken: task.leaseToken,
      applicationId: task.application.id,
      actionId: task.application.actions[index].id,
      state,
      evidence,
    });
  const result = (task: any, reason?: string) =>
    extension("/extension/v1/application/result", {
      taskId: task.id,
      leaseToken: task.leaseToken,
      applicationId: task.application.id,
      ...(reason ? { reason } : {}),
    });
  let servicesClosed = false;
  const closeServices = async () => {
    if (servicesClosed) return;
    await app.close();
    store.close();
    servicesClosed = true;
  };
  return {
    dir,
    closeServices,
    app,
    store,
    addJob,
    workbench,
    extension,
    preview,
    start,
    claim,
    action,
    result,
    close: async () => {
      await closeServices();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("bulk preview selects only eligible fresh gates, deduplicates companies and reports shortage without attachments", async () => {
  const f = await fixture();
  try {
    f.addJob("甲公司有限公司");
    f.addJob("甲公司");
    f.addJob("乙公司", "review");
    f.addJob("丙公司", null);
    f.addJob("禁止公司集团");
    f.addJob("保险示例", "eligible", { industry: "保险" });
    const p = await f.preview();
    assert.deepEqual(p.summary, {
      eligible: 1,
      selected: 1,
      shortfall: 149,
      unassessed: 1,
      review: 1,
      excluded: 2,
      duplicates: 1,
    });
    assert.equal(p.applications[0].resumeAttachment, null);
    assert.deepEqual(
      p.applications[0].actions.map((a: any) => a.kind),
      ["native-greeting", "message", "message"],
    );
    assert.equal(
      f.store.get<any>("template", {}).attachmentPolicy,
      "send-after-messages",
    );
    const oversized = await f.workbench("/api/bulk-application/preview", {
      ...config,
      target: 151,
    });
    assert.equal(oversized.statusCode, 400);
  } finally {
    await f.close();
  }
});

test("bulk start freezes configuration and job content and enqueues atomically once with fresh extension", async () => {
  const f = await fixture();
  try {
    const job = f.addJob("甲公司");
    f.addJob("乙公司");
    const p = await f.preview();
    await f.extension("/extension/v1/status", {}, "0.3.7");
    assert.equal(
      (
        await f.workbench("/api/bulk-application/start", {
          previewId: p.previewId,
        })
      ).statusCode,
      400,
    );
    await f.extension("/extension/v1/status");
    f.store.upsertJob({ ...job, description: "变化" });
    assert.equal(
      (
        await f.workbench("/api/bulk-application/start", {
          previewId: p.previewId,
        })
      ).statusCode,
      400,
    );
    assert.equal(f.store.applications().length, 0);
    const run = await f.start();
    assert.equal(run.counts.queued, 1);
    assert.equal(
      (
        await f.workbench("/api/bulk-application/start", {
          previewId: p.previewId,
        })
      ).statusCode,
      400,
    );
    const task = await f.claim();
    assert.ok(task.application.bulkRunId);
    assert.equal(await f.claim(), null);
  } finally {
    await f.close();
  }
});

test("existing contact skips all custom messages, consumes no quota, and preserves serial interval", async () => {
  const f = await fixture();
  try {
    f.addJob("甲公司");
    f.addJob("乙公司");
    await f.start();
    const task = await f.claim();
    assert.equal(
      (await f.action(task, 0, "skipped", "existing-contact")).statusCode,
      200,
    );
    assert.equal((await f.result(task, "existing-contact")).statusCode, 200);
    const state = (await f.workbench("/api/bulk-application")).json();
    assert.equal(state.today.occupied, 0);
    assert.equal(state.run.counts.skipped, 1);
    assert.equal(state.run.counts.queued, 1);
    assert.equal(await f.claim(), null);
    assert.ok(
      f.store
        .application(task.application.id)!
        .actions.slice(1)
        .every((a) => a.state === "pending"),
    );
  } finally {
    await f.close();
  }
});

test("unknown native attempt occupies daily quota once and pauses remaining batch without replay", async () => {
  const f = await fixture();
  try {
    f.addJob("甲公司");
    f.addJob("乙公司");
    await f.start();
    const task = await f.claim();
    assert.equal(
      (await f.action(task, 0, "started", "before-action")).statusCode,
      200,
    );
    const duplicate = await f.action(task, 0, "started", "before-action");
    assert.equal(duplicate.json().execute, false);
    await f.action(task, 0, "unknown", "send-unconfirmed");
    await f.result(task, "send-unconfirmed");
    const state = (await f.workbench("/api/bulk-application")).json();
    assert.equal(state.today.occupied, 1);
    assert.equal(state.today.uncertain, 1);
    assert.equal(state.today.contacts, 0);
    assert.equal(state.run.state, "paused");
    assert.equal(await f.claim(), null);
    assert.equal(
      (await f.workbench("/api/bulk-application/control", { action: "resume" }))
        .statusCode,
      200,
    );
    assert.equal(
      f.store.application(task.application.id)!.status,
      "needs-review",
    );
    await f.workbench("/api/bulk-application/control", { action: "cancel" });
    assert.equal(
      f.store.applications().filter((a) => a.status === "cancelled").length,
      1,
    );
    assert.equal(
      f.store.application(task.application.id)!.actions[0]!.state,
      "unknown",
    );
  } finally {
    await f.close();
  }
});

test("new conversation and complete message delivery are counted separately and result callbacks are idempotent", async () => {
  const f = await fixture();
  try {
    f.addJob("甲公司");
    await f.start();
    const task = await f.claim();
    await f.action(task, 0, "started", "before-action");
    assert.equal(
      (await f.action(task, 0, "confirmed", "new-conversation")).statusCode,
      200,
    );
    assert.equal(f.store.dailyQuota().contacts, 1);
    assert.equal(f.store.dailyQuota().completed, 0);
    for (let i = 1; i < 3; i++) {
      await f.action(task, i, "started", "before-action");
      await f.action(task, i, "confirmed", "new-message");
    }
    const first = await f.result(task);
    const repeat = await f.result(task);
    assert.equal(first.body, repeat.body);
    const state = (await f.workbench("/api/bulk-application")).json();
    assert.equal(state.run.state, "completed");
    assert.equal(state.today.completed, 1);
    assert.equal(state.today.occupied, 1);
  } finally {
    await f.close();
  }
});

test("pause blocks current authorization; cancellation retains all started actions", async () => {
  const f = await fixture();
  try {
    f.addJob("甲公司");
    await f.start();
    const task = await f.claim();
    await f.action(task, 0, "started", "before-action");
    await f.workbench("/api/bulk-application/control", { action: "pause" });
    const permit = await f.extension("/extension/v1/application/authorize", {
      taskId: task.id,
      leaseToken: task.leaseToken,
      applicationId: task.application.id,
      actionId: task.application.actions[0].id,
    });
    assert.equal(permit.statusCode, 400);
    await f.result(task, "cancelled");
    assert.equal(
      f.store.application(task.application.id)!.actions[0]!.state,
      "unknown",
    );
    assert.equal(f.store.dailyQuota().occupied, 1);
  } finally {
    await f.close();
  }
});

test("a contact slot consumed by another single task blocks bulk before the irreversible action", async () => {
  const f = await fixture();
  try {
    f.addJob("甲公司");
    await f.start({ ...config, target: 1, dailyLimit: 1 });
    const task = await f.claim();
    const application = {
      ...task.application,
      id: randomUUID(),
      jobId: randomUUID(),
      bulkRunId: undefined,
      status: "needs-review",
      actions: [
        {
          ...task.application.actions[0],
          id: randomUUID(),
          state: "unknown",
          evidence: "send-unconfirmed",
          updatedAt: new Date().toISOString(),
        },
      ],
    } as Application;
    f.store.insertApplication(application);
    const attempt = await f.action(task, 0, "started", "before-action");
    assert.equal(attempt.statusCode, 400);
    assert.match(attempt.body, /daily-limit/);
    assert.equal(
      f.store.application(task.application.id)!.actions[0]!.state,
      "pending",
    );
    assert.equal(f.store.dailyQuota().occupied, 1);
    assert.equal(
      (await f.workbench("/api/bulk-application")).json().run.state,
      "paused",
    );
  } finally {
    await f.close();
  }
});

test("unknown custom message appears in uncertain statistics and explicit resume only advances untouched jobs", async () => {
  const f = await fixture();
  try {
    f.addJob("甲公司");
    f.addJob("乙公司");
    await f.start();
    const task = await f.claim();
    await f.action(task, 0, "started", "before-action");
    await f.action(task, 0, "confirmed", "new-conversation");
    await f.action(task, 1, "started", "before-action");
    await f.action(task, 1, "unknown", "send-unconfirmed");
    await f.result(task, "send-unconfirmed");
    assert.equal(f.store.dailyQuota().uncertain, 1);
    assert.equal(f.store.dailyQuota().contacts, 1);
    await f.workbench("/api/bulk-application/control", { action: "resume" });
    const run = f.store.get<any>("bulk.current", null);
    run.nextRunAt = new Date(0).toISOString();
    f.store.set("bulk.current", run);
    const next = await f.claim();
    assert.notEqual(next.application.id, task.application.id);
    assert.ok(
      next.application.actions.every((a: any) => a.state === "pending"),
    );
    assert.equal(
      f.store.application(task.application.id)!.actions[1]!.state,
      "unknown",
    );
  } finally {
    await f.close();
  }
});

test("bulk rechecks the score before each action and collection cannot overlap queued application work", async () => {
  const f = await fixture();
  try {
    const job = f.addJob("甲公司");
    await f.start();
    const task = await f.claim();
    const collect = await f.workbench("/api/automation/start", {
      inspectJobId: job.id,
    });
    assert.equal(collect.statusCode, 400);
    assert.match(collect.body, /投递任务/);
    f.store.db
      .prepare("DELETE FROM settings WHERE key LIKE 'assessment:%'")
      .run();
    assert.equal(
      (await f.action(task, 0, "started", "before-action")).statusCode,
      400,
    );
    assert.equal(f.store.dailyQuota().occupied, 0);
  } finally {
    await f.close();
  }
});

test("Shanghai quota rollover and persisted historical single applications share the configured limit", () => {
  const store = new Store(":memory:");
  try {
    assert.equal(shanghaiDate(new Date("2026-10-11T15:59:59Z")), "2026-10-11");
    assert.equal(shanghaiDate(new Date("2026-10-11T16:00:00Z")), "2026-10-12");
    const application = {
      id: randomUUID(),
      jobId: "job",
      batchId: "batch",
      status: "needs-review",
      actions: [
        {
          id: randomUUID(),
          kind: "native-greeting",
          index: 0,
          text: null,
          state: "unknown",
          evidence: "send-unconfirmed",
          updatedAt: "2026-10-11T15:59:59Z",
        },
      ],
    } as Application;
    store.insertApplication(application);
    assert.equal(
      store.dailyQuota(new Date("2026-10-11T15:59:59Z"), 1).remaining,
      0,
    );
    assert.equal(
      store.dailyQuota(new Date("2026-10-11T16:00:00Z"), 1).remaining,
      1,
    );
    assert.equal(
      store.dailyQuota(new Date("2026-10-11T15:59:59Z"), 1).occupied,
      1,
    );
  } finally {
    store.close();
  }
});

test("cancelled untouched jobs can enter a fresh preview while their frozen drafts and tasks remain audited", async () => {
  const f = await fixture();
  try {
    f.addJob("可重新选择公司");
    await f.start();
    const old = f.store.applications()[0]!;
    await f.workbench("/api/bulk-application/control", { action: "cancel" });
    assert.equal((await f.preview()).summary.selected, 1);
    await f.start();
    const next = f.store.applications()[0]!;
    assert.notEqual(next.id, old.id);
    assert.equal(f.store.application(old.id), undefined);
    assert.equal(f.store.tasks().length, 2);
    const audit = f.store.db
      .prepare(
        "SELECT body FROM audit WHERE event='application.unattemptedCancelledArchived'",
      )
      .get();
    assert.equal(JSON.parse(String(audit?.body)).application.id, old.id);
    assert.ok(next.actions.every((a) => a.state === "pending"));
    assert.equal(f.store.dailyQuota().occupied, 0);
  } finally {
    await f.close();
  }
});

test("a low-score excluded job remains excluded even when public fields also need verification", async () => {
  const f = await fixture();
  try {
    f.addJob("低分示例公司", "skip", { industry: null });
    const preview = await f.preview();
    assert.equal(preview.summary.excluded, 1);
    assert.equal(preview.summary.review, 0);
    assert.equal(preview.applications.length, 0);
  } finally { await f.close(); }
});

test("reopening SQLite retains quota and queue, and expired in-flight work pauses the batch without replay", async () => {
  const f = await fixture();
  let reopened: Store | undefined;
  let secondApp: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    f.addJob("重启公司甲");
    f.addJob("重启公司乙");
    const run = await f.start();
    const task = await f.claim();
    await f.action(task, 0, "started", "before-action");
    f.store.db
      .prepare("UPDATE tasks SET lease_until=? WHERE id=?")
      .run(new Date(0).toISOString(), task.id);
    await f.closeServices();
    reopened = new Store(join(f.dir, "db.sqlite"));
    secondApp = await createApp({
      store: reopened,
      password: "password",
      key: "key",
      internalToken: "internal",
      dataDir: f.dir,
      attachmentsDir: join(f.dir, "attachments"),
    });
    const login = await secondApp.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "password" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const state = (
      await secondApp.inject({
        method: "GET",
        url: "/api/bulk-application",
        headers: { cookie },
      })
    ).json();
    assert.equal(state.run.id, run.id);
    assert.equal(state.run.state, "paused");
    assert.equal(state.run.counts.queued, 1);
    assert.equal(state.run.counts.review, 1);
    assert.equal(state.today.occupied, 1);
    assert.equal(
      reopened.application(task.application.id)!.actions[0]!.state,
      "unknown",
    );
    assert.equal(
      reopened.tasks().find((t) => t.id === task.id)!.status,
      "needs-review",
    );
    assert.equal(reopened.dailyQuota().occupied, 1);
  } finally {
    await secondApp?.close();
    reopened?.close();
    await f.close();
  }
});

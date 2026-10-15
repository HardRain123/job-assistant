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
type BulkConfig = typeof config & { continueOnJobFailure?: boolean };
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
  const extension = (url: string, payload: any = {}, version = "0.4.2") =>
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
  const preview = async (custom: BulkConfig = config) => {
    const result = await workbench("/api/bulk-application/preview", custom);
    assert.equal(result.statusCode, 200, result.body);
    return result.json();
  };
  const start = async (custom: BulkConfig = config) => {
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
    await f.extension("/extension/v1/status", {}, "0.4.1");
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

test("cancelling a pre-action failed draft releases it for a new configuration without releasing attempted sends", async () => {
  for (const began of [false, true]) {
    const f = await fixture();
    try {
      f.addJob("配置变更示例公司");
      await f.start();
      const task = await f.claim();
      if (began) await f.action(task, 0, "started", "before-action");
      const result = await f.extension("/extension/v1/application/result", {
        taskId: task.id,
        leaseToken: task.leaseToken,
        applicationId: task.application.id,
        reason: "send-unconfirmed",
      });
      assert.equal(result.statusCode, 200, result.body);
      const cancelled = await f.workbench("/api/bulk-application/control", {
        action: "cancel",
      });
      assert.equal(cancelled.statusCode, 200, cancelled.body);
      assert.equal(
        f.store.application(task.application.id)?.status,
        began ? "needs-review" : "cancelled",
      );
      assert.equal((await f.preview()).summary.selected, began ? 0 : 1);
      assert.equal(
        f.store.tasks().find((old) => old.id === task.id)?.status,
        "needs-review",
      );
      assert.equal(f.store.dailyQuota().occupied, began ? 1 : 0);
    } finally {
      await f.close();
    }
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
  } finally {
    await f.close();
  }
});

test("an existing eligible assessment cannot bypass an explicitly excluded insurance project", async () => {
  const f = await fixture();
  try {
    const job = f.addJob("软件公司", "eligible", {
      industry: "计算机软件",
      description: "AgentScope 保险全栈-智能体Agent开发工程师",
    });
    const state = (await f.workbench("/api/state")).json();
    const assessed = state.jobs.find(
      (current: any) => current.id === job.id,
    ).assessment;
    assert.equal(assessed.decision, "skip");
    assert.ok(
      assessed.gates.some(
        (gate: any) => gate.field === "industry" && gate.status === "fail",
      ),
    );
    assert.equal((await f.preview()).summary.selected, 0);
  } finally {
    await f.close();
  }
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

const removeInterval = (store: Store) => {
  const run = store.get<any>("bulk.current", null);
  run.nextRunAt = new Date(0).toISOString();
  store.set("bulk.current", run);
};

test("opt-in local failure isolation retains unknown actions, quota and deduplication while advancing untouched jobs", async () => {
  const f = await fixture();
  try {
    f.addJob("隔离甲公司");
    f.addJob("隔离乙公司");
    await f.start({ ...config, continueOnJobFailure: true });
    const first = await f.claim();
    await f.action(first, 0, "started", "before-action");
    await f.action(first, 0, "unknown", "send-unconfirmed");
    const result = await f.result(first, "send-unconfirmed");
    assert.equal(result.statusCode, 200, result.body);
    const state = (await f.workbench("/api/bulk-application")).json();
    assert.equal(state.run.state, "running");
    assert.equal(state.run.continueOnJobFailure, true);
    assert.equal(state.run.consecutiveJobFailures, 1);
    assert.equal(state.run.isolatedReviewCount, 1);
    assert.equal(state.run.counts.review, 1);
    assert.equal(state.today.occupied, 1);
    assert.equal(state.today.uncertain, 1);
    assert.equal("isolatedReviewIds" in state.run, false);
    assert.equal("processedResults" in state.run, false);
    assert.equal(await f.claim(), null, "serial interval remains in force");
    removeInterval(f.store);
    const second = await f.claim();
    assert.notEqual(second.application.id, first.application.id);
    assert.ok(
      second.application.actions.every((a: any) => a.state === "pending"),
    );
    const retained = f.store.application(first.application.id)!;
    assert.equal(retained.status, "needs-review");
    assert.equal(retained.actions[0]!.state, "unknown");
    assert.ok(retained.actions.slice(1).every((a) => a.state === "pending"));
    assert.equal((await f.preview()).summary.selected, 0);
    const repeated = await f.result(first, "send-unconfirmed");
    assert.equal(repeated.body, result.body);
    assert.equal(
      (await f.workbench("/api/bulk-application")).json().run
        .consecutiveJobFailures,
      1,
    );
  } finally {
    await f.close();
  }
});

test("three consecutive isolated job failures pause the entire batch and explicit resume resets the streak", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 4; i++) f.addJob(`连续失败公司${i}`);
    await f.start({ ...config, continueOnJobFailure: true });
    for (let i = 0; i < 3; i++) {
      const task = await f.claim();
      assert.ok(task);
      await f.action(task, 0, "started", "before-action");
      await f.action(task, 0, "unknown", "send-unconfirmed");
      await f.result(task, "send-unconfirmed");
      await f.result(task, "send-unconfirmed");
      const run = (await f.workbench("/api/bulk-application")).json().run;
      assert.equal(run.consecutiveJobFailures, i + 1);
      assert.equal(run.state, i === 2 ? "paused" : "running");
      removeInterval(f.store);
    }
    const state = (await f.workbench("/api/bulk-application")).json();
    assert.equal(state.run.counts.queued, 1);
    assert.equal(state.run.counts.review, 3);
    assert.equal(state.today.occupied, 3);
    assert.match(state.run.message, /连续 3 个岗位/);
    assert.equal(await f.claim(), null);
    const resumed = await f.workbench("/api/bulk-application/control", {
      action: "resume",
    });
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.json().run.consecutiveJobFailures, 0);
    assert.ok(
      (await f.claim()).application.actions.every(
        (a: any) => a.state === "pending",
      ),
    );
  } finally {
    await f.close();
  }
});

test("a confirmed complete application resets local failure streak without hiding prior reviews", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 4; i++) f.addJob(`成功重置公司${i}`);
    await f.start({ ...config, continueOnJobFailure: true });
    const first = await f.claim();
    await f.result(first, "recipient-mismatch");
    removeInterval(f.store);
    const second = await f.claim();
    for (let i = 0; i < 3; i++) {
      await f.action(second, i, "started", "before-action");
      await f.action(
        second,
        i,
        "confirmed",
        i === 0 ? "new-conversation" : "new-message",
      );
    }
    await f.result(second);
    assert.equal(
      (await f.workbench("/api/bulk-application")).json().run
        .consecutiveJobFailures,
      0,
    );
    removeInterval(f.store);
    const third = await f.claim();
    await f.result(third, "page-unrecognized");
    // A replayed older success cannot reset a more recent failure streak.
    await f.result(second);
    const run = (await f.workbench("/api/bulk-application")).json().run;
    assert.equal(run.state, "running");
    assert.equal(run.consecutiveJobFailures, 1);
    assert.equal(run.counts.review, 2);
    assert.equal(run.counts.completed, 1);
  } finally {
    await f.close();
  }
});

test("account-wide and ambiguous errors still pause an opted-in batch", async () => {
  for (const reason of [
    "login-required",
    "verification-required",
    "platform-limit",
    "daily-limit",
    "cancelled",
    undefined,
  ]) {
    const f = await fixture();
    try {
      f.addJob("全局错误甲");
      f.addJob("全局错误乙");
      await f.start({ ...config, continueOnJobFailure: true });
      const task = await f.claim();
      await f.action(task, 0, "started", "before-action");
      const result = await f.result(task, reason);
      assert.equal(result.statusCode, 200, result.body);
      const run = (await f.workbench("/api/bulk-application")).json().run;
      assert.equal(run.state, "paused", reason);
      assert.equal(run.isolatedReviewCount, 0);
      assert.equal(
        f.store.application(task.application.id)!.actions[0]!.state,
        "unknown",
      );
      assert.equal(await f.claim(), null);
    } finally {
      await f.close();
    }
  }
});

test("local-looking errors cannot bypass changed configuration, eligibility or global browser ownership", async () => {
  for (const blocked of [
    "config",
    "eligibility",
    "paused",
    "takeover",
    "browserUncertain",
  ]) {
    const f = await fixture();
    try {
      f.addJob("资格变化甲");
      f.addJob("资格变化乙");
      await f.start({ ...config, continueOnJobFailure: true });
      const task = await f.claim();
      if (blocked === "config") {
        const template = f.store.get<any>("template", null);
        template.version++;
        f.store.set("template", template);
      } else if (blocked === "eligibility") {
        f.store.db
          .prepare("DELETE FROM settings WHERE key LIKE 'assessment:%'")
          .run();
      } else f.store.set(blocked, true);
      const result = await f.result(task, "page-unrecognized");
      assert.equal(result.statusCode, 200, result.body);
      const run = (await f.workbench("/api/bulk-application")).json().run;
      assert.equal(run.state, "paused", blocked);
      assert.equal(run.isolatedReviewCount, 0);
      assert.equal(await f.claim(), null);
    } finally {
      await f.close();
    }
  }
});

test("persisted isolated reviews survive restart, but an unexplained expired lease still pauses the batch", async () => {
  const f = await fixture();
  let reopened: Store | undefined;
  let secondApp: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    for (let i = 0; i < 3; i++) f.addJob(`隔离重启公司${i}`);
    const run = await f.start({ ...config, continueOnJobFailure: true });
    const first = await f.claim();
    await f.action(first, 0, "started", "before-action");
    await f.result(first, "send-unconfirmed");
    removeInterval(f.store);
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
    const state = async () =>
      (
        await secondApp!.inject({
          method: "GET",
          url: "/api/bulk-application",
          headers: { cookie },
        })
      ).json();
    assert.equal((await state()).run.id, run.id);
    assert.equal((await state()).run.state, "running");
    assert.equal((await state()).run.consecutiveJobFailures, 1);
    assert.equal((await state()).run.isolatedReviewCount, 1);
    assert.equal(
      reopened.application(first.application.id)!.actions[0]!.state,
      "unknown",
    );
    const next = reopened.claim("extension")!;
    const nextApplication = reopened.application(
      (next.payload as Application).id,
    )!;
    assert.notEqual(nextApplication.id, first.application.id);
    nextApplication.actions[0]!.state = "started";
    reopened.updateApplication(nextApplication);
    reopened.db
      .prepare("UPDATE tasks SET lease_until=? WHERE id=?")
      .run(new Date(0).toISOString(), next.id);
    const expired = await state();
    assert.equal(expired.run.state, "paused");
    assert.equal(expired.run.counts.review, 2);
    assert.equal(expired.run.isolatedReviewCount, 1);
    assert.equal(expired.run.consecutiveJobFailures, 1);
    assert.equal(
      reopened.application(nextApplication.id)!.actions[0]!.state,
      "unknown",
    );
  } finally {
    await secondApp?.close();
    reopened?.close();
    await f.close();
  }
});

test("an earlier isolation never authorizes a changed outcome on the same application", async () => {
  const f = await fixture();
  try {
    f.addJob("隔离后接续甲");
    f.addJob("隔离后接续乙");
    await f.start({ ...config, continueOnJobFailure: true });
    const task = await f.claim();
    await f.result(task, "page-unrecognized");
    assert.equal(
      (await f.workbench("/api/bulk-application")).json().run.state,
      "running",
    );
    // A later manually resumed execution can expire without a new result callback.
    // Its unknown outcome must be reviewed even though this application was isolated before.
    const changed = f.store.application(task.application.id)!;
    delete changed.stopReason;
    changed.actions[0]!.state = "unknown";
    changed.actions[0]!.updatedAt = new Date().toISOString();
    f.store.updateApplication(changed);
    const state = (await f.workbench("/api/bulk-application")).json();
    assert.equal(state.run.state, "paused");
    assert.equal(state.run.isolatedReviewCount, 0);
    assert.equal(state.run.counts.review, 1);
    assert.equal(state.run.counts.queued, 1);
    assert.equal(await f.claim(), null);
  } finally {
    await f.close();
  }
});

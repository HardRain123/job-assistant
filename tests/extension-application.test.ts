import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/api/src/app.ts";
import {
  Store,
  actionCompleteForExistingContact,
  shanghaiDate,
} from "../packages/storage/src/index.ts";
import {
  DEFAULT_POLICY,
  type Assessment,
  type Job,
  type Resume,
} from "../packages/contracts/src/index.ts";
import { fingerprint } from "../packages/templates/src/index.ts";

const origin = `chrome-extension://${"a".repeat(32)}`;
test("a wholly unattempted generic failure can requeue inside its paused bulk, but never replay a begun action", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture("eligible", undefined, "0.4.5");
  try {
    const preview = (
      await f.workbench("/api/bulk-application/preview", {
        dailyLimit: 150,
        target: 1,
        intervalSeconds: 30,
      })
    ).json();
    const started = await f.workbench("/api/bulk-application/start", {
      previewId: preview.previewId,
    });
    assert.equal(started.statusCode, 200, started.body);
    const task = (await f.extension("/extension/v1/application/claim")).json()
      .task;
    const identity = {
      taskId: task.id,
      leaseToken: task.leaseToken,
      applicationId: task.application.id,
    };
    const result = await f.extension("/extension/v1/application/result", {
      ...identity,
      reason: "send-unconfirmed",
    });
    assert.equal(result.statusCode, 200, result.body);
    const beforeTasks = f.store.tasks().length;
    const retry = await f.workbench("/api/extension-application/retry", {
      applicationId: identity.applicationId,
    });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(f.store.tasks().length, beforeTasks + 1);
    assert.equal(
      f.store.tasks().find((t) => t.id === task.id)?.status,
      "needs-review",
    );
    assert.equal(f.store.get<any>("bulk.current", null).state, "paused");
    assert.equal(
      (await f.extension("/extension/v1/application/claim")).json().task,
      null,
    );
    const resumed = await f.workbench("/api/bulk-application/control", {
      action: "resume",
    });
    assert.equal(resumed.statusCode, 200, resumed.body);
    t.mock.timers.tick(31_000); // Respect the configured interval before another claim.
    const next = (await f.extension("/extension/v1/application/claim")).json()
      .task;
    assert.ok(next);
    const nextIdentity = {
      taskId: next.id,
      leaseToken: next.leaseToken,
      applicationId: identity.applicationId,
    };
    const begun = await f.extension("/extension/v1/application/action", {
      ...nextIdentity,
      actionId: next.application.actions[0].id,
      state: "started",
      evidence: "before-action",
    });
    assert.equal(begun.statusCode, 200, begun.body);
    await f.extension("/extension/v1/application/result", {
      ...nextIdentity,
      reason: "send-unconfirmed",
    });
    assert.equal(
      (
        await f.workbench("/api/extension-application/retry", {
          applicationId: identity.applicationId,
        })
      ).statusCode,
      400,
    );
    const rejected = await f.extension("/extension/v1/application/authorize", {
      ...nextIdentity,
      actionId: next.application.actions[0].id,
    });
    assert.equal(rejected.statusCode, 400);
    const audit = f.store.db
      .prepare(
        "SELECT body FROM audit WHERE event='extensionApplication.requestRejected' ORDER BY id DESC LIMIT 1",
      )
      .get()!;
    const body = JSON.parse(String(audit.body));
    assert.equal(body.applicationId, identity.applicationId);
    assert.equal(body.operation, "authorize");
    assert.equal(body.code, "任务租约无效，需要人工核对");
    assert.equal(String(audit.body).includes(next.leaseToken), false);
  } finally {
    await f.close();
  }
});
test("only an entirely unsent layout failure can retry, retaining the original task receipt", async () => {
  const f = await fixture("eligible");
  try {
    const selection = { ...f.selection, acceptReview: false };
    const preview = (
      await f.workbench("/api/extension-application/preview", selection)
    ).json();
    await f.workbench("/api/extension-application/start", {
      ...selection,
      expectedConfigurationKey: preview.configurationKey,
    });
    const task = (await f.extension("/extension/v1/application/claim")).json()
      .task;
    const identity = {
      taskId: task.id,
      leaseToken: task.leaseToken,
      applicationId: task.application.id,
    };
    const diagnostic = {
      stage: "detail-entry",
      controlCount: 1,
      knownControlCount: 1,
      titleCount: 1,
      tags: ["div"],
    };
    assert.equal(
      (
        await f.extension("/extension/v1/application/result", {
          ...identity,
          reason: "page-unrecognized",
          diagnostic,
        })
      ).statusCode,
      200,
    );
    const savedDiagnostic = f.store.application(
      identity.applicationId,
    )?.pageDiagnostic;
    assert.equal(savedDiagnostic?.stage, "detail-entry");
    if (savedDiagnostic?.stage === "detail-entry")
      assert.equal(savedDiagnostic.controlCount, 1);
    assert.equal(
      (
        await f.workbench("/api/extension-application/retry", {
          applicationId: identity.applicationId,
        })
      ).statusCode,
      200,
    );
    assert.equal(f.store.tasks().length, 2);
    assert.equal(
      f.store.tasks().find((old) => old.id === task.id)?.status,
      "needs-review",
    );
    const next = (await f.extension("/extension/v1/application/claim")).json()
      .task;
    const nextIdentity = {
      ...identity,
      taskId: next.id,
      leaseToken: next.leaseToken,
    };
    await f.extension("/extension/v1/application/action", {
      ...nextIdentity,
      actionId: next.application.actions[0].id,
      state: "started",
      evidence: "before-action",
    });
    await f.extension("/extension/v1/application/result", {
      ...nextIdentity,
      reason: "page-unrecognized",
      diagnostic: {
        stage: "conversation",
        editorCount: 1,
        activeJobCardCount: 0,
        exactJobLinkCount: 0,
        employerFieldMatchCount: 0,
      },
    });
    assert.equal(
      f.store.application(identity.applicationId)?.pageDiagnostic?.stage,
      "conversation",
    );
    assert.equal(
      (
        await f.workbench("/api/extension-application/retry", {
          applicationId: identity.applicationId,
        })
      ).statusCode,
      400,
    );
  } finally {
    await f.close();
  }
});
test("bounded conversation probes persist with idempotent receipts and never authorize pending actions", async () => {
  const f = await fixture("eligible");
  try {
    const selection = { ...f.selection, acceptReview: false };
    const preview = (
      await f.workbench("/api/extension-application/preview", selection)
    ).json();
    await f.workbench("/api/extension-application/start", {
      ...selection,
      expectedConfigurationKey: preview.configurationKey,
    });
    const task = (await f.extension("/extension/v1/application/claim")).json()
      .task;
    const identity = {
      taskId: task.id,
      leaseToken: task.leaseToken,
      applicationId: task.application.id,
    };
    const probe = {
      depth: 0,
      result: "view-control",
      viewControlCount: 0,
      viewTextCount: 1,
      titleMatchCount: 0,
      cityMatchCount: 0,
      salaryMatchCount: 0,
      employerMatchCount: 0,
      recruiterCount: 0,
    };
    const diagnostic = {
      stage: "conversation",
      editorCount: 1,
      activeJobCardCount: 0,
      exactJobLinkCount: 0,
      employerFieldMatchCount: 0,
      probes: [probe],
    };
    const countFields = [
      "viewControlCount",
      "viewTextCount",
      "titleMatchCount",
      "cityMatchCount",
      "salaryMatchCount",
      "employerMatchCount",
      "recruiterCount",
    ];
    const invalid = [
      [{ ...probe, html: "private content" }],
      [{ ...probe, result: "private content" }],
      [{ ...probe, depth: 12 }],
      [{ ...probe, depth: -1 }],
      [{ ...probe, depth: 0.5 }],
      Array.from({ length: 13 }, () => probe),
      ...countFields.flatMap((key) => [
        [{ ...probe, [key]: 21 }],
        [{ ...probe, [key]: -1 }],
        [{ ...probe, [key]: 0.5 }],
      ]),
    ];
    for (const probes of invalid) {
      assert.equal(
        (
          await f.extension("/extension/v1/application/result", {
            ...identity,
            reason: "recipient-mismatch",
            diagnostic: { ...diagnostic, probes },
          })
        ).statusCode,
        400,
      );
    }
    assert.equal(
      f.store.application(identity.applicationId)?.pageDiagnostic,
      undefined,
    );
    const actionsBefore = f.store.application(identity.applicationId)!.actions;
    const payload = {
      ...identity,
      reason: "recipient-mismatch",
      diagnostic: {
        ...diagnostic,
        probes: Array.from({ length: 12 }, (_, depth) => ({
          ...probe,
          depth,
          result: "matched",
          viewTextCount: 20,
        })),
      },
    };
    const response = await f.extension(
      "/extension/v1/application/result",
      payload,
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "needs-review");
    assert.deepEqual(
      f.store.application(identity.applicationId)!.actions,
      actionsBefore,
    );
    assert.ok(actionsBefore.every((action) => action.state === "pending"));
    const reopened = new Store(join(f.attachmentsDir, "..", "db.sqlite"));
    try {
      assert.deepEqual(
        reopened.application(identity.applicationId)?.pageDiagnostic,
        payload.diagnostic,
      );
    } finally {
      reopened.close();
    }
    assert.equal(
      (await f.extension("/extension/v1/application/result", payload))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await f.extension("/extension/v1/application/result", {
          ...payload,
          diagnostic,
        })
      ).statusCode,
      400,
    );
  } finally {
    await f.close();
  }
});
async function fixture(
  decision: Assessment["decision"] = "review",
  gates: Assessment["gates"] = [
    { field: "location", status: "pass", reason: "ok" },
  ],
  extensionVersion = "0.3.4",
) {
  const dir = mkdtempSync(join(tmpdir(), "extension-apply-"));
  const attachmentsDir = join(dir, "attachments");
  mkdirSync(attachmentsDir);
  const store = new Store(join(dir, "db.sqlite"));
  const id = randomUUID();
  const job = store.upsertJob({
    id,
    source: "boss",
    sourceId: "extension",
    sourceJobId: id,
    url: `https://www.zhipin.com/job_detail/${id}.html`,
    company: "示例公司",
    companyAliases: [],
    industry: "软件",
    title: "研发工程师",
    location: "上海",
    remote: false,
    salaryMin: 22000,
    salaryMax: 30000,
    salaryMonths: 12,
    experienceMin: 3,
    description: "Java 研发",
    skills: ["Java"],
    education: null,
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    contentHash: "pending",
    status: "active",
  } satisfies Job);
  const attachmentName = `${randomUUID()}.pdf`;
  writeFileSync(join(attachmentsDir, attachmentName), "%PDF-1.4 fixture");
  const resume: Resume = {
    id: randomUUID(),
    name: "候选人",
    text: "Java 研发经历",
    skills: ["Java"],
    years: 5,
    attachmentName,
    createdAt: new Date().toISOString(),
  };
  store.set("resume", resume);
  store.set("template", {
    id: "default",
    version: 2,
    name: "申请",
    segments: ["您好，我申请{{title}}"],
    attachmentPolicy: "send-after-messages",
  });
  store.set(
    "assessment:" +
      fingerprint({
        job: job.contentHash,
        resume,
        policy: DEFAULT_POLICY,
        providers: [],
      }),
    {
      jobId: id,
      resumeId: resume.id,
      policyVersion: DEFAULT_POLICY.version,
      score: 83,
      decision,
      gates,
      dimensions: {},
      reasons: [],
      provider: null,
      model: null,
      createdAt: new Date().toISOString(),
    } satisfies Assessment,
  );
  const app = await createApp({
    store,
    password: "password",
    key: "key",
    internalToken: "internal",
    dataDir: dir,
    attachmentsDir,
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { password: "password" },
  });
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  const code = (
    await app.inject({
      method: "POST",
      url: "/api/extension/pair-code",
      headers: { cookie },
    })
  ).json().code;
  const token = (
    await app.inject({
      method: "POST",
      url: "/extension/v1/pair",
      headers: { origin },
      payload: { code },
    })
  ).json().token;
  const extHeaders = {
    origin,
    authorization: `Bearer ${token}`,
    "x-extension-version": extensionVersion,
  };
  await app.inject({
    method: "POST",
    url: "/extension/v1/status",
    headers: extHeaders,
  });
  const workbench = (url: string, payload: any) =>
    app.inject({ method: "POST", url, headers: { cookie }, payload });
  const readWorkbench = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
  const extension = (url: string, payload: any = {}) =>
    app.inject({ method: "POST", url, headers: extHeaders, payload });
  const selection = {
    jobId: id,
    expectedContentHash: job.contentHash,
    acceptReview: true,
  };
  return {
    app,
    store,
    job,
    attachmentName,
    attachmentsDir,
    workbench,
    readWorkbench,
    extension,
    selection,
    close: async () => {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function stageExistingContact(f: Awaited<ReturnType<typeof fixture>>, completedBulk = false) {
  const selection = { ...f.selection, acceptReview: false };
  if (completedBulk) {
    const preview = (await f.workbench("/api/bulk-application/preview", {
      target: 1, dailyLimit: 100, intervalSeconds: 30, continueOnJobFailure: true,
    })).json();
    const started = await f.workbench("/api/bulk-application/start", { previewId: preview.previewId });
    assert.equal(started.statusCode, 200, started.body);
  } else {
    const preview = (
      await f.workbench("/api/extension-application/preview", selection)
    ).json();
    await f.workbench("/api/extension-application/start", {
      ...selection,
      expectedConfigurationKey: preview.configurationKey,
    });
  }
  const task = (await f.extension("/extension/v1/application/claim")).json()
    .task;
  const identity = {
    taskId: task.id,
    leaseToken: task.leaseToken,
    applicationId: task.application.id,
  };
  const native = task.application.actions[0];
  assert.equal(
    (
      await f.extension("/extension/v1/application/action", {
        ...identity,
        actionId: native.id,
        state: "started",
        evidence: "before-action",
      })
    ).json().execute,
    true,
  );
  assert.equal(
    (
      await f.extension("/extension/v1/application/action", {
        ...identity,
        actionId: native.id,
        state: "unknown",
        evidence: "send-unconfirmed",
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await f.extension("/extension/v1/application/result", {
        ...identity,
        reason: "send-unconfirmed",
      })
    ).json().status,
    "needs-review",
  );
  const inspectionRunId = randomUUID();
  const inspectedJob = f.store.job(f.job.id)!;
  const run = {
    id: inspectionRunId,
    state: "completed",
    phase: "done",
    inspectionJobId: f.job.id,
    updatedAt: new Date().toISOString(),
    config: { maxJobs: 1, maxPages: 1, autoAssess: false },
    discovered: 1,
    visited: 1,
    imported: 1,
    seenUrls: [],
    jobIds: [f.job.id],
    fieldReadings: [
      {
        url: inspectedJob.url,
        evidence: {
          title: inspectedJob.title,
          company: inspectedJob.company,
          descriptionPresent: true,
          headerLines: ["感兴趣 继续沟通"],
        },
      },
    ],
  };
  f.store.set("automation.current", run);
  return { identity, native, run, inspectionRunId };
}

async function stageUncertainMessage(
  f: Awaited<ReturnType<typeof fixture>>,
  receiptDiagnostic?: Record<string, unknown>,
) {
  const template = f.store.get<any>("template", null);
  f.store.set("template", {
    ...template,
    segments: [...template.segments, "到岗时间：一周"],
  });
  const staged = await stageExistingContact(f);
  const resumed = await f.workbench(
    "/api/extension-application/resume-existing-contact",
    {
      applicationId: staged.identity.applicationId,
      inspectionRunId: staged.inspectionRunId,
    },
  );
  assert.equal(resumed.statusCode, 200, resumed.body);
  const task = (await f.extension("/extension/v1/application/claim")).json()
    .task;
  const identity = {
    taskId: task.id,
    leaseToken: task.leaseToken,
    applicationId: task.application.id,
  };
  const action = task.application.actions[1];
  for (const [state, evidence] of [
    ["started", "before-action"],
    ["unknown", "send-unconfirmed"],
  ]) {
    const response = await f.extension("/extension/v1/application/action", {
      ...identity,
      actionId: action.id,
      state,
      evidence,
    });
    assert.equal(response.statusCode, 200, response.body);
  }
  const diagnostic = receiptDiagnostic ?? {
    stage: "conversation",
    editorCount: 1,
    activeJobCardCount: 1,
    exactJobLinkCount: 1,
    employerFieldMatchCount: 1,
  };
  assert.equal(
    (
      await f.extension("/extension/v1/application/result", {
        ...identity,
        reason: "send-unconfirmed",
        diagnostic,
      })
    ).json().status,
    "needs-review",
  );
  const run = {
    ...staged.run,
    id: randomUUID(),
    updatedAt: new Date().toISOString(),
  };
  f.store.set("automation.current", run);
  const request = {
    applicationId: identity.applicationId,
    actionId: action.id,
    expectedTextHash: createHash("sha256").update(action.text).digest("hex"),
    inspectionRunId: run.id,
  };
  return { identity, action, run, request, diagnostic };
}

function ownBatch(f: Awaited<ReturnType<typeof fixture>>, applicationId: string,
  state: "running" | "paused" | "completed" | "cancelled" = "completed", day = shanghaiDate()) {
  const application = f.store.application(applicationId)!;
  let bulk = f.store.get<any>("bulk.current", null);
  if (!application.bulkRunId) {
    application.bulkRunId = randomUUID();
    f.store.updateApplication(application);
    bulk = {
      id: application.bulkRunId, state: "paused", target: 1, dailyLimit: 100, intervalSeconds: 30,
      configurationKey: f.store.get(`extensionApplication.configuration:${application.id}`, null),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), message: "test",
      counts: { queued: 0, running: 0, completed: 0, review: 1, skipped: 0, cancelled: 0 },
    };
    f.store.set("bulk.current", bulk);
  }
  const owner = {
    id: randomUUID(), state, phase: state === "running" || state === "paused" ? "sending" : "done",
    config: { target: 10, dailyLimit: 100, intervalSeconds: 30, keywords: ["Java"], city: "上海",
      maxJobsPerRound: 50, maxPages: 2, maxRounds: 5 }, target: 10,
    message: "test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    rounds: 1, noGrowthRounds: 0, consecutiveJobFailures: 0, budgetUsed: 1,
    counts: { planned: 1, completed: 0, review: 1, skipped: 0, queued: 0 },
    configurationKey: fingerprint({ application: bulk.configurationKey, providers: [],
      embedding: { enabled: false, baseUrl: "https://api.openai.com/v1", model: "" } }),
    shanghaiDay: day, manualPaused: state === "paused",
    childBulkId: bulk.id, childAutomationId: null, childTotals: [], currentPreviewId: null,
    currentAutomationImported: 0, keywordIndex: 0,
  };
  f.store.set("bulkWorkflow.current", owner);
  return owner;
}

async function stageAutomaticPrefix(f: Awaited<ReturnType<typeof fixture>>, uncertainIndex: 1 | 2, finished: boolean) {
  f.store.set("template", { ...f.store.get<any>("template", null),
    segments: ["您好，我申请{{title}}", "到岗时间：一周"], attachmentPolicy: "message-only" });
  const preview = (await f.workbench("/api/bulk-application/preview", {
    target: 1, dailyLimit: 1, intervalSeconds: 30, continueOnJobFailure: finished,
  })).json();
  const started = await f.workbench("/api/bulk-application/start", { previewId: preview.previewId });
  assert.equal(started.statusCode, 200, started.body);
  const task = (await f.extension("/extension/v1/application/claim")).json().task;
  assert.ok(task);
  const identity = { taskId: task.id, leaseToken: task.leaseToken, applicationId: task.application.id };
  for (const action of task.application.actions.slice(0, uncertainIndex + 1)) {
    const begin = await f.extension("/extension/v1/application/action", {
      ...identity, actionId: action.id, state: "started", evidence: "before-action",
    });
    assert.equal(begin.json().execute, true, begin.body);
    const receipt = await f.extension("/extension/v1/application/action", {
      ...identity, actionId: action.id,
      state: action.index === uncertainIndex ? "unknown" : "confirmed",
      evidence: action.index === uncertainIndex ? "send-unconfirmed" : action.index === 0 ? "new-conversation" : "new-message",
    });
    assert.equal(receipt.statusCode, 200, receipt.body);
  }
  const outcome = await f.extension("/extension/v1/application/result", { ...identity, reason: "send-unconfirmed" });
  assert.equal(outcome.json().status, "needs-review", outcome.body);
  const inspectionRunId = randomUUID();
  f.store.set("automation.current", {
    id: inspectionRunId, state: "completed", phase: "done", inspectionJobId: f.job.id,
    updatedAt: new Date().toISOString(), config: { maxJobs: 1, maxPages: 1, autoAssess: false },
    discovered: 1, visited: 1, imported: 1, seenUrls: [], jobIds: [f.job.id],
    fieldReadings: [{ url: f.job.url, evidence: { title: f.job.title, company: f.job.company,
      descriptionPresent: true, headerLines: ["感兴趣 继续沟通"] } }],
  });
  const source = structuredClone(f.store.application(identity.applicationId)!);
  const action = source.actions[uncertainIndex]!;
  return { source, request: { applicationId: source.id, actionId: action.id, inspectionRunId,
    expectedTextHash: createHash("sha256").update(action.text!).digest("hex") } };
}

test("automatic receipts can precede an uncertain message: reconcile only untouched work even at zero quota", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  for (const finished of [false, true]) for (const uncertainIndex of [1, 2] as const) {
    const f = await fixture("eligible", undefined, "0.4.14");
    try {
      const { source, request } = await stageAutomaticPrefix(f, uncertainIndex, finished);
      assert.equal(f.store.dailyQuota(new Date(), 1).remaining, 0);
      const owner = ownBatch(f, source.id, finished ? "completed" : "paused");
      const taskCount = f.store.tasks().length;
      let recoveryPreviewId: string | undefined;
      if (finished) {
        const blocked = await f.workbench("/api/extension-application/confirm-message-and-resume", request);
        assert.equal(blocked.statusCode, 400);
        const preview = await f.workbench("/api/extension-application/recovery-preview", {
          applicationId: source.id, actionId: request.actionId,
        });
        assert.equal(preview.statusCode, 200, preview.body);
        assert.deepEqual(preview.json().messages, source.frozenMessages.slice(uncertainIndex));
        recoveryPreviewId = preview.json().recoveryPreviewId;
      }
      const response = await f.workbench("/api/extension-application/confirm-message-and-resume",
        { ...request, ...(recoveryPreviewId ? { recoveryPreviewId } : {}) });
      assert.equal(response.statusCode, 200, response.body);
      const saved = f.store.application(source.id)!;
      assert.deepEqual(saved.actions.slice(0, uncertainIndex), source.actions.slice(0, uncertainIndex));
      assert.equal(saved.actions[uncertainIndex]!.state, "unknown");
      assert.equal(saved.actions[uncertainIndex]!.evidence, "send-unconfirmed");
      assert.equal(saved.actions[uncertainIndex]!.resolution, "user-confirmed-sent");
      assert.equal(f.store.dailyQuota(new Date(), 1).occupied, 1);
      if (finished) {
        assert.notEqual(saved.bulkRunId, source.bulkRunId);
        assert.deepEqual(f.store.get<any>("bulkWorkflow.current", null).recoveryApplications, [source]);
        assert.equal(f.store.get<any>("bulkWorkflow.current", null).id, owner.id);
      }
      if (uncertainIndex === 2) {
        assert.equal(saved.status, "completed");
        assert.equal(f.store.tasks().length, taskCount);
        assert.equal(f.store.get<any>("bulk.current", null).state, "completed");
        assert.equal((await f.extension("/extension/v1/application/claim")).json().task, null);
      } else {
        if (!finished) {
          const resume = await f.workbench("/api/bulk-workflow/control", { action: "resume" });
          assert.equal(resume.statusCode, 200, resume.body);
          t.mock.timers.tick(31_000);
        }
        const claimed = await f.extension("/extension/v1/application/claim");
        const task = claimed.json().task;
        assert.ok(task, claimed.body);
        assert.deepEqual(task.application.actions.map((item: any) => item.index), [0, 2]);
        assert.equal(task.application.actions[0].state, "confirmed");
        const identity = { taskId: task.id, leaseToken: task.leaseToken, applicationId: saved.id };
        assert.equal((await f.extension("/extension/v1/application/authorize", {
          ...identity, actionId: source.actions[0]!.id,
        })).json().allowed, true);
        assert.equal((await f.extension("/extension/v1/application/action", {
          ...identity, actionId: source.actions[0]!.id, state: "started", evidence: "before-action",
        })).statusCode, 400, "confirmed greeting cannot be sent again");
        const remaining = source.actions[2]!;
        assert.equal((await f.extension("/extension/v1/application/action", {
          ...identity, actionId: remaining.id, state: "started", evidence: "before-action",
        })).json().execute, true);
        await f.extension("/extension/v1/application/action", {
          ...identity, actionId: remaining.id, state: "confirmed", evidence: "new-message",
        });
        assert.equal((await f.extension("/extension/v1/application/result", identity)).json().status, "completed");
      }
      assert.equal((await f.workbench("/api/extension-application/confirm-message-and-resume",
        { ...request, ...(recoveryPreviewId ? { recoveryPreviewId } : {}) })).statusCode, 400);
    } finally { await f.close(); }
  }
});

test("at zero quota a queued new contact cannot block a reconciled message behind it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture("eligible", undefined, "0.4.14");
  try {
    const { source, request } = await stageAutomaticPrefix(f, 1, false);
    const otherId = randomUUID();
    const otherJob = f.store.upsertJob({ ...source.job, id: otherId, sourceJobId: otherId,
      url: `https://www.zhipin.com/job_detail/${otherId}.html` });
    const unattempted = { ...structuredClone(source), id: randomUUID(), job: otherJob, jobId: otherJob.id, status: "queued" as const };
    delete unattempted.stopReason;
    unattempted.actions = unattempted.actions.map((action) => ({ ...action, id: randomUUID(), state: "pending", evidence: null }));
    f.store.insertApplication(unattempted);
    f.store.enqueue("apply", unattempted);
    f.store.set(`extensionApplication.configuration:${unattempted.id}`,
      f.store.get(`extensionApplication.configuration:${source.id}`, null));
    const reconciled = await f.workbench("/api/extension-application/confirm-message-and-resume", request);
    assert.equal(reconciled.statusCode, 200, reconciled.body);
    const resumed = await f.workbench("/api/bulk-application/control", { action: "resume" });
    assert.equal(resumed.statusCode, 200, resumed.body);
    t.mock.timers.tick(31_000);
    const claimed = await f.extension("/extension/v1/application/claim");
    assert.equal(claimed.json().task?.application.id, source.id, claimed.body);
    assert.equal(f.store.application(unattempted.id)!.actions[0]!.state, "pending");
    assert.equal(f.store.dailyQuota(new Date(), 1).occupied, 1);
    assert.equal((await f.extension("/extension/v1/application/claim")).json().task, null, "only one lease is allowed");
  } finally { await f.close(); }
});

test("paused workflow inspection and reconciliation allow only queued siblings, never live sends or unrelated work", async () => {
  for (const scenario of ["paused", "running", "unrelated", "leased", "wrong-job"] as const) {
    const f = await fixture("eligible", undefined, "0.4.14");
    try {
      const { source, request } = await stageAutomaticPrefix(f, 1, false);
      const owner = ownBatch(f, source.id, scenario === "running" ? "running" : "paused");
      const otherId = randomUUID();
      const otherJob = f.store.upsertJob({ ...source.job, id: otherId, sourceJobId: otherId,
        url: `https://www.zhipin.com/job_detail/${otherId}.html` });
      const sibling = { ...structuredClone(source), id: randomUUID(), jobId: otherId, job: otherJob,
        status: "queued" as const, ...(scenario === "unrelated" ? { bulkRunId: randomUUID() } : {}) };
      delete sibling.stopReason;
      sibling.actions = sibling.actions.map((action) => ({ ...action, id: randomUUID(), state: "pending", evidence: null }));
      f.store.insertApplication(sibling);
      f.store.enqueue("apply", sibling);
      if (scenario === "leased") assert.ok(f.store.claim("extension"));
      if (scenario === "running") f.store.set("bulk.current", { ...f.store.get<any>("bulk.current", null), state: "running" });
      const beforeTasks = f.store.tasks();
      const beforeInspection = f.store.get<any>("automation.current", null);
      const response = await f.workbench("/api/automation/start", { inspectJobId: scenario === "wrong-job" ? otherId : source.jobId });
      if (scenario === "paused") {
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(f.store.get<any>("bulkWorkflow.current", null).state, "paused");
        assert.equal(f.store.get<any>("bulk.current", null).state, "paused");
        const command = (await f.extension("/extension/v1/claim")).json().command;
        assert.equal(command.kind, "detail");
        assert.equal(command.url, source.job.url);
        assert.deepEqual(f.store.tasks(), beforeTasks);
        assert.equal((await f.extension("/extension/v1/application/claim")).json().task, null);
        assert.equal((await f.workbench("/api/bulk-workflow/control", { action: "resume" })).statusCode, 400);
        const stopped = await f.workbench("/api/automation/control", { action: "cancel" });
        assert.equal(stopped.statusCode, 200, stopped.body);
        f.store.set("automation.current", beforeInspection);
        const reconciled = await f.workbench("/api/extension-application/confirm-message-and-resume", request);
        assert.equal(reconciled.statusCode, 200, reconciled.body);
        assert.equal(f.store.application(sibling.id)!.actions[0]!.state, "pending");
        assert.equal(f.store.get<any>("bulkWorkflow.current", null).id, owner.id);
      } else {
        assert.equal(response.statusCode, 400, scenario + response.body);
        assert.deepEqual(f.store.get("automation.current", null), beforeInspection);
        assert.deepEqual(f.store.tasks(), beforeTasks);
        if (scenario !== "wrong-job") {
          const reconciled = await f.workbench("/api/extension-application/confirm-message-and-resume", request);
          assert.equal(reconciled.statusCode, 400, scenario + reconciled.body);
          assert.equal(f.store.application(source.id)!.actions[1]!.resolution, undefined);
        }
      }
    } finally { await f.close(); }
  }
});

test("partial message recovery previews are bound to the action, unchanged record, and fresh contact inspection", async () => {
  for (const scenario of ["expired", "changed-record", "wrong-action", "no-contact", "missing-manual-audit"] as const) {
    const f = await fixture("eligible", undefined, "0.4.14");
    try {
      const { source, request } = await stageAutomaticPrefix(f, 2, true);
      const preview = await f.workbench("/api/extension-application/recovery-preview", {
        applicationId: source.id, actionId: request.actionId,
      });
      assert.equal(preview.statusCode, 200, preview.body);
      const recoveryPreviewId = preview.json().recoveryPreviewId;
      if (scenario === "expired") {
        const key = `extensionApplication.recoveryPreview:${recoveryPreviewId}`;
        f.store.set(key, { ...f.store.get<any>(key, null), expiresAt: new Date(Date.now() - 1000).toISOString() });
      }
      if (scenario === "changed-record") {
        source.pageDiagnostic = { stage: "chat-ready", code: "loading", stableChecks: 0 };
        f.store.updateApplication(source);
      }
      if (scenario === "wrong-action") request.actionId = source.actions[1]!.id;
      if (scenario === "no-contact") {
        const run = f.store.get<any>("automation.current", null);
        run.fieldReadings[0].evidence.headerLines = ["立即沟通"];
        f.store.set("automation.current", run);
      }
      if (scenario === "missing-manual-audit") {
        Object.assign(source.actions[1]!, { state: "unknown", evidence: "send-unconfirmed", resolution: "user-confirmed-sent" });
        f.store.updateApplication(source);
        const invalid = await f.workbench("/api/extension-application/recovery-preview", {
          applicationId: source.id, actionId: request.actionId,
        });
        assert.equal(invalid.statusCode, 400, invalid.body);
      }
      const before = f.store.application(source.id);
      const tasks = f.store.tasks();
      const result = await f.workbench("/api/extension-application/confirm-message-and-resume", { ...request, recoveryPreviewId });
      assert.equal(result.statusCode, 400, scenario + ": " + result.body);
      assert.deepEqual(f.store.application(source.id), before);
      assert.deepEqual(f.store.tasks(), tasks);
    } finally { await f.close(); }
  }
});

test("all reconciliation entrances reject a terminal, replaced or previous-day workflow before queueing", async () => {
  for (const route of ["retry", "resume-existing-contact", "confirm-message-and-resume"] as const) {
    for (const ownerCase of ["completed", "cancelled", "previous-day", "replaced"] as const) {
      const f = await fixture("eligible", undefined, "0.4.13");
      try {
        const staged = route === "confirm-message-and-resume" ? await stageUncertainMessage(f) : await stageExistingContact(f);
        const application = f.store.application(staged.identity.applicationId)!;
        if (route === "retry") {
          for (const action of application.actions) {
            action.state = "pending";
            action.evidence = null;
            delete action.resolution;
          }
          f.store.updateApplication(application);
        }
        const owner = ownBatch(f, application.id,
          ownerCase === "completed" || ownerCase === "cancelled" ? ownerCase : "paused",
          ownerCase === "previous-day" ? shanghaiDate(new Date(Date.now() - 86400000)) : shanghaiDate());
        if (ownerCase === "replaced") {
          f.store.set(`bulkWorkflow.history:${owner.id}`, { ...owner, state: "completed" });
          f.store.set("bulkWorkflow.current", { ...owner, id: randomUUID(), childBulkId: randomUUID() });
        }
        const before = structuredClone(f.store.application(application.id));
        const beforeTasks = f.store.tasks();
        const request = route === "confirm-message-and-resume" ? (staged as Awaited<ReturnType<typeof stageUncertainMessage>>).request :
          { applicationId: application.id, ...(route === "resume-existing-contact" ? { inspectionRunId: staged.run.id } : {}) };
        const response = await f.workbench(`/api/extension-application/${route}`, request);
        assert.equal(response.statusCode, 400, route + " " + ownerCase + " " + response.body);
        assert.deepEqual(f.store.application(application.id), before);
        assert.deepEqual(f.store.tasks(), beforeTasks);
      } finally { await f.close(); }
    }
  }
});

test("a live paused workflow can reconcile its contact and explicitly resume without replaying greeting", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture("eligible", undefined, "0.4.13");
  try {
    const staged = await stageExistingContact(f);
    ownBatch(f, staged.identity.applicationId, "paused");
    const response = await f.workbench("/api/extension-application/resume-existing-contact", {
      applicationId: staged.identity.applicationId, inspectionRunId: staged.run.id,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await f.extension("/extension/v1/application/claim")).json().task, null);
    const resumed = await f.workbench("/api/bulk-workflow/control", { action: "resume" });
    assert.equal(resumed.statusCode, 200, resumed.body);
    t.mock.timers.tick(31000);
    const task = (await f.extension("/extension/v1/application/claim")).json().task;
    assert.ok(task);
    assert.equal(task.application.actions[0].state, "unknown");
    assert.equal(task.application.actions[0].resolution, "contact-exists");
  } finally { await f.close(); }
});

test("completed contact recovery explicitly adopts the same actions into one new batch and preserves historical counts", async () => {
  for (const ownerState of ["completed", "cancelled"] as const) {
    const f = await fixture("eligible", undefined, "0.4.13");
    try {
      const staged = await stageExistingContact(f, true);
      const source = structuredClone(f.store.application(staged.identity.applicationId)!);
      const old = f.store.get<any>("bulk.current", null);
      assert.equal(old.state, "completed");
      const owner = ownBatch(f, source.id, ownerState, shanghaiDate(new Date(Date.now() - 86400000)));
      const sibling = { ...structuredClone(source), id: randomUUID(), jobId: randomUUID() };
      sibling.actions = sibling.actions.map((action) => ({ ...action, id: randomUUID() }));
      f.store.insertApplication(sibling);
      f.store.set("bulk.current", { ...old, target: 2, counts: { ...old.counts, review: 2 } });
      f.store.set("bulkWorkflow.current", { ...owner, counts: { ...owner.counts, planned: 2, review: 2 } });
      const quotaBefore = f.store.dailyQuota();
      const tasksBefore = f.store.tasks().length;
      const unchanged = await f.workbench("/api/extension-application/resume-existing-contact", {
        applicationId: source.id, inspectionRunId: staged.inspectionRunId,
      });
      assert.equal(unchanged.statusCode, 400);
      assert.deepEqual(f.store.application(source.id), source);
      assert.equal(f.store.tasks().length, tasksBefore);
      const previewResponse = await f.workbench("/api/extension-application/recovery-preview", { applicationId: source.id });
      assert.equal(previewResponse.statusCode, 200, previewResponse.body);
      const preview = previewResponse.json();
      assert.equal(preview.dailyLimit, 100);
      assert.equal(preview.previousBulkRunId, old.id);
      assert.deepEqual(preview.messages, source.frozenMessages);
      assert.deepEqual(f.store.application(source.id), source);
      assert.equal(f.store.tasks().length, tasksBefore);
      const request = { applicationId: source.id, inspectionRunId: staged.inspectionRunId,
        recoveryPreviewId: preview.recoveryPreviewId };
      const response = await f.workbench("/api/extension-application/resume-existing-contact", request);
      assert.equal(response.statusCode, 200, response.body);
      const recovered = f.store.application(source.id)!;
      assert.equal(recovered.id, source.id);
      assert.notEqual(recovered.bulkRunId, old.id);
      assert.equal(recovered.bulkRunId, response.json().bulkRunId);
      assert.deepEqual(recovered.actions.slice(1), source.actions.slice(1));
      assert.deepEqual(recovered.actions[0], { ...source.actions[0], resolution: "contact-exists" });
      assert.equal(f.store.get<any>("bulk.current", null).target, 1);
      assert.equal(f.store.get<any>("bulk.current", null).intervalSeconds, 30);
      assert.equal(f.store.get<any>(`bulk.history:${old.id}`, null).counts.review, 2);
      assert.equal(f.store.get<any>("bulkWorkflow.current", null).state, ownerState);
      assert.deepEqual(f.store.get<any>("bulkWorkflow.current", null).recoveryApplications, [source]);
      const audit = f.store.db.prepare("SELECT body FROM audit WHERE event='bulk.existingContactRecoveryStarted'").get();
      assert.deepEqual(JSON.parse(String(audit!.body)).application, source);
      assert.equal(f.store.tasks().length, tasksBefore + 1);
      assert.equal((await f.workbench("/api/extension-application/resume-existing-contact", request)).statusCode, 400);
      assert.equal(f.store.tasks().length, tasksBefore + 1);
      assert.equal(f.store.dailyQuota().occupied, quotaBefore.occupied);
      let history = (await f.readWorkbench("/api/bulk-workflow")).json().run;
      assert.equal(history.counts.review, 2);
      sibling.status = "completed";
      f.store.updateApplication(sibling);
      history = (await f.readWorkbench("/api/bulk-workflow")).json().run;
      assert.equal(history.counts.completed, 1);
      assert.equal(history.counts.review, 1);
      const task = (await f.extension("/extension/v1/application/claim")).json().task;
      assert.ok(task, "restored application must be claimable");
      const identity = { taskId: task.id, leaseToken: task.leaseToken, applicationId: recovered.id };
      assert.equal((await f.extension("/extension/v1/application/action", { ...identity,
        actionId: source.actions[0]!.id, state: "started", evidence: "before-action" })).statusCode, 400);
      assert.equal((await f.extension("/extension/v1/application/authorize", { ...identity,
        actionId: source.actions[0]!.id })).json().allowed, true);
      assert.equal((await f.extension("/extension/v1/application/action", { ...identity,
        actionId: source.actions[1]!.id, state: "started", evidence: "before-action" })).json().execute, true);
      assert.equal(f.store.dailyQuota().occupied, quotaBefore.occupied);
    } finally { await f.close(); }
  }
});

test("bounded receipt diagnostics persist without confirming or disclosing messages", async () => {
  const f = await fixture("eligible");
  try {
    const diagnostic = {
      stage: "message-receipt",
      beforeCount: 2,
      afterCount: 3,
      messageRowCount: 5,
      matchingCount: 1,
      newMatchingCount: 1,
      acknowledgedCount: 0,
      failedCount: 0,
      editorEmpty: true,
    };
    const staged = await stageUncertainMessage(f, diagnostic);
    const saved = f.store.application(staged.identity.applicationId)!;
    assert.deepEqual(saved.pageDiagnostic, diagnostic);
    assert.equal(saved.actions[1]!.state, "unknown");
    assert.equal(saved.actions[2]!.state, "pending");
    for (const invalid of [
      { ...diagnostic, text: "private chat" },
      { ...diagnostic, afterCount: 1001 },
      { ...diagnostic, newMatchingCount: -1 },
      { ...diagnostic, editorEmpty: "true" },
    ]) {
      const response = await f.extension("/extension/v1/application/result", {
        ...staged.identity,
        reason: "send-unconfirmed",
        diagnostic: invalid,
      });
      assert.equal(response.statusCode, 400);
    }
  } finally {
    await f.close();
  }
});

test("chat readiness diagnostics accept only fixed codes and bounded counts", async () => {
  const f = await fixture("eligible");
  try {
    const diagnostic = {
      stage: "chat-ready",
      code: "connecting",
      stableChecks: 0,
    };
    const staged = await stageUncertainMessage(f, diagnostic);
    assert.deepEqual(
      f.store.application(staged.identity.applicationId)!.pageDiagnostic,
      diagnostic,
    );
    for (const invalid of [
      { ...diagnostic, code: "private page text" },
      { ...diagnostic, stableChecks: 21 },
      { ...diagnostic, html: "private DOM" },
    ]) {
      const response = await f.extension("/extension/v1/application/result", {
        ...staged.identity,
        reason: "send-unconfirmed",
        diagnostic: invalid,
      });
      assert.equal(response.statusCode, 400);
    }
  } finally {
    await f.close();
  }
});

test("a paused bulk message can be reconciled without unpausing or resending it", async () => {
  const f = await fixture("eligible", undefined, "0.4.4");
  try {
    const staged = await stageUncertainMessage(f);
    const application = f.store.application(staged.identity.applicationId)!;
    const runId = randomUUID();
    application.bulkRunId = runId;
    f.store.updateApplication(application);
    f.store.set("bulk.current", {
      id: runId,
      state: "paused",
      target: 2,
      dailyLimit: 150,
      intervalSeconds: 30,
      configurationKey: f.store.get(
        `extensionApplication.configuration:${application.id}`,
        null,
      ),
      message: "等待核对",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      counts: {
        queued: 0,
        running: 0,
        completed: 0,
        review: 1,
        skipped: 0,
        cancelled: 0,
      },
    });
    const response = await f.workbench(
      "/api/extension-application/confirm-message-and-resume",
      staged.request,
    );
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(f.store.get<any>("bulk.current", null).state, "paused");
    const saved = f.store.application(application.id)!;
    assert.equal(saved.status, "queued");
    assert.equal(saved.actions[1]!.state, "unknown");
    assert.equal(saved.actions[1]!.resolution, "user-confirmed-sent");
    assert.equal(
      (await f.extension("/extension/v1/application/claim")).json().task,
      null,
    );
    const resume = await f.workbench("/api/bulk-application/control", {
      action: "resume",
    });
    assert.equal(resume.statusCode, 200, resume.body);
    const task = (await f.extension("/extension/v1/application/claim")).json()
      .task;
    assert.ok(task);
    assert.ok(
      !task.application.actions.some(
        (item: any) => item.id === staged.action.id,
      ),
    );
    const identity = {
      taskId: task.id,
      leaseToken: task.leaseToken,
      applicationId: application.id,
    };
    assert.equal(
      (
        await f.extension("/extension/v1/application/authorize", {
          ...identity,
          actionId: staged.action.id,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.extension("/extension/v1/application/action", {
          ...identity,
          actionId: saved.actions[2]!.id,
          state: "started",
          evidence: "before-action",
        })
      ).json().execute,
      true,
    );
  } finally {
    await f.close();
  }
});

async function stageUpdatedTemplate(f: Awaited<ReturnType<typeof fixture>>) {
  f.store.set("template", {
    ...f.store.get<any>("template", null),
    attachmentPolicy: "message-only",
  });
  const staged = await stageUncertainMessage(f);
  const application = f.store.application(staged.identity.applicationId)!;
  application.bulkRunId = randomUUID();
  // Bulk drafts deliberately omit the attachment even when a resume file exists.
  application.resumeAttachment = null;
  f.store.set(`extensionApplication.attachment:${application.id}`, null);
  f.store.updateApplication(application);
  f.store.set("bulk.current", {
    id: application.bulkRunId,
    state: "paused",
    target: 1,
    dailyLimit: 150,
    intervalSeconds: 30,
    configurationKey: f.store.get(
      `extensionApplication.configuration:${application.id}`,
      null,
    ),
    message: "等待核对",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    counts: {
      queued: 0,
      running: 0,
      completed: 0,
      review: 1,
      skipped: 0,
      cancelled: 0,
    },
  });
  const previous = f.store.get<any>("template", null);
  f.store.set(`template:${previous.version}`, previous);
  const next = {
    ...previous,
    version: previous.version + 1,
    attachmentPolicy: "send-after-messages",
    segments: [previous.segments[0], "到岗时间：拿到 offer 后一周"],
  };
  f.store.set(`template:${next.version}`, next);
  f.store.set("template", next);
  const preview = (
    await f.workbench("/api/template/preview", { jobId: application.jobId })
  ).json();
  const request = {
    ...staged.request,
    updatedTemplate: {
      version: preview.templateVersion,
      expectedConfigurationKey: preview.configurationKey,
      expectedMessages: preview.messages,
    },
  };
  return { ...staged, application, request, preview };
}

test("reviewed latest template replaces only pending text in a single paused batch, never adds attachments", async () => {
  const f = await fixture("eligible", undefined, "0.4.4");
  try {
    const staged = await stageUpdatedTemplate(f);
    const url = "/api/extension-application/confirm-message-and-resume";
    const { updatedTemplate, ...withoutReview } = staged.request;
    assert.equal((await f.workbench(url, withoutReview)).statusCode, 400);
    const result = await f.workbench(url, staged.request);
    assert.equal(result.statusCode, 200, result.body);
    const saved = f.store.application(staged.application.id)!;
    assert.equal(saved.actions.length, 3);
    assert.deepEqual(saved.actions[0], staged.application.actions[0]);
    assert.equal(saved.actions[1]!.text, staged.application.actions[1]!.text);
    assert.equal(saved.actions[1]!.resolution, "user-confirmed-sent");
    assert.equal(saved.actions[2]!.text, "到岗时间：拿到 offer 后一周");
    assert.equal(saved.actions[2]!.state, "pending");
    assert.equal(saved.attachmentPolicy, "message-only");
    assert.equal(saved.resumeAttachment, null);
    assert.equal(f.store.get<any>("bulk.current", null).state, "paused");
    assert.equal(
      (await f.extension("/extension/v1/application/claim")).json().task,
      null,
    );
    assert.equal(
      (await f.workbench("/api/bulk-application/control", { action: "resume" }))
        .statusCode,
      200,
    );
    const task = (await f.extension("/extension/v1/application/claim")).json()
      .task;
    assert.ok(task);
    assert.deepEqual(
      task.application.actions.map((item: any) => item.id),
      [saved.actions[0]!.id, saved.actions[2]!.id],
    );
    assert.equal(task.application.actions[1].text, saved.actions[2]!.text);
    assert.equal(
      f.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM audit WHERE event='extensionApplication.pendingTemplateUpdated'",
        )
        .get()?.n,
      1,
    );
  } finally {
    await f.close();
  }
});

test("latest-template review cannot hide changed inputs, modify attempted text or reconfigure other batch jobs", async () => {
  for (const change of [
    "hash",
    "version",
    "text",
    "prefix",
    "resume",
    "policy",
    "history",
    "other-job",
    "inspection",
    "audit",
  ]) {
    const f = await fixture("eligible", undefined, "0.4.4");
    try {
      const staged = await stageUpdatedTemplate(f);
      if (change === "hash")
        staged.request.updatedTemplate.expectedConfigurationKey = "0".repeat(
          64,
        );
      if (change === "version") staged.request.updatedTemplate.version++;
      if (change === "text")
        staged.request.updatedTemplate.expectedMessages[1] = "未预览的话术";
      if (change === "resume")
        f.store.set("resume", {
          ...f.store.get<any>("resume", null),
          text: "新的履历",
        });
      if (change === "policy")
        f.store.set("policy", { ...DEFAULT_POLICY, salaryMin: 30000 });
      if (change === "history")
        f.store.set(`template:${staged.application.templateVersion}`, null);
      if (change === "other-job")
        f.store.insertApplication({
          ...staged.application,
          id: randomUUID(),
          jobId: randomUUID(),
        });
      if (change === "inspection")
        f.store.set("automation.current", {
          ...staged.run,
          updatedAt: new Date(Date.now() - 100000).toISOString(),
        });
      if (change === "audit")
        f.store.db
          .prepare(
            "DELETE FROM audit WHERE event='extensionApplication.existingContactResumed'",
          )
          .run();
      if (change === "prefix") {
        const t = f.store.get<any>("template", null);
        f.store.set("template", {
          ...t,
          segments: ["另一段已经尝试的话术", t.segments[1]],
        });
      }
      if (["prefix", "resume", "policy"].includes(change)) {
        const p = (
          await f.workbench("/api/template/preview", {
            jobId: staged.application.jobId,
          })
        ).json();
        staged.request.updatedTemplate = {
          version: p.templateVersion,
          expectedConfigurationKey: p.configurationKey,
          expectedMessages: p.messages,
        };
      }
      const before = f.store.application(staged.application.id);
      const oldKey = f.store.get(
        `extensionApplication.configuration:${staged.application.id}`,
        null,
      );
      const response = await f.workbench(
        "/api/extension-application/confirm-message-and-resume",
        staged.request,
      );
      assert.equal(response.statusCode, 400, change + response.body);
      assert.deepEqual(
        f.store.application(staged.application.id),
        before,
        change,
      );
      assert.equal(
        f.store.get(
          `extensionApplication.configuration:${staged.application.id}`,
          null,
        ),
        oldKey,
        change,
      );
      assert.equal(
        f.store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM audit WHERE event='extensionApplication.pendingTemplateUpdated'",
          )
          .get()?.n,
        0,
        change,
      );
    } finally {
      await f.close();
    }
  }
});

test("bulk reconciliation rejects ended, missing or replaced runs and global browser pauses", async () => {
  for (const state of [
    "completed",
    "cancelled",
    "missing",
    "replaced",
    "global-paused",
  ]) {
    const f = await fixture("eligible", undefined, "0.4.4");
    try {
      const staged = await stageUncertainMessage(f);
      const application = f.store.application(staged.identity.applicationId)!;
      application.bulkRunId = randomUUID();
      f.store.updateApplication(application);
      if (state !== "missing")
        f.store.set("bulk.current", {
          id: state === "replaced" ? randomUUID() : application.bulkRunId,
          state: ["completed", "cancelled"].includes(state) ? state : "paused",
        });
      if (state === "global-paused") f.store.set("paused", true);
      const before = f.store.tasks().length;
      const response = await f.workbench(
        "/api/extension-application/confirm-message-and-resume",
        staged.request,
      );
      assert.equal(response.statusCode, 400, state + response.body);
      assert.equal(f.store.tasks().length, before);
      assert.equal(
        f.store.application(application.id)!.actions[1]!.resolution,
        undefined,
      );
    } finally {
      await f.close();
    }
  }
});

test("authenticated manual message confirmation preserves uncertainty, audits it and resumes only pending work", async () => {
  const f = await fixture("eligible");
  try {
    const staged = await stageUncertainMessage(f);
    const url = "/api/extension-application/confirm-message-and-resume";
    assert.equal(
      (await f.app.inject({ method: "POST", url, payload: staged.request }))
        .statusCode,
      401,
    );
    assert.equal((await f.extension(url, staged.request)).statusCode, 403);
    const before = f.store.application(staged.identity.applicationId)!;
    const response = await f.workbench(url, staged.request);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await f.workbench(url, staged.request)).statusCode, 400);
    assert.equal(f.store.tasks().length, 3);
    const saved = f.store.application(before.id)!;
    assert.equal(saved.status, "queued");
    assert.equal(saved.stopReason, undefined);
    assert.equal(saved.pageDiagnostic, undefined);
    assert.deepEqual(saved.actions[0], before.actions[0]);
    assert.equal(saved.actions[1]!.state, "unknown");
    assert.equal(saved.actions[1]!.evidence, "send-unconfirmed");
    assert.equal(saved.actions[1]!.resolution, "user-confirmed-sent");
    assert.deepEqual(saved.frozenMessages, before.frozenMessages);
    const audit = JSON.parse(
      String(
        f.store.db
          .prepare(
            "SELECT body FROM audit WHERE event='extensionApplication.messageConfirmedAndResumed'",
          )
          .get()?.body,
      ),
    );
    assert.equal(audit.actionId, staged.action.id);
    assert.equal(audit.textHash, staged.request.expectedTextHash);
    assert.equal(audit.previousState, "unknown");
    assert.equal(audit.previousEvidence, "send-unconfirmed");
    assert.deepEqual(audit.previousDiagnostic, staged.diagnostic);
    const payload = f.store.tasks().find((task) => task.status === "queued")!
      .payload as typeof saved;
    assert.deepEqual(payload.actions, saved.actions);
    const task = (await f.extension("/extension/v1/application/claim")).json()
      .task;
    assert.deepEqual(
      task.application.actions.map((action: any) => action.id),
      [saved.actions[0]!.id, saved.actions[2]!.id, saved.actions[3]!.id],
    );
    const identity = {
      taskId: task.id,
      leaseToken: task.leaseToken,
      applicationId: saved.id,
    };
    for (const path of ["authorize", "action"]) {
      const extra =
        path === "action"
          ? { state: "started", evidence: "before-action" }
          : {};
      assert.equal(
        (
          await f.extension(`/extension/v1/application/${path}`, {
            ...identity,
            actionId: staged.action.id,
            ...extra,
          })
        ).statusCode,
        400,
      );
    }
    assert.equal(
      (
        await f.extension("/extension/v1/application/action", {
          ...identity,
          actionId: saved.actions[2]!.id,
          state: "started",
          evidence: "before-action",
          resolution: "user-confirmed-sent",
        })
      ).statusCode,
      400,
    );
    for (const action of saved.actions.slice(2)) {
      assert.equal(
        (
          await f.extension("/extension/v1/application/action", {
            ...identity,
            actionId: action.id,
            state: "started",
            evidence: "before-action",
          })
        ).json().execute,
        true,
      );
      if (action.kind === "attachment")
        assert.equal(
          (
            await f.extension("/extension/v1/application/attachment", {
              ...identity,
              actionId: action.id,
            })
          ).statusCode,
          200,
        );
      assert.equal(
        (
          await f.extension("/extension/v1/application/action", {
            ...identity,
            actionId: action.id,
            state: "confirmed",
            evidence:
              action.kind === "attachment" ? "new-attachment" : "new-message",
          })
        ).statusCode,
        200,
      );
    }
    // Successful completion must remove even old diagnostics restored by a stale client.
    const running = f.store.application(saved.id)!;
    running.stopReason = "send-unconfirmed";
    running.pageDiagnostic = staged.diagnostic as typeof running.pageDiagnostic;
    f.store.updateApplication(running);
    assert.equal(
      (await f.extension("/extension/v1/application/result", identity)).json()
        .status,
      "completed",
    );
    const completed = f.store.application(saved.id)!;
    assert.ok(completed.actions.every(actionCompleteForExistingContact));
    assert.equal(completed.actions[1]!.state, "unknown");
    assert.equal(completed.stopReason, undefined);
    assert.equal(completed.pageDiagnostic, undefined);
  } finally {
    await f.close();
  }
});

test("manual reconciliation rejects mismatched text, non-message actions, stale or reused inspection and altered frozen inputs", async () => {
  const cases = [
    "wrong-hash",
    "native",
    "attachment",
    "expired",
    "wrong-job",
    "no-contact",
    "used-inspection",
    "configuration",
    "attachment-bytes",
    "job-changed",
    "later-unknown",
    "prior-unresolved",
    "prior-confirmed",
    "no-contact-audit",
    "no-pending",
    "wrong-stop",
  ] as const;
  for (const scenario of cases) {
    const f = await fixture("eligible");
    try {
      const staged = await stageUncertainMessage(f);
      const application = f.store.application(staged.identity.applicationId)!;
      const request = { ...staged.request };
      if (scenario === "wrong-hash") request.expectedTextHash = "0".repeat(64);
      if (scenario === "native") request.actionId = application.actions[0]!.id;
      if (scenario === "attachment")
        request.actionId = application.actions.at(-1)!.id;
      if (scenario === "expired")
        staged.run.updatedAt = new Date(Date.now() - 91000).toISOString();
      if (scenario === "wrong-job") staged.run.inspectionJobId = randomUUID();
      if (scenario === "no-contact")
        staged.run.fieldReadings[0]!.evidence.headerLines = ["立即沟通"];
      if (scenario === "used-inspection")
        f.store.audit("extensionApplication.existingContactResumed", {
          applicationId: application.id,
          inspectionRunId: staged.run.id,
        });
      if (scenario === "configuration")
        f.store.set("template", {
          ...f.store.get<any>("template", null),
          version: 999,
        });
      if (scenario === "attachment-bytes")
        writeFileSync(
          join(f.attachmentsDir, f.attachmentName),
          "%PDF-1.4 changed",
        );
      if (scenario === "job-changed")
        f.store.upsertJob({ ...f.job, description: "不同工作内容" });
      if (scenario === "later-unknown")
        application.actions[2]!.state = "unknown";
      if (scenario === "prior-unresolved")
        delete application.actions[0]!.resolution;
      if (scenario === "prior-confirmed")
        application.actions[0]!.state = "confirmed";
      if (scenario === "no-contact-audit")
        f.store.db
          .prepare(
            "DELETE FROM audit WHERE event='extensionApplication.existingContactResumed'",
          )
          .run();
      if (scenario === "no-pending")
        application.actions = application.actions.slice(0, 2);
      if (scenario === "wrong-stop")
        application.stopReason = "recipient-mismatch";
      f.store.updateApplication(application);
      f.store.set("automation.current", staged.run);
      const response = await f.workbench(
        "/api/extension-application/confirm-message-and-resume",
        request,
      );
      assert.equal(response.statusCode, 400, scenario + ": " + response.body);
      assert.equal(f.store.tasks().length, 2, scenario);
      assert.equal(
        f.store.application(application.id)!.actions[1]!.resolution,
        undefined,
        scenario,
      );
      assert.equal(
        f.store.db
          .prepare(
            "SELECT count(*) n FROM audit WHERE event='extensionApplication.messageConfirmedAndResumed'",
          )
          .get()?.n,
        0,
        scenario,
      );
    } finally {
      await f.close();
    }
  }
});

test("another unknown segment can be reconciled once after a new inspection, without replaying prior messages", async () => {
  const f = await fixture("eligible");
  try {
    const staged = await stageUncertainMessage(f);
    const url = "/api/extension-application/confirm-message-and-resume";
    assert.equal((await f.workbench(url, staged.request)).statusCode, 200);
    const task = (await f.extension("/extension/v1/application/claim")).json()
      .task;
    const identity = {
      taskId: task.id,
      leaseToken: task.leaseToken,
      applicationId: staged.identity.applicationId,
    };
    const action = task.application.actions.find(
      (item: any) => item.kind === "message",
    );
    for (const [state, evidence] of [
      ["started", "before-action"],
      ["unknown", "send-unconfirmed"],
    ])
      assert.equal(
        (
          await f.extension("/extension/v1/application/action", {
            ...identity,
            actionId: action.id,
            state,
            evidence,
          })
        ).statusCode,
        200,
      );
    await f.extension("/extension/v1/application/result", {
      ...identity,
      reason: "send-unconfirmed",
    });
    assert.equal(
      f.store.application(identity.applicationId)?.pageDiagnostic,
      undefined,
    );
    const request = {
      ...staged.request,
      actionId: action.id,
      expectedTextHash: createHash("sha256").update(action.text).digest("hex"),
    };
    assert.equal((await f.workbench(url, request)).statusCode, 400);
    request.inspectionRunId = randomUUID();
    f.store.set("automation.current", {
      ...staged.run,
      id: request.inspectionRunId,
      updatedAt: new Date().toISOString(),
    });
    assert.equal((await f.workbench(url, request)).statusCode, 200);
    const lastTask = (
      await f.extension("/extension/v1/application/claim")
    ).json().task;
    assert.deepEqual(
      lastTask.application.actions.map((item: any) => item.kind),
      ["native-greeting", "attachment"],
    );
    assert.equal(
      f.store
        .application(identity.applicationId)
        ?.actions.filter((item) => item.resolution === "user-confirmed-sent")
        .length,
      2,
    );
  } finally {
    await f.close();
  }
});

test("confirming the final text completes the record and paused batch without enqueueing or rewriting unknown receipts", async () => {
  const f = await fixture("eligible", undefined, "0.4.4");
  try {
    f.store.set("template", {
      ...f.store.get<any>("template", null),
      attachmentPolicy: "message-only",
    });
    const staged = await stageUncertainMessage(f);
    const url = "/api/extension-application/confirm-message-and-resume";
    assert.equal((await f.workbench(url, staged.request)).statusCode, 200);
    const task = (await f.extension("/extension/v1/application/claim")).json()
      .task;
    const identity = {
      taskId: task.id,
      leaseToken: task.leaseToken,
      applicationId: staged.identity.applicationId,
    };
    const last = task.application.actions.find(
      (item: any) => item.kind === "message",
    );
    for (const [state, evidence] of [
      ["started", "before-action"],
      ["unknown", "send-unconfirmed"],
    ])
      assert.equal(
        (
          await f.extension("/extension/v1/application/action", {
            ...identity,
            actionId: last.id,
            state,
            evidence,
          })
        ).statusCode,
        200,
      );
    await f.extension("/extension/v1/application/result", {
      ...identity,
      reason: "send-unconfirmed",
    });
    const application = f.store.application(identity.applicationId)!;
    application.bulkRunId = randomUUID();
    f.store.updateApplication(application);
    f.store.set("bulk.current", {
      id: application.bulkRunId,
      state: "paused",
      target: 1,
      dailyLimit: 150,
      intervalSeconds: 30,
      configurationKey: f.store.get(
        `extensionApplication.configuration:${application.id}`,
        null,
      ),
      counts: {
        queued: 0,
        running: 0,
        completed: 0,
        review: 1,
        skipped: 0,
        cancelled: 0,
      },
    });
    const run = {
      ...staged.run,
      id: randomUUID(),
      updatedAt: new Date().toISOString(),
    };
    f.store.set("automation.current", run);
    const count = f.store.tasks().length;
    const response = await f.workbench(url, {
      applicationId: application.id,
      actionId: last.id,
      expectedTextHash: createHash("sha256").update(last.text).digest("hex"),
      inspectionRunId: run.id,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, "completed");
    const saved = f.store.application(application.id)!;
    assert.deepEqual(
      saved.actions.slice(0, 2),
      application.actions.slice(0, 2),
    );
    assert.equal(saved.actions[2]!.state, "unknown");
    assert.equal(saved.actions[2]!.resolution, "user-confirmed-sent");
    assert.equal(f.store.tasks().length, count);
    assert.equal(
      (await f.extension("/extension/v1/application/claim")).json().task,
      null,
    );
    assert.equal(f.store.get<any>("bulk.current", null).state, "completed");
    assert.equal(f.store.get<any>("bulk.current", null).counts.completed, 1);
  } finally {
    await f.close();
  }
});

test("fresh exact read-only inspection resumes only pending messages while native remains unknown", async () => {
  const f = await fixture("eligible");
  try {
    const staged = await stageExistingContact(f);
    const latest = f.store.upsertJob({
      ...f.job,
      company: "示例公司有限公司",
      lastSeen: new Date().toISOString(),
    });
    staged.run.fieldReadings[0]!.evidence.company = latest.company;
    f.store.set("automation.current", staged.run);
    const response = await f.workbench(
      "/api/extension-application/resume-existing-contact",
      {
        applicationId: staged.identity.applicationId,
        inspectionRunId: staged.inspectionRunId,
      },
    );
    assert.equal(response.statusCode, 200, response.body);
    const restored = f.store.application(staged.identity.applicationId)!;
    assert.equal(restored.actions[0]!.state, "unknown");
    assert.equal(restored.actions[0]!.evidence, "send-unconfirmed");
    assert.equal(restored.actions[0]!.resolution, "contact-exists");
    assert.equal(restored.job.contentHash, latest.contentHash);
    const next = (await f.extension("/extension/v1/application/claim")).json()
      .task;
    const identity = {
      taskId: next.id,
      leaseToken: next.leaseToken,
      applicationId: restored.id,
    };
    assert.equal(
      (
        await f.extension("/extension/v1/application/authorize", {
          ...identity,
          actionId: staged.native.id,
        })
      ).json().allowed,
      true,
    );
    assert.equal(
      (
        await f.extension("/extension/v1/application/action", {
          ...identity,
          actionId: staged.native.id,
          state: "started",
          evidence: "before-action",
        })
      ).statusCode,
      400,
    );
    const message = next.application.actions[1];
    assert.equal(
      (
        await f.extension("/extension/v1/application/action", {
          ...identity,
          actionId: message.id,
          state: "started",
          evidence: "before-action",
        })
      ).json().execute,
      true,
    );
  } finally {
    await f.close();
  }
});

test("resolved existing-contact page failure can resume after a new inspection without a new score", async () => {
  for (const reason of ["recipient-mismatch", "page-unrecognized"] as const) {
    const f = await fixture("eligible");
    try {
      const staged = await stageExistingContact(f);
      const current = f.store.upsertJob({
        ...f.job,
        company: "示例公司有限公司",
      });
      staged.run.fieldReadings[0]!.evidence.company = current.company;
      f.store.set("automation.current", staged.run);
      const request = (inspectionRunId: string) =>
        f.workbench("/api/extension-application/resume-existing-contact", {
          applicationId: staged.identity.applicationId,
          inspectionRunId,
        });
      assert.equal((await request(staged.inspectionRunId)).statusCode, 200);
      const firstResume = (
        await f.extension("/extension/v1/application/claim")
      ).json().task;
      assert.equal(
        (
          await f.extension("/extension/v1/application/result", {
            taskId: firstResume.id,
            leaseToken: firstResume.leaseToken,
            applicationId: staged.identity.applicationId,
            reason,
            diagnostic: {
              stage: "conversation",
              editorCount: 1,
              activeJobCardCount: 0,
              exactJobLinkCount: 0,
              employerFieldMatchCount: 0,
            },
          })
        ).json().status,
        "needs-review",
      );
      const before = f.store.application(staged.identity.applicationId)!;
      assert.equal(before.actions[0]!.state, "unknown");
      assert.equal(before.actions[0]!.resolution, "contact-exists");
      assert.ok(
        before.actions.slice(1).every((action) => action.state === "pending"),
      );
      assert.equal((await request(staged.inspectionRunId)).statusCode, 400);
      const newRunId = randomUUID();
      f.store.set("automation.current", {
        ...staged.run,
        id: newRunId,
        updatedAt: new Date().toISOString(),
      });
      assert.equal((await request(newRunId)).statusCode, 200);
      const restored = f.store.application(staged.identity.applicationId)!;
      assert.deepEqual(restored.actions, before.actions);
      assert.equal(f.store.tasks().length, 3);
      assert.equal(
        f.store.tasks().filter((task) => task.status === "needs-review").length,
        2,
      );
      assert.equal(
        f.store.db
          .prepare(
            "SELECT count(*) n FROM audit WHERE event='extensionApplication.existingContactResumed'",
          )
          .get()?.n,
        2,
      );
      const secondResume = (
        await f.extension("/extension/v1/application/claim")
      ).json().task;
      const identity = {
        taskId: secondResume.id,
        leaseToken: secondResume.leaseToken,
        applicationId: staged.identity.applicationId,
      };
      assert.equal(
        (
          await f.extension("/extension/v1/application/authorize", {
            ...identity,
            actionId: staged.native.id,
          })
        ).json().allowed,
        true,
      );
      assert.equal(
        (
          await f.extension("/extension/v1/application/action", {
            ...identity,
            actionId: secondResume.application.actions[1].id,
            state: "started",
            evidence: "before-action",
          })
        ).json().execute,
        true,
      );
    } finally {
      await f.close();
    }
  }
});

test("resolved contact retry rejects other stop reasons, changed hash, and touched later actions", async () => {
  const f = await fixture("eligible");
  try {
    const staged = await stageExistingContact(f);
    const current = f.store.upsertJob({
      ...f.job,
      company: "示例公司有限公司",
    });
    staged.run.fieldReadings[0]!.evidence.company = current.company;
    f.store.set("automation.current", staged.run);
    const request = (inspectionRunId: string) =>
      f.workbench("/api/extension-application/resume-existing-contact", {
        applicationId: staged.identity.applicationId,
        inspectionRunId,
      });
    assert.equal((await request(staged.inspectionRunId)).statusCode, 200);
    const first = (await f.extension("/extension/v1/application/claim")).json()
      .task;
    const identity = {
      taskId: first.id,
      leaseToken: first.leaseToken,
      applicationId: staged.identity.applicationId,
    };
    await f.extension("/extension/v1/application/result", {
      ...identity,
      reason: "send-unconfirmed",
    });
    const newRunId = randomUUID();
    f.store.set("automation.current", {
      ...staged.run,
      id: newRunId,
      updatedAt: new Date().toISOString(),
    });
    assert.equal((await request(newRunId)).statusCode, 400);
    const changed = f.store.application(staged.identity.applicationId)!;
    changed.stopReason = "recipient-mismatch";
    changed.actions[1]!.state = "unknown";
    f.store.updateApplication(changed);
    assert.equal((await request(newRunId)).statusCode, 400);
    changed.actions[1]!.state = "pending";
    f.store.updateApplication(changed);
    f.store.upsertJob({ ...current, url: current.url + "?ref=changed" });
    assert.equal((await request(newRunId)).statusCode, 400);
  } finally {
    await f.close();
  }
});

test("resume rejects wrong or expired inspection and any previously started later action", async () => {
  const f = await fixture("eligible");
  try {
    const staged = await stageExistingContact(f);
    const request = (inspectionRunId = staged.inspectionRunId) =>
      f.workbench("/api/extension-application/resume-existing-contact", {
        applicationId: staged.identity.applicationId,
        inspectionRunId,
      });
    const connection = f.store.get<any>("browserExtension.connection", null);
    f.store.set("browserExtension.connection", {
      ...connection,
      version: "0.3.3",
    });
    assert.equal((await request()).statusCode, 400);
    f.store.set("browserExtension.connection", connection);
    assert.equal((await request(randomUUID())).statusCode, 400);
    staged.run.updatedAt = new Date(Date.now() - 91000).toISOString();
    f.store.set("automation.current", staged.run);
    assert.equal((await request()).statusCode, 400);
    staged.run.updatedAt = new Date().toISOString();
    staged.run.inspectionJobId = randomUUID();
    f.store.set("automation.current", staged.run);
    assert.equal((await request()).statusCode, 400);
    staged.run.inspectionJobId = f.job.id;
    staged.run.fieldReadings[0]!.evidence.headerLines = [
      "立即沟通",
      "感兴趣 继续沟通",
    ];
    f.store.set("automation.current", staged.run);
    assert.equal((await request()).statusCode, 400);
    staged.run.fieldReadings[0]!.evidence.headerLines = ["感兴趣 继续沟通"];
    f.store.set("automation.current", staged.run);
    const corrupted = f.store.application(staged.identity.applicationId)!;
    corrupted.actions[1]!.state = "unknown";
    f.store.updateApplication(corrupted);
    assert.equal((await request()).statusCode, 400);
  } finally {
    await f.close();
  }
});

test("resume rejects changed employer, salary or description even with existing-contact evidence", async () => {
  for (const change of [
    { company: "无关企业有限公司" },
    { companyAliases: ["新增关联企业"] },
    { salaryMin: 24000 },
    { description: "新的岗位职责" },
  ]) {
    const f = await fixture("eligible");
    try {
      const staged = await stageExistingContact(f);
      f.store.upsertJob({ ...f.job, ...change });
      const response = await f.workbench(
        "/api/extension-application/resume-existing-contact",
        {
          applicationId: staged.identity.applicationId,
          inspectionRunId: staged.inspectionRunId,
        },
      );
      assert.equal(response.statusCode, 400);
      assert.equal(
        f.store.application(staged.identity.applicationId)?.actions[0]
          ?.resolution,
        undefined,
      );
    } finally {
      await f.close();
    }
  }
});

test("single application preview and start accept only reviewed soft review with all hard gates", async () => {
  const f = await fixture();
  try {
    const preview = await f.workbench(
      "/api/extension-application/preview",
      f.selection,
    );
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(f.store.applications().length, 0);
    const start = await f.workbench("/api/extension-application/start", {
      ...f.selection,
      expectedConfigurationKey: preview.json().configurationKey,
    });
    assert.equal(start.statusCode, 200, start.body);
    assert.equal(f.store.applications()[0]?.executor, "extension");
    assert.equal(
      f.store.db
        .prepare(
          "SELECT count(*) n FROM audit WHERE event='extensionApplication.manualReviewAccepted'",
        )
        .get()?.n,
      1,
    );
    assert.equal(
      (
        await f.workbench("/api/extension-application/start", {
          ...f.selection,
          expectedConfigurationKey: preview.json().configurationKey,
        })
      ).statusCode,
      400,
    );
  } finally {
    await f.close();
  }
  const hardFail = await fixture("review", [
    { field: "location", status: "fail", reason: "mismatch" },
  ]);
  try {
    assert.equal(
      (
        await hardFail.workbench(
          "/api/extension-application/preview",
          hardFail.selection,
        )
      ).statusCode,
      400,
    );
  } finally {
    await hardFail.close();
  }
});

test("stale hash or configuration fails closed and worker cannot claim extension task", async () => {
  const f = await fixture("eligible");
  try {
    const selection = { ...f.selection, acceptReview: false };
    assert.equal(
      (
        await f.workbench("/api/extension-application/preview", {
          ...selection,
          expectedContentHash: "0".repeat(64),
        })
      ).statusCode,
      400,
    );
    const preview = (
      await f.workbench("/api/extension-application/preview", selection)
    ).json();
    assert.equal(
      (
        await f.workbench("/api/extension-application/start", {
          ...selection,
          expectedConfigurationKey: "0".repeat(64),
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.workbench("/api/extension-application/start", {
          ...selection,
          expectedConfigurationKey: preview.configurationKey,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/internal/tasks/claim",
          headers: { authorization: "Bearer internal" },
        })
      ).json().task,
      null,
    );
    assert.equal(
      (await f.extension("/extension/v1/application/claim")).json().task
        .application.executor,
      "extension",
    );
  } finally {
    await f.close();
  }
});

test("action receipts enforce order and duplicate start cannot replay; attachment is bound to started action", async () => {
  const f = await fixture("eligible");
  try {
    const selection = { ...f.selection, acceptReview: false };
    const preview = (
      await f.workbench("/api/extension-application/preview", selection)
    ).json();
    await f.workbench("/api/extension-application/start", {
      ...selection,
      expectedConfigurationKey: preview.configurationKey,
    });
    const task = (await f.extension("/extension/v1/application/claim")).json()
      .task;
    const identity = {
      taskId: task.id,
      leaseToken: task.leaseToken,
      applicationId: task.application.id,
    };
    const [greeting, message, attachment] = task.application.actions;
    const action = (actionId: string, state: string, evidence: string) =>
      f.extension("/extension/v1/application/action", {
        ...identity,
        actionId,
        state,
        evidence,
      });
    assert.equal(
      (await action(message.id, "started", "before-action")).statusCode,
      400,
    );
    assert.equal(
      (await action(greeting.id, "skipped", "existing-contact")).statusCode,
      200,
    );
    assert.equal(
      (await action(message.id, "started", "before-action")).json().execute,
      true,
    );
    assert.equal(
      (await action(message.id, "started", "before-action")).json().execute,
      false,
    );
    assert.equal(
      (
        await f.extension("/extension/v1/application/authorize", {
          ...identity,
          actionId: message.id,
        })
      ).json().allowed,
      true,
    );
    assert.equal(
      (
        await f.extension("/extension/v1/application/attachment", {
          ...identity,
          actionId: attachment.id,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await action(message.id, "confirmed", "new-message")).statusCode,
      200,
    );
    assert.equal(
      (await action(attachment.id, "started", "before-action")).json().execute,
      true,
    );
    const file = await f.extension("/extension/v1/application/attachment", {
      ...identity,
      actionId: attachment.id,
    });
    assert.equal(file.statusCode, 200, file.body);
    assert.equal(file.json().name, f.attachmentName);
    assert.equal(
      file.json().sha256,
      createHash("sha256")
        .update(Buffer.from(file.json().base64, "base64"))
        .digest("hex"),
    );
    assert.equal(
      (await action(attachment.id, "confirmed", "new-attachment")).statusCode,
      200,
    );
    const result = await f.extension(
      "/extension/v1/application/result",
      identity,
    );
    assert.equal(result.json().status, "completed");
    assert.equal(
      (await f.extension("/extension/v1/application/result", identity)).json()
        .status,
      "completed",
    );
  } finally {
    await f.close();
  }
});

test("attachment replacement blocks authorization and retrieval", async () => {
  const f = await fixture("eligible");
  try {
    const selection = { ...f.selection, acceptReview: false };
    const preview = (
      await f.workbench("/api/extension-application/preview", selection)
    ).json();
    await f.workbench("/api/extension-application/start", {
      ...selection,
      expectedConfigurationKey: preview.configurationKey,
    });
    const task = (await f.extension("/extension/v1/application/claim")).json()
      .task;
    const identity = {
      taskId: task.id,
      leaseToken: task.leaseToken,
      applicationId: task.application.id,
    };
    const [greeting, message, attachment] = task.application.actions;
    const path = join(f.attachmentsDir, f.attachmentName);
    writeFileSync(path, "%PDF-1.4 changed");
    assert.equal(
      (
        await f.extension("/extension/v1/application/action", {
          ...identity,
          actionId: greeting.id,
          state: "started",
          evidence: "before-action",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.extension("/extension/v1/application/authorize", {
          ...identity,
          actionId: greeting.id,
        })
      ).statusCode,
      400,
    );
    writeFileSync(path, "%PDF-1.4 fixture");
    await f.extension("/extension/v1/application/action", {
      ...identity,
      actionId: greeting.id,
      state: "skipped",
      evidence: "existing-contact",
    });
    await f.extension("/extension/v1/application/action", {
      ...identity,
      actionId: message.id,
      state: "started",
      evidence: "before-action",
    });
    await f.extension("/extension/v1/application/action", {
      ...identity,
      actionId: message.id,
      state: "confirmed",
      evidence: "new-message",
    });
    await f.extension("/extension/v1/application/action", {
      ...identity,
      actionId: attachment.id,
      state: "started",
      evidence: "before-action",
    });
    writeFileSync(path, "%PDF-1.4 changed again");
    assert.equal(
      (
        await f.extension("/extension/v1/application/attachment", {
          ...identity,
          actionId: attachment.id,
        })
      ).statusCode,
      400,
    );
  } finally {
    await f.close();
  }
});

test("authorization fails for pause, uncertain browser, expired lease, and changed job", async () => {
  const f = await fixture("eligible");
  try {
    const selection = { ...f.selection, acceptReview: false };
    const preview = (
      await f.workbench("/api/extension-application/preview", selection)
    ).json();
    await f.workbench("/api/extension-application/start", {
      ...selection,
      expectedConfigurationKey: preview.configurationKey,
    });
    const task = (await f.extension("/extension/v1/application/claim")).json()
      .task;
    const identity = {
      taskId: task.id,
      leaseToken: task.leaseToken,
      applicationId: task.application.id,
    };
    const actionId = task.application.actions[0].id;
    const authorize = () =>
      f.extension("/extension/v1/application/authorize", {
        ...identity,
        actionId,
      });
    assert.equal(
      (
        await f.extension("/extension/v1/application/action", {
          ...identity,
          actionId,
          state: "started",
          evidence: "before-action",
        })
      ).json().execute,
      true,
    );
    assert.equal((await authorize()).statusCode, 200);
    f.store.set("paused", true);
    assert.equal((await authorize()).statusCode, 400);
    assert.equal(
      (
        await f.extension("/extension/v1/application/heartbeat", {
          taskId: task.id,
          leaseToken: task.leaseToken,
        })
      ).json().paused,
      true,
    );
    f.store.set("paused", false);
    f.store.set("browserUncertain", true);
    assert.equal((await authorize()).statusCode, 400);
    f.store.set("browserUncertain", false);
    f.store.upsertJob({ ...f.job, description: "内容已经变化" });
    assert.equal((await authorize()).statusCode, 400);
    f.store.db
      .prepare("UPDATE tasks SET lease_until=? WHERE id=?")
      .run("2000-01-01T00:00:00.000Z", task.id);
    assert.equal((await authorize()).statusCode, 400);
  } finally {
    await f.close();
  }
});

test("unfinished started action becomes unknown and requires review", async () => {
  const f = await fixture("eligible");
  try {
    const selection = { ...f.selection, acceptReview: false };
    const preview = (
      await f.workbench("/api/extension-application/preview", selection)
    ).json();
    await f.workbench("/api/extension-application/start", {
      ...selection,
      expectedConfigurationKey: preview.configurationKey,
    });
    const task = (await f.extension("/extension/v1/application/claim")).json()
      .task;
    const identity = {
      taskId: task.id,
      leaseToken: task.leaseToken,
      applicationId: task.application.id,
    };
    const greeting = task.application.actions[0];
    await f.extension("/extension/v1/application/action", {
      ...identity,
      actionId: greeting.id,
      state: "started",
      evidence: "before-action",
    });
    assert.equal(
      (await f.extension("/extension/v1/application/result", identity)).json()
        .status,
      "needs-review",
    );
    assert.equal(
      f.store.application(identity.applicationId)?.actions[0]?.state,
      "unknown",
    );
  } finally {
    await f.close();
  }
});

test("configuration changes before claim or action block sends, and attachment paths cannot escape the upload directory", async () => {
  const f = await fixture("eligible");
  try {
    const selection = { ...f.selection, acceptReview: false };
    let preview = (
      await f.workbench("/api/extension-application/preview", selection)
    ).json();
    await f.workbench("/api/extension-application/start", {
      ...selection,
      expectedConfigurationKey: preview.configurationKey,
    });
    f.store.set("policy", { ...DEFAULT_POLICY, version: 2 });
    assert.equal(
      (await f.extension("/extension/v1/application/claim")).json().task,
      null,
    );
    assert.equal(f.store.applications()[0]?.status, "needs-review");
  } finally {
    await f.close();
  }
  const g = await fixture("eligible");
  try {
    const selection = { ...g.selection, acceptReview: false };
    const preview = (
      await g.workbench("/api/extension-application/preview", selection)
    ).json();
    await g.workbench("/api/extension-application/start", {
      ...selection,
      expectedConfigurationKey: preview.configurationKey,
    });
    const task = (await g.extension("/extension/v1/application/claim")).json()
      .task;
    const identity = {
      taskId: task.id,
      leaseToken: task.leaseToken,
      applicationId: task.application.id,
    };
    const [greeting, message, attachment] = task.application.actions;
    await g.extension("/extension/v1/application/action", {
      ...identity,
      actionId: greeting.id,
      state: "skipped",
      evidence: "existing-contact",
    });
    await g.extension("/extension/v1/application/action", {
      ...identity,
      actionId: message.id,
      state: "started",
      evidence: "before-action",
    });
    await g.extension("/extension/v1/application/action", {
      ...identity,
      actionId: message.id,
      state: "confirmed",
      evidence: "new-message",
    });
    await g.extension("/extension/v1/application/action", {
      ...identity,
      actionId: attachment.id,
      state: "started",
      evidence: "before-action",
    });
    const corrupted = g.store.application(identity.applicationId)!;
    corrupted.resumeAttachment = "../outside.pdf";
    g.store.updateApplication(corrupted);
    assert.equal(
      (
        await g.extension("/extension/v1/application/attachment", {
          ...identity,
          actionId: attachment.id,
        })
      ).statusCode,
      400,
    );
    g.store.set("policy", { ...DEFAULT_POLICY, version: 2 });
    assert.equal(
      (
        await g.extension("/extension/v1/application/action", {
          ...identity,
          actionId: attachment.id,
          state: "started",
          evidence: "before-action",
        })
      ).statusCode,
      400,
    );
  } finally {
    await g.close();
  }
});

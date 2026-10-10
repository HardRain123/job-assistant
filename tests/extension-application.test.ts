import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/api/src/app.ts";
import { Store } from "../packages/storage/src/index.ts";
import {
  DEFAULT_POLICY,
  type Assessment,
  type Job,
  type Resume,
} from "../packages/contracts/src/index.ts";
import { fingerprint } from "../packages/templates/src/index.ts";

const origin = `chrome-extension://${"a".repeat(32)}`;
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
async function fixture(
  decision: Assessment["decision"] = "review",
  gates: Assessment["gates"] = [
    { field: "location", status: "pass", reason: "ok" },
  ],
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
    "x-extension-version": "0.3.4",
  };
  await app.inject({
    method: "POST",
    url: "/extension/v1/status",
    headers: extHeaders,
  });
  const workbench = (url: string, payload: any) =>
    app.inject({ method: "POST", url, headers: { cookie }, payload });
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
    extension,
    selection,
    close: async () => {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function stageExistingContact(f: Awaited<ReturnType<typeof fixture>>) {
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

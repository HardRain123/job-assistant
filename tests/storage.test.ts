import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../packages/storage/src/index.ts";
import {
  DEFAULT_TEMPLATE,
  type Application,
  type Job,
} from "../packages/contracts/src/index.ts";
import { renderTemplate } from "../packages/templates/src/index.ts";
import { encrypt, decrypt } from "../apps/api/src/security.ts";
const job: Job = {
  id: "j1",
  source: "boss",
  sourceId: "s1",
  sourceJobId: "j1",
  url: "https://www.zhipin.com/job_detail/example.html",
  title: "Java AI",
  company: "示例科技",
  companyAliases: [],
  industry: "软件",
  location: "上海",
  remote: false,
  salaryMin: 22000,
  salaryMax: 30000,
  salaryMonths: 13,
  experienceMin: 5,
  description: "Java AI Spring Boot",
  skills: ["Java"],
  education: null,
  firstSeen: "2026-01-01",
  lastSeen: "2026-01-01",
  contentHash: "hash",
  status: "active",
};
function application(): Application {
  return {
    id: "a1",
    batchId: "b1",
    jobId: job.id,
    job,
    resumeId: "r1",
    resumeAttachment: null,
    templateVersion: 1,
    frozenMessages: ["您好"],
    attachmentPolicy: "message-only",
    status: "queued",
    createdAt: "2026-01-01",
    actions: [
      {
        id: "g",
        kind: "native-greeting",
        index: 0,
        text: null,
        state: "pending",
        evidence: null,
        updatedAt: "2026-01-01",
      },
      {
        id: "m",
        kind: "message",
        index: 1,
        text: "您好",
        state: "pending",
        evidence: null,
        updatedAt: "2026-01-01",
      },
    ],
  };
}
test("岗位增量同步保留身份和首次时间，保存变更快照", () => {
  const s = new Store(":memory:");
  try {
    s.upsertJob(job);
    s.upsertJob({
      ...job,
      id: "other",
      firstSeen: "later",
      contentHash: "new",
      salaryMin: 25000,
    });
    assert.equal(s.jobs().length, 1);
    assert.equal(s.jobs()[0].id, "j1");
    assert.equal(s.jobs()[0].firstSeen, "2026-01-01");
    assert.equal(s.db.prepare("SELECT count(*) n FROM snapshots").get()?.n, 2);
  } finally {
    s.close();
  }
});
test("独占租约、段落顺序、未知结果禁止重放、过期任务转人工核对", () => {
  const s = new Store(":memory:");
  try {
    const a = application();
    s.insertApplication(a);
    const id = s.enqueue("apply", a);
    const t = s.claim()!;
    assert.equal(s.claim(), null);
    assert.throws(
      () =>
        s.recordAction(id, t.leaseToken!, a.id, {
          ...a.actions[1],
          state: "started",
        }),
      /前序/,
    );
    s.recordAction(id, t.leaseToken!, a.id, {
      ...a.actions[0],
      state: "skipped",
    });
    s.recordAction(id, t.leaseToken!, a.id, {
      ...a.actions[1],
      state: "started",
    });
    s.recordAction(id, t.leaseToken!, a.id, {
      ...a.actions[1],
      state: "unknown",
    });
    assert.throws(
      () =>
        s.recordAction(id, t.leaseToken!, a.id, {
          ...a.actions[1],
          state: "started",
        }),
      /倒退/,
    );
    s.db
      .prepare("UPDATE tasks SET lease_until=? WHERE id=?")
      .run("2000-01-01", id);
    assert.equal(s.claim(), null);
    assert.equal(s.tasks()[0].status, "needs-review");
    assert.equal(s.application(a.id)?.status, "needs-review");
    assert.throws(() => s.heartbeat(id, t.leaseToken!), /租约/);
  } finally {
    s.close();
  }
});
test("暂停和人工接管禁止领取和开始外部动作", () => {
  const s = new Store(":memory:");
  try {
    const a = application();
    s.insertApplication(a);
    const id = s.enqueue("apply", a);
    s.set("paused", true);
    assert.equal(s.claim(), null);
    s.set("paused", false);
    const t = s.claim()!;
    s.set("takeover", true);
    assert.throws(
      () =>
        s.recordAction(id, t.leaseToken!, a.id, {
          ...a.actions[0],
          state: "started",
        }),
      /暂停/,
    );
  } finally {
    s.close();
  }
});
test("不可伪造冻结话术且单个岗位不能重复进入批次", () => {
  const s = new Store(":memory:");
  try {
    const a = application();
    s.insertApplication(a);
    assert.throws(() => s.insertApplication({ ...a, id: "a2" }));
    const id = s.enqueue("apply", a);
    const t = s.claim()!;
    assert.throws(
      () =>
        s.recordAction(id, t.leaseToken!, a.id, {
          ...a.actions[0],
          text: "另一段内容",
          state: "started",
        }),
      /冻结/,
    );
  } finally {
    s.close();
  }
});
test("话术只允许已声明变量，不能提前声称简历附上", () => {
  assert.deepEqual(
    renderTemplate(DEFAULT_TEMPLATE, {
      title: "Java",
      years: "7",
      skills: "Java",
    }),
    [
      "您好，看到贵司的Java岗位与我的经历比较匹配。我有7年研发经验，熟悉Java，希望能进一步沟通。",
    ],
  );
  assert.throws(
    () => renderTemplate({ ...DEFAULT_TEMPLATE, segments: ["{{apiKey}}"] }, {}),
    /不支持/,
  );
  assert.throws(
    () => renderTemplate({ ...DEFAULT_TEMPLATE, segments: ["简历已附上"] }, {}),
    /附件/,
  );
});
test("模型凭据加密且篡改或错误密钥不能解密", () => {
  const value = encrypt({ apiKey: "private-example-key" }, "test-key");
  assert.ok(!value.includes("private-example-key"));
  assert.deepEqual(decrypt(value, "test-key"), {
    apiKey: "private-example-key",
  });
  assert.throws(() => decrypt(value, "other"));
});

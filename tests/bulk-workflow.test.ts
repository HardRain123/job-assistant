import test from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { Store } from "../packages/storage/src/index.ts";
import {
  createBulkWorkflow,
  type AutomationSummary,
} from "../apps/api/src/bulk-workflow.ts";
import type { Application, BulkRun } from "../packages/contracts/src/index.ts";

const baseConfig = {
  dailyLimit: 150,
  target: 2,
  intervalSeconds: 30,
  keywords: ["Java", "后端"],
  city: "上海",
};

async function fixture(
  options: { candidates?: number; maxRounds?: number; applications?: Application[] } = {},
) {
  const store = new Store(":memory:");
  store.set("paused", false);
  store.set("takeover", false);
  store.set("browserUncertain", false);
  let now = Date.UTC(2026, 9, 15, 3);
  let configKey = "fingerprint-a";
  let quotaRemaining = 150;
  let candidateCount = options.candidates ?? 0;
  let previewCount = 0;
  let app: FastifyInstance;
  let workflow: ReturnType<typeof createBulkWorkflow>;
  let bulkCurrent: BulkRun | null = null;
  let automationCurrent: AutomationSummary | null = null;
  const starts = { bulk: 0, automation: 0 };
  const controls: string[] = [];
  const keywordStarts: string[] = [];
  const failureSeeds: number[] = [];
  const mount = async () => {
    app = Fastify();
    app.setErrorHandler((error, _req, reply) => {
      reply.code(400).send({
        error:
          error instanceof z.ZodError
            ? "请求格式不正确"
            : error instanceof Error
              ? error.message
              : "请求失败",
      });
    });
    workflow = createBulkWorkflow({
      store,
      now: () => now,
      configurationKey: () => configKey,
      messageTemplates: () => [
        "您好，我对{{title}}感兴趣。",
        "我有相关经验，期待沟通。",
      ],
      ...(options.applications ? { applications: () => options.applications! } : {}),
      status: () => ({
        paired: true,
        version: "1.0.0",
        lastSeen: new Date(now - 1000).toISOString(),
      }),
      quota: () => ({ remaining: quotaRemaining, date: "2026-10-15" }),
      bulk: {
        state: () => bulkCurrent,
        preview: (config) => {
          previewCount = Math.min(
            config.target,
            candidateCount,
            quotaRemaining,
          );
          return {
            previewId: `bulk-preview-${randomId()}`,
            applications: Array.from(
              { length: previewCount },
              () => ({}) as Application,
            ),
            summary: { selected: previewCount },
          };
        },
        start: (_previewId, insideTransaction, inheritedJobFailures = 0) => {
          assert.equal(insideTransaction, true);
          assert.equal(bulkCurrent?.state === "running", false);
          starts.bulk++;
          failureSeeds.push(inheritedJobFailures);
          candidateCount = Math.max(0, candidateCount - previewCount);
          bulkCurrent = {
            id: `bulk-${starts.bulk}`,
            state: "running",
            target: previewCount,
            dailyLimit: 150,
            intervalSeconds: 30,
            consecutiveJobFailures: inheritedJobFailures,
            message: "running",
            createdAt: new Date(now).toISOString(),
            updatedAt: new Date(now).toISOString(),
            counts: {
              queued: previewCount,
              running: 0,
              completed: 0,
              review: 0,
              skipped: 0,
              cancelled: 0,
            },
          };
          return { run: bulkCurrent };
        },
        control: (action, insideTransaction) => {
          assert.equal(insideTransaction, true);
          if (!bulkCurrent) throw new Error("no bulk");
          controls.push(`bulk:${action}:${bulkCurrent.id}`);
          bulkCurrent = {
            ...bulkCurrent,
            consecutiveJobFailures: action === "resume" ? 0 : bulkCurrent.consecutiveJobFailures,
            state:
              action === "cancel"
                ? "cancelled"
                : action === "pause"
                  ? "paused"
                  : "running",
          };
          return { run: bulkCurrent };
        },
      },
      automation: {
        state: () => automationCurrent,
        start: (config) => {
          assert.equal(automationCurrent?.state === "running", false);
          starts.automation++;
          keywordStarts.push(config.keywords[0]);
          automationCurrent = {
            id: `automation-${starts.automation}`,
            state: "running",
            phase: "collecting",
            imported: 0,
            eligible: 0,
            failed: 0,
            message: "采集中",
          };
          return { run: automationCurrent };
        },
        control: ({ action }) => {
          if (!automationCurrent) throw new Error("no automation");
          controls.push(`automation:${action}:${automationCurrent.id}`);
          automationCurrent = {
            ...automationCurrent,
            state:
              action === "cancel"
                ? "cancelled"
                : action === "pause"
                  ? "paused"
                  : "running",
          };
          return { run: automationCurrent };
        },
      },
    });
    workflow.register(app);
    await app.ready();
  };
  await mount();
  const request = (path: string, payload?: any) => {
    if (path === "/api/bulk-workflow")
      return app.inject({ method: "GET", url: path });
    return app.inject({ method: "POST", url: path, payload });
  };
  const preview = async (extra: Record<string, unknown> = {}) => {
    const response = await request("/api/bulk-workflow/preview", {
      ...baseConfig,
      ...extra,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const start = async (extra: Record<string, unknown> = {}) => {
    const p = await preview(extra);
    const response = await request("/api/bulk-workflow/start", {
      previewId: p.previewId,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().run;
  };
  const state = async () => (await request("/api/bulk-workflow")).json().run;
  return {
    store,
    request,
    preview,
    start,
    state,
    starts,
    controls,
    keywordStarts,
    failureSeeds,
    pump: () => workflow.pump(),
    restart: async () => {
      await app.close();
      await mount();
    },
    finishBulk: (counts: Partial<BulkRun["counts"]> = {}, consecutiveJobFailures = 0) => {
      assert.ok(bulkCurrent);
      const planned =
        bulkCurrent!.counts.queued +
        bulkCurrent!.counts.running +
        bulkCurrent!.counts.completed;
      bulkCurrent = {
        ...bulkCurrent!,
        state: "completed",
        consecutiveJobFailures,
        counts: {
          ...bulkCurrent!.counts,
          queued: 0,
          running: 0,
          completed: planned,
          ...counts,
        },
      };
    },
    finishAutomation: (imported: number, eligible: number) => {
      assert.ok(automationCurrent);
      automationCurrent = {
        ...automationCurrent!,
        state: "completed",
        phase: "done",
        imported,
        eligible,
        failed: 0,
      };
      candidateCount += eligible;
    },
    setCandidates: (count: number) => {
      candidateCount = count;
    },
    setConfigKey: (value: string) => {
      configKey = value;
    },
    setPaused: (value: boolean) => {
      store.set("paused", value);
    },
    setQuota: (value: number) => {
      quotaRemaining = value;
    },
    replaceBulk: () => {
      bulkCurrent = { ...bulkCurrent!, id: "unrelated-bulk", state: "running" };
    },
    close: async () => {
      await app.close();
      store.close();
    },
  };
}

function randomId() {
  return `${Math.random().toString(16).slice(2)}-${Date.now()}`;
}

test("零候选时先采集评分，再发送新增合格候选", async () => {
  const f = await fixture();
  try {
    await f.start();
    assert.equal(f.starts.automation, 1);
    assert.equal(f.starts.bulk, 0);
    f.finishAutomation(4, 1);
    await f.pump();
    assert.equal(f.starts.bulk, 1);
    assert.equal((await f.state()).phase, "sending");
    f.finishBulk();
    await f.pump();
    assert.equal((await f.state()).counts.planned, 1);
    assert.equal(f.starts.bulk, 1);
    assert.equal(f.starts.automation, 2);
  } finally {
    await f.close();
  }
});

test("空候选预览仍冻结并展示待填充标题的两段话术", async () => {
  const f = await fixture();
  try {
    const preview = await f.preview();
    assert.deepEqual(preview.messageTemplates, [
      "您好，我对{{title}}感兴趣。",
      "我有相关经验，期待沟通。",
    ]);
    assert.equal(preview.applications.length, 0);
  } finally {
    await f.close();
  }
});

test("完成一批后继续补采，达到目标后不超投", async () => {
  const f = await fixture({ candidates: 1 });
  try {
    await f.start({ target: 2 });
    assert.equal(f.starts.bulk, 1);
    f.finishBulk();
    await f.pump();
    assert.equal(f.starts.automation, 1);
    f.finishAutomation(3, 1);
    await f.pump();
    assert.equal(f.starts.bulk, 2);
    f.finishBulk();
    await f.pump();
    assert.equal((await f.state()).state, "completed");
    assert.equal((await f.state()).counts.planned, 2);
    assert.equal(f.starts.bulk, 2);
    assert.equal(f.starts.automation, 1);
  } finally {
    await f.close();
  }
});

test("连续空轮结束且不降低条件；单轮上限生效", async () => {
  const f = await fixture();
  try {
    await f.start({ target: 5, maxRounds: 5, maxJobsPerRound: 10 });
    f.finishAutomation(0, 0);
    await f.pump();
    assert.equal(f.starts.automation, 2);
    f.finishAutomation(0, 0);
    await f.pump();
    assert.equal((await f.state()).state, "completed");
    assert.equal((await f.state()).rounds, 2);
    assert.match((await f.state()).message, /未降低筛选门槛/);
  } finally {
    await f.close();
  }
  const capped = await fixture();
  try {
    await capped.start({ target: 5, maxRounds: 1 });
    capped.finishAutomation(0, 0);
    await capped.pump();
    assert.equal((await capped.state()).state, "completed");
    assert.equal((await capped.state()).rounds, 1);
  } finally {
    await capped.close();
  }
});

test("全批累计采集预算硬限制为 300", async () => {
  const f = await fixture();
  try {
    await f.start({ target: 150, maxRounds: 5, maxJobsPerRound: 100 });
    for (let round = 0; round < 3; round++) {
      f.finishAutomation(100, 1);
      await f.pump();
      assert.equal(f.starts.bulk, round + 1);
      f.finishBulk();
      await f.pump();
    }
    const state = await f.state();
    assert.equal(state.state, "completed");
    assert.equal(state.rounds, 3);
    assert.equal(state.budgetUsed, 300);
  } finally {
    await f.close();
  }
});

test("配置漂移和全局暂停使工作流暂停，人工暂停不会被 pump 自动恢复", async () => {
  const f = await fixture({ candidates: 1 });
  try {
    await f.start();
    f.setPaused(true);
    await f.pump();
    assert.equal((await f.state()).state, "paused");
    assert.deepEqual(f.controls, ["bulk:pause:bulk-1"]);
    await f.request("/api/bulk-workflow/control", { action: "resume" });
    assert.equal((await f.state()).state, "paused");
    f.setPaused(false);
    await f.request("/api/bulk-workflow/control", { action: "resume" });
    await f.pump();
    assert.equal((await f.state()).state, "running");
    await f.request("/api/bulk-workflow/control", { action: "pause" });
    const before = f.starts.bulk + f.starts.automation;
    await f.pump();
    assert.equal((await f.state()).state, "paused");
    assert.equal(f.starts.bulk + f.starts.automation, before);
  } finally {
    await f.close();
  }
  const drift = await fixture({ candidates: 1 });
  try {
    await drift.start();
    drift.setConfigKey("changed");
    await drift.pump();
    assert.equal((await drift.state()).state, "paused");
    assert.match((await drift.state()).message, /配置已变化/);
    assert.deepEqual(drift.controls, ["bulk:pause:bulk-1"]);
  } finally {
    await drift.close();
  }
});

test("同一 workflow 重复 pump 与重启后不会重复创建当前子任务", async () => {
  const f = await fixture();
  try {
    await f.start();
    const before = f.starts.automation;
    await Promise.all([f.pump(), f.pump(), f.pump()]);
    assert.equal(f.starts.automation, before);
    await f.restart();
    await f.pump();
    assert.equal(f.starts.automation, before);
    assert.equal((await f.state()).phase, "collecting");
  } finally {
    await f.close();
  }
});

test("取消不接管或取消已被替换的子任务", async () => {
  const f = await fixture({ candidates: 1 });
  try {
    await f.start();
    f.replaceBulk();
    const response = await f.request("/api/bulk-workflow/control", {
      action: "cancel",
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().run.state, "cancelled");
    assert.deepEqual(f.controls, []);
  } finally {
    await f.close();
  }
});

test("已预留最后一个名额的子批次可以完成，不被零剩余额度提前暂停", async () => {
  const f = await fixture({ candidates: 1 });
  try {
    f.setQuota(1);
    await f.start({ target: 1, dailyLimit: 1 });
    f.setQuota(0);
    await f.pump();
    assert.equal((await f.state()).state, "running");
    assert.deepEqual(f.controls, []);
    f.finishBulk();
    await f.pump();
    assert.equal((await f.state()).state, "completed");
    assert.equal((await f.state()).counts.completed, 1);
  } finally { await f.close(); }
});

test("前两轮没有候选仍尝试第三个配置关键词，随后按上限结束", async () => {
  const f = await fixture();
  try {
    await f.start({ keywords: ["Java", "后端", "AI应用开发"], maxRounds: 3 });
    for (let round = 0; round < 3; round++) {
      f.finishAutomation(0, 0);
      await f.pump();
      assert.equal((await f.state()).state, round === 2 ? "completed" : "running");
    }
    assert.deepEqual(f.keywordStarts, ["Java", "后端", "AI应用开发"]);
    assert.equal(f.starts.bulk, 0);
  } finally { await f.close(); }
});

test("子批次刚刚完成时取消工作流，不再调用已完成子批次的取消接口", async () => {
  const f = await fixture({ candidates: 1 });
  try {
    await f.start();
    f.finishBulk();
    const result = await f.request("/api/bulk-workflow/control", { action: "cancel" });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().run.state, "cancelled");
    assert.deepEqual(f.controls, []);
  } finally { await f.close(); }
});

test("人工继续恰好已完成的失败子批次，其旧计数不会覆盖工作流的显式重置", async () => {
  const f = await fixture({ candidates: 1 });
  try {
    await f.start({ target: 3 });
    f.finishBulk({ completed: 0, review: 1 }, 1);
    const paused = await f.request("/api/bulk-workflow/control", { action: "pause" });
    assert.equal(paused.statusCode, 200, paused.body);
    const resumed = await f.request("/api/bulk-workflow/control", { action: "resume" });
    assert.equal(resumed.statusCode, 200, resumed.body);
    await f.pump();
    assert.equal((await f.state()).phase, "collecting");
    assert.equal(f.store.get<any>("bulkWorkflow.current", null).consecutiveJobFailures, 0);
    f.finishAutomation(1, 1);
    await f.pump();
    assert.deepEqual(f.failureSeeds, [0, 0]);
    assert.equal(f.starts.bulk, 2);
  } finally { await f.close(); }
});

test("旧父批次在补采期间从已完成子批次归档恢复失败次数，成功归档会重置", async () => {
  for (const hadSuccess of [false, true]) {
    const f = await fixture();
    try {
      await f.start({ target: 3 });
      const run = f.store.get<any>("bulkWorkflow.current", null);
      delete run.consecutiveJobFailures;
      run.childTotals = [{ bulkId: "legacy-child", planned: 1, completed: hadSuccess ? 1 : 0, review: hadSuccess ? 0 : 1, skipped: 0 }];
      run.counts.planned = 1;
      f.store.set("bulkWorkflow.current", run);
      f.store.set("bulk.history:legacy-child", {
        id: "legacy-child", state: "completed", consecutiveJobFailures: hadSuccess ? 0 : 1,
        counts: { completed: hadSuccess ? 1 : 0, review: hadSuccess ? 0 : 1 },
      });
      await f.restart();
      await f.pump();
      assert.equal(f.store.get<any>("bulkWorkflow.current", null).consecutiveJobFailures, hadSuccess ? 0 : 1);
      f.finishAutomation(1, 1);
      await f.pump();
      assert.deepEqual(f.failureSeeds, [hadSuccess ? 0 : 1]);
    } finally { await f.close(); }
  }
});

test("旧父批次合并三个独立失败归档后立即暂停，不会新建第四个发送子批次", async () => {
  const f = await fixture();
  try {
    await f.start({ target: 5 });
    const run = f.store.get<any>("bulkWorkflow.current", null);
    delete run.consecutiveJobFailures;
    run.childTotals = Array.from({ length: 3 }, (_, index) => ({ bulkId: `legacy-failed-${index}`, planned: 1, completed: 0, review: 1, skipped: 0 }));
    run.counts.planned = 3;
    for (const child of run.childTotals) f.store.set(`bulk.history:${child.bulkId}`, {
      id: child.bulkId, state: "completed", consecutiveJobFailures: 1,
      counts: { completed: 0, review: 1 },
    });
    f.store.set("bulkWorkflow.current", run);
    await f.pump();
    assert.equal((await f.state()).state, "paused");
    assert.equal(f.store.get<any>("bulkWorkflow.current", null).consecutiveJobFailures, 3);
    assert.equal(f.starts.bulk, 0);
    assert.match((await f.state()).message, /连续 3 个岗位/);
  } finally { await f.close(); }
});

test("缺少旧归档时按持久化应用动作恢复；缺少结果先后证据则暂停而非猜零", async () => {
  for (const ambiguous of [false, true]) {
    const applications = [{ id: "legacy-app-failed", bulkRunId: "legacy-child", status: "needs-review", stopReason: "send-unconfirmed", actions: ambiguous ? [] : [{ id: "native", state: "unknown", updatedAt: "2026-10-15T01:00:00Z" }] }] as Application[];
    if (ambiguous) applications.push({ id: "legacy-app-success", bulkRunId: "legacy-child", status: "completed", actions: [] } as unknown as Application);
    const f = await fixture({ applications });
    try {
      await f.start({ target: 3 });
      const run = f.store.get<any>("bulkWorkflow.current", null);
      delete run.consecutiveJobFailures;
      run.childTotals = [{ bulkId: "legacy-child", planned: ambiguous ? 2 : 1, completed: ambiguous ? 1 : 0, review: 1, skipped: 0 }];
      run.counts.planned = ambiguous ? 2 : 1;
      f.store.set("bulkWorkflow.current", run);
      await f.pump();
      if (ambiguous) {
        assert.equal((await f.state()).state, "paused");
        assert.match((await f.state()).message, /无法完整还原/);
        assert.equal(f.store.get<any>("bulkWorkflow.current", null).consecutiveJobFailures, undefined);
      } else {
        assert.equal((await f.state()).state, "running");
        assert.equal(f.store.get<any>("bulkWorkflow.current", null).consecutiveJobFailures, 1);
      }
    } finally { await f.close(); }
  }
});

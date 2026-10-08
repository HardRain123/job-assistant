import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Store } from "../packages/storage/src/index.ts";
import { createApp } from "../apps/api/src/app.ts";
import { DEFAULT_POLICY } from "../packages/contracts/src/index.ts";

test("模型连接错误返回固定中文提示并隐藏桥接正文", async () => {
  const dir = mkdtempSync(join(tmpdir(), "job-assistant-error-test-"));
  const store = new Store(join(dir, "test.sqlite"));
  let errorBody: unknown = {
    error: "workspace_requirements_unavailable",
    details: "secret",
  };
  const model = createServer((_req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify(errorBody));
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const { port } = model.address() as { port: number };
  const app = await createApp({
    store,
    password: "test-password",
    key: "test-key",
    internalToken: "test-internal",
    dataDir: dir,
    attachmentsDir: join(dir, "attachments"),
    bridgeUrl: `http://127.0.0.1:${port}`,
  });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "test-password" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const saved = await app.inject({
      method: "PUT",
      url: "/api/providers",
      headers: { cookie },
      payload: [
        {
          id: "bridge",
          name: "测试桥接",
          kind: "codex",
          baseUrl: `http://127.0.0.1:${port}`,
          model: "fixture",
          protocol: "chat-completions",
          enabled: true,
          priority: 0,
          timeoutMs: 1000,
        },
      ],
    });
    assert.equal(saved.statusCode, 200, saved.body);
    for (const [body, expected] of [
      [
        { error: "workspace_requirements_unavailable", details: "secret" },
        "ChatGPT 工作区要求加载失败，尚未完成模型调用；请检查桥接服务连接与账号配置。",
      ],
      [
        { error: "unknown secret failed to load workspace requirements" },
        "所有已配置的模型均调用失败，请检查模型连接与配置。",
      ],
    ]) {
      errorBody = body;
      const response = await app.inject({
        method: "POST",
        url: "/api/providers/test",
        headers: { cookie },
        payload: { id: "bridge" },
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), { error: expected });
      assert.ok(!response.body.includes("secret"));
    }
  } finally {
    await app.close();
    store.close();
    await new Promise<void>((resolve, reject) =>
      model.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test("本地工作台鉴权、简历/模型/话术/岗位/评分/预览完整流程", async () => {
  const dir = mkdtempSync(join(tmpdir(), "job-assistant-test-"));
  const store = new Store(join(dir, "test.sqlite"));
  const scores = Object.fromEntries(
    [
      "skills",
      "responsibilities",
      "experience",
      "qualifications",
      "preferences",
    ].map((k) => [
      k,
      {
        score: 94,
        evidence: "匿名样例岗位与简历包含 Java、AI 应用开发，经验满足要求",
      },
    ]),
  );
  const model = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          { message: { content: JSON.stringify({ dimensions: scores }) } },
        ],
      }),
    );
  });
  await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
  const address = model.address() as { port: number };
  const app = await createApp({
    store,
    password: "test-password",
    key: "test-key",
    internalToken: "test-internal",
    dataDir: dir,
    attachmentsDir: join(dir, "attachments"),
  });
  try {
    assert.equal((await app.inject("/api/state")).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/login",
          headers: { origin: "https://evil.example" },
          payload: { password: "test-password" },
        })
      ).statusCode,
      403,
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "test-password" },
    });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const call = async (
      method: "GET" | "POST" | "PUT",
      url: string,
      payload?: unknown,
    ) => {
      const res = await app.inject({
        method,
        url,
        headers: { cookie },
        payload: payload as string,
      });
      assert.equal(res.statusCode, 200, res.body);
      return res.json();
    };
    await call("PUT", "/api/resume", {
      name: "匿名候选人",
      text: "7年Java后端开发经验，熟悉Spring Boot，近期负责企业AI应用、RAG与Agent开发。",
      skills: ["Java", "AI", "Spring Boot"],
      years: 7,
    });
    await call("PUT", "/api/providers", [
      {
        id: "mock",
        name: "测试模型",
        kind: "openai-compatible",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "fixture",
        protocol: "chat-completions",
        enabled: true,
        priority: 0,
        timeoutMs: 3000,
        apiKey: "private-token",
      },
    ]);
    assert.ok(
      !JSON.stringify(await call("GET", "/api/state")).includes(
        "private-token",
      ),
    );
    assert.ok(
      !String(
        store.db
          .prepare("SELECT value FROM settings WHERE key='providers'")
          .get()?.value,
      ).includes("private-token"),
    );
    await call("PUT", "/api/policy", DEFAULT_POLICY);
    await call("PUT", "/api/template", {
      name: "测试",
      segments: [
        "您好，看到{{title}}与我的经历比较匹配。",
        "我有{{years}}年经验，熟悉{{skills}}。",
      ],
      attachmentPolicy: "message-only",
    });
    const job = {
      id: "job1",
      source: "boss",
      sourceId: "s1",
      sourceJobId: "j1",
      url: "https://www.zhipin.com/job_detail/fixture.html",
      company: "匿名软件公司",
      companyAliases: [],
      industry: "软件",
      title: "Java AI应用开发",
      location: "上海",
      remote: false,
      salaryMin: 22000,
      salaryMax: 32000,
      salaryMonths: 13,
      experienceMin: 5,
      description:
        "负责Java后端与AI应用开发，熟悉Spring Boot，5年以上开发经验。",
      skills: ["Java", "AI", "Spring Boot"],
      education: null,
      firstSeen: "2026-01-01",
      lastSeen: "2026-01-01",
      contentHash: "fixturehash",
      status: "active",
    };
    await call("POST", "/api/jobs/import", [job]);
    const result = await call("POST", "/api/assess", { jobIds: ["job1"] });
    assert.equal(result[0].decision, "eligible");
    const preview = await call("POST", "/api/batches/preview", {
      jobIds: ["job1"],
    });
    assert.deepEqual(preview.applications[0].frozenMessages, [
      "您好，看到Java AI应用开发与我的经历比较匹配。",
      "我有7年经验，熟悉Java、AI、Spring Boot。",
    ]);
    const send = await app.inject({
      method: "POST",
      url: "/api/batches",
      headers: { cookie },
      payload: { previewId: preview.previewId },
    });
    assert.equal(send.statusCode, 400);
    assert.equal(store.applications().length, 0);
    const jobs = await call("POST", "/api/jobs/search", {
      company: "匿名",
      salaryMin: 20000,
    });
    assert.equal(jobs.length, 1);
    const saved = await call("GET", "/api/export");
    assert.equal(saved.jobs.length, 1);
    const backup = await app.inject({
      method: "POST",
      url: "/api/backup",
      headers: { cookie },
    });
    assert.equal(backup.statusCode, 200);
    assert.equal(
      backup.rawPayload.subarray(0, 15).toString(),
      "SQLite format 3",
    );
    const source = await call("POST", "/api/sources", {
      name: "匿名官网",
      kind: "official",
      url: "https://careers.example.com",
      allowedHosts: ["careers.example.com"],
      enabled: true,
    });
    await call("POST", `/api/sources/${source.id}/sync`, {});
    const serviceHeaders = { authorization: "Bearer test-internal" };
    const claimed = await app.inject({
      method: "POST",
      url: "/internal/tasks/claim",
      headers: serviceHeaders,
      payload: { workerId: "test" },
    });
    const task = claimed.json().task;
    const callback = { leaseToken: task.leaseToken, result: { jobs: [] } };
    const completed = await app.inject({
      method: "POST",
      url: `/internal/tasks/${task.id}/result`,
      headers: serviceHeaders,
      payload: callback,
    });
    assert.equal(completed.statusCode, 200);
    const duplicate = await app.inject({
      method: "POST",
      url: `/internal/tasks/${task.id}/result`,
      headers: serviceHeaders,
      payload: callback,
    });
    assert.equal(duplicate.statusCode, 200);
    const changed = await app.inject({
      method: "POST",
      url: `/internal/tasks/${task.id}/result`,
      headers: serviceHeaders,
      payload: { ...callback, result: { jobs: [], error: "different" } },
    });
    assert.equal(changed.statusCode, 400);
    assert.equal(
      (await app.inject({ method: "POST", url: "/internal/tasks/claim" }))
        .statusCode,
      401,
    );
    const failedTakeover = await app.inject({
      method: "POST",
      url: "/api/browser/takeover",
      headers: { cookie },
      payload: {},
    });
    assert.equal(failedTakeover.statusCode, 400);
    assert.equal(store.get("takeover", false), false);
    await call("POST", "/api/queue/resume", {});
    const current = store.get<Record<string, unknown>>("resume", {});
    store.set("resume", { ...current, attachmentName: "old-version.docx" });
    const edited = await call("PUT", "/api/resume", {
      name: "匿名候选人",
      text: "修改后的简历资料：更新企业AI应用项目经历和工作职责，Java后端开发。",
      skills: ["Java", "AI"],
      years: 7,
    });
    assert.equal(edited.attachmentName, null);
    await call("POST", "/api/logout");
    assert.equal(
      (await app.inject({ url: "/api/state", headers: { cookie } })).statusCode,
      401,
    );
  } finally {
    await app.close();
    store.close();
    model.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

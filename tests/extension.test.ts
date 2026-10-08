import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import Fastify from "fastify";
import { Store } from "../packages/storage/src/index.ts";
import { createApp } from "../apps/api/src/app.ts";
import { createExtensionAccess } from "../apps/api/src/extension.ts";

const origin = `chrome-extension://${"a".repeat(32)}`;
const otherOrigin = `chrome-extension://${"b".repeat(32)}`;
const item = (id = "fixture") => ({
  url: `https://www.zhipin.com/job_detail/${id}.html?ref=tracking#top`,
  title: "工程师",
  company: "公司",
  description: "完整职责与任职要求",
  salaryText: "20-30K",
  experienceText: "3-5年",
  detail: true,
});

test("扩展凭据隔离工作台和内部接口，绑定精确来源，且不泄露明文", async () => {
  const dir = mkdtempSync(join(tmpdir(), "extension-api-"));
  const store = new Store(join(dir, "test.sqlite"));
  const app = await createApp({
    store,
    password: "fixture-password",
    key: "fixture-key",
    internalToken: "fixture-internal",
    dataDir: dir,
    attachmentsDir: join(dir, "attachments"),
  });
  try {
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/extension/pair-code" }))
        .statusCode,
      401,
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { password: "fixture-password" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const code = (
      await app.inject({
        method: "POST",
        url: "/api/extension/pair-code",
        headers: { cookie },
      })
    ).json().code;
    const paired = await app.inject({
      method: "POST",
      url: "/extension/v1/pair",
      headers: { origin },
      payload: { code },
    });
    assert.equal(paired.statusCode, 200, paired.body);
    const token = paired.json().token;
    const authorization = `Bearer ${token}`;
    for (const path of ["/extension/v1/status", "/extension/v1/automation-status"]) {
      const valid = await app.inject({ method: "POST", url: path, headers: { origin, authorization } });
      assert.equal(valid.statusCode, 200, valid.body);
      assert.equal((await app.inject({ method: "POST", url: path, headers: { authorization } })).statusCode, 403);
    }
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/state",
          headers: { authorization },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/internal/tasks/claim",
          headers: { authorization },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/extension/v1/status",
          headers: { origin: otherOrigin, authorization },
        })
      ).statusCode,
      401,
    );
    for (const badOrigin of ["https://www.zhipin.com", `${origin}/`, "null"]) {
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/extension/v1/status",
            headers: { origin: badOrigin, authorization },
          })
        ).statusCode,
        403,
      );
    }
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/extension/v1/status",
          headers: { origin, authorization, host: "app" },
        })
      ).statusCode,
      403,
    );
    const status = await app.inject({
      method: "GET",
      url: "/api/extension/status",
      headers: { cookie },
    });
    assert.equal(status.json().paired, true);
    assert.ok(!status.body.includes(token));
    const stored = store.get<any>("browserExtension.connection", null);
    assert.equal(stored.hash, createHash("sha256").update(token).digest("hex"));
    const persisted = JSON.stringify({
      settings: store.db.prepare("SELECT * FROM settings").all(),
      audit: store.db.prepare("SELECT * FROM audit").all(),
    });
    assert.ok(!persisted.includes(token));
    assert.ok(!persisted.includes(code));
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function fixture() {
  const store = new Store(":memory:");
  let time = Date.UTC(2026, 0, 1);
  const access = createExtensionAccess(store, () => time);
  const app = Fastify();
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/extension/")) return access.guard(req, reply);
  });
  access.register(app);
  const code = async () =>
    (
      await app.inject({ method: "POST", url: "/api/extension/pair-code" })
    ).json().code;
  const pair = (value: string) =>
    app.inject({
      method: "POST",
      url: "/extension/v1/pair",
      headers: { origin },
      payload: { code: value },
    });
  const request = (
    token: string,
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: any,
  ) =>
    app.inject({
      method,
      url,
      headers: { origin, authorization: `Bearer ${token}` },
      payload,
    });
  return {
    app,
    store,
    code,
    pair,
    request,
    advance: (ms: number) => {
      time += ms;
    },
    close: async () => {
      await app.close();
      store.close();
    },
  };
}

test("扩展弹窗请求与真实 API 契约一致：配对、导入、查询和无请求体撤销", async () => {
  const f = await fixture();
  try {
    const popup = readFileSync(
      new URL("../apps/browser-extension/popup.js", import.meta.url),
      "utf8",
    ).replace(/^import .*\n/, "");
    const element = {
      addEventListener() {},
      classList: { toggle() {}, add() {} },
    };
    const { api, importPayload } = runInNewContext(
      popup + "\n({api, importPayload})",
      {
        document: { getElementById: () => element },
        chrome: {
          storage: {
            local: { setAccessLevel: async () => {}, get: async () => ({}) },
          },
        },
        AbortController,
        setTimeout,
        clearTimeout,
        fetch: async (url: string, options: any) => {
          assert.ok(url.startsWith("http://127.0.0.1:3000/extension/v1/"));
          assert.equal(options.credentials, "omit");
          assert.equal(options.redirect, "error");
          const response = await f.app.inject({
            method: options.method ?? "GET",
            url: new URL(url).pathname,
            headers: { ...options.headers, origin },
            payload: options.body,
          });
          return {
            ok: response.statusCode < 400,
            status: response.statusCode,
            json: async () => response.json(),
          };
        },
      },
    );
    const pair = await api("/extension/v1/pair", {
      method: "POST",
      body: JSON.stringify({ code: await f.code() }),
    });
    const headers = { Authorization: `Bearer ${pair.token}` };
    const jobs = importPayload([
      { ...item(), sourceJobId: "client-field", secret: "must-not-send" },
    ]);
    const imported = await api("/extension/v1/jobs", {
      method: "POST",
      headers,
      body: JSON.stringify({ jobs }),
    });
    assert.equal(imported.count, 1);
    assert.equal(
      (await api("/extension/v1/status", { method: "POST", headers })).connected,
      true,
    );
    assert.equal(
      (await api("/extension/v1/connection", { method: "DELETE", headers })).ok,
      true,
    );
    await assert.rejects(api("/extension/v1/status", { method: "POST", headers }), /已失效/);
  } finally {
    await f.close();
  }
});

test("配对码单次使用、错误次数限制、过期、连接替换和撤销", async () => {
  const f = await fixture();
  try {
    const firstCode = await f.code();
    assert.equal((await f.pair("0".repeat(32))).statusCode, 401);
    const first = (await f.pair(firstCode)).json().token;
    assert.equal((await f.pair(firstCode)).statusCode, 401);
    const second = (await f.pair(await f.code())).json().token;
    assert.equal(
      (await f.request(first, "POST", "/extension/v1/status")).statusCode,
      401,
    );
    assert.equal(
      (await f.request(second, "POST", "/extension/v1/status")).statusCode,
      200,
    );
    const expired = await f.code();
    f.advance(5 * 60000);
    assert.equal((await f.pair(expired)).statusCode, 401);
    const exhausted = await f.code();
    for (let n = 0; n < 10; n++)
      assert.equal((await f.pair("0".repeat(32))).statusCode, 401);
    assert.equal((await f.pair(exhausted)).statusCode, 401);
    const third = (await f.pair(await f.code())).json().token;
    f.advance(7 * 86400000);
    assert.equal(
      (await f.request(third, "POST", "/extension/v1/status")).statusCode,
      401,
    );
    const fourth = (await f.pair(await f.code())).json().token;
    const pending = await f.code();
    assert.equal(
      (await f.request(fourth, "DELETE", "/extension/v1/connection"))
        .statusCode,
      200,
    );
    assert.equal(
      (await f.request(fourth, "POST", "/extension/v1/status")).statusCode,
      401,
    );
    assert.equal((await f.pair(pending)).statusCode, 401);
  } finally {
    await f.close();
  }
});

test("岗位导入规范化、去重、保留详情，并整批拒绝非法链接与额外字段", async () => {
  const f = await fixture();
  try {
    const token = (await f.pair(await f.code())).json().token;
    const importJobs = (jobs: any[]) =>
      f.request(token, "POST", "/extension/v1/jobs", { jobs });
    const imported = await importJobs([item(), item()]);
    assert.equal(imported.statusCode, 200, imported.body);
    assert.equal(imported.json().count, 1);
    const saved = f.store.jobs()[0]!;
    assert.equal(saved.sourceJobId, "fixture");
    assert.equal(saved.sourceId, "boss-browser-extension");
    assert.equal(saved.url, "https://www.zhipin.com/job_detail/fixture.html");
    assert.equal(saved.salaryMin, 20000);
    assert.equal(saved.salaryMax, 30000);
    assert.equal(saved.experienceMin, 3);
    assert.equal((await importJobs([{ ...item(), companyAliases: ["展示名", "展示名"] }])).statusCode, 200);
    assert.deepEqual(f.store.jobs()[0]!.companyAliases, ["展示名"]);
    assert.ok((await importJobs([{ ...item(), companyAliases: Array(6).fill("过多别名") }])).statusCode >= 400);
    await importJobs([
      { ...item(), detail: false, description: "列表摘要", title: "列表标题" },
    ]);
    assert.equal(f.store.jobs().length, 1);
    assert.equal(f.store.jobs()[0]!.id, saved.id);
    assert.equal(f.store.jobs()[0]!.description, saved.description);
    for (const badUrl of [
      "https://evil.example/job_detail/bad.html",
      "http://www.zhipin.com/job_detail/bad.html",
      "https://user@www.zhipin.com/job_detail/bad.html",
      "https://www.zhipin.com/jobs/bad",
    ]) {
      const before = f.store.get<any>(
        "browserExtension.connection",
        null,
      ).importedCount;
      assert.ok(
        (await importJobs([item("new"), { ...item("bad"), url: badUrl }]))
          .statusCode >= 400,
      );
      assert.equal(f.store.jobs().length, 1);
      assert.equal(
        f.store.get<any>("browserExtension.connection", null).importedCount,
        before,
      );
    }
    assert.ok(
      (
        await importJobs([
          { ...item("extra"), status: "applied", arbitrary: true },
        ])
      ).statusCode >= 400,
    );
    assert.equal(f.store.jobs().length, 1);
  } finally {
    await f.close();
  }
});

test("扩展预检权限受限，导入批次有上限，列表可更新且不扩大令牌权限", async () => {
  const f = await fixture();
  try {
    const preflight = await f.app.inject({
      method: "OPTIONS",
      url: "/extension/v1/jobs",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], origin);
    assert.equal(
      preflight.headers["access-control-allow-credentials"],
      undefined,
    );
    for (const headers of [
      { origin, "access-control-request-method": "PUT" },
      {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "cookie",
      },
      {
        origin: "http://evil.example",
        "access-control-request-method": "POST",
      },
    ])
      assert.equal(
        (
          await f.app.inject({
            method: "OPTIONS",
            url: "/extension/v1/jobs",
            headers,
          })
        ).statusCode,
        403,
      );
    const token = (await f.pair(await f.code())).json().token;
    assert.equal(
      (await f.request(token, "POST", "/extension/v1/send", {})).statusCode,
      403,
    );
    const importJobs = (jobs: any[]) =>
      f.request(token, "POST", "/extension/v1/jobs", { jobs });
    assert.ok(
      (await importJobs(Array.from({ length: 31 }, (_, n) => item(String(n)))))
        .statusCode >= 400,
    );
    assert.equal(f.store.jobs().length, 0);
    await importJobs([{ ...item(), detail: false, description: "原始摘要" }]);
    await importJobs([
      {
        ...item(),
        detail: false,
        description: "更新摘要",
        salaryText: "25-35K",
      },
    ]);
    assert.equal(f.store.jobs().length, 1);
    assert.equal(f.store.jobs()[0]!.salaryMin, 25000);
    assert.equal(f.store.jobs()[0]!.description, "更新摘要");
    await importJobs([{ ...item(), salaryText: "300-500元/天" }]);
    assert.equal(f.store.jobs()[0]!.salaryMin, null);
  } finally {
    await f.close();
  }
});

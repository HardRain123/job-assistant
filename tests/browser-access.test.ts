import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
  createWorker,
  type BrowserSession,
} from "../apps/browser-worker/src/index.ts";
import { createApp } from "../apps/api/src/app.ts";
import { Store } from "../packages/storage/src/index.ts";

function upgrade(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; socket?: Socket }> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    req.on("error", reject);
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode! });
    });
    req.on("upgrade", (res, socket) => {
      socket.on("error", () => {});
      resolve({ status: res.statusCode!, socket });
    });
    req.setTimeout(5000, () => req.destroy(new Error("Upgrade timed out")));
    req.end();
  });
}

test("浏览器 HTTP/WS 需双层认证；跨站、未接管拒绝；退出或结束接管断开现有控制连接", async () => {
  const dir = mkdtempSync(join(tmpdir(), "job-browser-access-"));
  const token = "isolated-test-service-token";
  writeFileSync(join(dir, "token"), token);
  const sockets = new Set<Duplex>();
  const paths: string[] = [];
  const leakedHeaders: string[] = [];
  const desktop = createServer((req, res) => {
    paths.push(req.url!);
    if (req.headers.cookie || req.headers.authorization)
      leakedHeaders.push("http");
    res.setHeader("content-type", "text/html");
    res.end("<title>Fixture desktop</title>");
  });
  desktop.on("upgrade", (req, socket) => {
    paths.push(req.url!);
    if (req.headers.cookie || req.headers.authorization)
      leakedHeaders.push("ws");
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("end", () => socket.destroy());
    const accept = createHash("sha1")
      .update(
        String(req.headers["sec-websocket-key"]) +
          "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      )
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  await new Promise<void>((resolve) => desktop.listen(0, "127.0.0.1", resolve));
  const desktopPort = (desktop.address() as { port: number }).port;
  const session: BrowserSession = {
    active: false,
    page: null,
    async start() {
      Object.assign(this, { active: true });
    },
    async stop() {
      Object.assign(this, { active: false });
    },
  };
  const worker = await createWorker(
    {
      appUrl: "http://127.0.0.1",
      tokenFile: join(dir, "token"),
      port: 0,
      viewerEnabled: true,
      viewerUrl: `http://127.0.0.1:${desktopPort}`,
      logger: false,
    },
    session,
  );
  const workerUrl = await worker.app.listen({ host: "127.0.0.1", port: 0 });
  const store = new Store(":memory:");
  const app = await createApp({
    store,
    password: "fixture-password",
    key: "fixture-key",
    internalToken: token,
    dataDir: dir,
    attachmentsDir: join(dir, "attachments"),
    workerUrl,
  });
  const appUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const clients: Socket[] = [];
  try {
    assert.equal((await fetch(workerUrl + "/browser/vnc.html")).status, 401);
    assert.equal(
      (await upgrade(workerUrl + "/browser/websockify")).status,
      401,
    );
    assert.equal((await fetch(appUrl + "/browser/vnc.html")).status, 401);
    assert.equal((await upgrade(appUrl + "/browser/websockify")).status, 401);
    const login = await fetch(appUrl + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "fixture-password" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const headers = { cookie, "content-type": "application/json" };
    assert.equal(
      (await upgrade(appUrl + "/browser/websockify", { cookie })).status,
      409,
    );
    const start = await fetch(appUrl + "/api/browser/takeover", {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(start.status, 200, await start.text());
    assert.equal(
      (
        await upgrade(appUrl + "/browser/websockify", {
          cookie,
          origin: "https://unrelated.example",
        })
      ).status,
      403,
    );
    const page = await fetch(appUrl + "/browser/vnc.html", {
      headers: { cookie },
    });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Fixture desktop/);
    const first = await upgrade(appUrl + "/browser/websockify", {
      cookie,
      origin: appUrl,
    });
    assert.equal(first.status, 101);
    clients.push(first.socket!);
    // Wait until the second proxy has connected, before testing connection revocation.
    for (let i = 0; i < 50 && !paths.includes("/websockify"); i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(paths.includes("/vnc.html"));
    assert.ok(paths.includes("/websockify"));
    assert.deepEqual(leakedHeaders, []);
    const ended = once(first.socket!, "close");
    const release = await fetch(appUrl + "/api/browser/release", {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(release.status, 200);
    await ended;
    assert.equal(
      session.active,
      true,
      "release retains current page for collection",
    );
    assert.equal(
      (await upgrade(appUrl + "/browser/websockify", { cookie })).status,
      409,
    );
    assert.equal(
      (
        await fetch(appUrl + "/api/browser/takeover", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      200,
    );
    const second = await upgrade(appUrl + "/browser/websockify", {
      cookie,
      origin: appUrl,
    });
    clients.push(second.socket!);
    assert.equal(second.status, 101);
    const closed = once(second.socket!, "close");
    assert.equal(
      (
        await fetch(appUrl + "/api/logout", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      200,
    );
    await closed;
    assert.equal(
      (await fetch(appUrl + "/browser/vnc.html", { headers: { cookie } }))
        .status,
      401,
    );
  } finally {
    for (const socket of clients) socket.destroy();
    for (const socket of sockets) socket.destroy();
    await app.close();
    await worker.stop();
    store.close();
    desktop.closeAllConnections();
    await new Promise<void>((resolve) => desktop.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("浏览器启动失败释放接管锁，未配置本机桌面时不尝试启动浏览器", async () => {
  const dir = mkdtempSync(join(tmpdir(), "job-browser-failure-"));
  writeFileSync(join(dir, "token"), "fixture-token");
  let starts = 0;
  const session: BrowserSession = {
    active: false,
    page: null,
    async start() {
      starts++;
      throw new Error("fixture browser missing");
    },
    async stop() {},
  };
  const worker = await createWorker(
    {
      appUrl: "http://127.0.0.1",
      tokenFile: join(dir, "token"),
      port: 0,
      viewerEnabled: true,
      viewerUrl: "http://127.0.0.1:6080",
      logger: false,
    },
    session,
  );
  try {
    const r = await worker.app.inject({
      method: "POST",
      url: "/takeover/start",
      headers: { authorization: "Bearer fixture-token" },
      payload: {},
    });
    assert.equal(r.statusCode, 503);
    assert.equal(worker.status().takeover, false);
    assert.equal(starts, 1);
    const disabled = await createWorker(
      {
        appUrl: "http://127.0.0.1",
        tokenFile: join(dir, "token"),
        port: 0,
        viewerEnabled: false,
        logger: false,
      },
      session,
    );
    try {
      const response = await disabled.app.inject({
        method: "POST",
        url: "/takeover/start",
        headers: { authorization: "Bearer fixture-token" },
        payload: {},
      });
      assert.equal(response.statusCode, 503);
      assert.equal(starts, 1);
    } finally {
      await disabled.stop();
    }
  } finally {
    await worker.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

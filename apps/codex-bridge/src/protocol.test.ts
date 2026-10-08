import assert from "node:assert/strict";
import test from "node:test";
import { createBridge } from "./index.ts";
import {
  CodexClient,
  CodexProtocolError,
  StdioAppServer,
  type RpcTransport,
} from "./protocol.ts";

const safeConfig = {
  features: {
    shell_tool: false,
    unified_exec: false,
    apps: false,
    multi_agent: false,
    hooks: false,
    remote_plugin: false,
  },
  web_search: "disabled",
  agents: { enabled: false },
  mcp_servers: {},
  plugins: {},
};

class FakeRpc implements RpcTransport {
  readonly calls: string[] = [];
  readonly params = new Map<string, any>();
  private listener?: (message: { method?: string; params?: any }) => void;
  constructor(
    private readonly config: unknown = safeConfig,
    private readonly action: "idle" | "tool" | "failed" = "idle",
    private readonly failureMessage: unknown = "failed to load workspace requirements: secret",
  ) {}
  async request(method: string, params?: unknown): Promise<any> {
    this.calls.push(method);
    this.params.set(method, params);
    if (method === "config/read") return { config: this.config };
    if (method === "thread/start") return { thread: { id: "thread-1" } };
    if (method === "turn/start") {
      if (this.action === "failed")
        queueMicrotask(() =>
          this.listener?.({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: {
                status: "failed",
                error: { message: this.failureMessage },
              },
            },
          }),
        );
      if (this.action === "tool")
        queueMicrotask(() =>
          this.listener?.({
            method: "item/started",
            params: {
              threadId: "thread-1",
              item: { type: "commandExecution" },
            },
          }),
        );
      return { turn: { id: "turn-1" } };
    }
    return {};
  }
  notify(): void {}
  subscribe(
    listener: (message: { method?: string; params?: any }) => void,
  ): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  close(): void {}
}

test("bridge requires its bearer token for every non-health route", async () => {
  const bridge = createBridge(
    new CodexClient(new FakeRpc()),
    "a".repeat(48),
    "/tmp/scoring",
  );
  try {
    assert.equal(
      (await bridge.inject({ method: "GET", url: "/health" })).statusCode,
      200,
    );
    assert.equal(
      (await bridge.inject({ method: "GET", url: "/models" })).statusCode,
      401,
    );
    assert.equal(
      (
        await bridge.inject({
          method: "POST",
          url: "/chat",
          headers: { authorization: "Bearer wrong" },
          payload: {
            model: "x",
            messages: [{ role: "user", content: "hello" }],
          },
        })
      ).statusCode,
      401,
    );
  } finally {
    await bridge.close();
  }
});

test("chat fails closed if a tool cannot be ruled out", async () => {
  const rpc = new FakeRpc({
    ...safeConfig,
    features: { ...safeConfig.features, shell_tool: true },
  });
  await assert.rejects(
    new CodexClient(rpc).chat(
      "model",
      [{ role: "user", content: "hello" }],
      "/tmp/scoring",
    ),
    /tool isolation/,
  );
  assert.ok(!rpc.calls.includes("thread/start"));
});

test("chat rejects a tool item before returning any model text", async () => {
  const rpc = new FakeRpc(safeConfig, "tool");
  await assert.rejects(
    new CodexClient(rpc).chat(
      "model",
      [{ role: "user", content: "hello" }],
      "/tmp/scoring",
      100,
    ),
    CodexProtocolError,
  );
});

test("chat times out and interrupts a stalled turn", async () => {
  const rpc = new FakeRpc();
  await assert.rejects(
    new CodexClient(rpc).chat(
      "model",
      [{ role: "user", content: "hello" }],
      "/tmp/scoring",
      10,
    ),
    /timed out/,
  );
  assert.ok(rpc.calls.includes("turn/interrupt"));
  // The pinned CLI rejects legacy readOnly.access. Keep scoring environmentless
  // and explicitly bounded rather than weakening its permissions to recover.
  assert.equal(rpc.params.get("initialize").capabilities.experimentalApi, true);
  const thread = rpc.params.get("thread/start");
  const turn = rpc.params.get("turn/start");
  assert.deepEqual(thread.environments, []);
  assert.deepEqual(turn.environments, []);
  assert.equal(thread.permissions, "job_scoring");
  assert.equal(thread.config.default_permissions, thread.permissions);
  assert.equal(turn.permissions, "job_scoring");
  assert.equal(thread.sandbox, undefined);
  assert.equal(turn.sandboxPolicy, undefined);
  assert.deepEqual(thread.config.permissions.job_scoring, {
    filesystem: { ":minimal": "read", ":workspace_roots": "read" },
    network: { enabled: false },
  });
});

test("RPC rejection preserves workspace failure classification", async () => {
  const pending = new Map();
  const rejection = new Promise((_resolve, reject) => {
    pending.set(1, { reject, timer: setTimeout(() => {}, 1000) });
  });
  (StdioAppServer.prototype as any).receive.call(
    { pending },
    JSON.stringify({
      id: 1,
      error: {
        code: -32603,
        message: "failed to load workspace requirements: secret",
      },
    }),
  );
  await assert.rejects(rejection, (error: unknown) => {
    assert.ok(error instanceof CodexProtocolError);
    assert.equal(error.code, "workspace_requirements_unavailable");
    return true;
  });
  assert.equal(pending.size, 0);
});

test("bridge classifies failed turns and returns only safe error codes", async () => {
  for (const [message, code] of [
    [
      "failed to load workspace requirements: secret",
      "workspace_requirements_unavailable",
    ],
    ["unknown error containing secret", "codex_chat_unavailable"],
    [{ secret: "malformed message" }, "codex_chat_unavailable"],
  ] as const) {
    const bridge = createBridge(
      new CodexClient(new FakeRpc(safeConfig, "failed", message)),
      "a".repeat(48),
      "/tmp/scoring",
    );
    try {
      const response = await bridge.inject({
        method: "POST",
        url: "/chat",
        headers: { authorization: `Bearer ${"a".repeat(48)}` },
        payload: {
          model: "fixture",
          messages: [{ role: "user", content: "hello" }],
        },
      });
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: code });
      assert.ok(!response.body.includes("secret"));
    } finally {
      await bridge.close();
    }
  }
});

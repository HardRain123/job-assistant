import test from "node:test";
import assert from "node:assert/strict";
import type {
  ProviderConfig,
  EmbeddingConfig,
} from "../../contracts/src/index.ts";
import {
  chat,
  embed,
  ProviderChainError,
  type ProviderEvent,
} from "./index.ts";

const provider = (
  id: string,
  priority: number,
  protocol: ProviderConfig["protocol"] = "chat-completions",
): ProviderConfig => ({
  id,
  name: id,
  kind: "openai-compatible",
  baseUrl: `https://${id}.example/v1`,
  model: "custom-model",
  protocol,
  enabled: true,
  priority,
  timeoutMs: 1000,
});

test("known bridge workspace errors fall back and emit a safe typed event", async () => {
  const events: ProviderEvent[] = [];
  const result = await chat(
    [{ ...provider("bridge", 1), kind: "codex" }, provider("backup", 2)],
    [{ role: "user", content: "hello" }],
    {
      onEvent: (event) => events.push(event),
      fetch: async (url) =>
        String(url).includes("bridge")
          ? Response.json(
              {
                error: "workspace_requirements_unavailable",
                details: "secret",
              },
              { status: 503 },
            )
          : Response.json({ choices: [{ message: { content: "OK" } }] }),
    },
  );
  assert.equal(result.providerId, "backup");
  assert.equal(result.text, "OK");
  assert.deepEqual(
    events.map(({ type, error }) => [type, error]),
    [
      ["attempt", undefined],
      ["failure", "workspace_requirements_unavailable"],
      ["attempt", undefined],
      ["success", undefined],
    ],
  );
  assert.ok(!JSON.stringify(events).includes("secret"));
});

test("unknown bridge error bodies never leak and are not classified by raw text", async () => {
  for (const body of [
    "secret failed to load workspace requirements",
    { error: "secret failed to load workspace requirements" },
  ]) {
    await assert.rejects(
      chat(
        [{ ...provider("bridge", 1), kind: "codex" }],
        [{ role: "user", content: "hello" }],
        {
          fetch: async () =>
            typeof body === "string"
              ? new Response(body, { status: 503 })
              : Response.json(body, { status: 503 }),
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ProviderChainError);
        assert.equal(error.failures[0]?.code, "server");
        assert.ok(!JSON.stringify(error.failures).includes("secret"));
        assert.ok(!error.failures[0]?.message.includes("secret"));
        return true;
      },
    );
  }
});
test("chat falls back in priority order and reports typed failure events", async () => {
  const seen: string[] = [],
    events: ProviderEvent[] = [];
  const result = await chat(
    [provider("backup", 2), provider("first", 1)],
    [{ role: "user", content: "hello" }],
    {
      onEvent: (event) => events.push(event),
      fetch: async (url) => {
        seen.push(String(url));
        return String(url).includes("first")
          ? new Response("{}", { status: 429 })
          : Response.json({ choices: [{ message: { content: "OK" } }] });
      },
    },
  );
  assert.equal(result.providerId, "backup");
  assert.deepEqual(seen, [
    "https://first.example/v1/chat/completions",
    "https://backup.example/v1/chat/completions",
  ]);
  assert.equal(events[1]?.error, "rate_limit");
});

test("responses adapter extracts text and disables response storage", async () => {
  const result = await chat(
    [provider("responses", 1, "responses")],
    [{ role: "user", content: "hi" }],
    {
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.store, false);
        return Response.json({
          output: [{ content: [{ type: "output_text", text: "hello" }] }],
        });
      },
    },
  );
  assert.equal(result.text, "hello");
});

test("all providers failing yields a chain of safe errors", async () => {
  await assert.rejects(
    chat([provider("a", 1)], [{ role: "user", content: "hello" }], {
      fetch: async () => new Response("secret body", { status: 401 }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderChainError);
      assert.equal(error.failures[0]?.code, "authentication");
      assert.ok(!error.message.includes("secret"));
      return true;
    },
  );
});

test("embedding order, dimensions and identity are validated", async () => {
  const config: EmbeddingConfig = {
    enabled: true,
    baseUrl: "https://embed.example/v1",
    model: "embed-v1",
  };
  const result = await embed(config, ["one", "two"], {
    fetch: async () =>
      Response.json({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
  });
  assert.deepEqual(result.vectors, [
    [1, 0],
    [0, 1],
  ]);
  assert.equal(result.dimensions, 2);
  assert.match(result.identity, /embed-v1/);
  await assert.rejects(
    embed(config, ["one"], {
      fetch: async () =>
        Response.json({ data: [{ index: 0, embedding: [NaN] }] }),
    }),
  );
});

import Fastify from "fastify";
import { mkdirSync, readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CodexClient, CodexProtocolError, StdioAppServer } from "./protocol.ts";

const ChatBody = z.object({
  model: z.string().min(1).max(200),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "developer", "user", "assistant"]),
        content: z.string().min(1).max(20000),
      }),
    )
    .min(1)
    .max(8),
});
function constantEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function readBridgeToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.INTERNAL_TOKEN_FILE
    ? readFileSync(env.INTERNAL_TOKEN_FILE, "utf8").trim()
    : env.BRIDGE_TOKEN?.trim();
  if (!token || token.length < 32)
    throw new Error("A 32-character internal bridge token is required");
  return token;
}
export function createBridge(client: CodexClient, token: string, cwd: string) {
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 });
  app.get("/health", async () => ({ status: "alive" }));
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    const supplied =
      request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (!constantEqual(supplied, token))
      return reply.code(401).send({ error: "unauthorized" });
  });
  app.get("/account", async (_request, reply) => {
    try {
      return await client.account();
    } catch {
      return reply.code(503).send({ error: "codex_unavailable" });
    }
  });
  app.post("/login", async (_request, reply) => {
    try {
      return await client.deviceLogin();
    } catch {
      return reply.code(503).send({ error: "device_login_unavailable" });
    }
  });
  app.get("/models", async (_request, reply) => {
    try {
      return await client.models();
    } catch {
      return reply.code(503).send({ error: "codex_unavailable" });
    }
  });
  app.post("/chat", async (request, reply) => {
    const parsed = ChatBody.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "invalid_chat_request" });
    try {
      return {
        text: await client.chat(parsed.data.model, parsed.data.messages, cwd),
      };
    } catch (error) {
      return reply.code(503).send({
        error:
          error instanceof CodexProtocolError
            ? error.code
            : "codex_chat_unavailable",
      });
    }
  });
  return app;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  const token = readBridgeToken();
  if (!process.env.CODEX_HOME)
    throw new Error("Set CODEX_HOME to a dedicated bridge credential volume");
  const cwd = process.env.BRIDGE_SCORING_CWD ?? "/tmp/job-assistant-scoring";
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const client = new CodexClient(new StdioAppServer());
  const app = createBridge(client, token, cwd);
  await app.listen({
    host: "127.0.0.1",
    port: Number(process.env.BRIDGE_PORT ?? 3002),
  });
}

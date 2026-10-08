import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type RpcObject = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
};
export class CodexProtocolError extends Error {
  readonly code:
    | "workspace_requirements_unavailable"
    | "tool_isolation_unverified"
    | "codex_chat_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "CodexProtocolError";
    this.code = message.includes("failed to load workspace requirements")
      ? "workspace_requirements_unavailable"
      : message.includes("tool isolation") ||
          message === "Codex attempted to use a tool during scoring"
        ? "tool_isolation_unverified"
        : "codex_chat_unavailable";
  }
}
export interface RpcTransport {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  notify(method: string, params?: unknown): void;
  subscribe(listener: (message: RpcObject) => void): () => void;
  close(): void;
}

export class StdioAppServer implements RpcTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (result: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly listeners = new Set<(message: RpcObject) => void>();
  private closed = false;
  constructor(
    command = "codex",
    args = [
      "-c",
      "features.shell_tool=false",
      "-c",
      "features.unified_exec=false",
      "-c",
      "features.apps=false",
      "-c",
      "features.multi_agent=false",
      "-c",
      "features.hooks=false",
      "-c",
      "features.remote_plugin=false",
      "-c",
      'web_search="disabled"',
      "-c",
      "agents.enabled=false",
      "--strict-config",
      "app-server",
    ],
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
    createInterface({ input: this.child.stdout }).on("line", (line) =>
      this.receive(line),
    );
    // Never echo stderr: it can contain auth or request details.
    this.child.stderr.resume();
    this.child.on("error", () =>
      this.failAll(new CodexProtocolError("Codex App Server could not start")),
    );
    this.child.on("exit", () =>
      this.failAll(new CodexProtocolError("Codex App Server exited")),
    );
  }
  private receive(line: string): void {
    let message: RpcObject;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id === "number" && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      message.error
        ? pending.reject(
            new CodexProtocolError(
              `Codex RPC ${message.error.code}: ${message.error.message}`,
            ),
          )
        : pending.resolve(message.result);
      return;
    }
    if (typeof message.id === "number" && message.method) {
      // The bridge never grants a server-initiated request. This is defense in depth,
      // not a replacement for disabling tools and process isolation.
      this.child.stdin.write(
        `${JSON.stringify({ id: message.id, error: { code: -32601, message: "Unsupported by scoring bridge" } })}\n`,
      );
    }
    for (const listener of this.listeners) listener(message);
  }
  private failAll(error: Error): void {
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }
  request(
    method: string,
    params: unknown = {},
    timeoutMs = 30000,
  ): Promise<any> {
    if (this.closed)
      return Promise.reject(
        new CodexProtocolError("Codex App Server is unavailable"),
      );
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexProtocolError(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  notify(method: string, params: unknown = {}): void {
    if (!this.closed)
      this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }
  subscribe(listener: (message: RpcObject) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): void {
    this.child.kill();
    this.failAll(new CodexProtocolError("Codex App Server closed"));
  }
}

export class CodexClient {
  private initialized: Promise<void> | null = null;
  constructor(private readonly rpc: RpcTransport) {}
  async ready(): Promise<void> {
    this.initialized ??= (async () => {
      await this.rpc.request("initialize", {
        capabilities: { experimentalApi: true },
        clientInfo: {
          name: "job_assistant_scoring_bridge",
          title: "Job Assistant Scoring Bridge",
          version: "0.1.0",
        },
      });
      this.rpc.notify("initialized", {});
    })();
    return this.initialized;
  }
  async account(): Promise<unknown> {
    await this.ready();
    return this.rpc.request("account/read", { refreshToken: false });
  }
  async deviceLogin(): Promise<{
    type: string;
    loginId: string;
    verificationUrl: string;
    userCode: string;
  }> {
    await this.ready();
    const result = await this.rpc.request("account/login/start", {
      type: "chatgptDeviceCode",
    });
    if (
      result?.type !== "chatgptDeviceCode" ||
      !result.loginId ||
      !result.verificationUrl ||
      !result.userCode
    )
      throw new CodexProtocolError("Device-code login is unavailable");
    return result;
  }
  async models(): Promise<unknown> {
    await this.ready();
    return this.rpc.request("model/list", { limit: 100, includeHidden: false });
  }
  async safeConfig(): Promise<boolean> {
    await this.ready();
    const result = await this.rpc.request("config/read", {
      includeLayers: false,
    });
    const config = result?.config;
    const features = config?.features;
    return (
      features?.shell_tool === false &&
      features?.unified_exec === false &&
      features?.apps === false &&
      features?.multi_agent === false &&
      features?.hooks === false &&
      features?.remote_plugin === false &&
      config?.web_search === "disabled" &&
      config?.agents?.enabled === false &&
      Object.keys(config?.mcp_servers ?? {}).length === 0 &&
      Object.keys(config?.plugins ?? {}).length === 0
    );
  }
  async chat(
    model: string,
    messages: Array<{ role: string; content: string }>,
    cwd: string,
    timeoutMs = 90000,
  ): Promise<string> {
    await this.ready();
    if (!(await this.safeConfig()))
      throw new CodexProtocolError(
        "Codex tool isolation could not be verified",
      );
    const started = await this.rpc.request("thread/start", {
      model,
      cwd,
      approvalPolicy: "never",
      permissions: "job_scoring",
      // Scoring accepts text only. No environment is exposed to the model.
      environments: [],
      ephemeral: true,
      serviceName: "job_assistant_scoring_bridge",
      config: {
        // Workspace routing rebuilds the session config without the per-request
        // permission selection. Keep the same restricted profile as its default.
        default_permissions: "job_scoring",
        permissions: {
          job_scoring: {
            filesystem: { ":minimal": "read", ":workspace_roots": "read" },
            network: { enabled: false },
          },
        },
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
      },
    });
    const threadId = started?.thread?.id;
    if (typeof threadId !== "string")
      throw new CodexProtocolError("Codex did not create a thread");
    const prompt = messages
      .map((m) => `${m.role.toUpperCase()}:\n${m.content}`)
      .join("\n\n");
    let turnId: string | undefined;
    let finalText = "";
    let stop: (() => void) | undefined;
    let timer: NodeJS.Timeout | undefined;
    const completion = new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => {
        if (turnId)
          void this.rpc
            .request("turn/interrupt", { threadId, turnId })
            .catch(() => undefined);
        reject(new CodexProtocolError("Codex turn timed out"));
      }, timeoutMs);
      stop = this.rpc.subscribe((message) => {
        if (message.params?.threadId !== threadId) return;
        if (
          message.method === "item/started" &&
          !["userMessage", "agentMessage", "reasoning"].includes(
            message.params?.item?.type,
          )
        ) {
          if (turnId)
            void this.rpc
              .request("turn/interrupt", { threadId, turnId })
              .catch(() => undefined);
          clearTimeout(timer);
          reject(
            new CodexProtocolError(
              "Codex attempted to use a tool during scoring",
            ),
          );
        }
        if (
          message.method === "item/completed" &&
          message.params?.item?.type === "agentMessage" &&
          (message.params?.item?.phase === "final_answer" ||
            !message.params?.item?.phase)
        )
          finalText = message.params.item.text ?? "";
        if (message.method === "turn/completed") {
          clearTimeout(timer);
          if (message.params?.turn?.status === "completed" && finalText.trim())
            resolve(finalText.trim());
          else
            reject(
              new CodexProtocolError(
                typeof message.params?.turn?.error?.message === "string"
                  ? message.params.turn.error.message
                  : "Codex turn ended without a final answer",
              ),
            );
        }
      });
    });
    // An item notification may arrive before turn/start replies. Mark the deferred
    // promise handled immediately while retaining its rejection for the caller.
    void completion.catch(() => undefined);
    try {
      const turn = await this.rpc.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
        model,
        cwd,
        approvalPolicy: "never",
        permissions: "job_scoring",
        environments: [],
      });
      turnId = turn?.turn?.id;
      if (typeof turnId !== "string")
        throw new CodexProtocolError("Codex did not start a turn");
      return await completion;
    } finally {
      if (timer) clearTimeout(timer);
      stop?.();
    }
  }
}

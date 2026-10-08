import type {
  EmbeddingConfig,
  ProviderConfig,
} from "../../contracts/src/index.ts";

export type ChatMessage = {
  role: "system" | "developer" | "user" | "assistant";
  content: string;
};
export type ProviderEvent = {
  type: "attempt" | "failure" | "success";
  providerId: string;
  model: string;
  error?: ProviderErrorCode;
};
export type ProviderErrorCode =
  | "workspace_requirements_unavailable"
  | "configuration"
  | "authentication"
  | "rate_limit"
  | "timeout"
  | "network"
  | "server"
  | "invalid_response"
  | "unavailable";
export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly providerId?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
export class ProviderChainError extends Error {
  constructor(public readonly failures: ProviderError[]) {
    super("All configured model providers failed");
    this.name = "ProviderChainError";
  }
}
export function safeProviderChainMessage(error: ProviderChainError): string {
  return error.failures.some(
    (failure) => failure.code === "workspace_requirements_unavailable",
  )
    ? "ChatGPT 工作区要求加载失败，尚未完成模型调用；请检查桥接服务连接与账号配置。"
    : "所有已配置的模型均调用失败，请检查模型连接与配置。";
}
export interface ChatResult {
  text: string;
  providerId: string;
  model: string;
  protocol: ProviderConfig["protocol"];
}
export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  endpoint: string;
  dimensions: number;
  identity: string;
}
export interface RequestOptions {
  fetch?: typeof fetch;
  onEvent?: (event: ProviderEvent) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function endpoint(baseUrl: string, path: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ProviderError("configuration", "Invalid model endpoint URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ProviderError(
      "configuration",
      "Model endpoint must be an HTTP(S) URL without credentials or query",
    );
  const prefix = url.pathname.replace(/\/$/, "");
  url.pathname = `${prefix}${path}`;
  return url.toString();
}

async function postJson(
  url: string,
  body: unknown,
  key: string | undefined,
  id: string,
  options: RequestOptions,
  timeoutMs: number,
  codexBridge = false,
): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const externalAbort = () => controller.abort();
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    if (controller.signal.aborted)
      throw new ProviderError("unavailable", "Request was cancelled", id);
    const response = await (options.fetch ?? fetch)(url, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (codexBridge) {
        const body = (await response.json().catch(() => undefined)) as
          | { error?: unknown }
          | undefined;
        if (body?.error === "workspace_requirements_unavailable")
          throw new ProviderError(
            "workspace_requirements_unavailable",
            "ChatGPT workspace requirements unavailable",
            id,
            response.status,
          );
      }
      const code: ProviderErrorCode =
        response.status === 401 || response.status === 403
          ? "authentication"
          : response.status === 429
            ? "rate_limit"
            : response.status >= 500
              ? "server"
              : "configuration";
      throw new ProviderError(
        code,
        `Model provider returned HTTP ${response.status}`,
        id,
        response.status,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new ProviderError(
        "invalid_response",
        "Model provider returned invalid JSON",
        id,
      );
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (timedOut)
      throw new ProviderError("timeout", "Model provider timed out", id);
    if (options.signal?.aborted)
      throw new ProviderError("unavailable", "Request was cancelled", id);
    throw new ProviderError("network", "Model provider is unreachable", id);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", externalAbort);
  }
}

function nonemptyText(value: unknown, id: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new ProviderError("invalid_response", "Model returned no text", id);
  return value.trim();
}

export async function chat(
  providers: ProviderConfig[],
  messages: ChatMessage[],
  options: RequestOptions = {},
): Promise<ChatResult> {
  if (!messages.length || messages.some((m) => !m.content.trim()))
    throw new ProviderError(
      "configuration",
      "Messages must contain nonempty text",
    );
  const ordered = providers
    .filter((p) => p.enabled)
    .sort((a, b) => a.priority - b.priority);
  if (!ordered.length)
    throw new ProviderChainError([
      new ProviderError("configuration", "No enabled model provider"),
    ]);
  const failures: ProviderError[] = [];
  for (const provider of ordered) {
    options.onEvent?.({
      type: "attempt",
      providerId: provider.id,
      model: provider.model,
    });
    try {
      if (!provider.model.trim())
        throw new ProviderError(
          "configuration",
          "Model name is required",
          provider.id,
        );
      const timeout = options.timeoutMs ?? provider.timeoutMs;
      if (!Number.isFinite(timeout) || timeout <= 0)
        throw new ProviderError(
          "configuration",
          "Timeout must be positive",
          provider.id,
        );
      let result: unknown;
      if (provider.kind === "codex") {
        result = await postJson(
          endpoint(provider.baseUrl, "/chat"),
          { model: provider.model, messages },
          provider.apiKey,
          provider.id,
          options,
          timeout,
          true,
        );
        const text = nonemptyText(
          (result as { text?: unknown })?.text,
          provider.id,
        );
        options.onEvent?.({
          type: "success",
          providerId: provider.id,
          model: provider.model,
        });
        return {
          text,
          providerId: provider.id,
          model: provider.model,
          protocol: provider.protocol,
        };
      }
      if (provider.protocol === "responses") {
        const input = messages.map((m) => ({
          role: m.role === "system" ? "developer" : m.role,
          content: m.content,
        }));
        result = await postJson(
          endpoint(provider.baseUrl, "/responses"),
          { model: provider.model, input, store: false },
          provider.apiKey,
          provider.id,
          options,
          timeout,
        );
        const value = result as {
          output_text?: unknown;
          output?: Array<{
            type?: string;
            content?: Array<{ type?: string; text?: string }>;
          }>;
        };
        const text = nonemptyText(
          value?.output_text ??
            value?.output
              ?.flatMap((item) => item.content ?? [])
              .filter((part) => part.type === "output_text")
              .map((part) => part.text ?? "")
              .join(""),
          provider.id,
        );
        options.onEvent?.({
          type: "success",
          providerId: provider.id,
          model: provider.model,
        });
        return {
          text,
          providerId: provider.id,
          model: provider.model,
          protocol: provider.protocol,
        };
      }
      result = await postJson(
        endpoint(provider.baseUrl, "/chat/completions"),
        { model: provider.model, messages, stream: false },
        provider.apiKey,
        provider.id,
        options,
        timeout,
      );
      const value = result as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const text = nonemptyText(
        value?.choices?.[0]?.message?.content,
        provider.id,
      );
      options.onEvent?.({
        type: "success",
        providerId: provider.id,
        model: provider.model,
      });
      return {
        text,
        providerId: provider.id,
        model: provider.model,
        protocol: provider.protocol,
      };
    } catch (error) {
      const failure =
        error instanceof ProviderError
          ? error
          : new ProviderError(
              "unavailable",
              "Unknown model provider failure",
              provider.id,
            );
      failures.push(failure);
      options.onEvent?.({
        type: "failure",
        providerId: provider.id,
        model: provider.model,
        error: failure.code,
      });
      if (options.signal?.aborted) break;
    }
  }
  throw new ProviderChainError(failures);
}

export function embeddingIdentity(
  endpointUrl: string,
  model: string,
  dimensions: number,
): string {
  return JSON.stringify([endpointUrl.replace(/\/$/, ""), model, dimensions]);
}

export async function embed(
  config: EmbeddingConfig,
  texts: string[],
  options: RequestOptions = {},
): Promise<EmbeddingResult> {
  if (
    !config.enabled ||
    !config.model.trim() ||
    !texts.length ||
    texts.some((t) => !t.trim())
  )
    throw new ProviderError(
      "configuration",
      "Enabled embedding model and nonempty inputs are required",
    );
  const url = endpoint(config.baseUrl, "/embeddings");
  const raw = (await postJson(
    url,
    { model: config.model, input: texts },
    config.apiKey,
    "embedding",
    options,
    options.timeoutMs ?? 30000,
  )) as { data?: Array<{ index?: number; embedding?: unknown }> };
  if (!Array.isArray(raw?.data) || raw.data.length !== texts.length)
    throw new ProviderError(
      "invalid_response",
      "Embedding count does not match inputs",
      "embedding",
    );
  const vectors = [...raw.data]
    .sort((a, b) => (a.index ?? -1) - (b.index ?? -1))
    .map((entry, index) => {
      if (
        entry.index !== index ||
        !Array.isArray(entry.embedding) ||
        !entry.embedding.length ||
        entry.embedding.some(
          (x) => typeof x !== "number" || !Number.isFinite(x),
        )
      )
        throw new ProviderError(
          "invalid_response",
          "Invalid embedding vector",
          "embedding",
        );
      return entry.embedding as number[];
    });
  const dimensions = vectors[0]!.length;
  if (vectors.some((v) => v.length !== dimensions))
    throw new ProviderError(
      "invalid_response",
      "Inconsistent embedding dimensions",
      "embedding",
    );
  return {
    vectors,
    model: config.model,
    endpoint: url,
    dimensions,
    identity: embeddingIdentity(url, config.model, dimensions),
  };
}

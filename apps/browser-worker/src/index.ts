import { timingSafeEqual, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import Fastify from "fastify";
import proxy from "@fastify/http-proxy";
import type { Socket } from "node:net";
import { chromium, type BrowserContext, type Page } from "playwright";
import type {
  Application,
  ApplicationAction,
  Job,
  JobSource,
  Task,
} from "../../../packages/contracts/src/index.ts";
import { crawlOfficial } from "../../../packages/sources/src/index.ts";
import {
  collectBossPage,
  FixtureBossAdapter,
  UnverifiedLiveBossAdapter,
  runApplication,
  type ActionJournal,
  type BossActionOutcome,
} from "../../../packages/boss/src/index.ts";

/** Kept top-level because the app's task callback intentionally accepts jobs/application/error. */
type TaskResult = { jobs?: Job[]; application?: Application; error?: string };
type ClaimReply = { task: Task | null };

export interface WorkerConfig {
  appUrl: string;
  tokenFile: string;
  port: number;
  workerId?: string;
  pollMs?: number;
  profileDir?: string;
  viewerEnabled?: boolean;
  viewerUrl?: string;
  logger?: boolean;
}
const defaultConfig = (): WorkerConfig => ({
  appUrl: process.env.APP_INTERNAL_URL ?? "http://app:3000",
  tokenFile: process.env.INTERNAL_TOKEN_FILE ?? "",
  port: Number(process.env.WORKER_PORT ?? process.env.PORT ?? 3001),
  workerId: process.env.WORKER_ID,
  pollMs: Number(process.env.WORKER_POLL_MS ?? 2000),
  profileDir:
    process.env.BOSS_PROFILE_DIR ??
    process.env.BROWSER_PROFILE_DIR ??
    "data/boss-profile",
  viewerEnabled: process.env.BOSS_VIEWER_ENABLED === "true",
  viewerUrl: process.env.VIEWER_URL,
});

class InternalClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly workerId: string,
  ) {}
  private async request(path: string, init: RequestInit): Promise<Response> {
    return fetch(new URL(path, this.baseUrl), {
      ...init,
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  }
  async claim(): Promise<Task | null> {
    const response = await this.request("/internal/tasks/claim", {
      method: "POST",
      body: JSON.stringify({ workerId: this.workerId }),
    });
    if (!response.ok) throw new Error(`claim failed: ${response.status}`);
    return ((await response.json()) as ClaimReply).task;
  }
  async heartbeat(task: Task): Promise<{ paused: boolean; takeover: boolean }> {
    const response = await this.request(
      `/internal/tasks/${encodeURIComponent(task.id)}/heartbeat`,
      { method: "POST", body: JSON.stringify({ leaseToken: task.leaseToken }) },
    );
    if (!response.ok) throw new Error(`heartbeat failed: ${response.status}`);
    return (await response.json()) as { paused: boolean; takeover: boolean };
  }
  async result(task: Task, result: TaskResult): Promise<void> {
    const response = await this.request(
      `/internal/tasks/${encodeURIComponent(task.id)}/result`,
      {
        method: "POST",
        body: JSON.stringify({ leaseToken: task.leaseToken, result }),
      },
    );
    if (!response.ok)
      throw new Error(`result callback failed: ${response.status}`);
  }
  journal(task: Task, application: Application): ActionJournal {
    const send = async (
      action: ApplicationAction,
      state: ApplicationAction["state"],
      evidence: string,
    ) => {
      const response = await this.request(
        `/internal/applications/${encodeURIComponent(application.id)}/actions`,
        {
          method: "POST",
          body: JSON.stringify({
            leaseToken: task.leaseToken,
            taskId: task.id,
            action: { ...action, ...(state ? { state, evidence } : {}) },
          }),
        },
      );
      if (!response.ok)
        throw new Error(
          `application action callback failed: ${response.status}`,
        );
    };
    return {
      before: async (_application, action) =>
        send(action, "started", "journaled before browser action"),
      after: async (_application, action, state, evidence) =>
        send(action, state, evidence),
    };
  }
}

export interface BrowserSession {
  readonly active: boolean;
  readonly page: Page | null;
  readonly navigationError?: string | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

class BossViewer implements BrowserSession {
  private context: BrowserContext | null = null;
  private lastNavigationError: string | null = null;
  private navigationAttempted = false;
  constructor(
    private readonly profileDir: string,
    private readonly enabled: boolean,
  ) {}
  get active(): boolean {
    return this.context !== null;
  }
  get page() {
    return this.context?.pages()[0] ?? null;
  }
  get navigationError(): string | null {
    if (this.lastNavigationError) return this.lastNavigationError;
    if (this.navigationAttempted && this.page?.url() === "about:blank")
      return "BOSS 页面打开后回到了空白页，请在接管画面中检查。当前不能采集岗位。";
    return null;
  }
  async start(): Promise<void> {
    if (!this.enabled)
      throw new Error(
        "viewer is disabled by BOSS_VIEWER_ENABLED; deployment must provide a secured display path",
      );
    this.context ??= await chromium.launchPersistentContext(this.profileDir, {
      headless: false,
      chromiumSandbox: true,
      viewport: { width: 1440, height: 900 },
    });
    if (!this.context.pages().length) await this.context.newPage();
    const page = this.page;
    if (page) await page.bringToFront();
    if (page && page.url() === "about:blank") {
      this.lastNavigationError = null;
      this.navigationAttempted = true;
      try {
        await page.goto("https://www.zhipin.com/", {
          waitUntil: "domcontentloaded",
          timeout: 20000,
        });
      } catch (error) {
        const code =
          error instanceof Error
            ? (error.message.match(/net::[A-Z_]+/)?.[0] ?? error.name)
            : "navigation_failed";
        this.lastNavigationError = `BOSS 页面打开失败（${code}），可结束接管后重新开始以重试。`;
        /* Keep the desktop usable for a manual retry after a network error. */
      }
    }
    if (page) await page.bringToFront();
  }
  async stop(): Promise<void> {
    await this.context?.close();
    this.context = null;
    this.navigationAttempted = false;
    this.lastNavigationError = null;
  }
}

function stringRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function asApplication(value: unknown): Application | null {
  const record = stringRecord(value);
  return record?.id && Array.isArray(record.actions)
    ? (record as unknown as Application)
    : null;
}
function sourceFrom(value: unknown): JobSource | null {
  const record = stringRecord(value);
  return record?.id &&
    record.kind === "official" &&
    typeof record.url === "string" &&
    Array.isArray(record.allowedHosts)
    ? (record as unknown as JobSource)
    : null;
}
function sourceFromBoss(value: unknown): JobSource | null {
  const record = stringRecord(value);
  return record?.id && record.kind === "boss" && typeof record.url === "string"
    ? (record as unknown as JobSource)
    : null;
}
function jobsFrom(value: unknown): Job[] | null {
  return Array.isArray(value) ? (value as Job[]) : null;
}

export async function createWorker(
  config: WorkerConfig = defaultConfig(),
  browserSession?: BrowserSession,
) {
  const app = Fastify({ logger: config.logger ?? true });
  const workerId = config.workerId ?? `browser-worker-${randomUUID()}`;
  const viewer =
    browserSession ??
    new BossViewer(
      config.profileDir ?? "data/boss-profile",
      config.viewerEnabled ?? false,
    );
  let takeover = false;
  let working = false;
  let viewerTransition = false;
  const viewerSockets = new Set<Socket>();
  const disconnectViewer = () => {
    for (const socket of viewerSockets) socket.destroy();
    viewerSockets.clear();
  };
  let token: string | null = null;
  let tokenError: string | null = null;
  try {
    token = (await readFile(config.tokenFile, "utf8")).trim();
    if (!token) throw new Error("token file is empty");
  } catch (error) {
    tokenError =
      error instanceof Error ? error.message : "token file unavailable";
  }
  const authenticated = async (
    request: { headers: Record<string, string | string[] | undefined> },
    reply: { code(status: number): { send(value: unknown): void } },
  ) => {
    const authorization = request.headers.authorization;
    const candidate = (
      typeof authorization === "string" ? authorization : ""
    ).replace(/^Bearer\s+/i, "");
    const candidateBytes = Buffer.from(candidate);
    const tokenBytes = Buffer.from(token ?? "");
    const valid =
      token !== null &&
      candidateBytes.length === tokenBytes.length &&
      timingSafeEqual(candidateBytes, tokenBytes);
    if (!valid) {
      reply.code(401).send({ error: "unauthorized" });
      return false;
    }
    return true;
  };
  if (config.viewerUrl) {
    const upstream = new URL(config.viewerUrl);
    if (
      upstream.protocol !== "http:" ||
      upstream.hostname !== "127.0.0.1" ||
      upstream.username ||
      upstream.password ||
      upstream.search ||
      upstream.hash ||
      upstream.pathname !== "/"
    ) {
      throw new Error(
        "Browser desktop upstream must be an HTTP loopback root URL",
      );
    }
    app.addHook("onRequest", async (request, reply) => {
      if (!/^\/browser(?:\/|\?|$)/.test(request.url)) return;
      if (!(await authenticated(request, reply))) return;
      if (!takeover || !viewer.active || viewerTransition)
        return reply
          .code(409)
          .send({ error: "Browser takeover is not active" });
      if (request.headers.upgrade?.toLowerCase() === "websocket") {
        const socket = request.raw.socket;
        viewerSockets.add(socket);
        socket.once("close", () => viewerSockets.delete(socket));
      }
    });
    const desktopWsOptions = { headers: {}, rewriteRequestHeaders: () => ({}) };
    await app.register(proxy, {
      upstream: upstream.origin,
      prefix: "/browser",
      rewritePrefix: "/",
      websocket: true,
      wsClientOptions: desktopWsOptions,
      httpMethods: ["GET", "HEAD"],
      replyOptions: {
        rewriteRequestHeaders: (_request, headers) => {
          const safe = { ...headers };
          delete safe.authorization;
          delete safe.cookie;
          return safe;
        },
      },
    });
  }
  app.get("/health", async () => ({
    ok: token !== null,
    workerId,
    tokenError,
  }));
  app.get("/status", async (request, reply) => {
    if (!(await authenticated(request, reply))) return;
    return {
      workerId,
      ready: token !== null,
      working,
      takeover,
      viewerActive: viewer.active,
      viewerEnabled: !!config.viewerEnabled && !!config.viewerUrl,
      navigationError: viewer.navigationError ?? null,
      bossAdapter: "DOM adapter requires authenticated selector verification",
      liveApplyReady: false,
      liveCollectionReady:
        viewer.active && !!viewer.page && !viewer.navigationError,
    };
  });
  app.post("/takeover/start", async (request, reply) => {
    if (!(await authenticated(request, reply))) return;
    if (!config.viewerEnabled || !config.viewerUrl)
      return reply.code(503).send({ error: "本机浏览器接管服务尚未启用" });
    if (working || viewerTransition)
      return reply
        .code(409)
        .send({ error: "浏览器任务尚未结束，请稍后重试接管" });
    viewerTransition = true;
    takeover = true;
    try {
      await viewer.start();
      return {
        ready: true,
        takeover: true,
        viewerActive: viewer.active,
        navigationError: viewer.navigationError ?? null,
        liveApplyReady: false,
      };
    } catch (error) {
      takeover = false;
      disconnectViewer();
      return reply.code(503).send({
        takeover: false,
        viewerActive: false,
        error: error instanceof Error ? error.message : "viewer unavailable",
      });
    } finally {
      viewerTransition = false;
    }
  });
  app.post("/takeover/stop", async (request, reply) => {
    if (!(await authenticated(request, reply))) return;
    if (viewerTransition)
      return reply.code(409).send({ error: "浏览器正在启动，请稍后结束接管" });
    takeover = false;
    disconnectViewer();
    // Keep the signed-in page available for read-only collection after release.
    return {
      ready: true,
      takeover: false,
      viewerActive: viewer.active,
      liveApplyReady: false,
    };
  });

  const processTask = async (
    task: Task,
    client: InternalClient,
  ): Promise<TaskResult> => {
    const payload = stringRecord(task.payload) ?? {};
    if (task.kind === "crawl") {
      const source = sourceFrom(payload.source ?? task.payload);
      if (!source)
        return { error: "crawl task requires an official JobSource payload" };
      try {
        return { jobs: await crawlOfficial(source) };
      } catch (error) {
        return {
          error:
            error instanceof Error ? error.message : "official crawl failed",
        };
      }
    }
    if (task.kind === "boss-collect") {
      const fixtureJobs = jobsFrom(payload.fixtureJobs);
      if (fixtureJobs) return { jobs: fixtureJobs };
      const source = sourceFromBoss(payload.source ?? task.payload);
      if (!source)
        return { error: "BOSS collection requires a BOSS JobSource" };
      if (!viewer.page)
        return {
          error: "open a BOSS page in the manual browser before collecting",
        };
      try {
        return { jobs: await collectBossPage(viewer.page, source) };
      } catch (error) {
        return {
          error:
            error instanceof Error ? error.message : "BOSS collection failed",
        };
      }
    }
    const application = asApplication(payload.application ?? task.payload);
    if (!application)
      return { error: "apply task requires an Application payload" };
    const fixture = payload.fixture === true;
    const outcomes = Array.isArray(payload.outcomes)
      ? payload.outcomes.filter(
          (item): item is BossActionOutcome =>
            item === "confirmed" || item === "unknown" || item === "failed",
        )
      : [];
    const adapter = fixture
      ? new FixtureBossAdapter(outcomes)
      : new UnverifiedLiveBossAdapter();
    try {
      const outcome = await runApplication(
        application,
        adapter,
        client.journal(task, application),
        takeover,
      );
      return { application: outcome.application, error: outcome.reason };
    } catch (error) {
      return {
        application: { ...application, status: "needs-review" },
        error:
          error instanceof Error
            ? error.message
            : "application execution failed without replay",
      };
    }
  };
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (!token || working || takeover) return;
    working = true;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    try {
      const client = new InternalClient(config.appUrl, token, workerId);
      const task = await client.claim();
      if (!task) return;
      const control = await client.heartbeat(task);
      if (control.paused || control.takeover) {
        takeover = control.takeover;
        return;
      }
      let leaseValid = true;
      let heartbeatBusy = false;
      heartbeatTimer = setInterval(() => {
        if (heartbeatBusy) return;
        heartbeatBusy = true;
        void client
          .heartbeat(task)
          .then((state) => {
            if (state.paused || state.takeover) {
              takeover = state.takeover;
              leaseValid = false;
            }
          })
          .catch((error) => {
            leaseValid = false;
            app.log.warn({ err: error }, "task heartbeat failed");
          })
          .finally(() => {
            heartbeatBusy = false;
          });
      }, 15_000);
      const result = await processTask(task, client);
      if (leaseValid && !takeover) {
        const finalControl = await client.heartbeat(task);
        if (!finalControl.paused && !finalControl.takeover)
          await client.result(task, result);
        else takeover = finalControl.takeover;
      }
    } catch (error) {
      app.log.warn({ err: error }, "worker task cycle failed");
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      working = false;
    }
  };
  return {
    app,
    startPolling: () => {
      if (!timer) timer = setInterval(() => void tick(), config.pollMs ?? 2000);
      void tick();
    },
    stop: async () => {
      if (timer) clearInterval(timer);
      disconnectViewer();
      await viewer.stop();
      await app.close();
    },
    processTask,
    status: () => ({ workerId, takeover, working }),
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const worker = await createWorker();
  await worker.app.listen({ port: defaultConfig().port, host: "127.0.0.1" });
  worker.startPolling();
  let shutdown: Promise<void> | undefined;
  const stop = () => {
    shutdown ??= worker.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

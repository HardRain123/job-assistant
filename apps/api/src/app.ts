import Fastify from "fastify";
import staticPlugin from "@fastify/static";
import multipart from "@fastify/multipart";
import proxy from "@fastify/http-proxy";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { writeFile, rm } from "node:fs/promises";
import { resolve, extname, basename, join } from "node:path";
import { z } from "zod";
import type { Socket } from "node:net";
import mammoth from "mammoth";
import { Store } from "../../../packages/storage/src/index.ts";
import {
  renderTemplate,
  fingerprint,
} from "../../../packages/templates/src/index.ts";
import {
  DEFAULT_POLICY,
  DEFAULT_TEMPLATE,
  type ProviderConfig,
  type EmbeddingConfig,
  type JobSource,
  type Resume,
  type Assessment,
  type Application,
  type ApplicationAction,
  type Job,
  type MatchPolicy,
} from "../../../packages/contracts/src/index.ts";
import {
  chat,
  embed,
  ProviderChainError,
  safeProviderChainMessage,
} from "../../../packages/providers/src/index.ts";
import { assessJob } from "../../../packages/matching/src/index.ts";
import { decrypt, encrypt, equal } from "./security.ts";
import { createExtensionAccess } from "./extension.ts";
import { createAutomation } from "./automation.ts";
import {
  policySchema,
  providerSchema,
  embeddingSchema,
  templateSchema,
  resumeSchema,
  sourceSchema,
  jobSchema,
  actionSchema,
} from "./schemas.ts";

export interface AppOptions {
  store: Store;
  password: string;
  key: string;
  internalToken: string;
  dataDir: string;
  attachmentsDir: string;
  webDir?: string;
  workerUrl?: string;
  bridgeUrl?: string;
}
export async function createApp(o: AppOptions) {
  const app = Fastify({ logger: false, bodyLimit: 1048576 });
  const sessions = new Map<string, number>();
  const sessionSockets = new Map<string, Set<Socket>>();
  const loginAttempts = new Map<string, { count: number; until: number }>();
  const extension = createExtensionAccess(o.store);
  mkdirSync(o.attachmentsDir, { recursive: true });
  mkdirSync(o.dataDir, { recursive: true });
  const getProviders = (): ProviderConfig[] => {
    const raw = o.store.get<string | null>("providers", null);
    return raw ? decrypt(raw, o.key) : [];
  };
  const runtimeProviders = () =>
    getProviders().map((p) =>
      p.kind === "codex"
        ? {
            ...p,
            baseUrl: o.bridgeUrl ?? "http://codex-bridge:3002",
            apiKey: o.internalToken,
          }
        : p,
    );
  const getEmbedding = (): EmbeddingConfig => {
    const raw = o.store.get<string | null>("embedding", null);
    return raw
      ? decrypt(raw, o.key)
      : { enabled: false, baseUrl: "https://api.openai.com/v1", model: "" };
  };
  const cleanProvider = (p: ProviderConfig) => ({
    ...p,
    apiKey: undefined,
    hasKey: !!p.apiKey,
  });
  const policy = () => o.store.get("policy", DEFAULT_POLICY);
  const resume = () => o.store.get<Resume | null>("resume", null);
  const template = () => o.store.get("template", DEFAULT_TEMPLATE);
  function cacheKey(j: Job, r: Resume, p: MatchPolicy) {
    return fingerprint({
      job: j.contentHash,
      resume: r,
      policy: p,
      providers: getProviders().map((x) => ({
        id: x.id,
        model: x.model,
        url: x.baseUrl,
        enabled: x.enabled,
        priority: x.priority,
      })),
    });
  }
  function assessment(j: Job): Assessment | null {
    const r = resume();
    return r
      ? o.store.get("assessment:" + cacheKey(j, r, policy()), null)
      : null;
  }
  async function scoreJob(id: string, signal?: AbortSignal) {
    const r = resume();
    if (!r) throw new Error("请先导入并核对简历");
    const j = o.store.job(id);
    if (!j) throw new Error("岗位不存在");
    const p = policy();
    const key = cacheKey(j, r, p);
    let result = o.store.get<Assessment | null>("assessment:" + key, null);
    if (!result || result.decision === "unavailable") {
      result = await assessJob(j, r, p, runtimeProviders(), { signal });
      if (!signal?.aborted) o.store.set("assessment:" + key, result);
    }
    return result;
  }
  const automation = createAutomation({
    store: o.store,
    extensionStatus: extension.status,
    importJobs: extension.importJobs,
    configurationKey: () =>
      fingerprint({
        resume: resume(),
        policy: policy(),
        providers: getProviders(),
      }),
    ensureReady: (autoAssess) => {
      if (autoAssess && !resume())
        throw new Error("自动评分需要先导入并核对简历");
      if (autoAssess && !getProviders().some((p) => p.enabled))
        throw new Error("请先启用至少一个评分模型，或关闭本次自动评分");
      if (o.store.get("takeover", false))
        throw new Error("请先结束内置浏览器的人工接管");
    },
    scoreJob,
  });
  function authorized(cookie: string | undefined) {
    const token = cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("ja_session="))
      ?.slice(11);
    return !!token && (sessions.get(token) ?? 0) > Date.now();
  }
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0];
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "same-origin")
      .header("Cache-Control", "no-store");
    const host = req.headers.host?.split(":")[0];
    if (!host || !["localhost", "127.0.0.1", "app"].includes(host))
      return reply
        .code(403)
        .send({ error: "Host 不受信任；请通过本机地址访问" });
    if (path.startsWith("/extension/")) return extension.guard(req, reply);
    if (path.startsWith("/internal/")) {
      if (!equal(req.headers.authorization ?? "", `Bearer ${o.internalToken}`))
        return reply.code(401).send({ error: "服务认证失败" });
      return;
    }
    if (req.headers.origin) {
      let origin: URL;
      try {
        origin = new URL(req.headers.origin);
      } catch {
        return reply.code(403).send({ error: "无效来源" });
      }
      if (origin.host !== req.headers.host)
        return reply.code(403).send({ error: "不允许跨站请求" });
    }
    if (path === "/health" || path === "/api/login") return;
    if (
      (path.startsWith("/api/") || path.startsWith("/browser")) &&
      !authorized(req.headers.cookie)
    )
      return reply.code(401).send({ error: "请登录本地工作台" });
    if (path.startsWith("/browser")) {
      if (!o.store.get("takeover", false))
        return reply.code(409).send({ error: "请先开始人工接管" });
      if (req.headers.upgrade?.toLowerCase() === "websocket") {
        const token = req.headers
          .cookie!.split(";")
          .map((s) => s.trim())
          .find((s) => s.startsWith("ja_session="))!
          .slice(11);
        const sockets = sessionSockets.get(token) ?? new Set<Socket>();
        const socket = req.raw.socket;
        sockets.add(socket);
        sessionSockets.set(token, sockets);
        const timer = setTimeout(
          () => socket.destroy(),
          Math.max(1, (sessions.get(token) ?? 0) - Date.now()),
        );
        timer.unref();
        socket.once("close", () => {
          clearTimeout(timer);
          sockets.delete(socket);
        });
      }
    }
  });
  app.setErrorHandler((e, _req, reply) => {
    const err = e as Error & { statusCode?: number };
    const status =
      e instanceof z.ZodError
        ? 400
        : err.statusCode && err.statusCode < 500
          ? err.statusCode
          : 400;
    reply.code(status).send({
      error:
        e instanceof z.ZodError
          ? e.issues.map((x) => x.message).join("；")
          : e instanceof ProviderChainError
            ? safeProviderChainMessage(e)
            : err.message,
    });
  });
  app.get("/health", () => ({ ok: true, version: "0.1.0" }));
  extension.register(app);
  automation.register(app);
  app.post("/api/login", async (req, reply) => {
    const b = z.object({ password: z.string().max(512) }).parse(req.body);
    const now = Date.now();
    const attempt = loginAttempts.get(req.ip);
    if (attempt && attempt.until > now && attempt.count >= 10)
      return reply.code(429).send({ error: "尝试过于频繁，请稍后重试" });
    if (!equal(b.password, o.password)) {
      loginAttempts.set(req.ip, {
        count: (attempt && attempt.until > now ? attempt.count : 0) + 1,
        until: now + 60000,
      });
      return reply.code(401).send({ error: "工作台密码不正确" });
    }
    loginAttempts.delete(req.ip);
    for (const [key, expiry] of sessions)
      if (expiry < now) sessions.delete(key);
    const token = randomBytes(32).toString("hex");
    sessions.set(token, now + 12 * 3600000);
    reply.header(
      "Set-Cookie",
      `ja_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
    );
    return { ok: true };
  });
  app.post("/api/logout", (req, reply) => {
    const token = req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("ja_session="))
      ?.slice(11);
    if (token) {
      sessions.delete(token);
      for (const socket of sessionSockets.get(token) ?? []) socket.destroy();
      sessionSockets.delete(token);
    }
    reply.header(
      "Set-Cookie",
      "ja_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    );
    return { ok: true };
  });
  app.get("/api/state", () => ({
    resume: resume(),
    policy: policy(),
    template: template(),
    sources: o.store.get<JobSource[]>("sources", []),
    providers: getProviders().map(cleanProvider),
    embedding: {
      ...getEmbedding(),
      apiKey: undefined,
      hasKey: !!getEmbedding().apiKey,
    },
    jobs: o.store.jobs().map((j) => ({ ...j, assessment: assessment(j) })),
    applications: o.store.applications(),
    tasks: o.store
      .tasks()
      .map((t) => ({ ...t, leaseToken: undefined, payload: undefined })),
    paused: o.store.get("paused", false),
    takeover: o.store.get("takeover", false),
  }));
  app.put("/api/policy", (req) => {
    const next = {
      ...policySchema.parse(req.body),
      version: policy().version + 1,
    };
    o.store.set("policy", next);
    return next;
  });
  app.put("/api/resume", (req) => {
    const b = resumeSchema.parse(req.body);
    const old = resume();
    const next: Resume = {
      ...b,
      id: randomUUID(),
      attachmentName: old?.text === b.text ? old.attachmentName : null,
      createdAt: new Date().toISOString(),
    };
    o.store.set("resume", next);
    return next;
  });
  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5 },
  });
  app.post("/api/resume/upload", async (req) => {
    const file = await req.file();
    if (!file) throw new Error("请选择 DOCX 或 PDF 简历");
    const ext = extname(file.filename).toLowerCase();
    if (![".docx", ".pdf"].includes(ext)) throw new Error("只支持 DOCX 或 PDF");
    const buffer = await file.toBuffer();
    let text: string;
    if (ext === ".docx")
      text = (await mammoth.extractRawText({ buffer })).value;
    else {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: buffer });
      try {
        text = (await parser.getText()).text;
      } finally {
        await parser.destroy();
      }
    }
    if (text.trim().length < 20)
      throw new Error("未提取到足够文字，请手动填写或使用带文本的简历");
    const name = randomUUID() + ext;
    await writeFile(join(o.attachmentsDir, name), buffer, { mode: 0o640 });
    const next: Resume = {
      id: randomUUID(),
      name: basename(file.filename, ext),
      text: text.slice(0, 100000),
      skills: resume()?.skills ?? [],
      years: resume()?.years ?? 0,
      attachmentName: name,
      createdAt: new Date().toISOString(),
    };
    o.store.set("resume", next);
    return next;
  });
  app.put("/api/template", (req) => {
    const b = templateSchema.parse(req.body);
    const next = { ...b, id: "default", version: template().version + 1 };
    renderTemplate(next, {
      company: "示例公司",
      title: "AI 应用工程师",
      candidateName: "候选人",
      years: "7",
      skills: "Java、AI",
    });
    o.store.set(`template:${next.version}`, next);
    o.store.set("template", next);
    return next;
  });
  app.post("/api/template/preview", (req) => {
    const b = z.object({ jobId: z.string().optional() }).parse(req.body ?? {});
    const r = resume();
    const j = b.jobId ? o.store.job(b.jobId) : null;
    return {
      messages: renderTemplate(template(), {
        company: j?.company ?? "示例公司",
        title: j?.title ?? "AI 应用开发工程师",
        candidateName: r?.name ?? "候选人",
        years: String(r?.years ?? 7),
        skills: r?.skills.join("、") || "Java、AI",
      }),
    };
  });
  app.put("/api/providers", (req) => {
    const next = z.array(providerSchema).max(10).parse(req.body);
    if (new Set(next.map((p) => p.id)).size !== next.length)
      throw new Error("模型 ID 不可重复");
    const old = getProviders();
    const merged = next.map((p) => ({
      ...p,
      apiKey:
        p.apiKey === undefined
          ? old.find((x) => x.id === p.id)?.apiKey
          : p.apiKey,
    }));
    o.store.set("providers", encrypt(merged, o.key));
    return merged.map(cleanProvider);
  });
  app.put("/api/embedding", (req) => {
    const b = embeddingSchema.parse(req.body);
    const next = {
      ...b,
      apiKey: b.apiKey === undefined ? getEmbedding().apiKey : b.apiKey,
    };
    o.store.set("embedding", encrypt(next, o.key));
    return { ...next, apiKey: undefined, hasKey: !!next.apiKey };
  });
  app.post("/api/providers/test", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.body);
    const p = runtimeProviders().find((x) => x.id === id);
    if (!p) throw new Error("模型配置不存在");
    return chat(
      [{ ...p, enabled: true }],
      [{ role: "user", content: "Reply with OK." }],
    );
  });
  app.post("/api/embedding/test", async () =>
    embed(getEmbedding(), ["connection check"]),
  );
  async function bridge(path: string, method = "GET") {
    if (!o.bridgeUrl)
      throw new Error("ChatGPT 容器尚未启用，请使用 chatgpt profile 启动");
    const r = await fetch(o.bridgeUrl + path, {
      method,
      headers: {
        authorization: `Bearer ${o.internalToken}`,
        "content-type": "application/json",
      },
      ...(method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(20000),
    });
    const b = await r.json();
    if (!r.ok)
      throw new Error(
        typeof b.error === "string" ? b.error : JSON.stringify(b),
      );
    return b;
  }
  app.get("/api/chatgpt/account", () => bridge("/account"));
  app.get("/api/chatgpt/models", () => bridge("/models"));
  app.post("/api/chatgpt/login", () => bridge("/login", "POST"));
  app.post("/api/sources", (req) => {
    const b = sourceSchema.parse(req.body);
    const u = new URL(b.url);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      throw new Error("来源网址不正确");
    if (!b.allowedHosts.includes(u.hostname))
      throw new Error("入口域名必须在允许列表中");
    const next: JobSource = {
      ...b,
      id: randomUUID(),
      lastSuccess: null,
      lastError: null,
    };
    o.store.set("sources", [...o.store.get<JobSource[]>("sources", []), next]);
    return next;
  });
  app.delete<{ Params: { id: string } }>("/api/sources/:id", (req) => {
    o.store.set(
      "sources",
      o.store
        .get<JobSource[]>("sources", [])
        .filter((s) => s.id !== req.params.id),
    );
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/sources/:id/sync", (req) => {
    const s = o.store
      .get<JobSource[]>("sources", [])
      .find((s) => s.id === req.params.id);
    if (!s?.enabled) throw new Error("来源不存在或未启用");
    if (
      o.store
        .tasks()
        .some(
          (t) =>
            ["queued", "leased"].includes(t.status) &&
            (t.payload as JobSource).id === s.id,
        )
    )
      throw new Error("该来源已有同步任务");
    return {
      taskId: o.store.enqueue(s.kind === "boss" ? "boss-collect" : "crawl", s),
    };
  });
  app.post("/api/jobs/import", (req) => {
    const list = z.array(jobSchema).max(500).parse(req.body);
    o.store.transaction(() => list.forEach((j) => o.store.upsertJob(j)));
    return { count: list.length };
  });
  app.post("/api/assess", async (req) => {
    const b = z
      .object({ jobIds: z.array(z.string()).min(1).max(50) })
      .parse(req.body);
    const results: Assessment[] = [];
    for (const id of [...new Set(b.jobIds)]) {
      const j = o.store.job(id);
      if (!j) continue;
      results.push(await scoreJob(id));
    }
    return results;
  });
  app.post("/api/jobs/search", async (req) => {
    const b = z
      .object({
        query: z.string().max(1000).default(""),
        company: z.string().default(""),
        title: z.string().default(""),
        location: z.string().default(""),
        salaryMin: z.number().default(0),
        exact: z.boolean().default(false),
        semantic: z.boolean().default(false),
      })
      .parse(req.body ?? {});
    const matches = (value: string, needle: string) =>
      !needle ||
      (b.exact
        ? value.toLowerCase() === needle.toLowerCase()
        : value.toLowerCase().includes(needle.toLowerCase()));
    let jobs = o.store
      .jobs()
      .filter(
        (j) =>
          matches(j.company, b.company) &&
          matches(j.title, b.title) &&
          matches(j.location ?? "", b.location) &&
          (b.salaryMin === 0 ||
            (j.salaryMin !== null && j.salaryMin >= b.salaryMin)),
      );
    if (!b.semantic)
      return jobs
        .filter((j) =>
          matches(`${j.title} ${j.company} ${j.description}`, b.query),
        )
        .map((j) => ({ ...j, assessment: assessment(j), similarity: null }));
    if (!b.query.trim()) throw new Error("语义搜索需要输入描述");
    const config = getEmbedding();
    if (!config.enabled) throw new Error("请先配置并启用独立的向量模型");
    jobs = jobs.slice(0, 200);
    const queryResult = await embed(config, [b.query]);
    const q = queryResult.vectors[0];
    const vectorKey = (j: Job) =>
      "vector:" +
      fingerprint({ identity: queryResult.identity, job: j.contentHash });
    const missing = jobs.filter(
      (j) => !o.store.get<number[] | null>(vectorKey(j), null),
    );
    for (let offset = 0; offset < missing.length; offset += 20) {
      const batch = missing.slice(offset, offset + 20);
      const result = await embed(
        config,
        batch.map((j) => `${j.title}\n${j.description}`.slice(0, 8000)),
      );
      if (result.identity !== queryResult.identity)
        throw new Error("向量模型或维度发生变化，请重新搜索");
      batch.forEach((j, i) => o.store.set(vectorKey(j), result.vectors[i]));
    }
    const cosine = (v: number[]) => {
      if (v.length !== q.length) throw new Error("向量维度不一致");
      const norm = Math.sqrt(
        v.reduce((n, x) => n + x * x, 0) * q.reduce((n, x) => n + x * x, 0),
      );
      return norm ? v.reduce((n, x, i) => n + x * q[i], 0) / norm : 0;
    };
    return jobs
      .map((j) => ({
        ...j,
        assessment: assessment(j),
        similarity: cosine(o.store.get<number[]>(vectorKey(j), [])),
      }))
      .sort((a, b) => b.similarity - a.similarity);
  });
  function draft(ids: string[]): Application[] {
    const r = resume();
    if (!r) throw new Error("请先导入简历");
    const t = template();
    const batchId = randomUUID();
    return [...new Set(ids)].map((id) => {
      const j = o.store.job(id);
      if (!j) throw new Error("岗位不存在");
      if (j.source !== "boss") throw new Error("官网岗位请打开原始申请入口");
      if (o.store.applications().some((a) => a.jobId === id))
        throw new Error("该岗位已有投递记录");
      const a = assessment(j);
      if (a?.decision !== "eligible")
        throw new Error("岗位尚未达到自动投递要求，请先完成匹配评估");
      const messages = renderTemplate(t, {
        company: j.company,
        title: j.title,
        candidateName: r.name,
        years: String(r.years),
        skills: r.skills.join("、"),
      });
      if (t.attachmentPolicy !== "message-only" && !r.attachmentName)
        throw new Error("发送简历需要先上传附件");
      const now = new Date().toISOString();
      const actions: ApplicationAction[] = [
        {
          id: randomUUID(),
          kind: "native-greeting",
          index: 0,
          text: null,
          state: "pending",
          evidence: null,
          updatedAt: now,
        },
        ...messages.map((text, i) => ({
          id: randomUUID(),
          kind: "message" as const,
          index: i + 1,
          text,
          state: "pending" as const,
          evidence: null,
          updatedAt: now,
        })),
      ];
      if (t.attachmentPolicy === "send-after-messages")
        actions.push({
          id: randomUUID(),
          kind: "attachment",
          index: messages.length + 1,
          text: null,
          state: "pending",
          evidence: null,
          updatedAt: now,
        });
      return {
        id: randomUUID(),
        batchId,
        jobId: id,
        job: j,
        resumeId: r.id,
        resumeAttachment: r.attachmentName,
        templateVersion: t.version,
        frozenMessages: messages,
        attachmentPolicy: t.attachmentPolicy,
        status: "queued",
        actions,
        createdAt: now,
      };
    });
  }
  app.post("/api/batches/preview", (req) => {
    const b = z
      .object({ jobIds: z.array(z.string()).min(1).max(10) })
      .parse(req.body);
    const drafts = draft(b.jobIds);
    const previewId = randomUUID();
    o.store.set("preview:" + previewId, {
      drafts,
      policy: policy(),
      resumeId: resume()?.id,
      templateVersion: template().version,
      expires: Date.now() + 15 * 60000,
    });
    return { previewId, applications: drafts };
  });
  async function worker(path: string, method = "GET") {
    if (!o.workerUrl) throw new Error("浏览器服务尚未连接");
    const r = await fetch(o.workerUrl + path, {
      method,
      headers: {
        authorization: `Bearer ${o.internalToken}`,
        "content-type": "application/json",
      },
      ...(method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(path === "/takeover/start" ? 60000 : 10000),
    });
    const b = await r.json();
    if (!r.ok) throw new Error(b.error ?? "浏览器服务不可用");
    return b;
  }
  app.get("/api/browser/status", () => worker("/status"));
  app.post("/api/browser/takeover", async () => {
    if (!o.workerUrl) throw new Error("浏览器服务尚未连接");
    o.store.set("paused", true);
    o.store.set("takeover", true);
    try {
      const result = await worker("/takeover/start", "POST");
      o.store.set("browserUncertain", false);
      return result;
    } catch (e) {
      o.store.set("takeover", false);
      o.store.set("browserUncertain", true);
      throw e;
    }
  });
  app.post("/api/browser/release", async () => {
    try {
      const r = await worker("/takeover/stop", "POST");
      o.store.set("browserUncertain", false);
      return r;
    } catch (e) {
      o.store.set("paused", true);
      o.store.set("browserUncertain", true);
      throw e;
    } finally {
      o.store.set("takeover", false);
      for (const sockets of sessionSockets.values())
        for (const socket of sockets) socket.destroy();
      sessionSockets.clear();
    }
  });
  app.post("/api/batches", async (req) => {
    const b = z.object({ previewId: z.string() }).parse(req.body);
    const preview = o.store.get<{
      drafts: Application[];
      policy: MatchPolicy;
      resumeId: string;
      templateVersion: number;
      expires: number;
    } | null>("preview:" + b.previewId, null);
    if (!preview || preview.expires < Date.now())
      throw new Error("预览已过期，请重新预览");
    if (
      fingerprint(preview.policy) !== fingerprint(policy()) ||
      preview.resumeId !== resume()?.id ||
      preview.templateVersion !== template().version
    )
      throw new Error("策略、简历或话术已变化，请重新预览");
    const status = await worker("/status");
    if (status.liveApplyReady !== true)
      throw new Error(
        "BOSS 实际发送适配尚未完成验证，当前只能采集、分析和预览",
      );
    o.store.transaction(() => {
      for (const a of preview.drafts) {
        const current = o.store.job(a.jobId);
        if (
          !current ||
          current.contentHash !== a.job.contentHash ||
          assessment(current)?.decision !== "eligible"
        )
          throw new Error("岗位或匹配结果已变化，请重新预览");
        o.store.insertApplication(a);
        o.store.enqueue("apply", a);
      }
      o.store.set("preview:" + b.previewId, null);
    });
    return { count: preview.drafts.length };
  });
  app.post("/api/queue/pause", () => {
    o.store.set("paused", true);
    return { paused: true };
  });
  app.post("/api/queue/resume", async () => {
    if (o.store.get("takeover", false)) throw new Error("请先结束人工接管");
    if (o.store.get("browserUncertain", false)) {
      const status = await worker("/status");
      if (status.takeover || status.working)
        throw new Error("浏览器仍在工作，请结束接管或重启浏览器服务后再恢复");
      o.store.set("browserUncertain", false);
    }
    o.store.set("paused", false);
    return { paused: false };
  });
  app.get("/api/export", () => ({
    exportedAt: new Date().toISOString(),
    jobs: o.store.jobs(),
    applications: o.store.applications(),
  }));
  app.post("/api/backup", async (_req, reply) => {
    const file = join(o.dataDir, `backup-${randomUUID()}.sqlite`);
    await o.store.backup(file);
    const buffer = readFileSync(file);
    await rm(file);
    return reply
      .type("application/vnd.sqlite3")
      .header(
        "Content-Disposition",
        'attachment; filename="job-assistant.sqlite"',
      )
      .send(buffer);
  });
  app.post("/internal/tasks/claim", () => ({ task: o.store.claim() }));
  app.post<{ Params: { id: string } }>(
    "/internal/tasks/:id/heartbeat",
    (req) => {
      const b = z.object({ leaseToken: z.string() }).parse(req.body);
      o.store.heartbeat(req.params.id, b.leaseToken);
      return {
        ok: true,
        paused: o.store.get("paused", false),
        takeover: o.store.get("takeover", false),
      };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/internal/applications/:id/actions",
    (req) => {
      const b = z
        .object({
          taskId: z.string(),
          leaseToken: z.string(),
          action: actionSchema,
        })
        .parse(req.body);
      return {
        application: o.store.recordAction(
          b.taskId,
          b.leaseToken,
          req.params.id,
          b.action,
        ),
      };
    },
  );
  app.post<{ Params: { id: string } }>("/internal/tasks/:id/result", (req) => {
    const b = z
      .object({ leaseToken: z.string(), result: z.unknown() })
      .parse(req.body);
    const receiptKey = "receipt:" + req.params.id;
    const receipt = fingerprint(b);
    const existing = o.store.get<string | null>(receiptKey, null);
    if (existing) {
      if (existing !== receipt) throw new Error("重复回调内容不一致");
      return { ok: true };
    }
    const task = o.store.requireLease(req.params.id, b.leaseToken);
    const result = b.result as {
      jobs?: Job[];
      application?: Application;
      error?: string;
      status?: string;
    };
    if (!result || typeof result !== "object")
      throw new Error("任务结果格式不正确");
    o.store.transaction(() => {
      if (task.kind === "apply") {
        const a = o.store.application((task.payload as Application).id);
        if (!a) throw new Error("记录不存在");
        const completed =
          !result.error &&
          result.application?.status === "completed" &&
          a.actions.every((x) => ["confirmed", "skipped"].includes(x.state));
        a.status = completed ? "completed" : "needs-review";
        o.store.updateApplication(a);
        o.store.finishTask(
          task.id,
          b.leaseToken,
          { status: a.status },
          completed ? "completed" : "needs-review",
        );
      } else {
        if (result.jobs) {
          const jobs = z.array(jobSchema).max(1000).parse(result.jobs);
          for (const j of jobs) {
            if (j.sourceId !== (task.payload as JobSource).id)
              throw new Error("来源 ID 不匹配");
            o.store.upsertJob(j);
          }
        }
        const failed = !!result.error;
        const sources = o.store.get<JobSource[]>("sources", []).map((s) =>
          s.id === (task.payload as JobSource).id
            ? {
                ...s,
                lastError: result.error ?? null,
                lastSuccess: failed ? s.lastSuccess : new Date().toISOString(),
              }
            : s,
        );
        o.store.set("sources", sources);
        o.store.finishTask(
          task.id,
          b.leaseToken,
          { count: result.jobs?.length ?? 0, error: result.error ?? null },
          failed ? "failed" : "completed",
        );
      }
      o.store.set(receiptKey, receipt);
    });
    return { ok: true };
  });
  const workerWsOptions = {
    headers: { authorization: `Bearer ${o.internalToken}` },
    rewriteRequestHeaders: () => ({
      authorization: `Bearer ${o.internalToken}`,
    }),
  };
  if (o.workerUrl)
    await app.register(proxy, {
      upstream: o.workerUrl,
      prefix: "/browser",
      rewritePrefix: "/browser",
      websocket: true,
      wsClientOptions: workerWsOptions,
      replyOptions: {
        rewriteRequestHeaders: (_req, headers) => {
          const forwarded = {
            ...headers,
            authorization: `Bearer ${o.internalToken}`,
          };
          delete forwarded.cookie;
          return forwarded;
        },
      },
    });
  const webDir = o.webDir ?? resolve("dist/web");
  if (existsSync(webDir)) {
    await app.register(staticPlugin, { root: webDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "接口不存在" })
        : reply.sendFile("index.html"),
    );
  }
  return app;
}

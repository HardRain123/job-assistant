import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { Store } from "../../../packages/storage/src/index.ts";
import { parseSalary } from "../../../packages/sources/src/index.ts";
import type { Job } from "../../../packages/contracts/src/index.ts";
import { equal } from "./security.ts";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const connectionKey = "browserExtension.connection";
interface Connection {
  hash: string;
  origin: string;
  expiresAt: number;
  lastSeen: string | null;
  lastImport: string | null;
  importedCount: number;
  version?: string;
}
const itemSchema = z
  .object({
    url: z.string().url().max(2000),
    title: z.string().trim().min(1).max(500),
    company: z.string().trim().min(1).max(500),
    companyAliases: z.array(z.string().trim().min(1).max(160)).max(5).optional(),
    description: z.string().trim().min(1).max(50000),
    location: z.string().trim().max(500).nullable().optional(),
    salaryText: z.string().trim().max(200).nullable().optional(),
    industry: z.string().trim().max(200).nullable().optional(),
    experienceText: z.string().trim().max(200).nullable().optional(),
    education: z.string().trim().max(200).nullable().optional(),
    detail: z.boolean().default(false),
  })
  .strict();

export function createExtensionAccess(store: Store, now = Date.now) {
  let pending: { hash: string; expiresAt: number; attempts: number } | null =
    null;
  const connection = () => store.get<Connection | null>(connectionKey, null);
  const status = () => {
    const c = connection();
    return {
      paired: !!c && c.expiresAt > now(),
      expiresAt: c?.expiresAt ?? null,
      lastSeen: c?.lastSeen ?? null,
      lastImport: c?.lastImport ?? null,
      importedCount: c?.importedCount ?? 0,
      version: c?.version ?? null,
    };
  };
  // Only these routes are exempted from workbench cookie auth. A separate,
  // origin-bound credential never grants access to workbench/internal APIs.
  const routes: Record<string, string> = {
    "/extension/v1/pair": "POST",
    "/extension/v1/status": "POST",
    "/extension/v1/jobs": "POST",
    "/extension/v1/connection": "DELETE",
    "/extension/v1/claim": "POST",
    "/extension/v1/result": "POST",
    "/extension/v1/automation-status": "POST",
  };
  async function guard(req: FastifyRequest, reply: FastifyReply) {
    const path = req.url.split("?")[0]!;
    const origin = req.headers.origin ?? "";
    if (
      !routes[path] ||
      !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) ||
      !["localhost", "127.0.0.1"].includes(
        req.headers.host?.split(":")[0] ?? "",
      )
    ) {
      return reply.code(403).send({ error: "扩展来源或接口不受信任" });
    }
    reply
      .header("Access-Control-Allow-Origin", origin)
      .header("Vary", "Origin");
    if (req.method === "OPTIONS") {
      const headers = (req.headers["access-control-request-headers"] ?? "")
        .toLowerCase()
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      if (
        req.headers["access-control-request-method"] !== routes[path] ||
        headers.some(
          (x) =>
            !["authorization", "content-type", "x-extension-version"].includes(
              x,
            ),
        )
      ) {
        return reply.code(403).send({ error: "扩展请求不受支持" });
      }
      return reply
        .header("Access-Control-Allow-Methods", routes[path]!)
        .header(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type, X-Extension-Version",
        )
        .code(204)
        .send();
    }
    if (req.method !== routes[path])
      return reply.code(405).send({ error: "请求方式不受支持" });
    if (path === "/extension/v1/pair") return;
    const c = connection();
    const token = req.headers.authorization?.match(
      /^Bearer ([a-f0-9]{64})$/,
    )?.[1];
    if (
      !c ||
      c.expiresAt <= now() ||
      c.origin !== origin ||
      !token ||
      !equal(c.hash, digest(token))
    ) {
      return reply
        .code(401)
        .send({ error: "扩展连接已失效，请在工作台重新配对" });
    }
    const version = req.headers["x-extension-version"];
    store.set(connectionKey, {
      ...c,
      lastSeen: new Date(now()).toISOString(),
      ...(typeof version === "string" &&
      /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version)
        ? { version }
        : {}),
    });
  }
  let importJobs: (
    body: unknown,
    withinTransaction?: boolean,
  ) => { count: number; jobIds: string[] };
  function register(app: FastifyInstance) {
    app.post("/api/extension/pair-code", () => {
      const code = randomBytes(16).toString("hex");
      pending = {
        hash: digest(code),
        expiresAt: now() + 5 * 60000,
        attempts: 0,
      };
      return { code, expiresAt: pending.expiresAt };
    });
    app.get("/api/extension/status", status);
    const revoke = () => {
      pending = null;
      store.set(connectionKey, null);
      store.audit("extension.revoked", {});
      return { ok: true };
    };
    app.delete("/api/extension/connection", revoke);
    app.options("/extension/v1/:action", (_req, reply) =>
      reply.code(404).send(),
    );
    app.post("/extension/v1/pair", (req, reply) => {
      const code = z
        .object({ code: z.string().regex(/^[a-f0-9]{32}$/) })
        .safeParse(req.body);
      if (
        !pending ||
        pending.expiresAt <= now() ||
        ++pending.attempts > 10 ||
        !code.success ||
        !equal(pending.hash, digest(code.data.code))
      ) {
        return reply
          .code(401)
          .send({ error: "配对码无效或已过期，请在工作台重新生成" });
      }
      pending = null;
      const token = randomBytes(32).toString("hex");
      const expiresAt = now() + 7 * 86400000;
      store.set(connectionKey, {
        hash: digest(token),
        origin: req.headers.origin!,
        expiresAt,
        lastSeen: new Date(now()).toISOString(),
        lastImport: null,
        importedCount: 0,
      } satisfies Connection);
      store.audit("extension.paired", { expiresAt });
      return { token, expiresAt };
    });
    // Extension GET fetches can omit Origin in Chrome. POST preserves the
    // existing origin-bound credential check without weakening that boundary.
    app.post("/extension/v1/status", () => ({
      connected: true,
      expiresAt: connection()!.expiresAt,
    }));
    app.delete("/extension/v1/connection", revoke);
    importJobs = (body, withinTransaction = false) => {
      const { jobs } = z
        .object({ jobs: z.array(itemSchema).min(1).max(30) })
        .strict()
        .parse(body);
      const timestamp = new Date(now()).toISOString();
      // Validate all links before any database writes. Strip referral/query data.
      const normalized = jobs.map((item) => {
        const url = new URL(item.url);
        const id = url.pathname.match(
          /^\/job_detail\/([a-zA-Z0-9_-]+)\.html$/,
        )?.[1];
        if (
          url.origin !== "https://www.zhipin.com" ||
          url.username ||
          url.password ||
          !id
        )
          throw new Error("只接受 BOSS 官方岗位详情链接");
        url.search = "";
        url.hash = "";
        return { item, id, url: url.href };
      });
      const ids = new Set<string>();
      const commit = () => {
        for (const { item, id, url } of normalized) {
          const existing = store
            .jobs()
            .find((j) => j.source === "boss" && j.sourceJobId === id);
          if (
            existing &&
            !item.detail &&
            store.get(`browserExtension.detail:${existing.id}`, true)
          ) {
            store.upsertJob({ ...existing, lastSeen: timestamp });
            ids.add(existing.id);
            continue;
          }
          const experience = item.experienceText?.match(
            /^(\d+)(?:\s*[-–~至]\s*\d+)?\s*年/,
          );
          // BOSS range labels such as "20-30K" are monthly. Do not append
          // monthly units to daily, hourly, yearly or otherwise unclear pay.
          const salaryText = item.salaryText ?? "";
          const monthlyLabel =
            /^\s*\d+(?:\.\d+)?\s*[kK千万元]?\s*[-–~至]\s*\d+(?:\.\d+)?\s*[kK千万]\s*$/.test(
              salaryText,
            );
          const salary = parseSalary(
            monthlyLabel ? salaryText.replace("–", "-") + "/月" : salaryText,
          );
          const j: Job = {
            id: existing?.id ?? randomUUID(),
            source: "boss",
            sourceId: existing?.sourceId ?? "boss-browser-extension",
            sourceJobId: id,
            url,
            company: item.company,
            companyAliases: [...new Set(item.companyAliases ?? [])].filter((name) => name !== item.company),
            industry: item.industry || null,
            title: item.title,
            location: item.location || null,
            remote: null,
            ...salary,
            experienceMin: experience ? Number(experience[1]) : null,
            description: item.description,
            skills: [],
            education: item.education || null,
            firstSeen: timestamp,
            lastSeen: timestamp,
            contentHash: "pending",
            status: "active",
          };
          store.upsertJob(j);
          store.set(`browserExtension.detail:${j.id}`, item.detail);
          ids.add(j.id);
        }
        const c = connection()!;
        store.set(connectionKey, {
          ...c,
          lastImport: timestamp,
          importedCount: c.importedCount + ids.size,
        });
        store.audit("extension.imported", {
          count: ids.size,
          jobIds: [...ids],
        });
      };
      if (withinTransaction) commit();
      else store.transaction(commit);
      return { count: ids.size, jobIds: [...ids] };
    };
    app.post("/extension/v1/jobs", (req) => importJobs(req.body));
  }
  return {
    guard,
    register,
    status,
    importJobs: (body: unknown, withinTransaction = false) =>
      importJobs(body, withinTransaction),
  };
}

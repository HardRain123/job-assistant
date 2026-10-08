import { z } from "zod";
const text = z.string().trim().min(1).max(500);
const strings = z.array(z.string().trim().min(1).max(200)).max(100);
export const policySchema = z
  .object({
    version: z.number().int().optional(),
    cities: strings,
    allowRemote: z.boolean(),
    salaryMin: z.number().min(0).max(1000000),
    excludedCompanies: strings,
    excludedIndustries: strings,
    requiredSkills: strings,
    autoThreshold: z.number().min(1).max(100),
    reviewThreshold: z.number().min(0).max(100),
    reviewMargin: z.number().min(0).max(20),
    weights: z.object({
      skills: z.number().min(0),
      responsibilities: z.number().min(0),
      experience: z.number().min(0),
      qualifications: z.number().min(0),
      preferences: z.number().min(0),
    }),
  })
  .refine(
    (x) =>
      x.reviewThreshold <= x.autoThreshold &&
      Math.abs(Object.values(x.weights).reduce((a, b) => a + b, 0) - 100) <
        0.001,
    "阈值顺序不正确或权重总和不为 100",
  );
export const providerSchema = z.object({
  id: text,
  name: text,
  kind: z.enum(["openai-compatible", "codex"]),
  baseUrl: z.string().url(),
  model: text,
  protocol: z.enum(["chat-completions", "responses"]),
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(100),
  timeoutMs: z.number().int().min(1000).max(180000),
  apiKey: z.string().max(4096).optional(),
  hasKey: z.boolean().optional(),
});
export const embeddingSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().url(),
  model: z.string().max(200),
  apiKey: z.string().max(4096).optional(),
  hasKey: z.boolean().optional(),
});
export const templateSchema = z.object({
  name: text,
  segments: z.array(z.string().min(1).max(2000)).min(1).max(5),
  attachmentPolicy: z.enum(["message-only", "send-after-messages"]),
});
export const resumeSchema = z.object({
  name: text,
  text: z.string().min(20).max(100000),
  skills: strings,
  years: z.number().min(0).max(60),
});
export const sourceSchema = z.object({
  name: text,
  kind: z.enum(["official", "boss"]),
  url: z.string().url(),
  allowedHosts: z
    .array(z.string().regex(/^[a-zA-Z0-9.-]+$/))
    .min(1)
    .max(20),
  enabled: z.boolean(),
});
export const jobSchema = z.object({
  id: text,
  source: z.enum(["boss", "official"]),
  sourceId: text,
  sourceJobId: text,
  url: z.string().url(),
  company: text,
  companyAliases: strings,
  industry: z.string().nullable(),
  title: text,
  location: z.string().nullable(),
  remote: z.boolean().nullable(),
  salaryMin: z.number().min(0).nullable(),
  salaryMax: z.number().min(0).nullable(),
  salaryMonths: z.number().min(0).nullable(),
  experienceMin: z.number().min(0).nullable(),
  description: z.string().min(1).max(200000),
  skills: strings,
  education: z.string().nullable(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  contentHash: text,
  status: z.enum(["active", "unknown", "closed"]),
});
export const actionSchema = z.object({
  id: text,
  kind: z.enum(["native-greeting", "message", "attachment"]),
  index: z.number().int(),
  text: z.string().nullable(),
  state: z.enum([
    "pending",
    "started",
    "confirmed",
    "unknown",
    "failed",
    "awaiting-acceptance",
    "skipped",
  ]),
  evidence: z.string().max(10000).nullable(),
  updatedAt: z.string(),
});

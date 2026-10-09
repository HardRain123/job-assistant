export type SourceKind = "boss" | "official";
export interface Job {
  id: string;
  source: SourceKind;
  sourceId: string;
  sourceJobId: string;
  url: string;
  company: string;
  companyAliases: string[];
  industry: string | null;
  title: string;
  location: string | null;
  remote: boolean | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryMonths: number | null;
  experienceMin: number | null;
  description: string;
  skills: string[];
  education: string | null;
  firstSeen: string;
  lastSeen: string;
  contentHash: string;
  status: "active" | "unknown" | "closed";
}
export interface JobSource {
  id: string;
  name: string;
  kind: SourceKind;
  url: string;
  allowedHosts: string[];
  enabled: boolean;
  lastSuccess: string | null;
  lastError: string | null;
}
export interface Resume {
  id: string;
  name: string;
  text: string;
  skills: string[];
  years: number;
  attachmentName: string | null;
  createdAt: string;
}
export interface MatchPolicy {
  version: number;
  cities: string[];
  allowRemote: boolean;
  salaryMin: number;
  excludedCompanies: string[];
  excludedIndustries: string[];
  requiredSkills: string[];
  autoThreshold: number;
  reviewThreshold: number;
  reviewMargin: number;
  weights: {
    skills: number;
    responsibilities: number;
    experience: number;
    qualifications: number;
    preferences: number;
  };
}
export interface ProviderConfig {
  id: string;
  name: string;
  kind: "openai-compatible" | "codex";
  baseUrl: string;
  model: string;
  protocol: "chat-completions" | "responses";
  enabled: boolean;
  priority: number;
  timeoutMs: number;
  apiKey?: string;
  hasKey?: boolean;
}
export interface EmbeddingConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey?: string;
  hasKey?: boolean;
}
export interface Gate {
  field: string;
  status: "pass" | "fail" | "unknown";
  reason: string;
}
export interface Assessment {
  jobId: string;
  resumeId: string;
  policyVersion: number;
  score: number | null;
  decision: "eligible" | "review" | "skip" | "unavailable";
  gates: Gate[];
  dimensions: Record<string, { score: number; evidence: string }>;
  reasons: string[];
  provider: string | null;
  model: string | null;
  createdAt: string;
}
export interface MessageTemplate {
  id: string;
  version: number;
  name: string;
  segments: string[];
  attachmentPolicy: "message-only" | "send-after-messages";
}
export type ActionState =
  | "pending"
  | "started"
  | "confirmed"
  | "unknown"
  | "failed"
  | "awaiting-acceptance"
  | "skipped";
export interface ApplicationAction {
  id: string;
  kind: "native-greeting" | "message" | "attachment";
  index: number;
  text: string | null;
  state: ActionState;
  evidence: string | null;
  updatedAt: string;
}
export interface Application {
  id: string;
  executor?: "worker" | "extension";
  stopReason?: string;
  batchId: string;
  jobId: string;
  job: Job;
  resumeId: string;
  resumeAttachment: string | null;
  templateVersion: number;
  frozenMessages: string[];
  attachmentPolicy: MessageTemplate["attachmentPolicy"];
  status:
    | "queued"
    | "running"
    | "needs-review"
    | "completed"
    | "failed"
    | "cancelled";
  actions: ApplicationAction[];
  createdAt: string;
}
export interface Task {
  id: string;
  kind: "crawl" | "boss-collect" | "apply";
  payload: unknown;
  status: "queued" | "leased" | "completed" | "needs-review" | "failed";
  leaseToken: string | null;
  leaseUntil: string | null;
}
export const DEFAULT_POLICY: MatchPolicy = {
  version: 1,
  cities: ["上海"],
  allowRemote: true,
  salaryMin: 20000,
  excludedCompanies: [],
  excludedIndustries: [],
  requiredSkills: [],
  autoThreshold: 80,
  reviewThreshold: 65,
  reviewMargin: 5,
  weights: {
    skills: 35,
    responsibilities: 30,
    experience: 20,
    qualifications: 10,
    preferences: 5,
  },
};
export const TEMPLATE_VARIABLES = [
  "company",
  "title",
  "candidateName",
  "years",
  "skills",
] as const;
export const DEFAULT_TEMPLATE: MessageTemplate = {
  id: "default",
  version: 1,
  name: "初次沟通",
  segments: [
    "您好，看到贵司的{{title}}岗位与我的经历比较匹配。我有{{years}}年研发经验，熟悉{{skills}}，希望能进一步沟通。",
  ],
  attachmentPolicy: "message-only",
};

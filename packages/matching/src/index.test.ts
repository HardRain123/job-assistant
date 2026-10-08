import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POLICY,
  type Job,
  type ProviderConfig,
  type Resume,
} from "../../contracts/src/index.ts";
import { assessJob } from "./index.ts";

const job: Job = {
  id: "job",
  source: "official",
  sourceId: "s",
  sourceJobId: "j",
  url: "https://example.test",
  company: "Example",
  companyAliases: [],
  industry: "Software",
  title: "Engineer",
  location: "上海",
  remote: false,
  salaryMin: 25000,
  salaryMax: 35000,
  salaryMonths: 12,
  experienceMin: 3,
  description: "Build TypeScript services",
  skills: ["TypeScript"],
  education: null,
  firstSeen: "",
  lastSeen: "",
  contentHash: "",
  status: "active",
};
const resume: Resume = {
  id: "resume",
  name: "Anonymous",
  text: "Built TypeScript services",
  skills: ["TypeScript"],
  years: 5,
  attachmentName: null,
  createdAt: "",
};
const provider = (id: string, priority: number): ProviderConfig => ({
  id,
  name: id,
  kind: "openai-compatible",
  baseUrl: `https://${id}.example/v1`,
  model: "m",
  protocol: "chat-completions",
  enabled: true,
  priority,
  timeoutMs: 1000,
});
const dimensions = Object.fromEntries(
  [
    "skills",
    "responsibilities",
    "experience",
    "qualifications",
    "preferences",
  ].map((key) => [key, { score: 90, evidence: "TypeScript services" }]),
);

test("hard gate failure skips without making a model request", async () => {
  const result = await assessJob(
    { ...job, location: "北京" },
    resume,
    DEFAULT_POLICY,
    [provider("first", 1)],
    {
      fetch: async () => {
        throw new Error("must not call");
      },
    },
  );
  assert.equal(result.decision, "skip");
  assert.equal(result.score, null);
  assert.equal(result.gates.find((x) => x.field === "city")?.status, "fail");
});

test("unknown gate keeps high score in review", async () => {
  const result = await assessJob(
    { ...job, salaryMin: null },
    resume,
    DEFAULT_POLICY,
    [provider("first", 1)],
    {
      fetch: async () =>
        Response.json({
          choices: [{ message: { content: JSON.stringify({ dimensions }) } }],
        }),
    },
  );
  assert.equal(result.decision, "review");
  assert.equal(result.score, 90);
  assert.equal(
    result.gates.find((x) => x.field === "salary")?.status,
    "unknown",
  );
});

test("salary range lower bound must satisfy policy", async () => {
  const result = await assessJob(
    { ...job, salaryMin: 14000, salaryMax: 25000 },
    resume,
    DEFAULT_POLICY,
    [provider("first", 1)],
    {
      fetch: async () => {
        throw new Error("must not call");
      },
    },
  );
  assert.equal(result.decision, "skip");
  assert.equal(result.gates.find((x) => x.field === "salary")?.status, "fail");
});

test("anonymous client company stays in review even with known industry and a high score", async () => {
  const result = await assessJob(
    { ...job, company: "上海某大型电子商务公司" }, resume, DEFAULT_POLICY, [provider("first", 1)],
    { fetch: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ dimensions }) } }] }) },
  );
  assert.equal(result.decision, "review");
  assert.equal(result.gates.find((x) => x.field === "company")?.status, "unknown");
  const excluded = await assessJob(
    { ...job, company: "上海某大型电子商务公司", companyAliases: ["示例排除公司"] }, resume,
    { ...DEFAULT_POLICY, excludedCompanies: ["示例排除公司"] }, [provider("first", 1)],
    { fetch: async () => { throw new Error("must not call"); } },
  );
  assert.equal(excluded.decision, "skip");
  assert.equal(excluded.gates.find((x) => x.field === "company")?.status, "fail");
});

test("remote role outside preferred city needs review", async () => {
  const result = await assessJob(
    { ...job, remote: true, location: "海外" },
    resume,
    DEFAULT_POLICY,
    [provider("first", 1)],
    {
      fetch: async () =>
        Response.json({
          choices: [{ message: { content: JSON.stringify({ dimensions }) } }],
        }),
    },
  );
  assert.equal(result.decision, "review");
  assert.equal(result.gates.find((x) => x.field === "city")?.status, "unknown");
});

test("malformed scoring output falls back to next model", async () => {
  const seen: string[] = [];
  const result = await assessJob(
    job,
    resume,
    DEFAULT_POLICY,
    [provider("bad", 1), provider("good", 2)],
    {
      fetch: async (url) => {
        seen.push(String(url));
        return Response.json({
          choices: [
            {
              message: {
                content: String(url).includes("bad")
                  ? "{}"
                  : JSON.stringify({ dimensions }),
              },
            },
          ],
        });
      },
    },
  );
  assert.equal(result.decision, "eligible");
  assert.equal(result.provider, "good");
  assert.equal(seen.length, 2);
});


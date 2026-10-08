import test from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import type {
  Application,
  ApplicationAction,
  JobSource,
} from "../../contracts/src/index.ts";
import {
  collectBossPage,
  DomBossAdapter,
  FixtureBossAdapter,
  runApplication,
  type ActionJournal,
  type BossDomSelectors,
} from "./index.ts";

const action = (
  id: string,
  kind: ApplicationAction["kind"],
  index: number,
  text: string | null,
): ApplicationAction => ({
  id,
  kind,
  index,
  text,
  state: "pending",
  evidence: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const application = (actions: ApplicationAction[]): Application => ({
  id: "app-1",
  batchId: "batch-1",
  jobId: "job-1",
  job: {} as Application["job"],
  resumeId: "resume-1",
  resumeAttachment: "resume.pdf",
  templateVersion: 1,
  frozenMessages: ["first", "second"],
  attachmentPolicy: "send-after-messages",
  status: "queued",
  actions,
  createdAt: "2026-01-01T00:00:00.000Z",
});
const journaled: string[] = [];
const journal: ActionJournal = {
  before: async (_app, value) => {
    journaled.push(`before:${value.id}`);
  },
  after: async (_app, value, state) => {
    journaled.push(`after:${value.id}:${state}`);
  },
};

test("messages are confirmed in order before an attachment", async () => {
  journaled.length = 0;
  const adapter = new FixtureBossAdapter([
    "confirmed",
    "confirmed",
    "confirmed",
    "confirmed",
  ]);
  const result = await runApplication(
    application([
      action("native", "native-greeting", 0, null),
      action("m1", "message", 1, "first"),
      action("m2", "message", 2, "second"),
      action("a1", "attachment", 3, null),
    ]),
    adapter,
    journal,
    false,
  );
  assert.equal(result.result, "completed");
  assert.deepEqual(adapter.calls, [
    "message:native",
    "message:m1",
    "message:m2",
    "attachment:a1",
  ]);
  assert.deepEqual(journaled, [
    "before:native",
    "after:native:confirmed",
    "before:m1",
    "after:m1:confirmed",
    "before:m2",
    "after:m2:confirmed",
    "before:a1",
    "after:a1:confirmed",
  ]);
});

test("an unknown delivery stops the sequence and is never replayed automatically", async () => {
  const first = await runApplication(
    application([
      action("m1", "message", 0, "first"),
      action("a1", "attachment", 1, null),
    ]),
    new FixtureBossAdapter(["unknown"]),
    journal,
    false,
  );
  assert.equal(first.result, "needs-review");
  assert.equal(first.application.actions[0]!.state, "unknown");
  const secondAdapter = new FixtureBossAdapter(["confirmed"]);
  const second = await runApplication(
    first.application,
    secondAdapter,
    journal,
    false,
  );
  assert.equal(second.result, "needs-review");
  assert.deepEqual(secondAdapter.calls, []);
});

test("reconciliation allows later actions without duplicating a confirmed message", async () => {
  const prior = new Map<string, "confirmed">([["m1", "confirmed"]]);
  const adapter = new FixtureBossAdapter(["confirmed"], prior);
  const result = await runApplication(
    application([
      action("m1", "message", 0, "first"),
      action("a1", "attachment", 1, null),
    ]),
    adapter,
    journal,
    false,
  );
  assert.equal(result.result, "completed");
  assert.deepEqual(adapter.calls, ["attachment:a1"]);
});

test("read-only BOSS collector extracts an exact job detail URL from rendered cards", async () => {
  const fields = new Map([
    ['.company-name, [class*="company-name"]', "Acme"],
    ['.job-area, [class*="job-area"]', "上海"],
    ['.salary, [class*="salary"]', "20-30K·14薪"],
  ]);
  const card = {
    querySelector: (selector: string) =>
      fields.has(selector) ? { textContent: fields.get(selector) } : null,
    textContent: "AI Engineer Acme 上海 20-30K·14薪",
  };
  const link = {
    closest: () => card,
    getAttribute: () => "/job_detail/abc123.html",
    textContent: "AI Engineer",
  };
  const page = {
    url: () => "https://www.zhipin.com/web/geek/job",
    locator: () => ({
      evaluateAll: async (
        fn: (links: unknown[], max: number) => unknown,
        max: number,
      ) => fn([link], max),
    }),
  } as unknown as Page;
  const source: JobSource = {
    id: "boss-1",
    kind: "boss",
    name: "BOSS",
    url: page.url(),
    allowedHosts: ["zhipin.com"],
    enabled: true,
    lastSuccess: null,
    lastError: null,
  };
  const jobs = await collectBossPage(page, source);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.sourceJobId, "abc123");
  assert.equal(jobs[0]?.company, "Acme");
  assert.equal(jobs[0]?.salaryMonths, 14);
});

test("DOM adapter refuses an unmatched conversation before any send", async () => {
  const selectors: BossDomSelectors = {
    conversation: "#conversation",
    jobIdentity: ".job",
    companyIdentity: ".company",
    jobLink: ".job-link",
    nativeGreetingButton: ".greet",
    composer: ".composer",
    sendButton: ".send",
    outgoingMessage: ".outgoing",
    uploadInput: "input[type=file]",
    attachmentEvidence: ".attachment",
  };
  let clicks = 0;
  const conversation = {
    count: async () => 1,
    locator: (selector: string) => ({
      allTextContents: async () =>
        selector === ".job" ? ["Different job"] : ["Acme"],
      click: async () => {
        clicks += 1;
      },
    }),
  };
  const page = {
    url: () => "https://www.zhipin.com/web/geek/chat",
    locator: () => conversation,
  } as unknown as Page;
  const draft = application([action("m1", "message", 0, "first")]);
  draft.job = { title: "AI Engineer", company: "Acme" } as Application["job"];
  const adapter = new DomBossAdapter(page, draft, selectors, {
    verified: true,
  });
  await assert.rejects(() => adapter.sendMessage(draft.actions[0]!));
  assert.equal(clicks, 0);
});

test("DOM adapter confirms a new exact outgoing message in the matching job conversation", async () => {
  const selectors: BossDomSelectors = {
    conversation: "#conversation",
    jobIdentity: ".job",
    companyIdentity: ".company",
    jobLink: ".job-link",
    nativeGreetingButton: ".greet",
    composer: ".composer",
    sendButton: ".send",
    outgoingMessage: ".outgoing",
    uploadInput: "input[type=file]",
    attachmentEvidence: ".attachment",
  };
  const outgoing: string[] = [];
  let draftText = "";
  const conversation = {
    count: async () => 1,
    locator: (selector: string) => {
      if (selector === ".job")
        return { allTextContents: async () => ["AI Engineer"] };
      if (selector === ".company")
        return { allTextContents: async () => ["Acme"] };
      if (selector === ".job-link")
        return {
          count: async () => 1,
          getAttribute: async () => "/job_detail/abc123.html",
        };
      if (selector === ".outgoing")
        return {
          count: async () => outgoing.length,
          nth: (index: number) => ({
            waitFor: async () => {
              assert.ok(outgoing[index]);
            },
            innerText: async () => outgoing[index],
          }),
        };
      if (selector === ".composer")
        return {
          count: async () => 1,
          fill: async (value: string) => {
            draftText = value;
          },
        };
      if (selector === ".send")
        return {
          count: async () => 1,
          click: async () => {
            outgoing.push(draftText);
          },
        };
      throw new Error(`unexpected selector ${selector}`);
    },
  };
  const page = {
    url: () => "https://www.zhipin.com/web/geek/chat",
    locator: () => conversation,
  } as unknown as Page;
  const draft = application([action("m1", "message", 0, "first")]);
  draft.job = {
    title: "AI Engineer",
    company: "Acme",
    url: "https://www.zhipin.com/job_detail/abc123.html",
  } as Application["job"];
  const adapter = new DomBossAdapter(page, draft, selectors, {
    verified: true,
  });
  assert.equal(await adapter.sendMessage(draft.actions[0]!), "confirmed");
  assert.deepEqual(outgoing, ["first"]);
});

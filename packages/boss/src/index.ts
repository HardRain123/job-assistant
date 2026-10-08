import type {
  Application,
  ApplicationAction,
  Job,
} from "../../contracts/src/index.ts";
import type { Page } from "playwright";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { JobSource } from "../../contracts/src/index.ts";
import { parseSalary } from "../../sources/src/index.ts";

export type BossActionOutcome =
  | "confirmed"
  | "unknown"
  | "failed"
  | "awaiting-acceptance";
export interface BossAdapter {
  /** True only after selectors have been exercised against anonymized fixtures and reviewed. */
  readonly verified: boolean;
  readonly mode: "fixture" | "live";
  reconcile(
    application: Application,
  ): Promise<ReadonlyMap<string, "confirmed" | "unknown">>;
  sendMessage(action: ApplicationAction): Promise<BossActionOutcome>;
  sendAttachment(action: ApplicationAction): Promise<BossActionOutcome>;
  collect?(): Promise<Job[]>;
}
export interface ActionJournal {
  before(application: Application, action: ApplicationAction): Promise<void>;
  after(
    application: Application,
    action: ApplicationAction,
    state: BossActionOutcome,
    evidence: string,
  ): Promise<void>;
}
export interface RunResult {
  application: Application;
  result: "completed" | "needs-review" | "failed" | "blocked";
  reason?: string;
}

function copy(application: Application): Application {
  return structuredClone(application);
}
function setState(
  application: Application,
  id: string,
  state: ApplicationAction["state"],
  evidence: string | null,
): Application {
  return {
    ...application,
    actions: application.actions.map((action) =>
      action.id === id
        ? { ...action, state, evidence, updatedAt: new Date().toISOString() }
        : action,
    ),
  };
}
function isMessage(action: ApplicationAction): boolean {
  return action.kind === "native-greeting" || action.kind === "message";
}
function validatePlan(application: Application): string | null {
  let attachmentSeen = false;
  const messageTexts: string[] = [];
  for (const action of application.actions) {
    if (action.kind === "attachment") attachmentSeen = true;
    if (isMessage(action)) {
      if (attachmentSeen) return "message action appears after attachment";
      if (action.kind === "message" && !action.text?.trim())
        return "message action is empty";
      if (action.text) messageTexts.push(action.text);
    }
  }
  if (
    application.attachmentPolicy === "send-after-messages" &&
    application.actions.some((a) => a.kind === "attachment") &&
    !messageTexts.length
  )
    return "attachment requires at least one message";
  return null;
}

/**
 * The dispatcher deliberately never retries an ambiguous browser result. It can
 * only continue after a future reconciliation turns that result into confirmed.
 */
export async function runApplication(
  application: Application,
  adapter: BossAdapter,
  journal: ActionJournal,
  humanTakeover: boolean,
): Promise<RunResult> {
  let current = copy(application);
  const invalid = validatePlan(current);
  if (invalid)
    return {
      application: { ...current, status: "failed" },
      result: "failed",
      reason: invalid,
    };
  if (humanTakeover)
    return {
      application: { ...current, status: "needs-review" },
      result: "blocked",
      reason: "human takeover lock is active",
    };
  if (!adapter.verified)
    return {
      application: { ...current, status: "needs-review" },
      result: "blocked",
      reason: "BOSS adapter is unverified; live browser actions are disabled",
    };

  const observed = await adapter.reconcile(current);
  for (const action of current.actions) {
    const state = observed.get(action.id);
    if (state === "confirmed" && action.state !== "confirmed")
      current = setState(
        current,
        action.id,
        "confirmed",
        "reconciled from fixture/browser evidence",
      );
    if (state === "unknown")
      current = setState(
        current,
        action.id,
        "unknown",
        "unable to determine prior delivery",
      );
  }
  if (
    current.actions.some(
      (action) => action.state === "unknown" || action.state === "started",
    )
  )
    return {
      application: { ...current, status: "needs-review" },
      result: "needs-review",
      reason: "an earlier browser result is ambiguous; no replay performed",
    };

  for (const action of current.actions) {
    if (action.state === "confirmed" || action.state === "skipped") continue;
    if (action.state === "awaiting-acceptance")
      return {
        application: { ...current, status: "needs-review" },
        result: "needs-review",
        reason: "attachment request awaits recruiter acceptance",
      };
    if (action.state === "failed")
      return {
        application: { ...current, status: "failed" },
        result: "failed",
        reason: "prior action failed",
      };
    if (
      action.kind === "attachment" &&
      current.actions
        .filter(isMessage)
        .some(
          (message) =>
            message.state !== "confirmed" && message.state !== "skipped",
        )
    )
      return {
        application: { ...current, status: "needs-review" },
        result: "needs-review",
        reason: "attachment held until every message is confirmed",
      };
    try {
      await journal.before(current, action);
    } catch {
      return {
        application: { ...current, status: "needs-review" },
        result: "needs-review",
        reason: "could not journal action before browser side effect",
      };
    }
    current = setState(
      current,
      action.id,
      "started",
      "journaled before browser action",
    );
    let outcome: BossActionOutcome;
    try {
      outcome =
        action.kind === "attachment"
          ? await adapter.sendAttachment(action)
          : await adapter.sendMessage(action);
    } catch {
      outcome = "unknown";
    }
    const evidence =
      outcome === "confirmed"
        ? "fixture/browser confirmed action"
        : outcome === "awaiting-acceptance"
          ? "attachment request submitted; recruiter acceptance pending"
          : outcome === "unknown"
            ? "browser outcome ambiguous; manual reconciliation required"
            : "browser reported failure";
    try {
      await journal.after(current, action, outcome, evidence);
    } catch {
      return {
        application: setState(
          current,
          action.id,
          "unknown",
          "completion callback failed after browser side effect",
        ),
        result: "needs-review",
        reason: "completion callback failed; no replay performed",
      };
    }
    current = setState(current, action.id, outcome, evidence);
    if (outcome !== "confirmed")
      return {
        application: {
          ...current,
          status: outcome === "failed" ? "failed" : "needs-review",
        },
        result: outcome === "failed" ? "failed" : "needs-review",
        reason: evidence,
      };
  }
  return {
    application: { ...current, status: "completed" },
    result: "completed",
  };
}

/** Test-only adapter. Production live selectors remain deliberately unimplemented. */
export class FixtureBossAdapter implements BossAdapter {
  readonly verified = true as const;
  readonly mode = "fixture" as const;
  readonly calls: string[] = [];
  constructor(
    private readonly outcomes: BossActionOutcome[] = [],
    private readonly prior = new Map<string, "confirmed" | "unknown">(),
  ) {}
  async reconcile(): Promise<ReadonlyMap<string, "confirmed" | "unknown">> {
    return this.prior;
  }
  async sendMessage(action: ApplicationAction): Promise<BossActionOutcome> {
    this.calls.push(`message:${action.id}`);
    return this.outcomes.shift() ?? "confirmed";
  }
  async sendAttachment(action: ApplicationAction): Promise<BossActionOutcome> {
    this.calls.push(`attachment:${action.id}`);
    return this.outcomes.shift() ?? "confirmed";
  }
}

export class UnverifiedLiveBossAdapter implements BossAdapter {
  readonly verified = false as const;
  readonly mode = "live" as const;
  async reconcile(): Promise<ReadonlyMap<string, "confirmed" | "unknown">> {
    return new Map();
  }
  async sendMessage(): Promise<BossActionOutcome> {
    throw new Error(
      "live BOSS sending is disabled until selectors are fixture-verified",
    );
  }
  async sendAttachment(): Promise<BossActionOutcome> {
    throw new Error(
      "live BOSS sending is disabled until selectors are fixture-verified",
    );
  }
}

/**
 * Candidate selectors observed in BOSS page markup. They have not been
 * fixture-verified and are intentionally read-only: observations are evidence
 * for adapter work, never normalized jobs or a reason to enable live actions.
 */
export const UNVERIFIED_BOSS_READONLY_SELECTORS = Object.freeze({
  jobCard: "[data-jd-id]",
  title: 'a[href*="job_detail"]',
});
export interface BossObservation {
  selector: string;
  id: string | null;
  text: string;
  href: string | null;
}
export async function inspectUnverifiedBossPage(
  page: Page,
  maxCards = 25,
): Promise<BossObservation[]> {
  if (!/\.(?:zhipin|bosszhipin)\.com$/i.test(new URL(page.url()).hostname))
    throw new Error("BOSS inspection only accepts a BOSS page");
  return page.locator(UNVERIFIED_BOSS_READONLY_SELECTORS.jobCard).evaluateAll(
    (elements, maximum) =>
      elements.slice(0, maximum).map((element) => {
        const link = element.querySelector('a[href*="job_detail"]');
        return {
          selector: "[data-jd-id]",
          id: element.getAttribute("data-jd-id"),
          text: (element.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 2000),
          href: link?.getAttribute("href") ?? null,
        };
      }),
    maxCards,
  );
}

function bossUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !/(^|\.)(zhipin|bosszhipin)\.com$/i.test(url.hostname)
  )
    throw new Error("BOSS page URL is outside the expected HTTPS site");
  return url;
}

/** Read-only extraction of cards already rendered in the signed-in browser. */
export async function collectBossPage(
  page: Page,
  source: JobSource,
  maxCards = 100,
): Promise<Job[]> {
  const pageUrl = bossUrl(page.url());
  if (source.kind !== "boss")
    throw new Error("BOSS collector requires a BOSS source");
  const records = await page.locator('a[href*="job_detail/"]').evaluateAll(
    (links, maximum) =>
      links.slice(0, maximum).map((link) => {
        const card =
          link.closest(".job-card-wrapper, .job-card-body, li, article") ??
          link;
        const get = (selector: string) =>
          (card.querySelector(selector)?.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim();
        return {
          href: link.getAttribute("href"),
          title: (link.textContent ?? "").replace(/\s+/g, " ").trim(),
          company: get('.company-name, [class*="company-name"]'),
          location: get('.job-area, [class*="job-area"]'),
          salary: get('.salary, [class*="salary"]'),
          description: (card.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 4000),
        };
      }),
    Math.min(100, Math.max(1, maxCards)),
  );
  const now = new Date().toISOString();
  const jobs = new Map<string, Job>();
  for (const item of records) {
    if (!item.href || !item.title || !item.company) continue;
    let url: URL;
    try {
      url = bossUrl(new URL(item.href, pageUrl).toString());
    } catch {
      continue;
    }
    const match = url.pathname.match(/\/job_detail\/([^/?#]+?)(?:\.html)?$/);
    if (!match) continue;
    const sourceJobId = match[1]!;
    const salary = parseSalary(
      item.salary.includes("薪") ? item.salary : `${item.salary}/月`,
    );
    const content = {
      title: item.title,
      company: item.company,
      location: item.location || null,
      salary,
      description: item.description,
    };
    const id = `boss:${createHash("sha256").update(`${source.id}:${sourceJobId}`).digest("hex").slice(0, 24)}`;
    jobs.set(id, {
      id,
      source: "boss",
      sourceId: source.id,
      sourceJobId,
      url: url.toString(),
      title: item.title,
      company: item.company,
      companyAliases: [],
      industry: null,
      location: item.location || null,
      remote: /远程|remote/i.test(item.description),
      ...salary,
      experienceMin: null,
      description: item.description,
      skills: [],
      education: null,
      firstSeen: now,
      lastSeen: now,
      contentHash: createHash("sha256")
        .update(JSON.stringify(content))
        .digest("hex"),
      status: "active",
    });
  }
  return [...jobs.values()];
}

export interface BossDomSelectors {
  conversation: string;
  jobIdentity: string;
  companyIdentity: string;
  jobLink: string;
  nativeGreetingButton: string;
  composer: string;
  sendButton: string;
  outgoingMessage: string;
  uploadInput: string;
  attachmentEvidence: string;
  attachmentSendButton?: string;
  sentAttachmentEvidence?: string;
  pendingAcceptance?: string;
}

/** Exact identity and post-action evidence are required before an action can be confirmed. */
export class DomBossAdapter implements BossAdapter {
  readonly mode = "live" as const;
  readonly verified: boolean;
  constructor(
    private readonly page: Page,
    private readonly application: Application,
    private readonly selectors: BossDomSelectors,
    options: { verified: boolean; attachmentPath?: string },
  ) {
    this.verified = options.verified;
    this.attachmentPath = options.attachmentPath;
  }
  private readonly attachmentPath?: string;
  private async target() {
    bossUrl(this.page.url());
    if (!this.verified)
      throw new Error(
        "live BOSS selectors have not been verified against an authenticated page",
      );
    const conversation = this.page.locator(this.selectors.conversation);
    if ((await conversation.count()) !== 1)
      throw new Error("conversation identity is ambiguous");
    const job = await conversation
      .locator(this.selectors.jobIdentity)
      .allTextContents();
    const company = await conversation
      .locator(this.selectors.companyIdentity)
      .allTextContents();
    if (
      job.length !== 1 ||
      company.length !== 1 ||
      job[0]?.trim() !== this.application.job.title ||
      company[0]?.trim() !== this.application.job.company
    )
      throw new Error("conversation job or company does not match application");
    const links = conversation.locator(this.selectors.jobLink);
    if ((await links.count()) !== 1)
      throw new Error("conversation job link is ambiguous");
    const href = await links.getAttribute("href");
    if (!href) throw new Error("conversation job link is missing");
    const actual = bossUrl(new URL(href, this.page.url()).toString());
    const expected = bossUrl(this.application.job.url);
    if (actual.pathname !== expected.pathname)
      throw new Error("conversation job ID does not match application");
    return conversation;
  }
  async reconcile(
    application: Application,
  ): Promise<ReadonlyMap<string, "confirmed" | "unknown">> {
    await this.target();
    const observed = new Map<string, "confirmed" | "unknown">();
    for (const action of application.actions) {
      if (action.state !== "started" && action.state !== "unknown") continue;
      // Historical identical text cannot prove this particular attempt was sent.
      // A fresh send is only confirmed by observing a new outgoing bubble.
      observed.set(action.id, "unknown");
    }
    return observed;
  }
  async sendMessage(action: ApplicationAction): Promise<BossActionOutcome> {
    const conversation = await this.target();
    const outgoing = conversation.locator(this.selectors.outgoingMessage);
    const before = await outgoing.count();
    try {
      if (action.kind === "native-greeting") {
        const button = conversation.locator(
          this.selectors.nativeGreetingButton,
        );
        if ((await button.count()) !== 1) return "failed";
        await button.click();
        await outgoing.nth(before).waitFor({ state: "visible", timeout: 8000 });
        return "confirmed";
      }
      if (!action.text?.trim()) return "failed";
      const composer = conversation.locator(this.selectors.composer);
      const send = conversation.locator(this.selectors.sendButton);
      if ((await composer.count()) !== 1 || (await send.count()) !== 1)
        return "failed";
      await composer.fill(action.text);
      await send.click();
      await outgoing.nth(before).waitFor({ state: "visible", timeout: 8000 });
      return (await outgoing.nth(before).innerText()).trim() === action.text
        ? "confirmed"
        : "unknown";
    } catch {
      return "unknown";
    }
  }
  async sendAttachment(action: ApplicationAction): Promise<BossActionOutcome> {
    if (
      action.kind !== "attachment" ||
      !this.attachmentPath ||
      !this.application.resumeAttachment ||
      basename(this.attachmentPath) !== this.application.resumeAttachment
    )
      return "failed";
    const conversation = await this.target();
    try {
      const upload = conversation.locator(this.selectors.uploadInput);
      if ((await upload.count()) !== 1) return "failed";
      await upload.setInputFiles(this.attachmentPath);
      const evidence = conversation
        .locator(this.selectors.attachmentEvidence)
        .filter({ hasText: this.application.resumeAttachment });
      await evidence.first().waitFor({ state: "visible", timeout: 8000 });
      if (!this.selectors.attachmentSendButton) return "unknown";
      const send = conversation.locator(this.selectors.attachmentSendButton);
      if ((await send.count()) !== 1) return "unknown";
      await send.click();
      if (
        this.selectors.pendingAcceptance &&
        (await conversation
          .locator(this.selectors.pendingAcceptance)
          .isVisible())
      )
        return "awaiting-acceptance";
      if (
        this.selectors.sentAttachmentEvidence &&
        (await conversation
          .locator(this.selectors.sentAttachmentEvidence)
          .filter({ hasText: this.application.resumeAttachment })
          .isVisible())
      )
        return "confirmed";
      return "unknown";
    } catch {
      return "unknown";
    }
  }
}

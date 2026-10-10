import { extractJobs } from "./extract.mjs";
import { applicationPageStep } from "./application-page.mjs";

const HOST = "https://www.zhipin.com";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();
const company = (value) =>
  clean(value)
    .replace(/^公司名称\s*[:：]?\s*/, "")
    .replace(/(?:股份有限公司|有限责任公司|有限公司)$/, "");
const reasons = new Set([
  "recipient-mismatch",
  "page-unrecognized",
  "login-required",
  "verification-required",
  "send-unconfirmed",
  "attachment-pending",
  "cancelled",
]);
export function canonicalApplicationUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === HOST &&
      !url.username &&
      !url.password &&
      /^\/job_detail\/[a-zA-Z0-9_-]+\.html$/.test(url.pathname)
      ? url.origin + url.pathname
      : "";
  } catch {
    return "";
  }
}
export function matchesFrozenJob(found, expected) {
  if (
    !found ||
    !expected ||
    canonicalApplicationUrl(found.url) !==
      canonicalApplicationUrl(expected.url) ||
    !canonicalApplicationUrl(expected.url)
  )
    return false;
  if (
    !found.detail ||
    clean(found.title) !== clean(expected.title) ||
    clean(found.description) !== clean(expected.description)
  )
    return false;
  if (
    ![expected.company, ...(expected.companyAliases || [])]
      .map(company)
      .includes(company(found.company))
  )
    return false;
  const salary = clean(found.salaryText).match(
    /^(\d+(?:\.\d+)?)\s*[-–—~至]\s*(\d+(?:\.\d+)?)\s*[kK](?:\s*[·•・]\s*\d+\s*薪)?$/,
  );
  return (
    Boolean(salary) &&
    Number(salary[1]) * 1000 === expected.salaryMin &&
    Number(salary[2]) * 1000 === expected.salaryMax
  );
}
export function applicationNavigationState(tab, expectedUrl) {
  const expected = canonicalApplicationUrl(expectedUrl);
  if (!expected) return "reject";
  if (tab.pendingUrl && canonicalApplicationUrl(tab.pendingUrl) !== expected)
    return "reject";
  const committed = canonicalApplicationUrl(tab.url);
  if (committed && committed !== expected) return "reject";
  if (
    !committed &&
    tab.url &&
    !["about:blank", "chrome://newtab/"].includes(tab.url)
  )
    return "reject";
  if (committed === expected && tab.status === "complete") return "ready";
  return tab.status === "complete" ? "reject" : "wait";
}

/** One leased application at a time; no browser side effect is retried. */
export async function runExtensionApplication(api, token) {
  const call = (path, body = {}) =>
    api(`/extension/v1/application/${path}`, {
      method: "POST",
      token,
      version: true,
      body,
    });
  const claim = await call("claim");
  const task = claim.task;
  if (!task) return false;
  const application = task.application;
  const identity = {
    taskId: task.id,
    leaseToken: task.leaseToken,
    applicationId: application?.id,
  };
  let tabId;
  let actionStarted = null;
  let interrupted = false;
  let stopReason;
  let pageDiagnostic;
  let activeAction = null;
  let authorization = null;
  const heartbeat = async () => {
    const status = await call("heartbeat", {
      taskId: task.id,
      leaseToken: task.leaseToken,
    });
    if (status.paused || status.takeover) interrupted = true;
    return !interrupted;
  };
  const timer = setInterval(
    () =>
      heartbeat().catch(() => {
        interrupted = true;
      }),
    10_000,
  );
  const progress = (action, state, evidence) =>
    call("action", { ...identity, actionId: action.id, state, evidence });
  const diagnostic = (reason) =>
    chrome.storage.local.set({
      jobAssistantAutomationDiagnostic: {
        phase: "application",
        status: "failed",
        reason,
      },
    });
  // Credentials stay in the extension worker. Only the dedicated, isolated
  // script can request a short-lived permission immediately before a UI action.
  const authorizeMessage = (message, sender, respond) => {
    if (message?.type !== "job-assistant:application-authorize") return;
    if (
      !authorization ||
      message.nonce !== authorization.nonce ||
      message.actionId !== activeAction?.id ||
      sender.id !== chrome.runtime.id ||
      sender.tab?.id !== tabId ||
      sender.frameId !== 0 ||
      interrupted
    ) {
      respond({ allowed: false });
      return false;
    }
    const senderUrl = sender.url || "";
    const rightPage =
      activeAction.kind === "native-greeting"
        ? canonicalApplicationUrl(senderUrl) ===
          canonicalApplicationUrl(application.job.url)
        : /^https:\/\/www\.zhipin\.com\/web\/geek\/chat\/?(?:\?.*)?$/.test(
            senderUrl,
          );
    if (!rightPage) {
      respond({ allowed: false });
      return false;
    }
    call("authorize", { ...identity, actionId: activeAction.id }).then(
      (permit) => {
        respond({
          allowed: !interrupted && permit.allowed === true,
          expiresAt: permit.expiresAt,
        });
      },
      () => respond({ allowed: false }),
    );
    return true;
  };
  chrome.runtime.onMessage.addListener(authorizeMessage);
  const page = async (request) => {
    if (!(await heartbeat())) return { ok: false, reason: "cancelled" };
    const tab = await chrome.tabs.get(tabId);
    const url = new URL(tab.url || "");
    if (url.origin !== HOST || url.username || url.password)
      return { ok: false, reason: "recipient-mismatch" };
    authorization = activeAction
      ? { nonce: crypto.randomUUID(), actionId: activeAction.id }
      : null;
    const readerKey =
      request.mode === "contact"
        ? `__jobAssistantReader${crypto.randomUUID().replaceAll("-", "")}`
        : null;
    if (readerKey)
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        func: extractJobs,
        args: [{ readerKey }],
      });
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "ISOLATED",
        func: applicationPageStep,
        args: [{ ...request, job: application.job, authorization, readerKey }],
      });
      if (result?.result?.diagnostic) pageDiagnostic = result.result.diagnostic;
      return result?.result || { ok: false, reason: "page-unrecognized" };
    } finally {
      authorization = null;
    }
  };
  const waitConversation = async (originTab) => {
    for (let attempt = 0; attempt < 24; attempt++) {
      if (!(await heartbeat())) return false;
      const candidates = await chrome.tabs.query({
        url: `${HOST}/web/geek/chat*`,
      });
      const relevant = candidates.filter(
        (tab) => tab.id === originTab || tab.openerTabId === originTab,
      );
      if (relevant.length === 1) tabId = relevant[0].id;
      else if (relevant.length > 1) return false;
      let view;
      try {
        view = await page({ mode: "inspect" });
      } catch {
        // A committed navigation destroys the old isolated context. Wait and
        // inspect the same tab or its one opener-linked chat; never click again.
        await sleep(500);
        continue;
      }
      if (view.ok && view.page === "conversation") return true;
      if (
        ["login-required", "verification-required", "cancelled"].includes(
          view.reason,
        )
      )
        return false;
      await sleep(500);
    }
    return false;
  };
  try {
    if (
      !application?.job ||
      !canonicalApplicationUrl(application.job.url) ||
      !Array.isArray(application.actions) ||
      !application.actions.length
    )
      throw new Error("page-unrecognized");
    const resolvedContact = (action) =>
      action.kind === "native-greeting" &&
      action.state === "unknown" &&
      action.resolution === "contact-exists";
    if (
      application.actions.some(
        (action) => action.state !== "pending" && !resolvedContact(action),
      )
    )
      throw new Error("send-unconfirmed");
    if (!(await heartbeat())) throw new Error("cancelled");
    const tab = await chrome.tabs.create({
      url: canonicalApplicationUrl(application.job.url),
      active: true,
    });
    tabId = tab.id;
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (!(await heartbeat())) throw new Error("cancelled");
      const current = await chrome.tabs.get(tabId);
      const navigation = applicationNavigationState(
        current,
        application.job.url,
      );
      if (navigation === "reject") throw new Error("recipient-mismatch");
      if (navigation === "ready") {
        const [read] = await chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          func: extractJobs,
        });
        if (matchesFrozenJob(read?.result?.jobs?.[0], application.job)) {
          ready = true;
          break;
        }
      }
      await sleep(500);
    }
    if (!ready) throw new Error("page-unrecognized");
    for (const action of [...application.actions].sort(
      (a, b) => a.index - b.index,
    )) {
      activeAction = action;
      if (!(await heartbeat())) throw new Error("cancelled");
      const key = `jobAssistantApplicationAttempt:${task.id}:${action.id}`;
      if (
        !resolvedContact(action) &&
        (await chrome.storage.local.get(key))[key]
      )
        throw new Error("send-unconfirmed");
      if (action.kind === "native-greeting") {
        const view = await page({ mode: "inspect" });
        if (!view.ok || view.page !== "detail")
          throw new Error(view.reason || "recipient-mismatch");
        if (resolvedContact(action) && !view.existingContact)
          throw new Error("recipient-mismatch");
        if (view.existingContact) {
          if (!resolvedContact(action))
            await progress(action, "skipped", "existing-contact");
          const originalTab = tabId;
          let contact;
          try {
            contact = await page({ mode: "contact", expectedExisting: true });
          } catch {
            // Continue is navigation only. Its context can disappear while the
            // new chat loads; confirm the recipient read-only without replay.
          }
          if (
            (contact && !contact.ok) ||
            !(await waitConversation(originalTab))
          )
            throw new Error(contact?.reason || "recipient-mismatch");
          continue;
        }
      } else {
        const view = await page({ mode: "inspect" });
        if (!view.ok || view.page !== "conversation")
          throw new Error(view.reason || "recipient-mismatch");
      }
      const permission = await progress(action, "started", "before-action");
      if (permission.execute !== true) throw new Error("send-unconfirmed");
      actionStarted = action;
      await chrome.storage.local.set({ [key]: true });
      let result;
      if (action.kind === "native-greeting") {
        const originalTab = tabId;
        const contact = await page({
          mode: "contact",
          expectedExisting: false,
        });
        result =
          contact.ok &&
          contact.contactConfirmed &&
          (await waitConversation(originalTab))
            ? { ok: true, evidence: "new-message" }
            : { ok: false, reason: contact.reason || "send-unconfirmed" };
      } else if (action.kind === "message") {
        result = await page({ mode: "message", text: action.text });
      } else if (action.kind === "attachment") {
        const attachment = await call("attachment", {
          ...identity,
          actionId: action.id,
        });
        result = await page({ mode: "attachment", attachment });
      } else throw new Error("page-unrecognized");
      const reason = reasons.has(result?.reason)
        ? result.reason
        : "send-unconfirmed";
      const outcome = result?.ok
        ? "confirmed"
        : reason === "attachment-pending"
          ? "awaiting-acceptance"
          : "unknown";
      await progress(action, outcome, result?.ok ? result.evidence : reason);
      actionStarted = null;
      if (outcome !== "confirmed") {
        stopReason = reason;
        await diagnostic(reason);
        break;
      }
    }
    await call("result", {
      ...identity,
      ...(stopReason ? { reason: stopReason } : {}),
      ...(pageDiagnostic ? { diagnostic: pageDiagnostic } : {}),
    });
    return true;
  } catch (error) {
    const reason = reasons.has(error?.message)
      ? error.message
      : "send-unconfirmed";
    if (actionStarted)
      await progress(actionStarted, "unknown", reason).catch(() => undefined);
    await diagnostic(reason).catch(() => undefined);
    await call("result", {
      ...identity,
      reason,
      ...(pageDiagnostic ? { diagnostic: pageDiagnostic } : {}),
    }).catch(() => undefined);
    return true;
  } finally {
    clearInterval(timer);
    chrome.runtime.onMessage.removeListener(authorizeMessage);
    // Leave the dedicated tab open for inspection. Never automatically reopen or
    // replay an uncertain send, including after extension/service worker restart.
  }
}

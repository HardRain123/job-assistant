import { extractJobs } from "./extract.mjs";
import { inspectSplitSearch, clickAndReadSplitDetail } from "./split-page.mjs";
import { runExtensionApplication } from "./application.mjs";

const API_BASE = "http://127.0.0.1:3000";
const VERSION = "0.3.3";
const STATE_KEY = "jobAssistantAutomationTabs";
const DIAGNOSTIC_KEY = "jobAssistantAutomationDiagnostic";
const ALARM = "job-assistant-automation-poll";
const HOST = "https://www.zhipin.com";
const IDLE_POLL_MINUTES = 0.5;
const STEP_LIMIT = 8;
const WAIT_MS = 18_000;
const WAIT_INTERVAL_MS = 500;
let processing = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
const DIAGNOSTIC_REASONS = new Set([
  "login-required",
  "verification-required",
  "page-unrecognized",
  "navigation-failed",
  "tab-closed",
  "page-repeated",
]);
async function diagnostic(phase, status = "working", reason = "") {
  try {
    await chrome.storage.local.set({
      [DIAGNOSTIC_KEY]: {
        phase,
        status,
        ...(DIAGNOSTIC_REASONS.has(reason) ? { reason } : {}),
      },
    });
  } catch {
    // Diagnostics must never prevent a lease result from being returned.
  }
}
export function canonicalDetailUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/job_detail\/([a-zA-Z0-9_-]+)\.html$/);
    if (url.origin !== HOST || url.username || url.password || !match) return "";
    return `${HOST}/job_detail/${match[1]}.html`;
  } catch {
    return "";
  }
}
export function listSignature(links) {
  return [...new Set(links.map(canonicalDetailUrl).filter(Boolean))].sort().join("|");
}
export function validCommand(command) {
  if (!command || !["search", "next", "detail"].includes(command.kind)) return false;
  if (!Number.isFinite(command.intervalSeconds) || command.intervalSeconds < 0) return false;
  if (typeof command.id !== "string" || typeof command.runId !== "string" || typeof command.leaseToken !== "string") return false;
  try {
    const url = new URL(command.url);
    if (url.origin !== HOST || url.username || url.password) return false;
    if (command.searchUrl && !isSearchUrl(command.searchUrl)) return false;
    return command.kind === "detail"
      ? Boolean(canonicalDetailUrl(command.url))
      : /^\/web\/geek\/jobs?\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}
async function api(path, { method = "GET", token, body, version = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (version) headers["X-Extension-Version"] = VERSION;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || data.message || `请求失败（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}
async function token() {
  const { jobAssistantToken = "" } = await chrome.storage.local.get("jobAssistantToken");
  return jobAssistantToken;
}
async function state() {
  const { [STATE_KEY]: value = {} } = await chrome.storage.session.get(STATE_KEY);
  return value;
}
async function saveState(value) {
  await chrome.storage.session.set({ [STATE_KEY]: value });
}
async function tabIsBoss(tabId) {
  if (!Number.isInteger(tabId)) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    return /^https:\/\/www\.zhipin\.com\//i.test(tab.url || "");
  } catch {
    return false;
  }
}
async function dedicatedTab(kind, runId) {
  const current = await state();
  const fresh = current.runId === runId ? current : { runId };
  const key = kind === "search" ? "searchTabId" : "detailTabId";
  if (await tabIsBoss(fresh[key])) return fresh[key];
  const tab = await chrome.tabs.create({ url: "https://www.zhipin.com/web/geek/jobs", active: false });
  fresh[key] = tab.id;
  await saveState(fresh);
  return tab.id;
}
async function existingSearchTab(runId) {
  const current = await state();
  if (current.runId !== runId || !(await tabIsBoss(current.searchTabId))) return null;
  return current.searchTabId;
}
async function runningRun(tokenValue, runId) {
  const status = await api("/extension/v1/automation-status", { method: "POST", token: tokenValue, version: true });
  return status.run?.id === runId && status.run?.state === "running";
}
async function actualUrl(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return /^https:\/\/www\.zhipin\.com\//i.test(tab.url || "") ? tab.url : "";
}
function isSearchUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === HOST && !url.username && !url.password && /^\/web\/geek\/jobs?\/?$/.test(url.pathname);
  } catch { return false; }
}
export function matchesIntendedUrl(actualValue, intendedValue, kind) {
  try {
    const actual = new URL(actualValue);
    const intended = new URL(intendedValue);
    if (
      actual.origin !== HOST || actual.username || actual.password ||
      intended.origin !== HOST || intended.username || intended.password
    ) return false;
    if (kind === "detail")
      return Boolean(canonicalDetailUrl(actual.href)) &&
        canonicalDetailUrl(actual.href) === canonicalDetailUrl(intended.href);
    return /^\/web\/geek\/jobs?\/?$/.test(actual.pathname) &&
      /^\/web\/geek\/jobs?\/?$/.test(intended.pathname) &&
      actual.searchParams.get("query") === intended.searchParams.get("query") &&
      actual.searchParams.get("city") === intended.searchParams.get("city");
  } catch {
    return false;
  }
}
export function classifyFailure(error) {
  const message = String(error?.message || error);
  if (/cannot access|missing host permission|permission.*denied|extensions gallery|cannot be scripted/i.test(message)) return "permission-denied";
  if (/no tab with id|tab (?:was |is )?closed|frame.*removed|frame.*not found/i.test(message)) return "tab-unavailable";
  if (/script|referenceerror|syntaxerror|typeerror|is not defined|is not a function/i.test(message)) return "script-error";
  if (/fetch|network|abort|请求失败/i.test(message)) return "request-failed";
  return "unknown-error";
}
export async function waitForUrl(tabId, intendedUrl, kind, tokenValue, runId) {
  const intended = new URL(intendedUrl);
  let lastCancellationCheck = 0;
  let matchingPageSeen = false;
  let failure = { code: "document-loading", tabState: "unknown" };
  for (let elapsed = 0; elapsed < WAIT_MS; elapsed += WAIT_INTERVAL_MS) {
    const tab = await chrome.tabs.get(tabId);
    failure.tabState = ["loading", "complete"].includes(tab.status) ? tab.status : "unknown";
    try {
      const actual = new URL(tab.url || "");
      if (actual.origin !== HOST) { failure.code = "url-mismatch"; }
      else
      {
        const page = kind === "detail" ? await inspectDetailPage(tabId) : await inspect(tabId);
        const documentReady = tab.status === "complete" ||
          (["interactive", "complete"].includes(page?.readyState) && page?.pageUrl === actual.href);
        if (documentReady && (page?.login || page?.challenge)) return { blocked: page };
        const urlMatches = matchesIntendedUrl(actual.href, intended.href, kind);
        const documentMatches = !page?.pageUrl || matchesIntendedUrl(page.pageUrl, intended.href, kind);
        if (documentReady && documentMatches && urlMatches && page?.recognized) return { ok: true };
        if (documentReady && documentMatches && urlMatches && page) matchingPageSeen = true;
        failure.code = !documentReady ? "document-loading" : !urlMatches || !documentMatches ? "url-mismatch" : "dom-unrecognized";
      }
    } catch (error) { failure.code = classifyFailure(error); }
    if (elapsed - lastCancellationCheck >= 2_000) {
      lastCancellationCheck = elapsed;
      if (!(await runningRun(tokenValue, runId))) return { cancelled: true };
    }
    await sleep(WAIT_INTERVAL_MS);
  }
  return matchingPageSeen ? { unrecognized: true, failure } : { failure };
}
function strictImportPayload(jobs) {
  return jobs.map((job) => {
    const item = {
      url: canonicalDetailUrl(job.url),
      title: String(job.title || "").trim(),
      company: String(job.company || "").trim(),
      description: String(job.description || "").trim(),
      detail: Boolean(job.detail),
    };
    for (const key of ["location", "salaryText", "industry", "experienceText", "education"]) {
      if (job[key]) item[key] = String(job[key]).trim();
    }
    if (Array.isArray(job.companyAliases)) item.companyAliases = [...new Set(job.companyAliases.filter((name) => typeof name === "string" && name.trim() && name.trim().length <= 160).map((name) => name.trim()))].slice(0, 5);
    return item;
  }).filter((item) => item.url && item.title && item.company && item.description);
}

// These functions run in the page's isolated world. They only inspect rendered DOM
// and interact with the visible, official pagination control.
export function inspectSearch() {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const visible = (node) => {
    if (!node || !node.getClientRects().length) return false;
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden";
  };
  const anyVisible = (selectors) => selectors.some((selector) => [...document.querySelectorAll(selector)].some(visible));
  const login = /\/(?:login|web\/user)(?:\/|$)/i.test(location.pathname) ||
    anyVisible([".login-dialog form", ".login-box form", "[class*='login-dialog'] form", "form:has(input[type='password'])"]);
  const challenge = anyVisible(["iframe[src*='captcha']", "iframe[src*='verify']", ".geetest_panel", ".verify-dialog", "[class*='captcha-dialog']", "[class*='verify-dialog']"]);
  const links = [...document.querySelectorAll("a[href*='/job_detail/']")]
    .filter(visible)
    .map((node) => {
      try {
        const url = new URL(node.href, location.href);
        const m = url.pathname.match(/^\/job_detail\/([a-zA-Z0-9_-]+)\.html$/);
        return url.origin === "https://www.zhipin.com" && m ? `${url.origin}/job_detail/${m[1]}.html` : "";
      } catch { return ""; }
    }).filter(Boolean);
  const unique = [...new Set(links)].sort().slice(0, 30);
  const enabled = (node) => node && visible(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true" && !node.classList.contains("disabled");
  const textNext = [...document.querySelectorAll("button, a")].find((node) => {
    const label = clean(node.innerText || node.getAttribute("aria-label") || node.title);
    return enabled(node) && /^(下一页|下页|Next)$/i.test(label);
  });
  // The observed BOSS paginator uses this exact icon; use its immediate control
  // and its disabled state, never a generic right-arrow glyph elsewhere on the page.
  const iconNext = [...document.querySelectorAll(".ui-icon-arrow-right")]
    .filter((icon) => visible(icon) && enabled(icon.parentElement))
    .map((icon) => icon.closest("a, button, li") || icon.parentElement)
    .find(enabled);
  const next = textNext || iconNext;
  const emptyNodes = [...document.querySelectorAll(".job-list-box, [class*='job-list'], [class*='empty']")].filter(visible);
  const empty = emptyNodes.some((node) => /暂无职位|没有找到\s*职位|暂无符合条件/.test(clean(node.innerText)));
  return { login, challenge, links: unique, signature: unique.join("|"), hasNext: Boolean(next), recognized: unique.length > 0 || empty, empty, readyState: document.readyState, pageUrl: location.href };
}
export function inspectDetail() {
  const visible = (node) => node && node.getClientRects().length && getComputedStyle(node).display !== "none" && getComputedStyle(node).visibility !== "hidden";
  const anyVisible = (selectors) => selectors.some((selector) => [...document.querySelectorAll(selector)].some(visible));
  const login = /\/(?:login|web\/user)(?:\/|$)/i.test(location.pathname) || anyVisible([".login-dialog form", ".login-box form", "[class*='login-dialog'] form", "form:has(input[type='password'])"]);
  const challenge = anyVisible(["iframe[src*='captcha']", "iframe[src*='verify']", ".geetest_panel", ".verify-dialog", "[class*='captcha-dialog']", "[class*='verify-dialog']"]);
  const recognized = anyVisible([".job-sec-text", ".job-detail .job-sec-text", ".job-detail-box .job-sec-text", "[data-testid='job-description']"]);
  return { login, challenge, recognized, readyState: document.readyState, pageUrl: location.href };
}
export function advanceSearch() {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const visible = (node) => node && node.getClientRects().length && getComputedStyle(node).display !== "none" && getComputedStyle(node).visibility !== "hidden";
  const enabled = (node) => node && visible(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true" && !node.classList.contains("disabled");
  const textNext = [...document.querySelectorAll("button, a")].find((node) => {
    const label = clean(node.innerText || node.getAttribute("aria-label") || node.title);
    return enabled(node) && /^(下一页|下页|Next)$/i.test(label);
  });
  const iconNext = [...document.querySelectorAll(".ui-icon-arrow-right")]
    .filter((icon) => visible(icon) && enabled(icon.parentElement))
    .map((icon) => icon.closest("a, button, li") || icon.parentElement)
    .find(enabled);
  const next = textNext || iconNext;
  if (!next) return { clicked: false };
  next.click();
  return { clicked: true };
}
async function inspect(tabId) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: inspectSearch });
  const page = result?.result || null;
  if (!page || page.login || page.challenge || page.recognized) return page;
  const [split] = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: inspectSplitSearch });
  return split?.result?.recognized ? { ...page, ...split.result, hasNext: page.hasNext } : page;
}
async function inspectDetailPage(tabId) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: inspectDetail });
  return result?.result || null;
}
async function submitResult(tokenValue, command, payload) {
  if (["error", "blocked"].includes(payload.outcome))
    await diagnostic("failed", "failed", payload.reason);
  return api("/extension/v1/result", { method: "POST", token: tokenValue, version: true, body: { commandId: command.id, runId: command.runId, leaseToken: command.leaseToken, ...payload } });
}
export async function execute(command, tokenValue) {
  let stage = "status-check";
  let inlineFallback = null;
  let pageEvidence;
  const fieldReading = { route: "standalone", merge: "not-needed", salary: "unchecked", location: "unchecked", industry: "unchecked" };
  const mark = async (value, status = "working", reason = "") => {
    if (["status-check", "opening-tab", "navigating", "waiting-page", "reading-page", "advancing-page", "reporting"].includes(value)) stage = value;
    return diagnostic(value, status, reason);
  };
  const report = (tokenValue, command, payload) => submitResult(tokenValue, command, {
    ...payload,
    ...(command.kind === "detail" && payload.outcome === "ok" && pageEvidence ? { pageEvidence } : {}),
    ...(command.kind === "detail" && payload.outcome === "ok" ? { fieldReading: {
      ...fieldReading,
      finalSalary: Boolean(payload.jobs?.[0]?.salaryText),
      finalLocation: Boolean(payload.jobs?.[0]?.location),
      finalIndustry: Boolean(payload.jobs?.[0]?.industry),
    } } : {}),
    ...(["error", "blocked"].includes(payload.outcome) ? { diagnostic: { stage, code: payload.reason === "page-unrecognized" ? "dom-unrecognized" : payload.reason === "tab-closed" ? "tab-unavailable" : "unknown-error", ...payload.diagnostic } } : {}),
  });
  const reportInline = async () => {
    if (!(await runningRun(tokenValue, command.runId))) return;
    await mark("reporting");
    const response = await report(tokenValue, command, {
      outcome: "ok",
      url: inlineFallback.searchUrl,
      jobs: [inlineFallback.job],
      detailContext: inlineFallback.detailContext,
    });
    await mark("idle", "idle");
    return response;
  };
  if (!validCommand(command)) {
    // A malformed command is reported only when it has an identity; it is never navigated.
    if (command?.id && command?.runId && command?.leaseToken) await report(tokenValue, command, { outcome: "error", url: command.url || "", reason: "navigation-failed" });
    return;
  }
  let tabId;
  try {
    await mark("status-check");
    if (!(await runningRun(tokenValue, command.runId))) return;
    if (command.kind === "detail" && command.searchUrl) {
      let searchTabId = await existingSearchTab(command.runId);
      // Extension reload clears session storage. Restore this task's search
      // context before processing its persisted pending detail queue.
      if (!searchTabId) {
        await mark("opening-tab");
        searchTabId = await dedicatedTab("search", command.runId);
        await mark("navigating");
        await chrome.tabs.update(searchTabId, { url: command.searchUrl });
        await mark("waiting-page");
        const ready = await waitForUrl(searchTabId, command.searchUrl, "search", tokenValue, command.runId);
        if (ready?.cancelled) return;
        if (ready?.blocked) return report(tokenValue, command, { outcome: "blocked", url: await actualUrl(searchTabId) || command.searchUrl, reason: ready.blocked.login ? "login-required" : "verification-required" });
        if (!ready?.ok) return report(tokenValue, command, { outcome: "error", url: await actualUrl(searchTabId) || command.searchUrl, reason: ready?.unrecognized ? "page-unrecognized" : "navigation-failed", diagnostic: ready?.failure });
      }
      if (searchTabId && matchesIntendedUrl(await actualUrl(searchTabId), command.searchUrl, "search")) {
        tabId = searchTabId;
        await mark("reading-page");
        const page = await inspect(tabId);
        if (page?.login || page?.challenge) return report(tokenValue, command, { outcome: "blocked", url: await actualUrl(tabId), reason: page.login ? "login-required" : "verification-required" });
        const [layout] = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: inspectSplitSearch });
        if (layout?.result?.links?.includes(canonicalDetailUrl(command.url))) {
          if (!(await runningRun(tokenValue, command.runId))) return;
          await mark("reading-page");
          const [result] = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: clickAndReadSplitDetail, args: [canonicalDetailUrl(command.url)] });
          const value = result?.result;
          const currentUrl = await actualUrl(tabId);
          const jobs = strictImportPayload(value?.ok && value.job ? [value.job] : []);
          const detailFailure = ["card-missing", "card-incomplete", "panel-missing", "panel-incomplete", "identity-mismatch", "detail-unchanged"].includes(value?.failureCode) ? value.failureCode : "dom-unrecognized";
          const validInline = matchesIntendedUrl(currentUrl, command.searchUrl, "search") && jobs.length === 1 && jobs[0].detail && jobs[0].url === canonicalDetailUrl(command.url) &&
              value?.detailContext?.jobUrl === jobs[0].url && value.detailContext.title === jobs[0].title && value.detailContext.company === jobs[0].company;
          if (validInline) {
            inlineFallback = { searchUrl: currentUrl, job: jobs[0], detailContext: value.detailContext };
            Object.assign(fieldReading, { route: "split", salary: jobs[0].salaryText ? "readable" : "unchecked", location: jobs[0].location ? "readable" : "unchecked", industry: jobs[0].industry ? "readable" : "unchecked" });
            // The split panel has a complete description, but often omits
            // salary/industry. Read the exact public detail URL once before
            // accepting those fields as unknown.
            if (jobs[0].salaryText && jobs[0].location && jobs[0].industry)
              return reportInline();
            Object.assign(fieldReading, { route: "supplement", merge: "detail-unavailable", salary: "unchecked", location: "unchecked", industry: "unchecked" });
          }
          // An unchanged split panel cannot prove which job is displayed.
          // Navigate once to the exact public detail URL instead; retain all
          // existing login, challenge, URL and payload checks below.
          if (!inlineFallback && (value?.ok !== false || detailFailure !== "detail-unchanged" || !matchesIntendedUrl(currentUrl, command.searchUrl, "search")))
            return report(tokenValue, command, { outcome: "error", url: currentUrl || command.searchUrl, reason: "page-unrecognized", diagnostic: { code: detailFailure } });
        }
      }
    }
    const kind = command.kind === "detail" ? "detail" : "search";
    await mark(command.kind === "next" ? "advancing-page" : "opening-tab");
    tabId = command.kind === "next"
      ? await existingSearchTab(command.runId)
      : await dedicatedTab(kind, command.runId);
    if (!tabId) return report(tokenValue, command, { outcome: "error", url: command.url, reason: "tab-closed" });
    if (command.kind !== "next") {
      if (!(await runningRun(tokenValue, command.runId))) return;
      await mark("navigating");
      await chrome.tabs.update(tabId, { url: command.url });
      await mark("waiting-page");
      const ready = await waitForUrl(tabId, command.url, command.kind, tokenValue, command.runId);
      if (ready?.cancelled) return;
      if (ready?.blocked) return report(tokenValue, command, { outcome: "blocked", url: await actualUrl(tabId) || command.url, reason: ready.blocked.login ? "login-required" : "verification-required" });
      if (ready?.unrecognized) return inlineFallback ? reportInline() : report(tokenValue, command, { outcome: "error", url: await actualUrl(tabId) || command.url, reason: "page-unrecognized", diagnostic: ready.failure });
      if (!ready?.ok) return inlineFallback ? reportInline() : report(tokenValue, command, { outcome: "error", url: await actualUrl(tabId) || command.url, reason: "navigation-failed", diagnostic: ready?.failure });
    }
    if (command.kind === "detail") {
      await mark("reading-page");
      const page = await inspectDetailPage(tabId);
      const currentUrl = await actualUrl(tabId);
      if (page?.login || page?.challenge) return report(tokenValue, command, { outcome: "blocked", url: currentUrl || command.url, reason: page.login ? "login-required" : "verification-required" });
      const [result] = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: extractJobs });
      // Only attach evidence from the exact commanded detail document. It is
      // separate from the job and must never become matching input or a fact.
      if (matchesIntendedUrl(currentUrl, command.url, "detail") && matchesIntendedUrl(result?.result?.pageUrl, command.url, "detail")) pageEvidence = result?.result?.pageEvidence;
      for (const [key, allowed] of Object.entries({
        salary: ["readable", "encoded", "unrecognized", "missing"],
        location: ["readable", "missing"],
        industry: ["readable", "employer-unknown", "company-mismatch", "unrecognized", "section-missing", "conflict"],
      })) {
        const value = result?.result?.fieldReading?.[key];
        if (allowed.includes(value)) fieldReading[key] = value;
      }
      const jobs = strictImportPayload(result?.result?.jobs || []);
      if (jobs.length !== 1 || jobs[0].url !== canonicalDetailUrl(command.url) || !jobs[0].detail)
        return inlineFallback && jobs.length === 0 ? reportInline() : report(tokenValue, command, { outcome: "error", url: currentUrl || command.url, reason: "page-unrecognized", diagnostic: { code: ["panel-incomplete", "card-incomplete"].includes(result?.result?.diagnosticCode) ? result.result.diagnosticCode : "dom-unrecognized" } });
      if (inlineFallback) {
        const base = inlineFallback.job;
        const detail = jobs[0];
        const normalized = (name) => String(name || "").replace(/\s+/g, "").replace(/(?:股份有限公司|有限责任公司|有限公司)$/, "");
        if (base.title !== detail.title) {
          fieldReading.merge = "title-mismatch";
          return reportInline();
        }
        if (normalized(base.company) !== normalized(detail.company)) {
          // The independent page has its own verified exact job URL, matching
          // title and complete description. Keep that coherent record when its
          // employer name differs from the list label; do not merge employers.
          fieldReading.merge = "standalone-selected";
          if (!(await runningRun(tokenValue, command.runId))) return;
          await mark("reporting");
          // Location describes this exact job, even when the two pages use
          // different employer labels. Preserve the visible same-job location.
          const response = await report(tokenValue, command, { outcome: "ok", url: currentUrl, jobs: [{ ...detail, ...(detail.location ? {} : base.location ? { location: base.location } : {}) }] });
          await mark("idle", "idle");
          return response;
        }
        const merged = { ...base };
        if (detail.companyAliases?.length) merged.companyAliases = detail.companyAliases;
        fieldReading.merge = "merged";
        for (const field of ["salaryText", "location", "industry", "experienceText", "education"]) {
          const before = base[field] || "";
          const after = detail[field] || "";
          merged[field] = before && after && before !== after ? "" : before || after;
          if (before && after && before !== after) fieldReading.merge = "conflict";
        }
        inlineFallback.job = merged;
        return reportInline();
      }
      await mark("reporting");
      const response = await report(tokenValue, command, { outcome: "ok", url: currentUrl, jobs });
      await mark("idle", "idle");
      return response;
    }
    let page = await inspect(tabId);
    let currentUrl = await actualUrl(tabId);
    if (!isSearchUrl(currentUrl)) return report(tokenValue, command, { outcome: "error", url: currentUrl || command.url, reason: "navigation-failed" });
    if (!page) return report(tokenValue, command, { outcome: "error", url: currentUrl || command.url, reason: "page-unrecognized" });
    if (page.login || page.challenge) return report(tokenValue, command, { outcome: "blocked", url: currentUrl || command.url, reason: page.login ? "login-required" : "verification-required" });
    if (!page.recognized) return report(tokenValue, command, { outcome: "error", url: currentUrl || command.url, reason: "page-unrecognized" });
    if (command.kind === "next") {
      if (!(await runningRun(tokenValue, command.runId))) return;
      if (await actualUrl(tabId) !== command.url || !isSearchUrl(command.url)) return report(tokenValue, command, { outcome: "error", url: await actualUrl(tabId) || command.url, reason: "navigation-failed" });
      const oldSignature = command.previousSignature || listSignature(page.links);
      if (command.previousSignature && listSignature(page.links) !== command.previousSignature) return report(tokenValue, command, { outcome: "error", url: currentUrl, reason: "page-repeated" });
      const [advanced] = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: advanceSearch });
      if (!advanced?.result?.clicked) return report(tokenValue, command, { outcome: "error", url: command.url, reason: "page-repeated" });
      let changed = null;
      let lastCancellationCheck = 0;
      for (let elapsed = 0; elapsed < WAIT_MS; elapsed += WAIT_INTERVAL_MS) {
        await sleep(WAIT_INTERVAL_MS);
        if (elapsed - lastCancellationCheck >= 2_000) {
          lastCancellationCheck = elapsed;
          if (!(await runningRun(tokenValue, command.runId))) return;
        }
        page = await inspect(tabId);
        currentUrl = await actualUrl(tabId);
        if (page?.login || page?.challenge) return report(tokenValue, command, { outcome: "blocked", url: currentUrl || command.url, reason: page.login ? "login-required" : "verification-required" });
        if (page?.recognized && (page.links.length > 0 || page.empty) && listSignature(page.links) !== oldSignature) { changed = page; break; }
      }
      if (!changed) return report(tokenValue, command, { outcome: "error", url: currentUrl || command.url, reason: "page-repeated" });
      page = changed;
    }
    currentUrl = await actualUrl(tabId);
    await mark("reporting");
    const response = await report(tokenValue, command, { outcome: "ok", url: currentUrl, links: page.links, hasNext: page.hasNext, signature: listSignature(page.links) });
    await mark("idle", "idle");
    return response;
  } catch (error) {
    const code = classifyFailure(error);
    const reason = code === "tab-unavailable" ? "tab-closed" : "navigation-failed";
    await mark("failed", "failed", reason);
    return report(tokenValue, command, { outcome: "error", url: command.url, reason, diagnostic: { code } }).catch(() => undefined);
  }
}
export async function wake() {
  if (processing) return;
  processing = true;
  try {
    const tokenValue = await token();
    if (!tokenValue) return;
    for (let step = 0; step < STEP_LIMIT; step += 1) {
      const claim = await api("/extension/v1/claim", { method: "POST", token: tokenValue, version: true });
      if (!claim.command) {
        await runExtensionApplication(api, tokenValue);
        break;
      }
      await execute(claim.command, tokenValue);
      if (claim.command.intervalSeconds > 0) await sleep(Math.min(claim.command.intervalSeconds * 1000, 30_000));
    }
  } catch {
    // The 30-second alarm provides the retry path for an unavailable local workbench.
    await diagnostic("connection", "connection-failed").catch(() => undefined);
  } finally { processing = false; }
}
chrome.alarms.create(ALARM, { periodInMinutes: IDLE_POLL_MINUTES });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) wake(); });
chrome.runtime.onStartup.addListener(wake);
chrome.runtime.onInstalled.addListener(wake);
chrome.runtime.onMessage.addListener((message) => { if (message?.type === "job-assistant:automation-wake") wake(); });

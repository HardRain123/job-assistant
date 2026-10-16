import { applicationPageStep } from "./application-page.mjs";

const chatUrl = (value) => {
  try {
    const url = new URL(value);
    return url.origin === "https://www.zhipin.com" && !url.username && !url.password &&
      /^\/web\/geek\/chat\/?$/.test(url.pathname);
  } catch { return false; }
};
const evidence = (value) => value && Object.keys(value).length === 2 &&
  [value.names, value.roles].every((items) => Array.isArray(items) && items.length <= 3 &&
    items.every((item) => typeof item === "string" && item.trim() && item.length <= 48 && !/[\p{Cc}\p{Cf}<>]/u.test(item)));
async function bounded(pending, timeoutMs = 3000) {
  let timer;
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("unavailable")), Math.max(1, timeoutMs));
    })]);
  } finally { clearTimeout(timer); }
}

/** Inspect existing chat tabs only. Never open, activate, click, type or send. */
export async function runChatDiagnostic(api, token) {
  const call = (path, body = {}) => api(`/extension/v1/application/diagnostic-${path}`, {
    method: "POST", token, version: true, body,
  });
  const { task } = await call("claim");
  if (!task) return false;
  const identity = { id: task.id, applicationId: task.applicationId, leaseToken: task.leaseToken };
  let outcome = "not-found";
  let headerEvidence;
  try {
    const tabs = (await bounded(chrome.tabs.query({ url: "https://www.zhipin.com/web/geek/chat*" })))
      .filter((tab) => Number.isInteger(tab.id) && chatUrl(tab.url));
    if (tabs.length > 8) outcome = "ambiguous";
    else {
      const found = [];
      let unavailable = false;
      let ambiguous = false;
      const deadline = Date.now() + 25_000;
      for (const tab of tabs) {
        if (Date.now() >= deadline) { unavailable = true; break; }
        try {
          if (!chatUrl((await bounded(chrome.tabs.get(tab.id))).url)) continue;
          const [result] = await bounded(
            chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "ISOLATED",
              func: applicationPageStep, args: [{ mode: "diagnose", job: task.job }] }),
            Math.min(4000, deadline - Date.now()),
          );
          if (!chatUrl((await bounded(chrome.tabs.get(tab.id))).url)) { unavailable = true; continue; }
          if (result?.result?.outcome === "observed" && evidence(result.result.headerEvidence))
            found.push(result.result.headerEvidence);
          else if (result?.result?.outcome === "ambiguous") ambiguous = true;
          else if (result?.result?.outcome !== "not-found") unavailable = true;
        } catch { unavailable = true; }
      }
      if (ambiguous || found.length > 1) outcome = "ambiguous";
      else if (unavailable) outcome = "unavailable";
      else if (found.length === 1) { outcome = "observed"; headerEvidence = found[0]; }
    }
  } catch { outcome = "unavailable"; }
  await call("result", { ...identity, outcome, ...(headerEvidence ? { headerEvidence } : {}) });
  return true;
}

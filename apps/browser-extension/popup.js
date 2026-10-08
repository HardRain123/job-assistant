import { extractJobs } from "./extract.mjs";

const API_BASE = "http://127.0.0.1:3000";
const PAIR_CODE = /^[a-f0-9]{32}$/i;
const state = { token: "", jobs: [] };
const el = (id) => document.getElementById(id);
const pairPanel = el("pairPanel"),
  importPanel = el("importPanel"),
  badge = el("connectionBadge");
const notice = el("notice"),
  preview = el("preview"),
  readButton = el("readButton");
const importButton = el("importButton"),
  disconnectButton = el("disconnectButton"),
  retryButton = el("retryButton");
const checkAutomationButton = el("checkAutomationButton");
const automationStatus = el("automationStatus");
function showAutomationDiagnostic(value) {
  const messages = {
    "status-check": "正在确认自动任务状态。",
    "opening-tab": "正在打开自动任务页面。",
    navigating: "正在进入职位列表。",
    "waiting-page": "正在等待职位列表加载。",
    "reading-page": "正在读取公开职位。",
    "advancing-page": "正在翻到下一页。",
    reporting: "正在提交已读取的结果。",
    claim: "正在检查自动任务。",
    failed: "自动任务上次未完成，请在工作台检查。",
    connection: "暂时无法连接本地工作台。",
    idle: "当前没有正在执行的扩展步骤。",
  };
  const reasons = {
    "login-required": "需要在自动任务标签页完成登录。",
    "verification-required": "需要在自动任务标签页完成验证。",
    "page-unrecognized": "已打开页面，但未能确认职位列表或详情与目标岗位一致。",
    "navigation-failed": "职位页面未能完成加载。",
    "tab-closed": "自动任务标签页已关闭或发生变化。",
    "page-repeated": "下一页与当前页相同，任务已停止。",
  };
  automationStatus.textContent = reasons[value?.reason] || messages[value?.phase] || "";
}

function setNotice(message, error = false) {
  notice.textContent = message;
  notice.style.color = error ? "#8a4331" : "";
}
function setBusy(button, busy) {
  button.disabled = busy;
}
async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
      headers: {
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(
        body.message || body.error || `请求失败（${response.status}）`,
      );
      error.status = response.status;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}
async function persistToken(token) {
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  await chrome.storage.local.set({ jobAssistantToken: token });
}
function showConnection(connected, expiresAt = "") {
  badge.textContent = connected ? "已连接" : "未连接";
  badge.classList.toggle("offline", !connected);
  pairPanel.classList.toggle("hidden", connected);
  importPanel.classList.toggle("hidden", !connected);
  el("manualImportPanel").classList.toggle("hidden", !connected);
  disconnectButton.classList.toggle("hidden", !connected);
  retryButton.classList.add("hidden");
  if (connected && expiresAt)
    setNotice(`连接有效至 ${new Date(expiresAt).toLocaleString("zh-CN")}。`);
}
function text(value) {
  return String(value || "").replace(
    /[&<>\"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char],
  );
}
function renderPreview(result) {
  state.jobs = result.jobs || [];
  const jobs = state.jobs
    .map(
      (job) =>
        `<article class="job"><strong>${text(job.title)}</strong><span>${text(job.company)}${job.salaryText ? ` · ${text(job.salaryText)}` : ""}</span>${job.description ? `<p class="snippet">${text(job.description)}</p>` : ""}</article>`,
    )
    .join("");
  const warnings = (result.warnings || [])
    .map((warning) => `<li>${text(warning)}</li>`)
    .join("");
  preview.innerHTML = `${jobs}${warnings ? `<ul class="warnings">${warnings}</ul>` : ""}`;
  preview.classList.remove("hidden");
  importButton.classList.toggle("hidden", state.jobs.length === 0);
}
function importPayload(jobs) {
  return jobs.map(
    ({
      url,
      title,
      company,
      companyAliases,
      description,
      location,
      salaryText,
      industry,
      experienceText,
      education,
      detail,
    }) => {
      const item = {
        url,
        title,
        company,
        description,
        detail: Boolean(detail),
      };
      if (Array.isArray(companyAliases)) item.companyAliases = companyAliases;
      for (const [key, value] of Object.entries({
        location,
        salaryText,
        industry,
        experienceText,
        education,
      })) {
        if (value) item[key] = value;
      }
      return item;
    },
  );
}
async function currentBossTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!tab?.id || !/^https:\/\/www\.zhipin\.com\//i.test(tab.url || ""))
    throw new Error("请先在 BOSS 直聘的公开职位详情页或职位列表页打开此扩展。");
  return tab;
}
el("pairForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = el("pairCode").value.trim().toLowerCase();
  if (!PAIR_CODE.test(code))
    return setNotice("配对码应为 32 位十六进制字符。", true);
  setBusy(event.submitter, true);
  try {
    const paired = await api("/extension/v1/pair", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    if (!paired.token || !paired.expiresAt)
      throw new Error("本地工作台返回了不完整的配对结果。");
    state.token = paired.token;
    await persistToken(state.token);
    chrome.runtime.sendMessage({ type: "job-assistant:automation-wake" });
    showConnection(true, paired.expiresAt);
  } catch (error) {
    setNotice(
      error.name === "AbortError" ? "本地工作台连接超时。" : error.message,
      true,
    );
  } finally {
    setBusy(event.submitter, false);
  }
});
readButton.addEventListener("click", async () => {
  state.jobs = [];
  preview.innerHTML = "";
  preview.classList.add("hidden");
  importButton.classList.add("hidden");
  setBusy(readButton, true);
  try {
    const tab = await currentBossTab();
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "ISOLATED",
      func: extractJobs,
    });
    renderPreview(
      injection.result || {
        jobs: [],
        warnings: ["页面未返回可读取的职位信息。"],
      },
    );
    setNotice(
      state.jobs.length
        ? `已读取 ${state.jobs.length} 个职位，请确认预览后导入。`
        : "没有可导入的职位。",
    );
  } catch (error) {
    setNotice(error.message || "无法读取当前页面。", true);
  } finally {
    setBusy(readButton, false);
  }
});
importButton.addEventListener("click", async () => {
  if (!state.jobs.length) return;
  setBusy(importButton, true);
  try {
    const response = await api("/extension/v1/jobs", {
      method: "POST",
      headers: { Authorization: `Bearer ${state.token}` },
      body: JSON.stringify({ jobs: importPayload(state.jobs) }),
    });
    setNotice(`已导入 ${response.count ?? state.jobs.length} 个职位。`);
    importButton.classList.add("hidden");
  } catch (error) {
    setNotice(
      error.name === "AbortError" ? "导入请求超时。" : error.message,
      true,
    );
  } finally {
    setBusy(importButton, false);
  }
});
disconnectButton.addEventListener("click", async () => {
  try {
    await api("/extension/v1/connection", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${state.token}` },
    });
  } catch {
    setNotice("本地撤销未完成，但已清除扩展中的连接信息。", true);
  }
  state.token = "";
  state.jobs = [];
  await chrome.storage.local.remove("jobAssistantToken");
  preview.classList.add("hidden");
  importButton.classList.add("hidden");
  showConnection(false);
});
el("openBossButton").addEventListener("click", () =>
  chrome.tabs.create({ url: "https://www.zhipin.com/web/geek/jobs" }),
);
checkAutomationButton.addEventListener("click", async () => {
  setBusy(checkAutomationButton, true);
  try {
    chrome.runtime.sendMessage({ type: "job-assistant:automation-wake" });
    const status = await api("/extension/v1/automation-status", {
      method: "POST",
      headers: { Authorization: `Bearer ${state.token}` },
    });
    const run = status.run;
    setNotice(
      run?.state === "running"
        ? "自动任务正在运行，扩展会继续读取公开职位。"
        : "当前没有运行中的自动任务。",
    );
  } catch (error) {
    setNotice(error.message || "无法检查自动任务。", true);
  } finally {
    setBusy(checkAutomationButton, false);
  }
});
retryButton.addEventListener("click", () => init());
async function init() {
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  const { jobAssistantToken = "", jobAssistantAutomationDiagnostic } =
    await chrome.storage.local.get(["jobAssistantToken", "jobAssistantAutomationDiagnostic"]);
  state.token = jobAssistantToken;
  showAutomationDiagnostic(jobAssistantAutomationDiagnostic);
  if (!state.token) return showConnection(false);
  try {
    const status = await api("/extension/v1/status", {
      method: "POST",
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!status.connected) throw new Error("连接已失效");
    showConnection(true, status.expiresAt);
  } catch (error) {
    if (error.status === 401) {
      state.token = "";
      await chrome.storage.local.remove("jobAssistantToken");
      showConnection(false);
      setNotice("本地连接已失效，请重新配对。", true);
      return;
    }
    showConnection(false);
    retryButton.classList.remove("hidden");
    setNotice("暂时无法连接本地工作台；配对信息已保留，可稍后重试。", true);
  }
}
init().catch(() => {
  showConnection(false);
  setNotice("无法初始化扩展存储。", true);
});

// Standalone functions for chrome.scripting.executeScript: each carries its helpers.
export function inspectSplitSearch() {
  if (new URL(location.href).origin !== "https://www.zhipin.com" || !/^\/web\/geek\/jobs?\/?$/.test(location.pathname))
    return { recognized: false, links: [], signature: "", hasNext: false, empty: false, readyState: document.readyState, pageUrl: location.href };
  const clean = (value, limit = 200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  const visible = (node) => {
    if (!node?.isConnected) return false;
    for (let part = node; part?.nodeType === 1; part = part.parentElement) {
      const style = getComputedStyle(part);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return !!node.getClientRects().length;
  };
  const rendered = (node) => visible(node) || (node?.isConnected && getComputedStyle(node).display === "contents" &&
    [...node.querySelectorAll("*")].some(visible));
  const canonical = (href) => {
    try {
      const url = new URL(href, location.href);
      return url.origin === "https://www.zhipin.com" && !url.username && !url.password && /^\/job_detail\/[\w-]+\.html$/.test(url.pathname)
        ? url.origin + url.pathname : "";
    } catch { return ""; }
  };
  const links = new Set();
  for (const card of document.querySelectorAll(".job-list-container .job-card-box, .job-list-container .job-card-wrap")) {
    if (!visible(card)) continue;
    const link = card.querySelector("a.job-name[href], .job-name a[href], a[href*='/job_detail/']");
    const title = card.querySelector(".job-name");
    if (!link || !title || !rendered(title)) continue;
    let hidden = false;
    for (let part = link; part && part !== card; part = part.parentElement) {
      const style = getComputedStyle(part);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") hidden = true;
    }
    if (hidden || !clean(title.innerText)) continue;
    const url = canonical(link.href);
    if (url) links.add(url);
    if (links.size >= 30) break;
  }
  const found = [...links].sort();
  const empty = [...document.querySelectorAll(".job-list-container [class*='empty']")]
    .some((node) => visible(node) && /暂无职位|没有找到\s*职位/.test(clean(node.innerText)));
  return { recognized: found.length > 0 || empty, links: found, signature: found.join("|"), hasNext: false,
    empty, readyState: document.readyState, pageUrl: location.href };
}

export async function clickAndReadSplitDetail(expectedUrl) {
  const fail = { ok: false };
  if (new URL(location.href).origin !== "https://www.zhipin.com" || !/^\/web\/geek\/jobs?\/?$/.test(location.pathname)) return fail;
  const clean = (value, limit = 12000) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  const visible = (node) => {
    if (!node?.isConnected) return false;
    for (let part = node; part?.nodeType === 1; part = part.parentElement) {
      const style = getComputedStyle(part);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return !!node.getClientRects().length;
  };
  const rendered = (node) => visible(node) || (node?.isConnected && getComputedStyle(node).display === "contents" &&
    [...node.querySelectorAll("*")].some(visible));
  const canonical = (href) => {
    try {
      const url = new URL(href, location.href);
      return url.origin === "https://www.zhipin.com" && !url.username && !url.password && /^\/job_detail\/[\w-]+\.html$/.test(url.pathname)
        ? url.origin + url.pathname : "";
    } catch { return ""; }
  };
  if (!expectedUrl || canonical(expectedUrl) !== expectedUrl) return fail;
  const readCard = (node) => {
    if (!visible(node)) return null;
    const link = node.querySelector("a.job-name[href], .job-name a[href], a[href*='/job_detail/']");
    const titleNode = node.querySelector(".job-name");
    if (!link || !titleNode || !rendered(titleNode)) return null;
    for (let part = link; part && part !== node; part = part.parentElement) {
      const style = getComputedStyle(part);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return null;
    }
    const url = canonical(link.href);
    const title = clean(titleNode.innerText, 160);
    const companyNode = node.querySelector(".boss-name, .company-name");
    const company = visible(companyNode) ? clean(companyNode.innerText, 160) : "";
    return url && title && company ? { url, title, company } : null;
  };
  const unique = new Map();
  let targetLinkSeen = false;
  for (const node of document.querySelectorAll(".job-list-container .job-card-box, .job-list-container .job-card-wrap")) {
    const candidateLink = node.querySelector("a.job-name[href], .job-name a[href], a[href*='/job_detail/']");
    if (visible(node) && candidateLink && canonical(candidateLink.href) === expectedUrl) targetLinkSeen = true;
    const data = readCard(node);
    // Both wrapper and inner box can expose the same link. Click the inner card
    // carrying its own interaction handler, not its enclosing layout wrapper.
    if (data && (!unique.has(data.url) || unique.get(data.url).node.contains?.(node))) unique.set(data.url, { node, data });
  }
  const target = unique.get(expectedUrl);
  if (!target) return { ...fail, failureCode: targetLinkSeen ? "card-incomplete" : "card-missing" };
  const { node: card, data: initial } = target;
  const duplicateTitle = [...unique.values()].some(({ data }) => data.url !== expectedUrl && data.title === initial.title && data.company !== initial.company);
  const duplicateIdentity = [...unique.values()].some(({ data }) => data.url !== expectedUrl && data.title === initial.title && data.company === initial.company);
  const selected = () => card.classList.contains("active") || card.classList.contains("selected") || card.getAttribute("aria-selected") === "true";
  const field = (root, selectors, limit = 160, accept = () => true) => {
    for (const selector of selectors) {
      for (const node of root.querySelectorAll(selector)) {
        if (!visible(node)) continue;
        const text = clean(node.innerText, limit);
        if (text && accept(text)) return text;
      }
    }
    return "";
  };
  const readableSalary = (text) => !/[\uE000-\uF8FF\uFFFD\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u.test(text);
  const salaryFrom = (root) => field(root, [".job-salary", ".salary"], 80, readableSalary);
  // Company metadata on headhunter pages may describe the agency, not the
  // hiring client. Keep it unknown unless the source identifies a direct hire.
  const anonymousCompany = /某|匿名|保密/.test(initial.company);
  const agencyContext = (root) => /猎头|客户公司\s*[:：]/.test(root.innerText || "");
  const cardIndustry = anonymousCompany || agencyContext(card) ? "" : field(card, [".company-info .industry"]);
  const readPanel = () => {
    const panel = document.querySelector(".job-detail-box");
    if (!visible(panel)) return null;
    const titleNode = panel.querySelector(".job-name");
    const descriptionNode = panel.querySelector(".desc, .job-sec-text");
    if (!rendered(titleNode) || !visible(descriptionNode)) return null;
    const panelLink = panel.querySelector("a[href*='/job_detail/']");
    const companyNode = panel.querySelector(".boss-name, .company-name");
    const company = visible(companyNode) ? clean(companyNode.innerText, 160) : "";
    return {
      title: clean(titleNode.innerText, 160), description: clean(descriptionNode.innerText),
      company,
      url: panelLink && rendered(panelLink) ? canonical(panelLink.href) : "",
      salary: salaryFrom(panel),
      agency: agencyContext(panel),
      industry: !anonymousCompany && !agencyContext(card) && !agencyContext(panel) && company === initial.company
        ? field(panel, [".company-info .industry"]) : "",
    };
  };
  const before = readPanel();
  const wasSelected = selected();
  const identity = (panel) => panel && panel.title === initial.title && panel.description &&
    (!panel.company || panel.company === initial.company) && (!panel.url || panel.url === expectedUrl) &&
    (!duplicateTitle || panel.company === initial.company || panel.url === expectedUrl) &&
    (!duplicateIdentity || panel.url === expectedUrl);
  const exactBefore = wasSelected && identity(before) &&
    (before.url === expectedUrl || (before.company === initial.company && !duplicateIdentity));
  if (card.tagName?.toLowerCase() === "a" && canonical(card.href) !== expectedUrl) return fail;
  try { card.click(); } catch { return fail; }
  const deadline = Date.now() + 8000;
  let previous = null;
  let failureCode = "detail-unchanged";
  while (Date.now() <= deadline) {
    const fresh = readCard(card);
    if (!fresh || fresh.url !== expectedUrl || fresh.title !== initial.title || fresh.company !== initial.company) return { ...fail, failureCode: "identity-mismatch" };
    const panel = readPanel();
    const changed = panel?.description && panel.description !== before?.description;
    failureCode = !visible(document.querySelector(".job-detail-box")) ? "panel-missing" : !panel || !panel.title || !panel.description ? "panel-incomplete" : !identity(panel) ? "identity-mismatch" : "detail-unchanged";
    if (identity(panel) && (changed || exactBefore)) {
      const fingerprint = [panel.title, panel.company, panel.url, panel.description, panel.salary, panel.industry, panel.agency].join("\u0000");
      if (previous === fingerprint) {
        const locationNode = card.querySelector(".company-location, .job-area");
        const locationText = visible(locationNode) ? clean(locationNode.innerText, 160) : "";
        const salary = panel.salary || salaryFrom(card);
        const industry = panel.agency || (panel.industry && cardIndustry && panel.industry !== cardIndustry) ? "" : panel.industry || cardIndustry;
        const job = { url: expectedUrl, title: initial.title, company: initial.company,
          description: panel.description, detail: true };
        if (locationText) job.location = locationText;
        if (salary) job.salaryText = salary;
        if (industry) job.industry = industry;
        return { ok: true, job, detailContext: { jobUrl: expectedUrl, title: initial.title, company: initial.company } };
      }
      previous = fingerprint;
    } else previous = null;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return { ...fail, failureCode };
}

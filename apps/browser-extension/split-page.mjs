// Standalone functions for chrome.scripting.executeScript: each carries its helpers.
// Read-only, bounded structural evidence. Until an actual search page identifies
// its continuation mechanism, never guess which element should be scrolled.
export function inspectSearchContinuation(expectedUrl) {
  try {
    const actual = new URL(location.href);
    const expected = new URL(expectedUrl);
    if ([actual, expected].some((url) => url.origin !== "https://www.zhipin.com" || url.username || url.password || !/^\/web\/geek\/jobs?\/?$/.test(url.pathname)) ||
      !expected.searchParams.get("query") || !expected.searchParams.get("city") ||
      actual.searchParams.get("query") !== expected.searchParams.get("query") ||
      actual.searchParams.get("city") !== expected.searchParams.get("city")) return null;
  } catch { return null; }
  const visible = (node) => {
    if (!node?.isConnected || !node.getClientRects().length) return false;
    for (let part = node, depth = 0; part?.nodeType === 1; part = part.parentElement) {
      if (++depth > 64) return false;
      const style = getComputedStyle(part);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return true;
  };
  const blocked = [".login-dialog form", ".login-box form", "[class*='login-dialog'] form", "form:has(input[type='password'])",
    "iframe[src*='captcha']", "iframe[src*='verify']", ".geetest_panel", ".verify-dialog", "[class*='captcha-dialog']", "[class*='verify-dialog']"];
  if (blocked.some((selector) => [...document.querySelectorAll(selector)].slice(0, 100).some(visible))) return null;
  let truncated = false;
  const bounded = (selector, root = document, limit = 100) => {
    const found = root.querySelectorAll(selector);
    if (found.length > limit) truncated = true;
    return [...found].slice(0, limit);
  };
  const count = (value) => { if (value > 100) truncated = true; return Math.min(value, 100); };
  const integer = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    if (number > 10_000_000) truncated = true;
    return Math.max(0, Math.min(10_000_000, Math.round(number)));
  };
  const canonical = (href) => {
    try {
      const url = new URL(href, location.href);
      return url.origin === "https://www.zhipin.com" && !url.username && !url.password && /^\/job_detail\/[\w-]+\.html$/.test(url.pathname) ? url.origin + url.pathname : "";
    } catch { return ""; }
  };
  const links = new Set();
  for (const link of bounded("a[href*='/job_detail/']")) {
    const rendered = visible(link) || (link?.isConnected && getComputedStyle(link).display === "contents" && bounded("*", link, 10).some(visible));
    if (rendered && canonical(link.href)) links.add(canonical(link.href));
  }
  const controls = new Map();
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  for (const node of bounded("button, a", document, 250)) {
    if (/^(下一页|下页|Next)$/i.test(clean(node.innerText || node.getAttribute("aria-label") || node.title))) controls.set(node, node);
  }
  for (const icon of bounded(".ui-icon-arrow-right")) {
    const control = icon.closest("a, button, li") || icon.parentElement;
    if (control && !controls.has(control)) controls.set(control, icon);
  }
  const disabled = (node) => {
    for (let part = node, depth = 0; part?.nodeType === 1 && depth <= 12; part = part.parentElement, depth++) {
      if (part.disabled || part.getAttribute("aria-disabled") === "true" || part.classList.contains("disabled")) return true;
    }
    return false;
  };
  const shown = [...controls].filter(([control, source]) => visible(control) && visible(source));
  const available = shown.filter(([control, source]) => !disabled(control) && !disabled(source));
  const paginationTruncated = controls.size > 100 || document.querySelectorAll("button, a").length > 250 || document.querySelectorAll(".ui-icon-arrow-right").length > 100;
  const listNodes = bounded(".job-list-container, .job-list-box");
  const visibleLists = listNodes.filter(visible);
  const containers = [];
  const measured = new Set();
  const addContainer = (node, kind, depth) => {
    if (!node || measured.has(node)) return;
    measured.add(node);
    if (containers.length >= 6) { truncated = true; return; }
    const clientHeight = integer(node.clientHeight), scrollHeight = integer(node.scrollHeight), scrollTop = integer(node.scrollTop);
    const remaining = integer(Math.max(0, scrollHeight - clientHeight - scrollTop));
    const overflow = getComputedStyle(node).overflowY;
    containers.push({ kind, depth, clientHeight, scrollHeight, scrollTop, remaining,
      canScroll: clientHeight > 0 && scrollHeight > clientHeight + 2 && (kind === "document" || /^(auto|scroll)$/.test(overflow)),
      atEnd: remaining <= 2 });
  };
  for (const list of visibleLists) {
    // Only inspect ancestors of the known list containing recognizable cards.
    const cards = bounded(".job-card-box, .job-card-wrap", list, 60);
    const bound = cards.some((card) => visible(card) && bounded("a[href*='/job_detail/']", card, 5).some((link) => {
      // display:contents anchors have no box but can own a rendered title.
      return canonical(link.href) && (visible(link) || (getComputedStyle(link).display === "contents" && bounded("*", link, 10).some(visible)));
    }));
    if (!bound) continue;
    addContainer(list, "list", 0);
    let part = list.parentElement;
    for (let depth = 1; part && depth <= 12; part = part.parentElement, depth++) {
      if (part === document.scrollingElement) break;
      if (visible(part) && /^(auto|scroll|hidden|clip)$/.test(getComputedStyle(part).overflowY)) addContainer(part, "ancestor", depth);
      if (depth === 12 && part.parentElement && part.parentElement !== document.scrollingElement) truncated = true;
    }
    if (visible(document.scrollingElement)) addContainer(document.scrollingElement, "document", 0);
  }
  return {
    version: 1, linkCount: count(links.size),
    pagination: { matched: count(controls.size), visible: count(shown.length), enabled: count(available.length),
      disabled: count(shown.length - available.length), ambiguous: available.length > 1, truncated: paginationTruncated },
    lists: { matched: count(listNodes.length), visible: count(visibleLists.length), truncated: document.querySelectorAll(".job-list-container, .job-list-box").length > 100 },
    scrollContainers: containers, truncated,
  };
}

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

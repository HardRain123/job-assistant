/** Standalone DOM extractor: safe to pass to chrome.scripting.executeScript. */
export function extractJobs(options) {
  // Reuse this reader in the isolated world for the last pre-click check.
  if (options?.readerKey && /^__jobAssistantReader[a-f0-9]{32}$/.test(options.readerKey) &&
    location.origin === "https://www.zhipin.com" && /^\/job_detail\/[a-zA-Z0-9_-]+\.html$/.test(location.pathname)) {
    globalThis[options.readerKey] = extractJobs;
    return { registered: true };
  }
  const MAX_JOBS = 30;
  const clean = (value, max = 3000) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  const visible = (node) => {
    if (!node || !node.getClientRects().length) return false;
    for (let element = node; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return true;
  };
  const renderedText = (node, max) =>
    visible(node) ? clean(node.innerText, max) : "";
  const textFrom = (root, selectors, max, accept = () => true) => {
    for (const selector of selectors) {
      for (const element of root.querySelectorAll(selector)) {
        const value = renderedText(element, max);
        if (value && accept(value)) return value;
      }
    }
    return "";
  };
  const companyName = (value) => clean(value.replace(/^公司名称(?:\s*[:：]\s*|\s+)/, ""), 160);
  // Obfuscated glyphs must not reach the numeric salary parser, even when
  // some digits remain readable. Try another visible candidate instead.
  const readableSalary = (value) => !/[\uE000-\uF8FF\uFFFD\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u.test(value);
  const unique = (values) => {
    const candidates = [...new Set(values.filter(Boolean))];
    return candidates.length === 1 ? candidates[0] : "";
  };
  // These fallbacks use rendered, bounded sections, never whole-page text.
  // Screenshots establish the labels/order, not the site's CSS class names.
  const linesOf = (root) => visible(root)
    ? String(root.innerText || "").split(/[\r\n]+/).map((line) => clean(line, 500)).filter(Boolean)
    : [];
  const sectionLines = (heading) => {
    const sections = [];
    const headings = new Set([...document.querySelectorAll("h2, h3, h4, h5, dt"), ...document.querySelectorAll("div, p, span")]);
    for (const element of headings) {
      if (renderedText(element, 80) !== heading) continue;
      let parent = element.parentElement;
      for (let depth = 0; parent && depth < 3; depth++, parent = parent.parentElement) {
        if (!visible(parent) || String(parent.innerText || "").length > 1200) break;
        const lines = linesOf(parent);
        if (lines[0] !== heading || lines.some((line) => /^(职位描述|推荐职位|相似职位|热门职位|公司介绍|工商信息)$/.test(line))) break;
        if (lines.length > 1) sections.push({ lines, root: parent });
      }
    }
    return sections;
  };
  const absoluteUrl = (href) => {
    try {
      const url = new URL(href, location.href);
      return url.origin === "https://www.zhipin.com" ? url.href : "";
    } catch {
      return "";
    }
  };
  const sourceJobId = (url) =>
    url.match(/\/job_detail\/([^/?#]+)\.html/i)?.[1] || "";
  const result = { jobs: [], warnings: [] };
  if (location.origin !== "https://www.zhipin.com") {
    result.warnings.push("当前页面不是 BOSS 直聘，无法读取职位信息。");
    return result;
  }
  const seen = new Set();
  const add = (job) => {
    const key = job.sourceJobId || job.url;
    if (
      !job.title ||
      !job.company ||
      !job.description ||
      !job.url ||
      seen.has(key) ||
      result.jobs.length >= MAX_JOBS
    )
      return;
    seen.add(key);
    result.jobs.push(job);
  };
  const isDetail = /\/job_detail\/[^/?#]+\.html/i.test(location.pathname);
  if (isDetail) {
    result.pageUrl = location.href;
    const title = textFrom(
      document,
      [
        ".job-banner .name h1",
        ".job-banner .job-name",
        ".job-detail .job-name",
        "h1",
      ],
      160,
    );
    // Headhunter pages label the hiring client in the job banner; a sidebar
    // company name may instead belong to the recruiting agency.
    const clientNames = new Set();
    let clientLabelSeen = false;
    for (const banner of document.querySelectorAll(".job-banner")) {
      if (!visible(banner)) continue;
      for (const element of banner.querySelectorAll("p, span, a, div")) {
        if (!visible(element)) continue;
        const value = String(element.innerText || "").trim();
        if (/^客户公司\s*[:：]/.test(value)) clientLabelSeen = true;
        if (value.length > 200 || /[\r\n]/.test(value)) continue;
        const match = value.match(/^客户公司\s*[:：]\s*(\S.{0,159})$/);
        if (match && clean(match[1], 160)) clientNames.add(clean(match[1], 160));
      }
    }
    const company = clientLabelSeen ? (clientNames.size === 1 ? [...clientNames][0] : "") : companyName(textFrom(
      document,
      [
        ".company-info .name",
        ".job-banner .company-name",
        ".job-detail .company-name",
      ],
      160,
    ));
    const description = textFrom(document, [".job-sec-text", ".job-detail .job-sec-text", ".job-detail-box .job-sec-text", "[data-testid='job-description']"], 12000);
    const headerCandidates = [...document.querySelectorAll(".job-banner")];
    // If the banner class changed, stay within a small ancestor of this exact
    // title. Never climb into the description/sidebar/recommendations.
    for (const heading of document.querySelectorAll("h1")) {
      if (renderedText(heading, 160) !== title) continue;
      for (let parent = heading.parentElement, depth = 0; parent && depth < 4; parent = parent.parentElement, depth++) {
        const value = visible(parent) ? String(parent.innerText || "") : "";
        if (!value || value.length > 1500 || /职位描述|公司基本信息|推荐职位|相似职位/.test(value)) break;
        headerCandidates.push(parent);
      }
    }
    const headers = [...new Set(headerCandidates)].filter((banner) =>
      visible(banner) && title && renderedText(banner, 4000).includes(title)
      && !/职位描述|推荐职位|相似职位/.test(renderedText(banner, 4000)));
    const salaryPattern = /^(?:\d+(?:\.\d+)?\s*[-–—~至]\s*\d+(?:\.\d+)?\s*[kK千万元](?:元)?(?:\s*[/／]\s*[月天日年])?(?:\s*[·•・]\s*\d+\s*薪)?|面议)$/;
    const headerSalaryCandidates = headers.flatMap((banner) => [
      ...linesOf(banner),
      ...[...banner.querySelectorAll("span, b, strong")].map((element) => renderedText(element, 80)),
    ]);
    const headerSalaries = headerSalaryCandidates.filter((line) => readableSalary(line) && salaryPattern.test(line));
    const salaryText = textFrom(document, [".job-banner .salary", ".job-banner .job-salary"], 80,
      (value) => readableSalary(value) && salaryPattern.test(value)) || unique(headerSalaries);
    const metadata = headers.flatMap((banner) => [banner, ...banner.querySelectorAll("p, span, li")])
      .filter(visible).map((element) => renderedText(element, 400))
      .map((value) => value.match(/^([\p{Script=Han}·•\-]{2,40})\s+(经验不限|应届生|\d+\s*[-–至]\s*\d+年|\d+年以上|\d+年以内)\s+(学历不限|初中及以下|中专\/中技|高中|大专|本科|硕士|博士)$/u))
      .filter(Boolean);
    const locationText = textFrom(document, [".job-banner .job-location", ".job-info .location", ".job-banner .job-area"], 160)
      || unique(metadata.map((match) => match[1]));
    const normalizeCompany = (value) => clean(value, 160).replace(/(?:股份有限公司|有限责任公司|有限公司)$/, "");
    const industries = [];
    const companySections = sectionLines("公司基本信息");
    const linkedCompanyName = ({ lines, root }) => unique([...root.querySelectorAll("a[href*='/gongsi/']")].map((link) => {
      const name = renderedText(link, 160);
      if (!name || name !== lines[1]) return "";
      try {
        const url = new URL(link.href, location.href);
        return url.origin === location.origin && !url.username && !url.password && /^\/gongsi\/[a-zA-Z0-9_-]+\.html$/.test(url.pathname) ? name : "";
      } catch { return ""; }
    }));
    const displayCompany = unique(companySections.map(linkedCompanyName));
    // Bounded public field evidence helps diagnose real layouts without reading
    // page HTML, hidden state, chat history or unrelated page text.
    const evidenceSections = companySections.map(({ lines, root }) => ({
      lines: lines.slice(0, 16).map((line) => clean(line, 160)),
      links: [...root.querySelectorAll("a[href]")].filter(visible).flatMap((link) => {
        try {
          const url = new URL(link.href, location.href);
          if (url.origin !== location.origin || url.username || url.password || !/^\/gongsi\/[a-zA-Z0-9_-]+\.html$/.test(url.pathname)) return [];
          return [{ text: renderedText(link, 160), path: url.pathname }];
        } catch { return []; }
      }).slice(0, 8),
    }));
    result.pageEvidence = {
      title, company, descriptionPresent: Boolean(description), clientLabelSeen,
      clientNames: [...clientNames].slice(0, 3),
      headerLines: [...new Set(headers.flatMap(linesOf))].slice(0, 20).map((line) => clean(line, 160)),
      companySections: [...new Map(evidenceSections.map((section) => [JSON.stringify(section), section])).values()].slice(0, 3),
    };
    const companyAliases = !clientLabelSeen && !/某|匿名|保密/.test(company) && displayCompany && displayCompany !== company ? [displayCompany] : [];
    let matchingCompanySection = false;
    if (!clientLabelSeen && !/某|匿名|保密/.test(company)) {
      for (const section of companySections) {
        const { lines } = section;
        if (!lines.some((line) => normalizeCompany(line) === normalizeCompany(company))
          && !(displayCompany && linkedCompanyName(section) === displayCompany)) continue;
        matchingCompanySection = true;
        // Only the single industry line between company size and the jobs link.
        const size = lines.findIndex((line) => /^(?:\d+\s*[-–至]\s*\d+人|\d+人以上|少于\d+人)$/.test(line));
        const industry = lines[size + 1];
        if (size >= 0 && industry && /^[\p{Script=Han}A-Za-z/、·&（）()\s-]{2,40}$/u.test(industry)
          && !/公司|职位|招聘|查看|融资|轮|未融资|不需要融资/.test(industry)
          && /^(查看全部职位|查看所有职位)$/.test(lines[size + 2] || "")) industries.push(industry);
      }
    }
    const explicitIndustry = textFrom(document, [".company-info .industry"], 160);
    const industry = clientLabelSeen || /某|匿名|保密/.test(company) ? "" : unique([explicitIndustry, ...industries]);
    const salaryCandidates = [
      ...[...document.querySelectorAll(".job-banner .salary, .job-banner .job-salary")].map((element) => renderedText(element, 80)),
      ...headerSalaryCandidates.filter((value) => value.length <= 80 && /[kK千万元]|面议/.test(value)),
    ].filter(Boolean);
    result.fieldReading = {
      salary: salaryText ? "readable" : salaryCandidates.some((value) => !readableSalary(value)) ? "encoded" : salaryCandidates.length ? "unrecognized" : "missing",
      location: locationText ? "readable" : "missing",
      industry: industry ? "readable" : clientLabelSeen || /某|匿名|保密/.test(company) ? "employer-unknown"
        : new Set([explicitIndustry, ...industries].filter(Boolean)).size > 1 ? "conflict"
        : !companySections.length ? "section-missing" : !matchingCompanySection ? "company-mismatch" : "unrecognized",
    };
    if (!salaryText) result.warnings.push("薪资未能可靠读取，保留未知，不视为达到薪资要求。");
    if (!locationText) result.warnings.push("工作地点未能可靠读取，保留未知。");
    if (!industry) result.warnings.push("雇主行业未能可靠读取，保留未知。");
    if (!description) result.diagnosticCode = "panel-incomplete";
    else if (!title || !company) result.diagnosticCode = "card-incomplete";
    if (!description)
      result.warnings.push(
        "未找到可见的职位描述区域，因此没有导入该职位。请确认已打开公开职位详情页后重试。",
      );
    if (!title || !company)
      result.warnings.push(
        "未能读取职位名称或公司名称，因此没有可导入的职位。",
      );
    else
      add({
        url: location.href,
        sourceJobId: sourceJobId(location.href),
        title,
        company,
        ...(companyAliases.length ? { companyAliases } : {}),
        description,
        detail: true,
        location: locationText,
        salaryText,
        industry,
        experienceText: textFrom(
          document,
          [".job-banner .tag-list", ".job-info .job-limit"],
          240,
        ) || unique(metadata.map((match) => match[2])),
        education: textFrom(
          document,
          [".job-banner .job-limit", ".job-info .job-limit"],
          160,
        ) || unique(metadata.map((match) => match[3])),
      });
    return result;
  }
  const links = Array.from(
    document.querySelectorAll(
      ".job-card-wrapper a[href*='/job_detail/'], .job-card a[href*='/job_detail/'], .job-list-box a[href*='/job_detail/'], a.job-card-left[href*='/job_detail/']",
    ),
  );
  for (const link of links) {
    const card =
      link.closest(".job-card-wrapper, .job-card, li") || link.parentElement;
    if (!visible(card) || !visible(link)) continue;
    const url = absoluteUrl(link.href);
    const title =
      textFrom(link, [".job-name, .job-title, h3"], 160) ||
      renderedText(link, 160);
    const company = companyName(textFrom(
      card,
      [".company-name", ".company-text .name", ".company-info .name"],
      160,
    ));
    const location = textFrom(card, [".job-area", ".job-location"], 160);
    const salaryText = textFrom(card, [".salary", ".job-salary"], 80, readableSalary);
    const experienceText = textFrom(
      card,
      [".job-info .tag-list", ".job-card-footer .tag-list"],
      240,
    );
    const education = textFrom(card, [".job-info .job-limit"], 160);
    // Lists lack a full description; their visible fields form an explicit summary.
    const description = clean(
      [title, company, salaryText, location, experienceText, education]
        .filter(Boolean)
        .join(" · "),
      1200,
    );
    add({
      url,
      sourceJobId: sourceJobId(url),
      title,
      company,
      description,
      detail: false,
      location,
      salaryText,
      industry: textFrom(card, [".company-info .industry"], 160),
      experienceText,
      education,
    });
  }
  if (!result.jobs.length)
    result.warnings.push(
      "没有识别到可见的公开职位卡片。请打开 BOSS 直聘的职位详情页后重试。",
    );
  else
    result.warnings.push(
      "列表页只导入可见职位摘要；打开职位详情页可补充完整职位描述。",
    );
  return result;
}

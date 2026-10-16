/** Runs only in the isolated world of the dedicated application tab. */
export async function applicationPageStep(request) {
  const clean = (value) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  const normCompany = (value) =>
    clean(value)
      .replace(/^公司名称\s*[:：]?\s*/, "")
      .replace(/(?:股份有限公司|有限责任公司|有限公司)$/, "");
  const visible = (node) => {
    if (!node?.getClientRects().length) return false;
    for (let el = node; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (
        style.display === "none" ||
        ["hidden", "collapse"].includes(style.visibility)
      )
        return false;
    }
    return true;
  };
  const nodes = (root, selector) =>
    [...root.querySelectorAll(selector)].filter(visible);
  const text = (node) => (visible(node) ? clean(node.innerText) : "");
  const enabled = (node) =>
    visible(node) &&
    !node.disabled &&
    node.getAttribute("aria-disabled") !== "true" &&
    !node.classList.contains("disabled");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const canonical = (value) => {
    try {
      const url = new URL(value, location.href);
      return url.origin === "https://www.zhipin.com" &&
        !url.username &&
        !url.password &&
        /^\/job_detail\/[a-zA-Z0-9_-]+\.html$/.test(url.pathname)
        ? url.origin + url.pathname
        : "";
    } catch {
      return "";
    }
  };
  const stop = (reason) => ({ ok: false, reason });
  const authorize = async () => {
    if (
      !request.authorization ||
      typeof chrome?.runtime?.sendMessage !== "function"
    )
      return false;
    try {
      const permit = await chrome.runtime.sendMessage({
        type: "job-assistant:application-authorize",
        ...request.authorization,
      });
      return (
        permit?.allowed === true &&
        Number.isFinite(permit.expiresAt) &&
        Date.now() <= permit.expiresAt
      );
    } catch {
      return false;
    }
  };
  const blocked = () => {
    if (location.origin !== "https://www.zhipin.com")
      return "recipient-mismatch";
    if (
      /\/(?:login|web\/user)(?:\/|$)/.test(location.pathname) ||
      nodes(
        document,
        ".login-dialog form, .login-box form, form input[type=password]",
      ).length
    )
      return "login-required";
    if (
      nodes(
        document,
        "iframe[src*='captcha'], iframe[src*='verify'], .geetest_panel, .verify-dialog, [class*='captcha-dialog']",
      ).length
    )
      return "verification-required";
    // Read only visible platform notices, never job text or chat messages.
    if (
      nodes(
        document,
        ".dialog-wrap, .dialog-box, .toast, .toast-text, .chat-tip",
      ).some((node) => {
        const value = text(node);
        return (
          value.length <= 500 &&
          /(?:今日|今天|每日|当天).{0,30}(?:沟通|招呼).{0,30}(?:上限|用完|已满)|(?:沟通|招呼).{0,30}(?:次数已达上限|次数已用完)|操作(?:过于|太)频繁|沟通(?:过于|太)频繁/.test(
            value,
          )
        );
      })
    )
      return "platform-limit";
    return "";
  };
  const job = request?.job;
  if (!job || !canonical(job.url) || !clean(job.title) || !clean(job.company))
    return stop("recipient-mismatch");
  const reason = blocked();
  if (reason) return stop(reason);
  const companies = [job.company, ...(job.companyAliases || [])]
    .map(normCompany)
    .filter(Boolean);
  const locationMatches = (value) => {
    const expected = clean(job.location),
      actual = clean(value);
    if (!expected || !actual) return false;
    if (actual === expected) return true;
    // A chat job bar can omit district/area segments from a structured address.
    // Only accept whole leading segments, never substring or cross-city matches.
    const split = (address) => address.split(/[·•・]/).map(clean);
    const parts = split(expected),
      shown = split(actual);
    return (
      parts.length >= 2 &&
      parts.length <= 3 &&
      parts.every((part) => /^[\p{Script=Han}]{2,20}$/u.test(part)) &&
      /[区县市]$/.test(parts[1]) &&
      shown.length >= 1 &&
      shown.length <= parts.length &&
      shown.every((part, index) => part === parts[index])
    );
  };
  const readJob = request.readerKey ? globalThis[request.readerKey] : null;
  if (request.readerKey) delete globalThis[request.readerKey];
  const fullJobMatches = () => {
    if (typeof readJob !== "function") return false;
    const found = readJob()?.jobs?.[0];
    if (
      !found?.detail ||
      found.status === "closed" ||
      found.status === "unknown" ||
      canonical(found.url) !== canonical(job.url) ||
      clean(found.title) !== clean(job.title) ||
      !companies.includes(normCompany(found.company)) ||
      clean(found.description) !== clean(job.description)
    )
      return false;
    const salary = clean(found.salaryText).match(
      /^(\d+(?:\.\d+)?)\s*[-–—~至]\s*(\d+(?:\.\d+)?)\s*[kK](?:\s*[·•・]\s*\d+\s*薪)?$/,
    );
    return (
      Boolean(salary) &&
      Number(salary[1]) * 1000 === job.salaryMin &&
      Number(salary[2]) * 1000 === job.salaryMax
    );
  };
  const contactControl = () => {
    if (canonical(location.href) !== canonical(job.url)) return null;
    const roots = new Set(nodes(document, ".job-banner"));
    for (const h1 of nodes(
      document,
      ".job-banner .job-name, .job-detail .job-name, h1",
    )) {
      if (text(h1) !== clean(job.title)) continue;
      for (
        let parent = h1.parentElement, depth = 0;
        parent && depth < 4;
        parent = parent.parentElement, depth++
      ) {
        if (
          text(parent).length > 2000 ||
          /职位描述|公司基本信息|推荐职位/.test(text(parent))
        )
          break;
        roots.add(parent);
      }
    }
    for (const root of roots) {
      if (!text(root).includes(clean(job.title))) continue;
      const controls = nodes(
        root,
        "a, button, .btn-startchat, .op-btn-chat, [role='button']",
      ).filter(
        (node) => enabled(node) && /^(立即沟通|继续沟通)$/.test(text(node)),
      );
      if (controls.length === 1) return controls[0];
    }
    return null;
  };
  // Match the editor's own header; never use the contact list or old messages.
  const editorSelector =
    ".chat-editor .chat-input[contenteditable='true'], div.chat-input[contenteditable='true'], #chat-input[contenteditable='true']";
  const headerFields =
    "a, button, span, div, p, strong, em, h1, h2, h3, b, label";
  const leafFields = (root) =>
    nodes(root, headerFields).filter(
      (node) =>
        outsideChatHistory(node) &&
        node.children.length === 0 &&
        text(node).length <= 160,
    );
  const outsideChatHistory = (node) =>
    !node.closest(
      ".message-item, .chat-message, .chat-message-list, .message-list, .chat-record, .user-list, .chat-user-list, .friend-list",
    );
  const semanticProbes = [];
  const diagnosticHeaders = new Map();
  const bindConversation = (root, editor, header, probe) => {
    // This bounded, visible header stays in the extension worker's memory only.
    // A changed recruiter/header invalidates all subsequent actions.
    const binding = JSON.stringify([canonical(job.url), header]);
    if (
      request.conversationBinding &&
      request.conversationBinding !== binding
    ) {
      if (probe) probe.result = "binding-changed";
      return null;
    }
    if (
      request.conversationOrigin &&
      request.mode !== "inspect" &&
      !request.conversationBinding
    ) {
      if (probe) probe.result = "binding-missing";
      return null;
    }
    if (probe) probe.result = "matched";
    return { root, editor, binding };
  };
  // Some current layouts render the job bar as a button-driven card, without a
  // job-detail href. Accept it only after this dedicated tab navigated from the
  // exact frozen job, with all four visible header fields agreeing. Geometry
  // confines the lookup to the editor's own pane, above its message history.
  const semanticHeader = (root, editor, depth) => {
    // Fixed codes and bounded counts only: no DOM, text, URLs or chat history
    // leave the page through these diagnostics, and they never grant permission.
    const probe = {
      depth,
      result: "source-unverified",
      viewControlCount: 0,
      viewTextCount: 0,
      titleMatchCount: 0,
      cityMatchCount: 0,
      salaryMatchCount: 0,
      employerMatchCount: 0,
      recruiterCount: 0,
    };
    semanticProbes.push(probe);
    const stages = [
      "no-card",
      "card-bounds",
      "job-fields",
      "salary",
      "conflicting-link",
      "employer",
      "recruiter",
      "header-limit",
    ];
    const progress = (result) => {
      if (stages.indexOf(result) >= stages.indexOf(probe.result))
        probe.result = result;
    };
    const count = (key, value) => {
      probe[key] = Math.min(20, Math.max(probe[key], value));
    };
    if (
      (request.mode !== "diagnose" && canonical(request.conversationOrigin) !== canonical(job.url)) ||
      !clean(job.location) ||
      !Number.isFinite(job.salaryMin) ||
      !Number.isFinite(job.salaryMax)
    )
      return null;
    probe.result = "geometry-unavailable";
    if (
      typeof editor.getBoundingClientRect !== "function" ||
      typeof root.getBoundingClientRect !== "function"
    )
      return null;
    const er = editor.getBoundingClientRect(),
      rr = root.getBoundingClientRect();
    if (er.width < 200) {
      probe.result = "editor-width";
      return null;
    }
    if (rr.left < er.left - 80) {
      probe.result = "pane-left";
      return null;
    }
    if (rr.right > er.right + 80) {
      probe.result = "pane-right";
      return null;
    }
    probe.result = "view-control";
    const candidates = nodes(root, headerFields).filter(
      (node) => outsideChatHistory(node) && text(node) === "查看职位",
    );
    count("viewTextCount", candidates.length);
    // A label may repeat in nested wrappers and contain a decorative child.
    // Keep its innermost matching element; separate controls remain ambiguous.
    const controls = candidates.filter(
      (node) =>
        !candidates.some((other) => other !== node && node.contains(other)),
    );
    count("viewControlCount", controls.length);
    if (controls.length !== 1) return null;
    progress("no-card");
    for (
      let card = controls[0].parentElement, depth = 0;
      card && card !== root && depth < 5;
      card = card.parentElement, depth++
    ) {
      if (!outsideChatHistory(card)) {
        probe.result = "outside-history";
        return null;
      }
      const cr = card.getBoundingClientRect();
      progress("card-bounds");
      if (
        cr.height > 120 ||
        text(card).length > 400 ||
        cr.bottom > er.top ||
        cr.top > rr.top + 200
      )
        continue;
      const fields = leafFields(card);
      progress("job-fields");
      count(
        "titleMatchCount",
        fields.filter((node) => text(node) === clean(job.title)).length,
      );
      count(
        "cityMatchCount",
        fields.filter((node) => locationMatches(text(node))).length,
      );
      if (
        fields.filter((node) => text(node) === clean(job.title)).length !== 1 ||
        fields.filter((node) => locationMatches(text(node))).length !== 1
      )
        continue;
      progress("salary");
      const salaries = fields
        .map((node) =>
          text(node).match(
            /^(\d+(?:\.\d+)?)\s*[-–—~至]\s*(\d+(?:\.\d+)?)\s*[kK](?:\s*[·•・]\s*(\d+(?:\.\d+)?)\s*薪)?$/,
          ),
        )
        .filter(Boolean);
      const salaryMatches = (salary) =>
        Number(salary[1]) * 1000 === job.salaryMin &&
        Number(salary[2]) * 1000 === job.salaryMax &&
        (!salary[3] ||
          job.salaryMonths == null ||
          Number(salary[3]) === job.salaryMonths);
      count("salaryMatchCount", salaries.filter(salaryMatches).length);
      if (salaries.length !== 1 || !salaryMatches(salaries[0])) continue;
      const links = [
        ...new Set([
          ...nodes(card, "a[href*='/job_detail/']"),
          ...nodes(root, "a[href*='/job_detail/']").filter((link) => {
            if (!outsideChatHistory(link)) return false;
            const box = link.getBoundingClientRect();
            return box.top >= rr.top && box.bottom <= cr.bottom;
          }),
        ]),
      ];
      if (links.some((link) => canonical(link.href) !== canonical(job.url))) {
        probe.result = "conflicting-link";
        return null;
      }
      const header = leafFields(root).filter((node) => {
        const box = node.getBoundingClientRect();
        return (
          box.top >= cr.top - 100 &&
          box.bottom <= cr.top + 4 &&
          box.left >= rr.left &&
          box.right <= rr.right
        );
      });
      const employer = header.filter((node) =>
        companies.includes(normCompany(text(node))),
      );
      if (request.mode === "diagnose") {
        // A separate read-only task can explain a header without claiming that
        // navigation or a send was verified. Read only the four-field-matched
        // editor pane's public Name / Employer / Role row, never chat history.
        if (employer.length !== 1) continue;
        const companyBox = employer[0].getBoundingClientRect();
        const candidates = nodes(root, headerFields).filter((node) => {
          const value = text(node);
          if (!outsideChatHistory(node) || !value || value.length > 48 ||
              /[\p{Cc}\p{Cf}<>]/u.test(value) || node === employer[0] ||
              companies.includes(normCompany(value))) return false;
          const box = node.getBoundingClientRect();
          return box.left >= rr.left && box.right <= rr.right &&
            box.top >= cr.top - 100 && box.bottom <= cr.top + 4 &&
            Math.abs((box.top + box.bottom - companyBox.top - companyBox.bottom) / 2) <= 12;
        });
        const innermost = candidates.filter((node) => !candidates.some((other) =>
          node !== other && node.contains(other) && text(node) === text(other)));
        const labels = (side) => [...new Set(innermost.filter((node) => {
          const box = node.getBoundingClientRect();
          return side === "name" ? box.right <= companyBox.left + 4
            : box.left >= companyBox.right - 4;
        }).map(text))].slice(0, 3);
        const evidence = { names: labels("name"), roles: labels("role") };
        diagnosticHeaders.set(JSON.stringify(evidence), evidence);
        continue;
      }
      // A plain name needs the full Name / exact Employer / recruiting Role row.
      // Do not accept arbitrary header text or online/activity labels as names.
      const roles = header.filter((node) =>
        /^(HR|HRBP|招聘者|人事|招聘助理|招聘专员|招聘经理|招聘负责人)$/i.test(
          text(node),
        ),
      );
      const plainNameInRecruiterRow = (node) => {
        const value = text(node);
        if (
          employer.length !== 1 ||
          roles.length !== 1 ||
          node === employer[0] ||
          node === roles[0] ||
          !/^[\p{Script=Han}]{2,4}$/u.test(value) ||
          /在线|离线|活跃|沟通|招聘|职位|详情|更多|客服|人事|反馈|举报|收藏|返回|投递|未读|已读|送达|状态/.test(
            value,
          )
        )
          return false;
        const nameBox = node.getBoundingClientRect();
        const companyBox = employer[0].getBoundingClientRect();
        const roleBox = roles[0].getBoundingClientRect();
        const sameRow = (box) =>
          Math.abs(
            (box.top + box.bottom) / 2 -
              (companyBox.top + companyBox.bottom) / 2,
          ) <= 12;
        return (
          nameBox.right <= companyBox.left + 4 &&
          roleBox.left >= companyBox.right - 4 &&
          sameRow(nameBox) &&
          sameRow(roleBox)
        );
      };
      const recruiters = header.filter(
        (node) =>
          /^[\p{Script=Han}·]{1,8}(先生|女士)$/u.test(text(node)) ||
          plainNameInRecruiterRow(node),
      );
      count("employerMatchCount", employer.length);
      count("recruiterCount", recruiters.length);
      progress("employer");
      if (employer.length !== 1) continue;
      progress("recruiter");
      if (recruiters.length !== 1) continue;
      progress("header-limit");
      if (
        employer.length === 1 &&
        recruiters.length === 1 &&
        header.length <= 12
      ) {
        const labels = header
          .map((node) => text(node))
          .filter(Boolean)
          .sort();
        if (labels.join(" ").length <= 400)
          return bindConversation(root, editor, labels, probe);
      }
    }
    return null;
  };
  const conversation = () => {
    semanticProbes.length = 0;
    if (!/^\/web\/geek\/chat\/?$/.test(location.pathname)) return null;
    const editors = nodes(document, editorSelector);
    if (editors.length !== 1) return null;
    const editor = editors[0];
    for (
      let root = editor.parentElement, depth = 0;
      root && depth < 12;
      root = root.parentElement, depth++
    ) {
      if (root === document.body || root === document.documentElement) break;
      if (nodes(root, ".user-list, .chat-user-list, .friend-list").length)
        break;
      const semantic = semanticHeader(root, editor, depth);
      if (semantic) return semantic;
      if (request.mode === "diagnose") continue;
      const outsideHistory = (node) =>
        !node.closest(
          ".message-item, .user-list, .chat-user-list, .friend-list",
        );
      const headers = nodes(root, ".title-box, .name-box, .chat-title").filter(
        outsideHistory,
      );
      const cards = [
        ...headers,
        ...nodes(
          root,
          ".chat-job-card, .chat-job-info, .job-card, .job-info",
        ).filter(outsideHistory),
      ];
      const links = nodes(root, "a[href*='/job_detail/']").filter(
        (link) =>
          outsideHistory(link) && cards.some((card) => card.contains(link)),
      );
      if (links.length !== 1 || canonical(links[0].href) !== canonical(job.url))
        continue;
      const employerMatches = headers.some((header) => {
        const fields = nodes(header, ".company-name, .company-text, .company");
        return (fields.length ? fields : [header]).some((field) =>
          companies.includes(normCompany(text(field))),
        );
      });
      if (!employerMatches) continue;
      return bindConversation(
        root,
        editor,
        headers.map((header) => text(header).slice(0, 400)).sort(),
      );
    }
    return null;
  };
  const conversationDiagnostic = () => {
    const editors = nodes(document, editorSelector);
    let activeJobCardCount = 0,
      exactJobLinkCount = 0,
      employerFieldMatchCount = 0;
    for (const editor of editors) {
      for (
        let root = editor.parentElement, depth = 0;
        root && depth < 7;
        root = root.parentElement, depth++
      ) {
        if (
          root === document.body ||
          root === document.documentElement ||
          nodes(root, ".user-list, .chat-user-list, .friend-list").length
        )
          break;
        const outsideHistory = (node) =>
          !node.closest(
            ".message-item, .user-list, .chat-user-list, .friend-list",
          );
        const headers = nodes(
          root,
          ".title-box, .name-box, .chat-title",
        ).filter(outsideHistory);
        const cards = [
          ...new Set([
            ...headers,
            ...nodes(
              root,
              ".chat-job-card, .chat-job-info, .job-card, .job-info",
            ).filter(outsideHistory),
          ]),
        ];
        const links = nodes(root, "a[href*='/job_detail/']").filter(
          (link) =>
            outsideHistory(link) && cards.some((card) => card.contains(link)),
        );
        activeJobCardCount = Math.max(activeJobCardCount, cards.length);
        exactJobLinkCount = Math.max(
          exactJobLinkCount,
          links.filter((link) => canonical(link.href) === canonical(job.url))
            .length,
        );
        employerFieldMatchCount = Math.max(
          employerFieldMatchCount,
          headers.filter((header) => {
            const fields = nodes(
              header,
              ".company-name, .company-text, .company",
            );
            return (fields.length ? fields : [header]).some((field) =>
              companies.includes(normCompany(text(field))),
            );
          }).length,
        );
      }
    }
    return {
      stage: "conversation",
      editorCount: Math.min(editors.length, 20),
      activeJobCardCount: Math.min(activeJobCardCount, 20),
      exactJobLinkCount: Math.min(exactJobLinkCount, 20),
      employerFieldMatchCount: Math.min(employerFieldMatchCount, 20),
      probes: semanticProbes.slice(0, 12),
    };
  };
  const unknownConversation = () => ({
    ...stop("recipient-mismatch"),
    diagnostic: conversationDiagnostic(),
  });
  // A rendered recipient header is not evidence that the chat client is ready.
  // Only inspect visible UI state; do not access its sockets or internal stores.
  const chatReadiness = (current, allowDraft = false) => {
    if (globalThis.navigator?.onLine === false) return "offline";
    if (document.visibilityState === "hidden") return "background";
    if (document.readyState && document.readyState !== "complete")
      return "loading";
    if (
      !enabled(current.editor) ||
      current.editor.getAttribute("aria-readonly") === "true"
    )
      return "editor-unavailable";
    if (!allowDraft && text(current.editor)) return "draft";
    if (current.editor.closest("[aria-busy='true']")) return "loading";
    const notices = nodes(
      document,
      ".dialog-wrap, .dialog-box, .toast, .toast-text, .chat-tip, .chat-notice, .chat-warning, .connect-tip, [role='alert'], [role='status']",
    ).filter(outsideChatHistory);
    for (const notice of notices) {
      const value = text(notice);
      if (!value || value.length > 500) continue;
      if (
        /网络.{0,15}(?:异常|断开|不可用)|连接.{0,15}(?:断开|失败)|已断线|已离线/.test(
          value,
        )
      )
        return "offline";
      if (/正在连接|连接中|正在重连|重新连接中|加载中|正在加载/.test(value))
        return "connecting";
      if (
        /无法发送|不能发送|暂不支持发送|对方回复后.{0,15}(?:发送|沟通)|(?:发送|沟通).{0,15}(?:受限|限制)|(?:账号|帐号).{0,15}(?:其他|其它|别处).{0,10}登录/.test(
          value,
        )
      )
        return "restricted";
    }
    return "ready";
  };
  const outgoing = (root) => {
    const known = nodes(root, ".message-item.item-myself");
    const rows = nodes(root, ".message-item, .message-content").filter(
      (node) => {
        const classes = [node, node.parentElement].flatMap((part) =>
          String(part?.getAttribute("class") || "").split(/\s+/),
        );
        // Require explicit sender classes; position alone cannot identify authors.
        return (
          classes.some((name) =>
            [
              "item-myself",
              "myself",
              "self",
              "mine",
              "from-me",
              "message-right",
              "item-right",
            ].includes(name),
          ) &&
          !classes.some((name) =>
            [
              "item-friend",
              "friend",
              "other",
              "receive",
              "from-them",
              "message-left",
              "item-left",
            ].includes(name),
          )
        );
      },
    );
    const unique = [...new Set([...known, ...rows])];
    return unique.filter(
      (node) => !unique.some((other) => other !== node && other.contains(node)),
    );
  };
  const sent = (item) =>
    !nodes(item, ".message-fail, .send-fail, .retry").length &&
    nodes(item, ".status, .message-status, .read-status").some((node) =>
      /^(已读|未读|已发送|已送达|送达)$/.test(text(node)),
    );
  const messageBody = (item) => {
    const bodies = nodes(
      item,
      ".text, .message-text, .text-content, .bubble-content",
    );
    // Nested wrappers represent one body, not several independent messages.
    const outer = bodies.filter(
      (node) => !bodies.some((other) => other !== node && other.contains(node)),
    );
    return outer.length === 1 ? outer[0] : null;
  };
  const messageReceipt = (item, expected) => {
    const body = messageBody(item);
    const outsideBody = (node) =>
      node !== body &&
      (!body || (!body.contains(node) && !node.contains(body)));
    const explicit = new Set(
      nodes(item, ".status, .message-status, .read-status"),
    );
    const labelNodes = [
      ...new Set([
        ...explicit,
        ...nodes(item, "span, div, em, i, b, small").filter(
          (node) => node.children.length === 0,
        ),
      ]),
    ].filter(
      (node) => node !== body && (explicit.has(node) || outsideBody(node)),
    );
    const labels = labelNodes.flatMap((node) => [
      text(node),
      ...(outsideBody(node)
        ? [
            clean(node.getAttribute("title")),
            clean(node.getAttribute("aria-label")),
          ]
        : []),
    ]);
    const failed =
      Boolean(nodes(item, ".message-fail, .send-fail, .retry").length) ||
      labels.some((value) =>
        /^(?:消息)?(?:发送失败|发送中|未发送|重试|重新发送)(?:[，,：:]?请(?:点击)?重试)?$/.test(
          value,
        ),
      );
    // Positive delivery still requires visible text, never an attribute alone.
    const visibleLabels = labelNodes.map(text);
    const successLabels = visibleLabels.filter((value) =>
      /^(已读|未读|已发送|已送达|送达|\[(?:已读|已送达|送达)\]|【(?:已读|已送达|送达)】)$/.test(
        value,
      ),
    );
    // Some bubbles have no known text class, or wrap the status in that class.
    // Accept only the exact entire message plus a separately rendered status at
    // one boundary. Never strip arbitrary text, timestamps or quoted messages.
    const whole = text(item);
    const wholeMatches =
      Boolean(expected) &&
      successLabels.some((label) =>
        [
          expected + label,
          label + expected,
          `${expected} ${label}`,
          `${label} ${expected}`,
        ].includes(whole),
      );
    const bodyText = wholeMatches
      ? expected
      : body
        ? text(body)
        : whole === expected
          ? expected
          : "";
    const independentStatus =
      Boolean(body) &&
      text(body) === expected &&
      labelNodes.some(
        (node) => outsideBody(node) && successLabels.includes(text(node)),
      );
    return {
      body: bodyText,
      acknowledged: !failed && (wholeMatches || independentStatus),
      failed,
    };
  };
  if (request.mode === "diagnose") {
    conversation();
    const headers = [...diagnosticHeaders.values()];
    return headers.length === 1
      ? { outcome: "observed", headerEvidence: headers[0] }
      : { outcome: headers.length > 1 ? "ambiguous" : "not-found" };
  }
  if (request.mode === "inspect") {
    const control = contactControl();
    if (control)
      return {
        ok: true,
        page: "detail",
        existingContact: text(control) === "继续沟通",
      };
    const current = conversation();
    if (!current && canonical(location.href) === canonical(job.url)) {
      const controls = nodes(document, "a, button, div, span").filter((node) =>
        /^(立即沟通|继续沟通)$/.test(text(node)),
      );
      return {
        ...stop("page-unrecognized"),
        diagnostic: {
          stage: "detail-entry",
          controlCount: Math.min(controls.length, 20),
          tags: controls
            .slice(0, 5)
            .map((node) =>
              ["a", "button", "div", "span"].includes(
                node.tagName?.toLowerCase(),
              )
                ? node.tagName.toLowerCase()
                : "other",
            ),
          knownControlCount: Math.min(
            nodes(
              document,
              ".btn-startchat, .op-btn-chat, [role='button']",
            ).filter((node) => /^(立即沟通|继续沟通)$/.test(text(node))).length,
            20,
          ),
          titleCount: Math.min(
            nodes(
              document,
              ".job-banner .job-name, .job-detail .job-name, h1",
            ).filter((node) => text(node) === clean(job.title)).length,
            20,
          ),
        },
      };
    }
    return current
      ? {
          ok: true,
          page: "conversation",
          conversationBinding: current.binding,
          outgoingCount: outgoing(current.root).length,
        }
      : unknownConversation();
  }
  if (request.mode === "contact") {
    if (!fullJobMatches()) return stop("page-unrecognized");
    const control = contactControl();
    if (!control) return stop("page-unrecognized");
    const existingContact = text(control) === "继续沟通";
    if (existingContact !== Boolean(request.expectedExisting))
      return stop("recipient-mismatch");
    if (!(await authorize())) return stop("cancelled");
    if (
      blocked() ||
      contactControl() !== control ||
      !fullJobMatches() ||
      (text(control) === "继续沟通") !== existingContact
    )
      return stop("recipient-mismatch");
    control.click();
    let contactConfirmed = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      await sleep(250);
      const block = blocked();
      if (block) return stop(block);
      const dialogs = nodes(
        document,
        ".dialog-wrap, .dialog-box, .toast, .toast-text, .chat-tip",
      );
      for (const dialog of dialogs) {
        const value = text(dialog);
        if (value.length > 500) continue;
        if (
          /招呼已发送|打招呼成功|已向.{1,60}发送|沟通已发送|沟通成功/.test(
            value,
          )
        )
          contactConfirmed = true;
        const continues = nodes(dialog, "a, button").filter(
          (node) => enabled(node) && text(node) === "继续沟通",
        );
        if (continues.length === 1 && (contactConfirmed || existingContact)) {
          if (!(await authorize()) || blocked()) return stop("cancelled");
          continues[0].click();
          return { ok: true, clicked: true, existingContact, contactConfirmed };
        }
      }
      if (conversation())
        return { ok: true, clicked: true, existingContact, contactConfirmed };
      // Some details remain open after the native greeting and replace the
      // original button with Continue. This second click only opens that exact
      // contact; it is never another greeting and never confirms delivery alone.
      const next = !existingContact ? contactControl() : null;
      if (next && text(next) === "继续沟通") {
        if (!fullJobMatches()) return stop("recipient-mismatch");
        if (!(await authorize())) return stop("cancelled");
        const nextBlock = blocked();
        if (nextBlock) return stop(nextBlock);
        if (
          contactControl() !== next ||
          text(next) !== "继续沟通" ||
          !fullJobMatches()
        )
          return stop("recipient-mismatch");
        next.click();
        return { ok: true, clicked: true, existingContact, contactConfirmed };
      }
    }
    return { ok: true, clicked: true, existingContact, contactConfirmed };
  }
  const current = conversation();
  if (!current) return unknownConversation();
  if (request.mode === "ready") {
    let stable = 0;
    let code = "loading";
    for (let attempt = 0; attempt < 20; attempt++) {
      const block = blocked();
      if (block) return stop(block);
      const live = conversation();
      if (
        !live ||
        live.editor !== current.editor ||
        live.binding !== current.binding
      )
        return unknownConversation();
      code = chatReadiness(live);
      if (
        ["offline", "restricted", "draft", "editor-unavailable"].includes(code)
      )
        break;
      stable = code === "ready" ? stable + 1 : 0;
      // Five seconds of the same ready, foreground conversation before typing.
      if (stable >= 11) return { ok: true };
      await sleep(500);
    }
    return {
      ...stop("page-unrecognized"),
      diagnostic: {
        stage: "chat-ready",
        code: code === "ready" ? "unstable" : code,
        stableChecks: stable,
      },
    };
  }
  if (request.mode === "message") {
    if (
      typeof request.text !== "string" ||
      !request.text.trim() ||
      request.text.length > 2000
    )
      return stop("page-unrecognized");
    if (text(current.editor)) return stop("page-unrecognized"); // never overwrite a user's draft
    const readiness = chatReadiness(current);
    if (readiness !== "ready")
      return {
        ...stop("page-unrecognized"),
        diagnostic: { stage: "chat-ready", code: readiness, stableChecks: 0 },
      };
    const buttons = nodes(current.root, "button.btn-send, a.btn-send");
    if (buttons.length !== 1) return stop("page-unrecognized");
    const before = new Set(outgoing(current.root));
    const expected = clean(request.text);
    const previousMatches = [...before].filter(
      (item) => messageReceipt(item, expected).body === expected,
    ).length;
    current.editor.focus();
    // Normal editable input only; no trusted-event hooks or security bypasses.
    current.editor.textContent = request.text;
    current.editor.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: request.text,
      }),
    );
    await sleep(300);
    if (!(await authorize())) return stop("cancelled");
    if (
      blocked() ||
      conversation()?.editor !== current.editor ||
      // Our exact draft is now present; all other readiness checks still apply.
      chatReadiness(current, true) !== "ready" ||
      text(current.editor) !== clean(request.text) ||
      !enabled(buttons[0])
    )
      return stop("send-unconfirmed");
    buttons[0].click();
    let diagnostic;
    for (let attempt = 0; attempt < 75; attempt++) {
      await sleep(400);
      const block = blocked();
      if (block) return stop(block);
      if (conversation()?.editor !== current.editor)
        return stop("recipient-mismatch");
      const after = outgoing(current.root);
      const matching = after.filter(
        (item) => messageReceipt(item, expected).body === expected,
      );
      const added = matching.filter((item) => !before.has(item));
      const acknowledged = added.filter(
        (item) => messageReceipt(item, expected).acknowledged,
      );
      const bounded = (count) => Math.min(1000, count);
      diagnostic = {
        stage: "message-receipt",
        beforeCount: bounded(before.size),
        afterCount: bounded(after.length),
        messageRowCount: bounded(
          nodes(current.root, ".message-item, .message-content").length,
        ),
        matchingCount: bounded(matching.length),
        newMatchingCount: bounded(added.length),
        acknowledgedCount: bounded(acknowledged.length),
        failedCount: bounded(
          added.filter((item) => messageReceipt(item, expected).failed).length,
        ),
        editorEmpty: !text(current.editor),
      };
      if (
        matching.length === previousMatches + 1 &&
        added.length === 1 &&
        acknowledged.length === 1 &&
        after.at(-1) === added[0] &&
        diagnostic.editorEmpty
      )
        return { ok: true, evidence: "new-message" };
    }
    return { ...stop("send-unconfirmed"), diagnostic };
  }
  if (request.mode === "attachment") {
    const file = request.attachment;
    if (
      !file ||
      typeof file.name !== "string" ||
      !/^[^/\\\x00-\x1f]+\.(docx|pdf)$/i.test(file.name) ||
      typeof file.base64 !== "string" ||
      file.base64.length > 14_000_000
    )
      return stop("page-unrecognized");
    // Only upload the frozen local bytes; never select an existing resume by
    // its name alone or send the first item in a platform selection dialog.
    const inputs = [
      ...current.root.querySelectorAll("input[type=file]"),
    ].filter((input) => !input.disabled);
    if (inputs.length !== 1) return stop("page-unrecognized");
    const before = outgoing(current.root).length;
    const bytes = Uint8Array.from(atob(file.base64), (value) =>
      value.charCodeAt(0),
    );
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    if (hash !== file.sha256) return stop("page-unrecognized");
    if (blocked() || conversation()?.editor !== current.editor)
      return stop("recipient-mismatch");
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], file.name, { type: file.mimeType }));
    if (!(await authorize())) return stop("cancelled");
    if (blocked() || conversation()?.editor !== current.editor)
      return stop("recipient-mismatch");
    inputs[0].files = transfer.files;
    inputs[0].dispatchEvent(new Event("change", { bubbles: true }));
    // Upload can itself submit on some layouts, so this step never clicks a
    // speculative second send button. Unsupported layouts remain unconfirmed.
    for (let attempt = 0; attempt < 25; attempt++) {
      await sleep(400);
      if (blocked() || conversation()?.editor !== current.editor)
        return stop("recipient-mismatch");
      const after = outgoing(current.root);
      const added = after.slice(before);
      if (
        added.some(
          (item) =>
            text(item).includes(file.name) &&
            /附件简历请求已发送|等待对方同意/.test(text(item)),
        )
      )
        return { ok: false, reason: "attachment-pending" };
      if (
        after.length === before + 1 &&
        text(after[before]).includes(file.name) &&
        sent(after[before])
      )
        return { ok: true, evidence: "new-attachment" };
    }
    return stop("send-unconfirmed");
  }
  return stop("page-unrecognized");
}

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
  const readJob = request.readerKey ? globalThis[request.readerKey] : null;
  if (request.readerKey) delete globalThis[request.readerKey];
  const fullJobMatches = () => {
    if (typeof readJob !== "function") return false;
    const found = readJob()?.jobs?.[0];
    if (
      !found?.detail ||
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
  // The current editor's ancestors must contain this exact job link AND a
  // matching employer in the conversation header. A sidebar match is not enough.
  const conversation = () => {
    if (!/^\/web\/geek\/chat\/?$/.test(location.pathname)) return null;
    const editors = nodes(
      document,
      ".chat-editor .chat-input[contenteditable='true'], div.chat-input[contenteditable='true']",
    );
    if (editors.length !== 1) return null;
    const editor = editors[0];
    for (
      let root = editor.parentElement, depth = 0;
      root && depth < 7;
      root = root.parentElement, depth++
    ) {
      if (root === document.body || root === document.documentElement) break;
      if (nodes(root, ".user-list, .chat-user-list, .friend-list").length)
        break;
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
      return { root, editor };
    }
    return null;
  };
  const outgoing = (root) => nodes(root, ".message-item.item-myself");
  const sent = (item) =>
    !nodes(item, ".message-fail, .send-fail, .retry").length &&
    nodes(item, ".status, .message-status, .read-status").some((node) =>
      /^(已读|未读|已发送|已送达)$/.test(text(node)),
    );
  const messageText = (item) => {
    const bodies = nodes(item, ".text, .message-text, .text-content");
    return bodies.length === 1 ? text(bodies[0]) : "";
  };
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
          outgoingCount: outgoing(current.root).length,
        }
      : stop("recipient-mismatch");
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
    }
    return { ok: true, clicked: true, existingContact, contactConfirmed };
  }
  const current = conversation();
  if (!current) return stop("recipient-mismatch");
  if (request.mode === "message") {
    if (
      typeof request.text !== "string" ||
      !request.text.trim() ||
      request.text.length > 2000
    )
      return stop("page-unrecognized");
    if (text(current.editor)) return stop("page-unrecognized"); // never overwrite a user's draft
    const buttons = nodes(current.root, "button.btn-send, a.btn-send");
    if (buttons.length !== 1) return stop("page-unrecognized");
    const before = outgoing(current.root).length;
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
      text(current.editor) !== clean(request.text) ||
      !enabled(buttons[0])
    )
      return stop("send-unconfirmed");
    buttons[0].click();
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(400);
      if (blocked() || conversation()?.editor !== current.editor)
        return stop("recipient-mismatch");
      const after = outgoing(current.root);
      if (
        after.length === before + 1 &&
        messageText(after[before]) === clean(request.text) &&
        sent(after[before])
      )
        return { ok: true, evidence: "new-message" };
    }
    return stop("send-unconfirmed");
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

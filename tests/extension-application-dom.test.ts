import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";

// Synthetic DOM contracts; these do not prove the current BOSS layout works.
const pageScript =
  readFileSync(
    new URL("../apps/browser-extension/application-page.mjs", import.meta.url),
    "utf8",
  ).replace("export async function", "async function") +
  "\napplicationPageStep(request)";
const runnerScript = readFileSync(
  new URL("../apps/browser-extension/application.mjs", import.meta.url),
  "utf8",
)
  .replace(/^import .*;\r?\n/gm, "")
  .replaceAll("export function", "function")
  .replaceAll("export async function", "async function");
const job = {
  url: "https://www.zhipin.com/job_detail/example.html",
  title: "AI 工程师",
  company: "示例公司",
  companyAliases: [],
  description: "完整岗位职责",
  salaryMin: 20000,
  salaryMax: 30000,
  location: "上海",
};
test("unresolved browser injections time out once and late completion cannot restart them", async () => {
  let expire: (() => void) | undefined;
  let release: (value: any) => void = () => {};
  let cleared = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const result = runInNewContext(
    runnerScript + "\nboundedApplicationScript(pending)",
    {
      pending,
      setTimeout: (callback: () => void) => {
        expire = callback;
        return 1;
      },
      clearTimeout: () => {
        cleared++;
      },
    },
  );
  expire!();
  await assert.rejects(result, /page-unrecognized/);
  release([{ result: { ok: true } }]);
  await Promise.resolve();
  assert.equal(cleared, 1);
});
test("new Chrome tabs may have a pending URL before commit; wait without injecting or rejecting", () => {
  const run = (tab: any) =>
    runInNewContext(
      runnerScript + "\napplicationNavigationState(tab, expected)",
      { URL, tab, expected: job.url },
    );
  assert.equal(run({ status: "loading", pendingUrl: job.url }), "wait");
  assert.equal(
    run({ status: "loading", url: "about:blank", pendingUrl: job.url }),
    "wait",
  );
  assert.equal(run({ status: "loading", url: job.url }), "wait");
  assert.equal(run({ status: "complete", url: job.url }), "ready");
  assert.equal(
    run({ status: "loading", pendingUrl: "https://evil.example/" }),
    "reject",
  );
  assert.equal(
    run({
      status: "loading",
      url: "https://www.zhipin.com/job_detail/other.html",
    }),
    "reject",
  );
  assert.equal(run({ status: "complete", url: "about:blank" }), "reject");
});
function element(
  value = "",
  selectors: Record<string, any[]> = {},
  hidden = false,
): any {
  return {
    innerText: value,
    children: [],
    parentElement: null,
    disabled: false,
    getClientRects: () => (hidden ? [] : [{}]),
    getAttribute: () => null,
    classList: { contains: () => false },
    closest: () => null,
    contains: (child: any) =>
      Object.values(selectors).some((values) => values.includes(child)),
    querySelectorAll: (selector: string) => selectors[selector] ?? [],
    focus() {},
    click() {},
    dispatchEvent() {},
    get textContent() {
      return this.innerText;
    },
    set textContent(text: string) {
      this.innerText = text;
    },
  };
}
function chatFixture() {
  const rows: any[] = [];
  const editor = element();
  const link = element("当前岗位");
  link.href = job.url;
  const header = element("示例公司", { "a[href*='/job_detail/']": [link] });
  const button = element("发送");
  const input = element();
  input.type = "file";
  const root = element("", {
    "a[href*='/job_detail/']": [link],
    ".title-box, .name-box, .chat-title": [header],
    ".message-item.item-myself": rows,
    "button.btn-send, a.btn-send": [button],
    "input[type=file]": [input],
  });
  const body = element();
  root.parentElement = body;
  editor.parentElement = root;
  const document = element("", {
    ".chat-editor .chat-input[contenteditable='true'], div.chat-input[contenteditable='true'], #chat-input[contenteditable='true']":
      [editor],
  });
  document.body = body;
  document.documentElement = element();
  return { rows, editor, link, header, button, input, root, document };
}
function semanticChatFixture() {
  const f = chatFixture();
  const selector = "a, button, span, div, p, strong, em, h1, h2, h3, b, label";
  const title = element(job.title),
    salary = element("20-30K"),
    city = element(job.location);
  const employer = element(job.company),
    recruiter = element("王先生"),
    view = element("查看职位");
  const fields = [title, salary, city, view],
    links: any[] = [],
    headerLinks: any[] = [];
  const card = element(`${job.title} 20-30K 上海 查看职位`, {
    [selector]: fields,
    "a[href*='/job_detail/']": links,
  });
  const rect = (left: number, top: number, right: number, bottom: number) => ({
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  });
  f.editor.getBoundingClientRect = () => rect(400, 500, 1000, 650);
  f.root.getBoundingClientRect = () => rect(380, 100, 1020, 680);
  card.getBoundingClientRect = () => rect(400, 180, 1000, 230);
  employer.getBoundingClientRect = () => rect(440, 140, 610, 170);
  recruiter.getBoundingClientRect = () => rect(400, 140, 440, 170);
  card.parentElement = f.root;
  employer.parentElement = f.root;
  recruiter.parentElement = f.root;
  for (const field of fields) {
    field.parentElement = card;
    field.getBoundingClientRect = () => rect(410, 190, 580, 215);
  }
  const oldQuery = f.root.querySelectorAll;
  const allFields = [employer, recruiter, ...fields];
  f.root.querySelectorAll = (query: string) =>
    query === selector
      ? allFields
      : query === "a[href*='/job_detail/']"
        ? headerLinks
        : query === ".title-box, .name-box, .chat-title"
          ? []
          : oldQuery(query);
  return {
    ...f,
    title,
    salary,
    city,
    employer,
    recruiter,
    view,
    card,
    allFields,
    links,
    headerLinks,
  };
}
function row(value: string, sent = true) {
  return element(value, {
    ".text, .message-text, .text-content, .bubble-content": [element(value)],
    ".status, .message-status, .read-status": sent ? [element("已发送")] : [],
  });
}
async function runPage(
  document: any,
  request: any,
  path = "/web/geek/chat",
  additions: any = {},
) {
  return runInNewContext(pageScript, {
    document,
    __jobAssistantReader00000000000000000000000000000000: () => ({
      jobs: [{ ...job, detail: true, salaryText: "20-30K" }],
    }),
    request: {
      job,
      readerKey: "__jobAssistantReader00000000000000000000000000000000",
      authorization: { nonce: "fixture", actionId: "fixture" },
      ...request,
    },
    chrome: {
      runtime: {
        sendMessage: async () => ({
          allowed: true,
          expiresAt: Date.now() + 1500,
        }),
      },
    },
    location: {
      origin: "https://www.zhipin.com",
      pathname: path,
      href: "https://www.zhipin.com" + path,
    },
    URL,
    Uint8Array,
    atob,
    crypto: webcrypto,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    setTimeout: (callback: () => void) => {
      callback();
      return 1;
    },
    InputEvent: class {},
    Event: class {},
    ...additions,
  });
}
test("conversation requires this exact job and employer inside the current editor pane", async () => {
  const f = chatFixture();
  assert.equal(
    (await runPage(f.document, { mode: "inspect" })).page,
    "conversation",
  );
  f.link.href = "https://www.zhipin.com/job_detail/other.html";
  assert.equal((await runPage(f.document, { mode: "inspect" })).ok, false);
  f.link.href = job.url;
  f.header.innerText = "其他公司";
  assert.equal((await runPage(f.document, { mode: "inspect" })).ok, false);
  f.header.innerText = job.company;
  f.link.closest = () => element("旧消息");
  assert.equal((await runPage(f.document, { mode: "inspect" })).ok, false);
  f.link.closest = () => null;
  f.header.innerText = "其他公司和示例公司";
  assert.equal((await runPage(f.document, { mode: "inspect" })).ok, false);
  f.header.innerText = job.company;
  const oldQuery = f.root.querySelectorAll;
  f.root.querySelectorAll = (selector: string) =>
    selector === ".user-list, .chat-user-list, .friend-list"
      ? [element()]
      : oldQuery(selector);
  assert.equal((await runPage(f.document, { mode: "inspect" })).ok, false);
});
test("button job bar requires verified navigation and all visible identity fields", async () => {
  const f = semanticChatFixture();
  const request = { mode: "inspect", conversationOrigin: job.url };
  assert.equal((await runPage(f.document, request)).page, "conversation");
  assert.equal((await runPage(f.document, { mode: "inspect" })).ok, false);
  assert.equal(
    (
      await runPage(f.document, {
        ...request,
        conversationOrigin: job.url + "wrong",
      })
    ).ok,
    false,
  );
  for (const field of [f.title, f.salary, f.city, f.employer]) {
    const original = field.innerText;
    field.innerText = "其他值";
    assert.equal((await runPage(f.document, request)).ok, false);
    field.innerText = original;
  }
  const wrongLink = element();
  wrongLink.href = "https://www.zhipin.com/job_detail/other.html";
  f.links.push(wrongLink);
  assert.equal((await runPage(f.document, request)).ok, false);
});

test("chat salary accepts the actual 23-29K·13薪 format but rejects different amounts or stated months", async () => {
  const f = semanticChatFixture();
  const request = {
    mode: "inspect",
    conversationOrigin: job.url,
    job: { ...job, salaryMin: 23000, salaryMax: 29000, salaryMonths: 13 },
  };
  for (const salary of [
    "23-29K·13薪",
    "23 - 29k · 13 薪",
    "23–29K•13薪",
    "23-29K",
  ]) {
    f.salary.innerText = salary;
    assert.equal(
      (await runPage(f.document, request)).page,
      "conversation",
      salary,
    );
  }
  for (const salary of [
    "23-29K·14薪",
    "23-29K·13.5薪",
    "22-29K·13薪",
    "23-30K·13薪",
    "23-29K/月·13薪",
    "23-29K·13薪 其他岗位",
    "2\uE123-29K·13薪",
  ]) {
    f.salary.innerText = salary;
    const result = await runPage(f.document, request);
    assert.equal(result.ok, false, salary);
    assert.equal(result.diagnostic.probes.at(-1).result, "salary");
  }
  f.salary.innerText = "23-29K·13.5薪";
  assert.equal(
    (
      await runPage(f.document, {
        ...request,
        job: { ...request.job, salaryMonths: 13.5 },
      })
    ).page,
    "conversation",
  );
});

test("semantic header rejects sidebar geometry, history controls and duplicate job bars", async () => {
  for (const modify of [
    (f: any) => {
      f.root.getBoundingClientRect = () => ({
        left: 0,
        top: 100,
        right: 1020,
        bottom: 680,
        width: 1020,
        height: 580,
      });
    },
    (f: any) => {
      f.view.closest = () => element("旧消息");
    },
    (f: any) => {
      f.allFields.push(element("查看职位"));
    },
  ]) {
    const f = semanticChatFixture();
    modify(f);
    assert.equal(
      (
        await runPage(f.document, {
          mode: "inspect",
          conversationOrigin: job.url,
        })
      ).ok,
      false,
    );
  }
});

test("semantic recipient is rechecked after authorization before sending", async () => {
  const f = semanticChatFixture();
  let clicks = 0;
  const binding = (
    await runPage(f.document, { mode: "inspect", conversationOrigin: job.url })
  ).conversationBinding;
  f.button.click = () => clicks++;
  const result = await runPage(
    f.document,
    {
      mode: "message",
      text: "您好",
      conversationOrigin: job.url,
      conversationBinding: binding,
    },
    "/web/geek/chat",
    {
      chrome: {
        runtime: {
          sendMessage: async () => {
            f.recruiter.innerText = "李先生";
            return { allowed: true, expiresAt: Date.now() + 1500 };
          },
        },
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(clicks, 0);
});

test("semantic header rejects conflicting links outside the job card and changed contacts between steps", async () => {
  const f = semanticChatFixture();
  const request = { mode: "inspect", conversationOrigin: job.url };
  const binding = (await runPage(f.document, request)).conversationBinding;
  assert.equal(typeof binding, "string");
  assert.equal(
    (
      await runPage(f.document, {
        mode: "message",
        text: "您好",
        conversationOrigin: job.url,
      })
    ).ok,
    false,
  );
  const wrongLink = element("其他岗位");
  wrongLink.href = "https://www.zhipin.com/job_detail/other.html";
  wrongLink.getBoundingClientRect = () => ({ top: 140, bottom: 170 });
  f.headerLinks.push(wrongLink);
  assert.equal((await runPage(f.document, request)).ok, false);
  f.headerLinks.length = 0;
  f.recruiter.innerText = "李先生";
  assert.equal(
    (await runPage(f.document, { ...request, conversationBinding: binding }))
      .ok,
    false,
  );
});

test("semantic header cannot bind a company and status label without a recruiter name", async () => {
  const f = semanticChatFixture();
  for (const label of ["在线", "活跃", "已沟通", "招聘者", ""]) {
    f.recruiter.innerText = label;
    assert.equal(
      (
        await runPage(f.document, {
          mode: "inspect",
          conversationOrigin: job.url,
        })
      ).ok,
      false,
    );
  }
});

test("native contact must match the frozen URL and existing-contact state before click", async () => {
  let clicks = 0;
  const control = element("继续沟通");
  control.click = () => clicks++;
  const banner = element(job.title, {
    "a, button, .btn-startchat, .op-btn-chat, [role='button']": [control],
  });
  const document = element("", { ".job-banner": [banner] });
  assert.equal(
    (
      await runPage(
        document,
        { mode: "contact", expectedExisting: false },
        "/job_detail/example.html",
      )
    ).ok,
    false,
  );
  assert.equal(clicks, 0);
  assert.equal(
    (
      await runPage(
        document,
        { mode: "contact", expectedExisting: true },
        "/job_detail/other.html",
      )
    ).ok,
    false,
  );
  assert.equal(clicks, 0);
  assert.equal(
    (
      await runPage(
        document,
        { mode: "contact", expectedExisting: true },
        "/job_detail/example.html",
      )
    ).existingContact,
    true,
  );
  assert.equal(clicks, 1);
});
test("a new greeting that stays on the detail opens its changed Continue control exactly once", async () => {
  for (const change of [
    "continue",
    "unchanged",
    "job-changed",
    "closed",
    "revoked",
  ]) {
    let clicks = 0;
    let permissions = 0;
    let live = { ...job, detail: true, status: "active", salaryText: "20-30K" };
    const control = element("立即沟通");
    control.click = () => {
      clicks++;
      if (change !== "unchanged") control.innerText = "继续沟通";
      if (change === "job-changed")
        live = { ...live, description: "另一岗位职责" };
      if (change === "closed") live = { ...live, status: "closed" };
    };
    const banner = element(job.title, {
      "a, button, .btn-startchat, .op-btn-chat, [role='button']": [control],
    });
    const document = element("", { ".job-banner": [banner] });
    const result = await runPage(
      document,
      { mode: "contact", expectedExisting: false },
      "/job_detail/example.html",
      {
        __jobAssistantReader00000000000000000000000000000000: () => ({
          jobs: [live],
        }),
        chrome: {
          runtime: {
            sendMessage: async () => ({
              allowed: !(change === "revoked" && ++permissions > 1),
              expiresAt: Date.now() + 1500,
            }),
          },
        },
      },
    );
    assert.equal(clicks, change === "continue" ? 2 : 1, change);
    if (change === "continue") {
      assert.equal(result.ok, true);
      assert.equal(result.contactConfirmed, false); // Continue is not a delivery receipt.
    }
    if (["job-changed", "closed", "revoked"].includes(change))
      assert.equal(result.ok, false);
  }
});

test("composer clearing alone is unknown; only one new sent message confirms, and drafts are preserved", async () => {
  const f = chatFixture();
  let clicks = 0;
  f.button.click = () => {
    clicks++;
    f.editor.innerText = "";
  };
  assert.equal(
    (await runPage(f.document, { mode: "message", text: "您好" })).reason,
    "send-unconfirmed",
  );
  assert.equal(clicks, 1);
  f.editor.innerText = "用户草稿";
  assert.equal(
    (await runPage(f.document, { mode: "message", text: "新话术" })).ok,
    false,
  );
  assert.equal(f.editor.innerText, "用户草稿");
  assert.equal(clicks, 1);
  f.editor.innerText = "";
  f.button.click = () => {
    clicks++;
    f.rows.push(row("您好"));
    f.editor.innerText = "";
  };
  assert.equal(
    (await runPage(f.document, { mode: "message", text: "您好" })).evidence,
    "new-message",
  );
  assert.equal(clicks, 2);
});
test("contact rechecks the full live job after authorization, before any click", async () => {
  let clicks = 0;
  const control = element("立即沟通");
  control.click = () => clicks++;
  const banner = element(job.title, {
    "a, button, .btn-startchat, .op-btn-chat, [role='button']": [control],
  });
  const document = element("", { ".job-banner": [banner] });
  let live = { ...job, detail: true, salaryText: "20-30K" };
  const result = await runPage(
    document,
    { mode: "contact", expectedExisting: false },
    "/job_detail/example.html",
    {
      __jobAssistantReader00000000000000000000000000000000: () => ({
        jobs: [live],
      }),
      chrome: {
        runtime: {
          sendMessage: async () => {
            live = { ...live, description: "已变更的职责" };
            return { allowed: true, expiresAt: Date.now() + 1500 };
          },
        },
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(clicks, 0);
});
test("receipt accepts nested text and sibling delivery labels while unrelated history is removed", async () => {
  const f = chatFixture();
  const child = element("第一行 第二行");
  const body = element("第一行\n第二行", { span: [child] });
  const status = element("送达");
  const own = element("第一行\n第二行 送达", {
    ".text, .message-text, .text-content, .bubble-content": [body, child],
    "span, div, em, i, b, small": [child, status],
  });
  f.rows.push(row("更早的历史消息"));
  f.button.click = () => {
    f.rows.splice(0, f.rows.length, own);
    f.editor.innerText = "";
  };
  assert.equal(
    (await runPage(f.document, { mode: "message", text: "第一行\n第二行" }))
      .evidence,
    "new-message",
  );
});

test("whole-bubble matching accepts a separately rendered boundary receipt without a text class", async () => {
  for (const placement of ["after", "before", "no-space", "nested-status"]) {
    const f = chatFixture();
    const expected = "目前状态：离职\n平均月薪是18350元";
    const normalized = expected.replace(/\s+/g, " ");
    const label = element("送达");
    const value =
      placement === "before"
        ? `送达 ${normalized}`
        : placement === "no-space"
          ? `${normalized}送达`
          : `${normalized} 送达`;
    const body = element(value, { span: [label] });
    const sent = element(value, {
      ".status, .message-status, .read-status": [label],
      ".text, .message-text, .text-content, .bubble-content":
        placement === "nested-status" ? [body] : [],
    });
    f.button.click = () => {
      f.rows.push(sent);
      f.editor.innerText = "";
    };
    assert.equal(
      (await runPage(f.document, { mode: "message", text: expected })).evidence,
      "new-message",
      placement,
    );
  }
});

test("boundary receipt cannot be inferred from body text alone, partial quotes, hidden labels or failures", async () => {
  for (const example of [
    { value: "您好 送达", expected: "您好 送达" },
    { value: "引用：您好 送达", expected: "您好" },
    { value: "您好 已修改 送达", expected: "您好" },
    { value: "您好 送达", expected: "您好", hidden: true },
    { value: "您好 送达", expected: "您好", failed: true },
  ]) {
    const f = chatFixture();
    f.button.click = () => {
      f.rows.push(
        element(example.value, {
          ".status, .message-status, .read-status": [
            element("送达", {}, example.hidden),
          ],
          ".message-fail, .send-fail, .retry": example.failed
            ? [element("失败")]
            : [],
        }),
      );
      f.editor.innerText = "";
    };
    assert.equal(
      (await runPage(f.document, { mode: "message", text: example.expected }))
        .reason,
      "send-unconfirmed",
    );
  }
});

test("message-content rows require an explicit unambiguous self class, never right-hand geometry", async () => {
  for (const sender of [
    "item-myself",
    "item-friend",
    "item-myself item-friend",
    "",
  ]) {
    const f = chatFixture();
    const contents: any[] = [];
    const oldQuery = f.root.querySelectorAll;
    f.root.querySelectorAll = (selector: string) =>
      selector === ".message-item, .message-content"
        ? contents
        : oldQuery(selector);
    const own = row("您好");
    own.parentElement = element();
    own.parentElement.getAttribute = (name: string) =>
      name === "class" ? sender : null;
    own.getBoundingClientRect = () => ({ left: 800, right: 1000 });
    f.button.click = () => {
      contents.push(own);
      f.editor.innerText = "";
    };
    const result = await runPage(f.document, { mode: "message", text: "您好" });
    assert.equal(result.ok, sender === "item-myself", sender);
  }
});

test("receipt ignores old/remounted messages, duplicate new copies, incoming text and statuses inside the body", async () => {
  for (const kind of [
    "old",
    "remounted",
    "duplicate",
    "incoming",
    "inside-body",
    "hidden",
    "failed",
    "draft-remains",
  ]) {
    const f = chatFixture();
    const previous = row("您好");
    if (["old", "remounted"].includes(kind)) f.rows.push(previous);
    let clicks = 0;
    f.button.click = () => {
      clicks++;
      f.editor.innerText = kind === "draft-remains" ? "您好" : "";
      if (kind === "old" || kind === "incoming") return;
      if (kind === "remounted") {
        f.rows.splice(0, 1, row("您好"));
        return;
      }
      if (kind === "duplicate") {
        f.rows.push(row("您好"), row("您好"));
        return;
      }
      const label = element("送达", {}, kind === "hidden");
      const body = element(
        "您好",
        kind === "inside-body" ? { span: [label] } : {},
      );
      f.rows.push(
        element("您好 送达", {
          ".text, .message-text, .text-content, .bubble-content": [body],
          "span, div, em, i, b, small": [label],
          ".message-fail, .send-fail, .retry":
            kind === "failed" ? [element("发送失败")] : [],
        }),
      );
    };
    const result = await runPage(f.document, { mode: "message", text: "您好" });
    assert.equal(result.reason, "send-unconfirmed", kind);
    assert.equal(clicks, 1);
    assert.equal(result.diagnostic.stage, "message-receipt");
    assert.ok(!JSON.stringify(result.diagnostic).includes("您好"));
  }
});
test("an unacknowledged or different new message is never confirmation", async () => {
  for (const outgoing of [row("您好", false), row("其他话术")]) {
    const f = chatFixture();
    f.button.click = () => {
      f.rows.push(outgoing);
      f.editor.innerText = "";
    };
    assert.equal(
      (await runPage(f.document, { mode: "message", text: "您好" })).ok,
      false,
    );
  }
});
test("denied or expired permission immediately before sending prevents clicks", async () => {
  for (const permit of [
    { allowed: false },
    { allowed: true, expiresAt: Date.now() - 1 },
  ]) {
    const f = chatFixture();
    let clicks = 0;
    f.button.click = () => clicks++;
    const result = await runPage(
      f.document,
      { mode: "message", text: "您好" },
      "/web/geek/chat",
      {
        chrome: { runtime: { sendMessage: async () => permit } },
      },
    );
    assert.equal(result.reason, "cancelled");
    assert.equal(clicks, 0);
  }
});
test("attachment requires matching local bytes and records recipient acceptance separately", async () => {
  const f = chatFixture();
  let changes = 0;
  const bytes = Buffer.from("fixture attachment");
  const sha256 = Buffer.from(
    await webcrypto.subtle.digest("SHA-256", bytes),
  ).toString("hex");
  const attachment = {
    name: "resume.pdf",
    base64: bytes.toString("base64"),
    sha256,
    mimeType: "application/pdf",
  };
  const additions = {
    DataTransfer: class {
      files: any[] = [];
      items = { add: (file: any) => this.files.push(file) };
    },
    File: class {
      constructor(
        public bytes: any[],
        public name: string,
      ) {}
    },
  };
  f.input.dispatchEvent = () => {
    changes++;
    f.rows.push(row("resume.pdf 等待对方同意"));
  };
  assert.equal(
    (
      await runPage(
        f.document,
        {
          mode: "attachment",
          attachment: { ...attachment, sha256: "0".repeat(64) },
        },
        "/web/geek/chat",
        additions,
      )
    ).ok,
    false,
  );
  assert.equal(changes, 0);
  assert.equal(
    (
      await runPage(
        f.document,
        { mode: "attachment", attachment },
        "/web/geek/chat",
        additions,
      )
    ).reason,
    "attachment-pending",
  );
  assert.equal(changes, 1);
});
function runnerFixture(
  options: {
    wrongJob?: boolean;
    execute?: boolean;
    journal?: boolean;
    resolvedContact?: boolean;
    unresolvedContact?: boolean;
    navigationError?: boolean;
    navigationHang?: boolean;
    missingContact?: boolean;
    wrongConversation?: boolean;
    bulk?: boolean;
    messageSuccess?: boolean;
  } = {},
) {
  const calls: any[] = [];
  const scriptTimers: Array<() => void> = [];
  let markContactStarted: () => void = () => {};
  const contactStarted = new Promise<void>((resolve) => {
    markContactStarted = resolve;
  });
  let stage = "detail";
  const actions = [
    {
      id: "greeting",
      kind: "native-greeting",
      index: 0,
      state:
        options.resolvedContact || options.unresolvedContact
          ? "unknown"
          : "pending",
      ...(options.resolvedContact ? { resolution: "contact-exists" } : {}),
    },
    {
      id: "message",
      kind: "message",
      index: 1,
      state: "pending",
      text: "您好",
    },
    { id: "attachment", kind: "attachment", index: 2, state: "pending" },
  ];
  const api = async (path: string, request: any) => {
    calls.push({ path, body: request.body });
    if (path.endsWith("/claim"))
      return {
        task: {
          id: "task",
          leaseToken: "lease",
          application: {
            id: "app",
            job,
            ...(options.bulk ? { bulkRunId: "batch" } : {}),
            actions: options.bulk
              ? [
                  ...actions.filter((a) => a.kind !== "attachment"),
                  {
                    id: "message-2",
                    kind: "message",
                    index: 2,
                    state: "pending",
                    text: "目前状态：离职",
                  },
                ]
              : actions,
          },
        },
      };
    if (path.endsWith("/heartbeat")) return { paused: false, takeover: false };
    if (path.endsWith("/action")) return { execute: options.execute !== false };
    if (path.endsWith("/result"))
      return {
        ok: true,
        status: options.messageSuccess ? "completed" : "needs-review",
      };
    return { ok: true };
  };
  const values: any = options.journal
    ? { "jobAssistantApplicationAttempt:task:greeting": true }
    : {};
  const extractJobs = () => {};
  const applicationPageStep = () => {};
  const chrome = {
    runtime: {
      id: "fixture",
      onMessage: { addListener() {}, removeListener() {} },
    },
    tabs: {
      create: async () => ({ id: 1 }),
      get: async () => ({
        id: 1,
        url:
          stage === "detail" ? job.url : "https://www.zhipin.com/web/geek/chat",
        status: "complete",
      }),
      query: async () => (stage === "conversation" ? [{ id: 1 }] : []),
      remove: async (id: number) => {
        calls.push({ removedTab: id });
      },
    },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: values[key] }),
        set: async (value: any) => Object.assign(values, value),
      },
    },
    scripting: {
      executeScript: async ({ func, args }: any) => {
        if (func === extractJobs)
          return [
            {
              result: {
                jobs: [
                  {
                    ...job,
                    title: options.wrongJob ? "其他岗位" : job.title,
                    detail: true,
                    salaryText: "20-30K",
                  },
                ],
              },
            },
          ];
        calls.push({
          mode: args[0].mode,
          expectedExisting: args[0].expectedExisting,
          conversationOrigin: args[0].conversationOrigin,
          conversationBinding: args[0].conversationBinding,
        });
        if (args[0].mode === "inspect")
          return [
            {
              result: {
                ok: !(options.wrongConversation && stage === "conversation"),
                page: stage,
                conversationBinding:
                  stage === "conversation" ? "fixture-binding" : undefined,
                existingContact: !options.missingContact,
              },
            },
          ];
        if (args[0].mode === "contact") {
          stage = "conversation";
          markContactStarted();
          if (options.navigationHang) return new Promise(() => {});
          if (options.navigationError)
            throw new Error("Frame context destroyed during navigation");
          return [
            {
              result: {
                ok: true,
                clicked: true,
                existingContact: !options.missingContact,
              },
            },
          ];
        }
        if (args[0].mode === "message" && options.messageSuccess)
          return [{ result: { ok: true, evidence: "new-message" } }];
        return [{ result: { ok: false, reason: "send-unconfirmed" } }];
      },
    },
  };
  const context = {
    api,
    chrome,
    extractJobs,
    applicationPageStep,
    URL,
    crypto: webcrypto,
    setTimeout: (callback: () => void, ms: number) => {
      if (ms === 15000) {
        scriptTimers.push(callback);
        return scriptTimers.length;
      }
      callback();
      return 1;
    },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  };
  return {
    calls,
    contactStarted,
    expireScript: () => scriptTimers.at(-1)?.(),
    run: () =>
      runInNewContext(
        runnerScript + "\nrunExtensionApplication(api, 'fixture-token')",
        context,
      ),
  };
}
test("runner never starts a side effect when the live job differs or a local attempt is already recorded", async () => {
  for (const options of [{ wrongJob: true }, { journal: true }]) {
    const f = runnerFixture(options);
    await f.run();
    assert.equal(
      f.calls.some(
        (call) => call.body?.state === "started" || call.mode === "contact",
      ),
      false,
    );
    assert.equal(
      f.calls.filter((call) => call.path?.endsWith("/result")).length,
      1,
    );
  }
});
test("verified existing contact preserves the unknown greeting and only navigates once", async () => {
  for (const navigationError of [false, true]) {
    const f = runnerFixture({
      resolvedContact: true,
      navigationError,
      journal: true,
    });
    await f.run();
    assert.equal(f.calls.filter((call) => call.mode === "contact").length, 1);
    assert.equal(
      f.calls.find((call) => call.mode === "contact")?.expectedExisting,
      true,
    );
    assert.equal(
      f.calls.some((call) => call.body?.actionId === "greeting"),
      false,
    );
    assert.equal(f.calls.filter((call) => call.mode === "message").length, 1);
    assert.equal(
      f.calls.find((call) => call.mode === "contact")?.conversationOrigin,
      null,
    );
    assert.equal(
      f.calls.find((call) => call.mode === "message")?.conversationOrigin,
      job.url,
    );
    assert.equal(
      f.calls.find((call) => call.mode === "message")?.conversationBinding,
      "fixture-binding",
    );
    assert.equal(
      f.calls.some((call) => call.mode === "attachment"),
      false,
    );
  }
});

test("a lost Continue navigation result is inspected without replaying the click", async () => {
  const f = runnerFixture({ resolvedContact: true, navigationHang: true });
  const pending = f.run();
  await f.contactStarted;
  assert.equal(f.calls.filter((call) => call.mode === "contact").length, 1);
  f.expireScript();
  await pending;
  assert.equal(f.calls.filter((call) => call.mode === "contact").length, 1);
  assert.equal(f.calls.filter((call) => call.mode === "message").length, 1);
  assert.equal(
    f.calls.some((call) => call.body?.actionId === "greeting"),
    false,
  );
});

test("a timed out new contact without an exact target conversation stays unknown", async () => {
  const f = runnerFixture({
    missingContact: true,
    navigationHang: true,
    wrongConversation: true,
  });
  const pending = f.run();
  await f.contactStarted;
  f.expireScript();
  await pending;
  assert.equal(f.calls.filter((call) => call.mode === "contact").length, 1);
  assert.equal(
    f.calls.some(
      (call) => call.mode === "message" || call.mode === "attachment",
    ),
    false,
  );
  assert.equal(
    f.calls.filter(
      (call) =>
        call.body?.actionId === "greeting" && call.body?.state === "unknown",
    ).length,
    1,
  );
});
test("one new contact navigation can be confirmed by exact conversation readback without replay", async () => {
  for (const navigationError of [false, true]) {
    const f = runnerFixture({
      missingContact: true,
      navigationError,
      bulk: true,
      messageSuccess: true,
    });
    await f.run();
    assert.equal(f.calls.filter((c) => c.mode === "contact").length, 1);
    assert.equal(f.calls.filter((c) => c.mode === "message").length, 2);
    assert.equal(
      f.calls.some(
        (c) => c.mode === "attachment" || c.path?.endsWith("/attachment"),
      ),
      false,
    );
    assert.equal(
      f.calls.find(
        (c) => c.body?.actionId === "greeting" && c.body?.state === "confirmed",
      )?.body.evidence,
      "new-conversation",
    );
    assert.equal(
      f.calls.find((c) => c.mode === "message")?.conversationBinding,
      "fixture-binding",
    );
    assert.deepEqual(
      f.calls.filter((c) => c.removedTab).map((c) => c.removedTab),
      [1],
    );
  }
});
test("an explicitly reconciled bulk contact resumes only pending messages without replaying the greeting", async () => {
  const f = runnerFixture({
    bulk: true,
    resolvedContact: true,
    journal: true,
    messageSuccess: true,
  });
  await f.run();
  assert.equal(f.calls.filter((c) => c.mode === "contact").length, 1);
  assert.equal(
    f.calls.find((c) => c.mode === "contact")?.expectedExisting,
    true,
  );
  assert.equal(f.calls.filter((c) => c.mode === "message").length, 2);
  assert.equal(
    f.calls.some((c) => c.body?.actionId === "greeting"),
    false,
  );
  assert.equal(
    f.calls.find((c) => c.path?.endsWith("/result"))?.body.reason,
    undefined,
  );
});

test("bulk applications skip previously contacted recruiters without navigation or messages", async () => {
  const f = runnerFixture({ bulk: true });
  await f.run();
  assert.equal(
    f.calls.some(
      (c) =>
        c.mode === "contact" ||
        c.mode === "message" ||
        c.mode === "attachment" ||
        c.body?.state === "started",
    ),
    false,
  );
  assert.equal(
    f.calls.find((c) => c.path?.endsWith("/result"))?.body.reason,
    "existing-contact",
  );
});
test("bulk unknown message retains its tab and never starts the next message", async () => {
  const f = runnerFixture({ missingContact: true, bulk: true });
  await f.run();
  assert.equal(f.calls.filter((c) => c.mode === "message").length, 1);
  assert.equal(
    f.calls.some((c) => c.body?.actionId === "message-2" || c.removedTab),
    false,
  );
});
test("the exact delivered label confirms a new matching outgoing message but failures do not", async () => {
  for (const failed of [false, true]) {
    const f = chatFixture();
    f.button.click = () => {
      f.rows.push(
        element("您好", {
          ".text, .message-text, .text-content, .bubble-content": [
            element("您好"),
          ],
          ".status, .message-status, .read-status": [element("送达")],
          ".message-fail, .send-fail, .retry": failed ? [element("重试")] : [],
        }),
      );
      f.editor.innerText = "";
    };
    assert.equal(
      (await runPage(f.document, { mode: "message", text: "您好" })).ok,
      !failed,
    );
  }
});
test("visible platform quota notices stop before any sending", async () => {
  const f = chatFixture();
  let clicks = 0;
  f.button.click = () => clicks++;
  const query = f.document.querySelectorAll;
  f.document.querySelectorAll = (selector: string) =>
    selector === ".dialog-wrap, .dialog-box, .toast, .toast-text, .chat-tip"
      ? [element("今日沟通次数已达上限")]
      : query(selector);
  assert.equal(
    (await runPage(f.document, { mode: "message", text: "您好" })).reason,
    "platform-limit",
  );
  assert.equal(clicks, 0);
});
test("unknown greeting without a resolution or without a live Continue control cannot be replayed", async () => {
  for (const options of [
    { unresolvedContact: true },
    { resolvedContact: true, missingContact: true },
  ]) {
    const f = runnerFixture(options);
    await f.run();
    assert.equal(
      f.calls.some(
        (call) =>
          call.mode === "contact" ||
          call.mode === "message" ||
          call.body?.state === "started",
      ),
      false,
    );
  }
});
test("failed conversation inspection reports only bounded counts, excluding history", async () => {
  const f = chatFixture();
  f.header.innerText = "其他公司";
  const result = await runPage(f.document, { mode: "inspect" });
  assert.equal(result.ok, false);
  const { probes, ...legacyDiagnostic } = JSON.parse(
    JSON.stringify(result.diagnostic),
  );
  assert.equal(probes[0].result, "source-unverified");
  assert.deepEqual(legacyDiagnostic, {
    stage: "conversation",
    editorCount: 1,
    activeJobCardCount: 1,
    exactJobLinkCount: 1,
    employerFieldMatchCount: 0,
  });
  f.link.closest = () => element("旧消息");
  assert.equal(
    (await runPage(f.document, { mode: "inspect" })).diagnostic
      .exactJobLinkCount,
    0,
  );
});
test("nested View Job wrappers with decorative children remain one current-header control", async () => {
  const f = semanticChatFixture();
  const selector = "a, button, span, div, p, strong, em, h1, h2, h3, b, label";
  f.view.children = [element()];
  const wrapper = element("查看职位", { [selector]: [f.view] });
  wrapper.children = [f.view];
  wrapper.getBoundingClientRect = f.view.getBoundingClientRect;
  wrapper.parentElement = f.card;
  f.view.parentElement = wrapper;
  f.allFields.push(wrapper);
  const result = await runPage(f.document, {
    mode: "inspect",
    conversationOrigin: job.url,
  });
  assert.equal(result.page, "conversation");
  assert.equal(typeof result.conversationBinding, "string");
  f.allFields.push(element("查看职位"));
  const ambiguous = await runPage(f.document, {
    mode: "inspect",
    conversationOrigin: job.url,
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.diagnostic.probes[0].viewControlCount, 2);
});
test("semantic diagnostics pinpoint the failed gate without returning visible text or granting sends", async () => {
  const cases: Array<[string, (f: any) => void]> = [
    [
      "view-control",
      (f) => {
        f.allFields.push(element("查看职位"));
      },
    ],
    [
      "job-fields",
      (f) => {
        f.city.innerText = "其他城市";
      },
    ],
    [
      "salary",
      (f) => {
        f.salary.innerText = "10-15K";
      },
    ],
    [
      "employer",
      (f) => {
        f.employer.innerText = "其他公司";
      },
    ],
    [
      "recruiter",
      (f) => {
        f.recruiter.innerText = "在线";
      },
    ],
    [
      "pane-left",
      (f) => {
        f.root.getBoundingClientRect = () => ({
          left: 0,
          right: 1020,
          top: 100,
        });
      },
    ],
  ];
  for (const [expected, modify] of cases) {
    const f = semanticChatFixture();
    modify(f);
    let clicks = 0;
    f.button.click = () => clicks++;
    const result = await runPage(f.document, {
      mode: "inspect",
      conversationOrigin: job.url,
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostic.probes[0].result, expected);
    assert.equal(clicks, 0);
    const serialized = JSON.stringify(result.diagnostic);
    for (const sensitive of [
      job.title,
      job.company,
      job.location,
      job.url,
      "王先生",
      "其他公司",
    ])
      assert.equal(serialized.includes(sensitive), false);
    if (expected === "view-control") {
      assert.equal(result.diagnostic.probes[0].viewTextCount, 2);
      assert.equal(result.diagnostic.probes[0].viewControlCount, 2);
    }
  }
  const f = semanticChatFixture();
  f.allFields.push(...Array.from({ length: 40 }, () => element("查看职位")));
  const result = await runPage(f.document, {
    mode: "inspect",
    conversationOrigin: job.url,
  });
  assert.equal(result.diagnostic.probes[0].viewTextCount, 20);
  assert.equal(result.diagnostic.probes[0].viewControlCount, 20);
});
test("runner refuses duplicate begin permission and stops after an uncertain message before attachment", async () => {
  const denied = runnerFixture({ execute: false });
  await denied.run();
  assert.equal(
    denied.calls.some((call) => call.mode === "message"),
    false,
  );
  const f = runnerFixture();
  await f.run();
  assert.equal(f.calls.filter((call) => call.mode === "message").length, 1);
  assert.equal(
    f.calls.some(
      (call) =>
        call.mode === "attachment" || call.path?.endsWith("/attachment"),
    ),
    false,
  );
  assert.equal(
    f.calls.filter((call) => call.body?.state === "unknown").length,
    1,
  );
  assert.equal(
    f.calls.filter((call) => call.path?.endsWith("/result")).length,
    1,
  );
});

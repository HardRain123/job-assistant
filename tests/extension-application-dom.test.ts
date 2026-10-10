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
    ".text, .message-text, .text-content": [element(value)],
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
    missingContact?: boolean;
  } = {},
) {
  const calls: any[] = [];
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
          application: { id: "app", job, actions },
        },
      };
    if (path.endsWith("/heartbeat")) return { paused: false, takeover: false };
    if (path.endsWith("/action")) return { execute: options.execute !== false };
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
                ok: true,
                page: stage,
                conversationBinding:
                  stage === "conversation" ? "fixture-binding" : undefined,
                existingContact: !options.missingContact,
              },
            },
          ];
        if (args[0].mode === "contact") {
          stage = "conversation";
          if (options.navigationError)
            throw new Error("Frame context destroyed during navigation");
          return [{ result: { ok: true, existingContact: true } }];
        }
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
    setTimeout: (callback: () => void) => {
      callback();
      return 1;
    },
    setInterval: () => 1,
    clearInterval: () => {},
  };
  return {
    calls,
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
  assert.deepEqual(JSON.parse(JSON.stringify(result.diagnostic)), {
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

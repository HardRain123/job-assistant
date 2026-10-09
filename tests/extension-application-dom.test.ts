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
};
function element(
  value = "",
  selectors: Record<string, any[]> = {},
  hidden = false,
): any {
  return {
    innerText: value,
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
    ".chat-editor .chat-input[contenteditable='true'], div.chat-input[contenteditable='true']":
      [editor],
  });
  document.body = body;
  document.documentElement = element();
  return { rows, editor, link, header, button, input, root, document };
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
test("native contact must match the frozen URL and existing-contact state before click", async () => {
  let clicks = 0;
  const control = element("继续沟通");
  control.click = () => clicks++;
  const banner = element(job.title, { "a, button": [control] });
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
  const banner = element(job.title, { "a, button": [control] });
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
  options: { wrongJob?: boolean; execute?: boolean; journal?: boolean } = {},
) {
  const calls: any[] = [];
  let stage = "detail";
  const actions = [
    { id: "greeting", kind: "native-greeting", index: 0, state: "pending" },
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
        calls.push({ mode: args[0].mode });
        if (args[0].mode === "inspect")
          return [{ result: { ok: true, page: stage, existingContact: true } }];
        if (args[0].mode === "contact") {
          stage = "conversation";
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

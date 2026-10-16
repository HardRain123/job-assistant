import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../apps/browser-extension/chat-diagnostics.mjs", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "").replace("export async function", "async function");
const url = "https://www.zhipin.com/web/geek/chat";
const headerEvidence = { names: ["测试招聘者"], roles: ["技术负责人"] };
async function fixture({ tabs = [{ id: 1, url }], response = { outcome: "observed", headerEvidence }, getUrl = url, task = true } = {}) {
  const calls: any[] = [];
  const injections: any[] = [];
  const api = async (path: string, options: any) => {
    calls.push({ path, ...options });
    return path.endsWith("claim") ? { task: task ? { id: "diagnostic", applicationId: "application", leaseToken: "lease", job: { title: "岗位" } } : null } : { ok: true };
  };
  await runInNewContext(source + "\nrunChatDiagnostic(api, 'paired-token')", {
    URL, setTimeout, clearTimeout, Date, api, applicationPageStep: () => {},
    chrome: {
      tabs: { query: async () => tabs, get: async () => ({ url: getUrl }) },
      scripting: { executeScript: async (input: any) => { injections.push(input); return [{ result: response }]; } },
    },
  });
  return { calls, injections, report: calls.find((call) => call.path.endsWith("result"))?.body };
}
test("diagnostic worker is bounded to existing exact chat tabs and sends only the declared evidence", async () => {
  const f = await fixture();
  assert.equal(f.injections.length, 1);
  assert.equal(f.injections[0].world, "ISOLATED");
  assert.equal(f.injections[0].args[0].mode, "diagnose");
  assert.equal(f.injections[0].args[0].authorization, undefined);
  assert.equal(f.report.outcome, "observed");
  assert.deepEqual(f.report.headerEvidence, headerEvidence);
  assert.ok(f.calls.every((call) => /diagnostic-(claim|result)$/.test(call.path)));
});
test("multiple matches, excessive tabs and malformed evidence cannot be reported as one target", async () => {
  const two = await fixture({ tabs: [{ id: 1, url }, { id: 2, url }] });
  assert.equal(two.report.outcome, "ambiguous");
  assert.equal(two.report.headerEvidence, undefined);
  const excessive = await fixture({ tabs: Array.from({ length: 9 }, (_, id) => ({ id, url })) });
  assert.equal(excessive.report.outcome, "ambiguous");
  assert.equal(excessive.injections.length, 0);
  const malformed = await fixture({ response: { outcome: "observed", headerEvidence: { names: ["<html>"], roles: [] } } });
  assert.equal(malformed.report.outcome, "unavailable");
  assert.equal(malformed.report.headerEvidence, undefined);
});
test("no task, unrelated or navigated tabs have no injection and never open a chat", async () => {
  const none = await fixture({ task: false });
  assert.equal(none.calls.length, 1);
  assert.equal(none.injections.length, 0);
  for (const other of ["https://example.com/web/geek/chat", "https://www.zhipin.com/web/geek/chat-history"]) {
    const filtered = await fixture({ tabs: [{ id: 1, url: other }] });
    assert.equal(filtered.injections.length, 0);
    assert.equal(filtered.report.outcome, "not-found");
    const navigated = await fixture({ getUrl: other });
    assert.equal(navigated.injections.length, 0);
  }
});

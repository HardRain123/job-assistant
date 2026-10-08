import test from "node:test";
import assert from "node:assert/strict";
import { accountLabel, isChatGPTAccount, modelNames } from "./provider-view.ts";
test("未登录的 Codex 账户不能显示已连接", () => {
  assert.match(
    accountLabel({ account: null, requiresOpenaiAuth: true }),
    /尚未登录/,
  );
  assert.equal(
    accountLabel({
      account: { type: "chatgpt", email: "fixture@example.com" },
    }),
    "已连接：fixture@example.com",
  );
  assert.match(accountLabel({}), /尚未确认/);
});

test("仅在账户状态确认是 ChatGPT 时结束设备码引导", () => {
  assert.equal(isChatGPTAccount({ account: { type: "chatgpt" } }), true);
  assert.equal(isChatGPTAccount({ type: "chatgpt" }), true);
  assert.equal(isChatGPTAccount({ account: { type: "apiKey" } }), false);
  assert.equal(isChatGPTAccount({ account: null }), false);
  assert.equal(isChatGPTAccount({}), false);
});
test("读取 Codex 分页模型列表并优先使用实际模型名称", () => {
  assert.deepEqual(
    modelNames({
      data: [{ id: "display-id", model: "fixture-model" }],
      nextCursor: null,
    }),
    ["fixture-model"],
  );
});

import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Extension code is shared with Chrome's isolated world.
import { matchesFrozenJob } from "../apps/browser-extension/application.mjs";

test("发送前重新读取到关闭或未知状态时，拒绝原先开放的冻结岗位", () => {
  const expected = {
    url: "https://www.zhipin.com/job_detail/fixture.html",
    company: "示例科技有限公司",
    title: "AI 开发",
    description: "Agent 与 Java 后端开发",
    salaryMin: 20000,
    salaryMax: 30000,
    status: "active",
  };
  const found = { ...expected, detail: true, salaryText: "20-30K" };
  assert.equal(matchesFrozenJob(found, expected), true);
  for (const status of ["closed", "unknown"]) {
    assert.equal(matchesFrozenJob({ ...found, status }, expected), false);
  }
});

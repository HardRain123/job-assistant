# 批量工作流与候选补采调研

> 2026-10-22 当前方向：按用户最新要求继续修复本项目，暂停替换执行器方案。此前的 [get_jobs 复核](get-jobs-reassessment.md) 仅保留为历史调研；当前修复以 [项目缺口核查](current-project-audit-2026-10-20.md) 及后续验证记录为准。下文保留为 10 月 15 日的历史决策，不代表已验证上游无法复用。

核对日期：2026-10-15。范围是后续的“采集 → 评分 → 批量发送 → 候选不足时补采”编排设计。只查阅公开 GitHub 仓库、提交记录、README、问题区及 Chrome 官方扩展文档；没有克隆、执行、部署或安全审计候选代码。仓库中现有的 [自动采集调研](automation-research.md)、[批量投递调研](bulk-application-research.md) 和 [架构取舍](architecture.md) 也作为本项目现况依据。

## 候选比较

| 候选 | 许可证、近期活动与技术栈 | 覆盖、质量证据 | 风险、集成成本与结论 |
| --- | --- | --- | --- |
| [mrcxsy/boss-auto-apply](https://github.com/mrcxsy/boss-auto-apply) | 仓库标示 Apache-2.0；[提交历史](https://github.com/mrcxsy/boss-auto-apply/commits/main/)显示 5 次提交，最近可见为 2026-06-23；原生 JavaScript/MV3。 | [README](https://github.com/mrcxsy/boss-auto-apply#readme)描述持续扫描、过滤、岗位处理及跨页面保存状态。公开目录以扩展脚本为主，现有调研未找到充分自动化测试证据。以上功能均是仓库自述，未运行验证。 | 浏览器扩展栈最匹配、局部参考成本低，但进度状态主要留在扩展侧，缺少本项目所需的后端批次账本和可核验发送结果。README 描述的 `isTrusted` hook、反检测行为不适合作为复用内容。参考扫描循环的有限阶段拆分，不复制实现。 |
| [bazxhy/Automated-Resume-Submission](https://github.com/bazxhy/Automated-Resume-Submission) | 仓库标示 MIT；[提交历史](https://github.com/bazxhy/Automated-Resume-Submission/commits/main/)共有 8 次提交。既有调研记录最近提交为 2026-06-02；Python/DrissionPage。 | [README](https://github.com/bazxhy/Automated-Resume-Submission#readme)描述岗位搜索、匹配、每日计数及 CSV/JSON 投递记录；[计数实现位置](https://github.com/bazxhy/Automated-Resume-Submission/blob/main/submitter.py#L47-L91)可参考跨日额度概念。公开目录未见测试套件；页面声明和行为未经运行验证。 | 每日计数、持久记录和去重概念可参考，但 Python/CDP 路线与 Fastify/SQLite/原生 MV3 差异明显，移植成本高。其点击后的计数不能替代实际发送回执；监听页面网络响应的方式也不纳入本项目边界。只参考计数思路。 |
| [as161233574-alt/boss-zhipin-bot](https://github.com/as161233574-alt/boss-zhipin-bot) | 仓库标示 MIT；[提交历史](https://github.com/as161233574-alt/boss-zhipin-bot/commits/main/)显示 15 次提交，最近可见为 2026-06-08；FastAPI、Playwright、SQLite。 | [README](https://github.com/as161233574-alt/boss-zhipin-bot#readme)描述搜索、评分、投递、每日上限和调度防护，并声明有单元、API/调度、浏览器 E2E 测试及覆盖数量；仓库含 `tests/`。这些是上游说明，未在本机执行或独立确认覆盖。公开 [Issue #1](https://github.com/as161233574-alt/boss-zhipin-bot/issues/1) 报告唯一键冲突导致搜索 500。 | SQLite 账本和阶段拆分概念与本项目最接近；整体栈仍不兼容，完整移植成本高。Issue 暴露去重并发边界，自动触达及页面/API 操作也不能照搬。参考持久队列、阶段和错误分类的设计，不复用代码。 |

三者许可均为宽松许可，复用时仍需遵守各自许可条件；本计划不复制代码。三者提交集中在 2026 年 6 月，维护证据有限，不能据此称为持续活跃项目。候选 README 中的功能、测试数量和质量声明均不是本项目实测结果。没有候选能直接满足本项目需要的闭环：合格条件不降级、结果未知不重发、岗位级故障与账号级阻断分开处理。

## 方案结论

沿用现有 Fastify/SQLite 与原生 MV3 扩展，自行实现一个有界、可恢复的批次状态机。后端 SQLite 是批次、候选和发送步骤的唯一持久状态来源；浏览器扩展只执行后端下发的有限页面命令，并回报固定状态。当前已存在的命令租约、岗位去重、评分流程、批次和发送审计继续作为边界，不新增 Redis、Temporal 或 Playwright 运行栈。

MV3 Service Worker 会因浏览器生命周期而终止。扩展通过 [Chrome Service Worker lifecycle 文档](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) 与 [Alarms API 文档](https://developer.chrome.com/docs/extensions/reference/api/alarms)恢复有限轮询；重启恢复依据后端租约和 SQLite 状态，不依赖扩展内存。Chrome 文档解释的是平台生命周期和接口，不代表本项目扩展已完成真实浏览器验收。

## 建议的实施顺序与边界

1. **冻结批次输入。** 用户启动时固定关键词、城市、硬条件、评分门槛、目标数、话术和平台额度。显示完整候选与发送预览后，确认进入外部发送阶段；后续补采继续使用同一冻结筛选条件。
2. **采集与评分按轮运行。** 每轮只收集上限内的岗位，后端按岗位来源 ID 去重并保存快照，对新增岗位运行现有硬条件和评分。只将硬条件通过且达到既定评分门槛的岗位放入待确认队列；未知、拒绝和低分均不因候选不足而放宽。
3. **有界补足候选。** 合格且未投递候选少于目标时，才启动下一搜索轮。设置每批最大轮数、关键词页数、详情数和实际平台限制；遇到登录/验证、重复页面、连续无新增合格岗位或预算耗尽则停止补采并显示缺额，不虚构岗位填满目标。
4. **串行发送并隔离岗位结果。** 每个岗位独立记录发送阶段及回执。确认动作尚未开始的岗位级失败可跳过并继续下一个；发送已开始但结果未知的岗位记为占额、禁止重放。只有可确定未发生发送动作的失败才能释放候选名额并考虑补采。登录失效、验证码/人工验证和平台限额等账号/平台级状态暂停整个批次。
5. **恢复和审计依赖幂等回执。** 一次只领取有限命令，租约过期后用批次 ID、岗位 ID 和阶段 ID 校验回执；重复、过期或与冻结配置不符的回执不得推进工作流。保留来源、评分理由摘要、固定错误类别和状态变更记录，不保存与任务无关的页面或聊天原文。

默认每日目标 150 是批次配置建议，不视为平台统一保证额度；遇到实际限制优先暂停。该流程不包含反检测、隐藏接口、自动绕过验证码或把未知发送重新执行。个人筛选条件、简历内容和账号凭证不纳入此调研文档。

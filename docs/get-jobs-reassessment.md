# get_jobs 复核与实施顺序调整

> 历史调研记录。用户随后明确要求不迁移 get_jobs，继续修复当前项目；本文后面的试跑和替换顺序已被该决定取代，不作为当前实施计划。当前状态见 [项目核查](current-project-audit-2026-10-20.md) 和 [验证状态](verification.md)。

复核日期：2026-10-20。用户提供了此前候选清单遗漏的 [loks666/get_jobs](https://github.com/loks666/get_jobs)。本次已下载并检查源码、许可证、发行说明和问题区；未启动上游程序，未登录账号，未执行上游测试，未复制上游实现到本项目。

## 结论

将 get_jobs 提升为 **优先独立试跑、通过后再决定接入的候选**。先用实际浏览器验证其既有搜索和发送流程，再投入架构改造；不再仅以技术栈不同或已有本地测试为理由继续自行实现全部平台操作。原扩展 0.4.14 的未发布修改保留，暂缓发布。

过去的问题包括：遗漏重要候选；没有实跑候选就确定自行实现；真实批量验收太晚，页面识别的小修补不断累积。现有系统曾完成一个岗位的两段话术自动确认，但连续十岗位验收尚未完成。上游功能也只完成源码核对，不能把其自报的投递数当成本账号实测结果。

## 三个候选比较

维护日期取本次 GitHub API 返回的默认分支最新提交，而非搜索缓存或 Star 数。

| 候选 | 许可、维护与技术栈 | 功能、代码与测试 | 风险、接入成本、扩展性及选择 |
| --- | --- | --- | --- |
| [loks666/get_jobs](https://github.com/loks666/get_jobs) | PolyForm Noncommercial 1.0.0；`a78db87b1da539120eeb843e6ab2fc36998bc2c0`，2026-10-16；Java 21、Spring Boot、Playwright、SQLite、Next.js | 已有搜索、滚动加载、职位入库、筛选、沟通、文字与图片简历、管理页；两个测试类，未见应用构建或测试 CI | 最近仍在修 BOSS，功能覆盖最值得优先验证。独立试跑成本中等；接入现有工作台需执行接口、字段与状态映射。最新版不能直接复制后仅按 Apache-2.0 发布；访问保护、文字回执和数值阈值需补。选择：独立验证后评估复用。 |
| [mrcxsy/boss-auto-apply](https://github.com/mrcxsy/boss-auto-apply) | Apache-2.0；`c70372108354b3b1efdaf16775ffcbff42853919`，2026-06-23；MV3/JavaScript | 已有筛选、AI、多模型配置、自动沟通和本地日志；既有调研未见独立测试/CI，本次核对 README 与入口代码 | 与现有扩展最接近，局部复用成本较低；批次状态与记录仍要接后端。入口包含页面行为及事件钩子，不能整包盲接。选择：保留为宽松许可的扩展备选。 |
| [as161233574-alt/boss-zhipin-bot](https://github.com/as161233574-alt/boss-zhipin-bot) | MIT；`4f62a113de42fa3e8b14d243b4f7d2de45dfd732`，2026-06-08；FastAPI、Playwright、SQLite、Vue | 搜索、匹配、投递、聊天、数据库去重；有测试目录，既有调研未见 CI 执行应用测试；本次复核投递与记录源码 | 持久记录可参考，整体替换增加 Python 运行栈和数据迁移。问题区曾报告唯一键冲突与聊天超时，作者称已更新，不能直接认定当前仍复现。选择：记录与调度备选，优先级低于 get_jobs 实跑。 |

## 已核实的可用部分与差异

- **搜索采集可复用。** 逐城市、关键词搜索，有界滚动、遍历卡片；字段来自本次页面触发的职位详情响应，再入 SQLite，可减少目前依赖页面文字解析的问题，实际成功率仍待验证。[Boss.java](https://github.com/loks666/get_jobs/blob/a78db87b1da539120eeb843e6ab2fc36998bc2c0/src/main/java/com/getjobs/worker/boss/Boss.java#L227-L483)
- **配置与模型已有基础。** 管理页支持话术、API 地址、Key、模型名称；AI 以是否返回 false 判断跳过。未发现可配置的数值匹配阈值、ChatGPT 账号授权或多供应商降级链。[AI 服务](https://github.com/loks666/get_jobs/blob/a78db87b1da539120eeb843e6ab2fc36998bc2c0/src/main/java/com/getjobs/application/service/AiService.java)
- **图片流程已有实现。** 上传校验图片格式和大小，发送等待新增图片消息结束上传；当前只保留一张图片，仍不等于三到四张截图队列。图片继续排在批量之后。[图片服务](https://github.com/loks666/get_jobs/blob/a78db87b1da539120eeb843e6ab2fc36998bc2c0/src/main/java/com/getjobs/application/service/BossResumeImageService.java)
- **筛选顺序需要适配。** 上游先点击沟通，再调用 AI，AI 失败回退固定话术；本项目需在首次外发前完成现有资格判断。`isSalaryNotExpected` 只检索到定义，未找到调用，网站薪资选项不能代替精确月薪校验。[执行顺序](https://github.com/loks666/get_jobs/blob/a78db87b1da539120eeb843e6ab2fc36998bc2c0/src/main/java/com/getjobs/worker/boss/Boss.java#L1079-L1125)
- **文字成功需要核实。** 点击发送、等待一秒后即设成功并更新已投递，需补两段话术各自的回执与刷新后复查。不能把这个计数直接视为送达。[文字发送](https://github.com/loks666/get_jobs/blob/a78db87b1da539120eeb843e6ab2fc36998bc2c0/src/main/java/com/getjobs/worker/boss/Boss.java#L1138-L1193)
- **任务控制需要补齐。** 停止超时后复位运行标志，代码注明后台操作可能残留；应确认旧执行退出后才能启动下一任务。未发现 BOSS 的持久化每日 150 配额账本、两段话术断点或按目标补足的完整实现。[任务服务](https://github.com/loks666/get_jobs/blob/a78db87b1da539120eeb843e6ab2fc36998bc2c0/src/main/java/com/getjobs/worker/service/BossJobService.java)
- **工作台访问保护需要补齐。** 未见鉴权，CORS 放行任意 Origin，配置和 Cookie 接口返回敏感字段。启动脚本为主端口设回环绑定，但额外 6866 connector 未设置 address。试跑前必须满足用户已要求的仅本机、工作台登录保护；监听行为尚未运行核验。[CORS](https://github.com/loks666/get_jobs/blob/a78db87b1da539120eeb843e6ab2fc36998bc2c0/src/main/java/com/getjobs/application/config/CorsConfig.java)、[额外端口](https://github.com/loks666/get_jobs/blob/a78db87b1da539120eeb843e6ab2fc36998bc2c0/src/main/java/com/getjobs/application/config/StaticServerConfiguration.java#L41-L49)
- **部署与许可要明确。** 上游未提供 Docker/Compose，浏览器使用本机持久目录；适合先验证本机执行器。最新许可限制非商业用途并要求保留条款与声明，不能仅用 Apache-2.0 重许可；独立运行也不消除上游条款。旧 MIT 版须单独锁定核对，不能夹带新版本修复。[LICENSE](https://github.com/loks666/get_jobs/blob/a78db87b1da539120eeb843e6ab2fc36998bc2c0/LICENSE)

[发行页](https://github.com/loks666/get_jobs/releases/tag/v2.0.1)提供前端和空数据库，后端仍需构建；发行资产与 main 不同，应锁定兼容版本。近期[图片上传 PR](https://github.com/loks666/get_jobs/pull/300)、[状态同步 PR](https://github.com/loks666/get_jobs/pull/301)表明仍有平台维护。[Issue #303](https://github.com/loks666/get_jobs/issues/303)有短时间运行后被限制的用户报告，不能保证替换程序后每次都能投满 150。

## 调整后的实施与验收顺序

1. **隔离准备。** 锁定上游版本，使用独立目录、空数据库和浏览器资料，保留许可；补齐本机访问保护，明确关闭企业微信通知。准备 Java 21 和构建环境，执行已有测试。当前 PATH 只发现 Java 17，本次未安装运行环境。
2. **先验证采集。** 启用不发送的调试模式，验证真实搜索、续载、字段与去重，用现有配置评估候选；记录具体失败环节。
3. **接最小发送路径。** 优先复用验证通过的平台操作，补首次沟通前资格检查、单岗位接口与两段固定话术回执。输入为已批准岗位和冻结话术；输出区分未发送、已确认、结果未知，保留历史去重及未知不重发。
4. **真实小批验收。** 一个岗位完整验证后，再连续十个合格新岗位，核对实际消息、去重、停止、断线恢复。数量不足要区分候选不足、平台限制和代码失败；不以测试数或点击数代替完成数。
5. **实测后决定主执行器。** 若上游明显更稳定，优先采用其独立执行器，保留原许可；现有 Docker 工作台负责模型、评分和投递记录。若仍需大量平台修补，按证据比较宽松许可扩展备选。随后再推进每日目标及图片队列。公开分发须明确各组件许可，接接口不能消除非商业限制。

本记录调整后续优先级，不表示迁移完成、已在用户账号运行上游，或已通过十岗位批量验收。

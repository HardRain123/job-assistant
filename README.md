# Job Assistant · 本地 AI 求职助手

通过本地 Web 工作台管理简历、招聘岗位、匹配规则、模型和沟通话术。数据保存在本机 SQLite。默认 Docker Compose 部署，中文界面，单用户使用。

## 当前能力

- 导入 DOCX/PDF 简历、核对解析文字、填写技能和工作年限。
- 公司官网岗位采集、去重、内容快照，以及公司/岗位/地点/薪资筛选。
- 自定义 OpenAI 兼容服务地址、模型名称、API Key；Chat Completions 和 Responses 分别适配；按顺序回退。
- 独立向量模型、语义检索、本地向量缓存，按服务地址、模型和维度隔离。
- 硬条件三态过滤、可调整权重与阈值、分项评分及证据。薪资比较月薪区间下限；缺失信息转人工核对。
- 可编辑的多段话术、变量预览、批次冻结，先话术后附件；最多 10 个岗位/批次。
- 任务租约、动作日志、重复回调去重、未知发送结果暂停，SQLite 一致性备份。
- 可选 ChatGPT 设备码授权桥接，浏览器人工接管和独立账号数据卷。
- 普通 Chrome/Edge 扩展配对，从工作台发起 BOSS 多关键词搜索、分页、详情采集与自动评分，支持暂停、恢复和取消；已有真实采集验证，部分字段仍可能无法识别。安装方法见 [浏览器扩展说明](docs/browser-extension.md)。
- 普通浏览器单岗位投递验证：预览并冻结话术与附件字节，逐步授权和记录回执；收件人不符、配置变化、暂停或未知发送结果时停止。

**开发预览版。** BOSS 的完整发送流程尚未通过真实账号验收。扩展 0.3.0 提供显式确认后的单岗位实验入口，可能因页面无法核对而停止；批量发送未开放。岗位入库、评分、预览不表示已投递。ChatGPT 通道的实际账号可用性也需要使用者完成授权后验证；自定义兼容 API 可独立使用。

## Docker 启动

先安装并启动 Docker Desktop（Windows 使用 Linux 容器）或 Docker Engine + Compose。

```powershell
# Windows PowerShell，在项目目录执行
.\deploy\start.ps1
```

```sh
# Linux / macOS
sh deploy/start.sh
```

打开 [本地工作台](http://localhost:3000)。首次初始化生成的本地密码保存在 `.secrets/app_password`，不要把 `.secrets`、数据卷或个人简历提交到公开仓库。

启用 ChatGPT 可选服务：

```sh
docker compose --profile chatgpt up -d --build
```

在“模型连接”中完成设备码登录，然后选择账号可用的模型。ChatGPT 授权通过官方 Codex App Server，**不是**把 ChatGPT 凭据转为 API Key。授权状态和评分可用状态分别展示。详见 [部署说明](docs/deployment.md)。

## 初次使用

大文件下载不稳定时，可使用两个官方 npm 包进行 [离线桥接构建](docs/bridge-offline.md)；需要代理的网络见 [部署说明](docs/deployment.md)。

1. 导入简历，核对姓名、文字、技能和年限。
2. 配置城市、最低月薪、排除公司/行业、评分权重和阈值。
3. 添加对话模型并测试；语义检索需要另外启用向量模型。
4. BOSS：在普通浏览器安装并配对扩展（当前 0.3.3），登录 BOSS 后，在工作台“自动找岗位”设置关键词、城市、采集上限和翻页数并启动，无需手动逐个打开职位。新版左右分栏页面优先点击卡片并读取同页详情，必要时补读独立详情；未知字段保留待复核。官网：添加公司招聘入口与允许域名，同步岗位。
5. 编辑话术，选择岗位评估和预览。官网岗位通过原始申请链接处理；BOSS 在“岗位库”勾选一个岗位，点击“普通浏览器单岗位验证”，核对预览后确认启动。复核区间岗位只允许明确确认且硬条件全部通过的单个岗位；全局策略不变。在“投递记录”查看每步状态。

默认示例不包含真实个人资料。API Key 仅保存在服务端，以独立应用密钥加密；备份与恢复时须同时保管该密钥。网页岗位和模型输出只作为数据，不获得控制浏览器或读取密钥的权限。

## 本机开发

需要 Node.js 24 与 pnpm 11。Docker 部署不需要宿主机安装这些工具。

```sh
pnpm install --frozen-lockfile
pnpm check
```

启动 API 前设置 `APP_PASSWORD_FILE`、`APP_KEY_FILE`、`INTERNAL_TOKEN_FILE`，指向部署初始化脚本生成的文件。`pnpm build` 编译页面，`pnpm start` 在 `127.0.0.1:3000` 启动。未连接 browser-worker 时，岗位库、配置、导入和模型评估仍可使用，采集和浏览器页面会显示未连接。

## 工程结构

| 路径                                 | 职责                             |
| ------------------------------------ | -------------------------------- |
| apps/web                             | React 工作台                     |
| apps/browser-extension               | 普通浏览器搜索、翻页与可见岗位读取 |
| apps/api                             | 本地认证、API、数据库与任务      |
| apps/browser-worker                  | 采集、浏览器与接管               |
| apps/codex-bridge                    | 狭窄的 Codex 认证和评分接口      |
| packages/contracts                   | 共享数据契约                     |
| packages/providers、matching、search | 模型回退、匹配与向量检索         |
| packages/storage、templates          | 持久化与话术冻结                 |
| packages/sources、boss               | 官网及平台适配                   |
| deploy                               | 启动、凭据初始化、备份和容器配置 |

测试使用匿名夹具和本地模拟模型，不触达招聘者。接口层、模型层和页面构建的实际验证情况见 [验证记录](docs/verification.md)。

## 开源与参考

业务代码独立实现，Apache-2.0。未复制无明确许可证的求职项目代码。开工前比较了 [boss-auto-apply](https://github.com/mrcxsy/boss-auto-apply)、[AutoApply](https://github.com/geckguy/AutoApply) 与 [job-agent](https://github.com/anton-karlovskiy/job-agent)；采用成熟浏览器和解析依赖，参考本地记录、复核与供应商适配思路。详细记录见 [方案取舍](docs/architecture.md)。

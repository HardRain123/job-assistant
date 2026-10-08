# 开发协作

Node.js 24，pnpm 11。公共类型在 packages/contracts/src/index.ts；根依赖和公共类型由主维护者统一变更。
运行 pnpm install、pnpm check。测试使用匿名夹具，禁止测试向真实招聘者发消息。
生产默认 Docker Compose；数据、密钥、简历、浏览器登录目录不进入版本控制或镜像。

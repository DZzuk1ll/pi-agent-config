# 项目指南

先读实现与测试，复用既有模式，仅作必要改动；不得削弱安全、凭据保护或错误处理。外部输入按 `unknown` 处理，优先用既有 TypeBox schema 校验。

## Pi 权威资料

涉及 Pi 的 API、行为或版本时必须联网检索。优先查官网 pi.dev、官方仓库 github.com/earendil-works/pi（文档、源码、Release）和官方包 npmjs.com/package/@earendil-works/pi-coding-agent；按项目锁定版本核对，第三方资料仅作补充，结论附链接。

## 交付门禁

修改 TS 后检查相关文件的 LSP diagnostics。交付代码前必须在 `~/.pi/agent` 运行 `npm run check`；失败、超时或跳过均不得宣称完成，修复后重跑。严禁提交密钥、令牌、会话或本机状态文件。

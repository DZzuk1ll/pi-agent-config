# Pi Agent Config

一套可版本管理、可跨设备同步的 [Pi](https://github.com/earendil-works/pi) 个人配置。它包含扩展、快捷键、全局指令和界面定制，但不包含认证信息与会话记录。

这是一份有明确偏好的配置模板，不是 Pi 本体。建议先 Fork 本仓库，再按自己的习惯修改。

## 包含的体验

- 紧凑的消息、工具调用和搜索结果展示
- 位于输入框下方的多行状态栏
- Fast mode、Plan mode 和 Subagents
- LSP、代码搜索、危险命令确认、通知与历史回退
- 统一的快捷键和全局 `AGENTS.md`
- 通过 `package-lock.json` 固定扩展依赖

当前验证环境：

- Pi `0.83.0`
- Node.js `22.19.0+`
- macOS

## 快速开始

### 1. 安装 Pi

确保已经安装 Node.js 和 npm，然后安装 Pi：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

如果新版 Pi 与本配置不兼容，可以安装已验证版本：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.83.0
```

### 2. 安装配置

全新环境可以直接克隆：

```bash
git clone https://github.com/DZzuk1ll/pi-agent-config.git ~/.pi
```

如果已经使用过 Pi，先备份现有目录：

```bash
mv ~/.pi "$HOME/.pi.backup.$(date +%Y%m%d-%H%M%S)"
git clone https://github.com/DZzuk1ll/pi-agent-config.git ~/.pi
```

如果你已经 Fork 本仓库，请将克隆地址替换成自己的 Fork。

### 3. 安装扩展依赖

```bash
npm ci --prefix ~/.pi/agent/npm
```

`node_modules` 不进入 Git；它可以随时通过 `package-lock.json` 重建。

### 4. 登录并启动

进入你要处理的项目，然后启动 Pi：

```bash
cd /path/to/your/project
pi
```

在 Pi 中运行：

```text
/login
```

默认配置使用 `openai-codex/gpt-5.6-sol`。没有 ChatGPT Codex 访问权限时，请通过 `/model` 选择可用模型，并修改 `~/.pi/agent/settings.json` 中的默认 provider 和 model。

## 常用操作

修改配置后，在正在运行的 Pi 中执行：

```text
/reload
```

Fast mode：

```text
/fast
/fast on
/fast off
/fast status
```

有子代理运行时：

- 第一次按 `↓` 进入子代理管理
- 使用 `↑`、`↓` 选择
- 按 `Enter` 查看详情
- 按 `Esc` 返回

## 同步更新

从 GitHub 获取最新配置：

```bash
cd ~/.pi
git pull --ff-only
npm ci --prefix agent/npm
```

保存自己的修改：

```bash
cd ~/.pi
git status
git add <修改过的配置文件>
git commit -m "Update Pi config"
git push
```

## 目录说明

```text
~/.pi/
├── README.md
├── settings.json                  # 紧凑界面与工具展示
└── agent/
    ├── AGENTS.md                  # 全局编码指令
    ├── settings.json              # Pi、模型与扩展配置
    ├── keybindings.json           # 快捷键
    ├── pi-plan-mode.json          # Plan mode 配置
    ├── extensions/                # 自定义扩展及其配置
    ├── lib/                       # 扩展共享逻辑
    ├── tests/                     # 自定义逻辑测试
    └── npm/
        ├── package.json           # 扩展依赖声明
        └── package-lock.json      # 可复现的依赖版本
```

## 不会同步的内容

以下内容已被 `.gitignore` 排除：

- `agent/auth.json`：登录令牌和 API Key
- `agent/trust.json`：本机信任记录
- `agent/sessions/`：会话内容
- `agent/run-history.jsonl`：运行历史
- `agent/context.db*`：本机上下文索引
- `node_modules/`：可重建依赖
- 运行锁、缓存和 Git 包检出目录

每台新设备都应单独执行 `/login`。不要把 `auth.json`、API Key 或其他凭据提交到 Git。

## 安全提示

Pi 扩展拥有本机代码执行权限。使用前请检查：

- `agent/settings.json` 中启用的扩展
- `agent/npm/package.json` 中的第三方依赖
- `agent/extensions/` 中的本地扩展

本配置适合个人使用和学习；在工作设备或敏感仓库中使用前，请根据自己的安全要求进行审查。

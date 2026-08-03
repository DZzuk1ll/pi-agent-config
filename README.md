# Pi Agent Config

一套可版本管理、可跨设备同步的 [Pi](https://github.com/earendil-works/pi) 个人配置。它包含扩展源码、快捷键、全局指令和界面定制，但不包含 Pi Core、认证信息与会话记录。

这是一份有明确偏好的个人发行配置，不是 Pi Core 的 fork。当前使用的社区 Pi 扩展以及与 Pi 强耦合的交互、安全和配置辅助库源码已纳入本仓库；通用基础设施仍由一个 `package-lock.json` 管理。

## 包含的体验

- 紧凑的消息、工具调用和搜索结果展示
- 位于输入框下方的多行状态栏
- Fast mode、Plan mode 和 Subagents
- LSP、代码搜索、危险命令确认、通知与历史回退
- 统一的快捷键和全局 `AGENTS.md`
- 仓库内直接维护全部 Pi 扩展及 Pi 强耦合辅助库源码
- 通过一个 `package-lock.json` 固定通用运行依赖

当前验证环境：

- Pi `0.83.0`
- Node.js `24.15.0+`
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
cd ~/.pi/agent
npm ci
```

`agent/package.json` 同时是本地 Pi Package 清单和唯一的 npm 依赖清单。`node_modules` 不进入 Git；它只包含通用运行依赖和指向仓库内辅助库源码的本地链接，可以随时通过 `package-lock.json` 重建。

扩展、辅助库和主题分别位于 `agent/extensions/community/`、`agent/lib/community/` 和 `agent/themes/community/`。`agent/settings.json` 加载 agent 根目录 `.`，不会从 npm 下载社区 Pi 扩展。

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
(cd agent && npm ci)
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
    ├── package.json               # 本地 Pi Package 清单与通用运行依赖
    ├── package-lock.json          # 可复现的依赖版本
    ├── settings.json              # Pi、模型与扩展配置
    ├── keybindings.json           # 快捷键
    ├── extensions/
    │   ├── plan-mode/
    │   │   └── config.json        # Plan mode 配置
    │   ├── community/             # 纳入维护的社区 Pi 扩展
    │   └── ...                    # 自有扩展及其配置
    ├── lib/
    │   ├── community/             # Pi 强耦合但不注册入口的辅助库
    │   └── ...                    # 自有共享逻辑
    ├── themes/community/          # 纳入维护的社区主题
    ├── third-party/
    │   ├── upstream.json          # 版本、来源、许可证、本地路径与修改
    │   └── patches/               # 迁移前补丁，仅作来源记录
    └── tests/                     # 自定义逻辑测试
```

## 不会同步的内容

以下内容已被 `.gitignore` 排除：

- `agent/auth.json`：登录令牌和 API Key
- `agent/trust.json`、`agent/my-pi-settings.json`：本机信任和扩展设置记录
- `agent/sessions/`：会话内容
- `agent/run-history.jsonl`：运行历史
- `agent/context.db*`：本机上下文索引
- `node_modules/`：可重建依赖
- 运行锁、缓存和 Git 包检出目录

每台新设备都应单独执行 `/login`。不要把 `auth.json`、API Key 或其他凭据提交到 Git。

## 安全提示

Pi 扩展拥有本机代码执行权限。使用前请检查：

- `agent/settings.json` 中启用的扩展
- `agent/package.json` 中的通用运行依赖和 Pi 资源入口
- `agent/extensions/community/` 中纳入维护的社区扩展源码
- `agent/lib/community/` 中纳入维护的 Pi 辅助库
- `agent/extensions/` 中的自定义扩展

本配置适合个人使用和学习；在工作设备或敏感仓库中使用前，请根据自己的安全要求进行审查。

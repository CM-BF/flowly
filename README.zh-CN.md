# Flowly

**Flowly**——给 Paseo 的 agent 原生工作流。

[English](README.md) · **简体中文**

**Flowly 是一个 Paseo 插件：把 agent session 变成会自己运转的工作流，看板是它的界面。** 你只管派活、拍板、验收；进度、提醒、总结、后续想法和数据复盘由看板自动维护。

> 插件 ID `flowly` · 需要 Paseo `>=0.11.2 <0.12.0` · 支持桌面、平板和手机客户端。

![看板：卡片随 agent 工作在 Design、Development、Test、In review 之间流转](docs/promo/screenshots/01-board-auto-status.png)

<details>
<summary>深色主题</summary>

![看板（深色）](docs/promo/screenshots/01-board-auto-status-dark.png)

</details>

## 主要功能

### 1. 自动状态流转

从卡片启动 session 后，卡片会跟着工作走：**Design → Development → Test → In review**。agent 通过受限的 Kanban 工具设置自己所处的阶段；session 开始或恢复一轮时，daemon 也会移动卡片。回合结束**不会**把卡片设为 Done，Done 和 Cancelled 永远由你决定。卡片上显示运行中、已结束回合、未读、需关注的 session 数量，以及最近一条 agent 输出。

可在 *Settings → Moving cards* 全局关闭，也可以按项目关闭。

### 2. 人工介入提醒

agent 需要你拍板时，会提出一个明确的问题并停下。卡片亮起 **Needs you**，顶部 **Attention** 菜单和侧边栏角标都会计数，点 **Reply** 直达对应 session。授权请求和报错也以同样方式提示。

![卡片上 agent 的提问与 Reply 按钮](docs/promo/screenshots/02-needs-you-drawer.png)

### 3. 任务运行 summary

每轮成功结束后，一个低成本模型（默认 Haiku 5.5，可配置）会更新卡片的 **状态 / 目标 / 已完成 / 下一步**。历史版本全部保留，卡片 Done 之后仍能回看当时做到哪一步。summary 不会改变卡片状态。

![卡片 summary：状态、目标、已完成、下一步](docs/promo/screenshots/03-card-summary.png)

### 4. 任务延伸 ideas

agent 工作时发现的后续事项（顺带发现的 bug、现有方案的局限、下一步）会进入项目的 **Ideas** 收件箱，而不是淹没在对话里。点 **Good idea** 有两条路：在原 session 里继续，或者带着预填好的上下文新建卡片 / 新开 session；**Not now** 则忽略。agent 不会自己建卡或开工。

![Ideas 收件箱，标明来源卡片](docs/promo/screenshots/04-ideas-inbox.png)
![Good idea：新建任务、在原 session 继续，或开新 session](docs/promo/screenshots/04b-good-idea-two-paths.png)

### 5. Project insights

一页看完当天：完成 / 新建 / 返工的卡片数、回合数、agent 时长、commits、token（含缓存命中率）；**等你处理**的列表、基于规则的建议、AI 生成的日报、每张卡的 token 用量和 7 日趋势。

![Project insights：指标、等你处理、建议、日报与 token 用量](docs/promo/screenshots/05-insights.png)

<details>
<summary>深色主题</summary>

![Project insights（深色）](docs/promo/screenshots/05-insights-dark.png)

</details>

## 界面语言

界面默认跟随设备语言，也可以在 **Flowly 设置 → 语言** 中手动选择：English、简体中文、繁體中文、日本語、한국어、Español、Français、Deutsch、Português (Brasil)、Русский。智能体指令、守护进程的错误详情，以及智能体和摘要所写的内容不会被翻译。

| 日本語 | Deutsch |
| --- | --- |
| ![日语界面的看板](docs/promo/screenshots/i18n/ja-JP-board.png) | ![德语界面的看板](docs/promo/screenshots/i18n/de-DE-board.png) |

## 安装

```sh
git clone https://github.com/JasprW/flowly.git && cd flowly
npm install
paseo plugin install "$PWD" --id flowly
paseo plugin reload flowly   # 之后有改动时重载
paseo plugin logs flowly
```

在 Paseo 侧边栏打开 **Flowly**。daemon 所在机器的 PATH 里需要有 `paseo` CLI，用于注册新的原生 project。

## 快速上手

1. **New project**：选择一个目录（或多个仓库），把它注册为原生 Paseo project。
2. **New task**：描述要做的事，可以同时启动第一个 agent。
3. 看卡片自己移动。回答 **Needs you** 的问题，验收 **In review** 的卡片，处理 **Ideas**，一天结束时打开 **Insights**。

## 工作方式

- **一个看板 project 对应一个原生 Paseo project 根目录。** 要跨多个仓库工作，可以把它们放进同一个父目录并注册该目录；也可以让插件建一个“链接根目录”，里面为每个仓库放一个软链接（移除链接不会动目标目录）。
- **一张卡对应一个 workspace**，workspace 里可以有多个 session。由你选择哪个 session 接收指令；普通追问只发送你输入的原文。
- **Agent 工具。** 从卡片创建的 session 会获得四个受限 MCP 工具：`kanban_get_task`、`kanban_update_status`、`kanban_report_progress`、`kanban_propose_idea`，以及说明它们用法的 skill。agent 可以在工作阶段之间和 In review 之间移动自己的卡片；Done 与 Cancelled 由人决定。没有 MCP 的 session 可使用 CLI 兜底。
- **卡片业务状态与 session 执行状态相互独立。** 一轮结束不代表卡片完成。
- **其他能力：** 拖拽（含列内排序）、卡片关联（follow-up、blocks、related）、任务类型与优先级、Done 卡片收尾（预检后归档其 session 和自有 workspace）、键盘快捷键（`?`）、按卡片统计 token、手机紧凑布局。

### 模型

在 **设置 → Models** 里选择新会话默认使用的模型。每个 project 可以在自己的设置里单独指定，优先于全局；两者都没设时，新会话沿用最近一个会话的设置。

![设置 → Models：默认模型和摘要模型](docs/promo/screenshots/settings/models.png)

### 数据与安全

看板数据存放在 daemon 所在机器的 `~/.paseo/plugin-data/flowly/`（`PASEO_HOME` 可指定 daemon 主目录）。写入串行化并原子替换，过期编辑会被拒绝，无效文件会被保留而不是重置。移除或永久删除 project / 卡片前会先备份到 `removed/`。归档插件记录不会删除 Paseo 资源或磁盘目录。工具服务只监听本机回环地址，每个 session 使用独立的私有凭据。

## 开发

```sh
npm install
npm run typecheck
npm test
```

新增或修改文案时，用 `t()` / `tn()` 包起来，并在 [`shared/i18n/`](shared/i18n/) 的每个语言文件里补上译文；`npm test` 会列出缺失项。详见 [`docs/I18N-SPEC.md`](docs/I18N-SPEC.md)。

根目录代码只有 `index.client.tsx` 和 `index.server.ts`；其余在 `client/`、`server/` 和与运行环境无关的 `shared/` 中。设计、spec 与验收记录都在 [`docs/`](docs/)：建议先读 [`SPEC-OUTLINE.md`](docs/SPEC-OUTLINE.md)、[`SINGLE-ROOT-SPEC.md`](docs/SINGLE-ROOT-SPEC.md) 和 [`PROGRESS.md`](docs/PROGRESS.md)。给贡献者和 agent 的项目规则见 [`AGENTS.md`](AGENTS.md)。发布与宣传材料（文案、演示项目脚本、截图脚本）在 [`docs/promo/`](docs/promo/README.md)。

## 许可证

[MIT](LICENSE) © 2026 Bofan Wang

另一个单独安装的 `paseo-kanban` 插件是不同的插件，本插件不会覆盖它。

# Ultra Kanban — 发布 / 宣传材料

一句话：**把 Paseo 里的 agent session 变成一块会自己动的看板。** 你只管派活、拍板、验收；进度、提醒、总结、后续想法和数据复盘由看板自己维护。

## 五个主打功能（截图 → 文案）

| # | 功能 | 截图 | 文案 |
| --- | --- | --- | --- |
| 1 | 自动状态流转 | `screenshots/01-board-auto-status.png`（深色：`…-dark.png`） | agent 开工、规划、编码、验证、交付，卡片自己在 Design → Development → Test → In review 之间移动。回合结束不会擅自 Done，验收权永远在你。 / Cards move across lanes as the agent plans, codes, verifies and delivers. A finished turn never marks a card Done — you do. |
| 2 | 人工介入提醒 | `screenshots/02-needs-you-drawer.png` | agent 遇到需要你拍板的事（如 410 还是 404），会提问并停下；卡片亮起 **Needs you**，顶部 Attention 汇总，Reply 一键直达该 session。 / The agent asks, stops, and the card lights up “Needs you”; Reply jumps straight to the session. |
| 3 | 任务运行 summary | `screenshots/03-card-summary.png` | 每轮结束自动生成：一句话现状、目标、已完成要点、下一步，保留历史版本。Done 之后仍能回看当时做到哪。 / Auto-written after every turn: state, target, recap, next — with version history. |
| 4 | 任务延伸 ideas | `screenshots/04-ideas-inbox.png`、`04b-good-idea-two-paths.png` | agent 干活时发现的后续工作（配置化、Redis 限流、顺带发现的 bug）进入 Ideas 收件箱。Good idea 两条路：在原 session 继续，或新建卡片 / 新 session。 / Follow-up work found along the way lands in an inbox; accept it into the same session or a new card. |
| 5 | Project insights | `screenshots/05-insights.png`（深色：`…-dark.png`） | 一页看完今天：完成/新建/返工、agent 时长、commits、token 用量；「等你处理」列表、规则建议、AI 日报、7 日趋势。 / One page for the day: throughput, agent time, commits, tokens, waiting-on-you, suggestions, an AI daily summary and a 7-day trend. |

## 演示项目

> 截图完成后，演示项目（看板记录、Paseo 项目、Haiku session、临时目录）已清理；需要重拍时用下面的脚本重建。截图脚本会隐藏其他 project 的标签页，并裁掉宿主侧栏。

- **Tinylink**：零依赖 Node 短链服务，6 条提交的真实 git 历史。
- 6 张卡：Done 1 / In review 3（限流、点击统计、自定义别名，均由 Haiku 5.5 真实实现并提交，测试通过）/ Design 1（过期链接 bug，向用户提问中）/ Todo 0 / Backlog 1。
- 3 条 ideas 由 agent 通过 `kanban_propose_idea` 提出（覆盖“在本卡继续”和“新建卡片”两种）。
- 所有 session 均为 `claude/claude-haiku-5-5`。

## 复现 / 重拍

```
node docs/promo/setup.mjs                         # 建 Tinylink 仓库、项目、卡片，并启动 3 个 Haiku session
node docs/promo/start-session.mjs "Custom aliases" "<prompt>"   # 追加一个 session
node docs/promo/shots.mjs 01 01d 02 03 04 05 05d  # 截图（headless Chromium，2× 分辨率，裁掉宿主侧栏）
```

截图只裁取插件面板，不含宿主侧栏里的个人 workspace。

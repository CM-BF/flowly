# Agent 自管进度：调研与 v1 方案

状态：设计草案，2026-10-15，待用户确认后写实施 spec。取代 [PHASE-03-SPEC](PHASE-03-SPEC.md) 中“全部靠 agent 调工具”的思路；后者的工作流、阶段、审批设计作为本方案的远期扩展保留。

## 1. 现状问题

现在卡片状态只在 agent **主动调用** `kanban_update_status` 时变化。实测：
- 显式要求汇报的 F1–F4 每张都正确走完 Todo → In progress → In review。
- 没接工具或没收到指示的 session，84 轮里状态零变化。

“靠 agent 自觉”不稳定。更重要的是，系统其实已经知道很多事实：session 开始一轮、结束一轮、失败、等待授权、你又发了消息。这些都没被用来推进卡片。

## 2. 其他产品怎么做

| 产品 | 状态来源 | agent 要做什么 | 人的环节 |
| --- | --- | --- | --- |
| **Vibe Kanban** | 主要由**执行生命周期**驱动（第三方资料）：卡片拖到 In Progress 即建 worktree 并启动 agent；agent 执行结束卡片进入 In Review；要求修改后回到 In Progress。新版改为 workspace 状态，含 “Needs Attention: agent finished or needs input” | 几乎什么都不用做 | 看 diff、给反馈、开 PR、合并 |
| **GitHub Copilot coding agent** | **PR 状态**：指派 issue 后开 PR，做完后请求你 review | 完成时请求 review | 在 PR 上评论让它迭代 |
| **Linear agents** | 两层：**session 状态**（pending/active/awaitingInput/error/complete/stale）由 Linear 根据 agent 最后一条 activity **自动推导**；**issue 状态**由 agent 在开始时移到第一个 started 状态 | 发 activity：thought / action / elicitation（需要输入）/ response（完成）/ error；可选 plan 清单（pending/inProgress/completed/canceled，整体替换） | 回复 elicitation；验收 |
| **Multica** | agent 通过 CLI 改 issue 状态；执行完成不改状态；失败且无重试时 in_progress 回退 todo；PR 合并可自动 Done | 按说明改状态、评论 | 评论即触发新一轮；人设 Done |
| **Backlog.md** | 任务是仓库里的 Markdown 文件，agent 用 CLI/MCP 认领并改状态 | 遵守验收标准和 Definition of Done | 审 spec、审计划、审代码三个检查点 |

共同规律：
1. **生命周期事实由系统推导**（Vibe Kanban、Linear 的 session 状态），不靠 agent 记得报。
2. **agent 只报系统推导不出的语义**：我需要输入、我做完了、我的计划是什么（Linear 的 elicitation/response/plan，Copilot 的 request review）。
3. **人的消息本身就是状态信号**：要求修改 → 回到进行中（Vibe Kanban、Copilot、Multica）。
4. **Done 留给人或外部事实**（PR 合并）。

## 3. 方案：事实 → 规则 → 状态

```
信号（事实）                     规则（项目级，可开关）           结果
─────────────────               ──────────────────────          ─────────────
session 生命周期 hook  ──┐
  turn 开始/结束/失败     │
  授权请求/处理            ├──▶  小型规则表（daemon 内）  ──▶  卡片状态变更（带原因）
agent 报告（工具）         │      trigger + condition + action    卡片标记（需要你/静默/出错）
  progress/question/result│                                     活动记录（可追溯）
人的操作                   │
  发消息/拖拽/验收        ──┘
```

### 3.1 信号

- **session 生命周期**：已有的 `agent.turn_started`、`agent.turn_ended`（含 outcome），以及 `agent.permission_requested/resolved`、`agent.archived`。只看**看板管理的 session**（见 PHASE-02 修订）。
- **agent 报告**：保留现有工具，`kanban_report_progress` 的 kind 增加 `question`（需要你回答）。`result` 表示“我认为交付了”。不新增工具，agent 只需记住两个词：有问题报 `question`，做完报 `result`。
- **人的操作**：在卡片或 session 中给看板管理的 session 发消息、拖拽、验收。

### 3.2 v1 默认规则

| # | 触发 | 条件 | 动作 |
| --- | --- | --- | --- |
| R1 | 看板管理的 session 开始一轮 | 卡片在 Backlog/Todo | → **In progress**（对应 Linear 的 “first started status”、Vibe 的拖入即开工） |
| R2 | agent 报告 `result` 或设 in_review | 卡片未完成 | → **In review**（已有） |
| R3 | 看板管理的 session 结束一轮 | 卡片 In progress；本轮无任何报告；同卡没有其他运行中的 session | 卡片标记 **“等你看”**，进入 Attention；**不改状态** |
| R4 | agent 报告 `question` | — | 卡片标记 **“需要你回答”**，进入 Attention；不改状态（D2） |
| R5 | 回合失败 / 等待授权 | — | 卡片标记出错 / 等授权（已有） |
| R6 | 人给该卡的看板管理 session 发消息 | 卡片在 In review 或 Blocked | → **In progress**（“要求修改即回到进行中”）；清除“需要你回答”标记 |
| R7 | Done / Cancelled | — | 只能由人设置（未来可加 “PR 已合并”） |

规则与现有约束的关系：
- 业务状态变化来自**明确的事实**，不来自“一轮结束 = 完成”。R3 只打标记不改状态，回合结束仍然不会自动完成卡片。
- R1、R6 由系统改状态，需要修订 AGENTS.md 中“业务状态与执行状态独立”一条：改为“由项目规则基于明确事实推导，可按项目关闭，每次变更记录触发原因”。

### 3.3 为什么更轻量、更有效

- **agent 不报也能走对大半**：开工（R1）、等你看（R3）、打回续工（R6）都由系统推导，覆盖“84 轮零变化”的情况。
- **agent 只需最小协议**：两种报告（question / result），skill 可以压缩到几行。
- **每次状态变更都带原因**：活动里显示“由 R1：session X 开始工作”，人能看懂、能撤销（拖回去即可）。
- **不引入新存储**：规则在 daemon 的 hook 中执行，沿用现有串行写、CAS 和活动记录。

### 3.4 扩展路径（不在 v1）

规则表的 trigger/condition/action 都是可枚举的类型，后续扩展只需加类型：

| 扩展 | 加什么 |
| --- | --- |
| 可配置工作流 / 阶段（PHASE-03 D1） | condition 支持 stage；action 支持 set_stage；项目级编辑 UI |
| 计划清单（Linear plan） | 新信号 `plan_updated`，卡片显示进度条 |
| PR 合并 → Done | 新信号 `pr_merged`（轮询 gh/glab） |
| 回合结束直接进 Review（Vibe 模式） | 把 R3 的动作改为 → In review，作为项目选项 |
| 自动开工队列 | 新触发：卡片进入 Todo → 启动 session |
| 失败重试 / 卡住检测 | 新触发：超时、失败次数 |

## 4. 待确认

1. 是否接受 R1、R6 由系统改状态（需修订 AGENTS.md），默认开启、可按项目关闭？
2. 回合结束且无报告时（R3），v1 只打“等你看”标记（推荐），还是像 Vibe Kanban 直接进 In review？
3. `question` 标记的回答方式：v1 直接复用 session 输入框（回复即清除标记，推荐），还是做专门的回答区（PHASE-03 方案）？

## 参考

- Vibe Kanban（状态流转为第三方资料，官方 README 已标注 sunsetting）：https://github.com/BloopAI/vibe-kanban ，https://vibekanban.com/docs/core-features/monitoring-task-execution
- Linear agents：https://linear.app/developers/agent-interaction ，https://linear.app/developers/agent-best-practices
- GitHub Copilot coding agent：https://docs.github.com/en/copilot/using-github-copilot/coding-agent/using-copilot-to-work-on-an-issue
- Backlog.md：https://cdn.jsdelivr.net/gh/MrLesk/Backlog.md@main/README.md
- Multica：本地源码调研（commit 52b2690），见对话记录

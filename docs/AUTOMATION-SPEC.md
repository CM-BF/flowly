# 智能体自动化：把 Hermes Kanban 的 agent 自动化搬进 Flowly（AUTOMATION-SPEC）

状态：2026-10-22 用户要求实现（“把 hermes 的 kanban 的 agent 自动化集成到 paseo 的 flowly 插件上”），已实现，待用户验收。方向来自用户此前在 “设计 Flowly × Kanban 整合” 卡上的决定：**在 CM-BF/flowly fork 内置**，不另做适配插件，不建第二套看板。来源：Hermes `hermes-agent` 的 `cron/AGENTS.md` Kanban 一节、`website/docs/user-guide/features/kanban.md`、`agent/prompt_builder.py` 的 `KANBAN_GUIDANCE`、`skills/devops/sdlc-review`；Flowly 的 [ROADMAP-V2](ROADMAP-V2.md) M4–M6 与 [SYMPHONY-RESEARCH](SYMPHONY-RESEARCH.md) §3 “远期”。

## 1. 范围与约束变更

Hermes Kanban 的 agent 自动化有四块：**dispatcher**（依赖、并发、优先级、认领、启动 worker）、**worker 协议**（交付 / 阻塞 / 提问，静默退出算违规，有界提醒与重试，熔断后自动 block）、**review 回路**（交付后由 reviewer profile 审，`request_changes` 打回实现者）、**编排**（triage 自动拆卡、orchestrator 建子卡、goal 模式、定时开始）。本 spec 实现前三块；第四块见 §9。

| AGENTS.md 原约束 | 变更 |
| --- | --- |
| “Automatic assignment, multi-agent handoffs, role orchestration … are outside v1” | 例外（用户要求，2026-10-22）：**按项目开启、默认关闭**的智能体自动化可以自动启动已排队卡片的 session、在实现者与评审者之间交接、对静默/失败的回合发送提醒与重试。跨 host 调度、PR 自动化仍不做。agent 建卡与子卡片由 [SUB-CARDS-SPEC](SUB-CARDS-SPEC.md) 补上（用户决定，2026-10-22）。 |
| “ordinary follow-up sends exactly the user's text” | 不变。自动化发出的消息（开工、提醒、重试、评审、修改要求）是插件发起的显式 Kanban 消息，统一以 `[Flowly automation]` 开头，不冒充用户。 |
| “A turn ending never automatically completes the card” / Done 由人决定 | 不变。自动化从不把卡片移到 Done/Cancelled。评审通过时卡片留在 In review。 |
| 自动化可以改卡片状态吗 | 只有两处，均为系统事件并带 rule：放弃时把卡片移到 Blocked（`rule="AUTO"`，同 Hermes 熔断 auto-block）；评审要求修改时从 In review 回到工作阶段（`rule="REVIEW"`，与人的评审反馈触发 A1 落到同一阶段）。 |

与此前设计稿的取舍（`flowly-hermes-design.md`，已读回）：保留“单一卡片身份、状态与卡片同一事务、显式排队、依赖必须 Done、不自动 Done、无 PR 自动化”；协议版本/能力探测/outbox/多仓库 fingerprint 不做——Flowly 的 store 已是唯一写者，session 创建用已有的 prepared-identity + idempotencyKey 保证不重复，足以覆盖重启恢复（§4.4）。

## 2. 项目设置

`project.automation?: AutomationSettings`（缺省 = 关闭），`projects.update` 整体替换；编辑项目 → **Agent automation**。

| 字段 | 默认 | 含义（Hermes 对应） |
| --- | --- | --- |
| `enabled` | — | 总开关。关闭后不派发、不监督；已有 job 保持原状，再打开继续。 |
| `maxRunning` | 2 | 同时占用名额的卡片数（`max_in_progress`）。`starting/working/reviewing/retry_wait` 占名额；等人回复的不占。 |
| `implementer` | 无 | 实现者模型；无则用项目默认模型 → 全局默认模型 → 第一个可用 provider 的默认模型。 |
| `reviewer` | 无 | 评审者模型；无则不做 agent 评审（`review_dispatch=false`）。 |
| `maxReviewRounds` | 3 | 一个交付周期内最多几轮评审。 |
| `fullAccess` | true | session 用 provider 的免审批模式（claude `bypassPermissions`、codex `full-access`），其它 provider 用默认模式。 |
| `nudgeLimit` | 2 | 静默结束后的提醒次数（stop nudge）。界面不暴露。 |
| `failureLimit` | 2 | 连续失败回合上限（`failure_limit`）。界面不暴露。 |

## 3. 数据

`board.json` 新增 `automation: AutomationJob[]`（缺省读作空数组，看板版本仍为 5），随 etag/patch 看板读取到达客户端（`automation` 按 `taskId` 匹配）。删卡、移除项目时一并删除。job 不改 task revision，agent 手里的签名请求不受影响。

```
AutomationJob {
  taskId, projectId,
  state: queued | starting | working | needs_human | waiting | retry_wait | reviewing | delivered | stopped | failed,
  role: implementer | reviewer,          // 当前被监督的是谁
  implementerId?, reviewerId?,            // 两个 session（都在卡片自己的 workspace，都是 Flowly 管理的 session）
  generation,                             // 每次排队 +1
  nudges, failures, reviewRounds,
  verdict?: approved | changes | incomplete,
  code?: question | blocked | permission | interrupted | stopped | card_moved | card_finished
       | no_delivery | failed | start_failed | session_unavailable | review_rounds | review_incomplete | sub_cards | cooldown,
  detail?,                                // daemon 文本（错误、评审摘要），不翻译
  retryAt?, turnAt?, pendingOp?,
  queuedAt, startedAt?, updatedAt
}
```

`turnAt`：早于或等于它的回合结束不归本 job 处理（已处理，或早于最后一条指令）。`pendingOp`：正在创建的 session 的 preparation，重启后用同一个 op 再建同一个 id，绝不建第二个。

## 4. 生命周期

### 4.1 排队与派发（dispatcher）

- **Run with agent**（`automation.queue`）：卡片未归档、不在 Done/Cancelled、项目已开启、没有活着的 job。新 job 为 `queued`，`generation+1`，沿用上一次的 implementer session。活动记一条 `automation_queued`。
- dispatcher 每 15 秒一次，排队、停止、回合结束、移动卡片时也会立即跑一次（并发调用合并为下一次）。每个开启的项目：到期的 `retry_wait` 先恢复；再按优先级（urgent > high > normal > low）、排队时间把满足条件的 `queued` 填进空名额。
- **依赖**：沿用卡片的 `blocks` 链接。所有 blocker 都 **Done** 才放行；Cancelled（或未完成就归档）的 blocker 永不放行，直到人删掉链接——没完成的工作不能作为输入。
- **认领**：同一事务里 `queued → starting`，记 `automation_started`。随后在卡片 workspace 里：有活着的 implementer → 发“重新排队”开工消息；否则 `prepareSession`（与侧栏 Start session 同一路径，带 Flowly MCP、上下文与 skill）创建新 session，`labels: { flowly-task, flowly-automation: implementer }`，首条消息为开工说明。
- 首条开工说明（`startPrompt`）：无人值守、按 Flowly skill 走、最后以 `in_review` 交付或以提问/`blocked` 结束，不要等人、不要猜；若配置了评审者，提示交付后会被评审。

### 4.2 回合结束（worker 协议）

回合结束钩子先跑原有规则（记录 lifecycle、A1r），再交给自动化；自动化从看板上的 `agent.turn_ended` 事件读结果，所以钩子与对账走同一路径（§4.4）。只处理当前被监督的 session（`role` 对应的 id）。

| 情况 | 结果 |
| --- | --- |
| 卡片已 Done/Cancelled/归档 | `stopped` / `card_finished` |
| 回合失败 | `failures+1`；未到上限 → `retry_wait`，退避 30 s·2^(n−1)，最长 5 分钟，到期在同一 session 发“上次失败：…，从当前状态继续”；到上限 → 实现者：`failed` + 卡片移到 Blocked；评审者：见下 |
| 回合被中断 | `needs_human` / `interrupted` |
| 实现者交付（卡片在 In review） | 有评审者且轮次未满 → 开始评审（§5）；否则 `delivered`（轮次用完记 `review_rounds`） |
| 实现者本回合自己把卡片设为 Blocked | `needs_human` / `blocked`（卡片因别的原因停在 Blocked，例如重新运行时 A1r 在静默回合后把它恢复为 Blocked，按静默结束处理） |
| 本回合提了问题或报了 blocker（`kind=question/blocker`） | `needs_human` / `question` |
| 其它（静默结束） | 提醒未满 → `nudges+1`，发提醒；满了 → 实现者：`failed` / `no_delivery`，卡片移到 Blocked；评审者：见 §5 |

`needs_human` 的 session 开始下一回合（人回复了）→ 回到 `working`/`reviewing`，提醒计数清零。权限请求：`agent.permission_requested` → `needs_human` / `permission`，`permission_resolved` → 恢复。`delivered` 后实现者因人的反馈开始新回合 → 回到 `working`、评审轮次清零（Hermes reopen-review），下次交付再评审。

放弃时移到 Blocked 的条件：Blocked 泳道开启，卡片在 Backlog/Todo 或工作阶段；In review 的卡不动。

### 4.3 人的操作

- **Stop automation**（`automation.stop`）：job → `stopped`；不打断、不归档任何 session（要打断用 Paseo 自己的停止）。
- 人把卡片移到 Done/Cancelled → `stopped`/`card_finished`；移到 Backlog，或在 agent 已开工后移到 Todo/Blocked → `stopped`/`card_moved`。工作阶段之间的移动不影响。
- 删卡、移除项目：job 一并删除；session 照旧（删卡本身的归档选项不变）。

### 4.4 重启与漏掉的钩子（对账）

每次派发前对每个活着的 job：
- `starting` 或有 `pendingOp` 且超过 2 分钟没进展：用同一个 op 重新 `prepareSession`（得到同一 agentId），已存在就只补状态，不存在才创建（idempotencyKey 同侧栏）。
- 被监督的 session 已归档或不存在：实现者 → `failed`/`session_unavailable`；评审者 → 交付保留给人（`incomplete`）。
- 看板上已有晚于 `turnAt` 的 `agent.turn_ended`（钩子在处理前插件被重载等）：补做 §4.2。`needs_human` 时已有更晚的 `agent.turn_started`：补做恢复。

插件 SDK 只在 RPC/钩子上下文里提供 Paseo 连接；dispatcher 用最近一次拿到的连接。daemon 重启后在第一次 RPC 或钩子到来前不派发（看板打开即会到来）。

## 5. 评审回路

- 实现者交付后：`role=reviewer`、`reviewing`、`reviewRounds+1`，记 `automation_review_started`。首轮在同一 workspace 创建评审 session（`labels.flowly-automation=reviewer`，标题 `Review: <卡片>`）；之后各轮复用它，被归档则新建。
- 评审说明（`reviewPrompt`）沿用 Hermes `sdlc-review` 的分轮视角：第 1 轮先冷读 diff 再对照交付说明；第 2 轮亲自运行构建、测试与所述行为；第 3 轮起逐条对照原卡验收标准和此前每轮的修改要求。只评审，不改文件、不提交、不改卡片状态。
- **规则 A1 例外**：活着的评审 session 开始回合时不把卡片从 In review 拉回工作阶段（它不是在做卡片的工作）。
- 新工具 `flowly_submit_review { verdict: approve | changes, summary, findings[] }`（MCP；CLI API 动作 `review`，CLI 命令行未加——自动化创建的 session 总有 MCP）：
  - 只接受该卡当前 job 的 `reviewerId`，否则 `NOT_REVIEWER`；本轮已结束或卡片不在 In review → `REVIEW_CLOSED`；同一结论重复调用 → `replayed`。
  - `approve`：job `delivered`、`verdict=approved`，卡片留在 In review，记 `automation_review_approved`（附摘要）。
  - `changes`：卡片回到 `resumeStage`（通常 Development，`rule="REVIEW"`），job 回到实现者 `working`，把摘要与发现以 `[Flowly automation] The reviewer requested changes …` 发给实现者，记 `automation_changes_requested`。
- 评审者回合结束没给结论：提醒（同 §4.2）；满了或失败到上限 → job `delivered`、`verdict=incomplete`，卡片留在 In review 给人。

## 6. 界面

1. **卡片信号行**：Queued for agent / Starting agent… / Agent working / Agent reviewing（脉冲点）/ Agent retrying / Agent waiting for you / Agent needs permission / Agent review passed / Review needs you / Automation stopped（失败时）。`stopped` 与不带评审的 `delivered` 不显示（泳道已说明）。
2. **卡片详情**：标题与标签下一行 “Agent automation · 状态”，附原因、daemon 文本与计数（评审第 n/m 轮、提醒 n/m、失败 n/m），按钮 Run with agent / Run again / Stop。项目未开启且没有 job 时不显示。
3. **菜单**：卡片右键/⋯、手机操作表、详情菜单都有 Run with agent（项目开启且卡片未结束）或 Stop automation（job 活着）。
4. **编辑项目**：Agent automation 开关；开启后 Cards at once（1/2/3/5）、Implementer、Reviewer（模型选择沿用默认模型控件，“无”分别为项目默认模型 / 不评审）、Review rounds（有评审者时）、Full access。
5. **活动**：`automation_*` 事件各有文案；daemon 写的 note（“Reminder 1 of 2” 等）保持英文。
6. **新手引导**：一次性提示 `agent-automation`（项目有 Backlog/Todo 卡、未打开卡片时，排在 first-card 之后）；欢迎页 More features 增加 Agent automation。README Highlights 增加一节。

## 7. Skill

`skills/flowly/SKILL.md` 新增 “Automated runs”：首条指令以 `[Flowly automation]` 开头时无人值守，一次做到交付；每回合以交付、提问或 blocked 结束；按 `[Flowly automation]` 消息行事；评审者只评审，用 `flowly_submit_review` 结束本轮。原有 “不要自行交接、分派或完成” 不变（交接由 daemon 做）。

## 8. 验收

- 纯函数（`shared/automation.test.ts`）：依赖必须 Done、Cancelled 不放行；按优先级填名额、等人回复不占名额、关闭的项目不派发；重试到期；交付→评审/交付给人/轮次用完；提问与 blocker 等人；静默提醒到上限后 block；失败重试与放弃；中断等待；评审者无结论提醒后交给人且不 block；非监督 session 忽略；只有活着的评审者豁免 A1。
- 服务（`server/automation.test.ts`，假 SDK）：未开启时拒绝排队；排队后在卡片 workspace 创建无人值守 session（模型、模式、标签、开工说明）；名额、优先级与 blocker；提醒与 block 且同一回合结束不处理两次；提问等待与回复恢复；失败退避重试与放弃；创建失败重试后报告且不动卡片；评审回路（非评审者拒绝、修改→Development 并发给实现者、重复结论 replayed、第二轮复用评审 session、批准后留在 In review）；人移动卡片停止且不动 session、再次排队复用 session；钩子漏掉的回合结束由对账补上；被监督 session 归档后结束。
- 真实 daemon + Web UI（按 open-paseo-plugins/AGENTS.md）：安装到本机 daemon，用 app.paseo.sh 验证设置、排队、真实 agent 跑到交付、评审回路与卡片/详情显示；fixture 项目与 session 用后清理。结果记在 [verification/automation.md](verification/automation.md)。

## 9. 不做（本期）与后续

- **编排**：已由 [SUB-CARDS-SPEC](SUB-CARDS-SPEC.md) 实现（agent 建卡/子卡、依赖、父卡等待与唤醒）。仍不做：triage 列由 LLM 自动拆卡（Hermes decomposer）。
- goal 模式（每回合由裁判模型判定是否达成）、定时开始（`scheduled_at`）、按卡片指定执行者/模型、per-profile 并发、心跳/超时回收（Paseo 自己的 session 状态已覆盖进程存活；长时间 running 只靠人看）。
- 依赖 Done 不等于上游代码已进入下游 worktree（此前设计稿指出）：本期由人保证；下游 agent 会在上下文的 links 里看到 blocker 及其状态。
- 降级到上游 Flowly：旧版本解析 `board.json` 时会丢弃 `automation` 与 `project.automation`（zod 非严格对象），卡片与其它数据不受影响。


## 10. Review hardening (2026-10-22)

- Stop、人的接管、卡片/项目归档优先于旧异步操作。每次事务与创建/发送之前重读 generation、role、当前归属和 enabled；关闭项目自动化冻结 job，归档停止 job，但不打断或归档 session。取消/归档祖先也停止后代的 job，不改后代泳道。
- `pendingOp` 增加 `pendingRole`。实现者与评审者不得使用同一 preparation/session；放弃评审、角色转换和确认创建后清除 preparation。Run again 保留已知的两种角色 session 供复用。
- 修订 §1 的 outbox 取舍：每个 job 只保存一个 `instruction {id, role, text, fresh}`，与状态转换同事务写入。原文及稳定 messageId 在重载/发送失败后保留；确认送达后删除。它不是通用工作流队列。`feedback` 保存父卡给子卡的修改要求。
- 发送前检查实际 session 的 running/initializing、activeTurn 和 pending permissions，忙时保留指令，下一次派发再试；显式 `activeTurnBehavior=steer`。Paseo 0.12 没有原子的 idle-only send：检查与请求到达之间仍有竞态，且 steer 不可用时 daemon 可回退为 interrupt；这是宿主 API 限制，不能声称严格不打断。已完成 message receipt 可安全重放；`agent_request_outcome_unknown` 暂停为 needs_human/interrupted，让人检查 session，绝不换 ID 盲发。
- 真实 refresh RPC 失败是未知状态，不当作 session 消失。只有确定不存在/已归档/工作区不匹配才结束或替换。stale starting 或缺少角色 session 会重做原创建路径。若回合钩子完全丢失，超过 2 分钟后确认 session idle 且无 activeTurn/permission，则保守地进入 needs_human/interrupted 并释放名额；不伪造成功回合或编造 lifecycle 事件。
- `deliveryEvent` 记评审的实际 agent 交付事件，`reopened` 区分交付后反馈。A1r 恢复旧 In review 不启动新评审；有实际新交付才重开评审计数。实现者在评审期间开始工作会关闭旧评审归属，旧 reviewer 的迟到结论不生效；别的 managed session 接管时停止原自动化。旧 verdict 只在当前交付有效。
- 成功回合清零连续失败计数。明确的 429/rate-limit/quota/overload 失败使用 `cooldowns`（最多 5 次，1、2、4、8、15 分钟），不消耗普通 failureLimit；`provider` 来自实际当前 session，冷却期间同 provider 不再启动排队卡。超过上限等人处理，不把整个队列刷成 Blocked。
- 自动化需要启用 In review。项目设置拒绝不满足的组合，旧无效配置不派发；queue 同样拒绝。启动与父卡唤醒都检查 maxRunning 和工作区实际目录，Flowly 不会向同一物理目录派发另一个卡的 worker；Stopped/permission job 的 native session 若仍活跃，也保留目录占用。人的直接操作不受此调度规则控制。
- `waiting`、`sub_cards`、`subSeen` 为子卡等待协议字段；父卡唤醒遵守同一项目开关、归属和名额。发送的是当前子卡 handoff（有界的交付、workpad 检查、目录、分支、未满足 blocker），原文失败后保留。Stop、批准评审、删除卡片和项目设置变化立即触发 dispatcher。
- daemon 发出的 `[Flowly automation]` 文本不计入人的 memory clue 或 next-move 选择率；摘要保留内容但标作 Flowly automation。

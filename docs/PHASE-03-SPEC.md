# Phase 3（M3）：可配置工作流与人机闭环

状态：**暂缓**（2026-10-14 用户调整优先级：当前以人工多任务管理为主，agent 自动调整是远期目标）。本文保留为远期设计，实施前需重新确认。
上游：[ROADMAP-V2](ROADMAP-V2.md) M3，用户已确认决策 D1–D6：
- D1：工作流可配置，内置一套默认，允许用户自定义。
- D2：需要人回答时不改业务状态，只在卡片上出标记。
- D3：设计门禁默认关闭，可按阶段开启。
- D4：收尾归档策略属于 M4，本阶段不实现。
- D5：回复或打回后自动续工。
- D6：收件箱包含 session 信号。

继承 Phase 1/2、single-root、UI refresh 的全部约定，除非本文明确修订。

## 1. 目标

agent 在卡片 workspace 里按项目工作流推进阶段，需要人时在卡片上留标记。人在卡片、收件箱或原生 session 的 chip 上回答、批准或验收，答复自动送回发起的 session，agent 继续工作。卡片业务状态只由 agent 工具调用或人的操作改变，session 事件只产生提示。

不在本阶段：一键开始与 playbook 默认 agent（M4）、自动接入原生新建 session（M4）、Done 后的收尾与归档（M4）、Git 信息（M4）、自动启动与重试（M5）、自定义看板列（候选）。

## 2. 工作流模型

### 2.1 定义

工作流是一组有序阶段，只在业务状态为 In progress 时推进。看板的 7 个业务列保持不变：agent 权限、Finished 筛选和后续收尾都依赖它们。自定义列另行评估。

| 字段 | 约束 | 说明 |
| --- | --- | --- |
| `id` | 创建时生成的稳定 slug，1–40 字符，项目内唯一 | 卡片引用它；改名不改 id |
| `name` | trim 后 1–40 字符，项目内唯一（不区分大小写） | 卡片和工具中显示 |
| `instructions` | ≤ 4000 字符 | 本阶段要做什么；随 `get_task` 下发给 agent |
| `exitCriteria` | ≤ 2000 字符 | 进入下一阶段前须满足的条件 |
| `gate` | `none` 或 `human` | `human`：离开本阶段进入后一阶段前须由人批准 |

一个工作流有 1–8 个阶段，另有 `revision`（正整数）和 `updatedAt`。

内置默认工作流：

| id | name | gate | 要点 |
| --- | --- | --- | --- |
| `design` | Design | none | 理解需求，阅读相关代码，写出方案、取舍与验证计划，用 progress 汇报方案 |
| `develop` | Develop | none | 按方案实现，保持改动范围；偏离方案时先汇报 |
| `verify` | Verify | none | 运行验证（typecheck、测试、实际使用），记录通过、失败和未运行项；失败回到 Develop |

### 2.2 作用范围与编辑

- 每个项目有自己的工作流。没有自定义的项目使用“新项目默认工作流”：初始为内置默认，用户可把任一项目的工作流设为新项目默认。新建项目时复制当前默认。
- 入口：项目选择弹窗 →“Workflow”。编辑弹窗支持增、删、改名、上移/下移，编辑 instructions/exitCriteria，开关 gate，以及“恢复内置默认”和“设为新项目默认”。
- 保存时对项目工作流 `revision` 做 CAS，冲突返回 `REVISION_CONFLICT`，草稿保留。
- 删除仍被未归档、未完成卡片引用的阶段会被拒绝（`STAGE_IN_USE`），并列出这些卡片。改名、调整顺序和改 gate 立即生效。
- 修改工作流会增加项目工作流 revision，**不增加** `project.revision`，因此不会让 agent 的普通写入因工作流编辑而冲突。agent 下次读取时拿到新定义。
- 已归档项目只读。legacy 多 repo 卡片同样适用工作流。

### 2.3 卡片的阶段

- `task.stage`：阶段 id 或 null。
- 卡片进入 In progress 且 stage 为 null 时，自动设为第一个阶段，同一次提交、同一条活动记录完成。
- 卡片离开 In progress（Review、Blocked、Done 等）时保留 stage，显示为“停在哪个阶段”。回到 In progress 时继续该阶段。
- 人可随时在侧栏改阶段：未归档、未完成的卡片均可，不受 gate 约束（人即审批者）。这会增加 task revision。
- stage 指向的阶段若已不存在（例如编辑被并发绕过、导入的旧数据），显示为“Unknown stage”，agent 读取时 `stageValid=false`。agent 或人设置一个有效阶段即可恢复。

### 2.4 agent 切换阶段

`flowly_set_stage(stage, note)`：

- 只在状态为 In progress 时可用，否则返回 `STAGE_NOT_ACTIVE`。目标须为当前工作流中的阶段，否则返回 `STAGE_UNKNOWN`。
- 向后移动或同阶段（仅记活动）始终允许。
- 向前移动时，若当前阶段到目标之间（含当前阶段、不含目标）有 `gate=human` 的阶段：不移动 stage，创建一个 `approval` 请求（第 3 节）。返回 `{ pendingApproval: requestId }`，结果标记为 accepted-not-applied。卡片已有同一 from→to 的未结 approval 时，直接返回该请求，不重复创建。
- 成功移动时增加 task revision，记录 `stage_changed` 活动（from/to stage id 与名称、note、agentId）。

## 3. 请求（“需要你”标记）

### 3.1 种类

| kind | 来源 | 人的操作 | 结果 |
| --- | --- | --- | --- |
| `question` | agent `flowly_request_human` | 选一个选项或填写回答 | 答复送回发起的 session |
| `approval` | 阶段 gate（2.4） | Approve 或 Reject（Reject 须填意见） | Approve：stage 前进，通知 session；Reject：stage 不变，意见送回 |

请求**不改变业务状态，不增加 task revision**，只增加 board revision 并记活动。卡片因此可以一边保持 In progress 一边显示“需要你”。agent 可以继续做其他部分，也可以等待；skill 要求它在 note 中说明是否会等待。

### 3.2 数据

`board.requests[]`：

| 字段 | 说明 |
| --- | --- |
| `id` | `req_` 加随机串，显示时取短号 |
| `taskId` / `agentId` | 所属卡片与发起的 session（approval 记录触发 gate 的 session） |
| `kind` | `question` 或 `approval` |
| `question` | trim 后 1–4000 字符；approval 由系统生成，如 “Approve moving from Design to Develop” |
| `options` | 0–6 个，每个 1–200 字符，不可重复；仅 question 使用 |
| `stageFrom` / `stageTo` | 仅 approval 使用 |
| `createdAt` | 创建时间 |
| `state` | `open`、`answered`、`approved`、`rejected`、`withdrawn`、`dismissed` |
| `answer` / `closedAt` / `closedBy` | `closedBy` 为 `human` 或 agentId |
| `delivery` | `{ state: pending/sent/failed/unknown, at, error, agentId }`；仅人关闭请求时产生 |

约束：每卡最多 10 个 open 请求，超出返回 `REQUEST_LIMIT`；关闭后不可再关闭（`REQUEST_CLOSED`）。每卡保留全部 open 请求和最近 50 个已关闭请求；被清理的已关闭请求仍可从活动记录追溯。

### 3.3 关闭方式

- **人回答或批准**：RPC `requests.resolve({ id, action: answer/approve/reject/dismiss, answer?, operationId })`。
  - `answer`：须为某个选项原文，或 1–10000 字符的自由回答。
  - `reject`：须带意见。
  - `dismiss`：表示“不需要了”，不投递。
  - 同一 `operationId` 重放返回首次结果。
- **agent 撤回**：`flowly_withdraw_request(requestId, note)`，只能撤回自己发起的 open question。approval 由人处理，agent 撤回 approval 返回 `REQUEST_CLOSED` 之外的 `INVALID_REQUEST`。
- **卡片归档或进入 Done/Cancelled**：剩余 open 请求自动转为 `dismissed`（closedBy=system），不投递。

### 3.4 投递（D5 自动续工）

关闭后由 daemon 投递，不依赖客户端在线：

1. 先在 store 中提交关闭结果，`delivery.state=pending`。
2. 用 SDK 刷新目标 session，须仍属于该卡 workspace 且未归档。session 正在运行时用 `activeTurnBehavior: "steer"` 发送，空闲时直接发送。
3. 按结果写回 `sent` 或 `failed`（附错误）。

投递内容是显式的 Kanban 消息，带标识，和“普通 follow-up 原样发送”的规则区分：

```
[Ultra Kanban] Reply to request R-1a2b on "<card title>"
Question: <question>
Answer: <answer>
```

approval 的消息为 `Stage gate approved: Design → Develop. Continue with Develop.` 或 `Stage gate rejected (stay in Design): <comment>`。

失败与恢复：
- 投递失败时请求仍为已关闭，卡片显示“未送达”，提供“重试”或“改投到其他 session”。改投只能选同卡 workspace 内的 session。
- daemon 在 pending 状态重启时，把状态标为 `unknown`，不自动重发以免重复，由人决定是否重发。
- 重发需要显式操作，并记录新的投递活动。

## 4. Review 与验收

### 4.1 agent 提交

`flowly_submit_review(summary, verification, notRun?, links?)`：

| 字段 | 约束 |
| --- | --- |
| `summary` | 1–6000 字符 |
| `verification` | 1–6000 字符 |
| `notRun` | 0–4000 字符 |
| `links` | ≤ 10 个，每个 1–500 字符 |

- 仅从 In progress 或 Blocked 提交，否则返回 `INVALID_STATUS`。
- 一次提交内完成：状态改为 In review、写入 `task.review`（id、agentId、submittedAt、上述字段、verdict=null），增加 task revision，记录 `review_submitted` 活动。
- 原 `flowly_update_status(in_review, note)` 继续可用，视为只有 summary 的交付。

### 4.2 人验收

RPC `tasks.review({ id, revision, verdict, comment?, operationId })`，要求卡片当前为 In review：

- **Approve**：状态改为 Done，`review.verdict=approved`。M3 不做任何资源收尾。
- **Request changes**：须带意见。状态改回 In progress，stage 不变，`review.verdict=changes`，意见按 3.4 的方式投递给 `review.agentId`：`[Ultra Kanban] Changes requested on "<title>": <comment>`。该 session 不可用时，弹出同卡 session 列表供改投。agent 收到后自行决定回到哪个阶段。
- 人直接拖拽或在状态菜单改状态仍然允许。若卡片有未定的 review，记为 `verdict=bypassed`，不投递。

## 5. Session 信号（D6）

信号来自 hook 和 SDK，只做提示，不改业务状态。在卡片、收件箱和侧栏中与请求分组显示。

| 信号 | 判定 | 清除 |
| --- | --- | --- |
| 等待授权 | session 有 pending permission，沿用现有判定 | 授权被处理 |
| Turn 失败 | `agent.turn_ended` 的 outcome 为 failed（记录 outcome 与错误消息，截断到 500 字符） | 该 session 下一次 turn 开始，或人把该 session 标为已读 |
| 静默结束 | 卡片处于 In progress 时，某 session 的 turn 结束，且从该 turn 开始到结束之间没有该 session 的任何看板工具写入 | 该 session 之后有工具写入，或人标记已读 |

`agent.turn_ended` 活动增加可选字段 `outcome`（completed/failed/canceled）。信号由共享纯函数从活动、session 快照和已读回执计算，客户端与 daemon 结果一致，并单独测试。

## 6. Agent 工具与 CLI

所有新工具沿用 Phase 2 的身份绑定、session/workspace 校验、请求 ID 与 issuedAt、幂等回执和错误格式。

| 工具 | 输入 | 状态 / revision |
| --- | --- | --- |
| `flowly_get_task` | 不变 | 返回字段新增：<br>• `workflow`：阶段数组和 revision<br>• `stage` / `stageValid`、`nextStage`、`gateBeforeNext`<br>• `requests`：本卡 open 请求，以及最近 10 个已关闭请求及其答复<br>• `review` |
| `flowly_set_stage` | expectedRevision、request、`stage`、note | 移动时增加 task revision；遇到 gate 只建请求 |
| `flowly_request_human` | expectedRevision、request、`question`、`options?`、note | 不改状态，不增加 task revision |
| `flowly_withdraw_request` | expectedRevision、request、`requestId`、note | 不改状态，不增加 task revision |
| `flowly_submit_review` | expectedRevision、request、4.1 中的字段 | 状态改为 In review，增加 task revision |
| `flowly_update_status` / `flowly_report_progress` | 不变 | 不变；进入 In progress 时自动补首个阶段（2.3） |

- `request_human` 与 `withdraw_request` 同样校验读取时的 task/project revision（与 progress 一致），避免按旧上下文提问。
- CLI 子命令一一对应：`stage <id>`、`ask --question … [--option …]`、`withdraw <requestId>`、`review --summary … --verification … [--not-run …] [--link …]`，与 MCP 共用同一服务。
- 新错误码：`STAGE_UNKNOWN`、`STAGE_NOT_ACTIVE`、`REQUEST_LIMIT`、`REQUEST_NOT_FOUND`、`REQUEST_CLOSED`、`INVALID_REQUEST`、`WORKFLOW_INVALID`、`STAGE_IN_USE`。其余沿用。

Skill 增补：
- 每个阶段开始前读取 `get_task`，按 stage 的 instructions 和 exitCriteria 工作，满足条件后 `set_stage` 进入下一阶段。
- 遇到 pendingApproval 时，汇报方案摘要后等待人的消息。
- 必须找人的情况：不可逆或高风险操作、方案取舍、缺少信息或权限、需求超出卡片范围。问题要具体，尽量给选项，并说明在等待还是继续做其他部分。
- 问题已自行解决时撤回请求。
- 交付用 `submit_review`，写清改动、验证、未运行项和遗留问题。
- 收到带 `[Ultra Kanban]` 标识的消息时，按其内容继续工作。

## 7. 人侧 UI

| 位置 | 呈现 |
| --- | --- |
| 卡片 | 信号行新增：<br>• 阶段标签“Develop · 2/3”（In progress，以及停留在某阶段的 Review/Blocked 卡）<br>• “Needs you n”（warning 色，open 请求数）<br>• In review 且有待定交付时显示“To verify”（accent）<br>• session 信号沿用现有色点：授权、错误、静默<br>无障碍标签同步。 |
| 侧栏头部 | 属性行增加 Stage 标签，点开为阶段菜单（显示 gate 图标），与 Status、Priority 并列 |
| 侧栏“Needs you”区 | 固定在描述之前，有内容时才显示：<br>• 每个 open question：问题、选项按钮、回答输入框和 Send、Dismiss<br>• approval：from→to、Approve / Reject（需意见）<br>• 待验收交付：summary、verification、notRun、links，以及 Approve / Request changes（需意见）<br>• 投递状态：sent、failed（重试/改投）、unknown（重发）<br>• session 信号：点击打开对应 session 预览 |
| 收件箱 | 工具栏 Inbox 按钮带总数角标。弹窗分四组：Questions、Approvals、To verify、Session signals；每项显示卡片标题、项目、摘要、时间。点击切到该项目并打开卡片侧栏（信号项直接打开 session 预览）。跨所有未归档项目，桌面和手机通用 |
| 原生 session chip | 该 session 有自己发起的 open 请求时，chip 标签变为 “Task · Needs you”，behavior 改为 popover，内容为该 session 的请求，可直接回答或批准。若宿主 popover 内无法调用插件 RPC，退回 action，打开卡片侧栏并定位到 Needs you 区；实现时先做能力验证 |
| 工作流编辑 | 见 2.2，使用现有 Field、Choices、Row 组件；手机全屏模态 |
| 活动时间线 | 新增文案：阶段变更、提问、回答、批准/驳回、撤回、提交验收、验收结论、投递结果 |

操作成功用原生 toast，失败在对应区块内显示带恢复动作的错误。所有新模态遵循 Theme.Provider 规则，动效遵循 MOTION-SPEC。

## 8. 数据迁移与兼容

- 存储 v3 → v4：
  - `board.requests=[]`
  - `board.settings={ defaultWorkflow: 内置默认 }`
  - `project.workflow` 缺省视为当前默认的副本，首次编辑时写入
  - `task.stage=null`、`task.review=null`
  - 已在 In progress 的卡在首次被读取或写入时，按 2.3 补第一个阶段（读取不写盘，只在下次写入时一并补上）
- 无效数据沿用“保留文件、报错、不重置”的策略。
- RPC 新增 `workflow.update`、`workflow.setDefault`、`requests.resolve`、`requests.redeliver`、`tasks.review`，均使用 schema 校验和 CAS。`board.read` 返回 requests 和 settings。
- 工具 `toolVersion` 升为 2。旧 session 中的 v1 CLI context 文件仍可用于原有三个操作，调用新操作时提示重新发送看板工作指示。

## 9. 需要同步修改的 AGENTS.md 约束

实施获批后，在 Product invariants 增补：

- 回复、批准/驳回、验收打回是显式的 Kanban 投递，带 `[Ultra Kanban]` 标识，只发给相关 session；普通 follow-up 仍原样发送。
- 请求与 session 信号不改变业务状态。业务状态只由 agent 工具（In progress、Blocked、In review）和人的操作改变。

“Automatic assignment…outside v1”在 M3 不变。D4 的归档修订在 M4 再改。

## 10. 验收

实现后：先 typecheck，再跑聚焦测试和全量 `npm test`，然后只 reload 本插件；最后用一个 full-access 的 `codex/gpt-6-luna` 会话做独立验收。测试资源事先登记，结束后清理，证据保存到 `docs/verification/phase-03.md`。PASS、FAIL、UNRUN 分开记录。

| 场景 | 预期 |
| --- | --- |
| 默认工作流 | 新项目带 Design/Develop/Verify；卡片进入 In progress 自动处于 Design |
| 自定义工作流 | 增删改名排序后，卡片和工具立即反映；删除在用阶段被拒并列出卡片；CAS 冲突保留草稿；设为新项目默认生效 |
| 阶段推进 | agent 依次 set_stage；非 In progress 时被拒；未知阶段被拒；人可任意改阶段 |
| gate | 开启 gate 后 agent 前进只产生 approval；重复调用不重复建请求；Approve 后 stage 前进并收到消息；Reject 带意见后 stage 不变并收到消息 |
| 提问 | 状态与 task revision 不变，卡片显示 Needs you，收件箱有该项；选项或自由回答送达运行中（steer）和空闲两种 session；重复 resolve 幂等 |
| 撤回、忽略、上限 | agent 撤回自己的问题；人 dismiss 不投递；第 11 个 open 请求被拒；Done 或归档后剩余请求自动 dismissed |
| 投递失败 | session 归档后回答显示 failed，可改投；pending 时重启变 unknown，不自动重发 |
| Review | submit_review 进入 In review 并展示交付物；Approve → Done，无资源变更；Request changes → In progress 且意见送达；直接拖拽记 bypassed |
| 信号 | 授权、失败 turn、静默结束正确出现和清除，不改业务状态 |
| 多 session | 两个 session 并发 set_stage 只有一个成功，另一个 REVISION_CONFLICT；各自的问题投递回各自的 session |
| 迁移 | v3 文件升级后既有卡片、活动、回执保留；无效文件保持原样并报错 |
| UI | 桌面、手机、深浅色下卡片标记、侧栏 Needs you、收件箱、工作流编辑器可用；chip 的 popover 或退回行为符合第 7 节 |
| 清理 | 测试创建的 project、workspace、session、卡片和临时目录在原生注册表与看板中都已移除 |

UI 操作只能针对已识别的非全屏 Paseo 窗口。无法绑定时，记为 UNRUN，可用 web 客户端和组件级证据补充，但须注明不等同于原生验证。

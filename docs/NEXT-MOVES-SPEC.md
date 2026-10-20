# 下一步建议（NEXT-MOVES-SPEC）

## 1. 目标

Agent 完成一段工作后常在回复末尾写“接下来要不要……或者……”（例如开发完建议做 Luna 验证、验证完建议提交合入）。这些建议埋在文字里，用户要自己重新组织成一条消息再发。

本功能给 agent 一个工具，把本轮结束后的候选下一步结构化地交给 Flowly；会话输入框上方显示这一轮的建议，点一下就把对应指令**预填**进输入框，**不自动发送**，由用户修改或直接发送。

与 Ideas 的区别：idea 是本卡目标之外、值得以后做的工作（进 Ideas 收件箱，可建新卡）；next move 是**这个会话下一条消息**的候选，只在本轮结束到下一轮开始之间有效，不进收件箱、不建卡。

## 2. Agent 工具 `flowly_suggest_next_moves`

- 输入：`expectedRevision`、`request`（照抄 get_task）、`moves`：1–3 条，每条
  - `label`：按钮文字，1–60 字符，短动词短语，用用户使用的语言（如“用 Luna 验证”“提交并推送”）。
  - `prompt`：点按后预填进输入框的完整指令，1–2000 字符，写成用户发给 agent 的话，能独立理解。
- 同一会话同一轮内再次调用：以最新一次为准（整组替换）。
- 写入：记录事件 `next_moves_suggested`（actor=agent，`agentId`，`note` 为各 label 用 ` · ` 连接，新字段 `moves` 保存原样的列表）。**不改** task revision、卡片状态，不进 Ideas。
- 校验与其它写工具一致：签名、revision、过期、归档、Done/Cancelled 拒绝（`TASK_FINISHED`）、精确重放返回原回执，`REQUEST_REUSED`。回执 action=`next_moves`。label/prompt 去掉首尾空白后为空、超长、条数为 0 或大于 3 为 `INVALID_INPUT`。
- CLI：`next-moves --request-file <snapshot> --moves '<JSON 数组>'`（`[{"label":"…","prompt":"…"}]`）。HTTP API action `next_moves`。
- 何时调用（写进 skill）：一轮工作结束、准备把控制交回用户前，如果有明确的下一步（验证、提交/推送、继续下一阶段、修复刚发现的问题），调用一次；只放用户最可能选的 1–3 个，最推荐的放第一个。不需要用户动作时不调用。仍应在回复正文里简述这些选项（用户可能不在 Flowly 里看）。不要用它提问（提问用 `kind=question`），不要用它代替 idea。

## 3. 有效期（“这一轮的”建议）

`openNextMoves(events, agentId)`（`shared/next-moves.ts`）：该会话最新一条 `next_moves_suggested` 事件，且其后没有该会话的 `agent.turn_started`；否则为空。即用户发出下一条消息、新一轮开始后，旧建议自动消失。

客户端再加两条：会话 `lastUserMessageAt` 晚于事件时间（生命周期事件缺失时的兜底）不显示；本地点了关闭（×）的那一组（按事件 id）不再显示，直到新的一组出现。

活动时间线不显示 `next_moves_suggested`（它是会话级提示，不是卡片变化）；flow log 照常记录（不含 `moves`）。规则 A1r（“只回了句谢谢”回退 In review）不把这个事件当作工作汇报。

## 4. 界面

位置：Flowly 会话视图输入框正上方（与问题/审批表单同一位置，排在其后）。

显示条件：有有效建议，会话不在运行（`running`/`initializing`），没有待答的问题/审批，用户可以写入该会话。

样式：一行，左侧小号 `Sparkles` 图标，后接最多 3 个胶囊按钮（单行截断，横向可滚动，不换行，不把输入框顶高），行尾 × 关闭。出现时使用共享的 `Enter` 过渡（遵循减少动态效果）。手机与桌面同一组件，手机上触控高度保持可点。

点按一个建议：
- 输入框为空：填入其 `prompt`。
- 输入框已有文字：在原文后空一行追加 `prompt`（不覆盖用户已输入的内容）。
- 然后聚焦输入框（原生端按“外部改写”重挂载输入并聚焦，不破坏 IME；web 直接改受控值）。**不发送**。建议行保留到用户发送（新一轮开始）或关闭。
- 无障碍：按钮名“Suggested next step: {label}”，提示“Fills the message box. Nothing is sent until you send it.”

## 5. 新手引导

- 欢迎页特色列表新增一条“Suggested next steps”。
- 新一次性提示 `next-move`：当前项目某卡有有效建议时出现，文案“When an agent finishes a turn, its suggested next steps sit above the message box. Tap one to fill it in; nothing is sent until you press Send.”优先级排在 first-idea 之前（它比 idea 更直接地等待用户）。
- README Highlights 的“Needs-you reminders”后补一句，并在 agent 工具列表加上新工具。

## 6. 验收

- `server/agent-service.test.ts`：写入事件并带 `moves`、不改 revision；同轮再次调用以最新为准；重放；空/超长/超过 3 条拒绝；Done 卡拒绝。
- `shared/next-moves.test.ts`：新一轮开始后失效、取最新一组、只看本会话、预填拼接规则。
- `server/progress-rules.test.ts`：只有 next moves 的回合仍按 A1r 回退。
- `server/tool-server.test.ts`：工具列表包含 `flowly_suggest_next_moves`。
- `client/onboarding-logic.test.ts`：`next-move` 提示规则与优先级。
- Skill 文本（`server/skill-source.ts` 与 `skills/paseo-ultra-kanban/SKILL.md` 一致）。
- 人工/Luna：真实会话调用工具后输入框上方出现建议；点按只预填不发送、可编辑；已有文字时追加；发送后建议消失；关闭后不再显示；手机紧凑布局可用。

## 7. “移至 Done”建议（设计，待实现）

### 7.1 目标与边界

任务完成、已提交并推送后，agent 最自然的下一步是“把卡片放到 Done”。但 Done 是**用户的决定**（`allowedStatuses` 不含 done，agent 不能自己移）。所以它不是一条预填的消息，而是一种**动作型建议**：agent 只提出，用户点一下才移动；点按本身就是用户的决定。

不做：agent 直接把卡移到 Done；点按之外的自动移动；在 Flowly 里自行判断“已推送”（git 状态由 agent 判断，见 7.5）。

### 7.2 数据契约

`NextMove` 增加可选字段 `moveTo: "done"`（枚举预留，现在只允许 `done`）。

- 普通建议：`{label, prompt}`，行为不变。
- 动作建议：`{label, moveTo:"done"}`，`prompt` 可省略（省略即不预填任何内容；如给出则忽略）。
- 校验（`nextMovesInputSchema` 与 `nextMoveSchema`，`prompt` 改为可选，非动作建议仍必须有非空 `prompt`）：一组里最多 1 条动作建议；动作建议与普通建议可混排，总数仍 1–3；未知 `moveTo` 为 `INVALID_INPUT`。
- 事件 `next_moves_suggested` 的 `moves` 原样保存新字段；有效期、重放、Done/Cancelled 拒绝、revision 规则不变。旧事件无该字段，照常工作。
- CLI：`--moves '[{"label":"移至 Done","moveTo":"done"}]'`。

### 7.3 界面

- 动作建议的胶囊前加 `Check` 图标，边框用成功色，与消息型胶囊区分；仍在同一行，沿用 3 条上限与横向滚动。
- 显示条件在 §4 基础上再加：卡片当前不在 Done/Cancelled（已完成则隐藏该胶囊），且用户有权限移动卡片。
- 点按：
  1. 不动输入框内容，不发送任何消息。
  2. 走与拖拽到 Done 相同的移动路径（`rpc.moveTask`），再进入 `askWrapup`：未开 *Auto wrap up* 时弹出“是否收尾（归档会话与自有工作区）”，开了则由守护进程处理，规则不变（`docs/MULTITASK-SPEC.md`）。
  3. 成功用原生 toast“Moved to Done”；失败（revision 过期等）用现有错误提示，建议行保留，用户可重试。
  4. 移动成功后卡片已是 Done，该胶囊自然消失；其余消息型建议保留到本轮结束或关闭。
- 不额外弹确认框：点一个标明“Move to Done”的按钮已是明确意图；移出 Done 可恢复（`WORKSPACE-RESTORE-SPEC.md`）。
- 无障碍：按钮名“Suggested next step: {label}”，提示“Moves this card to Done.”（消息型仍用原提示）。
- 实现点：`session-preview.tsx` 新增 `onMoveToDone` 属性，由 `board.tsx` 提供（复用 `reorder` + `askWrapup`，无新 RPC）；`NextMoves` 按 `move.moveTo` 分支渲染并调用 `onPick` / `onAction`；传入的回调用 `useStableCallback`，保持 `React.memo`。

### 7.4 对其它规则的影响

- 规则 A1r（只回了句谢谢回退 In review）、活动时间线、flow log：不变。
- “agent 不能设 Done”不变：工具只是提出建议，状态变更由用户点按触发，事件记录 actor=human。

### 7.5 Skill 文本（`server/skill-source.ts` 与 `skills/paseo-ultra-kanban/SKILL.md` 同步）

在 next moves 一条后补：整张卡的工作已完成、已交付到 In review、改动已提交并推送（或确认无需提交）、没有遗留问题时，可在 moves 中加入一条 `moveTo:"done"` 的建议（label 用用户语言，如“移至 Done”），通常放在“提交并推送”之后的下一轮、或与其它收尾项并列；还有未提交/未推送改动、未验证项或待用户决定的问题时不要加。每组最多一条。

### 7.6 新手引导

- 欢迎页 “Suggested next steps” 一条补半句：“…including moving the card to Done once the work is pushed.”
- 现有 `next-move` 提示文案补一句“Some steps move the card, like Done.”，不新增 tip id（不重复向所有人弹出）。README Highlights 同步。所有新文案加入全部语言包。

### 7.7 验收

- `shared/next-moves.test.ts`：动作建议随有效期失效；卡已 Done 时过滤掉动作建议。
- `server/agent-service.test.ts`：接受 `moveTo:"done"` 且无 prompt；同组两条动作建议、未知 `moveTo`、非动作建议缺 prompt 均 `INVALID_INPUT`；事件保存 `moveTo`；不改 revision。
- `server/tool-server.test.ts`：工具 schema 含 `moveTo`。
- `client/onboarding-logic.test.ts`：无新 tip，现有规则不回归。
- 人工/Luna：agent 提交推送后建议出现“移至 Done”；点按不改输入框、卡片进入 Done 并按设置弹出/自动收尾；revision 冲突时报错且建议保留；已 Done 卡片不显示；手机紧凑布局可点。

## 8. 下一步建议随交付调用一起提交（已实现，桌面真实会话已验证）

> 2026-10-20 已实现：`shared/tools.ts`（共用的 0–3 条建议 schema，`nextMoves` 加到 status/progress，独立工具下限同为 0）、`server/agent-service.ts`（Done 守卫、同事务第二条事件）、`server/cli-source.ts`（`--moves` / `--no-moves`）、`shared/next-moves.ts`（`isNoMoves`、`noMovesNote`）、`client/drawer.tsx`（活动里的 “Suggested no next moves”）、工具描述与 skill 两份文字、README 两份、9 个语言包各 1 条。2026-10-20 已用两个 `codex/gpt-6-luna` full-access 会话在 Tinylink 临时卡上验证（MCP 与不带 MCP 的纯 CLI：带建议出现胶囊、`[]`/`--no-moves` 无胶囊且活动里有一行、Done 守卫在真实环境被拒），见 [verification/next-moves-delivery.md](verification/next-moves-delivery.md)；手机/紧凑布局与上线后覆盖率未验。§9（交付时提醒）尚未实现，见 §9.11。

### 8.1 评估

**问题成立，方案可行，按卡片实现，另有两处调整（8.2）。遗漏提示不在本节，由 §9 承担（8.9）。**

依据（`~/.paseo/plugin-data/flowly/board.json`，2026-10-19 起、按“会话的一轮”统计，agent 事件，共 171 轮）：

| 这一轮怎么结束 | 轮数 | 其中带下一步建议 |
|---|---|---|
| 交付到 In review（`status in_review`） | 89 | 48（54%） |
| `question` / `result` | 8 / 4 | 4 / 4 |
| 其它状态切换、仅 `progress` | 22 / 7 | 3 / 1 |
| 没有任何 status/progress 调用 | 41 | 2 |

- 交付轮只有约一半带建议，且分布不均：有会话 7 次交付全带，另有两个会话共 22 次交付只有 2 次带。从这个分布看，建议是否出现更像取决于 agent 是否想起第二次调用，而不是有没有下一步（这是推断，看板数据里没有 agent 的想法）。§9.1 的统计口径略宽（把系统或人写的 in_review 也算进去），结论一致：约一半交付轮没有建议。
- 交付、提问、结果这三类轮（101 轮，占 59%）结束时本来就会调用 `flowly_update_status` / `flowly_report_progress`。把字段放在这两个调用上，能覆盖这 101 轮；现在这些轮里只有 56 轮（48+4+4）有建议。
- **覆盖不到的部分要说清楚**：41 轮（24%）没有调用任何 Flowly 写工具（纯对话轮），本方案对它们无效，也不打算处理（这类轮多半不需要建议，且没有可挂的调用）。验收按“交付/提问/结果轮的覆盖率”衡量，不按全部轮。
- 卡片里的“MCP 重连后收尾退化成一条 status 命令”这一场景，说明 CLI 与 MCP 必须同等支持（8.4）。

**考虑过、不采用：**
- `nextMoves` 在 `in_review` 上设为必填：仍在运行的旧会话（旧 skill、旧 CLI 快照）会交付失败，还会逼出“继续”之类的凑数建议。可选字段 + 显式 `[]` 的可见度相同，不让交付失败。
- 守护进程在一轮结束时代为写入“无建议”：与“没传”无法区分，抹掉“agent 的选择可见”这一目的。
- 新增“结束本轮”合并工具：又多一个要记住的工具，失败模式不变。
- 用摘要器的 `next` 一句话补建议：每轮多开一个子会话、只在开启自动摘要时有、一句话不是可执行的 prompt。

### 8.2 数据契约

- `statusInputSchema` 与 `progressInputSchema` 增加可选字段 `nextMoves`，元素与 `flowly_suggest_next_moves` 的 `moves` 完全相同（label 1–60、prompt 1–2000、`moveTo:"done"` 且无 prompt、一组最多 1 条 `moveTo`、至多 3 条）。**三处下限相同，都是 0**：独立工具也接受 `[]`（§9.4、§9.11 第 1 点：提醒之后 agent 唯一的补救就是调用它）。实现上抽出共用的元素 schema 与校验函数，三处引用，不复制；现有测试“独立工具拒绝 `[]`”相应改为接受。
- 三种取值：
  - **没传**：不记录任何东西，行为与今天完全一致（本轮此前的建议保留）。
  - **`[]`**：显式“这一轮没有要用户做的事”。
  - **1–3 条**：与独立工具相同的建议。
- `nextMoves` 可用于 `report_progress` 的所有 `kind`（`progress` 也接受）。工具描述与 skill 只要求在交付、提问、阻塞、结果时传。**我的决定**：不在 `kind=progress` 上拒绝，因为守护进程无法判断这一轮是否结束，而拒绝会让整条汇报失败；代价是中途 `progress` 带 `[]` 会清掉本轮先前的建议，与“同轮后一次替换前一次”一致，描述里写明。
- **Done 守卫**（卡片所说的“同样的守卫”）：
  - 沿用：一组至多 1 条 `moveTo`、非动作建议必须有 prompt、未知 `moveTo` 为 `INVALID_INPUT`、已 Done/Cancelled 的卡为 `TASK_FINISHED`。
  - **新增，仅对合并调用**：带 `moveTo:"done"` 的 `nextMoves` 只在这次调用之后卡片处于 In review 时接受（`status in_review`，或卡片已在 In review 时的 `report_progress`）；否则 `INVALID_INPUT`（“moveTo done is only offered with a delivery to In review”），整条调用不写入任何东西。这把 skill 里的“已交付到 In review”变成机械检查。独立工具不加这条，避免改变已有调用的行为。
  - 不做：在守护进程里判断“已提交并推送”（见 7.1，仍是 agent 的判断）。

### 8.3 写入语义

- 在同一个事务里，主事件（`status_changed` 或 `progress_reported`）之后再写一条 `next_moves_suggested`（actor=agent、同一 `agentId`、`moves` 原样、`note` 为各 label 用 ` · ` 连接；`[]` 时 `note` 为 `No next steps needed`，与 §9.4 相同）。主事件先，所以活动里先看到“改状态/汇报”，再看到“没有下一步”。
- 一次调用一份回执：`action` 仍是 `status` / `progress`，`eventId` 指向主事件。回执重放返回原回执，不再写第二条建议事件；`payloadHash` 包含 `nextMoves`，同一请求 ID 换了 `nextMoves` 为 `REQUEST_REUSED`。
- 任何拒绝都不写建议：`WORKPAD_OPEN`、`REVISION_CONFLICT`、Done 守卫等。事务内抛错整体不落盘（`store.transaction` 每次重新加载看板，抛错即丢弃），所以不存在“状态改了、建议没写”。skill 里写明：被拒后用同样的 `nextMoves` 重发。
- 有效期不变，`openNextMoves` 无需改动：它已经把 `moves` 为空的最新事件当作“没有”（`shared/next-moves.ts`），所以 `[]` 自然替换本轮先前的建议并且不出现胶囊。独立工具与合并调用混用时，同轮以最后一次为准。
- 不改 task revision（状态切换本身的 revision 变化照旧）。

### 8.4 CLI

- `status <state> --note … [--moves '<JSON 数组>' | --no-moves]`、`note [--kind …] --note … [--moves '<JSON 数组>' | --no-moves]`。
- `--no-moves` 等价于 `nextMoves: []`；`--moves` 必须是 JSON 数组（可为 `[]`）；`--moves` 与 `--no-moves` 同时给出、`--no-moves` 用在 `next-moves`/其它命令上都在客户端报错。`next-moves` 命令不变（`--moves '[]'` 现在也被接受，§9.4）。
- `cli-source.ts`：`allowed` 增加 `no-moves`，`booleanFlags` 增加它；现有“`--moves` 只能用于 next-moves”的检查改为允许 `status`/`note`/`next-moves`。skill 末尾的命令说明与 CLI 用法串同步。
- MCP 与 CLI 走同一个 `write(identity, "status"|"progress", input)`，没有第二套逻辑。

### 8.5 界面

- 胶囊行不变：交付后会话空闲时显示。
- **活动时间线**：`next_moves_suggested` 对非空建议仍不显示，**例外**是 `moves` 为空（显式无建议）的那条，显示为“{agent} suggested no next moves”（时间照常；这一行不再显示 `note`，避免与文案重复）。这**取代** §9.4 里“活动时间线（不显示该事件）”一句：卡片要求 agent 的“无”选择在活动里可见。判断函数放在 `shared/next-moves.ts`（`isNoMoves(event)`），时间线过滤与文案共用，单元测试直接测它。新字符串 “Suggested no next moves” 加入全部语言包。
- flow log 照常记录；`moves` 为空的 `next_moves_suggested`（`note` 为 `No next steps needed`）即显式无建议，覆盖率统计可据此区分“建议 / 无 / 没传”。
- 手机与桌面同一行，无新布局。

### 8.6 文案

工具描述（`server/tool-server.ts`）：
- `flowly_update_status` 末尾加：“When you deliver (in_review), pass nextMoves: the 1-3 messages the user is most likely to send you next (same items as flowly_suggest_next_moves; a moveTo=\"done\" move is only accepted together with in_review), or [] when nothing needs the user. Leave it out on mid-work stage changes. A refused call records nothing: resend it with the same nextMoves.”
- `flowly_report_progress` 末尾加：“When you ask (kind=question; the moves are the likely answers), report a blocker or give a result, pass nextMoves (or [] when nothing needs the user).”
- `flowly_suggest_next_moves` 开头加：“For updates in the middle of a turn, or when your delivery call had none; when you deliver or ask, pass nextMoves on flowly_update_status / flowly_report_progress instead.”

Skill（`server/skill-source.ts` 与 `skills/flowly/SKILL.md` 逐字相同，`tool-server.test.ts` 已比较两者）：skill 只改一次，与 §9 合并（§9.11 第 3 点）。§8 这一半的目标语义，替换以 “When you end a turn and there are clear next steps” 开头的那条：交付（in_review）、提问（kind=question）、汇报结果（kind=result）的回合，在结束本轮的那次调用里带 next moves——交付传给 `flowly_update_status`，提问或汇报结果传给 `flowly_report_progress`；内容是 1–3 条用户最可能发给你的下一条消息（提问时是可能的回答），最推荐的放第一个，label 用用户的语言、prompt 写成用户对你的指令；没有需要用户的事就传 `nextMoves: []`（CLI `--no-moves`），不要直接跳过；`flowly_suggest_next_moves` 用于一轮中途的更新，或交付调用没带时的补救；被拒绝的调用不会记录，重发时带上同样的 `nextMoves`。有效期、“仍在回复里简述选项”、`moveTo:"done"` 的条件（并注明它只在随 `in_review` 交付时被接受）、“提问用 `kind=question`、分叉的工作用 `flowly_propose_idea`”都保留。§9 的 `reminders` 与 ideas 两句另加。skill 最后一条命令说明补 `--moves`/`--no-moves`。`description` 前言不变。

### 8.7 对其它规则的影响

- A1r（“只回了句谢谢”回退）：合并调用的主事件是 agent 的工作汇报，不会被回退；只有建议事件的回合仍按 A1r 回退。逻辑不改，补一个两事件的用例。
- “Needs you”、注意力、会话已读：不变（建议事件与今天同一 action）。
- 新手引导：不加 tour 条目或新 tip（可见变化只有活动里一行“suggested no next moves”，用户已通过 `next-move` 提示了解建议）。README 两份在 agent 工具一行补一句“`flowly_update_status` / `flowly_report_progress` 可携带 `nextMoves`”。交付说明里写明此判断。
- 工具列表体积：两个工具各多一份建议元素 schema，估计多几百个 token；实现时用 `tools/list` 实测，明显偏大就缩短字段说明（说明写在共用 schema 上，不重复）。

### 8.8 兼容与上线

- 纯增量：旧 skill、旧 CLI 快照、仍在运行的会话照常工作；新字段只有传了才生效。旧版本读到 `moves: []` 的事件也合法（schema 本就允许 0–3 条）。
- 插件重载时 `ToolServer.initialize()` 重写运行时的 `flowly.mjs` 与 `SKILL.md`；已连接的 MCP 会话通常要重连才会看到新的工具 schema，在那之前只能用 CLI 传，所以 CLI 必须完整支持（8.4）。落地顺序见 §9.11：先 §8，再 §9，最好同一个会话做。
- 实现时工作区里 `client/drawer.tsx`、`server/agent-service.ts`、`server/skill-source.ts`、`shared/tools.ts`、`skills/flowly/SKILL.md` 已有别的卡片的未提交改动；提交时只暂存本卡的 hunk（`git add -p`）。

### 8.9 遗漏提示

字段是可选的，没传仍然静默；补这个洞的是 §9 的 `reminders`（交付、提问、结果之后，若本轮还没有 next moves 事件，结果里带一句提醒），不在本节。本节只需保证两点：(1) 合并调用在同一事务里写建议事件，所以带了 `nextMoves`（含 `[]`）的交付不会再收到“没有建议”的提醒（§9.3）；(2) §9.6 的提醒文字里“call flowly_suggest_next_moves”在本节落地后仍然成立（独立工具保留），无需改。

### 8.10 验收

- `server/agent-service.test.ts`：
  1. `status in_review` + `nextMoves`：一条 `status_changed`、一条 `next_moves_suggested`（顺序、`agentId`、`moves`、`note`），task revision 只涨一次，回执 `action=status`，`openNextMoves` 返回该组。
  2. `nextMoves: []`：写入 `moves: []`、`note` 为 `No next steps needed`；`openNextMoves` 为 `null`；本轮先前非空的建议被替换为无。
  3. 没传：不写建议事件，先前的建议保留。
  4. `report_progress` 的 `question`/`blocker`/`result`/`progress` 都能带；非法元素（空 label、超长、4 条、缺 prompt、未知 `moveTo`）为 `INVALID_INPUT` 且不写状态。
  5. Done 守卫：`in_review` + `moveTo:"done"` 通过；`development` + `moveTo:"done"` 为 `INVALID_INPUT`，状态不变、无事件、无回执；同组两条 `moveTo` 拒绝；Done/Cancelled 卡为 `TASK_FINISHED`。
  6. 重放返回原回执且只有一条建议事件；同请求换 `nextMoves` 为 `REQUEST_REUSED`。
  7. `WORKPAD_OPEN` 拒绝时不写建议；带 `acknowledgeOpen` 重发后写入。
  8. 独立 `next_moves` 用例保持通过，唯一改动是“`[]` 被拒绝”改为接受并记录（§9.4）；独立与合并混用以最后一次为准。
- `shared/next-moves.test.ts`：`[]` 在非空之后替换为无；`isNoMoves`；带 `nextMoves`（含 `[]`）的交付不触发 §9 的提醒（`needsNextMoves`，两张卡都落地后）。
- `server/progress-rules.test.ts`：主事件 + 建议事件的回合不回退；只有建议事件的回合仍回退。
- `server/tool-server.test.ts`：两个工具的 schema 含 `nextMoves`（可为空数组）；CLI：`status --moves`、`status --no-moves`、`note --kind question --moves`；`--moves` 与 `--no-moves` 并用、`--moves` 非数组、`--no-moves` 用在 `next-moves` 均失败；skill 两份文件一致。
- 客户端：时间线过滤只放行显式无建议的那条；新字符串在全部语言包（`npm test` 的 i18n 检查）。
- §9 的提醒用例由 §9.9 负责；两张卡合并后补一条：交付调用带 `nextMoves`（含 `[]`）时结果没有 `reminders`。
- 人工/Luna：真实会话 `status in_review` 带建议后胶囊出现；`[]` 后无胶囊且活动里有一行“suggested no next moves”；CLI 路径同样；旧 skill 的会话不受影响。
- 上线后用同一脚本复算：交付/提问/结果轮中，带建议（含显式 `[]`）的比例，目标 ≥ 90%。基线 56/101（约 55%）。
- 先 `npm run typecheck`，再 `npm test`，再 `paseo plugin install "$PWD" --id flowly` / `paseo plugin reload flowly`。

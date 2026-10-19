# 下一步建议（NEXT-MOVES-SPEC）

## 1. 目标

Agent 完成一段工作后常在回复末尾写“接下来要不要……或者……”（例如开发完建议做 Luna 验证、验证完建议提交合入）。这些建议埋在文字里，用户要自己重新组织成一条消息再发。

本功能给 agent 一个工具，把本轮结束后的候选下一步结构化地交给 Flowly；会话输入框上方显示这一轮的建议，点一下就把对应指令**预填**进输入框，**不自动发送**，由用户修改或直接发送。

与 Ideas 的区别：idea 是本卡目标之外、值得以后做的工作（进 Ideas 收件箱，可建新卡）；next move 是**这个会话下一条消息**的候选，只在本轮结束到下一轮开始之间有效，不进收件箱、不建卡。

## 2. Agent 工具 `kanban_suggest_next_moves`

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
- `server/tool-server.test.ts`：工具列表包含 `kanban_suggest_next_moves`。
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

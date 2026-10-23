# 卡片评论（Card comments）

状态：**已实现，单元测试通过，实测未运行**（2026-10-23，见 §7）。

用户决定，2026-10-23：像 Multica 的 issue 评论那样，人可以直接在卡片上对进度提问、写意见或要求修改，不必先找到并打开某个 session。顶层卡的 Done 仍由人决定（AGENTS.md 产品不变量不变）。

## 1. 行为

- 卡片详情（抽屉）在 Progress 下方有 **Comments** 区：最近的评论（最新在下，默认显示 3 条，可展开全部）和一个输入框（占位 “Comment or ask the agent…”）。桌面与窄布局相同，都在抽屉的滚动内容里。
- 发送一条评论做两件事：
  1. **记在卡片上**：daemon 写一条事件 `commented`（actor `human`，note 为原文），出现在 Activity/History 里。评论不改 `task.revision`（同 agent 的进度备注），不会让 agent 的签名请求失效。
  2. **送给卡片的 agent**：原样发送评论文字（产品不变量 “ordinary follow-up sends exactly the user's text”），走与 session 输入框相同的发送路径（`sendCardInstruction`：重新确认 session 属于这张卡的 workspace、任务上下文可用），遵守同一个 “When running” 偏好（Steer / Queue / Interrupt，默认 Steer）。
- **收件 session**（输入框上方显示 “To: <session 标题>”，可点开改选本卡的其它 session）：
  1. 卡片有自动化 job 且其执行者 session 仍在本卡 workspace、未归档：发给执行者；
  2. 否则：本卡 workspace 里最近活跃、未归档、不是评审者（label `flowly-automation=reviewer`）的 session；
  3. 都没有：只记在卡片上，输入框下提示 “No agent session on this card yet: the comment is saved, and an agent reads it when one starts.”，并保留现有的 Start session 入口。
- 发送失败（session 不可用、权限错误）：评论仍已记在卡片上，界面提示失败原因和 “Saved on the card; not delivered to {session}.”，可以重发（只重发送，不重复记录）。
- 归档的卡片和项目不能评论（输入框禁用，说明原因）。Done/Cancelled 的卡片可以评论；若其 session 已被 wrap up 归档，则只记在卡片上（不自动恢复 session）。

## 2. 与自动化的关系

- 评论送到执行者，等同于人在 session 里发消息：交付后（In review）的评论让 job 重新开工，下一次交付重新评审（AUTOMATION-SPEC §4.2、§5）；只是问问题、agent 回答而不重新交付，则保留原评审结论（第 3 轮修复）。
- 评论送到已停止或失败的 job 的执行者，不会重新启动自动化（人接管；要重新排队用 Run again）。
- 评论从不移动卡片泳道，从不把顶层卡移到 Done/Cancelled。

## 3. Agent 可见

- `flowly_get_task` 的结果多一项 `comments`：本卡最近 20 条人写的评论 `{ id, at, text, unread }`（从旧到新）。`unread`：在这个 session 上次读卡（`flowly_get_task`）之后写的；新 session 的所有评论都是 unread。未读的评论给原文全文；已读的超过 4000 字符时截断并注明（“这个 session 已在之前的 flowly_get_task 里收到全文”），见 §7.10。
- Skill 与工具说明：comments 是人对这张卡的意见与问题，未读的和人发给 session 的消息同等对待；回应或照做，回答后照常结束回合。已读的留在列表里作背景，不再重复回答。评审者也能看到评论，评审时要核对所有评论（已读和未读）里提出的要求。

## 4. 数据与接口

- `BoardEvent.action` 增加 `commented`。事件随卡片删除一起删（与其它事件相同），随删除备份写入 `removed/`。
- RPC `tasks.comment`：`{ taskId, text (1–10000，非空白；原定 20000，见 §7), operationId }` → `{ event }`。同一 `operationId` 重放返回同一条事件，不重复记录。拒绝：卡片或项目已归档（`ARCHIVED`）、卡片不存在。写入串行、原子，与其它看板写一致。
- 发送由客户端在记录成功后进行（与 session 输入框相同的授权与发送代码）；记录与发送分开，所以发送失败不丢评论。

## 5. 新手引导

- 一次性提示 `card-comments`：第一次打开有 session 的卡片时，指向 Comments 区：“Ask about progress or request changes right on the card: comments are saved here and sent to the card's agent.”
- 欢迎页功能列表加一行 “Comments”。README 两种语言的亮点同步。

## 6. 验收

- 单元：`commented` 事件写入与幂等重放、归档拒绝、revision 不变；`get_task.comments` 的数量与截断；收件 session 选择（自动化执行者优先、排除评审者、无 session）；发送失败不丢评论、重发不重复记录。
- 实测（本机 daemon + app.paseo.sh）：对一张 In review 的自动化卡写评论要求修改 → 执行者收到原文、返工、重新评审；对一张直接启动的卡提问 → agent 回答，卡片不动；无 session 的卡只记录；桌面与窄布局截图；评论出现在 Activity。

## 7. 实现说明（2026-10-23）

代码：`shared/comments.ts`（常量、RPC 输入、`agentComments`）、`server/comments.ts`（`addComment`）、`shared/rpc.ts` + `index.server.ts`（`tasks.comment`）、`server/agent-service.ts` `get()`（`comments`）、`client/card-comments.ts`（收件 session、评论列表、先记录后发送；纯逻辑）、`client/task-comments.tsx`（Comments 区）、`client/drawer.tsx`。

与上文不同或上文未写的地方：

1. **单条评论最多 10000 字符，不是 20000。** 评论存为事件的 `note`，而 `eventSchema.note` 的上限是 10000：所有事件、客户端读到的看板和项目文件夹快照都按它校验。放宽到 20000 要改所有事件的数据契约；评论用不到这么长。输入框也限制在 10000。
2. **评论不会被活动记录挤掉。** 卡片只保留最近 100 条事件，自动化每轮会写好几条，几十轮后评论就会消失（agent 也就看不到了）。所以评论不计入这 100 条，单独保留最近 50 条（`commentLimits.perTask`）；删除卡片时与其它事件一起删除并写入 `removed/` 备份。
3. **幂等。** `operationId` 存在事件上（`BoardEvent.operationId`，可选字段）。同一 `operationId`、同一卡片、同一文字的重放返回原事件，不写文件，卡片归档后也一样；同一 `operationId` 换了内容则拒绝（`REQUEST_REUSED`）。客户端记录失败（例如回复丢失）后，对同一文字重试复用同一个 `operationId`，所以不会记两次。拒绝码：卡片或项目已归档 `ARCHIVED`，卡片不存在 `NOT_FOUND`。
4. **收件 session。** To: 列出本卡 workspace 里未归档的主 session，按最近活跃（`updatedAt`）排序；Paseo subagent 不单列，由它的主 session 接收。评审者（`flowly-automation=reviewer` 或 job 的 `reviewerId`）可以手动选（标注 reviewer），但不会被默认选中。人选的 session 在它仍可选时一直有效，否则回到默认。
5. **不恢复已归档的 session。** 发送前先确认 session 未归档（`workspaceSession(..., true)`），然后走 `sendCardInstruction`；`sendCardInstruction` 本身允许发给已归档的 session（Paseo 会恢复它），评论不允许。卡片只有已归档的 session（例如 wrap up 之后）时，提示 “This card's sessions are archived: the comment is saved on the card and not sent.”
6. **失败与重发。** 失败提示（原因 + “Saved on the card; not delivered to {session}.”）一直保留到重发成功或点 Dismiss；之后发出的新评论成功不会清掉它。Resend 发给当前 To: 选中的 session（与失败时不同则按钮写 “Resend to {session}”），只发送，不再记录。排队（Queue）失败也算发送失败。
7. **抽屉。** Comments 是可移动的侧栏分区（DRAWER-SPEC, Section order），默认在 Progress 下方、默认展开；已保存过分区顺序的用户也会看到它出现在 Progress 之后。草稿、To: 选择和失败提示在打开某个 session 再返回时保留（抽屉内存，不写入 daemon）。Enter 发送、Shift+Enter 换行、⌘/Ctrl+Enter 用 When running 的另一种方式，与 session 输入框相同。
8. **Agent 只在 `comments` 里看到评论。** `flowly_get_task.activity`（最近 20 条事件）不再包含 `commented` 事件，否则同一条评论会出现两次，而且绕过已读评论的 4000 字符上限。
9. **新手引导。** 提示 `card-comments` 的条件是：打开的卡片有未归档的 session，且卡片未归档（输入框可用）。优先级在其它“打开卡片”类提示之前（`connectors` 之前）。
10. **未读与截断（2026-10-23 评审修正）。** 原先每条评论一律截到 4000 字符，注明“全文已在写下时发给卡片的 session”。这对只记在卡片上的评论（没有 session、发送失败、session 已归档）和发给了别的 session 的评论（例如评审者）都不成立，而且没有任何工具能读到剩下的部分，评论后半段的要求就丢了。现在：评论带 `unread`（与 artifacts 共用每个 session 的读卡时间，`artifact-reads.json`；卡片只有评论、没有 artifact 时也记录读卡时间），未读的给全文（最多 10000 字符，即评论上限），读过的才截断，注明的内容对每种情况都成立。已读评论不再要求 agent 每回合重新回答。

验收（§6）：单元部分全部覆盖并先见红：`server/comments.test.ts`（事件写入、revision 不变、幂等重放、归档拒绝、Done/Cancelled 可评论、不被 100 条上限挤掉、删除与备份、RPC 输入）、`server/get-task-comments.test.ts`（数量、顺序、截断、skill 与评审提示）、`client/card-comments.test.ts`（收件 session 选择、列表、发送偏好、失败不丢评论、重发不重复记录、重试复用 operation）、`client/onboarding-logic.test.ts`（`card-comments`）、`shared/drawer-sections.test.ts`。实测部分（本机 daemon + app.paseo.sh）**未运行**：本次没有安装到 daemon。

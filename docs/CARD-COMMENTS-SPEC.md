# 卡片评论（Card comments）

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

- `flowly_get_task` 的结果多一项 `comments`：本卡最近 20 条人写的评论 `{ id, at, text }`（从旧到新，每条最多 4000 字符，超出截断并注明）。
- Skill 与工具说明：comments 是人对这张卡的意见与问题，和人发给 session 的消息同等对待；回应或照做，回答后照常结束回合。评审者也能看到评论，评审时要核对评论里提出的要求。

## 4. 数据与接口

- `BoardEvent.action` 增加 `commented`。事件随卡片删除一起删（与其它事件相同），随删除备份写入 `removed/`。
- RPC `tasks.comment`：`{ taskId, text (1–20000), operationId }` → `{ event }`。同一 `operationId` 重放返回同一条事件，不重复记录。拒绝：卡片或项目已归档（`ARCHIVED`）、卡片不存在。写入串行、原子，与其它看板写一致。
- 发送由客户端在记录成功后进行（与 session 输入框相同的授权与发送代码）；记录与发送分开，所以发送失败不丢评论。

## 5. 新手引导

- 一次性提示 `card-comments`：第一次打开有 session 的卡片时，指向 Comments 区：“Ask about progress or request changes right on the card: comments are saved here and sent to the card's agent.”
- 欢迎页功能列表加一行 “Comments”。README 两种语言的亮点同步。

## 6. 验收

- 单元：`commented` 事件写入与幂等重放、归档拒绝、revision 不变；`get_task.comments` 的数量与截断；收件 session 选择（自动化执行者优先、排除评审者、无 session）；发送失败不丢评论、重发不重复记录。
- 实测（本机 daemon + app.paseo.sh）：对一张 In review 的自动化卡写评论要求修改 → 执行者收到原文、返工、重新评审；对一张直接启动的卡提问 → agent 回答，卡片不动；无 session 的卡只记录；桌面与窄布局截图；评论出现在 Activity。

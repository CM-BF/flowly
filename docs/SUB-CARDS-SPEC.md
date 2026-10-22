# 卡片与子卡片：agent 自己建卡、拆子卡（SUB-CARDS-SPEC）

状态：2026-10-22 用户决定并要求实现（“agent 应该能自己建卡，建立 sub-卡，像 multica 那样。flowly 的 rule 不是我写的……我说怎么做就怎么做”），已实现。推翻上游规则“agent 从不建卡、Ideas 由人把关”。参照 Multica 的 sub-issue（`multica-platform/references/issues.md`：`issue create --parent`、`todo` 立即开始 / `backlog` 搁置、子任务结束时唤醒父任务的 assignee，由它决定下一步）和 Hermes 的 `kanban_create`（parents、orchestrator 不亲自干活、决定要写进每张子卡）。

## 1. 行为一览

- agent 用 `flowly_create_card` 建卡：默认是本卡的**子卡片**，也可以建独立卡片（`subCard=false`）。每张卡有自己的 workspace（项目根是 git 仓库时为隔离 worktree，否则为目录 workspace；`baseRef` 指定起点）。
- `start=now` 放进 Todo，项目开着智能体自动化时立即排队；`start=later` 搁置在 Backlog，之后由父卡 agent 启动。`blockedBy` 建 `blocks` 链接排顺序（blocker 为 Done 才开始）。
- 父卡的 agent 用 `flowly_update_card` 管理**自己的直接子卡片**：`start`（排队）、`accept`（In review → Done，即验收；会释放被它阻塞的卡）、`cancel`。
- 自动化下（[AUTOMATION-SPEC](AUTOMATION-SPEC.md)），父卡派出子卡片后结束本轮即进入 `waiting`（不占名额）；当没有子卡片还在推进、且子卡片状态与上次不同，就唤醒父卡并发送每张子卡片的泳道、自动化状态和分支。
- 顶层卡片的 Done 仍由人决定（用户可以再改）。

## 2. 数据与约束

- 新链接种类 `subtask`：`from` = 子卡片，`to` = 父卡片。从子卡看是 `sub_card_of`（“Sub-card of”），从父卡看是 `sub_card`（“Sub-card”）。删除父卡时链接一并删除，子卡片变成顶层卡片。
- 每张卡最多一个父卡；同一项目；不能成环；树最多 3 层（`depth(父) + 1 + height(子) ≤ 3`）；每张卡最多 20 张直接子卡片。人在 “Link to a card…” 里选 “Sub-card of” 时同样校验。
- `task.createdByAgent = { agentId, taskId }`：哪张卡上的哪个 session 建的；`created` 事件 actor 为 agent。agent 建卡带的标签记为 agent 标签。
- 一张卡上的 agent 最多建 50 张卡（`CARD_LIMIT`），超过需先问用户。
- `taskInput` 增加 `subCardOf`、`blockedBy`（≤ 10）；与 `followUpOf` 一样在建 workspace 前校验，并在建卡的同一次写入里建链接。
- 降级到上游 Flowly：旧版本不认识 `subtask` 链接，会把 `board.json` 判为无效并保留原文件；回退前需先删除这些链接。

## 3. `flowly_create_card`

输入：`title`、`description`、`type?`、`priority`（默认 normal）、`tags?`、`subCard`（默认 true）、`start`（now | later，默认 now）、`blockedBy`（卡片 id，默认 []）、`workspace?`（worktree | directory）、`baseRef?`，以及照例的 `expectedRevision`、`request`。

- 一个 request 只建一张卡：`operationId = agent-card:<request id 摘要>:<参数摘要>`。同一请求同一参数重发返回同一张卡（`replayed`），不会建第二个 workspace；同一请求换了参数是 `REQUEST_REUSED`（与其他写操作一致）。并行的调用在进程内按 request 认领，第一个 await 之前就占住，所以 agent 用同一个 request 并行建两张卡时只建一张，另一个拿到 `REQUEST_REUSED`（实测中 agent 确实这样并行调用过）。
- 拒绝：本卡已结束或归档；blocker 不在本项目（`CARD_INVALID`，且不会建 workspace）；超过限制（`CARD_LIMIT`、子卡片数量/层数）。
- 返回：`cardId`、`title`、`status`、`subCardOf?`、`queued`、`message`（已排队 / 已搁置 / 自动化未开启由人启动）。
- 工具说明与 skill 要求：子卡片的描述必须自带所需的全部决定、文件、分支、接口和验收标准；共同问题（命名、格式、接口）在父卡上一次决定并写进每张相关子卡；不要亲自做子卡片的工作；派出后结束本轮。

## 4. `flowly_update_card`

输入：`cardId`、`action`（start | accept | cancel）、`note?`、`expectedRevision`、`request`。

- 只能操作本卡的直接子卡片（`NOT_PARENT`）。
- `start`：Backlog → Todo；自动化开着时排队（已在排队/运行则 `replayed`）。
- `accept`：只接受 In review 的子卡片（`NOT_DELIVERED`），移到 Done；已 Done 时 `replayed`。
- `cancel`：移到 Cancelled；已 Cancelled 返回 replayed，Done 则拒绝。
- 状态变更以 agent 身份记事件，并触发与人移动卡片相同的后续：停止该卡的自动化 job、释放被它阻塞的卡、自动收尾（设置开启时）、完成卡的项目记忆复盘。

## 5. 自动化下父卡的等待与唤醒

- “仍在推进”的子卡片：未结束、未归档，且有活着的自动化 job；其中排队中的只有在 blocker 都已满足时才算（被未验收 blocker 卡住的不算，它在等父卡验收）。
- 实现者一轮结束、卡片未交付/未阻塞/未提问，而有子卡片仍在推进 → job 进入 `waiting`（code `sub_cards`），记下子卡片状态签名 `subSeen`（每张：id、泳道、job 状态、评审结论）。`waiting` 不占名额，所以名额为 1 时子卡片照样能跑。
- 每次派发前检查：`waiting` 的父卡没有子卡片在推进、且签名与 `subSeen` 不同 → 唤醒：job 回到 `working`，发送 `[Flowly automation] Your sub-cards changed…`，列出每张子卡片的标题、id、泳道、自动化状态/评审结论、分支和目录（读 workspace 与 git HEAD，尽力而为），并说明验收、启动、取消、再建卡或交付本卡的做法。
- 同一签名只唤醒一次；父卡醒来后若又派出子卡片并结束本轮，会再次进入 `waiting`。父卡没有新子卡片在推进却又静默结束，按普通静默结束提醒。
- 人在父卡 session 里发消息（或父卡开始新一轮）时 `waiting` → `working`。
- 例：A、B 并行，C blockedBy A、B。A、B 交付后 C 仍在排队但被卡住 → 没有推进中的子卡 → 父卡被唤醒，合并 A、B 的分支并验收 → C 开始 → 父卡再次等待 → C 交付 → 父卡被唤醒、验收 C、交付本卡。

## 6. 界面

- 卡片信号行：父卡显示 “Sub-cards 2/3”（Done 或 Cancelled 计入已完成）；自动化 `waiting` 显示 “Waiting on sub-cards”。
- Links 区新增 “Sub-card of” 与 “Sub-cards” 两组；“Link to a card…” 可选 “Sub-card of”；Links 区的 + 菜单、卡片右键菜单和手机操作表都有 “New sub-card”（打开预填父卡的新建表单，标题 “Create sub-card”）。
- 活动：`automation_waiting`（Waits for its sub-cards）、`automation_woken`（Woke the agent: its sub-cards settled）；agent 建卡、建链接、验收的事件都显示 agent。
- 一次性提示 `sub-cards`（项目里有带子卡片的卡、未打开卡片时；排在 subagents 之前）。九种语言。

## 7. 验收

- `server/sub-cards.test.ts`：父卡唯一、层数与数量限制；agent 建子卡片时 workspace、子卡链接与 blocks 链接同一次写入，`createdByAgent` 与 agent 事件，重发同一请求不建第二个 workspace，同一请求换参数（顺序或并行）为 `REQUEST_REUSED`，blocker 不在项目时不建 workspace；父卡 start/accept/cancel 只对自己的子卡片，accept 只对 In review，重复 accept 为 replayed，移动触发与人相同的后续；人手动链接不能有第二个父卡或反向链接；自动化下父卡 `waiting` 不占名额、子卡片开始、子卡片交付后父卡被唤醒且只唤醒一次。
- 真实 daemon + Web UI：见 [verification/sub-cards.md](verification/sub-cards.md)。


## 8. Review hardening (2026-10-22)

- 所有 create/update 与普通写操作共用 signed-request 回执命名空间，同一请求不能用于另一个 action 或参数。create 先持久认领请求，再按稳定 operationId 恢复；成功的卡片/链接/queued job/回执同事务提交。update 的状态、排队和回执同事务提交。重放只承认原结果，不重做用户已改过的操作。
- 事务内重新验证父卡绑定、task/project revision、未归档/未结束状态，以及当前直接子卡关系；provision workspace 前与提交时也重新验证 create 权限。评审 session 无 create/update 权限（REVIEWER_ONLY）。
- 创建限额：每张来源卡 50 张，沿 createdByAgent.taskId 追溯的整条创建链共 100 张（含 subCard=false），串行 provision 前检查并在写入时重查。requeue/wake 不重置；人新建独立根卡开始新预算。计数包含尚保留的已结束/归档卡。独立卡 start=now 的已接受行为保留。
- agent 的 start 不得重开 failed 或 stopped 的 job（NEEDS_PERSON / TAKEN_BY_PERSON），只能由人 Run again。父卡唤醒不指示无限重试。未运行过、主动搁置的子卡仍能 start。In review 的子卡要求修改时，start 必须带 note；回到工作阶段并把完整意见送给实现者，失败/重载保留原文。无 Todo 时，搁置卡可留在 Backlog 排队。
- 在 workspace 创建前验证整个计划链接集合的容量及混合 subtask/blocks 环；卡片不能依赖自己的父卡/祖先，也不能通过其它依赖形成这种环。提交仍重新验证。
- workspace 资源身份不代表目录隔离。directory 卡共享项目根，调度不并行写同一实际目录；worktree 默认仍从项目根的当前分支起步。依赖父卡代码时先 commit，再显式传 baseRef。Done 只释放依赖，不自动同步分支；开工消息附 blocker handoff/branch，执行者检查后合并。
- get_task 的直接子卡和 blocker 链接附有界只读 handoff（workpad 验收/检查、交付摘要、目录/分支、未满足 blocker）。它不允许跨卡写入。父卡唤醒只承诺给受监督的 implementer；普通会话需主动检查。明确 question/blocker 优先等人，不能把“等待子卡”误报为 blocker。
- 外部 blocker 尚推进时，父卡继续等待；已交付给本父卡验收的 sibling blocker 可使父卡被唤醒。Cancelled/归档未完成 blocker 仍不释放，界面及 handoff 说明卡住的原因。
- CLI fallback：`create-card --card <JSON> --request-file <snapshot>`、`update-card --card <JSON> --request-file <snapshot>`、`submit-review --review <JSON>`；复用同一 API 及校验。

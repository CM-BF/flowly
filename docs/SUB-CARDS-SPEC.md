# 卡片与子卡片：agent 自己建卡、拆子卡（SUB-CARDS-SPEC）

状态：2026-10-22 用户决定并要求实现（“agent 应该能自己建卡，建立 sub-卡，像 multica 那样。flowly 的 rule 不是我写的……我说怎么做就怎么做”），已实现。推翻上游规则“agent 从不建卡、Ideas 由人把关”。参照 Multica 的 sub-issue（`multica-platform/references/issues.md`：`issue create --parent`、`todo` 立即开始 / `backlog` 搁置、子任务结束时唤醒父任务的 assignee，由它决定下一步）和 Hermes 的 `kanban_create`（parents、orchestrator 不亲自干活、决定要写进每张子卡）。两轮评审后的修订已并入各节（[verification/automation-review.md](verification/automation-review.md)）。

## 1. 行为一览

- agent 用 `flowly_create_card` 建卡：默认是本卡的**子卡片**，也可以建独立卡片（`subCard=false`）。每张卡有自己的 workspace（项目根是 git 仓库时为隔离 worktree，否则为目录 workspace；`baseRef` 指定起点）。
- `start=now` 放进 Todo，项目开着智能体自动化时立即排队；`start=later` 搁置在 Backlog，之后由父卡 agent 启动。`blockedBy` 建 `blocks` 链接排顺序（blocker 为 Done 才开始）。独立卡片的 `start=now` 保留，受整条创建链的预算约束（§8）。
- 父卡的 agent 用 `flowly_update_card` 管理**自己的直接子卡片**：`start`（排队）、`accept`（In review → Done，即验收；会释放被它阻塞的卡）、`cancel`。
- 自动化下（[AUTOMATION-SPEC](AUTOMATION-SPEC.md)），父卡派出子卡片后结束本轮即进入 `waiting`（不占名额）；当没有子卡片还在推进、且子卡片状态与上次不同，就唤醒父卡并发送每张子卡片的泳道、自动化状态和分支。
- 顶层卡片的 Done 仍由人决定（用户可以再改）。自动化从不归档 session，也不主动打断 session。

## 2. 数据与约束

- 新链接种类 `subtask`：`from` = 子卡片，`to` = 父卡片。从子卡看是 `sub_card_of`（“Sub-card of”），从父卡看是 `sub_card`（“Sub-card”）。删除父卡时链接一并删除，子卡片变成顶层卡片。
- 每张卡最多一个父卡；同一项目；不能成环；树最多 3 层（`depth(父) + 1 + height(子) ≤ 3`）；每张卡最多 20 张直接子卡片。人在 “Link to a card…” 里选 “Sub-card of” 时同样校验。
- `task.createdByAgent = { agentId, taskId }`：哪张卡上的哪个 session 建的；`created` 事件 actor 为 agent。agent 建卡带的标签记为 agent 标签。
- 一张卡上的 agent 最多建 50 张卡（`CARD_LIMIT`），超过需先问用户。
- `taskInput` 增加 `subCardOf`、`blockedBy`（≤ 10）；与 `followUpOf` 一样在建 workspace 前校验，并在建卡的同一次写入里建链接。
- 降级到上游 Flowly：旧版本不认识 `subtask` 链接，会把 `board.json` 判为无效并保留原文件；回退前需先删除这些链接。

## 3. `flowly_create_card`

输入：`title`、`description`、`type?`、`priority`（默认 normal）、`tags?`、`subCard`（默认 true）、`start`（now | later，默认 now）、`blockedBy`（卡片 id，默认 []）、`workspace?`（worktree | directory）、`baseRef?`，以及照例的 `expectedRevision`、`request`。

- 一个 request 只建一张卡：`operationId = agent-card:<request id 摘要>:<参数摘要>`。同一请求同一参数重发返回同一张卡（`replayed`），不会建第二个 workspace；同一请求换了参数是 `REQUEST_REUSED`（与其他写操作一致）。并行的调用在进程内按 request 认领，第一个 await 之前就占住，所以 agent 用同一个 request 并行建两张卡时只建一张，另一个拿到 `REQUEST_REUSED`（实测中 agent 确实这样并行调用过）。已经建出卡片的请求，若那张卡之后被删除，重发得到 `REQUEST_REUSED`，不会再建一次。
- **revision 只查一次**：签名请求里的 task/project revision 只在认领请求时检查。之后，在建 workspace 之前和提交时只重查权限与存活：父卡绑定、归档、结束、评审者身份、祖先、创建预算和认领。同一 agent 并行写状态、元数据或进度，或人在 worktree 创建期间编辑了卡片，都不再让提交被拒。
- 拒绝：本卡已结束或归档；blocker 不在本项目（`CARD_INVALID`，且不会建 workspace）；超过限制（`CARD_LIMIT`、子卡片数量/层数）；`ANCESTOR_FINISHED`：沿子卡链接向上，本卡有已取消、已归档或已不存在的祖先时不能建卡（`subCard` 为 true 或 false 都一样），在建 workspace 之前检查，提交时再查一次；Done 的祖先不挡。`flowly_update_card` 的 `action=start` 同样检查父卡的祖先（`ANCESTOR_FINISHED`，“…so this card cannot start sub-cards”），`accept`/`cancel` 不受影响，所以被放弃的树里仍可以取消子卡片。
- `start=now` 而项目开着自动化却关了 In review 泳道（项目拒绝这种组合之前保存的旧配置）：在建 workspace 之前拒绝，`STATUS_UNAVAILABLE`：“Agent automation is on for this project but its In review lane is off, so a started card could never be delivered. Ask a person to turn the In review lane back on, or create the card with start=later.” `start=later` 仍在 Backlog 建卡。
- **workspace 已建好之后被拒**：保留原错误码（`ARCHIVED`、`TASK_FINISHED`、`ANCESTOR_FINISHED`、`CARD_INVALID`……），消息为 “Card was not saved: <原因> Workspace <id> was created for this request but has no card yet: retry this same request to reuse it, or ask a person to link or archive it.” 这句话存在该请求的回执上（`notice`），同一请求之后的每次拒绝都附上它，包括 15 分钟窗口过后的 `REQUEST_EXPIRED`。原因解除后重发同一请求，会通过不变的 Paseo idempotency key 在同一个 workspace 上建卡，并清除 notice。没有任何东西自动归档这个 workspace。人在界面里建卡失败仍是原来的 “Card was not saved. Workspace X remains available; retry with the same operation or link it.”
- 返回：`cardId`、`title`、`status`、`subCardOf?`、`queued`、`message`（已排队 / 已搁置 / 自动化未开启由人启动）。
- 工具说明与 skill 要求：子卡片的描述必须自带所需的全部决定、文件、分支、接口和验收标准；共同问题（命名、格式、接口）在父卡上一次决定并写进每张相关子卡；不要亲自做子卡片的工作；派出后结束本轮。

## 4. `flowly_update_card`

输入：`cardId`、`action`（start | accept | cancel）、`note?`、`expectedRevision`、`request`。

- 只能操作本卡的直接子卡片（`NOT_PARENT`）。独立卡（`subCard=false`）以 `start=later` 建好后，返回消息写 “A person starts it with Run with agent; this card's agent can start only its direct sub-cards.”，不再提示用 `flowly_update_card` 启动。
- `start`：Backlog → Todo；自动化开着时排队。
  - 子卡片的自动化仍活着（`queued`、`starting`、`working`、`waiting`、`retry_wait`、`reviewing` 或 `needs_human`）时：带 `note`，或子卡片在 In review，则拒绝：job 在等人时为 `NEEDS_PERSON`（由那个人在子卡片自己的 session 里回答），否则为 `CHILD_BUSY`。消息说明什么都没改、note 没有送出。不记回执、事件或反馈，所以之后可以原样再发同一请求。不带 note、且子卡片不在 In review 时仍按 `replayed` 确认，消息为 “This sub-card is already queued or running; nothing changed.”（此前带 note 时也返回 `replayed:true` 并丢掉 note。）
  - **重启上限**：父卡 agent 对已有 job 的子卡片再次 `start`（例如对已交付的子卡要求返工）最多 2 次。第 3 次被拒，`NEEDS_PERSON`（“An agent already started this card again 2 times since a person last ran or moved it…”），什么都不改。人选择 Run again，或人在工作阶段之间移动卡片（最近一次状态变更由人做）时计数清零；移到 Done/Cancelled/Backlog/Todo/Blocked 与验收本来就会结束 job。首次启动搁置或从未运行的子卡片不计数。计数存在 job 的可选字段 `restarts`，只由 agent 的排队带进下一代 job。
- `accept`：只接受 In review 的子卡片（`NOT_DELIVERED`），移到 Done；已 Done 时 `replayed`。
- `cancel`：移到 Cancelled；已 Cancelled 返回 replayed，Done 则拒绝。
- 状态变更以 agent 身份记事件，并触发与人移动卡片相同的后续：停止该卡的自动化 job、释放被它阻塞的卡、自动收尾（设置开启时）、完成卡的项目记忆复盘。

## 5. 自动化下父卡的等待与唤醒

- “仍在推进”的子卡片（`subCardActive`）：未结束、未归档，且有活着的自动化 job。这包括等人的 job（`needs_human`：提问、blocked、权限、中断，或冷却预算用完）：由人回答子卡片，而不是父卡；它交付后父卡被唤醒一次。排队中的子卡片：
  - blocker 都已满足 → 在推进。
  - 被未 Done 的 blocker 卡住 → 只在那个 blocker 自己推进时才算推进。只有交付到 In review 的**兄弟**（同一父卡）blocker 留给本父卡验收；其它 blocker 递归判断：已交付、失败、停止或从未由自动化运行（没有活着的 job）的 blocker 让子卡片算作停下，排在推进中的工作后面或正在评审的 blocker 算推进。依赖环终止这次递归。Cancelled/归档的未完成 blocker 让子卡片停下。
  - 因此父卡不再无限等待一张没有人的自动化在推进的外部卡：它被唤醒（或它的静默回合被提醒），应去问人。孙卡被其父卡的兄弟挡住（跨分支）不再让两个父卡互相等死：内层父卡醒来，看到被卡住的 blocker。
- 实现者一轮结束、卡片未交付/未阻塞/未提问，而有子卡片仍在推进 → job 进入 `waiting`（code `sub_cards`），记下子卡片状态签名 `subSeen`（每张：id、泳道、job 状态、评审结论；排队中的子卡片再以 `:moving` 或 `:held` 结尾）。`waiting` 不占名额，所以名额为 1 时子卡片照样能跑。这一分支不再自己清零父卡的失败计数：能走到这里的都是完成的回合，连续失败计数已经清零，所以没有可见变化。
- 每次派发前检查：`waiting` 的父卡没有子卡片在推进、且签名与 `subSeen` 不同 → 唤醒：job 回到 `working`，发送 `[Flowly automation] Your sub-cards changed…`，列出每张子卡片的标题、id、泳道、自动化状态/评审结论、分支和目录（读 workspace 与 git HEAD，尽力而为），并说明验收、启动、取消、再建卡或交付本卡的做法；还说明一张子卡片被重启两次后必须由人处理（`NEEDS_PERSON`），应去问人。
- 因为签名带 `:moving`/`:held`，子卡片的外部 blocker 被取消或归档时，等待中的父卡也会醒来，它的 handoff 把那个 blocker 列为 cancelled 或 archived。此前保存的 `subSeen` 与新格式不同，只会让父卡多醒一次；会因此醒来的只有原本已经静默卡住的父卡。
- 同一签名只唤醒一次；父卡醒来后若又派出子卡片并结束本轮，会再次进入 `waiting`。父卡没有新子卡片在推进却又静默结束，按普通静默结束提醒；有子卡片在推进（包括等人的子卡片）的静默回合回到 `waiting`，不提醒。
- 等待中的父卡自己的 workspace 已归档、正在归档或不再被 daemon 列出 → `failed` / `session_unavailable`（AUTOMATION-SPEC §4.1），它的父卡可以被唤醒。项目冻结（自动化开着但 In review 关闭）时不唤醒。
- 人在父卡 session 里发消息（或父卡开始新一轮）时 `waiting` → `working`。
- 例：A、B 并行，C blockedBy A、B。A、B 交付后 C 仍在排队但被卡住 → 没有推进中的子卡 → 父卡被唤醒，合并 A、B 的分支并验收 → C 开始 → 父卡再次等待 → C 交付 → 父卡被唤醒、验收 C、交付本卡。

## 6. 界面

- 卡片信号行：父卡显示 “Sub-cards 2/3”（Done 或 Cancelled 计入已完成）；自动化 `waiting` 显示 “Waiting on sub-cards”。
- Links 区新增 “Sub-card of” 与 “Sub-cards” 两组；“Link to a card…” 可选 “Sub-card of”；Links 区的 + 菜单、卡片右键菜单和手机操作表都有 “New sub-card”（打开预填父卡的新建表单，标题 “Create sub-card”）。
- 活动：`automation_waiting`（Waits for its sub-cards）、`automation_woken`（Woke the agent: its sub-cards settled）；agent 建卡、建链接、验收的事件都显示 agent。
- 一次性提示 `sub-cards`（项目里有带子卡片的卡、未打开卡片时；排在 subagents 之前，[ONBOARDING-SPEC](ONBOARDING-SPEC.md) §5）；欢迎页 More features 有 Sub-cards。九种语言。

## 7. 验收

- `server/sub-cards.test.ts`：父卡唯一、层数与数量限制；agent 建子卡片时 workspace、子卡链接与 blocks 链接同一次写入，`createdByAgent` 与 agent 事件，重发同一请求不建第二个 workspace，同一请求换参数（顺序或并行）为 `REQUEST_REUSED`，blocker 不在项目时不建 workspace；父卡 start/accept/cancel 只对自己的子卡片，accept 只对 In review，重复 accept 为 replayed，移动触发与人相同的后续；人手动链接不能有第二个父卡或反向链接；自动化下父卡 `waiting` 不占名额、子卡片开始、子卡片交付后父卡被唤醒且只唤醒一次。
- 第二轮（`server/sub-cards-round2.test.ts`、`server/sub-cards-create-round2.test.ts`、`server/automation-parents.test.ts`、`server/get-task-handoffs.test.ts`、`shared/automation-round2.test.ts`）：等人的子卡算推进、外部 blocker 的递归判断与跨分支不死锁、签名 `:moving`/`:held`；重启上限与人的操作清零；活着的子卡拒收 note；已结束父卡的重放；workspace 建好后被拒的 notice 与同一 workspace 上重试成功；被删卡的重放、`ANCESTOR_FINISHED`、In review 关闭时 `start=now` 被拒；get_task 链接 handoff 的范围与总预算、`branch` 字段、写操作的 `current` 不读链接的 workspace。
- 真实 daemon + Web UI：见 [verification/sub-cards.md](verification/sub-cards.md)。


## 8. Review hardening (2026-10-22)

- 所有 create/update 与普通写操作共用 signed-request 回执命名空间，同一请求不能用于另一个 action 或参数。create 先持久认领请求，再按稳定 operationId 恢复；成功的卡片/链接/queued job/回执同事务提交。update 的状态、排队和回执同事务提交。重放只承认原结果，不重做用户已改过的操作。重试的 `flowly_update_card`（同一签名请求与参数）即使父卡之后已结束或归档，也返回它记录的结果（`replayed:true`）；只有新请求才得到 `ARCHIVED`、`TASK_FINISHED` 或 `WORKSPACE_INCOMPATIBLE`。
- 事务内重新验证父卡绑定、未归档/未结束状态，以及当前直接子卡关系；update 还验证 task/project revision，create 只在认领时验证 revision（§3）。provision workspace 前与提交时也重新验证 create 权限。评审 session 无 create/update 权限（REVIEWER_ONLY）。
- 创建限额：每张来源卡 50 张，沿 createdByAgent.taskId 追溯的整条创建链共 100 张（含 subCard=false），串行 provision 前检查并在写入时重查。requeue/wake 不重置；人新建独立根卡开始新预算。计数包含尚保留的已结束/归档卡。独立卡 start=now 的已接受行为保留。
- agent 的 start 不得重开 failed 或 stopped 的 job（NEEDS_PERSON / TAKEN_BY_PERSON），只能由人 Run again；重启已交付的工作有上限（§4）。父卡唤醒不指示无限重试。未运行过、主动搁置的子卡仍能 start。In review 的子卡要求修改时，start 必须带 note；回到工作阶段并把完整意见送给实现者，失败/重载保留原文。子卡自动化仍活着时带 note 的 start 被拒（§4）。无 Todo 时，搁置卡可留在 Backlog 排队。
- 在 workspace 创建前验证整个计划链接集合的容量及混合 subtask/blocks 环；卡片不能依赖自己的父卡/祖先，也不能通过其它依赖形成这种环。提交仍重新验证。
- workspace 资源身份不代表目录隔离。directory 卡共享项目根，调度不并行写同一实际目录；但这个保护只看自动化 job 的 session（AUTOMATION-SPEC §10）：没有 job 的父卡在普通 session 里拆出 `start=now` 的子卡时，子卡的 worker 会在父卡 session 仍在回合中时就在同一目录启动，普通 session 与自动化 worker 同时改同一份 checkout 由用户自己协调（用 worktree 项目，或先 `start=later`、在父卡回合结束后再 start）。worktree 默认仍从项目根的当前分支起步。依赖父卡代码时先 commit，再显式传 baseRef。Done 只释放依赖，不自动同步分支；开工消息附 blocker handoff/branch，子卡片还附 “Parent integration branch (card data)”（父卡的 id、标题、泳道、分支、目录，并建议先检查、优先合并父卡分支，因为它可能已含兄弟 blocker 的改动且冲突已解决；AUTOMATION-SPEC §4.1），执行者检查后合并。
- **get_task 的链接**：`links[].handoff` 只出现在 `sub_card` 与 `blocked_by` 链接上，且只在那张卡处于 In review 或已停下（没有活着的自动化在推进它，按 `subCardActive`）时出现；Done、Cancelled、已归档的卡只给 status。所有 handoff 合计最多 16,000 字符的证据（每条仍最多 6,000），In review 的优先，其次按最近更新排序；超出预算的链接保留目录、分支和 blocker，证据换成一句指引：“Omitted: get_task carries at most 16000 characters of handoff evidence… Inspect this card's directory and branch (git log, git diff) instead.” handoff 的分支取交付时或最近一次写 workpad 时存下的 HEAD；只有没存过的卡才跑一次 `git rev-parse --abbrev-ref HEAD`（服务可注入的 git）。get_task 不再对每条链接跑 `git status`，只读要给 handoff 的卡的 workspace，外加没存分支的父卡。新字段 `links[].branch`（toolContextSchema）：在 `sub_card_of` 上是父卡的分支（存下的 HEAD，否则一次 live rev-parse）；在 Done 的 `blocked_by` 上是 blocker 交付时所在的分支（只用存下的 HEAD，不跑 git）。每次写操作（status、progress、workpad、tags……）返回的 `current` 上下文列出的链接不带 handoff 与 branch，也不读任何链接卡的 workspace；需要 handoff 时读 `flowly_get_task`。自动化开工说明与父卡唤醒消息（cardHandoff）不变。它不允许跨卡写入。父卡唤醒只承诺给受监督的 implementer；普通会话需主动检查。明确 question/blocker 优先等人，不能把“等待子卡”误报为 blocker。
- 外部 blocker 尚推进时，父卡继续等待；已交付给本父卡验收的 sibling blocker、以及没人推进的 blocker，可使父卡被唤醒（§5）。Cancelled/归档未完成 blocker 仍不释放，界面及 handoff 说明卡住的原因。
- CLI fallback：`create-card --card <JSON> --request-file <snapshot>`、`update-card --card <JSON> [--note <text>] --request-file <snapshot>`、`submit-review --review <JSON>`；复用同一 API 及校验。`update-card --note <text>` 把文本放进卡片的 note；JSON 里已有 note 时报错 “--note duplicates "note" in the --card JSON; give the note once.” update-card 不接受 `--kind`；create-card 不接受 `--note` 与 `--kind`（“put the card text in the --card JSON (title, description)”）；submit-review 不接受 `--note` 与 `--kind`（“put the text in the --review JSON (summary, findings)”）。

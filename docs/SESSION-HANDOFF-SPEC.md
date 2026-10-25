# 会话轮换与卡片交接：混合会话模型（SESSION-HANDOFF-SPEC）

状态：第三版设计稿与分期实施（2026-10-24）；review-levels 已合并为 `2e471e6`。**P1 `684a8fd` 已安装，真实接手验收尚未通过；P2 已实现并在独立复查，尚未安装。** 实际实现的取舍、上限及未做项以 §21 为准；前文保留设计推导。用户已经授权 hybrid 方向，不把常规设计取舍重新变成一串审批问题。第二版的 48 条审查意见保留在 §20。

读者先看：
- **卡片负责记住任务，session 只负责眼前这一段。** 卡片要能说明做到哪、为什么这样做、什么不能重做、谁还在运行、下一步是什么。artifact 仍是证据和产物，不能替代这份记录。
- 几分钟内的评审与返工通常沿用 session；Run again、新评审周期、上下文过长、冷且大的上下文等边界再换。文件有多大和模型记住了多少是两回事，分开测量（§2–§3）。
- 健康的旧 session 需要时先写交接；新 session 先读卡、核实仓库与后台任务，再逐项确认。确认只证明规定的项目已被核对，不能证明模型已经理解全部含义。
- 崩溃时不要求旧 session 起死回生：尽量用已经保存的输入、评审、叙述和文件状态恢复。拿不到的明确显示为缺口，关键指示不明时暂停询问，不能把“没记到”当成“没有”。
- **不承诺零信息损失，也不承诺一个长回合不会撑大历史。** 未说出的意图、未保存的工具结果、无法读取的图片与 provider 内部压缩可能丢失；被动捕获也可能落后（§16.1）。
- 第一阶段先把记录、可核实的接手和既有轮换路径做稳；自动按上下文、空闲和冷评论换 session 在第二阶段上线。历史检索、廉价问答、完整历代台账不阻塞第一阶段（§18）。
- 默认不主动打断运行中的 agent。若以后要开启回合内的 steer，需要单独决定，因为本机 Paseo 的 steer 可能变成 interrupt（§19）。

用户决定，2026-10-24：Flowly 改为**混合会话模型**，以 agent 到 agent 的交接为核心。原因：人不看 session 里面，卡片必须承载全部信息；设计要保证有意义的信息不丢。现状是每张卡的执行者从头到尾用一个 session（外加一个评审 session），只有 Run again、换备用模型、session 被归档、小组评审和历史过大（200 MB 轮换，AUTOMATION-SPEC §4.6）才换新 session。实际事故：C5b.3 的第一个 Codex 执行者在约两小时里长到 1.18 GB，daemon 崩溃循环；卡片上的 artifact 都是给人看的产出，不是交接；唯一的交接是崩溃之后人手写的（next-workspace `docs/handoff/2026-10-24-daemon-incident-and-review.md` §8 加一条接手评论），新 session 凭它约 20 分钟就结束了一个回合。

用户已接受的起始提案（本 spec 按证据细化，每处改动都给出理由，§0）：
1. 紧密循环保持同一 session（同一次交付的评审→修复、几分钟内的追问、提示缓存仍热）。
2. 在边界换新 session：历史超过软上限（约为模型上下文窗口的 50%，token 未知时约 30 MB）、空闲约 1 小时后恢复（缓存已冷）、阶段变化（实现→验证、人改变方向、Run again）、失败与换模型。
3. 交接是卡片上的一等记录：agent 每回合增量更新（现状、已完成、关键决定及理由、未决问题、下一步、坑、产物在哪）；轮换时 Flowly 把卡片、workpad、交接和最新评论交给新 session；评审者也检查“只凭这份记录，一个新 agent 能接着做吗”。
4. 评论路由：修改要求发给热 session，冷时交给带交接的新 session；纯进度提问由只读的廉价运行读卡回答，不让工作 session 继续变大。

## 0. 决定一览：对提案的细化

| 提案 | 本 spec | 依据（§1 的证据） |
| --- | --- | --- |
| 1. 紧密循环不换 | 保留，并给出定义：本周期的修改要求、评审下一轮和人的评论，距**本卡**上一回合结束（任一角色）≤ 20 分钟、且该 session 的缓存未冷，是**紧密边界**；提醒、普通重试、限额重试、宿主临时故障重试是**同一指令的后续**。紧密边界用更高的上限（70% / 300k），后续只受强制规则约束（§3.3）。 | 评审→修复间隔中位 2.8 分钟（最长 14.8），评审轮间 8.1 分钟，重试 0–1.3 分钟。19 个执行者里 15 个超过窗口的 50%，7 个在第一回合就超过：50% 会打断提案第 1 条要保护的循环。按角色自己的空闲计时会把对方的长回合算成空闲：C5b.3 的修复回合 27.5 和 38.4 分钟。 |
| 2a. 软上限 ≈ 50% 窗口 | 50% 只用于非紧密边界：`L_cold = min(0.50·W, 250k)`；紧密边界 `L_tight = min(0.70·W, 300k)`。300k/250k 的绝对上限针对 1M 窗口的模型。 | Codex 在有效窗口的 66–95% 自动压缩，压缩结果加密不可读（Hermes 测得压缩后召回 36.7%）。sol 的 300k（63%）低于所有观测到的压缩点。新 session 光是读卡就到约 108k token，低于约 2 倍这个量的轮换省不下什么。 |
| 2b. token 未知时 ≈ 30 MB | **不再把字节当 token 的替代**。token 从 Paseo 的 `lastUsage`、job 上保存的上次测量和 provider 文件读（§2）。字节是独立的**主机安全**上限：64 MiB 在任何边界轮换，128 MiB 回合内提醒，200 MiB 不读不发（今天的规则），300 MiB 严重警告。 | 1.18 GB 的 rollout 当时只占窗口 49.7%；纯文本会话约 2 MB / 10 万 token，所以 30 MB 已是好几个窗口。真实卡片上只有 3 个 session 超过 30 MB，其中两个是正常的长会话。 |
| 2c. 空闲约 1 小时 | 按 provider 估计缓存寿命，且**只在上下文大时**才因空闲轮换（`C ≥ 100k`）。Claude 主会话按转录里实际的缓存写入档（1 小时或 5 分钟）判断；Codex 2 小时内视为热，2–6 小时不确定，6 小时以上冷。 | 本机 Codex 首个请求的缓存命中率：2 小时内中位 0.97–1.00，2–6 小时 0.92，6 小时以上 0.04。Claude 主会话（订阅，1 小时档）超过 60 分钟后全冷；API key 只有 5 分钟。新 session 本来也是冷的，小上下文因冷而轮换省不了钱。 |
| 2d. 阶段变化 | 只认 Flowly 在回合之间看得见的边界：人的 Run again（默认新 session，§3.4）、新评审周期（总是新评审者）、父卡被唤醒、换模型、中毒失败、人点 “Continue in a fresh session”。**不认**泳道移动；实现→验证本来就是另一个评审 session；人在 session 里改方向看不到也改道不了，只能把原话记下来（§5.7）。 | 103 次 agent 改阶段全部发生在回合中；C5b.3 在 2.3 小时里改了 15 次。插件 SDK 没有用户消息之前的钩子（`agent.turn_started` 只有 `{agent, turnId}`）。 |
| 2e. 失败与换模型 | 只在 session 级的失败上轮换：中毒失败（上下文溢出、400 invalid_request、历史无法恢复）、session 消失、换备用模型。provider 限额和宿主临时故障的重试**不**轮换。 | Multica 的“中毒 session”列表；重试约 1 分钟后发生，缓存 99% 仍热。 |
| 3. 交接记录 | 保留并加固：(a) Flowly 派生的事实（人在 session 里说的原话、agent 提的问题和对应的回答、每一轮评审与交付说明、各仓库的 git 状态、后台任务清单、session 台账、每回合的最后一条 agent 消息、标识符锚点）；(b) **回合进行中的被动捕获**：Flowly 每分钟从 provider 文件读新增的部分，记下 agent 的最新消息、HEAD 变化、启动的后台和人的话，不需要 agent 调用 Flowly；(c) 回合中途的检查点提醒和软的交付门 `HANDOFF_STALE`；(d) 计划内轮换前，热的旧 session 做一个**收尾回合**（只在热且记录确实过期时）；没收尾时接班者拿到上次写入以来旧 session 自己的叙述；(e) 前任历史的有界只读检索；(f) 新 session 第一回合**确认接手**每个未决项。 | C5b.3 的卡片最后 23 分钟没有任何记录，其间也没有 Flowly 调用，所以只挂在工具结果上的提醒送不到；agent 消息一共只有 21 KB；验证结果落后两个提交；最要紧的事实（崩溃原因、新规则、安装状态）是 session 结束后由人产生的；摘要会丢一半具体事实（Hermes 45.8%，Factory 的产物轨迹 2.2/5）；能回到原始记录的指针多出 20–43 个百分点的召回。 |
| 4. 评论路由与只读回答 | 自动化卡的评论改由 daemon 路由：热 session 收原文，与人在 session 里打字完全一样；冷且大时建新 session，**首条消息就是评论原文**；轮换进行中的评论成为待办输入，绝不发给旧 session；每个 job 状态有明确的转移，从不覆盖另一角色的指令（§10.1）。只读回答只作 To: 里的显式选项（“Quick answer from the card”），v1 不自动分类。 | 真实卡片上进度提问 0 次；评论 4 条，直接打进 session 的消息 22 条。误判路由（把修改要求当成提问）是最主要的丢失方式。用户选择收件 session（产品不变量）。 |

前提更正（不改变决定）：
- **Multica 并不每条评论开新 session。** 每条评论开一个新 *run*，但 run 在安全时恢复同一 agent 在该 issue 上的 provider session；只有手动 rerun、中毒失败、rollout 丢失或换运行时才全新开始（multica-ai/multica@3de79cb `server/internal/handler/daemon.go`、`066_force_fresh_session.up.sql`）。也就是默认热，记录兜底。本设计同形，外加 Multica 没有的结构化记录。
- C5b.3 崩溃时卡片上有 9 个 artifact（11 是今天的数）；session 1 每次提交都更新了 `C5B3-HANDOFF.md`，但那是写给评审者的，没有当前步骤、在跑的进程、失败的尝试和坑；体积 44% 来自 agent 用自己的 patch 工具写的 9,870 个文件，内联截图只占 40%；崩溃发生在一个回合中间（之后每次恢复都再崩）；session 1 实际活动 2 小时 17 分钟。

实施校准：P1 的问题原文与评审对应的交付说明遵循实际工具的 10,000 字符上限保存，不能把旧版的 1,000/1,500 字符预览当成全文。默认视图仍有预算，全文通过分页读取。未决索引也无法容纳时明确拒绝新写入并保留原记录和未发送草稿，不静默丢弃；完整未决清单可分页读取，ACK 使用内部完整集合核对。

## 1. 证据（只记数字；对话内容只作概括）

- **C5b.3 #1**（`8815eda5`）：6 个回合，前后间隔都只有 1.0–3.1 分钟，按提案第 1 条整段都是紧密循环，只有体积上限能让它轮换。回合增长：322 MB（50 分钟）、272 MB（27.5 分钟）、37 MB、80 MB、466 MB（38 分钟，未结束）。会话开始 35.8 分钟到 200 MB；到 30 MB 时上下文 259k token（55%），到 200 MB 时 328k（69%）；峰值 81%，00:52 压缩一次（393,343 → 50,351），结束时 235,885（49.7%）。体积构成：`FileChange` 523.9 MB（44%，9,883 条，约 9,848 个 relay 文件由 agent 的 patch 工具写入，Codex 记下每个文件全文）、`browser_screenshot` 471 MB（1,346 次，每张存两份）、`browser_evaluate` 70 MB、`browser_snapshot` 31 MB、命令执行 67 MB；agent 消息只有 21 KB。今天的 200 MB 守卫在第 1 轮修改要求时（约 327 MB）才轮换，最大的 session 仍会到约 583 MB。
- **C5b.3 #2**：一个回合 20 分 23 秒；首个请求 44k token，70 秒后读完卡片与交接文档到 108k，结束时 209k（44%）、8.1 MB。首条消息是通用的“从头到尾无人值守”开工说明，接手的框架只来自人的评论。`flowly_get_task` 调了 23 次，每次约 109 KB；Flowly 工具结果占它历史的 59%。
- **交接文档**：§8 约 2,967 字符，包含事故得出的硬规则、要读的文件（指针不是内容）、带期望值的状态检查、待用户决定的事、有先后和前提的下一步、输出卫生规则、“不要恢复旧 session”。整份 64 KB 的文档写成约 20 分钟后就过时了，评论更正了安装状态。
- **全看板**（21 张卡，42 个真实卡片 session）：执行者中位 8.4 MB、2 个回合；评审者中位 2.65 MB（最大 5.8）；父卡 session 活 21–23 小时、13–36 个回合。每回合增长中位 0.94 MB，90 分位 5 MB；≥30 MB 的 5 个回合全是 C5b.3 #1。回合间空闲中位 8.9 分钟，21% ≥ 1 小时；人发给执行者的消息之前的空闲中位 110 分钟（多是 Run again）。C5b.2 在空闲 416 分钟后 Run again：首个请求 430,403 token 全部未命中缓存，2 分钟后压缩。
- **人怎么说话**：人直接在卡片 session 里打字 22 次（方向或 Run again 说明约 9、回答 agent 的问题 5、事故后的通知 2、手动 session 的开场 4），卡片评论 4 次，真实卡片上的纯进度提问 0 次。async-shell 通知 44 次进入 5 个 session，每个等待者属于注册它的 session。
- **Flowly 自己的工具结果**占普通会话历史的 32.5%：`get_task` 平均 67 KB（Codex 存文本和结构化两份），每次写入回显 55–78 KB；一次“读卡 + 写入”约 220 KB。
- **前人经验**：Hermes Kanban 每个 run 一个新 session，卡片就是交接（`gateway/session_kanban.py:89-90`），worker 上下文给每条内容标相对时间以促使重新核实；Hermes 的压缩评测（`evals/compaction/`）：不压缩 96.7%，摘要 45.8%，lean 原文保留 40.0%，lean + 一次 `session_search` 68.3%，Codex 自身压缩 36.7%；锚点索引把一份转录从 23.3% 提到 60.0%。Hermes 曾在每次压缩时换 session id，引出一串按 session id 存的状态丢失的 bug（#33618、#14238、#33907），教训是按 session 存的状态必须原子迁移、建不出接班者就回滚。Anthropic 的长任务 harness：初始化 agent 写进度文件和 JSON 特性清单，每个 session 先读它们再做一件事。Claude Code：被纠正两次以上后，干净的新 session 几乎总是胜过带着失败尝试的长 session；新上下文的评审更好。
- **提示缓存**：Anthropic 默认 5 分钟、可选 1 小时（写 1.25× / 2×，读 0.1×，Opus 5.5 为 0.05×），每次命中免费续期，从请求开始算；Claude Code 主会话只在订阅额度内用 1 小时档，API key 和用量额度是 5 分钟，子代理与压缩总是 5 分钟。OpenAI GPT-5.6 起最少 30 分钟（可选 12 小时）；Codex 在 ChatGPT 登录下请求哪一档未知。

## 1.1 不变量

新增（减少损失，并让缺口可见）：
- **Z1 不把未知当成没有。** 轮换前检查 §16.1 的信息类别：已保存、可检索、未核实或不可恢复。捕获失败、视图裁剪、落后与无法恢复都给出可见标记；关键用户指示、目标或评审要求不明时，接手者记录问题并等待澄清。不能声称全部信息已保存，也不能用一次 ack 证明语义上零损失。
- **Z2 人的话保留原文。** 人打进本卡任何 Flowly 管理的 session 的消息、评论、开工说明和能拿到的图片按原样完整保存（脱敏后；存储不截断，只有视图有上限），从不转述。别的 agent 发来的消息另行保存，从不标成人的话。
- **Z3 能派生的不靠自报。** HEAD、分支、未提交文件、diffstat、评审轮次与结论、产物、测量值和能检测到的后台任务由 Flowly 读出。
- **Z4 接手要验证。** 新 session 对每个未决项给出处置，并报告它看到的 HEAD；Flowly 机械核对。
- **Z5 当前记录小，历史增量保留，视图有界。** 当前记录允许原子覆盖；移走与删除的条目按变化追加进归档，不为每次轮询或小修改追加全量副本。轮换才封存快照。视图裁剪必须有可继续读取的路径。
- **Z6 Flowly 的轮换是持久化的分阶段事务。** Flowly 不主动向同卡两个工作 session 并行派发；每步按 rotation id 幂等前滚或回滚。宿主直接消息、已在运行的进程和后台通知不受该事务控制，不能保证物理上绝无并行（§9.2、§16）。
- **Z7 不加载过大的历史。** Flowly 从不让 Paseo 加载前任的历史（唯一经 Paseo 的读取是已加载、B < 64 MiB 的 session 的内存 timeline 尾部，同今天的 `limitNotice`）；agent 从不直接读 provider 文件。

保留的产品不变量：自动化不归档 session，也不主动打断（唯一例外是 §4 第 5 条、需用户决定的一次 steer；Paseo 0.12 的 steer 可能退化为 interrupt，见 AUTOMATION-SPEC §10）；daemon 的消息以 `[Flowly automation]` 开头；普通追问和评论发送用户原文；任务上下文在 session 创建时或经显式的 work-instructions 给出；一张卡一个 workspace；用户可以选择收件 session；顶层卡的 Done 由人决定。

AGENTS.md 随实现增加一行例外：“Agent automation may start a fresh Flowly-managed session of the card at the boundaries in docs/SESSION-HANDOFF-SPEC.md; the card's handoff record carries continuity.”（2026-10-24 用户决定）。

## 2. 测量：上下文、历史字节、压缩、空闲与缓存

新模块 `server/provider-usage.ts`（由 `server/provider-history.ts` 扩展而来）。所有读取都只读、有界，从不触发 Paseo 加载历史：`refresh()` 走 `fetch_agent`（不加载 session）；不取 timeline；文件读取有预算。解析器防御式编写，读不懂就返回 `unknown`，从不抛错；结果按 `(path, size, mtimeMs)` 缓存。

| 符号 | 含义 | Codex（含 `persistence.metadata.provider == "codex"` 的衍生 provider） | Claude Code | pi / omp | opencode、ACP |
| --- | --- | --- | --- | --- | --- |
| **C** | 最后一个请求的上下文 token | ① `lastUsage.contextWindowUsedTokens`；② job 上保存的上次测量；③（P2）文件尾最后一条 `info` 非空的 `event_msg/token_count`：`last_token_usage.total_tokens` | ①②；③ 最后一条主链（`isSidechain:false`）assistant 记录的 `input + cache_creation + cache_read + output`，按 `message.id` 去重 | ①②；③ 最后一条记录的 `usage.totalTokens` | ①② |
| **W** | 有效窗口 | `model_context_window`（已是 95% 有效值：sol 475,000，astra/luna 258,400） | `lastUsage.contextWindowMaxTokens`，否则模型清单（Opus 5.5 1,000,000，自动压缩约 967k；Haiku 4.5 200,000） | 仅实时 | 仅实时 |
| **B** | 磁盘上的历史字节 | 父 rollout（今天的测量）；子代理线程（P3，`~/.codex/state_5.sqlite` 的 `thread_spawn_edges`，只读 `mode=ro`，失败退回只测父线程） | 主转录；子代理与 workflow 文件（`<sessionId>/subagents/**`、`workflows/*.json`）合计另记 **S**（只 `stat`，最多遍历 5,000 项，超出按 S ≥ 512 MiB 处理）。Paseo 逐个文件读它们，风险不同于 Codex 的单行读回，所以 S 有独立的观测线（§3.1，观察值，P2 用本机 Claude 数据校准） | `persistence.nativeHandle` 文件 | 未知 |
| **C₀** | 起始上下文 | provider 文件里本 session 第一条 `token_count`（被动捕获顺带读到，§4）；否则仅用明确属于第一次请求的测量；没有则 unknown，不能把第一回合结束的高 C 当成起始值 | 同左（第一条主链 assistant 记录） | 第一次测量 | 第一次测量 |
| **K** | 本 session 的 provider 压缩次数 | 回合结束钩子 timeline 里 `{type:"compaction", status:"completed"}` 的条数超过已存的数；或 C 降到前一次测量的 60% 以下（回合中每分钟测一次，只作疑似压缩并重给交接视图，不单独增加 K）；被动捕获读到带 `latest_token_usage_record` 的 `compacted` 记录（不带的是子代理继承父历史，不算；超过行预算被跳过的 `compacted` 行在行尾 4 KiB 里找这个字段），或 `item_completed ContextCompaction`；同一次压缩的这两个信号相隔几毫秒、先后不定、可能分在两次轮询里，一分钟内的第二个算同一次（第三轮） | timeline（带 `preTokens`）；被动捕获读到 `compact_boundary` | timeline | opencode：timeline |
| **I** | 空闲时间 | now − max(`job.sessions[role].lastTurnEndAt`，文件里最后一个请求的时间，若已读) | 同左 | 同左 | 同左 |
| **TTL** | 估计的缓存寿命 | 热 < 120 分钟；120–360 分钟只在 C < 200k 时算热；≥ 360 分钟冷 | 最后一次主链写入 `cache_creation.ephemeral_1h_input_tokens > 0` → 55 分钟后冷；`ephemeral_5m_input_tokens > 0` → 4 分钟后冷；读不到 → unknown（不单因缓存触发 R4） | 未实测则 unknown | 未实测则 unknown |
| **L** | 已加载（daemon 内存里有它的运行时） | `fetch_agent` 快照的 `status` 不是 `closed`（daemon 重启后恢复的 session 在被打开之前是 `closed`，`automation.ts:1389` 已据此判断）。P1 在真实 daemon 上核实；拿不准时按未加载 | 同左 | 同左 | 同左 |

- **为什么不只用 `lastUsage`**：它只在 daemon 内存里，daemon 重启后恢复的 agent 没有它；压缩后它会下降，掩盖已经压缩过。所以每个受监督 session 的回合结束时 Flowly 做一次 `refresh()`，把 C、W、B、K、轮次和时间存到 job 的 `sessions[role]`（§6.1），重启后它是回退值。
- **文件尾读取**（P2）：从文件末尾按 1 MiB 块向前读，预算 16 MiB（C5b.3 的 1.18 GB 文件里最后一条 `token_count` 在末尾前约 9.3 MB）；超过 256 KiB 的行按长度跳过，不缓冲；按子串匹配行类型，不整行 JSON 解析。只在决定确实需要 C 而 ① ② 都没有时才读。
- **何时测量**：软规则（R2–R4）在每个边界、每个指令 id 测一次，决定缓存在指令上；强制规则（R0、R1：字节、归档、消失、中毒）在**每次发送尝试**时重测，同今天的 `send()`（暂扣 40 分钟的发送期间 session 可能被人的回合撑大）；回合结束时一次；运行中的 session 在已有的 60 秒 `watchHistory` 里测 B（一次 `stat`；Claude 子代理每 5 分钟最多测一次；路径清单可缓存，但已知文件要重新 stat，不能把目录 mtime 不变当成子文件没增长）并做被动捕获（§4）；C 来自 `lastUsage`（一次 `refresh()`）或被动捕获读到的 `token_count`。
- **新 session 的代价 F**：约 108k token 的定向读取（C5b.3 #2），首个请求的计费与后续缓存命中按实际 provider 记录，不统一套用一个倍率。

## 3. 轮换触发与阈值

### 3.1 常量（`shared/session-rotation.ts`，不是项目设置）

```
rotationLimits = {
  bytes:  { rotate: 64 MiB, checkpoint: 128 MiB, noRead: 200 MiB, critical: 300 MiB },
  claudeSidecars: { observe: 512 MiB },                            // S（§2），只警示；测量与加载成本实测后才定自动动作
  fill:   { checkpoint: 0.60, tight: 0.70, cold: 0.50 },          // 占有效窗口
  tokens: { tightMax: 300_000, coldMax: 250_000, coldResume: 100_000, minGrowth: 30_000 },
  tightGapMin: 20,                                                 // 本卡上一回合结束（任一角色）→ 新指令
  softPerRun: 4, bytesPerRunBeforeHold: 3,
  unknownProxy: { turns: 8, activeHours: 3 },                      // C 未知（opencode/ACP）
  staleTurnMin: 5, silentMin: 20,                                  // §5.5；§4 的沉默信号
  live:   { pollMaxBytes: 64 MiB, skipLine: 256 KiB, messages: 8, gitEveryMin: 2 },
  finalize: { maxBytesUnloaded: 64 MiB, maxBytesLoaded: 200 MiB, noTurnStartMin: 10, noteAfterMin: 20 },
}
L_tight = min(0.70·W, 300k)    L_cold = min(0.50·W, 250k)
```

阈值是常量而不是项目设置：`AutomationSettings` 是严格对象，存一个新设置会让旧版本拒绝读取整个 `board.json`（AUTOMATION-SPEC §5.1 兼容）。开发者覆盖文件 `plugin-settings/flowly/rotation.json`（插件启动时读，只用于实测时调低阈值，不进 `board.json`）。今天 `historyLimits.rotate`（200 MB）同时是“不读不发”的界限，`oversized()` 等都用它；本 spec 把两者拆开：`noRead` 仍是 200 MiB，轮换降到 64 MiB。

| 模型 | W | L_tight | L_cold | 观测到的 Codex 压缩点 |
| --- | --- | --- | --- | --- |
| gpt-6.1-sol | 475,000 | 300,000（63%） | 237,500（50%） | 79–97%（C5b.3 在 393k） |
| gpt-6-astra / gpt-6-luna | 258,400 | 180,880 | 129,200 | 89%（242k） |
| claude-opus-5-5 | 1,000,000（≈967k 压缩） | 300,000 | 250,000 | — |
| claude-haiku-4-5 | 200,000 | 140,000 | 100,000 | — |

### 3.2 边界

边界是 Flowly 正要给某个角色**空闲**的 session 发指令或为它创建 session 的时刻：`send()`、`begin()`、`wake()`、评论路由（§10）。`job.instruction` 增加可选的 `kind`：

- **同一指令的后续**：`nudge`、`retry`、`cooldown`、`host_retry`。
- **紧密**：当前周期的 `changes`、评审者的 `round` 和人的 `comment`，距本卡上一回合结束（任一角色）≤ 20 分钟，且该 session 未冷（I < TTL；Claude 5 分钟档不要求，见 §3.3）。按本卡而不是按角色计时：对方的长回合（C5b.3 的 27.5 / 38.4 分钟修复回合、Deep 或小组评审）不是这个 session 的空闲，Codex 的缓存那时仍热。
- **其它**：`start`（agent 重新排队）、`again`、`wake`、`requested`（人点 Continue in a fresh session），以及超过 20 分钟的 `changes` / `round` / `comment`、新周期的第 1 轮。
- **特殊**：`finalize`，只发给即将被换下的 session（§6.2）。

### 3.3 决策（纯函数 `rotationDecision`，第一条命中为准）

| 规则 | 条件 | 结果 | 收尾回合 |
| --- | --- | --- | --- |
| R0 强制 | 评审者的 session 已归档或不存在，或 `starting`（Run again）时执行者已归档或不存在；换备用模型（§4.5）；中毒：失败回合的错误是上下文溢出 / prompt too long / HTTP 400 `invalid_request_error` / 历史无法恢复，或 session 加载后处于 `error`；B ≥ 200 MiB（不读不发） | 轮换（任何指令种类，包括后续） | 无 |
| R1 主机安全 | B ≥ 64 MiB（Claude 的 S ≥ 512 MiB 另行警示，不属于 R1 条件） | 轮换（任何指令种类） | 只在已加载（L）、B < 200 MiB 且满足 §6.2 的收尾条件时 |
| R2 已压缩 | 经 provider 标记确认的 K 自 session 创建后增加，且它的 C 峰值 `peakC` ≥ L_cold；只在**其它**边界 | 轮换 | 满足收尾条件时 |
| R3 上下文 | 紧密边界 C ≥ L_tight；其它边界 C ≥ L_cold；其它边界 C 未知时：≥ 8 个已完成回合或 ≥ 3 小时活动时间 | 轮换 | 满足收尾条件时 |
| R4 冷且大 | 其它边界，TTL 有已知估计、I ≥ TTL 且 C ≥ 100k | 轮换 | 无（冷） |
| R5 阶段 | 人的 Run again（§3.4）；新评审周期 → 新评审者；人点 Continue in a fresh session | 轮换 | 执行者满足收尾条件时；评审者从不 |
| R6 | 其它 | 保持 | — |

第一条命中为准。R0 与 R1 对所有指令种类生效，包括限额重试和宿主临时故障的重试；下面的“从不触发”指这些原因**本身**不引起轮换。job 运行中被归档或消失的执行者不在 R0 里：job 照 §6.3 失败，人的 Run again 再开新 session。

软规则 R2–R4 另须：从起始上下文 C₀（§2）算起的增长 `peakC − C₀` ≥ 30k（C₀ 未知时视为满足，并记录无法证明增长；不能用第一回合结束值制造一个永远触发不了的增长门槛）；同一次运行（generation）里软轮换最多 4 次，之后软触发被忽略、强制规则照常（§3.5）。不再要求最少回合数：19 个执行者里 7 个在第一回合就过了 50%，执行者中位只有 2 个回合，回合数门槛会让它们永远不轮换；抖动的标志是接班者没有进展，增长量正好量它。R2 用峰值而不是当前的 C：压缩后 C 很小，正是要轮换的时候。紧密边界上的 Claude 5 分钟档 session 即使已冷也保持：评审循环本来就在重读，`L_tight` 限住了代价。

**从不触发**：泳道移动；provider 限额与宿主临时故障的重试；普通失败（同 session 重试）；紧密边界上的已有压缩（刚压缩的 session 最近一回合的细节还在；它的已读状态被重置，下一次 `get_task` 重新给完整的交接视图，§5.9）。

### 3.4 Run again

- 人的 Run again 默认**新执行者、新评审者**（提案的阶段规则；Multica rerun 的理由“人刚判定之前的输出不好”；C5b.2 的冷恢复）。AUTOMATION-SPEC §4.1 的“沿用上一次的 implementer 与 reviewer session”、§4.5 的“实现者沿用原 session”对人的 Run again 不再成立。`queueIn()` 在同一个事务里把旧执行者推入 `retired`（§6.1）。
- 抽屉的 Run again 旁有 ⋯ → **Run again in session #n**：只在那个 session 活着、未因 R0/R1 被换下（不中毒、B < 64 MiB）时出现，旁边写测量的理由（例如 “236k tokens, idle 3 h: a fresh session is cheaper”）。人的选择优先，R0/R1 除外。
- 父卡的 `flowly_update_card action=start`（SUB-CARDS-SPEC §4）不算人的 Run again：保留 session，走 §3.3 的“其它”边界。
- 每次 Run again 的对话框都有一个可选的 “What should the next session know?” 文本框（不只在异常结束后：22 条打进 session 的人的话里约 9 条是方向或 Run again 说明）。写成人的输入（`via: run_again`，`open`），卡片有未答的问题（§5.2 `questions`）时框上方列出它们，可选择这段话回答哪一个或哪些问题；未选择时只作为候选，不能自动关闭全部问题。
- 执行者接班者用卡片开工时选的模型（`job.launchModel`，§6.1），受备用模型与限额规则约束；今天它只用于第一个 session（`automation.ts:1061`），轮换会把模型悄悄换成项目或全局默认。

### 3.5 防抖

- 软轮换的最小增长（§3.3），每次运行最多 4 次软轮换。
- 一次运行里第 3 次字节轮换（R0 的 B ≥ 200 MiB 与 R1 的 B ≥ 64 MiB 都算；Claude 的 S 不触发轮换，子代理多的正常评审不该被挂起）→ `needs_human` / `interrupted`（现有的 state/code），另记可选字段 `hold: "history_runaway"`；新版本显示 “History kept growing too large in 3 sessions; see the card's pitfalls”，旧版本显示 interrupted。
- 每个角色每条指令最多一次软轮换；软决定缓存在指令 id 上，强制规则每次发送都重判（§2）。回滚过的指令记在 `rotationAbandoned`，之后对它的软决定一律保持（§6.4）。
- 新 session 的定向读取（约 108k）低于 sol 的 `L_cold`；258k 窗口上 `L_cold`（129k）接近它，所以要求 `minGrowth`，从 C₀ 算起。

### 3.6 用证据回放

- **C5b.3 #1**：第 1 回合因容量失败（4.4 MB），重试是后续，保持。第 2 回合 50 分钟长 322 MB：约 19 分钟到 64 MiB，检查点提醒只在它调用 Flowly 工具时送达（§4）；被动捕获每分钟读新增的约 6 MB，记下 agent 的最新消息、HEAD 变化和启动的后台；约 28 分钟到 128 MiB，卡片记一条体积提醒（用户批准时再加一次 steer）。第 1 轮修改要求（B ≈ 327 MB）命中 R0（≥ 200 MiB，计入 hold 的字节轮换），不收尾，直接封存并轮换；接班者的首条消息有上次交接写入以来它自己的叙述（标为未核实）和 Flowly 的体积构成提醒（截图与 patch 写文件的次数和 MB）。按原有回合边界估算，第一个 session 约 327 MB 时会轮换；后续回合的行为会变，不能据此推断最大 session 大小，也不能预测 steer 能把它限制在某个 MB。实际历史为 1.18 GB，今天的守卫在同样边界的静态回放中约 583 MB。同样的回合在本设计下也可能出现在任何一个 session 里（真实那天的第 6 回合：5,034 条 shell 命令，最后 23 分钟没有 Flowly 调用，于是检查点提醒一次也没送达）：20 分钟时卡片显示 “Agent has not updated the card for 20 min”；验证 runner、轮询 relay 和浏览器标签在启动时就进了后台清单，崩溃后成为接班者必须处置的 `unknown` 条目；如果 agent 在可解析的消息里说过重跑结果、JSON 读取失败与原子 rename 的修复，且仍在捕获预算内，它们进入未核实叙述；只在工具输出里或早已被滚动窗口替换的部分不保证保留，并显示捕获范围。
- **C5b.3 评审者**（astra，61%，158k）在 28 分钟的修复回合之后评审第 2 轮：本卡上一回合 1 分钟前结束，紧密，C < L_tight（180,880），保持；按旧的按角色计时它会是“其它”边界（≥ 129k）而在周期中途被换掉。
- **C5b.2**：18 个回合 48.8 MB，R1 从不触发；416 分钟后的 Run again 默认新 session（也满足 R3/R4），冷而不收尾；新 session 从约 108k 开始，而不是 430k 未命中缓存再立刻压缩。
- **普通卡**（C1–C4b、C5a.x，间隔 2.5–15 分钟，执行者峰值 44–80%）：只有 C ≥ 300k 的评审→修复边界轮换，此时 session 热，做收尾回合。估计约四分之一的执行者轮换一次（待测，§17.6）。“从简”方案用 62 个 Codex 卡片 session 模拟过相近的规则：50 个自动化边界里轮换 10 个（12 个评审→修复里 4 个），已接受提案的 50% / 30 MB / 1 小时是 21 个（12 个里 8 个）；模拟用每回合的峰值请求，压缩后的值偏高。

## 4. 回合内的保护（回合中途不能轮换）

1. **检查点提醒**（总是开启；只对执行者和收尾中的 session，评审者不能写交接）：满足任一条件时记 `job.checkpoint = {agentId, reason, at}`，该 session 之后的每个 Flowly 工具结果都带 `handoffDue: "<reason>: update the handoff now (state, next, running)"`（现有 `reminders` 通道，不进 system prompt），直到有一次交接写入：
   - 填充 ≥ 60%（Codex 在 66–95% 压缩，压缩前记录要是新的）；
   - B ≥ 64 MiB 且按最近 3 次测量的增速 10 分钟内会到 200 MiB，或 B ≥ 128 MiB；
   - 回合活动 20 分钟没有交接写入；
   - HEAD 或未提交文件指纹自上次写入后变了；
   - 检测到压缩（§2 的 K）。

   它**只在 agent 调用 Flowly 工具时**送达。只跑 shell 或浏览器循环的回合（C5b.3 #1 的最后一回合：5,034 条 shell 命令，最后 23 分钟没有 Flowly 调用）一次也收不到，所以下面两条不依赖它。
2. **被动捕获**（P1；Codex rollout 与 Claude 主转录，其它 provider 只有回合结束钩子）：`watchHistory` 每 60 秒对回合中的 session，从上次的偏移读到文件末尾（每次最多 64 MiB，没读完下次接着读；超过 256 KiB 的行按长度跳过不缓冲，按行前缀判断类型，同 §8.1）。偏移存在交接文件的台账条目里（`through`），插件重载或 daemon 重启后接着读。文件被替换、缩短、滚动、解析失败或积压时不能假定连续：保留最后成功位置，重新定位并记 coverage gap（§5.7）；补读只减少遗漏，不保证全部捕获。取出：
   - agent 的消息 → 台账的滚动**实时叙述** `live`：最新 8 条，每条 ≤ 800、合计 ≤ 4,000 字符，脱敏（C5b.3 #1 的 agent 消息一共只有 21 KB）；
   - 回合中途打进来的人的消息与别的 agent 的消息 → 输入（§5.7），与回合结束时的捕获按 messageId 去重；
   - 启动或结束后台的工具调用（§5.7 的清单）→ 台账的后台条目，启动时就可见；
   - 压缩标记 → K 加一、重置已读（§5.9）、检查点提醒；`token_count` → C；Claude 的缓存写入档 → TTL；
   - 每一行（含跳过的长行）按类型与长度累计体积构成（`growth`），incident 与 hazard 便签不必再读一遍文件。

   回合中的 session 每 2 分钟最多一次读各仓库的 HEAD 与未提交文件指纹（§5.7 的 git 读取；读取失败也等 2 分钟；空闲的卡不轮询，在回合结束、轮换与交接写入时读，第四轮；只有轮询看到的回合结束也读一次，上次整次读取失败的卡每 2 分钟再读，空闲时也是，第五轮）：与上一次记录不同就写一条 Flowly 的 `checkpoint` 便签（“HEAD 50a7993 → dc26c13 (2 commits: …); 3 files uncommitted”），每个 session 最多每 5 分钟一条。只在有变化时写交接文件；如果首次变为过期，可同步更新一次小索引，之后不随轮询重写 `board.json`。
3. **沉默信号**：Flowly 在内存里记每个回合中 session 最后一次 Flowly 工具调用的时间。回合已进行 20 分钟、且 20 分钟没有调用 → `job.silentSince`（一次看板写入），下一次调用或回合结束时清除（一次写入）；卡片自动化区显示 “Agent has not updated the card for N min”（N 由客户端算，§12）。
4. **体积提醒**：B ≥ 128 MiB 时卡片记一次 `automation_history_large`（今天在 300 MB），自动化区显示 “Session history N MB: the next instruction goes to a fresh session”。B ≥ 300 MiB 仍在增长时显示严重信号 “Session history N MB, still growing: stop this session in Paseo”。`historyWarning` 加可选的 `level: "large" | "critical"`，每级每个 session 记一次。
5. **一次检查点 steer（待用户决定，§19；决定前关闭）**：在 128 MiB 或上面的增速预测处，每个 session 一次，`activeTurnBehavior: "steer"`：
   > `[Flowly automation] Checkpoint: this session's history is 131 MB and grows ~12 MB/min; Paseo crashes when it loads histories near 500 MB. Update the handoff now (flowly_update_handoff: state, next, running), stop the loop that produces the bulk (screenshots, relayed commands, files written with your edit tool), and end this turn. Flowly continues in a fresh session.`

   这是 Flowly 第一次有意往进行中的回合里发消息，而 steer 在 Paseo 0.12 可能退化为 interrupt。它是唯一不依赖 agent 调用 Flowly、又能让 agent 本人在回合中途更新记录的手段：第 2、3 条只是 Flowly 旁观和告诉人。不开启时，单个回合仍可能超过 500 MB，只有 Paseo 自己的修复能补上。
6. **Skill 卫生**（扩展 AUTOMATION-SPEC §4.6 的 Skill 一条）：截图、DOM 和日志写到文件；不通过自己的工具或 Codex 子代理转发浏览器命令；**批量文件（fixture、抓到的响应、生成的数据）用脚本或 shell 生成，绝不用编辑/patch 工具，包括 code-mode `exec` 里调用的 `apply_patch`**：Codex 会把它们的全文记进历史（C5b.3 的 519 MB）。

`watchHistory` 的范围扩大到：当前活动的 session、job 的评审者、本卡正在回合中的被换下 session。

## 5. 交接记录

### 5.1 存放位置

- 每卡一个文件 `plugin-data/flowly/handoffs/<taskId>.json`，按卡串行写入，临时文件 + rename，0600；读不懂的文件保留、不重置（写入返回 `HANDOFF_UNAVAILABLE`）。同 `SummaryStore` 的做法。
- 每卡一个目录 `plugin-data/flowly/handoffs/<taskId>/`：`images/`（开工图片、能拿到的 session 图片，每卡最多 20 个文件、20 MB）、`inputs/<id>.txt`（长输入或为当前 JSON 预算移出的输入正文）、`sealed/<rotationId>.json`（轮换时的封存快照）、`skeletons/<agentId>.jsonl`（§8）、`archive.jsonl`。
- **写盘原则**：当前小记录用临时文件、flush/fsync、rename 及目录同步提交；归档只追加移走条目和变更，不在每次更新时抄整份记录。归档先按稳定 id 落盘，再从当前记录移走，崩溃后按 id 去重；封存快照只在实际交接时生成一次，不能每分钟生成。被取代的版本只在语义变化时归档（2026-10-25 第二轮）：台账条目在角色、结束、回合、后台条目或接手确认变化时才归档上一版，游标、测量、增长、叙述预览、覆盖说明与脚本计数这类几乎每次轮询都变的观察状态原地覆盖；分组缺口的计数与时间增长原地覆盖，重新打开或关闭才归档。没有新 provider 数据、没有新 timeline 内容的轮询什么都不写（revision 不变，`entries/` 与 `ops/` 不增加）：观察者比较的是将要存下的 JSON（第二轮修正：恢复的游标以前带一个值为 undefined 的 `skipping` 键，存下的 JSON 里没有它，于是每次轮询都算变化，空闲的卡片约每分钟一个新 revision，按刚读到的 revision 准备的 ACK 被 `ACK_MISMATCH` 拒绝；实测卡片上三个空闲 session 7.6 小时写了 263 次）。存储层同样（第四轮，2026-10-25）：一次事务的改动去掉 revision、写入时间、写入者、`ops` 环、条目的 `rev` / `at` / `contentRef` 与 Git 快照的读取时间之后若与原记录相同，就什么都不写：revision 不变，不写回执，不写一个字节（以前每个事务都取新 revision、写回执和 `ops`。上一轮的实测是 69422d8 装上后 22 张卡里 18 张、多是停着或空闲的卡每 1–3 分钟一个新 revision，两版之间只差 `ops` 环；能复现出这个形状的路径是观察者把一条被 40 条上限挤进归档、已确认关闭的 Flowly 缺口（`git-unavailable`、`git-coverage`）在每次 Git 观察时重新捕获，store 按来源去重后没有改动，却照样写了，Git 读取失败时还不受 2 分钟的间隔限制）。空闲的卡也不再按 2 分钟读仓库：Git 只为回合中的 session 轮询（§4 第 2 条本来就只说回合中的 session），空闲的卡在回合结束、轮换与交接写入时读（`forceGit`），ACK 自己读 HEAD。第五轮（2026-10-25，第四轮的复查）补上三处：(1) `flowly_update_handoff` 自己读到的 HEAD 与这次写入落在同一个 revision（以前先单独写一个 `git-before-update` 的 revision 再应用更新：空闲卡的 Git 只在回合结束时读，共享根里别的卡一提交，接班者按刚读到的 revision 准备的 ACK 就落后一个而 `ACK_MISMATCH`，实测的共享根上几乎总是这样）；被拒绝的写入仍单独记下读到的 HEAD，它要求的重读能看到。(2) 回合结束钩子丢了（回合中插件重载、daemon 重启，或钩子在观察之前失败）时，轮询看到 session 已不在回合里而 `turnStart` 还在，就为这个回合读一次 Git；`turnStart` 留给迟到的钩子记回合的开始，读过的回合只在内存里记，重载之后至多再读一次（以前这个回合最后的提交在卡空闲期间一直不上卡）。(3) 整次读取失败时快照本身标为 unobserved（保留最后已知的 HEAD，没有快照时为工作区记一个 `sha: null` 的占位），所以缺口确认之后 Git 再次读不到时卡上仍然看得到（“Some repository state could not be verified”），重复的失败不再写；这样的卡每 2 分钟重读一次，空闲时也是，直到读成功（只对整次读取失败；单个仓库快照自带的错误不重读，否则共享根里别人的编辑又会每 2 分钟换一次 revision）。只读实测（第四轮，2026-10-25 12:40–13:05 UTC，69422d8）：20 张以共享项目根 `/Users/citrine/Projects/flowly-kanban` 为工作区的卡写了 81 次，每次一个 revision、只有 Git 变了，变化来自这一轮自己在其中一个仓库（`flowly-session-handoff` 工作树）里的编辑：每张空闲或停着的卡都在下一次 2 分钟的 Git 观察时记下它，把准备好的 ACK 所指的 revision 推走；这段时间里没有只差 `ops` 的写入。周期性的调用方全部在这两条规则之内：观察者的 60 秒轮询（每次最多 8 个 session，轮转；provider 捕获、测量，以及回合中的 session 每卡每 2 分钟最多一次的 Git 快照，失败也一样，只有轮询看到的回合结束读一次，上次整次读取失败的卡每 2 分钟重读，和覆盖缺口），回合开始时的 `ensureSession`（只在角色变化时写）与回合结束钩子（重复投递的同一个 timeline 不写），自动化 15 秒一次的调度（只在轮换进行中经桥写入：prepare、seal、committed 的重试、abandoned），`get_task` 的 `handoffDue`、抽屉的 etag 读取与它们的 `reconcile`（只确认待确认的来源），以及 `syncIndex`（只在索引值变化时写 `board.json`；捕获什么都没写时观察者不再调用它）。`server/handoff-idle.test.ts` 在真实文件上跑这整个空闲循环：三张空闲卡、六个 session（Codex 与 Claude，含被换下的、工作区读不到的、仓库超过检查上限的、已不存在的）、真实 Git 仓库（循环中别的卡在共享的仓库里提交、再改一个已改过的文件）、自动化调度、30 分钟的假时间与一次插件重载，所有交接文件与 `board.json` 的字节和每张卡的 revision 都不变，之前准备的 ACK 经 `flowly_update_handoff`（`HandoffService.update`，带接班者核实的真实 HEAD）仍然成功，并在同一个 revision 里记下共享仓库的变化，下一个回合结束再补上之后的变化（第五轮：以前测试直接调用存储层的 `update`，跳过了服务自己的 Git 刷新；三个 Codex session 的 rollout 写在定位器不找的日期目录里，从没被读到，现在断言每个有 provider 文件的 session 都被读到）；同一文件里一个安静的长回合（provider 文件不增长、工作区读不到）也什么都不写。69422d8 上同一个空闲循环里一张卡多了 30 个 revision（归档缺口的重复捕获）、另一张多了 2 个（别人的 Git 改动），安静的长回合多了 12 个。在途占位（`inFlight`，§5.7 脚本一条）在它的 session 回合中时同样是观察状态：它出现与消失都不归档台账版本。否则接班者必读的 `handoff:"full"` 要翻过每分钟一份的台账快照。已经写下的旧快照也不再读（第二轮）：完整读取（`scope: "all"`，及只读归档的 `scope: "archive"`）跳过历史（角色、结束、回合、后台条目、接手确认）与下一个版本相同的归档台账版本，它们只差游标、测量这类观察状态，较新的版本有同样的历史；页里的 `supersededSnapshots` 写明跳过了几个，正文仍在 `entries/`。实测（接手卡片 2026-10-25 10:26 UTC 的只读副本）：3fe9409 的 store 下必读的完整读取是 101 页 / 596 项，其中 302 个归档台账版本，几乎每两个相邻版本只差 `capturedThrough` 与 `through.at`；现在 7 页 / 307 项，保留 13 个台账版本、跳过 289 个（ACK 之后 8 页 / 348 项）。仍安装着的 786d9cd 在被替换之前每小时还会加约 35 个版本（它们同样被跳过）。第六轮（2026-10-25，第五轮的复查）：(1) **观察状态原地写入，不换 revision**。接班者在自己正在跑的回合里读卡和 ACK，它读的每一页、跑的每个检查都是它自己 provider 文件里的新数据；60 秒的轮询把移动了的游标与测量记成一个新 revision，必读的完整读取于是 `viewChanged`、从第一页重来（重来时读的页又是新数据），准备好的 ACK 被 `ACK_MISMATCH` 拒绝（69422d8 与 7226099 上都是：每分钟读一页的 3 页读取重来 12 次也没读完；只多了一次 `git rev-parse` 的 ACK 被拒）。现在一次事务的改动若只是观察状态，就原地写：revision、写入时间与写入者不变，改到的条目保留它上一次被钉住的变化时的 `rev` 与 `at`，不写归档行，只有显式的 operationId 才写回执（Flowly 自己的轮询每次用新 id，回执只会填满 `ops/`），它的 intent 带 `inPlace`，崩溃后同样恢复。观察状态是：台账条目的游标、`capturedThrough`、测量、增长、叙述预览、覆盖说明、脚本计数、在途调用与进度事件（`ledgerHistory` 去掉的那些）；Git 快照（Flowly 在每次回合结束、轮换和交接写入时重读，ACK 拿它自己刚读的 HEAD 核对，完整读取的页里没有它；共享项目根里别人的编辑也因此不再每 2 分钟挪走回合中的卡的 revision）；读缓存 `seen`。页游标、ACK 与条目冲突钉住的 revision 只随其余的改动前进：人的话、便签、缺口、评审、真实的后台条目、回合、角色、结束、ACK、检查点与 lastWords。观察若让记录超过 1 MiB、把一个条目挤进归档，那就是历史，照常换 revision。原地写入之后观察者照样同步看板索引（覆盖不全、Git 读不到都会改变 `fresh`）。代价：只有观察状态变了时，同一 session 再次 `get_task` 得到 `unchanged` 的存根，不重给视图（Git 变化由 due 的 “Repository state changed after the checkpoint” 说出，抽屉的 etag 按内容算，照样刷新）；备份目标里已有同一 revision 时不重抄（两者只可能差观察状态）。(2) **每个结束的回合只归档一次**。`turns` 是历史，以前每次回合结束都归档整份上一版台账条目（最多 10 个回合的 final，各 ≤ 2,000 字符，加叙述预览与后台条目），完整读取把每一份都返回：每 3–4 个回合多一页，60 个回合之后约 1.1 MiB、18 页，一个回合的 final 出现 15 次。现在上一版只在回合以外的历史变化（角色、结束、后台条目、ACK）时，或一个还没有归档版本持有的回合离开 10 个的窗口时归档，一个事务至多一次（对照事务开始时的版本）；归档的版本只是历史：只带更早的归档版本没有的回合（`turnsArchived` 记下已归档的最大回合号，存储层自己的簿记），不带原地覆盖的观察状态。60 个回合归档 5 个版本，离开了窗口的回合在读取里只出现一次，窗口里的回合至多两次。首次实现先有一个当前记录和增量归档，完整历代台账、骨架与图片恢复按 §18 后续增加。第七轮（2026-10-25，第六轮的复查）再补三处，都在接班者自己的回合里：(1) open 的分组缺口只是计数、第一次与最后一次出现变了时原地写入（交付门的指纹本来就把它当同一项义务，§5.5）；新缺口、关闭与重新打开仍换 revision。以前缺口的每个字段都被钉住，接班者自己一次超过 256 KiB 的测试输出或 `git log -p` 就让它的整读从第 1 页重来（`viewChanged`），准备好的 ACK 被 `ACK_MISMATCH` 拒绝（评审数过：本机最近 341 个 Codex rollout 里 55 个有这样的工具输出行）。(2) session 在回合中自己产生、长得读不了的内容（不是人的话的长行：工具输出、它自己的叙述；超出上限的工具结果）回合中只计数（台账条目观察状态里的 `held`，覆盖说明写出条数），回合结束（空闲、不在或结束，且 provider 文件读到末尾）或封存时才成为那条分组缺口，所以它也不会在回合中重新打开自己刚处置过的缺口；人的长输入照旧立即是缺口。(3) 回合中的 session 自己启动的 exec session（Codex 的 yielded `exec_command`、Claude 的后台 Bash 与 Monitor）在那个回合里是观察状态（`transient`），同在途调用：在卡上，不是历史、不归档台账版本、不是 ACK 要处置的 id；同一回合里结束就去掉，不留 closed 条目；回合结束或封存时还在跑才成为历史与要处置的 id。`write_stdin` 轮询不再改写条目的 `callId`（以前每次轮询都是一个新 revision 外加一个归档的整版台账；30 个各轮询 3 次的命令是 120 个 revision、120 个归档版本，完整读取从 1 页涨到 8 页）。P2（`sw/hybrid-boundaries`，§21.6）多两个周期性的读取方，也在这两条规则之内：(1) 观察者对回合中的 session 的轮询以前每次都把 `turnStart.observedAt`（活动时长的证明，§21.1）改成当前时间写进台账条目的观察状态：移植第四轮之前每次轮询一个新 revision（15 次安静的轮询从 revision 15 到 30，准备好的 ACK 被 `ACK_MISMATCH` 拒绝），移植之后 revision 不变而每次轮询仍重写一次文件；现在 `turnStart` 只在第一次看到这个回合时写，之后的证明留在内存，有新 provider 数据时随游标写下。(2) 自动化调度每分钟一次的监视（`watchHistory`）对回合中的执行者只读测量（经桥的 `measure`，不进卡的队列、不写交接记录），只在历史字节样本、提醒级别、`checkpointSeen`、检查点提醒或 `silentSince` 变化时写 `board.json`。`server/handoff-running-quiet.test.ts` 用生产接线（含这个调度的 15 秒一次的调度）证明：接班者读完、准备好 ACK 之后，15 分钟安静的回合里所有文件的字节与 revision 都不变，ACK 照常应用。
- **总预算也是约束**：列表各自的上限相加并不等于文件大小有界。当前 JSON 的 UTF-8 编码硬上限为 1 MiB；大文本正文放独立文件，较早的派生叙述、已结案条目和评审移入归档，只在当前 JSON 留 id、状态和读取引用。只有 open 条目时也可以移正文，不能丢掉当前待办索引。首版不设计自动删除历史；统计当前文件、归档、封存与图片的实际字节，超过 32 MiB/卡时给一次空间警告。后续清理必须有单独的保留政策，不能默默移除原话或证据。
- **两个文件不是一个原子事务**：本稿提到问题/评审与看板“同一事务”，语义是同一次可恢复的服务操作，不能只异步 best effort 写交接。先校验权限并以稳定 operationId 写待确认的语义记录，再提交看板事件/job，成功后确认来源；中间崩溃以该 id 对账，重复追加按 id 去重。看板提交未被证实的条目标 `unconfirmed`，不能当成已接受的结论或新指令。未确认来源没有清理前不能裁掉对应恢复信息。磁盘写入失败则明确失败/待对账，不能回复“交接已保存”。实现须在每个落盘切点做故障测试，而不是用原子 rename 宣称两个文件原子一致。
- **不放进 `board.json`**：手机解码每一次看板读取（board.json 今天 1.5 MB）；旧版本重写 board.json 会丢掉不认识的字段，而独立文件不受影响，降级后记录仍在。`board.json` 只多一个小索引：顶层数组 `handoffIndex: { taskId, fresh, staleSince?, open, sessions }[]`（约 100 字节/卡），随 etag/delta 读取到达客户端（`server/board-delta.ts` 的 keyed 集合加一项，按 `taskId`），卡面据此显示记录落后多久（§12）。它**只在这些值变化时**写：回合结束、轮换、记录变为过期或重新变新；agent 的每次交接写入、检查点和被动捕获都不写 `board.json`（十张卡在跑时不该每小时几十次重写 1.5 MB 的文件、给手机推 delta）。看板 schema 不严格，旧版本丢掉它，由文件重建。
- 抽屉只在 Handoff 区展开时用 etag RPC `handoffs.read {taskId, etag?}` 读。人的写入：`handoffs.note`、`handoffs.input`（把一条输入标为 done / superseded / standing）、`handoffs.removeNote`。
- 删卡、移除项目时删除文件和目录，记录及其归档、输入正文、封存快照（不含可重建的骨架，图片未备份时明确记缺口）随删除备份写入 `removed/`。wrap up 与归档保留。从项目文件夹恢复（[PROJECT-FOLDER-SPEC](PROJECT-FOLDER-SPEC.md) 的 `projects.restore`）时，恢复的每个 taskId 若在 `removed/` 里有交接备份就放回，否则卡片回来了而决定、坑、评审轮次和台账全没了。项目文件夹快照默认不带交接，跨机器恢复时明示缺口；本机备份与显式导出的区别见 §19。

### 5.2 结构（`shared/handoff.ts`，zod，有界）

```
CardHandoff {
  version: 1, taskId, projectId,
  revision: int,                         // 自己的 revision（同 workpad），不改 task revision
  updatedAt, updatedBy: { kind: agent|human|flowly, agentId? },
  checkpoint?: { agentId, at, heads?: { repo, sha12 }[], dirtyHash?, turnStartedAt? },   // 上一次 agent 写入时的状态

  // —— 当前执行者写（每个条目都有 id、by、agentId?、at、rev）——
  state?:    { text ≤1200 }                                   // 一段话：现在到哪了、正在跑什么
  done:      { id "dn-*", text ≤300, ref? ≤200 }[] ≤30        // ref：SHA、artifact id、路径
  decisions: { id "dc-*", text ≤300, why ≤400（必填）, source?（输入 id） }[] ≤30
  ruledOut:  { id "ro-*", text ≤300, why ≤400（必填） }[] ≤20 // 试过并放弃的做法
  problems:  { id "op-*", text ≤400, status: open|resolved, note? ≤300 }[] ≤20
  next:      { id "nx-*", text ≤300, gate? ≤200 }[] ≤12        // 有序；gate：先要满足什么
  pitfalls:  { id "pf-*", text ≤400 }[] ≤20                    // 硬规则与危险，agent 自己的话；人的长期指示标为 standing 输入，不抄进来
  running:   { id "rf-*", what ≤200, how ≤300, check ≤200, owner: agentId, startedAt, status: running|done|unknown, endedAt?, result? ≤300 }[] ≤12
  where:     { id "wh-*", ref ≤300（路径|artifact id|URL）, what ≤200 }[] ≤30
  env:       { id "ev-*", text ≤300 }[] ≤12                    // 安装、服务、版本、密钥放在哪（从不写密钥本身）
  // 以上合计 ≤ 16,000 字符（HANDOFF_TOO_LARGE 给出各段大小）；skill 建议通常 ≤ 4,000

  // —— 人、Flowly、被换下的 session 追加（带时间）——
  notes: { id "nt-*", at, by: { kind: human|flowly|agent, agentId? }, kind: incident|direction|environment|hazard|background|checkpoint|retired_turn|other, text ≤2000, metadataOnly?: true }[] ≤100   // metadataOnly：Flowly 从 Paseo timeline 行的 metadata 重建、没有通知原文的便签（第七轮，§5.7）；原文到了就替换它
  gaps:  { id "g-*", at, by: reviewer|successor|answerer|flowly, agentId?, text ≤300, status: open|closed,
          count?, firstAt?, lastAt?,                       // Flowly 捕获缺口按 session、kind、typeHint 分组（§5.7）
          countAtRevision?,                                // 原地计数之后当前 revision 时的计数，只在 count 已超过它时存在（§7.5，P2 复查第一轮）
          resolution?: { by, at, note ≤300, count? } }[] ≤40   // count：确认（关闭）时覆盖的出现次数

  // —— Flowly 派生，agent 不能写（agent 只能改状态、standing 与问题的撤回）——
  inputs: { id "d-*", at, atSource: typed|captured, via: session|comment|launch|run_again|composer|retired_session|agent,
            agentId?, from?: { agentId?, title ≤120 }（via agent：发来消息的 agent）, commentId?, messageId?,
            text?（原文，脱敏；预算允许时内联）, textRef?（全文在 inputs/<id>.txt）, characters, truncatedInView?, redacted?: true,
            images?: string[] ≤6, imagesLost?: int, standing?: { by, at }, answers?: q-id[],
            status: open|received|done|answered|superseded|declined,
            handled?: { by: { kind, agentId? }, at, note? ≤300 } }[] ≤200
  questions: { id "q-*", kind: question|blocker, text ≤1000, askedBy: agentId, at,
               status: open|answered|withdrawn, answeredBy?: input id[] ≤5 }[] ≤40
  reviews: { cycle, round, level?, panel?, reviewerId, verdict: approve|changes|incomplete, summary ≤4000,
             findings: { id "c<cycle>.<round>-<k>", text ≤1000, status: open|done|obsolete }[] ≤20,
             risks: string(≤500)[] ≤10, gaps: string(≤300)[] ≤5,
             delivery?: { event?, text ≤1500 },              // 这一轮评审的那次交付的说明（同 cardHandoff 的上限）
             at }[] ≤30
  ledger: { agentId, n, role, provider, model?, startedAt, endedAt?, reason, endReason?, abandoned?: rotationId,   // session 台账
              measured: { C?, C0?, W?, B?, S?, K?, turns, peakC? }, finalized: boolean, handoffRevisionAtEnd?,
              turns: { n, startedAt, endedAt?, outcome, final? ≤2000, wroteHandoff }[] ≤10,   // final：回合最后一条 agent 消息，脱敏
              capturedThrough?: n, through?: { path, identity, offset, size, at, lagBytes, gaps },                      // 已捕获到第几个回合、provider 文件读到哪
              live?: { at, text ≤800, truncated?: true }[] ≤8,                                              // 实时叙述（§4），合计 ≤ 4,000
              background: { id "b-*", kind: async_shell|exec_session|browser_tab|terminal|script|subagent|schedule|heartbeat,
                            ref, label ≤120, startedAt, status: open|closed|unknown, outcome? ≤120, source: hook|live|skeleton, inFlight?: true, event?: ≤200, transient?: true }[] ≤40,   // outcome：怎样结束（退出码、工作流状态、async shell 结果、经 ACK 处置）；inFlight：回合中的 session 里结果还没读到的启动调用（§5.7），不是历史，也不是 ACK 要处置的 id（第六轮）；session 空闲、不在或封存时去掉；event：仍在跑的任务报告的最近一个进度（Claude Monitor 的事件，脱敏、有界），观察状态，原地覆盖；transient：回合中的 session 自己启动、还在跑的 exec session（第七轮，§5.7），同 inFlight 不是历史、不是 ACK 要处置的 id，同一回合里结束就去掉，回合结束或封存时还在跑才成为历史
              anchors?: string[] ≤60, growth?: { kind, calls, bytes }[] ≤12, nextMoves?: string[] ≤3,
              skeleton?: path, ack?: Ack, understanding? ≤800,
              scriptCalls?: int }[] ≤200                       // 说明性计数：脚本/工作流调用，其内部工具调用不逐条列出（§5.7），不是待办
  git: { repo: path, branch?, head?, dirty, dirtyCount, dirtyFiles: path[] ≤50, diffstat? ≤1000, upstreamDiffers?, at }[] ≤8
  lastWords?: { agentId, at, since, text ≤2000 }             // 没收尾就封存、而记录落后时的叙述兜底（§5.8）
  tombstones: { section, item, removedBy, reason ≤200, at }[] ≤300
  seen:  { [agentId]: revision }  ≤200                       // 这个 session 读到过的 revision（§5.9 的存根）；检测到压缩时删除
  digests: { [agentId]: { [digest]: count } }  ≤500 项        // 没有 messageId 的消息按摘要计数去重（§5.7）
  archivedOpen?: int                                         // 因溢出移入 archive 的 open 输入数
  ops: string[] ≤50                                          // 最近的 operationId（重放）
}
```

- 人的话在 `inputs` 里存原文全文：评论的事件只保留最近 50 条（CARD-COMMENTS-SPEC §7.2），记录不能依赖它。上限只在视图里（§5.9）。
- 有上限的列表（`inputs`、`notes`、`ledger`、`reviews`、`questions`、`tombstones`）满了时，最旧的、不是 open 的条目移入同目录的 `archive.jsonl`，不删除（Z5）；`handoff:"full"` 的后续页与抽屉 Show earlier 可读。只有 open 的条目时，最旧的 open 正文也可移入，但当前待办索引保留 id、首行与读取引用，`archivedOpen` 加一，并记 gap。接手确认包括这些归档中的未决 id；不能因为正文不在第一页就从确认名单中消失。
- `reviews` 的长度与 `reviewInputSchema` 一致（摘要 4,000、每条发现 1,000、最多 20 条），不截断；`delivery.text` 让后面的评审者能逐轮对照“要求了什么、交付时说怎样做了”；最坏约 800 KB/卡，不在看板读取里。今天只有最近一次的 `job.changes` 留下，人的反馈开新周期时还会删掉它（`turnStarted`），更早的修改要求和交付说明落出 100 条事件窗口后就没了。`cycle` 来自 job 的 `cycle` 计数（§6.1），不从事件推算（裁剪或重启后会重号）。
- 另外，`store.event()` 给评审结论事件（`automation_changes_requested`、`automation_review_approved`、§5.2 的 `automation_review_risks`）一个单独的保留类：每卡最新 10 条在 100 条窗口之外（同评论），活动里看得到所有轮次。旧版本按 100 条裁剪它们，无害。

### 5.3 预算

| 内容 | 上限 | 通常 | 理由 |
| --- | --- | --- | --- |
| agent 写的各段合计 | 16,000 字符（硬） | 2–6k | 管用的那份 §8 约 2,967 字符；Flowly 每条链接的 handoff 预算已是 6,000、总共 16,000 |
| `get_task` 的默认交接视图 | 24,000 字符；人的话、未答的问题、最近一轮的发现和人与 Flowly 的要紧便签有保留预算，agent 的各段填剩下的（§5.9） | 3–8k | 每个 session 一次，压缩后再给一次（§5.9） |
| 评审者的默认视图 | 40,000 字符（本周期优先；超出后沿游标取全文） | 5–15k | 评审要逐条核对更早的要求（§11.1） |
| `handoff:"full"` | 每页 96 KiB；带总数、省略计数和下一页游标 | — | 按需读取当前记录、长输入及归档，不能把第一页称为全文 |
| 当前 JSON | UTF-8 ≤ 1 MiB（硬） | 20–60 KB（待实测） | 仅展开抽屉或 agent 按需读取；不能靠各列表上限估算 |
| 每个 session 的骨架 | 2 MB | 1.18 GB 的线程约 37 KB | §8 |

### 5.4 谁写、何时写

| 写的人 | 写什么 | 何时 |
| --- | --- | --- |
| 当前执行者（`flowly_update_handoff`） | 各段、`note`、输入的处置与 `standing` 标记、撤回自己的问题、接手确认（`ack`） | 读完卡后（state、next）；**每次提交后**；**开始预计超过 5 分钟或在后台运行的事之前**（并写 `running`）；做出决定或放弃一个做法时；处理完人的一条话时；收到 `handoffDue` 时；每个工作回合结束前（清单第 5 条）；收尾回合里 |
| 被换下的 session | 只能写 `note`（checkpoint / background）和更新自己的 `running` 条目；收尾指令开始的迟到回合可写全部各段（§6.2 1c） | 被唤醒时（§9.3） |
| 评审者 | 不能写（`REVIEWER_ONLY`）；经 `flowly_submit_review` 报告 `handoff.gaps` | 每一轮 |
| 人（抽屉） | `note`（direction / incident / environment / other）；把输入标为 done、superseded 或 standing；删除自己的便签 | 任何时候；每次 Run again 的 “What should the next session know?”（成为输入，§3.4） |
| Flowly | 派生字段（含 `questions`、每回合的最后一条消息、实时叙述）；incident / hazard / checkpoint 便签（例如 “Session #1's history grew to 327 MB: browser_screenshot 1,346 calls 471 MB, apply_patch adds 9,870 files 519 MB”）；台账；gaps（answerer / flowly） | 回合结束钩子返回之后（同 `WorkpadService.recordTurn`，从不阻塞钩子）；回合进行中每分钟（被动捕获，§4）；`report_progress` 的同一事务里（`questions`）；轮换时；评审结论的同一事务里（`reviews`）；意外结束时 |

### 5.5 新鲜与过期

记录**过期**指上次 agent 写入（`checkpoint`）之后发生了**实质变化**：
- 任一仓库的 HEAD 或未提交文件指纹（`git status --porcelain` 加受影响文件的 mtime / size 指纹；仅状态文字不能发现同一个已修改文件继续被编辑）变了；
- 出现了状态为 `open` 的人的输入、新的评审结论或新的交付；
- Flowly 写了 incident / hazard 便签；
- 一个活动时间 ≥ 5 分钟的回合结束了，而这个回合里没有交接写入。只调查、不改文件的回合也算：排除了一个做法、发现一个环境怪癖时 HEAD 不变，知识却只在 session 里。

“上一回合比记录晚结束”本身**不算**过期：agent 按清单在回合结束前写入，这样的记录是新的；不到 5 分钟的回合（回答一句、一次提醒）也不算。

**交付门 `HANDOFF_STALE`**（软的，与 `WORKPAD_OPEN` 同一套 `DeliveryGate` 机制，原因合并为一次拒绝）：开启自动化的项目里，执行者的 `flowly_update_status(in_review | blocked)` 与 `flowly_report_progress(kind=blocker | question)` 在记录过期、缺 `state` 或 `next`、或接班者还没确认接手（§7.5）时第一次被拒，列出变了什么；同一回合带 `acknowledgeOpen=true` 的重试通过。提问也受此门约束：自动化下提问就结束回合（C5b.3 #2 唯一的回合以提问结束），回答常常到达一个新 session。父卡派出子卡后结束回合进入 `waiting` 时没有可拒的调用，所以 `flowly_create_card` 与 `flowly_update_card action=start` 的结果在记录过期时带 `handoffDue`（不拒：拒绝建卡会打断编排）；什么都不调用就结束的回合由 §5.7 的最后一条消息与 §5.8 的叙述兜底。拒绝说明自己写明怎么做（“update the handoff with flowly_update_handoff, then retry with acknowledgeOpen=true”），所以清单第 6 条不必改（改了就超过 1,800 字符，§13）。

门禁记住的是已列出的**语义要求**，不是整个交接文件的 revision（在途占位不是新的要求：一次轮询碰巧看到一个调用正在运行，不能让同一回合的重试再被拒一次；它仍在卡上，不在 ACK 的必须处置名单里（第六轮）；session 空闲、不在或封存之后它是遗留的工作，进指纹与名单，第五轮）：新的原话、评审、人的备注、风险或真实 coverage gap，卡片/workpad/HEAD 的改变，或新回合需要重新拒绝；相同 state/checkpoint 的更新、原话维持 open 并补充“留给接班者”的处理说明、seen、无新缺口的捕获游标、用量与采样时刻不重置已有确认。不可只比较通用 due 句子，两条不同原话或两轮评审可能产生相同句子。指纹使用完整当前记录及 overflow 索引，不使用截短的 UI 首页或扫描长期归档；归档索引保存与当前条目同算法的可选 `requirementsHash`（null 表示无待确认语义），因此仅搬到归档不算新要求。旧索引缺这个字段时保守用其不可变内容引用：重载该条目时可能额外拒绝一次，不在开门时读取所有旧正文。

### 5.6 工具 `flowly_update_handoff`

MCP 与 CLI fallback（`handoff --handoff '<JSON>'`，不需要 request file）。**用 session 自己的工具凭据认证，同 `flowly_submit_review`**（“No revisions or request needed”，`server/tool-server.ts`）：不要签名请求、不要 `expectedRevision`、不记 `agentReceipts`。原因：回执的 `action` 是 `storageSchema` 里的严格枚举（`shared/model.ts:441`），新增一个 action 会让旧版本在回执保留期内拒绝整个 `board.json`；高频的检查点写入也会占用 5,000 条回执的上限。

```
{ handoffRevision: int ≥ 0,
  operationId?: string,                         // 同一 id 的重放返回原结果（replayed）
  state?: string,
  set?: { section, id?, ...fields }[] ≤30,      // 按 id 更新或新增（不给 id 则分配）
  remove?: { section, id, reason ≤200 }[] ≤30,  // 变成墓碑；agent 不能删人写的条目
  order?: { next: id[] },
  note?: { kind, text },
  inputs?: { id, status?: done|answered|superseded|declined|open, standing?: boolean, note? }[] ≤30,
  questions?: { id, status: answered|withdrawn, answerInputIds?: string[], note? }[] ≤10, // 关联回答后才关闭，不靠任意新消息推断
  gaps?: ({ text: string(1–300), status: open } | { id, status: open|closed, note: string(1–300) })[] ≤10, // 新增缺口或附依据关闭；原描述与处置者保留
  ack?: Ack }                                   // §7.5
→ { ok, handoffRevision, replayed?, at, heads: { repo, sha | null }[], budget: { used, max },
    open: { inputs, questions, findings, running, gaps }, handoffDue: null | string, ackMissing?: id[] }   // ≤ 1 KB
```

- **合并**：`handoffRevision` 落后时，只要本次碰到的条目自那以后没变（每个条目有自己的 `rev`），照样应用；否则 `HANDOFF_CONFLICT`，给出这些 id 和 ≤ 2 KB 的差异。Flowly 频繁的派生写入和人的便签因此不会与 agent 的编辑冲突。
- **小回执**：不回显 `current`。今天一次“读卡 + 写入”约 220 KB 的历史，交接写入约 1–3 KB。
- 不写看板事件（不占 100 条事件窗口），只在 flow log 记 `handoff_updated`（同 `workpad_updated`）。
- 被换下的 session 只能用 `note` 和更新自己 `owner` 的 `running` 条目，其它返回 `RETIRED_SESSION`；例外是收尾指令开始的回合（按 messageId 认出），它在封存之后才开始时也可写全部各段（§6.2 1c）；评审者返回 `REVIEWER_ONLY`；归档的卡 `ARCHIVED`；Done/Cancelled 的卡只接受 `note`，其它 `TASK_FINISHED`。项目关闭了 workpad 时仍可写交接。

### 5.7 Flowly 派生什么（回合结束时，以及回合中的被动捕获）

对本卡**每个** Flowly 管理的 session（人开的、不受监督的、被换下的都算），在已有规则之后、不阻塞钩子。来源是回合结束钩子的 timeline，加上回合中的被动捕获（§4 第 2 条）。台账记已捕获到第几个回合（`capturedThrough`）和 provider 文件读到的偏移（`through`）。封存时若有未捕获的回合（回合中途插件重载或 daemon 重启而丢了钩子，现有的漏钩子恢复只恢复 job 状态）就补读：Codex 与 Claude 从偏移读到文件尾；其它 provider 在已加载且 B < 64 MiB 时读一次 timeline 尾部（同今天 `limitNotice` 的读法），否则记一条 gap（“turn 7 of session #2 was not captured”）。

- **人的话**：`user_message`，去掉以 `[Flowly automation]` 开头的、async-shell 通知（`[async-shell …`，按下面后台任务一条的规则处理；其中 `message` 与 `request` 是别的 agent 的话）和 Flowly 路由的评论原文（按发送时的 `messageId` 匹配）。每条成为一个输入（`via: session`，被换下的 session 为 `retired_session`）。去重先按 `messageId`，没有时按每个 agent 的摘要计数（同一句 “yes” 说三遍就是三条）：钩子带的是 agent 的整个内存 timeline，重启后会重建，所以不用游标计数。时间取 timeline 条目自己的时间，没有时取捕获时间并标 `atSource: captured`。
- **别的 agent 的话**：Paseo 0.12 的 `<paseo-system>` 信封装着 agent 之间的消息、agent 通知（例如 `create_agent` 建的子 agent 结束）和 schedule / heartbeat 的触发。消息成为 `via: agent` 的输入，带发来消息的 agent 的标题，从不标成人的话；子 agent 的 finished、errored、closed 通知关闭对应条目，它说的话（子 agent 的最后一条消息）写成便签（errored 为 hazard，其余 background，≤ 2,000 字符，按 message-id 去重），不是要处置的输入；permission-required 仍是输入。Paseo 0.12 在 timeline 里把带来源的信封投影成名为 `agent_message` 的 `tool_call` 行（callId `paseo-agent-message:<message-id>`，`agentMessage: { event, sender, text }`）：它是那条消息在回合结束时的副本，与 provider 副本（Codex `UserMessage` 里的信封）同一身份，照回合结果标 received（第二轮修正：以前这种行被忽略，provider 副本永远是 open，每个接班者都要处置一遍）；schedule / heartbeat 的一次触发只记发生时间，不能认定周期任务已关闭（§9.4），被换下的 session 收到时触发 §9.3 的唤醒。
- **状态**：
  - 接收它的回合**正常完成**，且那个 session 没有被换下、那个回合不是收尾回合、回合里没有写入被 `FINALIZING` 或 `RETIRED_SESSION` 拒绝 → `received`（只说明消息到达且回合完成，**不证明已照办**；接班者仍看得到原文。需要长期约束的内容标 standing，未履行要求应保留为 open）。有没有 job 都一样，所以手动卡和人自己开的 session 里的话不会永远是 open。
  - 其余 → `open`：回合失败或取消、被换下的 session、收尾回合（它被告知不要动手）、经 `save` 只记录的评论、轮换前没来得及处理的。
  - 打招呼一类的短话因此不会变成一串要确认的待办。
- **问题**：执行者的 `flowly_report_progress kind=question | blocker` 在同一事务里成为 `questions` 的一条（今天它只是一条看板事件：`get_task` 只给最近 20 条，卡片只留 100 条）。卡片有 open 的问题时，新输入先列为候选回答，仍保持问题 open。人在 Run again / 评论中明确选择回答哪个问题，或当前执行者用 `questions[{id, status: answered, answerInputIds}]` 核对关联，才记 answered；多个问题时不能把一句 “按第二个方案”自动当成全部问题的答案。候选写 “d-12 may answer q-3: <question>”；确认关联后才写 “answers”。agent 用自己的问题工具在回合内问答的，只在 timeline 与叙述里。
- **每回合的最后一条 agent 消息**：`turns[].final`（脱敏，≤ 2,000）和这个回合有没有交接写入。Flowly 本来就拿着 timeline，不多花钱；没收尾的封存靠它（§5.8）。
- **Flowly 自己输入框发出的消息**在发送时就记下（不依赖回合结束才能落盘），回合结束时按 messageId 去重。
- **图片**：`user_message` 只有 `text`、`messageId`、`clientMessageId`（`@getpaseo/protocol` `agent-types.d.ts:308-311`），图片本身拿不到。粘贴的图片在部分 provider 的文本里是占位 `[Image: source: /path.png]`（`shared/images.ts` `extractImages`）：Flowly 把这些本机图片文件（图片扩展名、≤ 8 MB、每条 ≤ 6 个）复制进 `images/`；没有占位的图片记为 `imagesLost`，抽屉写 “image attached, not kept”。开工图片在 `AutomationLaunches.collect()` 删除 launch 文件**之前**复制进来；经 Flowly 输入框发送的图片同样保留。
- **后台任务清单**：从整个 timeline（不只本回合）和被动捕获里取启动或结束长期东西的工具调用：`register_async_shell` / `cancel_async_shell`、Codex `exec_command` 的 session、`browser_new_tab` 对 `close_tab` / `browser_close_tab`、`create_terminal`、`start_workspace_script`、`create_agent`、`create_schedule`、`create_heartbeat`、Claude Code 的 `Monitor`（第六轮，见下面任务通知一条），以及 Codex 多 agent 模式的原生子 agent（第二轮补上：本月 Paseo 启动的 Codex session 里 47 次 `spawn_agent`、46 次 `followup_task`、85 次子 agent 完成，以前每个都是 `subagent unknown` 加一条 `background_handle_unknown` 缺口，完成后也不关闭）：`spawn_agent {task_name, message}` 以子 agent 的路径为句柄（结果 `{"task_name": "/root/<name>"}`；受管 session 是根线程 `/root`，裸名按它解析），标签是 task 名，所给任务是可读的文字（含空白、脱敏不改变它）时再加它的前 80 个字符（第三轮修正：本月 129 次 `spawn_agent` 与 2,681 次 `followup_task` 的 `message` 全是一个 600–900 字符的不透明令牌，脱敏后每个标签都是 “<name>: [redacted]”，看起来像有过密钥）；输出 `collab spawn failed: …` 什么都没启动，不留条目；`item_completed SubAgentActivity` 的 completed 与 interrupted 按 `agent_path` 关闭条目并记下 kind，started 与 interacted 证明它存在（没有条目时打开一个，已关闭的不重开）；`followup_task {target, message}` 给已有的子 agent 新工作，把条目重新打开（含 ACK 已处置的）并按同样的规则换标签，`collab tool failed: …` 不算；`interrupt_agent` 关闭它；`wait_agent`、`list_agents`、`send_message` 是轮询与对话，不是后台。子 agent 做了什么在它发给根线程的 `response_item agent_message` 里（`author` 是 `/root/<name>`，`recipient` 是 `/root`，`input_text` 以 `Message Type: FINAL_ANSWER`、`Task name:`、`Sender:`、`Payload:` 开头）：可读的正文（提交、分支、失败、“不要部署”）写成 `Sender:` 那个子 agent 的便签（“Sub-agent /root/<name> reported its final answer: …”，≤ 2,000 字符，脱敏，截断时写明是摘录，按记录 id，总是写），同 Paseo 子 agent 的 finished 通知；同一批次里它被中断（`SubAgentActivity interrupted` 或 `interrupt_agent`，在答复之前或之后都算）时是 hazard（“(interrupted)”，工作可能只做了一半），否则 background；只有加密正文的记录（MESSAGE 类型，`Payload:` 后为空）与根线程给子 agent 的指示（它工具调用的参数）是元数据；发给 `/root` 而头部读不懂的是一条分组缺口 `unknown_response_type: agent_message (unparsed header)`，不是默默跳过（第三轮修正：4702cc6 把整个通道当元数据，说 “子 agent 条目覆盖它”，可条目只有标签与 completed / interrupted，卡上只剩 “closed: completed”；本月 Paseo 启动的 Codex rollout 里 71 条 FINAL_ANSWER，25 条在卡片 session 里，10 月 2,414 次子 agent 完成中 1,517 次跟在这样的报告后面）。仍会漏的：答复与中断分在两次轮询读到时便签保持 background，条目的 outcome 仍是 interrupted。只解析小的调用参数和结果里的句柄字段（如 task id / session_id），不保存结果正文。Paseo 的工具把句柄和状态放在下一层：标签页在 `result.browserId`（关闭调用的参数是 `browserId`），async shell 在 `task.taskId` / `task.status`，标签页以 URL 做标签（第三轮修正：以前只读顶层字段，每个 `browser_new_tab` 是一个匿名的 `browser_tab unknown` 加一条 `background_handle_unknown`，每个 `browser_close_tab` 又是一个，标签页永远关不上；`cancel_async_shell` 之后 shell 仍像在跑；按 AGENTS.md 的要求用内置浏览器做 Web UI 验收的卡片 session 每次都碰到）。成功的关闭调用关闭它的目标并记下报告的状态（例如 cancelled；目标自己报告仍在 running / pending 时除外），从不新建条目，拿不到句柄时什么都不记（关闭不会留下在跑的东西，未关闭的条目仍要处置）。失败的调用（`isError`、`ok: false`、`error`）什么都没启动或改变，同 `collab spawn failed`：不留条目、不记缺口，启动与关闭调用只写一条带错误（≤ 300 字符，脱敏）的 background 便签（失败的轮询调用如 `write_stdin` 什么都不记），并关掉上一次轮询为它留下的在途占位（本月 4 次 `browser_new_tab` 与 3 次 `register_async_shell` 失败，例如 “plugin not ready”；以前各留一个 unknown 条目和一条 `background_tool_failed` 缺口）。只有启动调用拿不到返回句柄或长行被跳过时，记 unknown 与缺口，不虚构一个可接管的进程。同一条 detached 规则（`server/handoff-detached.ts`，2026-10-25 第二轮修正）用于已知工具的参数、脚本里的命令字面量、Codex 的 `item_completed CommandExecution` 与 Paseo 的 shell 行，只看 shell 结构：引号里的参数、heredoc 正文与注释是文字（只是搜索 `nohup` 这个词不算），`sh -c '…'` 的正文按命令再查一遍；任何位置单独的 `&`（不是 `&&`、`>&`、`<&`、`|&`、`&>`），或某一段命令（去掉环境变量赋值与 `sudo`、`env`、`exec`、`nice`、`time` 之后）是 `nohup`、`setsid`、`disown`、`docker [compose] up|run -d`、`docker start`、`tmux new -d`、`screen -dm`、`pm2 start`、`brew services start`、`launchctl load|bootstrap|kickstart`、`systemctl [--user] start|restart`，或参数 `run_in_background: true`。本机 10 月 99,875 条 CommandExecution 命令上，旧规则（词出现在任何位置或以 `&` 结尾）命中 6 条、全是误报，新规则命中 5 条、都是真的后台任务。shell 行在回合结束时仍是 `running`，就是一条打开的后台。命令行启动的后台只在输出里可见：`paseo-shell register` 打印的任务 JSON 与 `paseo-workflow run` 打印的 `Workflow launched in background. Run ID: …`（CommandExecution 的 `aggregated_output` 与任何已完成 shell 行的输出，不只 detached 的，读前 64 KiB；命令必须就是那个 CLI，别的命令输出里引用的启动不算）以任务 / run id 打开 async_shell / agent 条目；paseo-async-shell 的 `async-shell-task` 插件行（注册时追加一次，`paseo-shell register` 路径上唯一的结构痕迹）在 pending / running 时以 `data.taskId` 打开 async_shell 条目，已结束时记为 closed。按 ref 去重，每个成为台账里的一条 `b-*`（`status`、`outcome`、`source`）；标签脱敏，最多取命令前 120 个字符。每个 session 最多 40 个未关闭条目：超过时最早的（先是没有证据的占位）合并为一个计数的 unknown 条目（“N more background items merged at the 40-item capacity”），并写一条 background 便签逐个列出被合并的条目；捕获从不因后台容量拒绝（以前拒绝整批，连人的话、便签和压缩也一起被拒，游标停住）。paseo-async-shell 的通知按插件的头部语法解析（`[async-shell <event> <task>] <摘要>`，空一行后是正文；event 是 finished、failed、timed_out、lost、still_running、sendback、message、request。第二轮修正：以前只认前三种，其余五种都成了一条不带文字的匿名缺口，lost 的 shell 一直像在跑，每 2 小时的提醒让已确认的缺口重新打开，别的 agent 的话到不了卡上）：finished、failed、timed_out、lost 把对应条目标为 closed 并记下结果（`outcome`），没对上任何条目时关闭最早的一个没有证据的 async_shell 占位；failed、timed_out 与 lost 另写一条有界、脱敏的 hazard 便签（摘要、shell 主输出里的第一条错误行（没有就是第一行）、两个日志路径和清理说明，≤ 1,200 字符），所以失败的原因不只剩一个 outcome；finished 另写一条 background 便签（摘要、输出块的头（如 “stdout (88 B)”）与它最后 ≤ 600 字符（截断时写 “last 600 characters: …”）、两个日志路径和清理说明，≤ 1,500 字符，按 task 与 event 去重。第三轮修正：以前 finished 只关闭条目，可等 CI、轮询评审服务、跑长测试的 shell，输出正是它的意义，而通知只到注册它的 session（§9.4），被换下的前任不写便签，接班者就只看到 “closed: finished”；本月卡片 session 收到 48 条 finished，23 条带 stdout 文字）；still_running（每 2 小时一次的提醒）与 sendback 证明 shell 还在运行，打开或保持它的条目，从不成为缺口；sendback 的正文（shell 发回给主人的进展）写成 background 便签（按 task 与正文摘要去重，≤ 2,000 字符）；message 与 request 是别的 agent 经它自己的 async shell 发来的话（task id 是发送方的 shell，不动本 session 的条目），原文成为 `via: agent` 的输入，`from` 取摘要里的 agent 标题与 id；request 要它在这个回合里回答（最后一条消息回到对方的 shell），始终是 open：里面的要求（例如“确认之前不要删旧列”）必须有人处置。头部解析不了的仍是一条 `unknown_background_notice` 缺口。Claude 的 `<task-notification>` 与 `[paseo-dynamic-workflow]` 运行通知按 task id 关闭条目并记下状态（第四轮补上两条路径：Claude Code 把回合进行中被吸收的通知只写成 `queue-operation` 记录，先 `enqueue`、再带 `reason: absorbed_mid_turn` 的 `remove`，两条都带通知原文，本机 40 天的 sdk-cli 转录里 174 条排队的任务通知、114 条被吸收，其中 102 条在转录别处找不到；Paseo 0.12 把每条 Claude 任务通知投影成名为 `task_notification` 的 `tool_call` 行，`metadata.source` 为 `claude_task_notification`，`detail.text` 是通知原文，没有时用 `metadata` 的 taskId、status、outputFile 与标签（失败时是 `error.message`）。两者以前都被跳过，条目永远是 open，失败到不了卡上。现在它们与送达的通知走同一套读法：条目以状态关闭，失败的写出带摘要与输出文件的 hazard 便签；同一条通知的几份副本只关闭、只记一次；读不懂的排队通知或行是一条缺口，其余 `queue-operation` 记录仍是簿记）；每条通知都另写一条有界、脱敏的便签（第三轮修正：以前 completed、对上了已记录的启动、又不带下列块的通知只关闭条目，`<output-file>`——读结果的唯一途径——也丢了；通知只到启动它的 session）（≤ 2,000 字符：task id、状态、摘要、输出文件路径，有 `<result>`、`<error>`、`<failures>`、`<recovery>`、`<interrupted-agents>`、`<worktrees>`、`<note>` 时再按优先级：`<worktrees>` 的每一行（分支、路径与 “child creation/cleanup is unresolved” 标记：工作流的代码改动在那些分支上）、`<note>` 原文（例如用户停掉运行时的 “Do not resume or relaunch it unless they ask”）、被中断 agent 的 id、错误、失败、结果与恢复说明的开头；不是 completed 时为 hazard，否则 background）。便签不保留的块（`<diagnostics>`、`<usage>`、`<guidance>` 与以后新增的块）逐个写出名字，放不下的块也写出名字；只要有块被截断、省略或没保留，便签就以 “(Excerpt; the whole notice is in that session's raw history.)” 结尾（第二轮修正：以前 `<worktrees>` 与 `<note>` 被丢掉，又只在长值时才写这句，看起来完整的便签少了要合并的分支和不要重启的指示），没有任何已记录的启动与之对应时（Claude 后台 `Agent`、跳过的启动行）同样写，所以通知从不被丢掉；通知分不清工作流与后台命令，所以没对上的通知不关闭任何占位。不带 task id 与状态的 `[paseo-dynamic-workflow]` 消息（插件转达用户的 Ultracode / workflows off 设置）是 `via: agent`、来源 paseo-dynamic-workflow 的输入，不是匿名缺口；明确的子 agent 完成通知可关闭该子 agent；schedule / heartbeat 只有取消或删除被证实时才关闭，一次触发不算。 第七轮：Claude Code 用 `TaskStop {task_id}` 停掉后台任务或 Monitor（旧版本是 `KillShell` / `KillBash {shell_id}`），之后没有任务通知（本机转录里 23 次 TaskStop 全部如此；Claude Code 自己说经 UI 或 TaskStop 的停止 “leave no transcript marker”）：结果说停掉了（`{"message":"Successfully stopped task: <id> (<command>)","task_id",…}`、`Successfully killed shell: <id>`）时以 outcome `stopped` 关闭它点名的任务（任何类型），provider 路径与 Paseo 的通用 tool_call 行都是；失败的照常只写便签、目标不变，没说停掉的结果什么都不改（以前 TaskStop 是未知工具，停掉的 Monitor 与后台命令永远是看板上、封存提示里和接班者 ACK 名单里的 open 工作）。`write_stdin` 这类轮询只报告它点名的 session：保留条目的启动调用与标签，报告已结束时关闭条目并记下它已结束，从不新建；退出码从 `Process exited with code N` 头部读（以前写成 completed）。回合中的 session 自己启动的 exec session 是 `transient`（§5.1）：同一回合里结束就去掉；回合结束的 timeline 每次重放全部启动，所以去掉的按 kind 与 ref 记在观察状态里（最近 128 个），timeline 重放的启动与之后迟到的进度不会把它带回来，provider 文件里新读到的启动（每条只读一次）照常记下。被跳过的工具结果（超过 256 KiB）开头若是 Codex 的 `Process exited with code N`，它回答的 `exec_command` 或 `write_stdin` 照常结束（以前调用一直挂着，回合结束时成为 open 的占位或一直在跑的 session）；脚本的输出不这样处理：它留下在跑的东西写在没读到的输出里。
- **git**：卡片的每个仓库（`get_task` 给 agent 的 `scope.repoPaths`，为空时项目的仓库；新卡在项目根，根下可能有子仓库；默认最多 8 个，超过时列出总数与未检查路径并记 gap，接手者逐个核实，不把未测的当成干净）：HEAD、分支、未提交文件数与前 50 个（列表截断时写 “N more files”）、diffstat、是否与上游不同；不是 git 仓库的路径记 `head: null`。参数数组、5 秒超时，复用 workpad 的 `env` 读取。
- **台账**：回合数、C、C₀、W、B、S、K、模型。
- **锚点**：从 agent 消息里按正则取 SHA（7–40 位十六进制）、PR/issue URL、分支、路径和 `Error:` 行，每个 session ≤ 60 条。
- `handoffIndex` 的 `fresh` 与 `open` 在此时更新（只在变化时写，§5.1）。

- **脚本与工作流**（2026-10-25 接手实测后修正）：Codex code mode 的 `exec` 脚本、Claude Code 的 `Workflow` 与 paseo-dynamic-workflow 的 `workflow` 不再每次调用记一个 `opaque_tool_background` 缺口（实测卡片上 120 次脚本调用全部只有 ≤ 1 秒的已完成命令，脚本正文与输出都在原始历史里，94 条 open 缺口全是噪声）。每个 session 只在台账里计数（`scriptCalls`，视图与抽屉写明“其内部工具调用不逐条列出、仍在 session 原始历史里”；不是待办，不需要确认）。只有**证据表明它留下了仍在运行的工作**才成为后台条目：(a) 输出头 `Script running with cell ID N` → 打开 `cell:N`，顶层 `wait {cell_id}` 报告 `Script completed|failed` 或 `terminate` 时关闭；(b) 打印出的结果里有 `session_id` 而没有 `exit_code` → 打开该 exec session，之后同一 `process_id` 的 CommandExecution 完成条目关闭它，已证实结束的 session 不会因旧结果的重印再打开；(c) 命令字面量命中 detached 规则 → unknown；(d) 脚本文本调用了会启动后台的工具（`register_async_shell`、`browser_new_tab`、`create_agent` 等）而这个脚本期间没看到它的完成条目，或 `exec_command` 的调用处多于看到的 CommandExecution 完成条目（实测 727 个脚本中 23 个，19 个确有在跑的 session）→ unknown（“completion not observed”），`exec_command` 每个没对上的调用处一个（每个脚本最多 4 个）；之后一个不属于正在运行的脚本、也不是已知 session 的 CommandExecution 完成条目（那条命令比它的脚本活得久）关闭最早的一个这种占位，并记下退出码。归属规则（第二轮）：一个 exec session 在脚本开始前就已知（仍在跑、已结束，或脚本文字里点名，例如 `write_stdin` 的目标），它的完成条目不算这个脚本的启动，否则重启 dev server、轮询构建后再起服务的脚本会把新起的服务藏掉（本机 10 月 67,328 个脚本中 2,832 次）；仍在跑的 exec session 记在游标的 `sessions` 里，跨批次有效。重叠的脚本（P2 复查第一轮）：嵌套的完成条目不写它属于哪个脚本，以前一律记给最新的未返回脚本，于是并行的 exec cell 里自己的命令已经结束的旧脚本得到一个假的 “completion not observed”（回合结束时成为要 ACK 的 id、看板计数、交付门要求、一个 revision 与一个归档台账版本，永远关不掉），反过来一个 yielded cell 之后才来的完成条目会把较新脚本仍在跑的命令藏掉。现在同时在跑的脚本（未返回的脚本与仍在跑的 yielded cell）组成一个池（游标的 `scripts`，跨批次有效）：完成条目记给池，不记给哪一个成员；yielded cell 留在池里，直到 `wait` 报告它结束（它最后的输出里打印的仍在跑的 session 同脚本输出一样成为条目）或被 terminate（它留下什么不得而知，不补占位）。每有一个成员返回，池的占位是已返回成员里没有完成条目对上的调用处：完成条目先算给仍以 yielded cell 在跑的成员（它们可能活过这个回合），所以已返回成员可能留下的东西现在就出现；还在等自己结果的成员（普通的在途脚本）不先占，等它返回再算。没读到结果就离开的成员（被 terminate 的 cell、输出太长读不了的脚本、到调用预算被挤出的 cell）自己不补占位，它的调用处照它还在跑时那样继续先占完成条目（P2 复查第二轮：以前它的调用处同时算进已返回与已覆盖，已经记给它的完成条目又被减一次，多出来的那个撤回了旁边脚本 dev server 的占位）。成员还在跑时计数会先降后升（它们的完成条目先于它们的结果到），所以这时的撤回（`withdraw`）只去掉观察状态的占位（回合中是 `transient`，撤回不留痕迹）；已经成为历史的占位（池活过了回合：yielded cell 没人等，或封存结算了在跑的回合；或者记录在回合结束之后才读到）留着，等最后一个成员返回：那时数目是确切的，超出它的占位全部关闭，包括之前撤回时留下的（P2 复查第二轮：以前撤回把它当历史关掉，计数回升时同一个 id 的重新放置被观察者拒绝，仍在跑的 dev server 唯一的记录成了 closed，也不在 ACK 名单里）。单独一个脚本得到与以前完全相同的占位与 id；旧游标里未返回的脚本组成池并带上已记给它们的完成条目。(e) 工作流成功启动（`Workflow launched in background`、`async_launched`）→ 以 task / run id 打开，`<task-notification>` 或 `[paseo-dynamic-workflow]` 通知按该 id 关闭并记结果状态，这两种通知不再被当成人的话；被拒绝的启动（`<tool_use_error>`）什么都没启动，不记。嵌套调用的 `item_completed McpToolCall` 按已知工具表逐条处理（拿到真实句柄，例如 async shell 的 task id）。脚本尚未返回时是一个 unknown 占位，标为 `inFlight`（第四轮：任何结果还没读到的启动调用都是这样，脚本、`exec_command`、正在打开的标签页、正在注册的 async shell）：它出现在卡上与封存里，但不是 ACK 要处置的 id（第六轮：它随轮询出现又消失、原地写入不换 revision，作为要求它会让 ACK 的 `ackMissing` 随轮询时机变化；它自己的 session 还在跑它。它的 session 被封存、停下或不在时它成为普通占位，那时才进名单）；它不进台账的历史（§5.1），所以出现与消失都不归档台账版本，也不是交付门的新要求，不计入看板索引的 open 数（否则每次碰到都重写两次 `board.json`）；结果没有证据时（脚本只跑完了命令、命令已退出、启动失败）把它从 `background` 里删掉，而不是留一个 closed 条目到 40 条上限；结果带句柄时它成为真正的条目（例如 `cell:N`、async shell 的 task id），从那以后是历史；同类的迟到完成条目不能结算一个结果还没读到的调用（以前会，调用仍在跑时下一次轮询又把它加回来）；尚未返回的调用不再计入 `through.gaps`，它自己的条目就是这个信号（以前每次碰到都让卡片在“新”与“捕获不全”之间翻转）。在途只在它的 session 回合中（Paseo 报告 running / initializing 或有 activeTurn）且没有结束时成立（第五轮）：session 空闲（且这次把 provider 文件读到了末尾、捕获没有失败）、不在了或被封存时，没有结果的调用不会再有结果，它成为普通的无证据占位（封存只结算封存那一刻在途的调用；被封存的 session 之后被唤醒的回合同任何回合一样按它的状态判断，P2 复查第一轮：以前 `endedAt` 让它之后的每个回合都算已结束，迟到回合里碰到的脚本立刻成为要 ACK 的 id、换 revision、归档台账版本，返回时又关闭、再换一次）：计入看板索引的 open 数、进交付门指纹、是台账历史（以前 `inFlight` 永远不清，被封存、停掉或杀掉时还在跑的部署脚本在看板上是 “0 unresolved items”，交付门也不把它当要求）；之后才读到的结果按普通占位关闭它（已是历史，所以关闭而不是删掉）。容量：在途调用不算 40 条里的活动条目、不参与合并，只占真实条目剩下的空位（按第一次看到的顺序，所以每次轮询是同样几个），其余在覆盖说明里计数（“N calls in flight are not listed”，不计入 `through.gaps`），游标在每次轮询时重新给出它们，session 停下时它们照上一条成为普通占位（以前在途调用会让最早的真实条目永久并进计数条目、写合并便签、归档台账版本；超过 40 个在途调用时每次安静的轮询都再合并一次）。以前每次碰到正在运行的脚本都开一个占位、返回时关闭，各归档一个完整的台账版本，接班者必读的完整读取跳不过它们，关闭的占位一直留在 `background` 里；在途的 `wait`、cancel 这类关闭或轮询调用不是后台，不留占位，`wait` 返回时也关闭旧版本为它留下的占位；输出超过 256 KiB 读不了时才记缺口。接班者的 ACK 对后台条目处置 `done` / `obsolete`（附 note，§7.5）就关闭它。仍会漏的：条件分支或循环里多次启动、但看到过等量完成条目的命令；接班者仍按 §9.4 用 `ps`、锁文件核实。仍要处置的：没有执行的分支里的调用处、被杀掉而没有完成条目的 session，以及容量合并后的计数条目。实测（第二轮重新测量，更正此前“2,554 个 (d) 占位中 2,485 个被之后的完成条目关闭、剩 69 个”的错误数字；方法：对本机 10 月 440 个 rollout 逐个运行 `captureHandoff` 到文件尾，之后的完成条目先进先出地关闭占位，同观察者的 `placeholder()`，只读，只计数）：357 个 (d) 占位中只有 46 个（13%）被之后的完成条目关闭，剩 311 个，分布在 41 个 rollout，最多的一个 76 个（观察者层的容量合并之后最多 37 个）；38 个卡片 session（首条消息是 `[Flowly automation]`）里 49 个、关闭 4 个、剩 45 个，分布在 21 个 session（55%），其中 15 个 session 是 1–2 个，最多 5 个。剩下的几乎都是没有执行的条件分支里的 `exec_command` 调用处。这是明确接受的代价，不再自动关闭：唯一能减少它的规则是回合结束时关闭“脚本已完成、没打印 session_id、也没来完成条目”的占位，而那正是 (d) 要抓的情形：脚本里 yield 后仍在跑、却没把 session id 打印出来的 exec session（例如 dev server）在进程退出前没有完成条目；本月 56 个比脚本活得久的完成条目中 46 个正是这样关闭占位的，按那条规则它们在运行期间都会从卡片上消失。所以接班者对每个这样的 id 用 `ps` 核实一次，在 ACK 里处置为 done 或 obsolete（附 note），之后的接班者不再看到它。
- **缺口分组**：Flowly 的捕获缺口按 (session, kind, typeHint) 只记**一条**，带 `count`、`firstAt`、`lastAt`；每个 kind 每个 session 最多 8 个 typeHint，其余并入 “other types”，所以一次洪水最多产生少数几条 open 缺口。计数是绝对且幂等的：已提交的 provider 批次不会重读；没有游标的批次（身份不符）按出现 id 去重；回合结束钩子每次带整份内存 timeline（插件行只在 daemon 内存里，重启后 timeline 重建、变短），按行身份计数（第二轮修正：以前只取更高的计数，重启后新出现的行在超过旧计数之前都不计，已确认的缺口因此不会为它们重新打开）：插件行 id、messageId、callId，没有身份的行按位置；每组记最近 128 个身份摘要，只有没见过的行才加计数，所以重放不加、重启后的新行会加；没有身份的行在 timeline 变短时按新行计；一个 timeline 里同组超过 128 行时只算超出上次行数的部分；旧版本的计数当作同样多的已见行。带位置的缺口（`long_line`、`parse_failed`、`file_truncated`、`file_replaced`、`file_moved`）中，可能装着人的话的那些不合并：每个 session 每个 kind 前 8 个各是一条缺口，写明字节范围、messageId 与长度（长行的 messageId 也从行尾读，JSON 把它写在长文本之后）；跳过的长篇人的输入因此还能在原始历史里找到。长行的类型提示取前三层类型（`event_msg/item_completed/CommandExecution`；响应消息加 role，例如 `response_item/message (user)`），只有 Codex 的 `user_message`、`UserMessage` 条目、role 为 user 的响应消息、Claude 不是工具结果的 `user` 记录与排队的附件（以及认不出的类型）算人的话。工具输出和其它不是人的话的长行按类型提示合成一条计数的缺口，写明前 3 行的字节范围；超出 8 条的人的长行也按它们真实的类型提示计数（第二轮修正：以前前 8 条长行无论是什么都各成一条 open 缺口、全都写成 `event_msg/item_completed`，超出的写成 “other types” 且计数总是 1。本机 10 月卡片 session 里超过 256 KiB 的 47 行中 39 行是 CommandExecution、4 行脚本输出、3 行 McpToolCall、1 行压缩，440 个 rollout 里没有一行长的 UserMessage；逐条的长行缺口在卡片 session 上从 26 个涨到 47 个，全部 rollout 上从 133 个涨到 353 个）。缺口 open 时计数增长不改变交付门的语义指纹（§5.5），不会因洪水反复拒绝。用 `gaps:[{id, status: closed, note}]` 关闭，或在 ack 里处置为 `done` / `obsolete`（§7.5），就覆盖到它读的那个 revision 为止的全部出现，`resolution.count` 记下那个计数；之后计数超过它才重新打开**同一条**缺口（重新打开改变指纹，需要一次新的拒绝）。增长原地写入、不换 revision（第七轮），所以在那个 revision 之后原地计入的出现不算在内（P2 复查第一轮：以前按确认时的实时计数关闭，读完之后才跳过的人的第十条长消息被一起结算、再也不会重新打开）：缺口保持 open，`resolution.count` 是那个 revision 的计数（`countAtRevision`），ACK 的 `ackMissing` 列出它，下一次确认（那时的 revision 包含全部出现）才关闭它。`through.gaps` 只计当前的覆盖问题（积压、半行、读取失败；尚未返回的启动调用是自己的在途条目，第四轮起不计），持久的缺口已经是条目。786d9cd 之前逐条写入的缺口保持原样，不自动合并或关闭。第七轮：open 时计数与时间的增长原地写入，不换 revision（§5.1）；session 在回合中自己产生的长行（不是人的话的）与超出上限的工具结果先只计数（`held`），回合结束或封存时才写成分组缺口。
- **记录类型的分类**（来自三个 session 的 rollout、362 个本机 rollout 的结构统计与插件源码；从不保存其正文）：
  - 纯元数据，跳过：Codex `world_state`（全量与增量快照：注入的环境、skill 目录、AGENTS.md，会由接班者的 provider 重新注入）、`event_msg thread_settings_applied`（模型、权限、系统提示等配置）、`inter_agent_communication_metadata`、明确列出的 `item_completed` 条目（Reasoning、FileChange、Extension（网页搜索、sleep）、ImageView、CollabAgentToolCall（`wait`）、FunctionCallOutput；第二轮以前所有不认识的条目都被默默跳过，现在新的条目类型是一条分组缺口 `unknown_item_type`；第三轮起 ContextCompaction 计压缩、AgentMessage 是叙述，见下）；`response_item agent_message` 里只有加密正文的记录与根线程给子 agent 的指示（子 agent 发给根线程的可读报告是便签，见上面后台任务一条；第二轮说 “子 agent 条目覆盖它” 是错的：条目只有标签与结束方式）；timeline 的 `todo` 与 loading 状态的 `compaction` 行；插件行 `activity-list`（compact-activity）、`flowly-summary`、`flowly-next-moves`、`guard-decision`、`learning-update`、`dynamic-workflow-run`（`async-shell-task` 不是元数据，是后台证据，见上）；Claude Code 的簿记记录 `atis-latch`、`cost-state`、`mode`、`permission-mode`、`file-history-delta`、`agent-name`、`api-request*`（以及原有的 `progress`、`file-history-snapshot`、`queue-operation`、`last-prompt` 等）、宿主写的 `user` 记录（`isMeta`：Skill 工具载入的 skill 正文、斜杠命令的展开、本地命令的说明；`isCompactSummary`：压缩摘要，它的 `compact_boundary` 已经计了这次压缩；本地命令自己的输出 `<local-command-stdout>`。第三轮修正：它们以前落到一条 “unknown_record_type: user” 缺口，类型并不是未知，每条新的又让确认过的缺口重新打开；40 天内 92 个 Paseo Claude 转录里 19 个有，共 78 条 isMeta、4 条 isCompactSummary，单个最多 26 条）和宿主自己加的附件（total_tokens_reminder、deferred_tools_*、environment、date、model、skill_listing、instructions、session_context、credential_org、remote_session_change、silent_turn_reminder、prompt_snapshot、mcp_instructions_delta、agent_listing_delta、auto_mode、task_reminder、edited_text_file、file、nested_memory 等，完整列表在 `server/handoff-capture-records.ts`：提醒、工具与 skill 清单、环境、重新从磁盘读的文件与记忆，接班者的 provider 会重新注入，或在磁盘与 git 里；第二轮：本机 40 天内 91 个 Paseo 启动的 Claude 主转录中 90 个有附件，约 4,100 条 total_tokens_reminder，每类一条缺口、计数每个回合都长，确认后下一次轮询又重新打开）。Claude Code 的 `pr-link`（这个 session 关联的 PR）成为台账条目的锚点（`anchors`）。人的斜杠命令（不是 isMeta 的 `<command-name>` 记录，带 `<command-args>`）是人的话，记为 “/name args” 的输入（以前是一条 `provider_system_notification` 缺口）。依据：插件行从不进入模型，发给 agent 的消息总是单独的 user message，这条输入路径已经处理。
  - 人的话，作输入（原文）：goal-loop 的 `goal-status` 行里的 `goal`、Codex `thread_goal_updated` 的 `goal.objective`；同一目标的多次状态更新是同一条输入。
  - 便签（不是待办）：timeline `notification` 的 warning / error（info 跳过）；rate-fallback 的 `provider-transfer`（工作被移到另一个 agent）。
  - 压缩：确认的压缩（Codex `compacted` 或 `item_completed ContextCompaction`，两者是同一次时只算一次，§2 的 K；Claude `compact_boundary`；timeline 中 completed 的压缩行）写一条便签：“Session #n (id8): its context was compacted at T. Details from before then may be missing from that session's memory; its raw session history is unchanged.”，不是匿名缺口；K 照旧计数，并照 §5.9 重给交接视图。超过行预算被跳过的 `compacted` 行（10 月 1,565 条中 1,329 条超过 256 KiB，中位 608 KB：加密摘要加上已捕获历史的副本）同样计这次压缩，从不成为 `long_line` 缺口（第三轮修正：以前它没有便签、不计 K、不删 `seen`，只剩一条每次大压缩后都重新打开的长行缺口）。
  - 其余未知的记录、事件、响应、条目与 timeline 类型（含未知插件 kind，typeHint 为 `plugin:<pluginId>/<kind>`；未知的 Claude 附件子类型，typeHint 为 `attachment/<subtype>`；未知的 Codex `item_completed` 条目，`unknown_item_type`）仍是缺口，按上一条分组。
  - 人的话的 provider 副本（第二轮）：本机 Codex 版本不写 `event_msg user_message / agent_message`（本月 0 条，`item_completed UserMessage` 518 条），人的话只在 `item_completed UserMessage` 里，它的 id 不是 Paseo 的 messageId（在 fixture 上核对过）。被动捕获读它，按文字跨来源去重：卡上已有同样文字的输入（比较时去掉首尾空白、合并空白；Flowly 输入框发出的、路由的评论、开工说明、回合结束 timeline 的副本）时跳过，否则记为 open 输入（`provider-user:<agentId>:<item id>`）；以 `[Flowly automation]` 开头的、与自动化指令文字的摘要相符的、Codex 自己的包装（`<heartbeat>` 自动化触发、`<in-app-browser-context>`、`<chat-history-summary>`）都跳过；`<paseo-system>` 信封、async-shell 与后台任务通知照各自规则处理（回合中就能关闭后台条目）。之后回合结束 timeline 送来同样的话时，把 Paseo 的 messageId 记到这条输入上并照回合结果标 received，不另起一条；同一次观察里两份都是新的、或 timeline 先到时也只有一条。回合中途崩溃、钩子丢失时，这一回合里直接打进 session 的话因此仍在卡上（open，接班者必须处置）。仍会漏的：同一句话说两遍而 provider 副本先到时只记一条（话本身不丢）；Paseo 若改写了发给 Codex 的文字，两份各成一条。agent 自己的话同样只在 `item_completed AgentMessage` 里（本月 Paseo 启动的 rollout 里 1,153 条，`event_msg agent_message` 0 条），回合的最后一条还在 `task_complete.last_agent_message` 里（444 条）：第三轮起被动捕获把两者都读成实时叙述（文字块，≤ 800 字符，脱敏），观察者按规范化文字跨来源去重：回合结束钩子的副本替换同样文字的 provider 副本（保持 timeline 的顺序），provider 读到已经听过的话（每个 session 记最近 64 个摘要）就跳过；所以 `task_complete` 只在它的 AgentMessage 没读到时添一条。没有回合结束钩子时（崩溃、回合中途的重载或重启、回合中途的封存），叙述与 `lastWords`（§5.8）因此仍在卡上（第三轮修正：以前 Codex 的叙述只来自钩子，被动捕获一条都不留）。仍会漏的：没有钩子时，同一句话后来又说一遍只留一条；`turns[]` 仍只由钩子记，不从 `task_complete` 补出一个回合（之后到来的钩子会让回合计两次）。
  - Claude Code 经 SDK 运行（Paseo 用的 entrypoint `sdk-cli`）时，回合中途送达的东西（排队的人的话、`<task-notification>`、`<paseo-system>` 信封、async-shell 与 dynamic-workflow 通知）只写成 `type: "attachment"`、`attachment.type: "queued_command"` 的记录（`commandMode` 为 `prompt` 或 `task-notification`，`prompt` 是字符串或内容块列表；本机 126 条排队命令没有一条另有 `user` 记录）。被动捕获把 prompt 的文字交给同一套规则（通知关闭条目并写便签，信封与 async-shell 照各自规则，其余是 open 的人的话），以附件的 uuid 为来源，按文字与回合结束 timeline 的副本去重，与 Codex 的 `UserMessage` 相同；内容块里的图片记 `image_not_captured`（第二轮修正：以前每条附件都成为一条匿名的 `unknown_record_type: attachment` 缺口，任务失败不关闭条目也不写便签，人排队的话、别的 agent 的消息都藏在缺口里；回合中途的封存或丢失的钩子只剩这条缺口）。
  - Claude 的任务通知还有两条不经消息的路径（第四轮）：回合中途被吸收的只写成 `queue-operation` 记录（`enqueue`，再 `remove`，reason `absorbed_mid_turn`；本机 40 天的 sdk-cli 转录里 174 条排队、114 条被吸收、其中 102 条别处没有），Paseo 0.12 把每条通知映射成一行 `task_notification` 的 tool_call（`metadata.source` 为 `claude_task_notification`，带 `taskId`、`status`、`outputFile`，有原文时在 `detail.text`）。两条都照送达的通知读：条目以通知的状态关闭，失败写 hazard 便签（摘要、输出文件），副本只关闭、只记一次；读不出 task id 与状态的是一条缺口。Claude Code 的 Monitor 把仍在运行的任务的每个事件写成带 `<task-id>`、`<summary>`、`<event>` 而没有 `<status>` 的通知（同一批转录里 6 条排队、6 条被吸收），Paseo 给它的行状态默认是 completed、metadata 没有 status。它是进度，不是结束（第五轮）：在所有路径上（`queue-operation`、`task_notification` 行、送达或经 SDK 排队的消息）都不关闭任何东西、不写便签、不是缺口也不是输入；行的状态只取通知自己的，从不取行的生命周期。以前它被记成 “ended with status completed”，并占用真正结束时便签的 id（`task-notice:<task>:completed`），真正的结束与它的结果被去重掉；被吸收时是一条每个事件都重新打开的缺口，送达时是一条 open 的输入。事件正文留在 session 的原始历史里，任务的条目保持打开，直到它真正的结束通知；不写进度便签，是因为一个话多的 Monitor 会把 hazard 便签挤出当前记录的 100 条。第六轮：可 Monitor 本身没有条目——它不在已知工具表里，事件挂的是 Monitor 自己的 task id（本机转录里 7 次启动都是），不是某个后台 Bash 的；一个最多跑 30 分钟、会唤醒 session 的监视进程运行期间在卡上什么都没有，ACK 与封存都看不到。现在 `Monitor` 的 tool_use（`{command, description, timeout_ms}`）是一个启动（结果没读到时在途），标签是 “Monitor: <description>”；它的结果 “Monitor started (task <id>, …” 以这个 id 打开一个 exec_session 条目，provider 路径与 Paseo 的通用 tool_call 行（detail 类型 unknown，带原始输入与输出）都是；失败的启动只写带错误的便签。事件让条目保持打开（启动没读到时打开一个，标签取事件的摘要），并把最近一个事件（压成一行、脱敏、≤ 200 字符）记在条目的 `event` 上：观察状态，原地覆盖，不换 revision、不写便签；结束之后的事件不重新打开它。结束通知照常关闭条目并写便签，便签像保留 `<result>` 一样保留它最后的 `<event>`（“Last event: …”，≤ 500 字符：监视最后看到的往往就是它在等的失败）。第七轮：同一条通知的两份副本写同一条便签（来源 `task-notice:<task>:<status>`），可 Paseo 从 SDK 的实时 system 消息建的 `task_notification` 行没有原文（`detail.text` 只是摘要，app.asar 的 `toTaskNotificationToolCall`），只能从 metadata 重建，没有 `<error>`、`<failures>`、`<result>` 与 Monitor 结束时的 `<event>`；以前同一次观察里后到的行替换了 provider 副本的便签，先存下重建的便签时原文又被去重掉，失败原因与 Monitor 最后看到的事件只在原始历史里。现在重建的便签标 `metadataOnly`，并写明 “Rebuilt from Paseo's timeline row: the notice's own text, with any error, failures, result or last event, is in that session's raw history.”；它从不替换由原文写的便签，原文之后从 provider 文件读到时替换它（同一个便签 id，新 revision；已归档的也是）。同一条 Flowly 便签的其它副本（另一个时间、重建的）保持原样，不再是 `HANDOFF_CONFLICT`（那会拒绝整次捕获）。

捕获的持久化顺序是“先保存提取结果，后推进偏移”，重试按源身份去重；否则崩溃可能留下已经越过、却没有保存的输入。`through` 的时间、积压字节、跳过的长行/未知类型与叙述裁剪计数组成 coverage，卡片与接手视图都能看到。超过 256 KiB 的行即使是人的长输入也可能被跳过；这种情况保留 id/时间/长度和缺口，不能声称拿到了原文。Flowly 自己输入框已直接保存的正文优先于这种降级来源。

### 5.8 没收尾就封存时的确定性补记

三种情形：(a) session 消失、被归档、崩溃（没有回合结束）、中毒或达到 200 MiB；(b) 跟在一个没有正常完成的回合（限额、失败、沉默、中断）后面的任何轮换，包括备用模型切换和对一条后续的 R1 轮换；(c) 其它 `finalized: false` 的封存，而上次交接写入早于最后一个回合的结束（冷、未加载、收尾没发生）。

- **叙述**（三种都做）：`lastWords` = 上次交接写入之后各回合的 `final`，加上未结束回合的实时叙述；取较新的来源（崩溃的回合没有回合结束，钩子 timeline 还是上一回合的），≤ 2,000 字符，脱敏，标为 “unverified narration since the last handoff write”。实现：回合结束时取钩子的最后一条（同前）；封存时，被封存的 session 在上次交接写入之后的实时叙述（被动捕获与钩子的都在台账里：Codex 的 AgentMessage 与 `task_complete`、Claude 的 assistant 记录，§5.7）比卡上的 `lastWords` 新时，取这些叙述（按顺序，保留最新的 2,000 字符），所以没有回合结束的回合也有叙述兜底。轮询从不改写 `lastWords`：接班者、评审者在跑时的叙述不能替换被交接那个 session 的话。它进接班者的首条消息（§7.2），全文在交接视图里。
- **incident 便签**（a、b）：交接上次写入的时间和卡片沉默了多少分钟；各仓库现在的 HEAD 对比最后一个回合开始时；那个回合何时开始、跑了多久、怎样结束；最后一条进度记录的时间；体积构成（被动捕获顺带累计的；没有时，B ≥ 64 MiB 的 session 做一次后台低优先级的流式读取，§8.1）。
- **后台**：被动捕获、补读或骨架在最后一个已捕获回合之后看到的启动调用（`register_async_shell`、`exec_command` 的 session、没有 `close_tab` 的 `browser_new_tab`、`create_terminal` / `create_agent` / `create_schedule` / `create_heartbeat`），以及更早就没关闭的条目，都标 `unknown`，列进 incident 便签，接班者必须处置（§7.5）。什么清单都拿不到时（没有被动捕获的 provider，P2 之前也没有骨架），记一个必须处置的条目：“Session #1's turn started 01:12 and ran 38 min; no inventory available: check ps and lock files”。
- **人的话**：最后一次捕获之后的人的消息补成 `open` 输入，覆盖到的原话因此保留；长行、不可解析内容或未读积压记缺口，不能声称全部已补回。
- **骨架**（P2）：三种情形都建（执行者中位 8 MB，读一遍几秒；大的在后台低优先级读），接班者可用 `flowly_session_history` 检索。

台账条目的 `endReason`：`session_unavailable | crashed | poisoned | quarantined | failed_turn | limit | rotated`。

### 5.9 `flowly_get_task` 里的交接

- 输入增加可选的 `{ handoff?: "full" }`（工具输入今天是 `z.strictObject({})`，加一个可选字段）。
- 完整读取另外接受 `handoffCursor?: string`：`handoff:"full"` 返回一页，含 `revision`、各类条目总数、`omitted` 与 `nextCursor`。游标只属于本卡、限定返回字节，不接受文件路径。长输入按同一 id 的连续片段返回；后续页可读归档，直到 `nextCursor` 为空才表示本次范围完整。读取期间版本变化要明确返回 `viewChanged`，重读当前未决清单，不把旧页面当成新版本；原地写入的观察状态不是版本变化（§5.1 第六轮），读者自己 session 的轮询不会让它重来。归档里历史与下一个版本相同的台账版本（Flowly 的观察快照）不返回，只在 `supersededSnapshots` 里计数（§5.1）。`handoff:"full"` 是完整读取的入口，**不是**一次把所有历史塞给模型。抽屉用同样的读取路径。
- **`handoff`**：这个 session 第一次读（`seen` 里没有它）时给**默认视图**；之后给存根 `{ revision, updatedAt, by, unchanged, stale?, due?, open, headlines }`，外加自它上次读到的 revision 以来**别人**改动的条目（其它 session 的写入、人的便签与处置、Flowly 的 incident / hazard 便签、新的评审轮次、别的 session 收到的话），≤ 4,000 字符，超出时写明省略并指向 `handoff:"full"`。`headlines` 总在存根里：open 的输入与问题、standing 的输入和 pitfalls 的 id 与首行，≤ 1 KB（“and 6 more”）。Flowly 从这个 session 自己的回合派生的 git 与台账通常不重复；open、standing、缺口与外部输入仍按清单显示，不能仅因“来自它自己的回合”就认定它一定记得。读到的 revision 记在交接文件的 `seen` 里（只在变化时写）。一个 session 一生约 23 次 `get_task`，不能每次都多带几 KB，Codex 还会把每个结果存两份。
- **压缩后重给**：检测到这个 session 被压缩（§2 的 K：被动捕获读到压缩记录、回合中 C 降到上一次测量的 60% 以下、或回合结束时 K 增加）就删除 `seen[agentId]`，下一次 `get_task` 重新给默认视图，开头写 “Your context was compacted at 00:52; this is the card's handoff again.”。压缩丢掉工具输出，Codex 的摘要又是加密的，只有用户消息留下：不重给的话，它会以为自己还读着坑和人的指示（C5b.3 在 00:52 于回合中途压缩）。
- **默认视图**（≤ 24,000 字符，按顺序；超出部分写 “N earlier … omitted; flowly_get_task handoff=full”）。第 2 项是**保留预算**，agent 的各段挤不掉它，不用的部分留给后面：
  1. `you`：session 号、角色、为什么开始、前任；`ack`：待确认 / 已确认；
  2. 保留：(a) open 与 standing 的输入、开工说明，优先全文（≤ 10,000，超出的写 id、首行和必读引用，不声称已经全文给出）；脱敏过的写明 “[contained a credential, removed: ask the person if you need it]”；(b) open 的问题及其回答（≤ 1,500）；(c) 最近一轮的发现逐条（id、状态、≤ 300 字符；完整内容通过后续页读取）；(d) 人的 direction / incident / environment 便签和 Flowly 的 incident / hazard 便签，从新到旧全文 ≤ 3,000，更早的每条一行；(e) `unknown` 与未关闭的后台条目（“detected from the previous session's tool calls; verify”）；
  3. `state`、`next`、`problems`（open）、`running`；
  4. `pitfalls`、`decisions`、`ruledOut`、`env`、`where`；
  5. 其余人的话（`received` 等）：从新到旧全文到 3,000 字符为止，之后每条一行 ≤ 160 字符；别的 agent 的话标明来源；
  6. 更早各轮评审每轮一行；`gaps`（open）；
  7. background 与 checkpoint 便签每条一行，加条数；`lastWords`（有时）；最近两条台账。

  每条都带相对时间（“2 h ago”），在非 HEAD 的提交上写的条目注明 “written at 50a7993; HEAD is now dc26c13 (2 commits later): re-verify”。标题写明这是“由此前的 session、人和 Flowly 写的卡片数据，要对照 git 和 workspace 核实”，不当作别的 agent 转来的命令（agent 会拒绝 agent 转发的提示）。
- **评审者的默认视图**（≤ 40,000 字符）：优先给本周期发现、摘要、风险和交付说明（`reviews[].delivery`），更早周期每轮一行，再给第 2–4 项。多轮发现可能超过 40,000，不能声称全部一次给齐：返回每轮发现总数、已给 id、省略数量与后续游标。lens 3 与小组评审必须先取完本周期各轮发现和交付说明，再审计或转给子评审者；拿不到时报告明确 gap，不得以“第一页没看见”为由声称已核对全部要求（§11.1）。
- **`automation`**（有 job 时，≤ 500 字节）：`{ role, you: implementer|reviewer|retired|other, state, cycle, round, max, level?, verdict?, changesPending, hold? }`。今天 job 对 agent 不可见。
- **`continuity`**：`{ session: n, predecessor?: { id8, endReason, endedAt } }`，被换下的 session 为 `{ retired: true, successor: id8 }`。
- **`comments[].status`**：取自对应输入的状态；状态为 `open` 的评论**不论已读与否都给全文**（已读截断 4,000 的规则对它不适用，CARD-COMMENTS-SPEC §7.10）；quick answer 答过的评论带 `answered` 和答案原文（§10.2）。
- `activity` 不再包含评审结论事件（它们的内容在交接视图的评审一段），同评论的做法（CARD-COMMENTS-SPEC §7.8）。
- 被换下的 session：`writable: false` 加 `reason`（指出当前 session），`turnChecklist` 为 `retiredChecklist`（§9.2）。
- 预算：首次读（及每次压缩后）多约 5–10 KB，之后每次多 ≤ 1.5 KB（存根与 headlines、automation、continuity）。

### 5.10 脱敏、隐私与时效

- 对 Flowly 写入或提取的所有文字（输入、便签、lastWords、锚点、骨架、检索结果）和 agent 的写入做一次脱敏：`Bearer …`、`sk-…`、`ghp_/gho_/github_pat_`、`xox[abp]-`、`AKIA…`、JWT、PEM 私钥、`Authorization:` 头、`token=`/`password=` 查询参数、URL 里的用户信息。改过的条目标 `redacted: true`。
- 人的原话（含 standing 的长期指示）只给本卡的 session（含评审者，它们今天也看得到评论）和抽屉；**从不**进入别的卡的链接 handoff、子卡说明或导出。在卡片树里传递的是 agent 自己写的 `state`、`pitfalls` 和 Flowly 的 incident / hazard 便签（§11.5、§11.6）；skill 因此要求把人的长期指示标为 standing，而不是抄进 pitfalls（否则它要么被剥掉而丢失，要么破坏这条规则）。父卡的 standing 指示能否原文传给子卡不在本次扩大传播范围；父卡 agent 把相关约束明确写入子卡说明，并引用父卡指示来源。
- 文件 0600，随卡删除。

## 6. 轮换过程（状态机的改动）

### 6.1 job 新字段（全部可选；job 是非严格对象，旧版本丢掉；不新增 `state` / `code` 值）

`state` 与 `code` 是看板 schema 里不带 `catch` 的 `z.enum`，新值会让旧版本拒绝整个 `board.json`，所以阶段放在新字段里，job 在整个轮换期间保持原来的状态（`starting`、`working` 或 `reviewing`）。

```
instruction.kind?: start|again|nudge|retry|cooldown|host_retry|changes|round|wake|comment|requested|finalize
instruction.verbatim?: true                       // 人的原文（路由的评论）：不带 [Flowly automation] 前缀
sessions?: { implementer?: SessionMeta, reviewer?: SessionMeta }
  SessionMeta { agentId, n, since, reason, turns, C0?, peakC?, lastTurnStartAt?, lastTurnEndAt?, lastOutcome?,
                measured?: { at, C?, W?, B?, S?, K? }, ttl?: "1h"|"5m"|"openai"|"unknown" }
rotation?: { id: "rot:<taskId>:<generation>:<role>:<n>", role, from, trigger, forced, boundary: tight|other|forced,
             phase: finalizing|sealing|creating, carry: { id, kind, text, fresh, reviewDelivery?, verbatim? },   // id：被延后的指令自己的 id
             prevMeta?: SessionMeta,                  // 回滚时还原 sessions[role]
             finalize?: { instructionId, sentAt?, turnStarted? }, facts: { C?, W?, B?, K?, idleMin?, ttl? }, at }
rotationAbandoned?: { instructionId, at }         // 回滚过的指令：对它的软决定一律保持（§6.4）
retired?: { agentId, role, n, at, reason }[] ≤50  // 被换下的执行者与评审者（与板上事务原子写入；queueIn 照带）
rotations?: { soft, forced, bytes }               // 本次运行；bytes 含 R0 的 ≥ 200 MiB 与 R1
cycle?: int                                       // 评审周期：新 generation 与 reopened 后的评审开始时加一（§5.2 reviews.cycle）
launchModel?: { provider, model, mode?, thinking? } // 开工时人选的模型，消费 launch 文件时记下，所有执行者接班者都用（§3.4）
rotateRequested?: { at }                          // 人点了 Continue in a fresh session
retiredTurn?: { agentId, at }                     // 被换下的 session 正在回合中：Flowly 暂扣对本卡的发送（提示性，§6.5）
checkpoint?: { agentId, reason, at, steered? }    // 只对执行者与收尾中的 session
silentSince?: { agentId, at }                     // §4 的沉默信号
hold?: "history_runaway"
pendingInputs?: string[] ≤20                      // 等着随下一条指令送达的输入 id（§10.1）
ackDue?: { agentId, since }
historyWarning.level?: "large" | "critical"
handoffGaps?: string[] ≤5
```

`reviewers`（≤ 20）照旧写入，旧版本的行为不变。提高它的上限会让旧版本解析失败，所以另设 `retired`（≤ 50）；守卫同时读 `retired`、`reviewers`、交接台账和 label（§9.1），没有 20 条的断崖。

`queueIn()` 新建 job 时只带选定的字段（`automation.ts:244-265`），所以要加上：`retired`（截到 50）、`cycle`、`launchModel`，以及执行者被保留时（Run again in session #n、父卡的 `action=start`）的 `sessions.implementer`（没有它，回合数、C₀、空闲时间和 TTL 都丢了，软规则判不了）。

### 6.2 阶段

| 步骤 | 做什么 | 事件 |
| --- | --- | --- |
| 0 决定 | 在 `send()`、`begin()`、`wake()` 或评论路由里：刷新快照，测量（§2），`rotationDecision`。软决定缓存在指令上；R0、R1 每次发送尝试都重判。 | — |
| 1a 收尾（满足条件时） | 一个事务里：`rotation = { phase: finalizing, carry: 当前指令 }`，`instruction = { kind: finalize, text: finalizePrompt }`。发送规则同任何指令：本 session 和对方角色都空闲，稳定的 messageId。 | `automation_handoff_requested`（“Asked session #2 to update the handoff before a fresh session takes over: context 68% of 475k”） |
| 1b 收尾回合 | `from` 开始回合时：不适用 A1、不算接管、不重开。这个回合里允许 `flowly_update_handoff`、`flowly_get_task`、`flowly_session_history`、`flowly_report_progress kind=progress`、workpad 的验证与验收项（`flowly_update_workpad`，不改 plan）和 `flowly_add_artifact`：这些是记账，不是交付，最后一刻的测试结果要能带着 SHA 进 workpad。status、type、tags、idea、卡片管理返回 `FINALIZING`（“Only record in this turn; the card continues in a fresh session”），所以不会出现收尾回合里的交付。`from` 的每个回合结束（钩子或对账恢复的，任何结果）都在 `judgeTurnEnd` 里先于 `turnDecision` 交给封存：不提醒、不判交付；本回合里这个 agent 提高了交接 revision 就记 `finalized: true`。回合以 provider 限额结束 → 封存，接班者用备用模型（§6.3）。回合里 HEAD 或未提交文件变了 → Flowly 记一条便签，照常继续。 | — |
| 1c 收尾没发生 | 发出 10 分钟后 session 空闲且没开始回合（经已有的漏钩子恢复判断，封存前再 `refresh()` 一次：在初始化或回合开始中就继续等）、或 session 消失 → 以 `finalized: false` 封存，按 §5.8 (c) 补叙述。收尾回合**正在跑**时从不打断；20 分钟时记一次便签 “The handoff turn is taking long”，继续等。封存之后才开始的收尾回合（按 messageId 认出）仍可写交接的全部各段，条目注明 “late handover from session #2”；它在跑时照样暂扣接班者（步骤 3），Flowly 再派发前会复查它是否仍在跑；宿主迟到消息仍可能在接班者启动后唤醒它，因此这不是进程互斥锁。 | — |
| 2 封存 | 先写交接文件（以 `rotation.id` 为键，重放不改变任何东西）：台账条目（`endReason`、测量值、`finalized`、`handoffRevisionAtEnd`、后台条目、未用的 next moves 标签）、封存快照、`git`。**然后一个看板事务**：`from` 推入 `retired`（评审者同时用 `retireReviewer` 记入 `reviewers`），删除 `implementerId`（或 `reviewerId`），`rotation.prevMeta = sessions[role]`，`phase: creating`，`instruction = successorMessage(carry, …)`（§7.2），先记 `pendingOp` / `pendingRole`（同今天），执行者设 `ackDue`。`nudges`、`failures`、`cooldowns` 清零（同 `switchToFallback`，`automation.ts:637-639`；今天的 `rotate()` 不清）：接班者从没经历过那些回合，带着计数它一次普通失败就会用完预算、让卡片进 Blocked。 | — |
| 3 创建 | 已有的 `create()` 路径：prepared op → 稳定的 agentId、idempotencyKey、`exists()`、Full access、labels；preparation 带连续性说明（§7.1）；执行者用 `launchModel`（§3.4）。本卡任一被换下的 session（最新 5 个）在跑、初始化、回合中或等权限时暂扣，指令留着，15 秒的派发再试。 | — |
| 4 提交 | 接班者被确认（第一个回合开始或创建确认）：删除 `rotation`；`sessions[role] = { n+1, reason }`；播种已读（§7.4）；把 `from` 在 Flowly 输入框队列里的条目改到新 agentId；`from` 未用的 next moves 在卡面上隐藏（标签已在台账）；按 §5.8 排队建骨架（其它情况按需）。 | `automation_rotated`（note：原因、测量值、“handoff updated in a handover turn” 或 “handoff not updated: <why>”） |
| 5 确认 | 接班者的第一个回合，每个 Flowly 工具结果都提醒确认接手，直到确认（§7.5）。 | `handoff_acknowledged`（“Session #3 acknowledged: 6 items, 1 question”） |

**收尾条件**（全部满足）：触发是 R1、R2、R3 或执行者的 R5（R4 已冷，R0 不收尾）；session 热（I < TTL）；B < 64 MiB，或已加载（§2 的 L）且 B < 200 MiB：只有实测证实该路径不会重新加载历史时才可向 64–200 MiB 的已加载 session 收尾；能力未证实时仍按 64 MiB 上限，不能仅靠快照状态推断安全；最后一个回合不是中毒失败，provider 不在限额或冷却中；记录过期（§5.5）。评论边界也按相同条件收尾：紧密评论也可能因 R1 或 L_tight 触发，非紧密评论可能因 L_cold 触发；预计多等 1–3 分钟，客户端写 “Session #2 is updating the handoff; your comment goes to the fresh session next”。插件的运行 id 不再用作“已加载”：每次 `paseo plugin reload` 都会让所有 session 看起来未加载，而 daemon 其实还在内存里拿着它们。

不收尾的轮换（冷、未加载的大 session、中毒、限额）由 §5.8 的叙述、后台清单和骨架补；冷 session 不收尾是用信息换钱，列在 §16.1 与 §19。

收尾说明（daemon 英文）：
> `[Flowly automation] Before a fresh session continues this card (<reason>), bring the card's handoff up to date with flowly_update_handoff: state, next (ordered), decisions and ruled-out approaches with reasons, open problems, pitfalls, what is still running (async shells, exec sessions, browser tabs, scripts, sub-agents: how to check or stop each; stop only those whose result is already on disk), where things are, and environment facts. You may also record validation results in the workpad and register output files as artifacts. Do not change files or the card's status and do not start new work; end your turn after the write. The fresh session's first instruction will be: «{carry, first 1,500 characters}». Note in next how to approach it; do not start it here. If a notification wakes you later, record what it said with flowly_update_handoff (note) and end your turn.`

收尾说明带上被延后指令的开头，让旧 session 能在 `next` 里写怎样做它；这也是降级时的退路（§15.1）。

### 6.3 强制轮换

- 备用模型、中毒、≥ 200 MiB 跳过步骤 1，直接封存。`switchToFallback`（AUTOMATION-SPEC §4.5）和今天的 `rotate()`（§4.6）都改为调用同一个 `beginRotation(job, role, reason, { finalize })`；`takeoverNote` 与 `rotationNote` 缩成指向连续性说明的一句。
- **后续指令不原样带过去**：提醒、重试、冷却与宿主重试的文字（“The last turn failed … (attempt 2 of 2)”、“reminder 1 of 2”）说的是接班者没经历过的回合。carry 改为 `startPrompt(again:true)`，加上那条后续所跟的指令还没完成的内容（`job.changes`、唤醒列表、本轮的 `reviewPrompt`）和待办输入。
- **创建中再遇到限额**：`creating` 阶段的创建被 provider 限额拒绝时（`create()` 在 RPC 之前已把 `implementerId` 设成准备好的 agentId，`automation.ts:1057`），这是同一次轮换换了模型：保留 `rotation.id` 与 carry，不为从没建成的 agent 写台账或 `retired`（今天 `switchToFallback` 的 `keep: !!pendingOp`），计为强制。不嵌套第二次轮换，successorMessage 也不会套一层。
- job 运行中被归档的执行者仍是 `failed` / `session_unavailable`，加上封存和 incident 便签；不自动继续，因为崩溃需要人。人的 Run again 再用记录开新 session（R0 只对评审者和 `starting` 生效，§3.3）。

### 6.4 回滚

- **软触发**的创建明确失败（不是未知结果）、启动重试预算用完时（今天 `start_failed` 会让 job 失败）：重新采用 `from`，一个事务里：角色 id 改回 `from`，从 `retired` 移除，`sessions[role] = rotation.prevMeta`，删除 `ackDue`，`instruction` 用 carry **原来的 id**（`carry.id`）恢复，记 `rotationAbandoned = { instructionId }`，所以下一次 `send()` 对它的软决定是保持，不会再轮换、再失败地循环；删除 `rotation`。交接文件里撤销封存：台账条目清掉 `endedAt` / `endReason` 并记 `abandoned: rotation.id`，封存快照标为 abandoned。记 `automation_rotation_abandoned`（“The new session could not be started; the implementer continues in its previous session”）。旧 session 是健康的，job 不必失败。
- **强制触发**不回滚，走今天的失败处理；**未知结果**不回滚（接班者可能已存在），照今天进入 `needs_human`，`rotation` 保留。

### 6.5 幂等与对账（补充 AUTOMATION-SPEC §4.4）

| 对账时看到的阶段 | 做什么 |
| --- | --- |
| `finalizing`，指令还没发出 | 用同一个指令 id 发出。 |
| `finalizing`，已发出，3 分钟没有回合开始，session 空闲 | 已有的恢复（session 的 error / attention 状态）判断是否有回合结束；没有则按 1c。 |
| `finalizing`，回合在跑 | 等。 |
| `finalizing`，回合开始过，快照显示 session 空闲，没有收到回合结束 | 当作回合结束：封存（`finalized` 看它有没有提高交接 revision）。不交给 `turnDecision`，否则会提醒收尾中的 session 或把 job 设为 `needs_human`，轮换卡在 finalizing。 |
| `finalizing`，session 归档、消失或 ≥ 200 MiB | 不收尾，直接封存。 |
| `sealing` | 台账里已有 `rotation.id` 就只做看板事务，否则先封存。 |
| `creating` | 已有的 `pendingOp` 路径：同一个 op、同一个 agentId；未知结果 → `unconfirmedStart` 与 `needs_human`（今天的做法）；`rotation.carry` 一直保留，不丢、不盲发。 |
| `retiredTurn` | 只是提示：每次据它暂扣之前用 `refresh()` 核实（running、activeTurn、pendingPermissions，同对方忙检查），快照显示空闲就清除。插件重载丢了被换下 session 的回合结束钩子时，不会把本卡的发送暂扣 6 小时。 |
| `starting` 的 job 带着 `rotation`（Run again 时先收尾） | 今天“`starting` 超过 2 分钟没进展就重新 prepare”的过期启动恢复不适用，按上面各行处理。 |

- 每个事务都以 `current()` 为门：同一 generation、角色、指令 id、job 活着、`automationAllowed`。Stop、归档或人的接管取消轮换；台账条目保留，旧 session 仍是 Run again 能选的“上一个 session”。
- 轮换从不在这些时候开始：`unconfirmedFor` 有值；评审指令被 `reviewPause` 暂扣；本卡任何 session（含被换下的）在跑、初始化或等权限。
- 待发指令仍先送达（对账已有的 “pending instruction first”，`automation.ts:1354`）。没有指令时的过期启动恢复不再发裸的 `startPrompt`：卡片有台账或交接时用 `startPrompt(again:true)`，并且 preparation 本身带连续性说明（§7.1），所以没有一条创建路径会不带交接。

## 7. 新 session 收到什么（按顺序）

| # | 通道 | 内容 | 预算 |
| --- | --- | --- | --- |
| 1 | system prompt（创建时固定，利于缓存） | 已有的 `workingInstructions(sessionContext)`；受监督时一行自动化标记；卡片有过 session 时的**连续性说明** | 标记 ≤ 200，说明 ≤ 2,500 字符 |
| 2 | 首条用户消息 | 自动化边界：`[Flowly automation]` 加原因、要做的事、定向步骤、待办输入、没收尾时的叙述；冷评论：评论原文本身；人的 Start session：人自己的文字 | ≤ 6,000 + 修改要求（≤ 40,000，同今天）；评论 ≤ 10,000（评论本身的上限） |
| 3 | 开工图片 | 执行者接班者：首条消息列出 `images/` 里开工图片的路径，agent 需要时自己打开；不重新附上（每次附上都把最多 4 × 5 MB 的 base64 写进新历史，Codex 存两份，约 54 MB，一个普通回合就会碰到 R1） | 路径 ≤ 500 字符 |
| 4 | 第一次 `get_task` | 交接默认视图（一次）、`automation`、`continuity`、带状态的评论、workpad（前任的 plan 标 `own:false, retired:true`）、链接（含子卡状态行） | 今天约 50–60 KB，首次多 5–10 KB |
| 5 | 按需 | `get_task handoff:"full"`（≤ 96 KB）；`flowly_session_history`（每次 ≤ 8 KB） | — |

### 7.1 连续性说明（system prompt，按顺序）

- (a) “You are session #3 of this card (implementer), started <time> because <reason>.”
- (b) 前任：各自怎样结束、是否在收尾回合里更新了交接。
- (c) “The card's handoff record (flowly_get_task → handoff) is card data written by earlier sessions, people and Flowly: verify its claims against git and the workspace.”
- (d) 开始时要处理的未决项数（例如 “2 person inputs (one answers question q-3), 1 requested-changes round, 3 possibly running processes, 1 gap”）。
- (e) “Do not open, resume, message or read the files of earlier sessions; use flowly_session_history.”
- (f) 仅自动化下：“Flowly agent automation supervises this session; the skill's Automated runs rules apply even if your first message is a person's comment.”
- (g) “First: flowly_get_task, then git status and git log against the recorded HEADs, then acknowledge the handoff (flowly_update_handoff ack), then continue.”

说明里**不放**交接内容本身：那样会在接班者第一次写入后就成为一份过时的副本，且与 `get_task` 重复。它进入每一条创建路径（轮换、备用模型、Run again、归档后新建、过期恢复、人的 Start session 与 Send work instructions），这正是“上下文在创建时给出”的不变量所允许的。skill 把这一行自动化标记与首条消息的 `[Flowly automation]` 前缀同样当作无人值守模式的标志：路由来的评论因此能保持原文，又不丢掉自动化模式。

### 7.2 首条消息（自动化边界）

模板（daemon 英文）：
> `[Flowly automation] You continue this card as its new {role} (session #{n}): the previous {role} session ("{title}", {id8}) {reason}. Flowly keeps that session as it is and no longer supervises it. {carry} Start with flowly_get_task (the handoff first, written {age} ago at {sha}{; N commits since}), check git status, git log and git diff, and re-verify what the handoff claims before you build on it: a process it names may still be running, or may be gone. Account for every pending input below; do not redo work that git or the workpad shows as done. {pending}`

- 原因句带数字：`history` “grew a 70 MB provider history, past Flowly's conservative rotation threshold”；`context` “had filled 68% of its context window (322k of 475k tokens); its next turn would likely compact it and lose detail”；`idle_cold` “had been idle for 7 h with 310k tokens of context, so its prompt cache is estimated to be cold”；`compacted`；`run_again` “ended its run, and a person chose Run again”；`poisoned` “failed with an error that repeats in the same session: …≤200”；`fallback`；`archived`；`requested` “a person asked for a fresh session”；`new_cycle`（评审者）。
- `{carry}` 是被延后的指令：修改要求全文（同今天的 `job.changes`）；唤醒列表；评审者本轮的 `reviewPrompt`（绑定 `reviewDelivery`）；Run again 的继续说明（`startPrompt(again:true)`）；外加父卡反馈、依赖 handoff 和父卡集成分支（`begin()` 的追加，不变）。后续指令换成继续说明（§6.3）。主动的指令放在前面：只有背景、没有指令时模型会闲着或只叙述（Hermes #100818）。
- `{pending}`：未处理输入的 id 和首行，回答问题的写 “d-12 answers q-3: <question>”；未答的问题；≤ 2,000（全文在 `get_task` 里）。
- §5.8 的情形（没收尾就封存而记录落后，或跟在异常回合之后）：“What session #2 said since its last handoff write (unverified narration): …” ≤ 2,000。
- `begin()` 的从头开始的 `fresh` 只用于卡片没有台账、没有更早 job 的情形（修复 `automation.ts:835`：今天 Run again 遇到已归档的执行者时，新 session 被告知“从头到尾”做，没有交接）。

### 7.3 冷评论与人开的 session

- 冷评论建的新 session：首条消息就是评论原文（`instruction.verbatim`），连续性和自动化标记都在 system prompt。
- 人的 Start session：首条是人自己的文字，system prompt 里同样有连续性说明。

### 7.4 已读状态

`ArtifactReadStore` 每个 agent 只存一个读卡时间（`reads: record<string,string>`，`server/artifact-reads.ts`）。提交时（新 agentId 还没有记录才做，幂等）：前任最后一个回合在它的读卡时间之后正常完成 → 用前任的读卡时间；否则用 min(前任读卡时间, 前任最后一个回合的开始时间)。所以只在崩溃的回合里读过的评论对接班者仍是未读。逐条的“已处理”不放进这个文件（改值的形状会让旧版本报 “Artifact read data is invalid”），而是靠交接输入的状态：`open` 的评论不论已读与否都给全文并标出（§5.9）。

### 7.5 接手确认（ack）

在接班者的第一次交接写入里：

```
ack: { handoffRevision, heads: { repo, sha, dirty }[],   // 每个仓库：git rev-parse --short=12 HEAD / git status
       understanding: ≤800,                           // 用自己的话说现状和第一件要做的事
       items: { id, disposition: doing|done|obsolete|ask, note? ≤300 }[],
       questions?: string(≤300)[] ≤5 }
```

- 要处置的只有：状态为 `open` 的输入、open 的问题、最近一次修改要求里未完成的发现、未结束的 `running`、未关闭与 `unknown` 的后台条目（含 §5.8 的 “no inventory available” 条目）、open 的 gaps。`received` 的人的话、`problems` 等不要求逐条处置，避免把确认变成清单负担。
- 机械核对：Flowly 为这次写入读到的 HEAD 与写入落在同一个 revision，所以 `handoffRevision` 对照的是 Flowly 自己刷新之前的 revision（第五轮，§5.1）；这个 revision 不随观察状态前进（第六轮，§5.1）：接班者自己回合里的轮询、它自己的检查、在途调用、太长的输出与它启动的 exec session（第七轮）、共享仓库里别人的编辑都不让准备好的 ACK 或部分确认的续写落后，新的要求（人的话、便签、缺口、真实的后台条目）仍然让它落后（open 的分组缺口在读之后原地增长的出现不换 revision，但这次确认不结算它们，见下）；在途调用与回合中启动的 exec session 不在必须处置的名单里（回合结束或封存时还在跑的 exec session 才在，第七轮）；每个仓库的 `sha` 与 Flowly 自己读的不一致 → `ACK_MISMATCH`（给出 Flowly 的值，本次写入不记录，重新检查仓库并读实际值后重发；不能只照抄错误提示）；Flowly 读不到 HEAD 的路径（不是 git 仓库）不核对，所以不在 git 里的项目根不会每次都被拒；漏掉的 id → 已给的照常记录，回执的 `ackMissing` 列出其余，确认在全部处置后才算完成；`done` 与 `obsolete` 需要 `note`。
- 效果：处置更新对应条目（记下 note 与 session）；对 gap 的 `done` / `obsolete` 处置同时关闭它（`resolution` 带处置说明与 `handoffRevision` 那时的 `count`，一次确认覆盖分组缺口到那个 revision 为止的全部出现，§5.7）；那之后原地计入的出现（同一个 revision，接班者读的时候看不到）不被结算：缺口保持 open，`resolution.count` 是那时的计数，这个 id 不进记下的 `items`、列在 `ackMissing` 里，下一次确认关闭它（P2 复查第一轮）；`gaps` 里的显式关闭同样；对后台条目（台账里未关闭与 `unknown` 的 `b-*`）的 `done` / `obsolete`（note 说明核实了什么：已结束、无关）把它标为 closed，`outcome` 写明经 ACK 处置，之后的接班者不再需要确认它；`doing`（接管在跑的服务）与 `ask` 保持打开；`ask` 加提醒“问人（question）”；`questions` 成为 gaps（by successor），卡片上看得到；`understanding` 显示在抽屉里，人一眼能看出新 session 理解得对不对。记录指标：确认用时、首次完整与否、第一次提交的用时。
- 交付门是软的（§5.5）：没确认就交付第一次被拒，带 `acknowledgeOpen=true` 的重试通过，不会卡死在循环里。不用 LLM 打分。

## 8. 前任历史的访问

### 8.1 骨架（`server/session-history.ts`，P2）

- 从不使用：`fetch_agent_timeline`、Paseo 的聊天搜索、发送、刷新历史、恢复、`syncNative` 清 attention、session 预览（§5.7 的补读只对已加载、B < 64 MiB 的 session 读内存 timeline 的尾部）。它们都会让 Paseo 整个加载历史（Codex `thread/read includeTurns:true` 作为一行读回；Claude `readFileSync` 主转录和全部子代理文件）。
- 何时建：按需（第一次检索时）；以及 §5.8 的三种情形在被换下时（普通 session 几 MB，读一遍几秒）。收尾过、记录新的轮换不建，避免为不常用的恢复路径在 daemon 主机上做 IO。
- 怎么读：自己的分块读取器，一次一个、低优先级、块之间让出事件循环；**超过 256 KiB 的行不缓冲直接丢弃**，只看每行前 512 字节判断类型，所以每行仍计入体积构成。1.18 GB 文件约 10–30 秒，内存峰值约 74 MB（研究时实测）。
- 保留什么：Codex 的 `response_item` 用户与助手消息、工具名和截到 300 字符的参数、≤ 300 字符的错误；丢掉工具输出（`*_output`）、重复的 `event_msg item_completed`、图片和 `fileChange` 内容。Claude：主链文本块和可读的 `isCompactSummary` 文本；子代理文件只取文本，每个 ≤ 200 KB。
- 产出：`{ordinal, at, role, text ≤2000, tool?}` 的 jsonl（脱敏，≤ 2 MB），以及锚点和体积构成。
- 可选的快路径（P3，§19 的技术核实）：Codex 的 `thread_history_1.sqlite` `thread_items WHERE item_type IN ('userMessage','agentMessage')`，只读打开，读不了就退回流式。

### 8.2 工具 `flowly_session_history`（只读）

`{ session: "#1" | agentId, query?, around?: ordinal, roles?: [user|assistant|tool], limit ≤ 20 }` → 命中或一段窗口（带 ordinal 和相对时间），每次 ≤ 8 KB。只能查本卡台账里的 session；执行者、评审者、被换下的 session 都可用。骨架还没建好时回答 “Skeleton not ready (building); try again in a minute”，从不在调用里读原始文件。skill：只在记录缺东西时用，从不 `cat`、`grep`、`tail` provider 文件。

### 8.3 拿不回的

Codex 的推理和压缩摘要是加密的；工具输出和图片有意不留。被跳过的长行、被滚动窗口替换的叙述和骨架容量之外的消息同样可能拿不回：保留时间范围、跳过条数和容量裁剪计数，不把骨架叫作完整转录。

## 9. 被换下的 session

### 9.1 名单与识别

一个 session 对卡 X 是**被换下的**：它在 X 的 job 的 `retired` 或 `reviewers` 里，或在 X 的交接台账里且条目的 `role` 是 implementer / reviewer、`reason` 是自动化的原因，或带 label `flowly-task=X` 和任一 `flowly-automation` 角色（`automation.ts:1104` 创建时设）；并且不是当前的 `implementerId` / `reviewerId`；并且 job 活着或 `delivered`。人自己开的 session（抽屉的 Start session 等）也在台账里，但不算被换下：人在里面打字仍是今天的接管（`taken_over`）。

- `retired` 与删除角色 id 在同一个看板事务里写入，所以崩溃不会留下“已换下但没记名”的 session（不依赖单独的注册文件）。
- label 兜住升级之前被替换的 session（备用模型、历史过大的轮换）和超出名单上限的。回合钩子的 agent 只有 `{id, workspaceId, parentAgentId, provider, cwd, title}`，没有 labels；所以只在**少见的接管路径**上、在事务**之前**做一次 `refresh()` 读 label，再把结果带进事务（事务回调是同步的，不能在里面等 RPC）。label 不可变，按 agentId 缓存。回合开始钩子在 `store.mutate` 之前取得同一个结果，用于 A1 豁免。

### 9.2 守卫

| 情形 | 今天 | 本 spec |
| --- | --- | --- |
| 被换下的 session 开始回合 | job `stopped` / `taken_over`（`automation.ts:330`） | 不算接管；不适用 A1（同 `reviewerJob` 的豁免，A1r 也就没有可恢复的）；记 `job.retiredTurn`；回合期间 Flowly 暂扣对本卡当前 session 的发送和创建（`send()` 的对方忙检查、`begin()`、occupancy 都把在跑的被换下 session 算进去）；记 `automation_retired_turn` |
| 它的卡片写入 | 执行者可写 | `RETIRED_SESSION`（指出当前 session）：status、workpad、交接的各段、type、tags、artifact、idea、result、metadata 和卡片管理（`flowly_create_card` / `flowly_update_card`，被换下的父卡不能再管子卡）。允许：`get_task`、`report_progress kind=question / progress`、`flowly_update_handoff` 的 `note` 和自己的 `running` 条目、`flowly_session_history` |
| 评论默认收件人 | 可能退到它（`client/card-comments.ts` 的“最近活跃”回退） | 从不默认；To: 里标 “Session #1 (replaced)” |
| Flowly 输入框队列 | 读队列时 `drainAll` 会发给它 | 提交时改到接班者；之后（例如旧客户端）排给它的在 `drainAll` 时也改到当前执行者，队列里写 “moved to session #3” |
| next moves | 留着，点一个就唤醒它 | 卡面隐藏；session 视图里显示 “This session was replaced; send to session #3 instead” |
| 第 21 个以后的评审者 | 失去保护 | `retired`、台账与 label 继续保护 |

Stop automation 之后（job `stopped` 或 `failed`）守卫解除，它又是普通的管理 session。Stop 只对活着的 job 有（`automation.ts:284`、`client/automation-view.ts:60`），`delivered` 的 job 没有，所以被换下 session 的横幅和抽屉都有 **Continue in this session**（job 活着或 `delivered` 时）：关闭 job（`stopped` / `taken_over`，正是今天人在别的 session 里打字的结果），守卫随之解除；之后的 Run again 照常用记录。

`retiredChecklist`（被换下的 session 读到的 `turnChecklist`，3 条）：
1. “This session was replaced by session #3 (<id8>) on <time> (<reason>); the card's work continues there. Read flowly_get_task only for context.”
2. “Do not change files, the card or its sub-cards. If you know something the new session needs (a background task's result, a fact), add it with flowly_update_handoff note, then end your turn.”
3. “If a person here asks you to work on the card, tell them it continues in session #3. Do not change files here until they choose Continue in this session on the card (that ends the automation run and lifts these limits); until then, record what they asked with flowly_update_handoff note.”

### 9.3 被换下的 session 的回合结束

- 照 §5.7 捕获：人的话成为 `open` 输入（`via: retired_session`），别的 agent 的消息成为 `via: agent` 的输入；后台通知与 agent 通知关闭对应条目并加一条 background 便签（首行、退出状态、≤ 600 字符的尾部，脱敏；失败、超时与丢失为 hazard）。这与 §5.7 是同一条规则，对所有 session 都写，不只被换下的（第三轮统一：便签不是要确认的条目，以前 §5.7 只在失败或带结果时写，成功完成的 async shell 与对上了启动的 Claude 通知在被换下的 session 里也什么都不留）。
- 每个回合另记一条 `retired_turn` 便签：它的最后一条 agent 消息（≤ 600）和这个回合里各仓库的 git 变化（HEAD 前后、未提交文件的 diffstat）。被换下的 session 可能照人的话回答了什么、改了文件，当前 session 必须知道，免得重做或覆盖；若它已经在运行，不能承诺通知会先于它的下一次文件写入到达。
- 清除 `retiredTurn`。然后：
  - job `working`、当前 session 空闲、没有待发指令 → 发 `[Flowly automation] Since your last turn, replaced session #1 <ran a turn: its background task finished | a person wrote to it | another agent messaged it>; it said: "…≤600"; files changed: <diffstat | none>. See the handoff (inputs d-12, notes nt-4).`，`kind: wake`，走 §3.3；
  - job `delivered` 或 `needs_human` → 只记录，抽屉显示 “A person wrote in replaced session #1 (not handled)”，带 **Send to session #3**（发送原文，按 AUTOMATION-SPEC §4.2 重开）和 **Mark handled**。Flowly 不替人判断那是不是反馈。

### 9.4 后台任务

Async shell 和 exec/PTY session 属于注册它的 session：`list_async_shells` 只列“你的”，通知只发给注册者，Flowly 不能改投。所以：
1. **预防**（skill）：自动化下注册 async shell 必须同时写 `running` 条目（是什么、句柄、完成后做什么）；父卡不为子卡注册等待者（Flowly 会唤醒它，SUB-CARDS-SPEC §5）；收尾回合里停掉结果已落盘的，其余列出来。
2. **机械捕获**：timeline 里的注册与取消自动更新台账（§5.7）。
3. **通知捕获**：§9.3（async-shell 通知与 `<paseo-system>` 的 agent 通知；子 agent 完成可关闭，schedule / heartbeat 的一次触发不关闭周期任务），加上被换下 session 自己的便签。
4. 接班者的确认要求处置每个未结束条目：检查、自己重新注册一个，或标为 obsolete。

Flowly 看不到的进程（裸 `nohup`、浏览器标签以外的东西）只有 agent 写了才保留，是已知缺口；接班者被要求用 `ps`、锁文件核实。被换下 session 的显示：Flowly 的 session 视图有横幅 “Replaced: handed over to session #3 at 05:00; messages here are recorded on the card”；若 SDK 允许改标题，加 “(replaced)” 前缀（§19）。

## 10. 评论路由

`tasks.comment` 增加 `deliver?: "auto" | { agentId } | "fresh" | "save" | "quick"` 和 When running 偏好。daemon 照旧先记录（CARD-COMMENTS-SPEC §4 不变），再路由，按卡经 `deliver()` 串行。每条评论同时成为一个输入（`via: comment`，原文）：送达工作 session 且处理它的回合正常完成 → `received`；只记录未送达 → `open`。

### 10.1 自动化卡（job 活着、`delivered` 或 `needs_human`），`auto`（默认 To: “Card's agent (Flowly picks warm or fresh)”）

评论发给执行者。今天的 `send()` 只在 `starting`、`working`、`reviewing` 时发（`automation.ts:979`），`current()` 还要求 `job.role` 等于指令的角色（`:950`），`apply()` 在评审者回合结束时删掉 `job.instruction`（`:479`）：把评论塞进 `job.instruction` 会在 `needs_human`、`reviewing` 等状态里悄悄丢掉。所以评论有自己的转移，三条原则：

- **保持 → 直接发送**：原文直接发给执行者 session，与人在 session 里打字完全一样：不经 `job.instruction`、不改 job，messageId 记下供 §5.7 过滤。状态转移由 `turnStarted` 照今天做：`needs_human` / `retry_wait` / `waiting` → `working`；`reviewing` → `reviewPause`（需要时）加 `reopened`；`delivered` → `reopened`。
- **轮换 → 路由事务先做同样的转移**：旧 session 不会开回合，`turnStarted` 不会发生，所以事务自己做它对这个状态会做的转移，再设执行者的 `comment` 指令（`verbatim`）。从不覆盖另一角色的指令。
- **待办随下一条指令走**：`pendingInputs` 里的评论在这个执行者的下一条指令发出时（发给原 session，或作为接班者的首条消息）原文附上：“A person commented on the card meanwhile: …”。评审轮结束后若没有执行者的指令（批准 → `delivered`），它们作为一条 `comment` 指令按本节重新路由。

| job | 做什么 |
| --- | --- |
| 有 `rotation`、`pendingOp` 或 `unconfirmed` | 记入 `pendingInputs`。接班者正是为它建的 → 它就是首条消息；否则随首条消息或下一条指令（按 id 和首行列出，`get_task` 里全文）。客户端 “Session #3 is starting: your comment is part of its first instructions.” 从不发给 `from`，也不发两次。 |
| 执行者在跑 | 按人的 When running 偏好（steer / queue / interrupt），同今天。 |
| 执行者空闲；`working`、`needs_human`（含提问后）、`retry_wait`、`waiting`、`delivered` | `rotationDecision(kind: comment)`，距本卡上一回合 ≤ 20 分钟是紧密边界。保持 → 直接发送。轮换 → 事务里设为 `working`（`delivered` 加 `reopened`；`retry_wait` 清掉 `retryAt`，同 `turnStarted`），槽里已有的执行者指令（提醒、重试、唤醒）并入 carry；满足条件时收尾（§6.2），再建新 session，首条消息是评论原文。 |
| 执行者空闲；`reviewing`，槽空或是已派出的评审回合 | 保持 → 直接发送（同今天人在执行者里打字：评审暂停、`reopened`）。轮换 → 事务里做同样的转移（`role = implementer`、`reopened`、删 `verdict`、需要时 `reviewPause`），再设 `comment` 指令；评审者还在跑时，对方忙检查让发送等它的回合结束，而 `apply()` 因 `activeAgent` 已是执行者，不会删掉这条指令。 |
| 执行者空闲；槽里是评审者**未派出或被暂扣**的指令（含评审中途重开、暂扣着本轮 `reviewPrompt` 的 job） | 保持 → 直接发送。轮换 → 不覆盖（否则这一轮再也发不出去，之后的结论都是 `REVIEW_CLOSED`）：记入 `pendingInputs`，客户端 “Saved; the implementer gets it after this review round. Choose a session in To: to send it now.” |
| 已停止或失败 | 同今天：发给活着、未被换下的执行者，否则只记录；不重启自动化。 |

发送失败不算回合失败：job 回到原状态，客户端显示 “Saved on the card; not delivered” 与 Resend。

### 10.2 显式选择（所有卡）

- `{ agentId }`：选中的 session（被换下的列出但从不默认）。
- `fresh`（“New session with the handoff”）：为人开一个带连续性说明的 session，首条是评论原文；自动化下是原因为 `requested` 的轮换。
- `save`（“Save on the card (the next turn reads it)”）：只记录、不唤醒，下一回合读卡时未读。适合事故后补充事实、给以后的 session 留长期规则，零 token。
- `quick`（P3，“Quick answer from the card: does not reach the agent”）：
  - 一个**不受管理**的临时子 session（同卡片摘要：label `flowly=summarizer`、`paseo-rate-fallback=off`、没有 context file、用完硬删除，模型按 [SUMMARY-MODELS-SPEC](SUMMARY-MODELS-SPEC.md) 的顺序取最便宜的）。它不触发 A1、不算接管、不占目录，也没有卡片工具。
  - 输入（≤ 24,000 字符）：问题原文；标题、泳道、`automation` 摘要；交接默认视图（≤ 12,000）；未完成的 workpad 项（≤ 3,000）；最近 10 条活动；最近的交付说明；记录的年龄。
  - 输出 `{ answer ≤1200, asOf, result: answered | partial | not_in_record | contains_request }`，记为事件 `comment_answered`（system，链接 `commentId`）。`answered` 与 `partial`：输入标为 `answered`，工作 session 的 `get_task` 里这条评论带着答案（§5.9），所以它看得到人问过什么、得到了什么回答；只读回答不能把语义上尚未完成的请求证明成已办。
  - `contains_request`（问题里夹着要求，例如 “Did the migration run? If not, rerun it with --dry-run first”）：先显示答案，评论**同时按 `auto` 发给 agent**，输入保持 `open`。
  - `partial`：显示答案和 **Send to agent**。`not_in_record`、失败或 2 分钟没结果：**按 `auto` 发给 agent**（误判时偏向工作 session），附说明 “Flowly could not answer from the card; sent to the agent”，并记一个 gap（by answerer）：记录答不上来的问题就是一个可见的交接缺口；是否真的失败还要区分卡片本应记住的事实和新的任务。
  - 不自动分类：v1 只在人选它时运行。

客户端的默认收件人逻辑（`client/card-comments.ts` `commentTargets`）排除 `job.retired` 和 label 识别出的被换下 session。没有活着的 job 的手动卡：今天的规则（CARD-COMMENTS-SPEC §1），加上 `fresh`、`save`、`quick` 三个选项。

## 11. 评审者、小组评审、评审级别、父卡与依赖卡

### 11.1 评审 session

- 一个周期内保留（它记得自己的发现）；R0–R4 用它自己的 C、B、K 和空闲时间；从不收尾（它不能写交接，发现都在 `reviews` 里）。
- **新周期总是新评审者**（人的反馈或 Run again 开始的周期；`job.cycle` 加一）。这改变今天跨周期复用一个评审 session 的做法：新上下文评审更好，上一周期的发现通过 `reviews` 与归档可取（§19）。Run again 也不沿用评审者，这比 §5.2.3 的“只沿用 Standard 轮、不在小组或级别槽上的评审 session”更进一步，两条测试都仍然成立。
- 一轮中途因体积或上下文换评审者：重做**同一轮**（轮次不加），`reviewDelivery` 重新绑定，**沿用 job 上记录的本轮计划**（§5.2 的 `review`：级别、原因、上限、人数）以及 `seat` / `panel`，不重新解析；标题取 `reviewTitle(job)`（`Deep review:` / `Light review:` / `Panel review:` / `Review:`）。§5.2.3 已要求“同一轮的重发（备用模型、历史过大的轮换、重试、对账恢复）用 job 上记录的本轮计划”。更早各轮来自 `reviews`；更早的风险由 §5.2.4 照常附在每一轮的说明里。被换下评审者的迟到结论 `NOT_REVIEWER`。被换下的评审者可能已经在消息里写完了发现、只是没提交（R1 对后续也生效，Deep 与小组评审最可能过 64 MiB）：它最后一个回合的 `final`（§5.7）放进接替者的 `reviewPrompt`，“Previous reviewer's unsubmitted notes (unverified): …” ≤ 2,000，新评审者不必从零重做这一轮。
- `reviewPrompt` 加一句：“Read every finding and delivery note of this cycle in flowly_get_task → handoff.reviews, following nextCursor if any. Report missing evidence explicitly; do not treat an omitted page as an empty round.” 默认视图优先给本周期发现；超出时必须按游标读完全部发现与交付说明（§5.9）。

### 11.2 交接检查（`reviewPrompt` 的公共尾部，在 §5.2.4 风险一段之后，所有级别，约 450 字符）

> `Handoff check (does not block approval by itself): from the card's handoff alone, can a fresh agent tell (1) where the work stands and at which commit, (2) the main decisions and why, (3) what was tried and ruled out, (4) the next step and its gate, (5) what is still running and where the outputs are? Report what is missing in handoff.gaps (at most 5). A handoff that contradicts git or the workpad is a finding.`

具体的探针，而不是开放式的“新 agent 能接着做吗”，避免评审者总能找出一点缺口而导致过度返工（Claude Code 的提醒）。小组评审只由牵头者回答，子评审者不做。

### 11.3 `flowly_submit_review`

输入增加可选的 `handoff: { gaps: string(1–300)[] ≤ 5 }`，与 §5.2 的 `risks` 一起校验（`reviewInputSchema` 是严格对象，两个分支都在加可选字段，合并时并在一处）。gaps 写入 `job.handoffGaps`、`reviews[].gaps` 和交接的 `gaps`（by reviewer）。从不单独阻止批准：
- 与 `changes` 一起：附在修改要求末尾（“also close these handoff gaps; informational unless also a finding”）；
- 与 `approve` 一起：显示在卡片上（“Handoff gaps the reviewer noted (2)”）；卡片因人的反馈重开时，执行者的下一个 Flowly 工具结果提醒它们。**没有**批准之后再派一个收尾回合（见 §18.1）。

### 11.4 小组评审

状态机不变（AUTOMATION-SPEC §5.1）。B 是 Claude 主转录，子代理另记 S；Codex 子线程在 P3 单列测量，不把主线程阈值直接套到子代理总量。Deep 小组的主转录超过 64 MiB 才按 R1 在边界轮换，S 先观察警示，不据此自动停止正常的小组评审。小组说明里“交给每个子评审者”的内容不变（交接检查只归牵头者）。

### 11.5 父卡

- 父卡 session 最长寿（21–23 小时、13–36 个回合、唤醒前空闲中位 36–99 分钟）。唤醒是“其它”边界，R2–R4 常让它轮换；Codex 2 小时内仍热，所以多数能收尾。
- 父卡的记录最重要：编排决定、子卡的验收与合并状态、集成分支、等待者。轮换后的父卡收到已有的唤醒列表（`childrenPrompt`）和自己的交接。
- 子卡交给父卡：唤醒消息和 `get_task` 链接里每张子卡加一行交接 `state`（≤ 300）、“problems: n”，以及它的 Flowly incident / hazard 便签和 pitfalls 各一行（每张子卡合计 ≤ 600），放在 §5.2.4 的风险之后、证据之前，共用 SUB-CARDS-SPEC §8 的 16,000 字符总预算与每条 6,000。例如 C5b.3 的 “history grew to 327 MB from browser screenshots and patch-written relay files” 应当让兄弟卡 C5b.2 的下一个 session 看到。子卡的人的原话从不传给父卡（§5.10）。
- 父卡交给子卡：子卡的开工说明和链接里带父卡的 pitfalls 各一行（≤ 1,000）。父卡里人的 standing 指示（例如 “keep the install frozen”）默认不直接传原话，由父卡 agent 明确写入相关子卡说明并引用来源（§19）。
- `supervised` 跟随 `implementerId`（`agent-service.ts:233`），不受影响。被换下的父卡 session 对 `flowly_create_card` / `flowly_update_card` 得到 `RETIRED_SESSION`，不会让两个 session 都获得 Flowly 的子卡管理权限；文件系统和其它外部工具仍不受该守卫控制。
- `subCardActive`（SUB-CARDS-SPEC §5）本来就把“任一管理 session 在回合中”算作推进，被换下的子卡 session 被 async shell 唤醒时父卡会等，这是对的。

### 11.6 依赖卡

`cardHandoff`（`server/automation-handoff.ts`）给每个 blocker 加上它交接的 `state`、`pitfalls`、`env` 和 Flowly 的 hazard 便签（合计 ≤ 1,500），在每条链接 6,000 的预算内，排在风险（§5.2.4）与交付说明之后、检查之前。pitfalls 是 agent 自己的话（§5.10），所以不带人的原话。

## 12. 界面

- **卡面**：正常时没有新芯片。`rotation.phase = finalizing` 时自动化信号为 “Agent handing over”（脉冲点）；`creating` 时 “Starting a fresh session…”；`hold = history_runaway` 时 “History keeps growing too large”（需要人）；严重体积时 “Session history N MB, still growing”（warning）。记录的新旧在 job `working` 时也看得到：`job.silentSince` 有值时 “Agent has not updated the card for N min”，否则 `handoffIndex.fresh = false` 时 “Handoff N min behind”（N 从 `staleSince` 算，warning 色，`delivered` 与 `needs_human` 同样显示）。人不打开 session 也能知道卡片上的记录是不是新的。
- **抽屉，Agent automation 区**：
  - “Session #3 of this run · fresh after Run again · acknowledged 05:01”，下一行是它的 understanding；
  - “Handoff updated 6 min ago at dc26c13 (= HEAD)”或 “Handoff 41 min old; HEAD moved 2 commits; checkpoint requested 18 min ago, not answered”；
  - “Earlier sessions (2)”：标题 · 角色 · 原因 · 时间；
  - 被换下的 session 暂扣当前 session 时：“Waiting for an earlier session to finish its turn”；
  - Run again 与 ⋯ Run again in session #n（§3.4）；job 活着时的 **Continue in a fresh session**（设 `rotateRequested`）；
  - 每次 Run again 的 “What should the next session know?”（§3.4）；被换下 session 的 **Continue in this session**（§9.2）；
  - 评审者的交接缺口、quick answer 答不上来的次数。
- **抽屉，新的可移动分区 Handoff**（默认在 Workpad 之后，DRAWER-SPEC 的分区顺序；只在展开时按 etag 读）：
  - 标题行：revision、上次更新（session 号与相对时间）、新鲜或过期（以及变了什么）；
  - agent 的各段：State、Next、Open problems、Running / background（所属 session、年龄、结束与结果）、Pitfalls、Decisions、Ruled out、Where、Environment；
  - **Person's directions**：原文，状态（open / received / done / answered / superseded）和处理者；人可标 done、superseded 或 **standing**（以后接手必读，超预算时沿引用取全文）；脱敏过的标出；别的 agent 发来的消息另列，标明来源；
  - **Questions**：agent 问过的问题、状态和回答它的输入；
  - Notes（作者徽标：人 / agent / Flowly）与 **Add note**；Gaps；Review rounds；
  - Sessions：台账，例如 “#1 implementer gpt-6.1-sol 23:54–02:11, ended: session unavailable (history 1.18 GB), handoff not updated in the last 23 min”，及每个接班者的 understanding；被隔离的显示 “Too large to open (1.18 GB)”；
  - Show removed（墓碑）。
- **Comments**：打进 session 的人的话（来自交接输入，不是 `commented` 事件，不占评论的 50 / 20 名额）在评论流里以弱化样式显示 “In session {title}”，不能重发；To: 有 Card's agent (auto)、各 session（被换下的标注）、New session with the handoff、Save on the card、Quick answer（P3）；quick answer 显示在它的评论下，带 Ask the agent instead。
- **活动**（daemon 英文；事件 `action` 是 `z.string`，旧版本照常显示原始名）：`automation_handoff_requested`、`automation_rotated`（扩展）、`automation_rotation_abandoned`、`automation_retired_turn`、`automation_checkpoint`、`handoff_acknowledged`、`handoff_noted`、`handoff_gap`、`comment_answered`。agent 的交接更新不是看板事件。
- **窄布局**：同样的分区，默认折叠；手机只在打开 Handoff 分区时读文件。
- **新手引导**：一次性提示 `card-handoff`（项目里第一次出现轮换、打开那张卡时）：“When a session gets large or goes cold, Flowly hands the card to a fresh session; the Handoff section shows what it carried, and your comments and notes reach the next session too.”；欢迎页 More features 的 Agent automation 一行补上交接；README Highlights；所有新文案进全部语言目录（[ONBOARDING-SPEC](ONBOARDING-SPEC.md)）。

## 13. Skill 与回合清单

- **回合清单第 5 条**：“update workpad, then obtain” → “update workpad and handoff, then obtain”，并把 “or the user's requested handoff” 改为 “or one the user asked for”，让 “handoff” 只有一个意思。六条合计 **1,790 字符**（今天 1,784，测试要求 < 1,800、正好 6 条，`server/skill-source.test.ts:10-11`，已按 `shared/turn-checklist.ts` 实算）。第 6 条不改：加上 `HANDOFF_STALE` 会到 1,811 字符，拒绝说明本身写明了做法。skill 的生成文本逐字跟随。
- `reviewerChecklist` 第 1 条加 “and its handoff”。新增 `retiredChecklist`（§9.2）。
- **SKILL.md 新增一节 “Handoff and fresh sessions”**：各段写什么；检查点的时机（§5.4）；通常 ≤ 4,000 字符、指向文件而不是复制、从不写密钥；人的长期指示（“from now on never push to origin/main”）用 `inputs: [{id, standing: true}]` 标出，不抄进 pitfalls，pitfalls 用自己的话；描述与卡片有关的、人给的图片；按 `handoffDue` 行事；“after compaction, read the card handoff again; fetch any omitted standing directions, open inputs and review findings through handoff=full and nextCursor before acting”；第一回合确认接手；从不打开前任，只用 `flowly_session_history`；批量文件用脚本生成。
- **“Automated runs”**：无人值守模式的标志是首条消息的 `[Flowly automation]` 前缀**或** system prompt 的自动化标记；收尾回合只写交接然后结束；被换下的 session 怎么做；后台任务规则（§9.4）；卫生规则（§4）。
- 工具说明：`flowly_update_handoff`、`flowly_session_history`、`flowly_get_task` 的 `handoff` 输入、`flowly_submit_review` 的 `handoff.gaps`。

## 14. 错误码（daemon 英文）

| 码 | 何时 | 记录了什么 |
| --- | --- | --- |
| `HANDOFF_STALE` | §5.5 的交付门（交付、blocked、blocker、提问）：记录过期、缺 state/next、或接手未确认 | 无；同回合带 `acknowledgeOpen=true` 重试通过 |
| `HANDOFF_INVALID` | 结构不对（指出字段） | 无 |
| `HANDOFF_TOO_LARGE` | agent 各段合计超过 16,000（给出各段大小） | 无 |
| `HANDOFF_CONFLICT` | 碰到的条目自 `handoffRevision` 后变了（给出 id 与差异） | 无 |
| `HANDOFF_UNAVAILABLE` | 交接文件读不懂（已保留） | 不覆盖；计划内软轮换暂缓。强制安全轮换只能用独立恢复记录携带可得原指令与缺口，关键输入或评审要求不明则 needs_human，不带着空白记录继续工作 |
| `ACK_MISMATCH` | 确认里某个仓库的 HEAD 与 Flowly 读的不同（给出 Flowly 的值；读不到 HEAD 的路径不核对） | 无 |
| `RETIRED_SESSION` | 被换下的 session 的卡片写入（指出当前 session 和 Continue in this session） | 无 |
| `FINALIZING` | 收尾回合里 status、type、tags、idea 与卡片管理的写入（交接、workpad 验证与验收、artifact 允许） | 无 |
| `REVIEWER_ONLY`、`NOT_REVIEWER`、`REVIEW_CLOSED`、`ARCHIVED`、`TASK_FINISHED` | 同今天 | 无 |

## 15. 兼容与迁移

### 15.1 旧版本读新看板

- 只加可选的 job 字段、一个顶层数组 `handoffIndex`、事件上可选的字段和新的事件 action；**没有**新的 `state` / `code` 值，**没有**新的项目设置，**没有**新的回执 action。旧版本丢掉这些字段，照常读取 `board.json`。
- 旧版本忽略 `handoffs/`。它的接管规则会在被换下 session 开回合时停止 job，就是今天的行为，安全。
- 旧版本遇到 `rotation.phase = creating` 时仍可能沿普通 `instruction` + `pendingOp` 路径创建接班者，但不会保留新版本完整轮换状态，因此不能声称热降级无损。遇到 `finalizing`：看到一条发给旧 session 的指令，丢掉 `rotation`（carry 的唯一副本），按 `turnDecision` 判断它的回合结束，“静默”的收尾回合会收到一次 “If work remains, continue it” 的提醒。旧 session 仍能接着做，因为收尾说明里带着被延后指令的开头（§6.2），修改要求也一直留在 `job.changes`；剩下的退化（评论或唤醒的全文只在 carry 里）写进发布说明。
- 降级前必须备份 `plugin-data/flowly/`，并先停止派发、解决或结束 pending rotation / unconfirmed；新旧版本不同时运行。未经此步骤的中途降级不在“交接不丢指令”的保证范围内。

### 15.2 已有看板

- 不迁移。没有交接文件的卡读作空记录；第一次捕获时创建。
- 已有卡片的第一次轮换**引导**记录：Flowly 用最近 20 条事件说明、workpad、`job.changes` 和评论写一条便签（“built from the card's activity”）；旧 session 满足收尾条件时收尾回合照常（记录必然“过期”）。
- 升级时活着的 session 在下一次回合结束时补上台账（C₀ 未知，软规则的增长条件视为满足）；`job.reviewers` 里的 id 照旧受保护；升级前被替换的执行者靠 label 识别（§9.1）；已有的 job 没有 `cycle` 与 `launchModel`，从 1 开始计、用项目的模型。
- 64 MiB 的字节轮换比今天的 200 MB 早；不读不发的 200 MiB 不变。

### 15.3 与评审级别（AUTOMATION-SPEC §5.2，`feat/review-levels`）的配合

§5.2 在另一个分支上并行完成、尚未合并。顺序：**先合并 §5.2，再把本分支 rebase 上去**，两边的测试都要跑。

| 文件或部位 | §5.2 加的 | 本 spec 加的 | 合并方式 |
| --- | --- | --- | --- |
| `reviewPrompt` | 级别、Deep 视角、风险一段、更早的风险 | 交接检查一段 | 交接检查放在风险一段之后 |
| `reviewInputSchema`（严格） | `risks` | `handoff.gaps` | 都是可选字段，一处校验 |
| job schema 与 `queueIn()` 的照带字段 | `review`、`seat`、`risks`、`risksFrom` | `sessions`、`rotation`、`retired`、`cycle`、`launchModel` 等 | 互不重叠；两边的照带字段并在一处 |
| 评审 session 的选择 | 级别或槽变了就新建；Run again 只沿用 Standard 轮的 | 新周期和 Run again 总是新建；一轮中途轮换沿用 `job.review` 与 `seat` | 本 spec 的规则是 §5.2 的超集；§5.2 的测试仍成立 |
| 链接 handoff 预算 | 风险先扣，再扣证据 | 子卡交接状态行 | 顺序：风险 → 交接状态 → 证据 |
| 唤醒消息 | 风险一行 | 交接状态一行 | 并列 |
| 活动文字 | 评审开始写级别与原因 | 不改评审文字 | — |

§5.2.6 的“Standard 活动文字不变”仍成立；评审说明的文字断言会因交接检查一段而更新。实现者清单只由本 spec 改动（第 5 条），评审者清单的第 3 条（§5.2 改过）不动。

### 15.4 随实现修改的 spec

- AGENTS.md：§1.1 的例外一行。
- AUTOMATION-SPEC：§3（新字段）、§4.1（Run again 不再沿用 session、`fresh` 文字）、§4.3（接管不含被换下的 session）、§4.4（轮换阶段的对账）、§4.5（经 `beginRotation`）、§4.6（缩为指向本 spec，阈值 64 / 128 / 200 / 300 MiB）、§5（新周期新评审者、交接检查）、§6、§7、§8。
- CARD-COMMENTS-SPEC §1–§3：daemon 路由、`deliver` 选项、评论状态。
- PROJECT-FOLDER-SPEC：恢复时放回 `removed/` 里的交接备份（§5.1）。
- WORKPAD-SPEC §1：“不做 Notes 段（progress note 已覆盖）”的决定被交接记录取代（2026-10-24 用户决定；证据：每卡 100 条事件、agent 只看 20 条、C5b.2 已到上限、C5b.3 最后 23 分钟无记录）。workpad 本身不变。
- TURN-CHECKLIST-SPEC §2：第 5 条的新措辞（1,790 字符）。
- SUB-CARDS-SPEC §5：唤醒时的轮换与子卡交接状态行。
- ONBOARDING-SPEC：`card-handoff` 提示。

### 15.5 代码布局

`server/automation.ts` 已 1,521 行，不能再长很多：轮换放进同级文件。新模块：`shared/handoff.ts`、`shared/session-rotation.ts`、`server/handoff-store.ts`、`server/handoff-capture.ts`、`server/provider-usage.ts`、`server/session-history.ts`、`server/automation-rotation.ts`、`server/comment-routing.ts`、`server/live-capture.ts`（§4 的被动捕获与沉默信号）、`client/task-handoff.tsx`。

## 16. 故障模式

| # | 故障 | 处理 | 仍会丢的 |
| --- | --- | --- | --- |
| 1 | 一个回合里长了 466 MB | 检查点提醒、128 MiB 便签、可选的 steer、卫生规则；下一个边界 R0 / R1 | 用户不开 steer 时，单回合仍可能超过 500 MB |
| 2 | 崩溃时记录过期（沉默 23 分钟，没有 Flowly 调用） | 被动捕获（实时叙述、HEAD 便签、后台清单、人的话）；沉默信号；Flowly 的 incident 便签；`unknown` 后台条目必须处置；lastWords、骨架、锚点；Run again 时人的说明 | agent 没说出来的意图、工具输出、尚未读取或无法解析的部分；通常是一轮轮询的延迟，积压或故障时没有固定上限 |
| 3 | 收尾回合不结束或做了工作 | 从不打断；20 分钟便签；交接之外的写入 `FINALIZING`；工作区变化记便签；Flowly 不并行派发 | 宿主迟到消息或后台任务仍可能与当前回合重叠 |
| 4 | 封存与创建之间重启 | `rotation.phase` 加以 `rotation.id` 为键的台账；`carry` 保住指令 | — |
| 5 | 创建结果未知 | 今天的 `unconfirmedStart` 与 `needs_human`；不盲发 | — |
| 6 | 软触发的创建明确失败 | 回滚到旧 session（§6.4） | — |
| 7 | 人、等待者、别的 agent 或队列唤醒被换下的 session | 不算接管；暂扣；捕获并记录（含它的回复与文件变化，§9.3）；队列改投；`RETIRED_SESSION`；Continue in this session | 当前 session 正在回合中时，人自己的操作会让两个 session 同时运行 |
| 8 | 一个 workspace 两个 session | occupancy 与对方忙检查包含被换下的 session；封存和创建前都重新取快照 | 无法原子阻止宿主在快照后直接启动旧 session；工具守卫加提示只能减轻风险 |
| 9 | 接班者重做已完成的工作或重复死路 | `done` 与 `ruledOut`（带理由）；确认要求逐项处置；输入状态；已读播种 | — |
| 10 | 过时的说法被当成事实 | 相对时间；`ACK_MISMATCH`；workpad 的 sha 新鲜度；“card data: verify” | — |
| 11 | 修改要求被路由给只读回答 | `quick` 只在人选时运行；夹着要求（`contains_request`）、答不上或失败就发给 agent，输入保持 open；答过的评论连答案一起给工作 session | — |
| 12 | 人的话超出 20 条评论窗口，或打在 session 里 | 单独保存 ≤ 200 条原文与状态，更早的进 `archive.jsonl`；全是 open 时也移入并计数、记 gap | — |
| 13 | 更早的评审轮次丢失 | `reviews` 30 轮、每条发现有状态；结论事件单独保留 10 条 | — |
| 14 | 轮换抖动 | §3.5 | — |
| 15 | 记录膨胀、读不全 | agent 各段 16k 上限；视图写明省略并指向 `handoff:"full"`；墓碑而不是重写 | — |
| 16 | agent 覆盖或删除条目 | 补丁操作、墓碑、封存快照；agent 不能删人写的条目 | — |
| 17 | 交接文件损坏 | 保留文件；`HANDOFF_UNAVAILABLE`；计划内轮换暂缓，强制轮换用独立恢复记录，关键要求不明则等待人；从不重置 | 损坏之后到修复之前的写入 |
| 18 | provider 升级让解析器失效 | 返回 `unknown` → `lastUsage` → 保存的测量 → 代理规则；B 仍守着 | 只是精度 |
| 19 | 读历史时加载了巨大的 session | 从不经 Paseo；流式读取跳过长行；≥ 200 MiB 不发 | — |
| 20 | 接班者去 grep provider 文件 | skill 与连续性说明禁止；`flowly_session_history` 是唯一途径 | 模型不遵守时（无法强制） |
| 21 | 密钥或私人内容被复制 | 脱敏；0600；人的话不进链接 handoff 和子卡说明 | 脱敏规则认不出的密钥格式 |
| 22 | 评审者过度挑交接的毛病 | 五个固定探针；≤ 5 条；gaps 不单独阻止 | — |
| 23 | 评论作首条消息丢了自动化标志 | system prompt 的自动化标记与 skill 的识别 | — |
| 24 | 1M 窗口的成本 | 250k / 300k 的绝对上限 | — |
| 25 | 已有的过大 session 让 daemon 重启后崩溃循环 | Flowly 管不到（`before("agent.session_open")` 抛错否决加载未经测试，§19） | 主机可用性 |
| 26 | 回合中途压缩，agent 忘了坑和人的指示 | 重置已读，下一次 `get_task` 重给完整视图；存根总带 open 输入、standing 与 pitfalls 的首行；skill 一行 | 压缩之后、下一次 `get_task` 之前的动作 |
| 27 | 评论到达时 job 在 `reviewing`、`needs_human`、`waiting` 等状态 | 按状态的转移（§10.1）；保持时与人打字相同；不覆盖另一角色的指令；待办随下一条指令 | — |
| 28 | 回合中途插件重载或 daemon 重启，丢了回合结束钩子 | 偏移持久化的被动捕获接着读；`capturedThrough` 与封存前补读；Codex 的 `item_completed UserMessage` 与 Claude（SDK）回合中途的 `queued_command` 附件按文字去重后照各自规则处理（§5.7） | 没有被动捕获的 provider 上，未加载的大 session 的那一回合（记 gap） |
| 29 | 噪声缺口淹没真实缺口（2026-10-25 接手实测：30 分钟 112 条 open，接班者读 174 条、确认 89 个 id） | 脚本与工作流只计数、有证据才记后台（§5.7）；缺口按 session、kind、typeHint 分组计数，确认一次覆盖全部出现；元数据跳过；压缩是便签。第二轮（信息损失评审）：通知保留结果状态并写便签、没对上启动的通知也写；CLI 与插件行宣布的后台入清单；结构化的 detached 规则；之后的完成条目与 ACK 能关闭脚本占位，后台容量合并计数而不拒绝捕获；带位置的缺口逐条；timeline 按行身份计数；台账快照与分组缺口的增长不再每次轮询归档（三个真实 rollout 的回放，timeline 为合成：完整读取从 3 页 / 55 项降到 1 页 / 23 项，归档的台账版本从 45 个降到 12 个）。第二轮（两份评审，loss-r2-L1–L4、noise-r2-1–6）：空闲的轮询什么都不写，ACK 不再因 revision 每分钟变化而 `ACK_MISMATCH`；完整读取跳过 Flowly 自己的归档台账快照；async-shell 的八种事件、Claude SDK 的排队附件与宿主元数据、Paseo 0.12 的 `agent_message` 行、Codex 原生子 agent 与 `item_completed` 条目类型都按规则处理，不再成为匿名缺口；通知便签保留 worktrees 与 note、写明是摘录；工具输出的长行是一条计数的缺口。第三轮（loss-r3-L1–L3、noise-r3-1–4）：Codex 子 agent 发给根线程的报告是便签，不透明的任务令牌不进标签；成功完成的 async shell 与 Claude 通知也写便签（输出尾部、输出文件）；Codex 的 AgentMessage 与 `task_complete` 在没有钩子时也是叙述与 lastWords；Paseo 浏览器标签页与 async shell 的取消按下一层的句柄与状态关闭，失败的启动只是便签；Claude 的 isMeta 与压缩摘要记录是元数据，斜杠命令是人的话；压缩也从 ContextCompaction 与跳过的 `compacted` 行计数，不再是长行缺口 | 没有任何证据的后台（见 §5.7 脚本一条的“仍会漏的”与“仍要处置的”）；786d9cd 已写入的逐条缺口；已归档的旧台账快照的正文留在 `entries/` 与 archive 里（第二轮起完整读取跳过它们：实测卡片 101 页 / 596 项 → 7 页 / 307 项；仍安装着的 786d9cd 被替换前每小时还加约 35 个，此前的估计“59 个版本、约 11 页”低估了约 8 倍）；被取代版本的正文仍写入 `entries/`（不读，只占磁盘，计入 32 MiB 警告）；容量合并后的条目只剩计数与便签里的列表，之后对它们的完成证据不再逐个关闭 |

| 30 | 空闲的卡 revision 不停地变，准备好的 ACK 被 `ACK_MISMATCH` 拒绝（第四轮） | 没有语义变化的事务什么都不写（§5.1）；Git 只为回合中的 session 轮询，失败也等 2 分钟；捕获没写时不同步索引；`server/handoff-idle.test.ts` 跑整个空闲循环。第五轮：ACK 的写入与 Flowly 为它读到的 HEAD 同一个 revision；只有轮询看到的回合结束也读一次 Git；整次读取失败标在快照上，这样的卡每 2 分钟重读 | 回合中的 session 仍每 2 分钟记下共享仓库里别人的改动（那是它工作区真实的变化）；空闲的卡在下一个回合结束、轮换或交接写入之前看不到别人的改动（ACK 自己读 HEAD，并在同一个 revision 里记下）；连回合也没被轮询看到、钩子又丢了的短回合，最后的提交要等下一次 |
| 31 | 轮询碰到正在运行的调用（脚本、`exec_command`、正在打开的标签页） | 在途占位：仍在卡上与封存里、仍要在 ACK 里处置；不归档台账版本、不是交付门的新要求、不算覆盖缺口、不计入看板索引；没有证据的结果删掉它，带句柄的结果让它成为真正的条目（§5.7）。第五轮：只在 session 回合中成立，空闲、不在或封存后是普通占位（计数、进指纹、是历史）；不参与容量合并，只占真实条目剩下的空位 | 69422d8 写下的、不带 `inFlight` 的占位照旧关闭并留在 `background`；真实条目占满 40 条时在途调用只在覆盖说明里计数，session 停下时才逐个列出 |
| 32 | Claude 的任务通知在回合中途被吸收（只有 `queue-operation` 记录），或只在 Paseo 的 `task_notification` 行里 | 照送达的通知读：条目以状态关闭，失败写 hazard 便签（摘要、输出文件），副本只记一次（§5.7）。第五轮：Monitor 的事件（有 task id 与 `<event>`、没有 `<status>`）是进度，在所有路径上都不关闭、不记。第六轮：Monitor 的启动按它自己的 task id 成为打开的条目，事件把最近一个记在条目上，结束的便签保留最后的事件 | 既没有原文、也没有 task id 与状态的行只是一条缺口；更早的 Monitor 事件只在原始历史里，卡上只有最近一个 |
| 33 | 接班者在自己正在跑的回合里读卡和 ACK，每次轮询都看到它自己的新调用（第六轮） | 观察状态原地写入，不换页游标、ACK 与条目冲突钉住的 revision；在途调用不是 ACK 的要求（§5.1、§7.5） | 只有观察状态变了时同一 session 再读得到 `unchanged` 的存根（due 仍说 Git 变了）；被动捕获的条目正文仍在每次原地写入时写进 `entries/`（不读，只占磁盘） |
| 34 | 很多回合的 session：每次回合结束都归档整份台账条目，完整读取每 3–4 个回合多一页（第六轮） | 每个结束的回合只归档一次，归档的台账版本只是历史（§5.1） | 窗口里的回合在当前条目与最近一个归档版本里各一份；以前已归档的整份版本留在归档里 |
| 35 | 同一条任务通知的原文与 Paseo 只带 metadata 的 `task_notification` 行在同一次观察里读到，或行先到（第七轮） | 重建的便签标 `metadataOnly` 并写明是重建的；从不替换原文写的便签，原文之后替换它，已归档的也是；其它副本不是冲突（§5.7） | 两份都没有原文时，便签只有状态、摘要与输出文件 |
| 36 | 用 TaskStop 停掉的 Monitor 或后台命令永远是 open 工作（第七轮） | 说停掉了的结果以 `stopped` 关闭目标，provider 与 timeline 行都是；失败或没说停掉的不改（§5.7） | 经 Paseo 的 UI 停掉的任务在转录里没有标记，仍要在 ACK 里处置；`KillShell` / `KillBash` 的结果形状取自旧版本，本机转录里没有 |
| 37 | 接班者自己回合里超过 256 KiB 的工具输出挪走 revision、重开它刚处置过的缺口（第七轮） | open 缺口的增长原地写入；session 自己的长输出回合中只计数，回合结束或封存时成为缺口（§5.1、§5.7） | 回合结束时那条缺口仍是一个要处置的 id（接班者自己的输出也是）；输出被跳过的脚本在回合结束时仍是一个 “script running” 占位 |
| 38 | `write_stdin` 轮询改写条目的 callId；开了又关的 yielded 命令每个归档两个整版台账并留在 `background`（第七轮） | 轮询不改条目身份；回合中启动的 exec session 是观察状态，同一回合里结束就去掉，回合结束或封存时还在跑才成为历史（§5.1、§5.7） | 同一回合里结束的 exec session 的退出码不在卡上（回合的叙述与原始历史里有）；记住的已结束 session 超过 128 个以后，timeline 重放的更早的启动可能再出现一次（同一次重放里它的结束行随后关闭它） |
| 39 | P2：回合中每次轮询把活动时长的证明（`turnStart.observedAt`）改成当前时间写下，安静的回合也每分钟写一次（移植第四轮之前还每次一个 revision，ACK 失败） | 证明第一次看到回合时写下，之后留在内存，有新 provider 数据时随游标写；回合结束时取存下的与内存里较晚的那个（§21.1、§21.6） | 回合中插件重载时，上一次写入之后的安静区间要等下一次轮询看到回合还在跑才重新算进去；重载之后回合在被轮询之前就结束，那一段不算（只会少算，R3 的未知上下文代理线至多晚到） |
| 40 | P2：接班者读了 revision R 之后，open 的分组缺口原地多计了几次（人的第九条以后的长消息、未知的记录类型），R 的 ACK 按实时计数把它们一起结算，之后再也不会重新打开 | 原地写入记下 R 时的计数（`countAtRevision`）；R 的确认只结算这么多，其余让缺口保持 open、列进 `ackMissing`（§5.7、§7.5，§21.7） | 在 R 之内、确认之前原地计入而接班者其实已经读到的出现，也要再确认一次（看不出它读到的是哪一次的计数） |
| 41 | P2：回合结束钩子到的时候 Paseo 已经开始了下一个回合，结束的回合被记成下一个回合的开始、长度为 0，下一个回合的钩子被当成重复 | 钩子先结束它自己的回合（点名的 `turnId`，或快照不显示在跑的最早存下的回合），之后才采用在跑的回合；轮询先看到下一个回合时上一个存为 `priorTurn`（§21.1，§21.7） | 观察已看到空闲、钩子之后才到，而下一个回合在钩子之前被轮询看到时，那个回合的开始仍然丢了（同以前）；重载之后同样 |
| 42 | P2：被封存的 session 之后被唤醒的回合里碰到在跑的调用，立刻成为要 ACK 的 id、换 revision、归档台账版本，返回时再换一次、留下 closed 条目 | 回合是否结束只看 session 的状态，封存时在途的调用由封存结算（§5.7，§21.7） | 被封存的 session 的回合里启动、回合结束时仍在跑的东西，那时才成为接班者要处置的 id（换一次 revision） |
| 43 | P2：重叠的 code-mode 脚本：完成条目都记给最新的脚本，旧脚本得到假的 “completion not observed”，或 yielded cell 的完成条目藏掉新脚本仍在跑的命令 | 同时在跑的脚本与 yielded cell 组成池，完成条目记给池；占位按已返回成员的缺额，先算给仍在跑的 cell 与没读到结果就离开的成员，撤回不再需要的观察状态占位，已成为历史的等最后一个成员返回时按确切数目关闭（§5.7，§21.7，§21.8） | 池里有成员还没返回时，已返回成员留下的东西要等它返回才出现（普通脚本在同一回合里返回；一直不返回的脚本自己是在途占位）；活过回合的池里不再需要的历史占位要等最后一个成员返回才关闭（cell 一直没人等就一直 open）；被 terminate 或没读到的成员先占的完成条目可能其实是旁边脚本的，那时多一个占位；循环里一个调用处执行多次仍按调用处计 |
| 44 | P2：classifier helper 的硬删除一直失败时，每 30 秒的检查都开一次本地 daemon 连接、归档一次、记一行错误 | 只归档成功的 helper 按 1 分钟起、翻倍到 1 小时的间隔重试，安静重试，失败只记一次；30 秒的所有权检查照旧（AUTOMATION-SPEC，§21.7） | 退避只在内存里：每次插件启动的第一遍仍试一次 |

## 16.1 信息损失分析：今天只在 session 里的信息

| 信息 | 怎样保留 | 明知会丢的 |
| --- | --- | --- |
| 决定及理由 | `decisions`（理由必填），检查点与回合结束前写；计划内轮换时热 session 收尾；评审者的交接检查；兜底：骨架里的 agent 消息可检索 | 从没写下也没说出的细微考虑；Codex 加密的推理与压缩摘要 |
| 试过的死路 | `ruledOut`（理由必填）、收尾说明；Flowly 的体积构成写成 hazard 便签；骨架保留 ≤ 300 字符的错误 | 只在工具输出里的细节（工具输出有意不留） |
| 当前步骤、在跑的进程与锁 | `state`、`running`（agent 写，检查点提醒只在它调用 Flowly 时送达）；Flowly 的被动捕获：实时叙述、HEAD / 未提交文件的 checkpoint 便签、启动时就入清单的后台（目标每 60 秒，不需要 agent 配合）；没收尾时的 lastWords（标为未核实） | agent 记录的部分：从它最后一次 Flowly 调用起，**没有时间上限**（C5b.3 的回合跑了 38 和 50 分钟）。Flowly 旁观的部分：没说出口的意图、工具输出、尚未读取或无法解析的部分（轮询正常且无积压时约一轮延迟，不能承诺 ≤ 60 秒）；没有被动捕获的 provider（opencode、ACP、pi）只有回合结束时的捕获 |
| 人打进 session 的话（真实卡片上 22 次，评论 4 次） | 原文全文捕获（脱敏），回合中与回合结束时，带状态；standing 的长期指示必须完整可取，超预算时沿引用读取；崩溃中途的回合从被动捕获或骨架补回；Flowly 输入框发的在发送时就记 | 不经 Flowly 管理的 session（工作区里原生开的） |
| agent 问的问题与回答 | `questions`，回答按输入链接；open 的问题要处置；每次 Run again 可写说明 | agent 自己的问题工具里的问答，只在叙述里 |
| 别的 agent 发来的消息、子 agent / schedule / heartbeat 的结果 | `via: agent` 的输入（含 async shell 转来的 message / request，request 始终 open）；通知关闭后台条目，失败、丢失与超时的原因和日志路径写成 hazard 便签，成功完成的写出输出尾部或输出文件；Paseo 子 agent 的最后一条消息与 Codex 原生子 agent 的 FINAL_ANSWER 报告写成便签；被换下的 session 收到时唤醒当前 session | 只有加密正文的 Codex 子 agent 消息；头部读不懂的报告只是一条缺口（原文在原始历史里） |
| 图片 | 开工图片在删除前复制，接班者拿到路径；Flowly 输入框的图片保留；`[Image: source: …]` 占位指向的本机文件复制 | 没有占位、只在 provider 里的图片（`user_message` 不带图片） |
| 评论与哪些已处理 | 每条成为输入（原文，不受 50 / 20 名额影响），状态由 agent、人或只读回答设；已读按安全时间播种；open 的给全文；确认逐条处置 open 的 | — |
| 更早各轮的修改要求、交付说明、风险与缺口 | `reviews` 30 轮全文、每条发现有状态、每轮的交付说明；评审者的视图给本周期全文；被换下评审者没提交的发现进接替者的说明；结论事件单独保留 10 条 | — |
| job 状态 | `get_task.automation`；接班者首条消息 | — |
| 环境与外部状态（安装、服务、版本） | `env`；人和 Flowly 的带时间便签；`git` 由 Flowly 读 | 没人写下的 |
| 旧 session 的后台任务 | 工具调用自动入台账；收尾时要求停掉或列出；被唤醒时捕获通知并告诉当前 session；确认时逐条处置 | 不能把等待者转给接班者；输出只留 600 字符尾部（全文在 shell 日志里） |
| 外部标识（SHA、分支、PR、fixture 账本） | Flowly 读的 git；PR 作为 output artifact（已有规则）；`where`；锚点索引 | 标签页与 exec session 的 id 只作清单标签 |
| 未提交的修改 | 文件留在磁盘；每个仓库的 `git`（文件数、前 50 个、diffstat）与 HEAD 核对 | 半成品的用意，除非记录、叙述或骨架里有 |
| 测量与验证结果 | workpad（带 sha 与过期判断，不变）；`done` 指向证据 | 最后几分钟没记录的数字（接班者重新测） |
| session 自己不知道的危险、session 结束后才有的事实 | Flowly 的 hazard / incident 便签；人的便签（Run again 时提示） | 没有人写的事实 Flowly 无从得知 |
| Plan | 每个 session 的 plan 快照保留，`get_task` 给前任的（标明） | 只在中断回合里存在的 plan（快照在回合结束时取） |
| 旧 session 未用的 next moves | 标签进台账 | 建议本身（接班者的 `next` 取代） |
| 按 session 的门与提醒（交付门、ideas 提醒） | — | 重新开始：最多多一次拒绝或提醒 |
| provider 自己压缩掉的内容 | 60% 时提醒写记录（Codex 在 66–95% 压缩）；`L_tight` 低于观测到的压缩点；压缩后重置已读、重给交接视图；压缩后在其它边界轮换（R2 用峰值） | 单个回合在下一个边界之前就越过压缩点时，压缩前没写进记录的 |
| 热缓存与隐含的工作记忆 | — | 每次轮换都丢；规则只在更便宜或更安全时轮换（§16.2） |
| 记录本身 | 墓碑、封存快照、坏文件保留不重置；删卡先备份到 `removed/`，从项目文件夹恢复时放回 | 换机器恢复时（快照里没有交接，恢复时明示缺口，§19） |

**冷恢复的取舍**（不自动花一次冷重读来写形式化记录；关键缺口仍暂停确认，§19）：冷的 session 通常不收尾（至少要重新付出约 C 的未命中输入，实际缓存写入倍率取决于 provider 与计费方式），接班者拿到叙述、骨架和派生的事实，拿不到旧 session 没写下的理解；未加载的 64–200 MiB session 不收尾（发消息会让 Paseo 整个加载它）；不到 5 分钟、没有交接写入的回合不算过期。

## 16.2 代价

以下是本机样本和工程预算，不是 provider 的统一计费承诺或延迟保证；实现时按实际 provider/billing 记录输入、缓存命中与输出再比较。新 session 的 108k 定向读取来自一个接手案例，不应当作所有任务的固定开销。

- **一次轮换**：C5b.3 的新 session 定向读取约 108k；原 session 的 330k 若仍大量命中缓存，开头可能更便宜。是否会在 3–5 个请求后回本取决于 provider 的读写倍率、重读范围和后续工作量，不能按所有 provider 都 1.25×/0.1×计算。C < 100k 时不为缓存冷而轮换。
- **收尾回合**：预计多几个请求和 1–3k 输出；只在健康、热且记录落后时运行。常见 1–3 分钟只是待验证的预算；耗时长时明示等待、不创建第二个工作 session。关键缺口不能因为冷重读贵就隐藏。
- **维护记录**：每回合一两次补丁写入，每次约 1–3 KB 历史；对比今天一次“读卡 + 写入”约 220 KB。交付门最多多一次被拒的调用。
- **`get_task`**：首次（及每次压缩后）多 5–10 KB，之后每次 ≤ 1.5 KB。
- **只读回答**（P3，只在人选时）：最便宜的模型，≤ 24,000 字符的输入，用完删除；本机需求为 0。
- **daemon**：回合结束时一次 `refresh()`；60 秒的 `stat` 与一次 `refresh()`（Claude 子代理每 5 分钟最多测一次并重新 stat 文件）；被动捕获每分钟读新增的字节（普通回合每分钟几十 KB，C5b.3 最坏约 12 MB/分钟，长行跳过不缓冲）；每 2 分钟最多一次 git 读取（≤ 8 个仓库，5 秒超时）；文件尾读取最多 16 MiB，只在需要时；骨架按 §5.8 或按需，1.18 GB 约 10–30 秒、约 74 MB 内存，普通 session 几秒。
- **存储**：交接文件通常 20–60 KB/卡，最坏约 1 MB；骨架 ≤ 2 MB/session；图片 ≤ 20 MB/卡；`board.json` 多约 100 字节/卡（索引，只在变化时写）和约 0.5 KB/job，手机的看板读取基本不变。
- **实现**：约 4–6k 行（含测试），分三期；风险集中在轮换阶段和被换下 session 的守卫，新代码放在同级文件（§15.5）。

## 17. 验收

### 17.1 纯函数（`shared/session-rotation.test.ts`、`shared/handoff.test.ts`）

- `rotationDecision` 表：R0–R6 在每类边界上；各模型的 `L_cold` / `L_tight`；C 未知时的代理；紧密边界 2.8 分钟、55% → 保持，72% → 轮换并收尾；提醒或重试在 90% → 保持，在 70 MB → 强制；Codex 唤醒 3 小时、214k（sol）→ R4，90 分钟 → 保持；Opus 1 小时档空闲 70 分钟、200k → R4 轮换，30 分钟 → 保持；Opus 5 分钟档空闲 10 分钟、150k、其它边界 → R4 轮换，同样的数在紧密边界 → 保持；Opus 260k 在其它边界 → R3；210 MB → 强制不收尾；增长（`peakC − C₀`）< 30k → 不软轮换；sol 第一回合结束就到 380k、3 分钟后的修改要求 → 紧密边界 R3 轮换（不再被回合数挡住）；回合中压缩到 50k 之后的其它边界 → R2（用峰值）；只有一个回合、300k、空闲 7 小时 → R4；28 分钟、38 分钟修复回合后评审者的下一轮 → 紧密；人的评论在上一回合后 3 分钟 → 紧密，40 分钟 → 其它；第 5 次软轮换 → 忽略；连续三次 R0 的 ≥ 200 MiB → 第 3 次 `hold`；Claude 子代理 S 只警示，不轮换也不计入 hold；紧密边界上的压缩 → 保持，其它边界 → 轮换；回滚过的指令 → 保持；暂扣期间涨过 200 MiB 的 session 在下一次发送尝试时 → R0；归档的执行者在 `working` → 不轮换（失败），在 `starting` → R0；人的 Run again → 新；父卡的 `action=start` → 按规则。
- 收尾条件：冷、未加载且 ≥ 64 MiB、≥ 200 MiB、中毒、provider 在限额中、记录不过期 → 不收尾；插件重载之后已加载的 session、评论边界、上一回合普通失败 → 照常收尾。
- 过期判定：只有 §5.5 的实质变化算（含 ≥ 5 分钟、没有写入的回合）；agent 在回合结束前写过的不算。
- 交接：上限、按条目合并与冲突、墓碑、视图预算与省略计数、保留预算不被 12k 的 agent 各段挤掉、background 便签折成一行、评审者视图经后续页可取完本周期全文、相对时间与 SHA 漂移、脱敏规则与视图里的标注、存根与 headlines、压缩后 `seen` 被删、全是 open 时的溢出与计数、确认的校验（漏 id、某个仓库 HEAD 不符、非 git 路径不核对、需 note）。
- 输入提取：过滤 Flowly 前缀、async-shell 通知、路由评论的 messageId；`<paseo-system>` 成为 `via: agent`、不标成人的话，通知关闭子 agent 条目；messageId 去重，没有时摘要计数（三句 “yes” 三条）；`received` 与 `open` 的判定（手动卡、人自己的 session、收尾回合、被拒写入的回合、被换下的 session）；问题与回答的链接；`[Image: source: …]` 的图片引用。
- 清单仍 6 条且 < 1,800 字符，skill 逐字一致。

### 17.2 解析器（`server/provider-usage.test.ts`、`server/session-history.test.ts`，合成文件）

- Codex rollout：末尾前 9.3 MB 的 `token_count`、2.3 MB 的长行、`info:null`、带与不带 `latest_token_usage_record` 的 `compacted`；Claude 1M 转录带 `compact_boundary` 与子代理文件，缓存写入档。
- 超过 256 KiB 的行不缓冲跳过，内存峰值有上限；脱敏、锚点、体积构成。
- 被动捕获：从持久化的偏移接着读、每次 ≤ 64 MiB、半行留到下次；取 agent 消息、人的消息、启动后台的调用、压缩记录、`token_count`；模拟插件重载后幂等补读；覆盖不到、超预算或版本变化时返回 gap。
- 噪声与分组（`server/handoff-capture-noise.test.ts`，合成记录，形状取自接手 fixture；`server/handoff-capture-fixture.ts` 生成三个 session 的复制品）：只跑完已完成命令的脚本没有缺口与后台条目、只计数；留下在跑进程的脚本仍然浮现（打印的 session id、detached 字面量、未见完成的嵌套启动与 exec_command），之后的完成条目关闭它；嵌套 McpToolCall 拿到真实句柄；yielded cell 到 `wait` 完成为止；Workflow 与 dynamic workflow 按 task / run id 打开、按通知关闭，被拒绝的不记；插件行里人的目标被原文捕获，元数据跳过，未知 kind 一条分组缺口；`world_state` / `thread_settings_applied` 跳过，100 条相同的未知事件是一条 `count: 100` 的缺口；观察者层的洪水是一条 open 缺口、重放不加计数、增长不改交付门指纹、ack 一次全部覆盖、只有超过确认计数才重新打开；复制品在 786d9cd 上 139 条 open 缺口，现在 0 条，一条压缩便签与每个 session 的脚本计数。
- 信息损失（`server/handoff-capture-loss.test.ts`，第二轮评审的每一条，合成记录）：失败的工作流在关闭条目上留下状态并写出带失败与恢复说明的便签，没对上启动的通知（被中断的 dynamic workflow、Claude 后台 agent 的结果、后台命令）仍在卡上，长结果有界且脱敏；插件转达的 Ultracode 设置是输入；重启 dev server、轮询构建后再起服务的脚本仍浮现新服务；比脚本活得久的 exec_command 被之后的完成条目关闭；ACK `done` 关闭后台条目；41 个没有完成条目的脚本不阻止捕获下一句人的话；轮询时在途的 `wait` 不留占位；`paseo-shell register`（插件行、shell 行、Codex 脚本）与 `paseo-workflow run` 宣布的后台以真实 id 打开，引用的启动不算；detached 规则逐条正例与反例（含搜索命令）；两条被跳过的长输入各有字节范围与 messageId；重启后重建的 timeline 让已确认的缺口为新行重新打开、重放不加；例行轮询不归档台账快照与缺口增长版本；只在 rollout 里的人的话成为输入，timeline 副本无论先后都只链接、不重复，Flowly 发出的话不成为第二条。其中 18 个行为测试在 e183563 上失败；两个 provider 副本去重测试是新捕获的回归保护（e183563 不读 `UserMessage`，无从重复）；detached 规则的 45 个正反例中旧规则错 23 个（漏 19 个守护进程命令、误报 4 个只提到这个词的命令）。审查者的两份探针（22 个）现在全部通过。
- 第二轮（`server/handoff-capture-deliveries.test.ts`、`server/handoff-capture-subagents.test.ts`、`server/handoff-capture-coverage.test.ts`，合成记录，经真实的 HandoffObserver 与 HandoffStore，夹具在 `server/handoff-observer-fixture.ts`）：async-shell 八种事件各在 timeline 与 provider 两条路径上（不留匿名缺口：failed、timed_out、lost 关闭条目并写出第一条错误行与日志路径，still_running 与 sendback 保持条目打开，sendback 的正文、message 与 request 的原文到卡上，request 保持 open），ACK 之后的提醒不重新打开、不改交付门指纹，解析不了的头部仍是缺口；dynamic-workflow 通知的 worktrees 分支与用户的 note 在便签里，其它块写出名字并标为摘录，长通知里摘录标记不被截掉；Paseo 0.12 的 `agent_message` 行把 provider 捕获的 agent 消息标为 received，子 agent 的 finished / errored 通知是便签而不是输入；Claude SDK 的排队附件（任务失败关闭条目并写便签，人的话与回合结束副本链接，信封、async-shell、工作流通知、图片照各自规则），宿主附件与簿记记录不成为缺口，未知的附件子类型仍是缺口，`pr-link` 成为锚点；Codex 子 agent 按 task 名入清单、完成或中断时关闭、失败的 spawn 不留条目、`followup_task` 重新打开（含 ACK 已处置的），已知的条目类型跳过、未知的是分组缺口；空闲的轮询不写任何东西且之前准备的 ACK 成功；工具输出的长行是一条计数的缺口、人的长行逐条、超出的按真实类型计数；完整读取跳过与下一个版本历史相同的归档台账版本并计数。38 个新测试中 35 个在 3fe9409 上失败（另 3 个是守护：finished 通知与解析不了的头部原来就对）；两位评审者的探针（19 个）全部通过。
- 第三轮（`server/handoff-capture-round3.test.ts`，合成记录，形状取自本机 rollout 与 Claude SDK 转录的结构统计，经真实的 HandoffObserver 与 HandoffStore）：子 agent 的 FINAL_ANSWER 报告是便签而条目照常关闭，中断（先或后）时为 hazard，长报告有界、脱敏并写明摘录；加密正文与根线程的指示不留东西，头部读不懂的报告是一条分组缺口；不透明的任务令牌只留 task 名；async shell 的 finished 在 provider 与 timeline 两条路径上写出摘要、输出尾部与日志路径，长输出只留最后 600 字符；对上了启动的 Claude completed 通知写出输出文件；Codex 没有钩子时叙述仍在、封存时成为 lastWords（轮询不改写它），provider 副本、`task_complete` 与钩子副本是同一条叙述，`task_complete` 在 AgentMessage 缺失时补上；标签页打开又关闭不留待办，开着的以 browserId 记一条；取消的 async shell 关闭并记 cancelled；失败的启动只留便签，失败的轮询什么都不留；isMeta 与压缩摘要不成为缺口、ACK 之后不重新打开，斜杠命令是输入；跳过的 `compacted` 行与 ContextCompaction 各计一次、两者一起只计一次（跨轮询也一样），子代理继承的历史不计也不是缺口。23 个测试中 21 个在 0544d45 上失败（另 2 个是守护：Paseo 子 agent 的 finished 便签，以及跨轮询的那一对原来就只计一次）。四个旧测试改了契约：子 agent 的无头报告是缺口而不是元数据；finished 通知与对上了启动的 completed 通知写便签；失败的启动不再留 unknown 条目与 `background_tool_failed` 缺口。三个 rollout 的只读回放（只计数）：缺口仍是 0，压缩记 1 次（不是 2 次），实时叙述从 0 条变为 8 / 6 / 5 条。
- 第四轮（`server/handoff-capture-absorbed.test.ts`、`server/handoff-inflight.test.ts`，合成记录，形状取自本机 40 天的 sdk-cli 转录与 Paseo 的 `providers/claude/task-notification-tool-call.js`，经真实的 HandoffObserver 与 HandoffStore）：回合中途被吸收的后台命令失败（只有 `enqueue` 与 `absorbed_mid_turn` 的 `remove`）关闭条目并写 hazard 便签；只排了队、session 就停了的完成通知也关闭并留下输出文件，之后的 `remove`、`queued_command` 与 timeline 行副本什么都不加；timeline 的 `task_notification` 行带原文或只有 metadata、标签与 error 时都照通知读，两者都没有时是一条缺口；其余 `queue-operation` 记录不留东西，读不懂的排队通知是一条缺口。轮询五次碰到正在运行的脚本：每次一个在途条目，返回后什么都不剩，归档里没有台账版本；一直在跑的脚本跨轮询留在卡上、进入封存，yield 之后成为 `cell:N`；在途的启动调用拿到句柄时成为真正的条目，失败或已退出时只留便签，同类的迟到完成通知不结算它；在途占位不改交付门指纹，不改看板索引。第一个文件的 5 个测试在 8a8ed8b 上失败，第二个文件的 5 个测试中 4 个在 da098e0 上失败、1 个（看板索引）在 ea2f463 上失败；第三轮评审的探针 R3-A1、R3-A2 现在通过。一个旧测试改了契约：尚未返回的启动调用不再计入 `through.gaps`。
- 第五轮（第四轮的复查，合成记录与真实的 HandoffObserver、HandoffStore）：`server/handoff-capture-absorbed.test.ts` 里 Monitor 的事件在 timeline 行（有原文或只有 metadata）、被吸收、送达与经 SDK 排队时都不关闭条目、不写便签、不是缺口或输入，ACK 之后的事件不重新打开任何东西，之后真正的结束通知照常关闭条目并写出结果，读不出 task id 的仍是缺口；`server/handoff-inflight.test.ts` 改用回合中的 session，并加上：封存、回合结束（停掉）或本来就空闲时没有结果的调用计入看板索引、改变交付门指纹、归档一次台账版本，封存后才到的结果关闭它；40 个带句柄的 async shell 在跑时碰到一个在途脚本，不合并、40 个句柄都在、`task-0000` 由它的结束通知关闭，只有这一次结束归档台账版本；45 个在途调用在安静的回合里列出 40 个、计数 5 个，之后的轮询不写。`server/handoff-observer-git.test.ts`：只有轮询看到的回合结束读一次 Git，之后空闲不读、不写，重载后至多再读一次，迟到的钩子仍从观察到的开始记回合；缺口关闭后 Git 再次读不到时快照带 unobserved 错误、卡片 due，重复的失败不写；空闲卡上次读取失败时 2 分钟内重读，成功后不再读。`server/handoff-ack-git.test.ts`：共享根里别的卡提交、卡空闲 10 分钟后，接班者按刚读到的 revision 经 `HandoffService.update` 带真实 HEAD 的 ACK 成功，Flowly 的刷新与 ACK 同一个 revision；被拒的 ACK 仍记下 HEAD，按重读的 revision 再发成功。这些测试（含改了的空闲循环与封存测试）有 11 个在 687171c 上失败，只有被拒的 ACK 这个守护原来就对；评审探针 R4-N1a–c、R4-N2、R4-N2b、R4-N3、R4-N4、R4-N5、R4-C1 与 S5 通过（R4-N1d 的中间一步断言的是本轮去掉的那条缺口，它的最后一步成立）。
- 第六轮（第五轮的复查，合成记录，形状取自本机转录里的 Monitor 与 Paseo 的 `providers/claude/tool-call-detail-parser.js`，经真实的 HandoffObserver 与 HandoffStore）：`server/handoff-capture-absorbed.test.ts` 的 Monitor 测试改用真实形状（Monitor 自己的 task id，不再挂在后台 Bash 上）：启动是打开的条目，事件（被吸收、送达、经 SDK 排队、timeline 行有原文或只有 metadata）把最近一个记在条目上、原地写入不换 revision、不写便签，ACK 之后的事件不关闭它，结束通知关闭它并在便签里保留最后的事件，之后的事件不重新打开；回合中封存时它在封存的提示里与 ACK 名单里；失败的启动只写便签。`server/handoff-store-observation.test.ts`：只有观察状态的写入保留 revision、写入时间、条目的 rev 与 at，不写回执与归档，在每个落盘切点崩溃后恢复一次；显式 operationId 的原地写入仍认得重放；在途调用与进度事件是观察，结束的占位与真实条目不是；页游标与 ACK 经观察仍有效，新的输入让它们失效；观察把记录挤过 1 MiB 时换 revision。`server/handoff-turns.test.ts`：60 个回合（中间一个服务起停）归档不超过 8 个台账版本，每个回合在完整读取里都在、至多两份，离开窗口的回合的 final 文字只出现一次，读取比开始时至多多 3 页。
- 第七轮（第六轮的复查，合成记录，形状取自本机转录与 Paseo 的 `toTaskNotificationToolCall`，经真实的 HandoffObserver 与 HandoffStore）：`server/handoff-capture-notices.test.ts`：Monitor 结束与工作流失败的原文和只有 metadata 的行在同一次回合结束的观察里读到，便签保留 Error、Failures 与 Last event；行先到时重建的便签写明是重建的，之后读到的原文原地升级它（新 revision，之后再到的行不改）；便签已归档时原文照样升级它，重建或换了时间的副本不是冲突，agent 的便签重用来源 id 仍是冲突。`server/handoff-capture-stop.test.ts`：之前回合留下的 Monitor 与后台 Bash 经 TaskStop 以 stopped 关闭、不在封存的待办里；同一回合里启动又停掉的不留条目、封存提示里没有；失败的停止与没说停掉的结果不改目标；Paseo 的 TaskStop 行与旧版本的 KillShell 同样关闭。
- **一个桩断言没有发生任何 Paseo timeline、refresh-history、发送或恢复调用。**

### 17.3 服务（假 SDK，`server/automation-rotation*.test.ts`、`server/comment-routing.test.ts`、`server/handoff-*.test.ts`）

- **空闲循环**（`server/handoff-idle.test.ts`，第四轮）：生产接线（HandoffService 的互斥与 `syncIndex`、观察者的 60 秒轮询、自动化的 15 秒调度及其交接桥），真实文件与真实 Git 仓库；三张空闲卡、六个 session（Codex 与 Claude，含被换下的、工作区读不到的、仓库超过检查上限的、已不存在的），先做最后一个回合（`ensureSession` 与回合结束钩子）和 5 分钟预热，再跑 30 分钟假时间：每分钟一次轮询、四次调度，每 2 分钟 `ensureSession`、`syncIndex`、`handoffDue` 与抽屉读取，第 15 分钟插件重载，期间别的卡在共享仓库里提交、再改一个已改过的文件。所有交接文件与 `board.json` 的字节、每张卡的 revision 不变，没有一次调度或观察报错，每个有 provider 文件的 session 都真的被读到（第五轮补上的断言），之前准备的 ACK 经 `HandoffService.update` 带真实 HEAD 成功并记下共享仓库的变化，下一个回合结束补上之后的变化。一个安静的长回合（provider 文件不增长、工作区读不到、它的缺口已被挤进归档）12 分钟也什么都不写；存储层的契约测试（同一来源再捕获、再确认、没有新内容的捕获与更新）不写回执、不动 revision。三个测试都在 69422d8 上失败；拿掉存储层的规则时后两个失败，拿掉 Git 的回合限制时空闲循环失败。
- **接班者自己的回合**（`server/handoff-running-read.test.ts`，第六轮）：同样的生产接线，真实 Git 仓库与合成的 Codex rollout；被封存的前任留下多页的记录与两个缺口，接班者在回合中每分钟读一页，每页之间它自己的 rollout 多一次 Git 检查、一个没返回的调用（在途），共享仓库里别的卡提交一次，观察者照常轮询：每一页都不 `viewChanged`，读完整，观察确实写下了（游标前进、在途调用与新 HEAD 在卡上）而 revision 不变；再一次检查与轮询之后，经 `HandoffService.update`、带真实 HEAD 的 ACK 应用且完整（在途调用不在名单里）。读到一半时人的一条评论到达：下一页 `viewChanged`，按旧 revision 的 ACK 被 `ACK_MISMATCH` 拒绝，从第一页重读（中间照样轮询）后读完、名单里有那条输入，ACK 成功。部分确认之后它自己的 session 又被观察一次，续写仍补全确认。三个测试都在 c4aea18 上失败。
- **接班者自己的输出与命令**（`server/handoff-running-output.test.ts`，第七轮，同样的生产接线，夹具在 `server/handoff-running-fixture.ts`）：每页之间它自己的 300 KB 测试输出（`function_call_output`、code mode 的 `CommandExecution` 与 `custom_tool_call_output`），ACK 之前一次 `git log -p`：每页同一个 revision、读完整、ACK 通过，回合中只在覆盖说明里计数，回合结束时每种是一条计数的 open 缺口；处置过的缺口在下一个回合里不被它自己的输出重新打开，那个回合结束时重开一次；封存时还在计数的输出写进封存的记录；30 个各用 `write_stdin` 等两次的 yielded 命令贯穿整读与 ACK：没有新 revision、没有归档的台账版本、不留 closed 条目，回合中启动、还在跑的 dev server 立刻在卡上而不是 ACK 的 id，回合结束后才是；之前回合留下的 server 被轮询时保留启动调用、不写 revision，结束时是历史；最后一次输出太长读不了的命令照常结束；回合结束的 timeline 重放启动与之后迟到的进度都不会把同一回合里结束的 Monitor 带回来。`server/handoff-store-observation.test.ts` 加上：open 分组缺口的增长原地写入，新缺口、关闭与重新打开各换一个 revision。
- **安静的回合**（`server/handoff-running-quiet.test.ts`，P2，§21.6；同样的生产接线加自动化调度的 15 秒调度与它每分钟对回合中执行者的监视）：接班者在回合中读完记录、准备好 ACK，之后 15 分钟它的 rollout 不增长：数据目录里每个字节（交接记录、归档、回执、`board.json`）与 revision 都不变，调度没报错且确实测量过这个 session，之前准备的 ACK 经 `HandoffService.update` 带真实 HEAD 应用且完整；回合结束（一次轮询看到空闲，再到钩子）后活动时长正好到最后一次看到它在跑的轮询。在 f66d394（移植后、修复前）上字节不同；在 b7a1da1（移植前）上 15 次安静的轮询把 revision 从 15 推到 30，ACK 被拒。`server/handoff-observer.test.ts` 另有两条：安静的轮询不改文件、新 provider 数据带上证明、插件重载后迟到的钩子按存下的证明算（10 分钟，而不是内存里丢掉的 20 分钟或钩子的 25 分钟）；不重载时算到最后一次在跑的轮询，不算到迟到 39 分钟的钩子。
- **P2 复查第一轮**（§21.7）：`server/handoff-store-observation.test.ts` 与 `server/handoff-observer.test.ts`：读了 revision R 之后分组缺口原地增长（人的第十条长消息、未知记录类型），R 的 ACK 与显式关闭只结算 R 时的计数，缺口保持 open、在 `ackMissing` 里，下一次确认关闭它；`server/handoff-observer.test.ts`：钩子的快照已显示下一个回合、轮询先看到下一个回合（有与没有 `turnId`），两个回合各自的开始、活动时长、五分钟 hazard 与最后的话都对，点名一个没轮询到的回合的钩子不拿钩子丢了的更早回合的开始；`server/handoff-inflight.test.ts`：被封存 session 的迟到回合里碰到的脚本不换 revision、不进 ACK 名单、不归档，回合结束时仍没结果的才成为占位；`server/handoff-script-pool.test.ts`：两个重叠脚本、yielded cell 加较新的脚本、全部对上之后撤回的占位，以及接班者回合里一次启动的 20 个脚本（生产接线、整读之后）：没有剩余占位、revision 与归档台账版本不变；`server/classifier-helpers.test.ts`：硬删除一直失败时一小时的 30 秒检查只连 6 次、记 1 行错误。
- **P2 复查第二轮**（§21.8）：`server/handoff-script-pool.test.ts`：yielded cell 被 terminate 之后旁边脚本的 dev server 占位仍 open、回合结束后是 ACK id（cell 在前或在后两种顺序），被 terminate 的 cell 的 `spawn_agent` 同样先占它收到的启动；池活过回合时第二个回合的计数先降后升（中间有与没有轮询，cell 没人等或在第二个回合结束），以及同样的记录在回合结束之后一个批次读到，历史占位一直 open、仍在 ACK 名单里；不再需要的历史占位在最后一个成员返回时关闭。
- **C5b.3 回放**：字节在回合中越过 128 MiB → 下一个工具结果带 `handoffDue`；一个只跑 shell、23 分钟没有 Flowly 调用的回合 → 实时叙述、HEAD 便签、后台条目都在记录里，20 分钟时 `silentSince`；回合崩溃 → 后台条目 `unknown`、incident 便签、接班者必须处置；steer 只在开启时、每个 session 一次；下一条指令 → 强制轮换不收尾；接班者的 system prompt 有标记与连续性说明；首条消息有原因、要做的事、定向步骤与待办 id；incident 便签有体积构成。
- 收尾 → 封存 → 创建 → 确认，待发的修改要求原子带过去；收尾失败、超时、长时间收尾（不出现第二个 session）、收尾回合里的交付被 `FINALIZING` 拒绝而 workpad 验证与 artifact 通过；收尾回合里人打的话是 `open`；收尾回合的回合结束丢了（重启）→ 对账封存而不是提醒或 `needs_human`；收尾回合以限额结束 → 接班者在备用模型上；第 11 分钟才开始的收尾回合的写入被接受；在每个阶段模拟重启都只得到一个、同一个 agentId 的接班者。
- 回滚：软触发的创建明确失败到预算用完 → 旧 session 收到**同一个 id** 的延后指令且不再轮换；台账、`ackDue`、`sessions` 还原；未知结果 → `needs_human`，不回滚。`creating` 时创建遇到限额 → 同一次轮换换模型，没有为未建成的 agent 写台账。
- 强制轮换（备用模型、中毒、过大）不收尾、`nudges` / `failures` / `cooldowns` 清零、首条消息是继续说明而不是 “attempt 2 of 2”；Run again 在 `session_unavailable` 之后用继续说明而不是从头开始；过期恢复不发裸 `startPrompt`；轮换与 Run again 的接班者用开工时选的模型；`queueIn` 照带 `retired`、`cycle`、`launchModel` 与被保留执行者的 `sessions`；没收尾就封存而记录落后 → 首条消息有叙述。
- 被换下的 session：后台通知的回合不算 `taken_over`、不触发 A1、暂扣发送、关闭 `running`、加便签、告诉当前 session；人的话的回合捕获原文、`delivered` 时只记录并提供 Send；写入 `RETIRED_SESSION`、`kind=progress` 通过、`get_task` `writable:false`；只靠 label 识别的被换下 session 同样处理；队列在提交和 `drainAll` 时改投；25 个被换下的评审者全部保留 `REVIEWER_ONLY` 与接管豁免；人自己开的 session 仍按接管处理；`delivered` 的 job 上人在被换下 session 里要求改东西 → Continue in this session 关闭 job、解除守卫；被换下 session 的回合留下 `retired_turn` 便签并唤醒当前 session；`retiredTurn` 在钩子丢失后由快照清除。
- 评论，每个 job 状态各一组（`working`、`reviewing`、`needs_human` 含提问后、`waiting`、`retry_wait`、`unconfirmed`、评审中途重开、`delivered`）× 保持 / 轮换：热 → 与人打字相同的直接发送；冷且大 → 新 session 首条就是原文、system prompt 有标记、状态转移同 `turnStarted`；评审者在跑时设的执行者指令不被它的回合结束删掉；槽里是评审者暂扣的指令时不覆盖、待办在评审轮之后送达；暂扣的修改要求发给原 session 时附上待办评论；轮换期间 → 待办，出现在首条消息，不发给旧 session、不发两次；`save` 不唤醒；`quick` → 不受管理的子 session、用完删除、`comment_answered`、job 和泳道不变、`contains_request` 与答不上都发给 agent，答过的评论带答案。
- 已读播种：完成回合里处理过的评论不重做；只在崩溃回合里读过的评论对接班者未读；`open` 的评论给全文。
- 评审者：新周期新评审者、`cycle` 加一，重启或事件裁剪后发现 id 不重号；一轮中途轮换保留轮次、`job.review`、`seat`、`panel` 与标题，绑定 `reviewDelivery`，带上被换下评审者没提交的发现；第 3 轮的评审者看得到前两轮的全文与交付说明；旧评审者 `NOT_REVIEWER`；评审者不收到 `handoffDue`；`handoff.gaps` 与 `changes` / `approve`。
- 父卡与子卡：唤醒时轮换的父卡拿到子卡的交接状态行、hazard 便签与 pitfalls 且在预算内；子卡拿到父卡的 pitfalls；人的原话不跨卡；被换下的父卡不能接受子卡；父卡在记录过期时建子卡得到 `handoffDue`。
- 多仓库与非 git 的工作区：每个仓库的 git 与 HEAD 核对，根不是 git 仓库时确认不被拒。
- 从项目文件夹恢复后交接回来。
- 开工图片在删除前复制、接班者的首条消息给出路径而不重新附上；`handoffIndex` 在旧 schema 下被丢弃而看板仍可读；带全部新字段的看板能被上一版 `automationJobSchema` 解析；`state` / `code` 与冻结列表比对，没有新值；回执 action 列表不变。
- 单元测试绝不能碰到真实 daemon（open-paseo-plugins/AGENTS.md）：改动 CLI、SDK 或子进程调用后确认桩仍然拦截，跑完用 `paseo project ls` 等检查有没有多出来的资源。

### 17.4 真实 daemon 与 Web UI

按 open-paseo-plugins/AGENTS.md：安装到本机 daemon，app.paseo.sh，fixture 项目 `plugin-test-2026-10-xx`，最便宜的模型，阈值经 `plugin-settings/flowly/rotation.json` 调低；fixture 卡的描述驱动 agent 行为（agent 会拒绝转来的提示）。场景：紧密循环里带收尾的轮换；Run again 默认新 session；冷评论到新 session 的原文首条；轮换期间的评论；Save on the card；被 async shell 唤醒的被换下 session；抽屉 Handoff 区在刷新后仍在；确认与 understanding 显示；被换下的横幅。桌面与窄布局截图存 `docs/verification/session-handoff.md`，记 daemon 版本、插件路径与 commit、fixture id、没验证到的部分；清理后在 Paseo 与 Flowly 里各确认一次。

### 17.5 交接演练（可重复）

固定的 fixture：一张合成卡，带一份封存快照（交接、台账、评审轮次）和一个 git 仓库，标准答案是一份事实清单（HEAD SHA、下一步的 id、每条 pitfall 与 ruled-out 的 id、仍在跑的后台条目、open 的输入与问题的 id）。每次演练从快照开一个最便宜模型的新 session，只给它卡片。判定全部是机械的，不用 LLM 打分（同 §7.5）：(1) 它的 `ack` 是否第一次就完整（每个必须处置的 id 都有处置、每个仓库的 HEAD 正确）；(2) 五个探针（召回、产物、继续、决定、坑）的回答写成结构化字段，按 id 与 SHA 与标准答案做精确匹配，得分 = 匹配的事实数 / 总数；(3) 一个指标：从 session 开始到确认完成的分钟数。跑 5 次，通过线：至少 4 次 (1) 完整，(2) 的平均分 ≥ 0.8，(3) 的中位数 ≤ 5 分钟（C5b.3 #2 读完卡片与交接文档用了约 70 秒）。同一演练、对照有无 `flowly_session_history`，决定它值不值得用。

### 17.6 上线后的指标

按原因统计的每卡轮换数；收尾成功率；首次确认完整率；轮换后第一次提交的用时；重做工作的迹象（重复的 PR URL、重开的发现）；`flowly_session_history` 的使用；每卡 token（取自用量数据）；轮换的 session 与保留的 session 首个请求的缓存命中率（只在本机记录，用来校准 TTL，§19）；Claude 子代理文件合计 S 的分布（512 MiB 仅是观察线，§19）；沉默信号的次数与时长。

## 18. 分期：先交付可靠接手，再扩大自动轮换

本稿覆盖最终行为，不要求一次实现所有字段和十个模块。实现计划先拆成可单独审查、测试和交付的三个里程碑；某个里程碑不宣称已获得后续能力。先合 review-levels，再开始代码工作（§15.3）。

### P1：卡片记录与可靠接手（第一阶段）

只交付核心闭环：
1. 一份紧凑的当前交接记录、增量归档与完整读取路径。内容先有 `state / next / decisions / ruledOut / problems / pitfalls / running / where / env`；人的输入、问题与明确关联的回答；当前周期评审要求、交付说明；每仓库 git 状态；当前与前任的最小 session 元数据。完整的 200 个 session 台账、广泛锚点索引和骨架都不必首期完成。
2. 现有工具与 Flowly 输入框的消息在写入或发送时就落盘；回合结束捕获最后消息、git、可识别后台句柄，并做 Codex / Claude 主转录的有界增量捕获与 coverage gap。不能只等 agent 主动写交接，否则事故中断前的沉默回合仍旧没有记录。其它 provider 明确标仅有回合结束捕获。
3. 把**既有**备用模型切换、200 MiB 轮换，以及人请求的新 session / Run again 接到同一条可恢复的交接路径。健康且记录落后的旧 session 按 §6.2 收尾；异常或不安全时不用它收尾，带缺口接手。携带原指令、所选模型、未决输入和评审要求；未知创建结果不再建第二个。回滚、重启、迟到钩子和旧 session 的工具守卫是本阶段的一部分，不能省成“换个 id”。
4. 新 session 读卡和完整未决内容，核实仓库与后台，做 ack；缺关键指示时提问。卡面/抽屉显示现状、记录年龄、当前/前任、缺口及接手结果；不要求人打开聊天才能知道出了什么问题。首期不启用新的冷评论路由，只保证轮换期间的评论与输入不丢、之后送达。
5. 更新 skill、清单、相关 spec 与全部语言；交接软门、压缩后重给、同卡旧 session 写入限制，以及人为接回旧 session 的明确动作随核心一起交付。

**第一阶段通过线**：在假 SDK 上完成正常接手、收尾、崩溃/漏钩子、创建未知、模型保留、未决评论和旧 session 写入场景；用小 fixture 做真实 Web UI 接手演练。验证“下一位拿得到规定信息、会检查并能继续”，不只验证文件存在。详见 §17；P2/P3 独有测试此时记 unrun，不写成已完成。原有 200 MiB 守卫保留；64 MiB、R2–R4、缓存阈值只记影子决策，不自动触发。

### P2：按证据自动选择换人边界

P1 通过并安装验证后再启用：§3 的 64 MiB、上下文和空闲决策（紧密循环例外与防抖）；文件尾测量、骨架与只读检索；评论 `auto / fresh / save` 按 job 状态路由；新评审周期新评审者与交接检查/gaps；父卡、子卡和依赖的交接摘要；按需逐步扩充历史台账、图片引用恢复。

启用更早轮换前要验证被动捕获无积压的普通路径、缺口显示和强制接手，不把 60 秒轮询当成实时保证。Claude 子代理 S 先只观察；是否值得加独立阈值由本机测量决定。旧的 200 MiB 不读不发保护全程保留。不同 provider 的不读不发条件要以实际加载成本验证，不能把 Codex 父线程的风险直接套到所有 provider。

### P3：可选优化

显式 `quick` 只读回答；用户另行同意后的 steer；Codex 子线程字节和只读 SQLite 快路径；其它写入工具的小回执；按真实缓存命中率校准阈值。这些都不是第一阶段可靠交接的前提，不额外自动启动隐藏的评分模型。

### 18.1 不做

- 自动中断、停止或归档旧 session；不在本任务中否决宿主打开历史。
- 每条评论强制新 session，或自动把评论分类为进度提问。
- 批准之后再派收尾回合：会让 A1、重开与批准含义变复杂；缺口在卡片上保留，到下一次明确启动时处理。
- 因泳道移动、限额重试或宿主临时故障本身换 session；R0 的安全与中毒条件仍优先。
- 经 Paseo 加载过大的前任，或让 agent 自己读 provider 文件。
- 接管旧 session 的 exec/PTY、等待者、schedule 或浏览器；只能核实、记录，必要时由接手者建立自己的监测。
- 把整份交接塞进 `board.json`、每次轮询复制一遍全量历史、默认导出人的 session 原文，或自动清理语义记录。
- 用 LLM 给 ack 打分、把未核实叙述当事实，或声称一个长回合不会膨胀和零信息损失。

## 19. 已定默认、额外授权范围与技术核实

用户已经授权 hybrid 与认真设计交接；以下取舍由本设计落实，**不再要求逐条确认**：

| 事项 | 默认与理由 |
| --- | --- |
| Run again / 新评审周期 | Run again 默认新执行者；新周期新评审者，同周期紧密循环尽量复用。按 §18 分步上线；人仍可明确选健康的原 session。 |
| 旧 session 被通知唤醒 | 不自动当作人的接管；限制 Flowly 卡片写入、捕获通知并暂扣下一次派发。人明确点 Continue in this session 才关闭自动化并接回，`delivered` 同样有此动作。不能借此保证文件系统绝无并发。 |
| 记录与隐私范围 | 本卡 Flowly 管理 session 的任务输入原文脱敏后留在本卡，供本卡执行者、评审者和抽屉读取；不抓原生无关 session。人的原话默认不跨卡、不进文件夹快照；父卡通过明确子卡说明传达相关约束，引用来源并保留原始指示在父卡。 |
| 恢复与导出 | 本机 remove/restore 恢复交接备份，包括增量归档与输入正文。默认不把人的话、叙述、便签或完整交接导出进项目目录；跨机器恢复因此存在缺口，必须在恢复 UI 明示。未来可另做显式导出，不在此扩大数据传播范围。 |
| 交付门 / ack | 在开启自动化的项目对受监督执行者生效；手动 session 可用记录但不强加自动化交付协议。 |
| 缓存估计 | 采用本机观测作为估计，不把它说成 provider 保证。Claude 写入档未知、其它 provider 未实测时不只因缓存触发 R4；上下文与字节规则仍工作。不采用固定 1 小时或 30 MB 猜测。 |
| 不收尾的例外 | 冷且记录新的 session 不为形式多跑一回合；冷而记录落后时带叙述与缺口接手，不能称其完整。未加载的大 session 或中毒/限额 session 不冒险恢复。关键内容无法确认则暂停问人，不为了省钱越过。 |
| 首期范围 / 合并顺序 | 先合 review-levels；第一阶段只上线 §18 P1，后续自动决策先观察再启用。SDK 与 provider 文件结构的能力验证由实现者完成，不交给用户做技术选择。 |

**唯一需要额外决定的运行干预**：是否开启 §4 第 5 条的回合内 steer。当前保持关闭，既不发送试验性的 steer，也不自动停止。理由是 Paseo 0.12 的 steer 可能退化为 interrupt，超出了当前“不主动打断”的约束。这不阻塞 P1/P2 的记录、交接和边界轮换。

实现前/启用前由开发者核实（不是用户审批项）：
- `fetch_agent.status` 只能作已加载的候选信号。必须实测同一 daemon 上发送是否会重新读大历史；不能证明时，收尾上限按 64 MiB，不用 200 MiB 的“已加载例外”。
- 解析器与真实 provider 版本、compaction marker、半行/长行、文件滚动、子代理结构；有界读取、缺口与版本降级路径要有测试。SQLite 只能是可撤掉的只读快路径。
- 改标题/label 若 SDK 不支持，只做 Flowly 横幅；图片拿不到就标缺口。不能为了装饰或补缺口去调用未经测试的宿主能力。
- 不测试或启用 `before("agent.session_open")` 抛错来阻止宿主加载；那是 Paseo 主机修复的独立范围。

## 20. 评审意见的处理

### 20.1 第一版（三份方案的评审）

两轮评审选出“零损失”为主体（一轮选“故障优先”、一轮选“从简”），并指出以下缺陷。逐条去向：

| 缺陷 | 处理 |
| --- | --- |
| 交接视图每次 `get_task` 都多 5–10 KB（最多 28 KB） | 每个 session 每个新 revision 只给一次，其余是存根（§5.9） |
| 交接工具用签名请求，新回执 action 让旧版本拒绝 `board.json`、占 5,000 条回执 | session 凭据认证、不记回执，同 `flowly_submit_review`（§5.6） |
| 说 session 图片“timeline 暴露时”能捕获，而 `user_message` 只有文字 | 只捕获 `[Image: source: …]` 占位指向的本机文件，其余明确记为丢失（§5.7） |
| 清单长度算错（1,781） | 实算 1,790（§13） |
| 每条人的话都要逐条确认、闲聊变待办 | 回合正常完成的工作 session 收到的话为 `received`，不要求处置；确认只覆盖 open 项（§5.7、§7.5） |
| 冷 session 也收尾（约 C×1.25）、给 ≤ 200 MB 的 session 发收尾 | 只在记录过期、健康且热、满足可验证加载预算时收尾（§6.2）；64–200 MiB 的例外未经实测不启用 |
| “过期”几乎总成立，收尾在多数轮换上触发 | 过期只认实质变化（§5.5） |
| 收尾 10 分钟后封存，晚开始的收尾回合与接班者并行；收尾回合里的交付语义未定义 | 收尾回合在跑时从不创建接班者；收尾回合里的交付返回 `FINALIZING`（§6.2） |
| 批准后的尾声 | 不做（§18.1） |
| 给被换下 session 应用 A1 而 A1r 随即恢复、重开路径走不到 | 被换下 session 豁免 A1；`delivered` 时由人点 Send 转给当前 session（§9.2、§9.3） |
| 逐条标记已读，而 `artifact-reads.json` 每个 agent 只有一个时间 | 用一个安全的时间播种，逐条的未处理靠输入状态（§7.4） |
| 注册文件与看板事务不原子 | `retired` 在同一个看板事务里写（§9.1） |
| label 刷新放进同步事务 | 事务之前刷新，只在接管路径上（§9.1） |
| 人的话 16 条 FIFO；评审发现截到 300 / 摘要 600 | 200 条原文；`reviews` 与 `reviewInputSchema` 等长（§5.2） |
| 交接快照冻在 system prompt 里，很快与记录分叉 | system prompt 只放连续性说明，不放内容（§7.1） |
| 用游标计数 timeline 条目，重启后重复或遗漏 | 按摘要集合去重（§5.7） |
| 人的话作为 `commented` 事件挤占评论的 50 / 20 名额 | 存在交接文件，评论流里另行显示（§5.7、§12） |
| 交接放在 `board.json` 里，降级后丢失、加重手机读取 | 独立文件 + 小索引（§5.1） |
| 没有回滚 | 软触发明确失败时回到旧 session（§6.4） |
| 继承前任已读时间而不管崩溃的回合 | min 规则（§7.4） |
| 冷评论仍直达冷而大的 session（C5b.2 的模式） | daemon 路由，冷且大时新 session 首条原文（§10.1） |
| 清单上限要从 1,800 提到 2,000 | 不提，1,790（§13） |
| 每分钟 stat 上万个 Claude 子代理文件；每次换下都流式读 GB 级 rollout | 子代理最多每 5 分钟测一次，复用路径清单但重新 stat 文件；骨架只按需或在异常 / 大 session 时建（§2、§8.1） |
| 回合内增长靠轮换挡不住 | 提醒、便签、卫生规则；steer 交给用户决定（§4、§19） |

### 20.2 第二版（信息损失、状态机两位评审，48 条）

48 条都给出处理，不等于每种建议照单全收；大多沿用评审给的修法，散在各节（主要是 §2–§7、§9–§11、§16、§17）。下面只列改了修法或只部分采纳的：

| 意见 | 处理 | 理由 |
| --- | --- | --- |
| 评审者的后续在 64–200 MiB 时保留已加载的 session（两个修法之一） | 不采纳；采纳另一个：被换下评审者没提交的发现进接替者的说明（§11.1） | R1 是主机安全界限，不该因角色而异；未提交叙述提供线索；截断与未说出的发现仍可能丢，不能保证全部带过 |
| 降级时把 carry 写进 `job.changes`，或附在收尾说明后 | 收尾说明附 carry 的前 1,500 字符（§6.2）；`job.changes` 本来就留着修改要求 | 评论与唤醒不是修改要求，写进 `job.changes` 会被旧版本当成评审的要求；附全文会诱使收尾回合动手 |
| 恢复时读 `removed/`，或快照带上 agent 写的各段 | 前者采纳；后者默认不做，见 §19 | 快照随文件夹被带到别处，属于隐私决定 |
| 人的长期指示跨卡传递 | 分出 standing 输入；默认不跨卡，见 §19 | 默认范围保持在本卡；父卡通过明确子卡说明传递相关约束并引用来源 |
| 最少回合数只用于轮换出来的 session | 去掉最少回合数，只留从 C₀ 算起的增长 | 增长量已能区分抖动；接班者的第一个边界本来就在它第一回合之后，回合数门槛对它也没有作用 |
| 等子卡和普通结束的回合也加门或提醒 | 提问加门；建子卡与启动子卡的结果带 `handoffDue`；什么都不调用的回合靠最后一条消息与叙述 | 拒绝建卡会打断编排；不调用 Flowly 的回合没有可拒的调用 |
| 评论边界不收尾（列为一项损失） | 改为评论边界也收尾 | 无论由紧密边界的较高上限还是非紧密边界触发，符合收尾条件就先记录；不是所有评论轮换都已空闲 20 分钟 |
| “已加载”改用 daemon 身份与启动时间 | 改用 `fetch_agent` 快照的 `status`（`closed` 即未加载），P1 在真实 daemon 上核实 | 快照是关于这个 session 的事实；daemon 的启动时间说明不了某个 session 是否已被打开 |
| 卡面显示记录的年龄，同时只在变化时写索引 | 两者都采纳：索引存 `staleSince`，年龄由客户端算 | 每次写入都更新 `updatedAt` 会让 `board.json` 频繁重写 |
| 默认视图给保留预算 | 采纳，并把视图上限从 20,000 提到 24,000 | 保留部分的上限加起来超过 20,000；平常它们几乎是空的，空出的预算还给 agent 的各段 |
| 交接演练的单一指标 | 定为“开始到确认完成的分钟数”，不用“到第一次提交” | 确认由 Flowly 机械检测；第一次提交的早晚取决于任务大小 |
| 开工图片只附给第一个接班者 | 一律只给路径 | 第一个接班者同样会把约 54 MB 写进新历史 |

### 20.3 两份 critique 的逐条去向

编号与已完成 workflow 输出的顺序一致：L 为信息损失评审（20 条），M 为状态机评审（28 条）。这里只记录处理结果，不重抄整份意见；“解决”指设计已规定行为，**不表示实现或测试已通过**。

| 编号 | 问题 | 设计处理 |
| --- | --- | --- |
| L1 | 不调 Flowly 时收不到提醒、20 分钟损失界限失实 | §4 被动捕获与沉默信号；§16.1 明示无固定损失上限。 |
| L2 | 崩溃回合启动的后台任务没有入账 | §5.7 回合中捕获，§5.8 unknown 清单；取不到句柄时给 no-inventory 缺口。 |
| L3 | 压缩后 `seen` 仍让交接只剩存根 | §2/§5.9 检测后重给视图，存根常带重要首行与引用。 |
| L4 | 跳过收尾与知识型回合过期判定遗漏 | §5.5 含知识型长回合；§5.8 叙述补记；§6.2 评论也按同样条件收尾；冷时例外明确。 |
| L5 | 问题与回答不能对应 | §5.2 questions；§5.7 明确关联才关闭，任意新话仅作候选；每次 Run again 有说明框。 |
| L6 | 手动 session 的输入永远 open、溢出无定义 | §5.7 定义 received 的传输语义；§5.2 归档正文但保留未决索引。 |
| L7 | 收尾期间收到的话被误算已处理 | §5.7 收尾/被拒写入的输入仍 open，§7.5 必须处置。 |
| L8 | agent 正文把人的指示与危险便签挤出预算 | §5.9 保留预算、裁剪计数及完整读取游标。 |
| L9 | `<paseo-system>` 与旧 session 做过的事被丢掉 | §5.7 来源区分；§9.3 记录通知、回复和 git 变化；周期触发不等于任务关闭。 |
| L10 | 限额/后续轮换没补记且 R1 优先级不清 | §3.3 强制优先，§5.8 覆盖异常后轮换；§6.3 重新构造继续指令。 |
| L11 | 漏钩子、重复原话和捕获时间不准确 | §4 持久偏移与 coverage，§5.7 源 messageId / 摘要计数、原时间与捕获时间区分。 |
| L12 | 只核对一个仓库，未提交列表被截断 | §5.2/§5.7 每仓库记录；超过 8 仓库/50 文件明示未检查范围，§7.5 分别核对。 |
| L13 | 项目移除后恢复会丢交接 | §5.1/§19 本机 removed 备份包含归档与输入正文；跨机器缺口明确。 |
| L14 | 危险与长期指示不随卡片树传递 | §11.5–11.6 传 agent pitfalls 与 Flowly hazard；人原话留本卡，相关约束由父卡明确写入子卡说明并引用来源。 |
| L15 | 原话被截断、长期指示和脱敏提示不完整 | §5.2 正文保存与引用，§5.9 省略计数/必读引用、standing、脱敏标记。不能承诺一次响应全给完。 |
| L16 | quick 的 answered 与 open 语义矛盾 | §10.2 显式选择；contains_request 转 auto；答案也保留给工作 session。P3。 |
| L17 | 收尾不能补 workpad 验证与 artifact | §6.2 允许记账，仍禁止交付与新工作。 |
| L18 | 评审者没提交的发现随轮换丢失 | §11.1 未提交叙述给接替者，标未核实。摘要裁剪后的细节仍是已知损失，不称完整保留。 |
| L19 | 早轮次的交付说明被活动裁剪 | §5.2 reviews.delivery 与归档；§5.9 评审完整读取路径。 |
| L20 | working 卡面看不到沉默与过期 | §4/§12 卡面记录年龄、沉默、checkpoint 与缺口。 |
| M1 | 各 job 状态下评论可能丢失/覆盖另一角色指令 | §10.1 明确状态转移、pendingInputs 及下一条指令送达；冷路由在 P2。 |
| M2 | 第一回合填满与压缩后增长门槛永不触发 | §2 起始请求 C₀、未知不假造；§3.3 peakC、去掉最少回合门槛；§17 回放。 |
| M3 | 开工模型只在第一次有效 | §3.4/§6.1 持久 launchModel，轮换和 Run again 受原有 fallback 规则约束。 |
| M4 | 人开的 session 被误判 retired | §9.1 只认自动化角色/原因，人开的仍走接管。 |
| M5 | delivered 上 Stop 不存在，旧 session 无法接回 | §9.2 Continue in this session；解除前禁止工作。 |
| M6 | 无 Flowly 调用时提醒失效 | 同 L1；§16.1 不承诺 20 分钟上界。 |
| M7 | 缓存轮换决定绕过最新字节强制检查 | §2/§3.5/§6.2 每次发送尝试重判 R0/R1，只缓存软决定。 |
| M8 | 回滚重建指令导致反复轮换、封存状态没还原 | §6.1 carry.id / prevMeta，§6.4 rotationAbandoned 与撤销封存。 |
| M9 | 创建中 fallback 嵌套轮换 | §6.3 保留 rotation id/carry，不给未创建 session 写 retired/台账。 |
| M10 | 收尾与 retired 回合漏钩子会卡死 | §6.5 先于普通 turnDecision 处理收尾；hold 每次用快照核实。 |
| M11 | 收尾收到的新话被记 received | 同 L7。 |
| M12 | 对方角色长回合被当成本角色空闲 | §3.2 以本卡最近回合划紧密边界，另看目标 session 缓存估计。 |
| M13 | 后轮评审只看到前轮摘要，无法逐项核对 | §5.9/§11.1 给完整读取页、总数与遗漏 id；必须取完本周期要求再宣称完成审计。 |
| M14 | 200 MiB 的 R0 不计字节失控次数 | §3.5 R0/R1 主历史都计入，S 不触发。 |
| M15 | 前任失败/提醒计数与后续文本误带给接班者 | §6.2 清计数；§6.3 用继续说明与未完原指令替换后续文字。 |
| M16 | queueIn 丢 session 元数据与 retired | §6.1 明确照带项；fresh 时在事务里 retired 旧执行者。 |
| M17 | Claude 子代理总量被 Codex 单线程阈值误伤 | §2/§3/§11.4 分开 B 与 S；S 先观察不自动轮换，校准后再议动作。 |
| M18 | 开工图片反复内联造成每个接班者膨胀 | §7 只给文件路径，按需打开；不反复附 base64。 |
| M19 | 非 git 根/多仓库使 ack 永远不符 | 同 L12；§7.5 读不到 HEAD 的路径不做 SHA 比较。 |
| M20 | reviewer 收到自己不能执行的 handoffDue | §4 只对执行者/收尾回合；§11 reviewer 报 gaps。 |
| M21 | 归档执行者 R0 与 failed 行为矛盾 | §3.3/§6.3 区分 starting 与工作中消失。 |
| M22 | 崩溃的 lastWords 误取上一个回合 | §5.8 取较新可用来源、明确时间与覆盖范围。 |
| M23 | 迟到收尾写入被 retired 拒绝 | §6.2/§5.6 按收尾 messageId 识别迟到记录；不夸大其为文件系统互斥。 |
| M24 | 热降级丢掉 rotation carry | §6.2 留指令开头、job.changes；§15.1 不承诺热降级无损，降级前解决 pending/unknown 并备份。 |
| M25 | cycle 无持久计数导致发现 id 碰撞 | §6.1 cycle 与 queueIn 照带，按新周期更新，不从裁剪事件推算。 |
| M26 | plugin reload 被当作 session 未加载 | §2 候选快照与 §19 实测；不再用 plugin 进程 id，不证明加载安全就不启用大 session 收尾。 |
| M27 | handoffIndex 频繁重写 board.json | §5.1 只在可见 fresh/open/session 值变化时写；时长由客户端计算。 |
| M28 | 接手演练指标与判分不可重现 | §17.5 固定 fixture、事实 id/SHA 与统一起止定义；ack 是结构核对，不等于语义全懂。 |

### 20.4 接续自查补上的一致性问题

- 去掉“零损失”“任何时候绝不双 session”“最多丢 60 秒”和回放推导最大 MB 的保证；列出模型、宿主与捕获不能控制的部分。
- 完整读取由单次 96 KB 改为有预算、有省略计数的连续读取；评审也不能把 40k 第一页当成所有轮次。当前 JSON 的 1 MiB 是实际编码硬限，不是各列表上限相加的猜测。
- 问题只有明确关联回答才关闭；完成一个回合仅说明 received，不证明已照办。schedule / heartbeat 的一次触发不等于已结束。
- 当前记录原子覆盖、历史仅记变更，先落盘内容再推进捕获偏移；跨 handoff/board 的操作必须可恢复，不声称 rename 让两个文件原子。
- 文件缩短/替换、长行、嵌套工具不可见、叙述滚动、读取积压、超过仓库预算都有 coverage/gap；坏文件不重置，关键要求不明则等待。
- 去掉统一的缓存计费倍率与“冷了所以一定更便宜”；缓存未知不单独触发冷恢复，Claude 子代理先观测。本文的阈值是待验证策略，不是模型服务保证。
- 取消 15 项重复确认，保留已获授权的 hybrid 默认；首期收紧到可靠接手，主动打断仍默认关闭，技术核实由开发者完成。

上述为设计阶段的验证状态。后续实施见 §20.5–§20.9、§21 及 `verification/session-handoff.md`。

### 20.5 捕获评审第三轮（loss-r3-L1–L3、noise-r3-1–4，2026-10-25）

七条都已修（§2 的 K、§5.7、§5.8、§9.3、§16、§17.2）。下面只列改了修法或只部分采纳的：

| 意见 | 处理 | 理由 |
| --- | --- | --- |
| noise-r3-4：子 agent 的报告（探针里是不带头部的 `input_text`）写成便签 | 带 `Message Type` 头部的可读报告写成便签；不带头部的是一条分组缺口 | loss-r3-L1 在本机记录上核对过的形状都有头部（FINAL_ANSWER 带正文，MESSAGE 只有加密正文）；格式不明的记录写成便签，未来格式一变就可能每条一个便签，分组缺口有界，且明说原文在原始历史里 |
| noise-r3-4：子 agent 的标签只用 task 名 | 只用 task 名；所给任务是可读文字（含空白、脱敏不改变它）时再加前 80 个字符 | 实际数据里全是不透明令牌，结果与 “只用 task 名” 相同；可读的任务说明不必丢，也从不出现脱敏标记 |
| loss-r3-L3：没有钩子时以 `task_complete.last_agent_message` 作为那个回合的 `final` | 它是实时叙述并进入 `lastWords`；`turns[]` 仍只由钩子记 | 从 provider 补出回合后，迟到的钩子会再记一次，`measured.turns` 与依赖它的轮换判断（§3）会算错；话本身不丢 |
| loss-r3-L1：被中断的子 agent 的报告是 hazard 便签 | 同一批次里（中断在报告之前或之后）是 hazard；分在两次轮询读到时便签保持 background | 改写已存便签的种类需要新的写入路径；条目的 outcome 仍是 interrupted，接班者看得到 |
| noise-r3-1：失败的启动 “至多一条便签” | 每个失败的启动与关闭调用都写一条带错误的 background 便签，`create_agent` 也一样 | 便签不是要确认的条目；万一失败的调用其实留下了东西，错误原文仍在卡上 |

### 20.6 第四轮：空闲写入、吸收的任务通知、在途占位（2026-10-25）

最后一次检查与一次实测列出的 1、3、4 三条（2 与 5 只在 P2 上，不在本轮）都已修（§4 第 2 条、§5.1、§5.2、§5.5、§5.7、§16 #30–32、§17.2、§17.3）。改了修法或超出原要求的：

| 问题 | 处理 | 理由 |
| --- | --- | --- |
| 1：空闲卡每 1–3 分钟一个 revision，“只有 `ops` 环变了” | 存储层：没有语义变化的事务什么都不写；另外 Git 只为回合中的 session 轮询，失败也等 2 分钟 | 只读实测（12:40–13:05 UTC）里 81 次写入全是 Git 的真实变化：20 张卡共用的项目根下，这一轮自己在编辑 `flowly-session-handoff` 工作树；只差 `ops` 的写入一次也没有出现。这个形状在 fixture 上能由被挤进归档的 Flowly 缺口复现，所以两条都修：只修存储层，共用工作区的空闲卡仍会每 2 分钟随别人的编辑换 revision，ACK 照样失败 |
| 1：周期性调用方的完整清单 | 写进 §5.1；自动化调度也进了空闲循环测试 | 调度只在轮换进行中经桥写入，测试证明空闲时它一次也不写、不报错 |
| 3：失败时“结算条目并带上错误摘要” | 条目的 outcome 仍是状态（`failed`），错误摘要与输出文件在 hazard 便签里 | 与送达的通知（R2-D1）同一契约；outcome 只有 120 字符，便签是完整、有界、脱敏的那一份；第三轮评审的探针 R3-A1、R3-A2 也按这个形状判定 |
| 3：只读 `remove`（`absorbed_mid_turn`）还是也读 `enqueue` | 两条都读 | `enqueue` 本身就证明任务结束了；吸收或送达之前 session 停了时它是唯一的痕迹；副本的 id 相同，只关闭、只记一次 |
| 4：在途占位 | 推广到所有结果还没读到的启动调用，并且不改交付门指纹、不算覆盖缺口、不计入看板索引 | 同一个占位机制（`finish()`）也用于 `exec_command`、标签页与 async shell，而它们远比脚本常见；每次碰到都让卡片在“新”与“捕获不全”之间翻转、重写两次 `board.json`，同一回合的交付重试还可能再被拒一次 |
| 4：仍要处置 | 在途占位仍在 ACK 的必须处置名单里 | “真正一直在跑的脚本仍要浮现”：被换下的 session 封存时还在跑的调用，接班者要用 `ps` 核实；接班者自己的在途调用也在名单里，与它自己的其它后台条目相同（不变） |

### 20.7 第五轮：第四轮的复查（2026-10-25）

两位评审复查了 687171c（p1-noloss-R4-N1a–N5、p1-churn-R4-C1、T1、T2），都已修（§4 第 2 条、§5.1、§5.2、§5.5、§5.7、§7.5、§16 #30–32、§17.2、§17.3）。改了修法或超出原要求的：

| 问题 | 处理 | 理由 |
| --- | --- | --- |
| N5：ACK 自己的 Git 刷新挪走了它点名的 revision | 刷新与更新同一个事务；被拒的写入仍单独记下读到的 HEAD | 只在 ACK 的 HEAD 与刷新一致时跳过刷新也能过评审的探针，但普通的更新照样会多一个 revision；被拒时不记，接班者被要求重读，却读到旧的 HEAD |
| N1a / N1b：Monitor 事件 | 进度不记任何东西，不写有界的进度便签 | 便签是当前记录里 100 条的一份，话多的 Monitor 会把 hazard 便签挤进归档；事件正文在原始历史里，任务条目保持打开到真正的结束。送达与经 SDK 排队的同形通知也一样（以前是 open 的输入，同一类问题） |
| N1d：探针的中间一步 | 不再有那条缺口可确认 | 探针先断言 ACK 之后缺口是 closed:2，修复后根本没有缺口；它的最后一步（之后的事件不重新打开）成立 |
| N2：何时不再在途 | session 回合中且没结束时才在途；空闲时还要这次把 provider 文件读到末尾、捕获没失败；封存时直接去掉 | 有积压时结果可能就在没读的部分里，过早去掉会多一个历史版本再关掉它；之后才到的结果关闭（不删）已成为历史的占位 |
| N3：只有轮询看到的回合结束 | 读一次 Git，但不清 `turnStart` | 评审建议照钩子的做法清掉；可钩子常在轮询之后才到，清掉后它就把回合记成从结束那一刻开始，“五分钟没有交接”的提醒也不会出现。读过的回合只在内存里记：不为它多写一个 revision，重载后至多多读一次 |
| N3：失败后重试 | 只对整次读取失败（快照标为 unobserved），每 2 分钟，空闲时也是 | 单个仓库快照自带的错误（例如超过 50 个改动文件）是长期状态，重读会让共享根里别人的编辑又每 2 分钟换一次 revision |
| N4：再次读不到 Git | 记在快照上，不改成计数的分组缺口 | 快照本身就是“上一次读成功了没有”的状态，不需要另记计数；due 与视图都直接看到；第一次失败的缺口照旧 |
| C1：放不下的在途调用 | 在覆盖说明里计数，不计入 `through.gaps` | 计入就会让交付门指纹随在途调用的多少变化，第四轮刚去掉这一点；session 停下时它们照常成为普通占位 |
| T1：测试超时与 ENOTEMPTY | 测试里不做 fsync（`server/test-setup.ts`，由根目录的 `vitest.config.mjs` 加载）；`ClassifierHelpers.drained()` | 测量：每个测试的工作量不随负载变（交付门测试独跑与在套件里都是 26 次 Git、88 次 fsync），变的是每次的代价：一次套件运行约 10,300 次 fsync、合计约 104 秒，拖慢所有 worker 的文件操作，连不做 Git 也不做 fsync 的面板测试也从 42 ms 变成 5 秒以上。测试从不断电，fsync 证明不了什么，崩溃顺序由存储层的 `fault` 接缝测试。没有调高任何超时。分类器在 stop 之后的写入是设计（宽限期过后仍清理迟到的创建；生产里插件子进程随后停止，持久的归属记录留给下次启动的恢复），不是产品竞争；测试改为等助手自己的清理结束。配置文件放在根目录是工具配置，不是插件代码；用 JavaScript 写，免得类型检查引入 Vite 的 DOM 类型 |

### 20.8 第六轮：第五轮的复查（2026-10-25）

两位评审复查了 7226099（p1-noloss-R5-A、R5-B，p1-churn-R5-A1、R5-A2、R5-T1），都已修（§5.1、§5.2、§5.5、§5.7、§5.9、§7.5、§16 #32–34、§17.2、§17.3）。R5-A 与 R5-A1 是同一个问题。改了修法或超出原要求的：

| 问题 | 处理 | 理由 |
| --- | --- | --- |
| R5-A / A1：接班者自己的回合挪走 revision | 评审的方案 2：观察状态原地写入，不换 revision（不另设一个“要求 revision”） | `revision` 已经是 agent 抄回的 `handoffRevision`、条目 `rev`、页游标、`seen` 与续写共同钉住的那一个；另设一个计数器就得让所有这些改用它，条目 `rev` 与它混用会造成假冲突。原地写入的 intent 带 `inPlace`，恢复规则只多一种情形 |
| R5-A1：观察状态的范围 | 除评审列的字段外也包括 Git 快照的内容（不只是读取时间）与 `seen` | 页里没有 Git，ACK 拿自己刚读的 HEAD 核对，所以 Git 变化从不需要挪走 ACK 钉住的 revision；不这样，共享项目根里别人的编辑仍每 2 分钟挪走回合中的卡的 revision（第四轮实测：20 张卡共用一个根），接班者的读取照样重来。代价写在 §5.1：只有 Git 变了时再读得到 `unchanged` 的存根，由 due 说出 |
| R5-A1：“确认不必覆盖接班者自己的在途调用” | 在途调用一律不是 ACK 要处置的 id（自己的与别的 session 的），改了第四轮的决定（§20.6 “4：仍要处置”） | 原地写入之后在途调用出现、消失都不换 revision，留在名单里会让同一个 revision 的 ACK 的 `ackMissing` 随轮询时机变化；在途只在它自己的 session 回合中成立，那个 session 还在跑它；第四轮要的“真正一直在跑的脚本仍要浮现”由第五轮的规则保证：封存、停下时它成为普通占位，进名单 |
| R5-A2：每个结束的回合只归档一次 | 评审的第一种方案（写入时），另外归档的台账版本不带观察状态 | 读取时跳过“内容已在别处”的版本需要跨版本比较回合，游标还得记住每个条目读过的回合；写入时记 `turnsArchived` 就够。叙述预览留在归档版本里会让最近 8 条 final 的文字在每个版本里再出现一次，它是原地覆盖的观察状态，正文在原始历史里 |
| R5-B：Monitor | 启动按自己的 task id 成为条目；最近一个事件记在条目的 `event` 上（观察状态）；结束便签保留最后的事件 | 评审要求前一条与最后一条；`event` 让“health check failing”这样的进度在它运行时就在卡上，又不写便签、不换 revision，所以第五轮担心的便签挤占与每个事件一个历史版本都不会发生 |
| R5-T1：预算测试的二次方填充 | 用累计字节数一次填满，测试证明的不变（同样的 `HANDOFF_TOO_LARGE`、字节不变），约 1 s 变成约 50 ms；没有调高超时 | 再按评审的要求，在另一个完整套件同时运行时连跑 3 次 `npm test` |

### 20.9 第七轮：第六轮的复查（2026-10-25）

两位评审复查了 beffcc7（p1-noloss-r3-R6-N1、R6-S1，p1-churn-r3-A、B），都已修（§5.1、§5.2、§5.7、§7.5、§16 #35–38、§17.2、§17.3）。改了修法或超出原要求的：

| 问题 | 处理 | 理由 |
| --- | --- | --- |
| R6-N1：重建的便签替换原文的便签 | 便签带 `metadataOnly`，原文替换它（同一个便签 id），不另设来源 id | 另设来源 id 时两条便签同时在卡上，原文到了还得删掉重建的那条，而 Flowly 的便签没有删除路径；同一个 id 升级并换 revision，读过旧便签的读者会重读 |
| R6-N1：已归档便签的副本 | 同一条 Flowly 便签的其它副本不是冲突 | 便签超过 100 条进了归档后，换了时间（钩子与 provider 各有各的时间）的副本以前抛 `HANDOFF_CONFLICT`，整次捕获被拒、游标停住；评审没列这一条，原文升级已归档的便签要经过同一处，一起改了 |
| R6-S1：只信说停掉了的结果 | 结果说停掉了（或旧版本的 `success: true`）才关闭；失败照常写便签，其它结果什么都不改 | 本机转录里有 28 次 TaskStop 调用，成功的结果都是这个形状，失败的是 “No task found with ID” 这样的错误；只凭调用参数关闭，停止失败或目标早已不在时会把仍在跑的东西当成已停 |
| A：不只是工具输出，也不只是确认的 session | session 自己产生的、不是人的话的长行（含它自己的叙述）与超出上限的工具结果，任何回合中的 session 都一样 | 都是那个 session 自己的工作，理由同第六轮把在途调用扩到所有 session（§20.8）；人的长输入可能装着要求，照旧立即是缺口 |
| A：回合中只计数，不写缺口 | `held` 在观察状态里，覆盖说明写出条数；回合结束或封存时写成分组缺口 | 评审给的第二种做法（同在途调用）；写一条 “回合中” 的缺口还要给缺口加一种不算 id 的状态，读者看到的 open 缺口与 ACK 名单就不一致 |
| B：只对 exec session | `transient` 只给 exec session，不给标签页、子 agent、async shell | 子 agent 被中断这件事有时只记在它的条目上（答复与中断分在两次轮询读到时便签仍是 background），去掉条目就丢了；async shell 与任务通知另写便签；评审测到的反复写入就在 exec session 上 |
| B：重放不把它带回来 | 去掉的 exec session 按 kind 与 ref 记最近 128 个，只对 timeline 重放与之后的进度生效 | 回合结束的 timeline 每次带全部启动；Codex 的 exec session id 是 5 位数，只对重放与进度生效，provider 文件里新读到的启动（每条只读一次）不会因为碰巧同号被藏起来 |
| B 之外：被跳过的结果 | 开头是 Codex 退出头部的被跳过结果让它回答的 `exec_command` / `write_stdin` 照常结束；退出码从文本头部读 | 不这样，最后一次输出很长的测试运行（常见）在 B 之后会成为回合结束时一直 open 的 exec session；脚本不这样处理，它留下在跑的东西写在没读到的输出里 |

## 21. P2 实施合同与设计取舍

2026-10-24，`sw/hybrid-boundaries`，基于 P1 `684a8fd`。本节描述已实现代码；完整检查、真实验收与最终版本号另记验收报告，不能由这里推断已经上线。2026-10-25 起本分支也包含 P1 `786d9cd` 之后的捕获修复（至 `69422d8`，§5.7、§20.5；第四至第七轮至 `ec4a717`，§20.6–§20.9，移植见 §21.6）：测量里的 `coverage.gaps` 数的是分组后的缺口条目（每个 session、种类和类型提示一条），仍只作参考，不参与轮换决策。

### 21.1 边界与测量

- 自动派发在空闲、无待批权限的边界调用同一个纯决策函数；每次重查归档、消失、模型/失败和字节保护。R0/R1 优先于软轮换缓存，明确的人为 fresh/新评审周期 R5 优先于缓存和软次数上限，最后才是 R2–R4。已运行的回合只观测，不自动停止或发送 steer。
- 主文件 64 MiB 是早换人线；Codex 200 MiB 仍是禁止 Paseo 加载的独立界限。64–200 MiB 不申请收尾：安全证据不足时沿用 P1 的严格 `<64 MiB` 条件，直接携带缺口接手。Claude 子文件合计单独观测，不计入主文件的轮换次数。
- 上下文、压缩和冷热阈值沿用 §3 的数值。用量权威是当前快照和同身份的交接台账，不新增一套 `job.sessions`。C₀ 缺失保持未知，活动时长只累计可证明的活动区间，不能用 session 年龄替代：从回合开始到最后一次看到它还在跑的轮询（快照带 `activeTurn`），不到迟到的钩子的时间。这个证明第一次看到回合时随 `turnStart` 写下，之后的轮询只在内存里推进它，有新 provider 数据（游标移动）时随游标写下；安静的轮询什么都不写（§21.6）。回合结束钩子先结束它自己的回合（P2 复查第一轮）：钩子点名的回合（Paseo 的 `turnId`，与快照的 `activeTurn.turnId` 同一个 id），没有点名时是这个快照不显示在跑的、最早存下的回合，用它自己的开始与证明；Paseo 在发布钩子之前就关闭回合，所以钩子的快照里在跑的回合是下一个（排队的消息立刻开始），记下结束的回合之后才采用它。以前先采用：结束的回合记成下一个回合的开始、长度为 0（活动时长与五分钟的 hazard 都丢了），`lastEndedTurnId` 成了下一个回合，它自己的钩子被当成重复：没有 `turns` 条目、`measured.turns` 少一、最后的话不上卡。轮询先看到下一个回合时，上一个回合连同它的证明存为 `priorTurn` 等它的钩子（之后的观察已看到 session 不在那个回合里时不存：它的钩子可能丢了，没有点名的钩子会结束错的回合）；点名一个没存下的回合的钩子不再拿一个钩子丢了的更早回合的开始，那个回合被丢掉。
- 补用量的尾读最多 16 MiB、块 1 MiB、单行 256 KiB。先限制行长，再完整校验 JSON 和 native session 身份；不再采用设计稿的局部字段扫描。只有非空的实际压缩 marker 计 K。缓存和读取稳定性包含 inode、size、mtime、ctime 及 provider/native 身份，避免同大小原位重写命中旧结果。
- 每指令的软判定可缓存；字节/强制保护仍每次重测。每 generation 最多四次成功软替换；第三个不同字节超限触发挂起下一次派发，不另开第四位执行者，也不停止当前会话。未知创建不重复计数；明确回滚保留原身份。
- 运行中 60% 窗口、确认压缩、128 MiB、可测快速增长或二十分钟无交接时，记录工具结果提醒。二十分钟未调用 Flowly 显示沉默信号。平坦采样放内存；仅采样时间变化、空闲卡或无变化的忙碌轮询不重写看板。128/300 MiB 每身份每级只提醒一次。
- 测试用 `rotation.json` 只允许明确 task/project 白名单、最多二十条、调低既有阈值；禁止主机全局覆盖，也禁止改 200 MiB no-read。普通用户无需配置它。

### 21.2 评论与周期

- 新客户端在受监督卡默认 `auto`，也能选显式 session、`fresh` 或 `save`。先保存脱敏原文，再在同一个看板提交里接受评论事件和来源引用式路由意图。正文不复制进 job；未确认的原话不能冒充接受成功。旧客户端缺少 `deliver` 时保留原合同，不另发一次。
- 只有到达真正 native 发送回调才标记 `sending`；此前的权限/工作区/退役校验失败是确定失败。未知发送保持同一目标和 messageId，重试不能改投或生成另一条评论。已送达只表示传输，不自动把原话标成已解决。
- 统一 automation dispatcher 恢复待办引用，无第二个评论定时器/创建器。review 中的评论不覆盖评审指令；结束后交执行者。轮换中只排队；明确停止/失败的卡不因 auto 评论重启。冷评论的首条 native 消息仍是原文，连续性另放创建上下文。
- 每卡最多二十条真正未派发/未知意图；确定失败不占此名额。当前回执有界保存，删除卡/项目时先随恢复档备份，再从活动看板清除；未决意图不能被容量裁剪静默删除。刷新后仍能看到 pending、未知、失败、fresh 或 saved。
- 同周期紧密返工可复用健康 reviewer；新周期使用新 reviewer。原轮中途换人保留轮数、delivery、计划和 panel seat，迟到前任仍无权交付。Run again 与人工 fresh 使用同一可恢复管道，不增加另一个 session 创建入口。

### 21.3 有界检索和跨卡摘要

- `flowly_session_history` / `flowly history` 只读本卡台账已登记的精确 session ID，或当前台账里的 `#n`。当前 reader 必须属于本卡；目标的真实 workspace 仍须匹配。前任被归档也不恢复、不经 Paseo 读 timeline。
- 首次查询排入一个有界构建队列（最多十六项），响应明确 `building`。源最多 2 GiB / 二十万记录，256 KiB 以上行跳过；派生索引每份最多 2 MiB，最多一万条，响应最多 8 KiB / 二十条。短凭据和结构化/JSON 编码后的工具参数先脱敏再裁剪；无法安全解码的范围明确省略。
- 普通查询不因源增长而不断全扫描。游标绑定不可变的脱敏视图；源、sidecar 或原位内容变化显示 changed/viewChanged，明确 `rebuild` 才生成新视图。每身份只保留当前与上一份派生缓存；manifest 持久发布后才清理更旧的自有文件，清理未完成时拒绝继续堆新副本。停止与重启保留可恢复发布证据。
- 搜索不到不证明不存在：返回索引范围、跳过行、裁剪/未知格式和原始引用。它提供可核查线索，不是完整转录或模型未说出的推理。
- 父子/依赖仅传有界的 agent pitfalls、Flowly incident/hazard 和按关系适用的状态/环境，预算为 child 600、parent 1000、dependency 1500 字符，并共用 `get_task` 的 16,000 字符总预算。人的原话、备注、问题和私有对话默认不跨卡；相关约束仍由父卡明确写进子卡要求。省略会给出回到原卡 Handoff 的路径。

### 21.4 尚未承诺的范围

P3 的 quick-answer 模型、Codex SQLite 子线程读取、通用原始转录浏览器、对未捕获思考的恢复、跨机器图片/档案恢复、旧 session 指定复用的额外菜单仍未实现。低阈值 fixture 验收不能证明真实 200 MiB 加载安全、所有 provider 的压缩语义或手机启动时延。没有主动 auto-stop 或后台 steer。

### 21.5 实测失败后的软门修复

`HANDOFF_STALE` 的明确确认改用语义指纹：已接受的原话、评审、问题、真实缺口、重要备注和运行义务变化才重置。检查点、纯游标、测量、已读和相同原话的处理说明不单独重置。新的要求即使仍对应同一句通用提醒，也必须先拒绝一次。当前条目和 overflow 用同一语义 hash；旧 overflow 缺 hash 时保守重新拒绝，不为此全扫历史。这样 agent 能保留无法消除的真实缺口、说明原因并交付，而不必假装这些信息已经恢复。

已核实的 Codex `token_usage_record` 纯用量结构不再生成内容缺口；只有严格符合已知字段、身份及安全数值计数才忽略。未知扩展继续保留 gap，不据此推导 C/W/K。

### 21.6 第四至第七轮的移植；安静的回合与测试时序（2026-10-25）

`feat/session-handoff` 在 `69422d8` 之后的 27 个提交（第四至第七轮，到 `ec4a717`，§20.6–§20.9）按原顺序 cherry-pick 到本分支，保留作者。代码全部自动合并；冲突只在文档（P1 的 §20.6–§20.9 放在 §21 之前，P1 的进度段落放在本分支上一次移植的段落之上）与 `ObserverState` 的类型（P1 新增的 `ended` 与本分支的 `lastRequest`、`activeMs`、`lastEndedTurnId`、`turnStart.observedAt` 并存）。移植之后只有 `server/handoff-idle.test.ts` 的 “a quiet running turn writes nothing either” 失败，正是下面第 2 条。

| 问题 | 处理 | 理由 |
| --- | --- | --- |
| 2：回合中没有新数据的轮询也写（`turnStart.observedAt`） | 第一次看到回合时写下证明；之后只在内存（`HandoffObserver.activeSeen`，按卡与 session）推进，游标移动时随它写下；回合结束取存下的与内存里较晚的那个，然后清掉内存 | 移植来的原地写入已经让 revision 不变、ACK 不再失败，但每次轮询仍是一次完整的原子写（intent、rename、目录同步）；要求是没有新数据的轮询什么都不写。不能把这个时间去掉：它是 R3 在上下文未知时的活动时长代理线（`unknownActiveMs`，§3）唯一的证据，钩子会迟到，用钩子的时间会把等待也算进去 |
| 2：重载之后的证明 | 只会少算：上一次写入之后的安静区间要等下一次轮询看到回合还在跑才重新算进去 | 写下每次轮询的证明正是要去掉的写入；有新 provider 数据的轮询本来就写，重载丢掉的至多是上一次有数据的轮询之后、下一次轮询之前的那一段；少算只让 R3 的代理线晚到，不会造成没有证据的轮换 |
| 5：分类器在 dispose 之后写 `review-classifier-helpers.json`（ENOTEMPTY）是产品竞争还是测试时序 | 测试时序；不改产品，测试等 `ClassifierHelpers.drained()`（P1 `1109834`，本分支 `18a783d`；本分支与 P1 的分类器代码相同） | 那次写入是设计好的清理：`stop()` 至多等 1 秒，之后晚到的创建仍被删除，再写所有权记录（`confirm` / `forget`，内容正确，临时文件 + rename 不会写坏）。Paseo 0.12 的插件运行时（`@getpaseo/server` 的 `plugins/runtime.js` `stopPlugin`，`plugins/index.js` `reloadPlugin`）先发 `shutdown`，等插件子进程退出（2 秒后 SIGTERM，再 2 秒 SIGKILL），然后才启动下一代：晚到的写入只发生在正在退出的旧进程里，下一代还不存在，所以不会与它的所有权写入交错。测试的拆除在 10 ms 的宽限之后直接删数据目录，删到一半那次清理又写进来 |
| 5：交付门测试在套件里 5 秒超时（单跑 0.5–1.3 秒，套件里约 34 秒） | 测试里 fsync 是空操作（P1 `03af022`，本分支 `f19ea8d`，`server/test-setup.ts`），不放宽超时 | 每个测试的工作量不随负载变（26 次 Git、88 次 fsync），变的是 fsync 的代价：整个套件约一万次 fsync 让所有 worker 的文件操作都排队。移植后的默认并行全套件里这些测试每个 0.5–0.7 秒 |

剩下的：重载中断在临时文件写完、rename 之前时（SIGTERM / SIGKILL），数据目录里会留一个从不被读取的 `review-classifier-helpers.json.<uuid>.tmp`；钩子丢了的回合不计活动时长（只有钩子结束回合），与移植前相同。

### 21.7 P2 复查第一轮（2026-10-25）

两份评审复查了 `d261e08`（p2-noloss-R1–R3、p2-churn-1、p2-churn-2），都已修（§5.1、§5.2、§5.7、§7.5、§16 #40–44、§17.3、§21.1、AUTOMATION-SPEC 的 helper 所有权）。改了修法或超出原要求的：

| 问题 | 处理 | 理由 |
| --- | --- | --- |
| R1：读了 R 之后原地增长的分组缺口被 R 的 ACK 一起结算 | 取评审的第一种做法：原地写入记下 R 时的计数（`countAtRevision`，只在已超过它时存在，换 revision 的写入去掉它），关闭只结算这个数，其余让缺口保持 open、id 进 `ackMissing`，不进记下的 `items`；`gaps` 的显式关闭同样 | 第二种做法（可能装着人的话的分组让增长换 revision）只覆盖那几类：不是人的话、在没有钩子的回合结束时原地释放的 `held` 输出照样会被结算；而且每一次出现都让接班者的整读从第 1 页重来，正是第六、七轮去掉的代价。只结算看得见的计数对所有类型都成立，不换 revision |
| R1：读到的是 R 之内哪一次的计数 | 按 R 被钉住时的计数结算，偏保守 | 原地写入不换 revision，接班者在 R 之内可能读到增长前或增长后的计数，存储层分不出；多确认一次比漏掉一个人的消息便宜 |
| R2：钩子到时下一个回合已开始 | 钩子带上 Paseo 的 `turnId`（`index.server.ts`），先结束它自己的回合再采用在跑的回合；超出要求：轮询先看到下一个回合时上一个存为 `priorTurn` | 读了 Paseo 0.12 的 `agent-manager.js`（只读，应用包里）：回合在发布 `agent.turn_ended` 之前关闭（`applyActiveTurnTerminal` 先于分发），钩子的 `turnId` 与快照的 `activeTurn.turnId` 是同一个 id；轮询在钩子处理之前看到下一个回合是同一类竞争，以前同样丢掉上一个回合的开始 |
| R2：没有 `turnId` 的钩子 | 结束快照不显示在跑的最早存下的回合；全都在跑时只在 timeline 与上次不同时结束最早的那个（宿主先发钩子后关回合）；之后的观察已看到空闲的回合不存为 `priorTurn` | Paseo 0.12 对跟踪的回合总给 `turnId`；没有点名时，一个钩子丢了的 `priorTurn` 会让下一个钩子结束错的回合，并一个接一个错下去 |
| R3：被封存 session 的迟到回合 | 照评审：回合是否结束只看状态（空闲或不在、provider 文件读到末尾），`seal()` 照旧结算封存时在途的调用 | 封存之后 session 还在跑（强制轮换）或被唤醒时，它的在途调用与回合中启动的 exec session 同任何回合一样是观察状态，回合结束时还在跑才是历史；`server/handoff-inflight.test.ts` 封存中途的测试多验证这一点 |
| churn-1：重叠脚本的完成条目 | 池：完成条目记给池；占位在每个成员返回时按缺额计算，先算给仍以 yielded cell 在跑的成员，等还没返回的普通成员，撤回不再需要的，最后一个成员返回时确切 | 评审给的“只在归属明确时记给一个脚本”在一次启动 20 个脚本时等于全部进池；只在最后一个返回时补占位会让 yielded cell 一直在跑时较新脚本的 dev server 一直不出现（评审的反例正是这个）；先算给每个仍在跑的成员又会在 20 个脚本的例子里于回合中出现多达 10 个假占位。cell 可能活过回合，普通脚本在同一回合里返回或成为在途占位 |
| churn-1：yielded cell 结束时打印的 session | `wait` 报告结束时它最后的输出里仍在跑的 session 同脚本输出一样成为条目；被 terminate 的 cell 不补占位 | 现在 cell 的调用处参与池的计数，不读它最后的输出就会把它打印出来的 dev server 记成 “completion not observed”；terminate 之后留下什么不得而知，同以前一样不猜 |
| churn-2：helper 硬删除一直失败 | 30 秒的所有权检查照旧（经插件自己的 SDK 连接探测）；只归档的 helper 按 1 分钟起翻倍到 1 小时重试，重试不再记错误，失败只记一次；退避只在内存里 | 一小时 6 次而不是 120 次；每次插件启动先试一次，Paseo 升级后能删时不用等一小时；不改所有权文件的格式 |

仍未做的：R1 的分组缺口文字仍只写前几次出现的字节范围（之后的人的长消息从“these start in bytes”给出的位置往后在原始历史里找）；一个回合的钩子丢了、观察已看到空闲，而下一个回合在它迟到的钩子之前被轮询看到时，那个回合的开始仍然丢了；池里循环中一个调用处执行多次仍按调用处计。

### 21.8 P2 复查第二轮（2026-10-25）

评审复查了 `1eeafaa`（p2-noloss-r2-1、p2-noloss-r2-2），两条都是第一轮池的回归，都已修（§5.7、§16 #43、§17.3）：

| 问题 | 处理 | 理由 |
| --- | --- | --- |
| r2-1：被 terminate 的 cell 的调用处被减两次，撤回旁边脚本的占位 | 取评审的第一种做法：没读到结果就离开的成员（terminate、输出读不了、调用预算）的调用处按工具记进池的 `claims`，照仍在跑的 cell 那样先占完成条目，不再同时加进已返回与已覆盖；`spawn_agent` 等嵌套启动与 detached 同理（同一类：cell 离开后它收到的启动同样会多出来） | 第二种做法（按 CommandExecution 的 `command` 与成员的命令字面量对上）只在命令是静态字面量时有用，模板字符串、循环与拼接的命令仍要走计数；先占的代价是：被 terminate 的 cell 自己的命令其实没完成、而完成条目属于旁边的脚本时多一个占位，与 cell 在跑时的规则相同，是不丢东西的方向 |
| r2-2：活过回合的池在计数回落时把历史占位关掉，回升时重新放置被拒绝 | 取评审的第一种做法：成员还在跑时的撤回带 `withdraw`，观察者只用它去掉观察状态（`transient` / 在途）的占位；历史占位留着，最后一个成员返回时数目确切，超出它的全部关闭（池记下它在跑时放过的最多数目，`peak`） | 第二种做法（撤回照样关闭、重新放置带 `reopen`）每次先降后升都是一次关闭与重开：两个 revision、两个归档台账版本、接班者的整读重来、ACK 名单随时机变化，正是第四至第七轮去掉的代价；记录在回合结束之后才一起读到时（从不 `transient`）同一个问题在一个批次里就会发生，也由这条规则覆盖 |

代价与仍未做的：活过回合的池里计数确实降下来的历史占位（例如 dev server 在下一个回合才退出）要等最后一个成员返回才关闭，一直没人等的 cell 让它一直 open（同 `d261e08` 的单脚本占位）；池的占位按位置编号，接班者的 ACK 关掉一个之后池仍在跑、计数又需要它时，同一个 id 的重新放置仍被拒绝（只在前任的池在 ACK 之后仍在运行时发生）。

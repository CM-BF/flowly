# 会话轮换与卡片交接：混合会话模型（SESSION-HANDOFF-SPEC）

状态：设计稿，待用户审阅（2026-10-24，分支 `feat/session-handoff`，基于 origin/main `ca58787`），未实现。三份方案（“零损失”“从简”“故障优先”）经两轮评审后的综合：以“零损失”为主体，并入另外两份的长处，修正评审指出的每一处缺陷（去向见 §20）。与评审级别（[AUTOMATION-SPEC](AUTOMATION-SPEC.md) §5.2，分支 `feat/review-levels`，已实现、未合并）的配合见 §15.3。待用户决定的事项见 §19。

用户决定，2026-10-24：Flowly 改为**混合会话模型**，以 agent 到 agent 的交接为核心。原因：人不看 session 里面，卡片必须承载全部信息；设计要保证有意义的信息不丢。现状是每张卡的执行者从头到尾用一个 session（外加一个评审 session），只有 Run again、换备用模型、session 被归档、小组评审和历史过大（200 MB 轮换，AUTOMATION-SPEC §4.6）才换新 session。实际事故：C5b.3 的第一个 Codex 执行者在约两小时里长到 1.18 GB，daemon 崩溃循环；卡片上的 artifact 都是给人看的产出，不是交接；唯一的交接是崩溃之后人手写的（next-workspace `docs/handoff/2026-10-24-daemon-incident-and-review.md` §8 加一条接手评论），新 session 凭它约 20 分钟就结束了一个回合。

用户已接受的起始提案（本 spec 按证据细化，每处改动都给出理由，§0）：
1. 紧密循环保持同一 session（同一次交付的评审→修复、几分钟内的追问、提示缓存仍热）。
2. 在边界换新 session：历史超过软上限（约为模型上下文窗口的 50%，token 未知时约 30 MB）、空闲约 1 小时后恢复（缓存已冷）、阶段变化（实现→验证、人改变方向、Run again）、失败与换模型。
3. 交接是卡片上的一等记录：agent 每回合增量更新（现状、已完成、关键决定及理由、未决问题、下一步、坑、产物在哪）；轮换时 Flowly 把卡片、workpad、交接和最新评论交给新 session；评审者也检查“只凭这份记录，一个新 agent 能接着做吗”。
4. 评论路由：修改要求发给热 session，冷时交给带交接的新 session；纯进度提问由只读的廉价运行读卡回答，不让工作 session 继续变大。

## 0. 决定一览：对提案的细化

| 提案 | 本 spec | 依据（§1 的证据） |
| --- | --- | --- |
| 1. 紧密循环不换 | 保留，并给出定义：同一评审周期内、该角色 session 上一回合结束 ≤ 20 分钟的修改要求与评审下一轮是**紧密边界**；提醒、普通重试、限额重试、宿主临时故障重试是**同一指令的后续**。紧密边界用更高的上限（70% / 300k），后续只受强制规则约束（§3.3）。 | 评审→修复间隔中位 2.8 分钟（最长 14.8），评审轮间 8.1 分钟，重试 0–1.3 分钟。19 个执行者里 15 个超过窗口的 50%，7 个在第一回合就超过：50% 会打断提案第 1 条要保护的循环。 |
| 2a. 软上限 ≈ 50% 窗口 | 50% 只用于非紧密边界：`L_cold = min(0.50·W, 250k)`；紧密边界 `L_tight = min(0.70·W, 300k)`。300k/250k 的绝对上限针对 1M 窗口的模型。 | Codex 在有效窗口的 66–95% 自动压缩，压缩结果加密不可读（Hermes 测得压缩后召回 36.7%）。sol 的 300k（63%）低于所有观测到的压缩点。新 session 光是读卡就到约 108k token，低于约 2 倍这个量的轮换省不下什么。 |
| 2b. token 未知时 ≈ 30 MB | **不再把字节当 token 的替代**。token 从 Paseo 的 `lastUsage`、job 上保存的上次测量和 provider 文件读（§2）。字节是独立的**主机安全**上限：64 MiB 在任何边界轮换，128 MiB 回合内提醒，200 MiB 不读不发（今天的规则），300 MiB 严重警告。 | 1.18 GB 的 rollout 当时只占窗口 49.7%；纯文本会话约 2 MB / 10 万 token，所以 30 MB 已是好几个窗口。真实卡片上只有 3 个 session 超过 30 MB，其中两个是正常的长会话。 |
| 2c. 空闲约 1 小时 | 按 provider 估计缓存寿命，且**只在上下文大时**才因空闲轮换（`C ≥ 100k`）。Claude 主会话按转录里实际的缓存写入档（1 小时或 5 分钟）判断；Codex 2 小时内视为热，2–6 小时不确定，6 小时以上冷。 | 本机 Codex 首个请求的缓存命中率：2 小时内中位 0.97–1.00，2–6 小时 0.92，6 小时以上 0.04。Claude 主会话（订阅，1 小时档）超过 60 分钟后全冷；API key 只有 5 分钟。新 session 本来也是冷的，小上下文因冷而轮换省不了钱。 |
| 2d. 阶段变化 | 只认 Flowly 在回合之间看得见的边界：人的 Run again（默认新 session，§3.4）、新评审周期（总是新评审者）、父卡被唤醒、换模型、中毒失败、人点 “Continue in a fresh session”。**不认**泳道移动；实现→验证本来就是另一个评审 session；人在 session 里改方向看不到也改道不了，只能把原话记下来（§5.7）。 | 103 次 agent 改阶段全部发生在回合中；C5b.3 在 2.3 小时里改了 15 次。插件 SDK 没有用户消息之前的钩子（`agent.turn_started` 只有 `{agent, turnId}`）。 |
| 2e. 失败与换模型 | 只在 session 级的失败上轮换：中毒失败（上下文溢出、400 invalid_request、历史无法恢复）、session 消失、换备用模型。provider 限额和宿主临时故障的重试**不**轮换。 | Multica 的“中毒 session”列表；重试约 1 分钟后发生，缓存 99% 仍热。 |
| 3. 交接记录 | 保留并加固：(a) Flowly 派生的事实（人在 session 里说的原话、每一轮评审、git 状态、后台任务清单、session 台账、标识符锚点）；(b) 回合中途的检查点提醒和软的交付门 `HANDOFF_STALE`；(c) 计划内轮换前，热的旧 session 做一个**收尾回合**（只在热、已加载、记录确实过期时）；(d) 前任历史的有界只读检索；(e) 新 session 第一回合**确认接手**每个未决项。 | C5b.3 的卡片最后 23 分钟没有任何记录，验证结果落后两个提交；最要紧的事实（崩溃原因、新规则、安装状态）是 session 结束后由人产生的；摘要会丢一半具体事实（Hermes 45.8%，Factory 的产物轨迹 2.2/5）；能回到原始记录的指针多出 20–43 个百分点的召回。 |
| 4. 评论路由与只读回答 | 自动化卡的评论改由 daemon 路由：热 session 收原文；冷且大时建新 session，**首条消息就是评论原文**；轮换进行中的评论成为待办输入，绝不发给旧 session。只读回答只作 To: 里的显式选项（“Quick answer from the card”），v1 不自动分类。 | 真实卡片上进度提问 0 次；评论 4 条，直接打进 session 的消息 22 条。误判路由（把修改要求当成提问）是最主要的丢失方式。用户选择收件 session（产品不变量）。 |

前提更正（不改变决定）：
- **Multica 并不每条评论开新 session。** 每条评论开一个新 *run*，但 run 在安全时恢复同一 agent 在该 issue 上的 provider session；只有手动 rerun、中毒失败、rollout 丢失或换运行时才全新开始（multica-ai/multica@3de79cb `server/internal/handler/daemon.go`、`066_force_fresh_session.up.sql`）。也就是默认热，记录兜底。本设计同形，外加 Multica 没有的结构化记录。
- C5b.3 崩溃时卡片上有 9 个 artifact（11 是今天的数）；session 1 每次提交都更新了 `C5B3-HANDOFF.md`，但那是写给评审者的，没有当前步骤、在跑的进程、失败的尝试和坑；体积 44% 来自 agent 用自己的 patch 工具写的 9,870 个文件，内联截图只占 40%；崩溃发生在一个回合中间（之后每次恢复都再崩）；session 1 实际活动 2 小时 17 分钟。

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

新增（零损失）：
- **Z1 不随 session 离开。** 轮换提交之前，原本只在旧 session 里的每类信息（§16.1 的损失分析）要么在记录里，要么由 Flowly 机械地捕获，要么能通过有界的只读检索拿到。
- **Z2 人的话保留原文。** 人打进本卡任何 Flowly 管理的 session 的消息、评论、开工说明和能拿到的图片按原样保存（脱敏后），从不转述。
- **Z3 能派生的不靠自报。** HEAD、分支、未提交文件、diffstat、评审轮次与结论、产物、测量值和能检测到的后台任务由 Flowly 读出。
- **Z4 接手要验证。** 新 session 对每个未决项给出处置，并报告它看到的 HEAD；Flowly 机械核对。
- **Z5 存储只增，视图有界。** agent 删掉的条目留墓碑；每次轮换封存一份快照；只有 agent 和手机收到的视图有上限。
- **Z6 轮换是持久化的分阶段事务。** 任何时候不会有两个工作中的 session；每一步重启后幂等、按 rotation id 前滚或回滚。
- **Z7 不加载过大的历史。** Flowly 从不通过 Paseo 读前任；agent 从不直接读 provider 文件。

保留的产品不变量：自动化不归档 session，也不主动打断（唯一例外是 §4 第 3 条、需用户决定的一次 steer；Paseo 0.12 的 steer 可能退化为 interrupt，见 AUTOMATION-SPEC §10）；daemon 的消息以 `[Flowly automation]` 开头；普通追问和评论发送用户原文；任务上下文在 session 创建时或经显式的 work-instructions 给出；一张卡一个 workspace；用户可以选择收件 session；顶层卡的 Done 由人决定。

AGENTS.md 随实现增加一行例外：“Agent automation may start a fresh Flowly-managed session of the card at the boundaries in docs/SESSION-HANDOFF-SPEC.md; the card's handoff record carries continuity.”（2026-10-24 用户决定）。

## 2. 测量：上下文、历史字节、压缩、空闲与缓存

新模块 `server/provider-usage.ts`（由 `server/provider-history.ts` 扩展而来）。所有读取都只读、有界，从不触发 Paseo 加载历史：`refresh()` 走 `fetch_agent`（不加载 session）；不取 timeline；文件读取有预算。解析器防御式编写，读不懂就返回 `unknown`，从不抛错；结果按 `(path, size, mtimeMs)` 缓存。

| 符号 | 含义 | Codex（含 `persistence.metadata.provider == "codex"` 的衍生 provider） | Claude Code | pi / omp | opencode、ACP |
| --- | --- | --- | --- | --- | --- |
| **C** | 最后一个请求的上下文 token | ① `lastUsage.contextWindowUsedTokens`；② job 上保存的上次测量；③（P2）文件尾最后一条 `info` 非空的 `event_msg/token_count`：`last_token_usage.total_tokens` | ①②；③ 最后一条主链（`isSidechain:false`）assistant 记录的 `input + cache_creation + cache_read + output`，按 `message.id` 去重 | ①②；③ 最后一条记录的 `usage.totalTokens` | ①② |
| **W** | 有效窗口 | `model_context_window`（已是 95% 有效值：sol 475,000，astra/luna 258,400） | `lastUsage.contextWindowMaxTokens`，否则模型清单（Opus 5.5 1,000,000，自动压缩约 967k；Haiku 4.5 200,000） | 仅实时 | 仅实时 |
| **B** | 磁盘上的历史字节 | 父 rollout（今天的测量）；子代理线程（P3，`~/.codex/state_5.sqlite` 的 `thread_spawn_edges`，只读 `mode=ro`，失败退回只测父线程） | 主转录 + `<sessionId>/subagents/**` + `<sessionId>/workflows/*.json`（只 `stat`，最多遍历 5,000 项，超出按 ≥ 200 MiB 处理） | `persistence.nativeHandle` 文件 | 未知 |
| **K** | 本 session 的 provider 压缩次数 | 回合结束钩子 timeline 里 `{type:"compaction", status:"completed"}` 的条数超过已存的数；或同一 session 两次回合结束之间 C 降到前一次的 60% 以下；（P2）文件里带 `latest_token_usage_record` 的 `compacted` 记录（不带的是子代理继承父历史，不算） | timeline（带 `preTokens`）；文件 `compact_boundary` | timeline | opencode：timeline |
| **I** | 空闲时间 | now − max(`job.sessions[role].lastTurnEndAt`，文件里最后一个请求的时间，若已读) | 同左 | 同左 | 同左 |
| **TTL** | 估计的缓存寿命 | 热 < 120 分钟；120–360 分钟只在 C < 200k 时算热；≥ 360 分钟冷 | 最后一次主链写入 `cache_creation.ephemeral_1h_input_tokens > 0` → 55 分钟后冷；`ephemeral_5m_input_tokens > 0` → 4 分钟后冷；读不到（P2 之前）→ 55 分钟 | 30 分钟 | 30 分钟 |

- **为什么不只用 `lastUsage`**：它只在 daemon 内存里，daemon 重启后恢复的 agent 没有它；压缩后它会下降，掩盖已经压缩过。所以每个受监督 session 的回合结束时 Flowly 做一次 `refresh()`，把 C、W、B、K、轮次和时间存到 job 的 `sessions[role]`（§6.1），重启后它是回退值。
- **文件尾读取**（P2）：从文件末尾按 1 MiB 块向前读，预算 16 MiB（C5b.3 的 1.18 GB 文件里最后一条 `token_count` 在末尾前约 9.3 MB）；超过 256 KiB 的行按长度跳过，不缓冲；按子串匹配行类型，不整行 JSON 解析。只在决定确实需要 C 而 ① ② 都没有时才读。
- **何时测量**：在每个边界、每个指令 id 测一次，决定缓存在指令上（session 忙而暂扣的发送不再重测）；回合结束时一次；运行中的 session 在已有的 60 秒 `watchHistory` 里测 B（一次 `stat`；Claude 的子代理目录每 5 分钟最多遍历一次，按目录 mtime 缓存），只在文件长了 1 MB 以上时才重测 C。
- **新 session 的代价 F**：约 108k token 的定向读取（C5b.3 #2），首个请求按 1.25× 写入缓存，之后按 0.1× 读。

## 3. 轮换触发与阈值

### 3.1 常量（`shared/session-rotation.ts`，不是项目设置）

```
rotationLimits = {
  bytes:  { rotate: 64 MiB, checkpoint: 128 MiB, noRead: 200 MiB, critical: 300 MiB },
  fill:   { checkpoint: 0.60, tight: 0.70, cold: 0.50 },          // 占有效窗口
  tokens: { tightMax: 300_000, coldMax: 250_000, coldResume: 100_000, minGrowth: 30_000 },
  tightGapMin: 20,                                                 // 上一回合结束 → 新指令
  minTurnsForSoft: 2, softPerRun: 4, bytesPerRunBeforeHold: 3,
  unknownProxy: { turns: 8, activeHours: 3 },                      // C 未知（opencode/ACP）
  finalize: { maxBytes: 128 MiB, noTurnStartMin: 10, noteAfterMin: 20 },
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
- **紧密**：`changes` 与评审者的 `round`，属于当前周期，且该角色 session 的上一回合结束 ≤ 20 分钟。
- **其它**：`start`（agent 重新排队）、`again`、`wake`、`comment`、`requested`（人点 Continue in a fresh session），以及超过 20 分钟的 `changes` / `round`、新周期的第 1 轮。
- **特殊**：`finalize`，只发给即将被换下的 session（§6.2）。

### 3.3 决策（纯函数 `rotationDecision`，第一条命中为准）

| 规则 | 条件 | 结果 | 收尾回合 |
| --- | --- | --- | --- |
| R0 强制 | session 已归档或不存在；换备用模型（§4.5）；中毒：失败回合的错误是上下文溢出 / prompt too long / HTTP 400 `invalid_request_error` / 历史无法恢复，或 session 加载后处于 `error`；B ≥ 200 MiB（不读不发） | 轮换（任何指令种类，包括后续） | 无 |
| R1 主机安全 | B ≥ 64 MiB | 轮换（任何指令种类） | 只在 B < 128 MiB 且满足 §6.2 的收尾条件 |
| R2 已压缩 | K 自 session 创建后增加，且它的 C 峰值 ≥ L_cold；只在**其它**边界 | 轮换 | 满足收尾条件时 |
| R3 上下文 | 紧密边界 C ≥ L_tight；其它边界 C ≥ L_cold；其它边界 C 未知时：≥ 8 个已完成回合或 ≥ 3 小时活动时间 | 轮换 | 满足收尾条件时 |
| R4 冷且大 | 其它边界，I ≥ TTL 且 C ≥ 100k | 轮换 | 无（冷） |
| R5 阶段 | 人的 Run again（§3.4）；新评审周期 → 新评审者；人点 Continue in a fresh session | 轮换 | 执行者满足收尾条件时；评审者从不 |
| R6 | 其它 | 保持 | — |

软规则 R2–R4 另须：该 session 已完成 ≥ 2 个回合，且 C 比它第一回合结束时的值（`firstC`）多出 ≥ 30k；同一次运行（generation）里软轮换最多 4 次，之后软触发被忽略、强制规则照常（§3.5）。紧密边界上的 Claude 5 分钟档 session 即使已冷也保持：评审循环本来就在重读，`L_tight` 限住了代价。

**从不触发**：泳道移动；provider 限额与宿主临时故障的重试；普通失败（同 session 重试）；紧密边界上的已有压缩（刚压缩的 session 最近一回合的细节还在）。

### 3.4 Run again

- 人的 Run again 默认**新执行者、新评审者**（提案的阶段规则；Multica rerun 的理由“人刚判定之前的输出不好”；C5b.2 的冷恢复）。AUTOMATION-SPEC §4.1 的“沿用上一次的 implementer 与 reviewer session”、§4.5 的“实现者沿用原 session”对人的 Run again 不再成立。
- 抽屉的 Run again 旁有 ⋯ → **Run again in session #n**：只在那个 session 活着、未因 R0/R1 被换下（不中毒、B < 64 MiB）时出现，旁边写测量的理由（例如 “236k tokens, idle 3 h: a fresh session is cheaper”）。人的选择优先，R0/R1 除外。
- 父卡的 `flowly_update_card action=start`（SUB-CARDS-SPEC §4）不算人的 Run again：保留 session，走 §3.3 的“其它”边界。
- Run again 之前若上一次运行异常结束（`failed`、`session_unavailable`、`taken_over`、`interrupted`、`cooldown`），对话框多一个可选的 “What should the next session know?” 文本框，写成人的交接便签（§5.4）。

### 3.5 防抖

- 软轮换的最少回合数与最小增长（§3.3），每次运行最多 4 次软轮换。
- 一次运行里第 3 次 R1 字节轮换 → `needs_human` / `interrupted`（现有的 state/code），另记可选字段 `hold: "history_runaway"`；新版本显示 “History kept growing too large in 3 sessions; see the card's pitfalls”，旧版本显示 interrupted。
- 每个角色每条指令最多轮换一次；决定缓存在指令 id 上。
- 新 session 的定向读取（约 108k）低于 sol 的 `L_cold`；258k 窗口上 `L_cold`（129k）接近它，所以要求 `minGrowth`。

### 3.6 用证据回放

- **C5b.3 #1**：第 1 回合因容量失败（4.4 MB），重试是后续，保持。第 2 回合 50 分钟长 322 MB：约 19 分钟到 64 MiB，之后每次 Flowly 工具结果带检查点提醒（§4）；约 28 分钟到 128 MiB，卡片记一条体积提醒（用户批准时再加一次 steer）。第 1 轮修改要求（B ≈ 327 MB）是 R1，≥ 128 MiB 不收尾，直接封存并轮换；接班者的首条消息和卡片上有 Flowly 的体积构成提醒（截图与 patch 写文件的次数和 MB）。最大的 session 约 327 MB（有 steer 时约 150–170 MB）；实际 1.18 GB，今天的守卫约 583 MB。
- **C5b.2**：18 个回合 48.8 MB，R1 从不触发；416 分钟后的 Run again 默认新 session（也满足 R3/R4），冷而不收尾；新 session 从约 108k 开始，而不是 430k 未命中缓存再立刻压缩。
- **普通卡**（C1–C4b、C5a.x，间隔 2.5–15 分钟，执行者峰值 44–80%）：只有 C ≥ 300k 的评审→修复边界轮换，此时 session 热，做收尾回合。估计约四分之一的执行者轮换一次（待测，§17.6）。“从简”方案用 62 个 Codex 卡片 session 模拟过相近的规则：50 个自动化边界里轮换 10 个（12 个评审→修复里 4 个），已接受提案的 50% / 30 MB / 1 小时是 21 个（12 个里 8 个）；模拟用每回合的峰值请求，压缩后的值偏高。

## 4. 回合内的保护（回合中途不能轮换）

1. **检查点提醒**（总是开启，零风险）：满足任一条件时记 `job.checkpoint = {agentId, reason, at}`，该 session 之后的每个 Flowly 工具结果都带 `handoffDue: "<reason>: update the handoff now (state, next, running)"`（现有 `reminders` 通道，不进 system prompt），直到有一次交接写入：
   - 填充 ≥ 60%（Codex 在 66–95% 压缩，压缩前记录要是新的）；
   - B ≥ 64 MiB 且按最近 3 次测量的增速 10 分钟内会到 200 MiB，或 B ≥ 128 MiB；
   - 回合活动 20 分钟没有交接写入；
   - HEAD 或未提交文件指纹自上次写入后变了。
2. **体积提醒**：B ≥ 128 MiB 时卡片记一次 `automation_history_large`（今天在 300 MB），自动化区显示 “Session history N MB: the next instruction goes to a fresh session”。B ≥ 300 MiB 仍在增长时显示严重信号 “Session history N MB, still growing: stop this session in Paseo”。`historyWarning` 加可选的 `level: "large" | "critical"`，每级每个 session 记一次。
3. **一次检查点 steer（待用户决定，§19；决定前关闭）**：在 128 MiB 或上面的增速预测处，每个 session 一次，`activeTurnBehavior: "steer"`：
   > `[Flowly automation] Checkpoint: this session's history is 131 MB and grows ~12 MB/min; Paseo crashes when it loads histories near 500 MB. Update the handoff now (flowly_update_handoff: state, next, running), stop the loop that produces the bulk (screenshots, relayed commands, files written with your edit tool), and end this turn. Flowly continues in a fresh session.`

   这是 Flowly 第一次有意往进行中的回合里发消息，而 steer 在 Paseo 0.12 可能退化为 interrupt。不开启时，单个回合仍可能超过 500 MB，只有 Paseo 自己的修复能补上。
4. **Skill 卫生**（扩展 AUTOMATION-SPEC §4.6 的 Skill 一条）：截图、DOM 和日志写到文件；不通过自己的工具或 Codex 子代理转发浏览器命令；**批量文件（fixture、抓到的响应、生成的数据）用脚本或 shell 生成，绝不用编辑/patch 工具，包括 code-mode `exec` 里调用的 `apply_patch`**：Codex 会把它们的全文记进历史（C5b.3 的 519 MB）。

`watchHistory` 的范围扩大到：当前活动的 session、job 的评审者、本卡正在回合中的被换下 session。

## 5. 交接记录

### 5.1 存放位置

- 每卡一个文件 `plugin-data/flowly/handoffs/<taskId>.json`，按卡串行写入，临时文件 + rename，0600；读不懂的文件保留、不重置（写入返回 `HANDOFF_UNAVAILABLE`）。同 `SummaryStore` 的做法。
- 每卡一个目录 `plugin-data/flowly/handoffs/<taskId>/`：`images/`（开工图片、能拿到的 session 图片，每卡最多 20 个文件、20 MB）、`sealed/<rotationId>.json`（轮换时的封存快照）、`skeletons/<agentId>.jsonl`（§8）。
- **不放进 `board.json`**：手机解码每一次看板读取（board.json 今天 1.5 MB）；旧版本重写 board.json 会丢掉不认识的字段，而独立文件不受影响，降级后记录仍在。`board.json` 只多一个小索引：顶层数组 `handoffIndex: { taskId, revision, updatedAt, fresh, open, sessions }[]`（约 150 字节/卡），随 etag/delta 读取到达客户端（`server/board-delta.ts` 的 keyed 集合加一项，按 `taskId`），卡面据此显示 “Handoff stale”。看板 schema 不严格，旧版本丢掉它，由文件重建。
- 抽屉只在 Handoff 区展开时用 etag RPC `handoffs.read {taskId, etag?}` 读。人的写入：`handoffs.note`、`handoffs.input`（把一条人的话标为 done / superseded）、`handoffs.removeNote`。
- 删卡、移除项目时删除文件和目录，记录本身（不含骨架和图片）随删除备份写入 `removed/`。wrap up 与归档保留。项目文件夹快照（[PROJECT-FOLDER-SPEC](PROJECT-FOLDER-SPEC.md)）**不**包含它（里面有人的原话；§19）。

### 5.2 结构（`shared/handoff.ts`，zod，有界）

```
CardHandoff {
  version: 1, taskId, projectId,
  revision: int,                         // 自己的 revision（同 workpad），不改 task revision
  updatedAt, updatedBy: { kind: agent|human|flowly, agentId? },
  checkpoint?: { agentId, at, head?: sha12, dirtyHash?, turnStartedAt? },   // 上一次 agent 写入时的状态

  // —— 当前执行者写（每个条目都有 id、by、agentId?、at、rev）——
  state?:    { text ≤1200 }                                   // 一段话：现在到哪了、正在跑什么
  done:      { id "dn-*", text ≤300, ref? ≤200 }[] ≤30        // ref：SHA、artifact id、路径
  decisions: { id "dc-*", text ≤300, why ≤400（必填）, source?（输入 id） }[] ≤30
  ruledOut:  { id "ro-*", text ≤300, why ≤400（必填） }[] ≤20 // 试过并放弃的做法
  problems:  { id "op-*", text ≤400, status: open|resolved, note? ≤300 }[] ≤20
  next:      { id "nx-*", text ≤300, gate? ≤200 }[] ≤12        // 有序；gate：先要满足什么
  pitfalls:  { id "pf-*", text ≤400 }[] ≤20                    // 硬规则与危险；人的长期指示加引号并注明谁、何时说的
  running:   { id "rf-*", what ≤200, how ≤300, check ≤200, owner: agentId, startedAt, status: running|done|unknown, endedAt?, result? ≤300 }[] ≤12
  where:     { id "wh-*", ref ≤300（路径|artifact id|URL）, what ≤200 }[] ≤30
  env:       { id "ev-*", text ≤300 }[] ≤12                    // 安装、服务、版本、密钥放在哪（从不写密钥本身）
  // 以上合计 ≤ 16,000 字符（HANDOFF_TOO_LARGE 给出各段大小）；skill 建议通常 ≤ 4,000

  // —— 人、Flowly、被换下的 session 追加（带时间）——
  notes: { id "nt-*", at, by: { kind: human|flowly|agent, agentId? }, kind: incident|direction|environment|hazard|background|checkpoint|other, text ≤2000 }[] ≤100
  gaps:  { id "g-*", at, by: reviewer|successor|answerer|flowly, agentId?, text ≤300, status: open|closed }[] ≤40

  // —— Flowly 派生，agent 不能写 ——
  inputs: { id "d-*", at, via: session|comment|launch|composer|retired_session, agentId?, commentId?, messageId?,
            text（原文，脱敏，≤10000）, images?: string[] ≤6, imagesLost?: int,
            status: open|received|done|answered|superseded|declined,
            handled?: { by: { kind, agentId? }, at, note? ≤300 } }[] ≤200
  reviews: { cycle, round, level?, panel?, reviewerId, verdict: approve|changes|incomplete, summary ≤4000,
             findings: { id "c<cycle>.<round>-<k>", text ≤1000, status: open|done|obsolete }[] ≤20,
             risks: string(≤500)[] ≤10, gaps: string(≤300)[] ≤5, deliveryEvent?, at }[] ≤30
  ledger: { agentId, n, role, provider, model?, startedAt, endedAt?, reason, endReason?,       // session 台账
              measured: { C?, W?, B?, K?, turns, peakC? }, finalized: boolean, handoffRevisionAtEnd?,
              background: { id "b-*", kind: async_shell|exec_session|browser_tab|terminal|script|subagent|schedule, ref, label ≤120, startedAt, closed? }[] ≤40,
              anchors?: string[] ≤60, growth?: { kind, calls, bytes }[] ≤12, nextMoves?: string[] ≤3,
              skeleton?: path, ack?: Ack, understanding? ≤800 }[] ≤200
  git?:   { branch?, head?, dirty, dirtyFiles: path[] ≤50, diffstat? ≤1000, upstreamDiffers?, at }
  lastWords?: { agentId, at, text ≤2000 }                    // 只用于异常结束的兜底（§5.8）
  tombstones: { section, item, removedBy, reason ≤200, at }[] ≤300
  seen:  { [agentId]: revision }  ≤200                       // 这个 session 读到过的 revision（§5.9 的存根）
  digests: { [agentId]: string[] ≤500 }                      // 已捕获的人的消息摘要（§5.7）
  ops: string[] ≤50                                          // 最近的 operationId（重放）
}
```

- 人的话在 `inputs` 里存原文：评论的事件只保留最近 50 条（CARD-COMMENTS-SPEC §7.2），记录不能依赖它。
- 有上限的列表（`inputs`、`notes`、`ledger`、`reviews`、`tombstones`）满了时，最旧的、不是 open 的条目移入同目录的 `archive.jsonl`，不删除（Z5）；`handoff:"full"` 与抽屉的 Show earlier 读得到。open 的条目从不移出。
- `reviews` 的长度与 `reviewInputSchema` 一致（摘要 4,000、每条发现 1,000、最多 20 条），不截断；最坏约 750 KB/卡，不在看板读取里。今天只有最近一次的 `job.changes` 留下，人的反馈开新周期时还会删掉它（`turnStarted`），更早的修改要求落出 100 条事件窗口后就没了。
- 另外，`store.event()` 给评审结论事件（`automation_changes_requested`、`automation_review_approved`、§5.2 的 `automation_review_risks`）一个单独的保留类：每卡最新 10 条在 100 条窗口之外（同评论），活动里看得到所有轮次。旧版本按 100 条裁剪它们，无害。

### 5.3 预算

| 内容 | 上限 | 通常 | 理由 |
| --- | --- | --- | --- |
| agent 写的各段合计 | 16,000 字符（硬） | 2–6k | 管用的那份 §8 约 2,967 字符；Flowly 每条链接的 handoff 预算已是 6,000、总共 16,000 |
| `get_task` 的默认交接视图 | 20,000 字符，按优先级截断并写明省略 | 3–8k | 每个修订只给一次（§5.9） |
| `handoff:"full"` | 96 KB | — | 按需 |
| 整个文件 | 约 1 MB 最坏 | 20–60 KB | 不在看板读取里 |
| 每个 session 的骨架 | 2 MB | 1.18 GB 的线程约 37 KB | §8 |

### 5.4 谁写、何时写

| 写的人 | 写什么 | 何时 |
| --- | --- | --- |
| 当前执行者（`flowly_update_handoff`） | 各段、`note`、输入的处置、接手确认（`ack`） | 读完卡后（state、next）；**每次提交后**；**开始预计超过 5 分钟或在后台运行的事之前**（并写 `running`）；做出决定或放弃一个做法时；处理完人的一条话时；收到 `handoffDue` 时；每个工作回合结束前（清单第 5 条）；收尾回合里 |
| 被换下的 session | 只能写 `note`（checkpoint / background）和更新自己的 `running` 条目 | 被唤醒时（§9.3） |
| 评审者 | 不能写（`REVIEWER_ONLY`）；经 `flowly_submit_review` 报告 `handoff.gaps` | 每一轮 |
| 人（抽屉） | `note`（direction / incident / environment / other）；把输入标为 done 或 superseded；删除自己的便签 | 任何时候；Run again 的 “What should the next session know?”（§3.4） |
| Flowly | 派生字段；incident / hazard 便签（例如 “Session #1's history grew to 327 MB: browser_screenshot 1,346 calls 471 MB, apply_patch adds 9,870 files 519 MB”）；台账；gaps（answerer / flowly） | 回合结束钩子返回之后（同 `WorkpadService.recordTurn`，从不阻塞钩子）；轮换时；评审结论的同一事务里（`reviews`）；意外结束时 |

### 5.5 新鲜与过期

记录**过期**指上次 agent 写入（`checkpoint`）之后发生了**实质变化**：
- HEAD 或未提交文件指纹（`git status --porcelain` 的哈希）变了；
- 出现了状态为 `open` 的人的输入、新的评审结论或新的交付；
- Flowly 写了 incident / hazard 便签；
- 一个活动时间 ≥ 15 分钟的回合结束了，而这个回合里没有交接写入。

“上一回合比记录晚结束”本身**不算**过期：agent 按清单在回合结束前写入，否则几乎每份记录都算过期，收尾回合就会在大多数轮换上触发。

**交付门 `HANDOFF_STALE`**（软的，与 `WORKPAD_OPEN` 同一套 `DeliveryGate` 机制，原因合并为一次拒绝）：开启自动化的项目里，执行者的 `flowly_update_status(in_review | blocked)` 与 `flowly_report_progress(kind=blocker)` 在记录过期、缺 `state` 或 `next`、或接班者还没确认接手（§7.5）时第一次被拒，列出变了什么；同一回合带 `acknowledgeOpen=true` 的重试通过。提问（`kind=question`）不受此门约束，只带提醒，因为问题常在工作中途。拒绝说明自己写明怎么做（“update the handoff with flowly_update_handoff, then retry with acknowledgeOpen=true”），所以清单第 6 条不必改（改了就超过 1,800 字符，§13）。

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
  inputs?: { id, status: done|answered|superseded|declined|open, note? }[] ≤30,
  ack?: Ack }                                   // §7.5
→ { ok, handoffRevision, replayed?, at, head, budget: { used, max },
    open: { inputs, findings, running, gaps }, handoffDue: null | string, ackMissing?: id[] }   // ≤ 1 KB
```

- **合并**：`handoffRevision` 落后时，只要本次碰到的条目自那以后没变（每个条目有自己的 `rev`），照样应用；否则 `HANDOFF_CONFLICT`，给出这些 id 和 ≤ 2 KB 的差异。Flowly 频繁的派生写入和人的便签因此不会与 agent 的编辑冲突。
- **小回执**：不回显 `current`。今天一次“读卡 + 写入”约 220 KB 的历史，交接写入约 1–3 KB。
- 不写看板事件（不占 100 条事件窗口），只在 flow log 记 `handoff_updated`（同 `workpad_updated`）。
- 被换下的 session 只能用 `note` 和更新自己 `owner` 的 `running` 条目，其它返回 `RETIRED_SESSION`；评审者返回 `REVIEWER_ONLY`；归档的卡 `ARCHIVED`；Done/Cancelled 的卡只接受 `note`，其它 `TASK_FINISHED`。项目关闭了 workpad 时仍可写交接。

### 5.7 Flowly 在每次回合结束时派生什么

对本卡**每个** Flowly 管理的 session（人开的、不受监督的、被换下的都算），在已有规则之后、不阻塞钩子：

- **人的话**：钩子 timeline 里的 `user_message`，去掉以 `[Flowly automation]` 开头的、async-shell 通知（`[async-shell …`）和 `<paseo-system>` 通知、以及 Flowly 路由的评论原文（按发送时的 `messageId` 匹配）。每条成为一个输入（`via: session`，被换下的 session 为 `retired_session`），按每个 agent 的摘要集合（最近 500 条，存在交接文件的 `digests` 里）去重：钩子带的是 agent 的整个内存 timeline，而重启后 timeline 会重建，所以不用游标计数。状态：
  - 打进**当前工作 session**、而接收它的回合**正常完成** → `received`（那个 session 已经据此行动；接班者看得到原文，不必逐条确认）；
  - 回合失败或取消、session 被换下或不是工作 session、job 没有当前工作 session → `open`。
  - 打招呼一类的短话因此不会变成一串要确认的待办。
- **Flowly 自己输入框发出的消息**在发送时就记下（回合永远没结束也不丢），回合结束时按摘要去重。
- **图片**：`user_message` 只有 `text`、`messageId`、`clientMessageId`（`@getpaseo/protocol` `agent-types.d.ts:308-311`），图片本身拿不到。粘贴的图片在部分 provider 的文本里是占位 `[Image: source: /path.png]`（`shared/images.ts` `extractImages`）：Flowly 把这些本机图片文件（图片扩展名、≤ 8 MB、每条 ≤ 6 个）复制进 `images/`；没有占位的图片记为 `imagesLost`，抽屉写 “image attached, not kept”。开工图片在 `AutomationLaunches.collect()` 删除 launch 文件**之前**复制进来；经 Flowly 输入框发送的图片同样保留。
- **后台任务清单**：本回合里启动长期东西的工具调用：`register_async_shell` / `cancel_async_shell`、Codex `exec_command` 的 session、`browser_new_tab` 对 `close_tab`、`create_terminal`、`start_workspace_script`、`create_agent`、`create_schedule`、`create_heartbeat`。每个成为台账里的一条 `b-*`，带 closed 标记；标签脱敏，最多取命令前 120 个字符。`[async-shell finished|failed|timed_out <task>]` 通知把对应条目标为 closed，并给 `running` 条目写上结果。
- **git**：HEAD、分支、未提交文件（≤ 50）、diffstat、是否与上游不同；参数数组、5 秒超时，复用 workpad 的 `env` 读取。
- **台账**：回合数、C、W、B、K、模型。
- **锚点**：从 agent 消息里按正则取 SHA（7–40 位十六进制）、PR/issue URL、分支、路径和 `Error:` 行，每个 session ≤ 60 条。
- `handoffIndex` 的 `fresh` 与 `open` 在此时更新。

### 5.8 意外结束时的确定性补记

session 消失、被归档、崩溃（没有回合结束）、中毒或达到 200 MiB 时，Flowly 封存它的台账条目（`endReason: session_unavailable | crashed | poisoned | quarantined`），并写一条 incident 便签：
- 交接上次写入的时间、卡片沉默了多少分钟；
- 现在的 HEAD 对比它最后一个回合开始时的 HEAD；
- 最后一条进度记录的时间；
- 仍未关闭的后台条目；
- 体积构成（一次流式读取，在后台低优先级运行，只对 B ≥ 64 MiB 或异常结束的 session 做，§8.1）。

同时填 `lastWords`：前任最后 ≤ 3 条 agent 消息，≤ 2,000 字符，脱敏，标为 “unverified narration”；来自最后一次钩子 timeline，没有则来自骨架。骨架里在最后一次捕获之后的人的消息补成 `open` 输入（崩溃中途的回合里人说的话因此不丢）。

### 5.9 `flowly_get_task` 里的交接

- 输入增加可选的 `{ handoff?: "full" }`（工具输入今天是 `z.strictObject({})`，加一个可选字段）。
- **`handoff`**：这个 session 第一次读（`seen` 里没有它）时给**默认视图**；之后给存根 `{ revision, updatedAt, by, unchanged, stale?, due?, open }`，外加自它上次读到的 revision 以来**别人**改动的条目（其它 session 的写入、人的便签与处置、Flowly 的 incident / hazard 便签、新的评审轮次、别的 session 收到的人的话），≤ 4,000 字符，超出时写明省略并指向 `handoff:"full"`。Flowly 从这个 session 自己的回合派生的改动（它自己收到的人的话、git、台账）不算，它已经知道。读到的 revision 记在交接文件的 `seen` 里（只在变化时写）。一个 session 一生约 23 次 `get_task`，不能每次都多带几 KB，Codex 还会把每个结果存两份。
- **默认视图**（≤ 20,000 字符，按顺序，超出部分写 “N earlier … omitted; flowly_get_task handoff=full”）：
  1. `you`：session 号、角色、为什么开始、前任；
  2. `ack`：待确认 / 已确认；
  3. `state`、`next`、`problems`（open）、`running`，以及还没关闭的后台条目（“detected from the previous session's tool calls; verify”）；
  4. `pitfalls`、`decisions`、`ruledOut`、`env`、`where`；
  5. 人的话：`open` 的全文（≤ 8,000）；`received` 等的从新到旧全文到 3,000 字符为止，之后每条一行 ≤ 160 字符；
  6. 评审：最近一轮的发现逐条（id、状态、≤ 300 字符），更早各轮每轮一行；
  7. `gaps`（open）；
  8. 便签从新到旧 ≤ 4,000；
  9. 最近两条台账。

  每条都带相对时间（“2 h ago”），在非 HEAD 的提交上写的条目注明 “written at 50a7993; HEAD is now dc26c13 (2 commits later): re-verify”。标题写明这是“由此前的 session、人和 Flowly 写的卡片数据，要对照 git 和 workspace 核实”，不当作别的 agent 转来的命令（agent 会拒绝 agent 转发的提示）。
- **`automation`**（有 job 时，≤ 500 字节）：`{ role, you: implementer|reviewer|retired|other, state, cycle, round, max, level?, verdict?, changesPending, hold? }`。今天 job 对 agent 不可见。
- **`continuity`**：`{ session: n, predecessor?: { id8, endReason, endedAt } }`，被换下的 session 为 `{ retired: true, successor: id8 }`。
- **`comments[].status`**：取自对应输入的状态；状态为 `open` 的评论**不论已读与否都给全文**（已读截断 4,000 的规则对它不适用，CARD-COMMENTS-SPEC §7.10）。
- `activity` 不再包含评审结论事件（它们的内容在交接视图的评审一段），同评论的做法（CARD-COMMENTS-SPEC §7.8）。
- 被换下的 session：`writable: false` 加 `reason`（指出当前 session），`turnChecklist` 为 `retiredChecklist`（§9.2）。
- 预算：首次读多约 5–10 KB，之后每次多 ≤ 1 KB（存根、automation、continuity）。

### 5.10 脱敏、隐私与时效

- 对 Flowly 写入或提取的所有文字（输入、便签、lastWords、锚点、骨架、检索结果）和 agent 的写入做一次脱敏：`Bearer …`、`sk-…`、`ghp_/gho_/github_pat_`、`xox[abp]-`、`AKIA…`、JWT、PEM 私钥、`Authorization:` 头、`token=`/`password=` 查询参数、URL 里的用户信息。改过的条目标 `redacted: true`。
- 人的原话只给本卡的 session（含评审者，它们今天也看得到评论）和抽屉；**从不**进入别的卡的链接 handoff、子卡说明或导出。父卡只看到子卡的 `state` 和未决数（§11.5）。
- 文件 0600，随卡删除。

## 6. 轮换过程（状态机的改动）

### 6.1 job 新字段（全部可选；job 是非严格对象，旧版本丢掉；不新增 `state` / `code` 值）

`state` 与 `code` 是看板 schema 里不带 `catch` 的 `z.enum`，新值会让旧版本拒绝整个 `board.json`，所以阶段放在新字段里，job 在整个轮换期间保持原来的状态（`starting`、`working` 或 `reviewing`）。

```
instruction.kind?: start|again|nudge|retry|cooldown|host_retry|changes|round|wake|comment|requested|finalize
instruction.verbatim?: true                       // 人的原文（路由的评论）：不带 [Flowly automation] 前缀
sessions?: { implementer?: SessionMeta, reviewer?: SessionMeta }
  SessionMeta { agentId, n, since, reason, turns, firstC?, lastTurnStartAt?, lastTurnEndAt?, lastOutcome?,
                measured?: { at, C?, W?, B?, K? }, ttl?: "1h"|"5m"|"openai"|"unknown", run?: string }   // run：插件进程的启动 id
rotation?: { id: "rot:<taskId>:<generation>:<role>:<n>", role, from, trigger, forced, boundary: tight|other|forced,
             phase: finalizing|sealing|creating, carry: { kind, text, fresh, reviewDelivery?, verbatim? },
             finalize?: { instructionId, sentAt?, turnStarted? }, facts: { C?, W?, B?, K?, idleMin?, ttl? }, at }
retired?: { agentId, role, n, at, reason }[] ≤50  // 被换下的执行者与评审者（与板上事务原子写入）
rotations?: { soft, forced, bytes }               // 本次运行
rotateRequested?: { at }                          // 人点了 Continue in a fresh session
retiredTurn?: { agentId, at }                     // 被换下的 session 正在回合中：Flowly 暂扣对本卡的发送
checkpoint?: { agentId, reason, at, steered? }
hold?: "history_runaway"
pendingInputs?: string[] ≤20                      // 轮换期间到达的输入 id
ackDue?: { agentId, since }
historyWarning.level?: "large" | "critical"
handoffGaps?: string[] ≤5
```

`reviewers`（≤ 20）照旧写入，旧版本的行为不变。提高它的上限会让旧版本解析失败，所以另设 `retired`（≤ 50）；守卫同时读 `retired`、`reviewers`、交接台账和 label（§9.1），没有 20 条的断崖。

### 6.2 阶段

| 步骤 | 做什么 | 事件 |
| --- | --- | --- |
| 0 决定 | 在 `send()`、`begin()`、`wake()` 或评论路由里：刷新快照，测量（§2），`rotationDecision`，结果缓存在指令上。 | — |
| 1a 收尾（满足条件时） | 一个事务里：`rotation = { phase: finalizing, carry: 当前指令 }`，`instruction = { kind: finalize, text: finalizePrompt }`。发送规则同任何指令：本 session 和对方角色都空闲，稳定的 messageId。 | `automation_handoff_requested`（“Asked session #2 to update the handoff before a fresh session takes over: context 68% of 475k”） |
| 1b 收尾回合 | `from` 开始回合时：不适用 A1、不算接管、不重开。这个回合里除 `flowly_update_handoff`、`flowly_get_task`、`flowly_session_history`、`flowly_report_progress kind=progress` 之外的卡片写入返回 `FINALIZING`（“Only update the handoff in this turn; the card continues in a fresh session”），所以不会出现收尾回合里的交付。回合结束（任何结果）→ 封存；本回合里这个 agent 提高了交接 revision 就记 `finalized: true`。回合里 HEAD 或未提交文件变了 → Flowly 记一条便签，照常继续。不做 `turnDecision`（不提醒、不判交付）。 | — |
| 1c 收尾没发生 | 发出 10 分钟后 session 空闲且没开始回合（经已有的漏钩子恢复判断）、或 session 消失 → 以 `finalized: false` 封存。收尾回合**正在跑**时从不打断；20 分钟时记一次便签 “The handoff turn is taking long”，继续等。接班者在 `from` 还在跑时永远不会被创建（步骤 3 的暂扣）。 | — |
| 2 封存 | 先写交接文件（以 `rotation.id` 为键，重放不改变任何东西）：台账条目（`endReason`、测量值、`finalized`、`handoffRevisionAtEnd`、后台条目、未用的 next moves 标签）、封存快照、`git`。**然后一个看板事务**：`from` 推入 `retired`（评审者同时用 `retireReviewer` 记入 `reviewers`），删除 `implementerId`（或 `reviewerId`），`phase: creating`，`instruction = successorMessage(carry, …)`（§7.2），先记 `pendingOp` / `pendingRole`（同今天），执行者设 `ackDue`。 | — |
| 3 创建 | 已有的 `create()` 路径：prepared op → 稳定的 agentId、idempotencyKey、`exists()`、Full access、labels；preparation 带连续性说明（§7.1）。本卡任一被换下的 session（最新 5 个）在跑、初始化、回合中或等权限时暂扣，指令留着，15 秒的派发再试。 | — |
| 4 提交 | 接班者被确认（第一个回合开始或创建确认）：删除 `rotation`；`sessions[role] = { n+1, reason }`；播种已读（§7.4）；把 `from` 在 Flowly 输入框队列里的条目改到新 agentId；`from` 未用的 next moves 在卡面上隐藏（标签已在台账）；只在异常结束或 B ≥ 64 MiB 时排队建骨架（其它情况按需）。 | `automation_rotated`（note：原因、测量值、“handoff updated in a handover turn” 或 “handoff not updated: <why>”） |
| 5 确认 | 接班者的第一个回合，每个 Flowly 工具结果都提醒确认接手，直到确认（§7.5）。 | `handoff_acknowledged`（“Session #3 acknowledged: 6 items, 1 question”） |

**收尾条件**（全部满足）：软触发（R1 < 128 MiB、R2、R3、执行者的 R5），不是评论边界（有人在等）；session 热（I < TTL）；已加载（它最后一个回合在本插件进程运行期间结束：`sessions[role].run` 等于当前运行 id；daemon 重启后给它发消息会让 Paseo 整个加载历史）；最后一个回合正常完成；记录过期（§5.5）；B < 128 MiB。

收尾说明（daemon 英文）：
> `[Flowly automation] Before a fresh session continues this card (<reason>), bring the card's handoff up to date with flowly_update_handoff: state, next (ordered), decisions and ruled-out approaches with reasons, open problems, pitfalls, what is still running (async shells, exec sessions, browser tabs, scripts, sub-agents: how to check or stop each; stop only those whose result is already on disk), where things are, and environment facts. Do not change files or the card's status and do not start new work; end your turn after the write. If a notification wakes you later, record what it said with flowly_update_handoff (note) and end your turn.`

### 6.3 强制轮换

- 备用模型、中毒、≥ 200 MiB 跳过步骤 1，直接封存。`switchToFallback`（AUTOMATION-SPEC §4.5）和今天的 `rotate()`（§4.6）都改为调用同一个 `beginRotation(job, role, reason, { finalize })`；`takeoverNote` 与 `rotationNote` 缩成指向连续性说明的一句。
- 被归档的执行者仍是 `failed` / `session_unavailable`，加上封存和 incident 便签；不自动继续，因为崩溃需要人。人的 Run again 再用记录开新 session。

### 6.4 回滚

- **软触发**的创建明确失败（不是未知结果）、启动重试预算用完时（今天 `start_failed` 会让 job 失败）：重新采用 `from`：角色 id 改回 `from`，从 `retired` 移除，`instruction = carry` 作为 `text` 发给它；删除 `rotation`，记 `automation_rotation_abandoned`（“The new session could not be started; the implementer continues in its previous session”）。旧 session 是健康的，job 不必失败。
- **强制触发**不回滚，走今天的失败处理；**未知结果**不回滚（接班者可能已存在），照今天进入 `needs_human`，`rotation` 保留。

### 6.5 幂等与对账（补充 AUTOMATION-SPEC §4.4）

| 对账时看到的阶段 | 做什么 |
| --- | --- |
| `finalizing`，指令还没发出 | 用同一个指令 id 发出。 |
| `finalizing`，已发出，3 分钟没有回合开始，session 空闲 | 已有的恢复（session 的 error / attention 状态）判断是否有回合结束；没有则按 1c。 |
| `finalizing`，回合在跑 | 等。 |
| `finalizing`，session 归档、消失或 ≥ 200 MiB | 不收尾，直接封存。 |
| `sealing` | 台账里已有 `rotation.id` 就只做看板事务，否则先封存。 |
| `creating` | 已有的 `pendingOp` 路径：同一个 op、同一个 agentId；未知结果 → `unconfirmedStart` 与 `needs_human`（今天的做法）；`rotation.carry` 一直保留，不丢、不盲发。 |
| `retiredTurn` 超过 6 小时没有回合结束 | 清除（同 `subCardActive` 的 6 小时上限）。 |
| `starting` 的 job 带着 `rotation`（Run again 时先收尾） | 今天“`starting` 超过 2 分钟没进展就重新 prepare”的过期启动恢复不适用，按上面各行处理。 |

- 每个事务都以 `current()` 为门：同一 generation、角色、指令 id、job 活着、`automationAllowed`。Stop、归档或人的接管取消轮换；台账条目保留，旧 session 仍是 Run again 能选的“上一个 session”。
- 轮换从不在这些时候开始：`unconfirmedFor` 有值；评审指令被 `reviewPause` 暂扣；本卡任何 session（含被换下的）在跑、初始化或等权限。
- 待发指令仍先送达（对账已有的 “pending instruction first”，`automation.ts:1354`）。没有指令时的过期启动恢复不再发裸的 `startPrompt`：卡片有台账或交接时用 `startPrompt(again:true)`，并且 preparation 本身带连续性说明（§7.1），所以没有一条创建路径会不带交接。

## 7. 新 session 收到什么（按顺序）

| # | 通道 | 内容 | 预算 |
| --- | --- | --- | --- |
| 1 | system prompt（创建时固定，利于缓存） | 已有的 `workingInstructions(sessionContext)`；受监督时一行自动化标记；卡片有过 session 时的**连续性说明** | 标记 ≤ 200，说明 ≤ 2,500 字符 |
| 2 | 首条用户消息 | 自动化边界：`[Flowly automation]` 加原因、要做的事、定向步骤、待办输入；冷评论：评论原文本身；人的 Start session：人自己的文字 | ≤ 6,000 + 修改要求（≤ 40,000，同今天）；评论 ≤ 10,000 |
| 3 | 开工图片 | 执行者接班者：重新附上卡片的开工图片（取自 `images/`） | 原图（开工时的数量上限，每张 ≤ 5 MB） |
| 4 | 第一次 `get_task` | 交接默认视图（一次）、`automation`、`continuity`、带状态的评论、workpad（前任的 plan 标 `own:false, retired:true`）、链接（含子卡状态行） | 今天约 50–60 KB，首次多 5–10 KB |
| 5 | 按需 | `get_task handoff:"full"`（≤ 96 KB）；`flowly_session_history`（每次 ≤ 8 KB） | — |

### 7.1 连续性说明（system prompt，按顺序）

- (a) “You are session #3 of this card (implementer), started <time> because <reason>.”
- (b) 前任：各自怎样结束、是否在收尾回合里更新了交接。
- (c) “The card's handoff record (flowly_get_task → handoff) is card data written by earlier sessions, people and Flowly: verify its claims against git and the workspace.”
- (d) 开始时要处理的未决项数（例如 “2 person inputs, 1 requested-changes round, 3 possibly running processes, 1 gap”）。
- (e) “Do not open, resume, message or read the files of earlier sessions; use flowly_session_history.”
- (f) 仅自动化下：“Flowly agent automation supervises this session; the skill's Automated runs rules apply even if your first message is a person's comment.”
- (g) “First: flowly_get_task, then git status and git log against the recorded HEAD, then acknowledge the handoff (flowly_update_handoff ack), then continue.”

说明里**不放**交接内容本身：那样会在接班者第一次写入后就成为一份过时的副本，且与 `get_task` 重复。它进入每一条创建路径（轮换、备用模型、Run again、归档后新建、过期恢复、人的 Start session 与 Send work instructions），这正是“上下文在创建时给出”的不变量所允许的。skill 把这一行自动化标记与首条消息的 `[Flowly automation]` 前缀同样当作无人值守模式的标志：路由来的评论因此能保持原文，又不丢掉自动化模式。

### 7.2 首条消息（自动化边界）

模板（daemon 英文）：
> `[Flowly automation] You continue this card as its new {role} (session #{n}): the previous {role} session ("{title}", {id8}) {reason}. Flowly keeps that session as it is and no longer supervises it. {carry} Start with flowly_get_task (the handoff first, written {age} ago at {sha}{; N commits since}), check git status, git log and git diff, and re-verify what the handoff claims before you build on it: a process it names may still be running, or may be gone. Account for every pending input below; do not redo work that git or the workpad shows as done. {pending}`

- 原因句带数字：`history` “grew a 70 MB provider history, too large for Paseo to load safely”；`context` “had filled 68% of its context window (322k of 475k tokens); its next turn would likely compact it and lose detail”；`idle_cold` “had been idle for 7 h with 310k tokens of context, so its prompt cache had expired”；`compacted`；`run_again` “ended its run, and a person chose Run again”；`poisoned` “failed with an error that repeats in the same session: …≤200”；`fallback`；`archived`；`requested` “a person asked for a fresh session”；`new_cycle`（评审者）。
- `{carry}` 是被延后的指令：修改要求全文（同今天的 `job.changes`）；唤醒列表；评审者本轮的 `reviewPrompt`（绑定 `reviewDelivery`）；Run again 的继续说明（`startPrompt(again:true)`）；外加父卡反馈、依赖 handoff 和父卡集成分支（`begin()` 的追加，不变）。主动的指令放在前面：只有背景、没有指令时模型会闲着或只叙述（Hermes #100818）。
- `{pending}`：未处理输入的 id 和首行，≤ 2,000（全文在 `get_task` 里）。
- 只在 §5.8 的兜底情形：“Last words of the previous session (unverified): …” ≤ 2,000。
- `begin()` 的从头开始的 `fresh` 只用于卡片没有台账、没有更早 job 的情形（修复 `automation.ts:835`：今天 Run again 遇到已归档的执行者时，新 session 被告知“从头到尾”做，没有交接）。

### 7.3 冷评论与人开的 session

- 冷评论建的新 session：首条消息就是评论原文（`instruction.verbatim`），连续性和自动化标记都在 system prompt。
- 人的 Start session：首条是人自己的文字，system prompt 里同样有连续性说明。

### 7.4 已读状态

`ArtifactReadStore` 每个 agent 只存一个读卡时间（`reads: record<string,string>`，`server/artifact-reads.ts`）。提交时（新 agentId 还没有记录才做，幂等）：前任最后一个回合在它的读卡时间之后正常完成 → 用前任的读卡时间；否则用 min(前任读卡时间, 前任最后一个回合的开始时间)。所以只在崩溃的回合里读过的评论对接班者仍是未读。逐条的“已处理”不放进这个文件（改值的形状会让旧版本报 “Artifact read data is invalid”），而是靠交接输入的状态：`open` 的评论不论已读与否都给全文并标出（§5.9）。

### 7.5 接手确认（ack）

在接班者的第一次交接写入里：

```
ack: { handoffRevision, head: { sha, dirty },        // git rev-parse --short=12 HEAD / git status
       understanding: ≤800,                           // 用自己的话说现状和第一件要做的事
       items: { id, disposition: doing|done|obsolete|ask, note? ≤300 }[],
       questions?: string(≤300)[] ≤5 }
```

- 要处置的只有：状态为 `open` 的输入、最近一次修改要求里未完成的发现、未结束的 `running` 和未关闭的后台条目、open 的 gaps。`received` 的人的话、`problems` 等不要求逐条处置，避免把确认变成清单负担。
- 机械核对：`head.sha` 与 Flowly 自己读的不一致 → `ACK_MISMATCH`（给出 Flowly 的值，本次写入不记录，改了重发即可）；漏掉的 id → 已给的照常记录，回执的 `ackMissing` 列出其余，确认在全部处置后才算完成；`done` 与 `obsolete` 需要 `note`。
- 效果：处置更新对应条目（记下 note 与 session）；`ask` 加提醒“问人（question）”；`questions` 成为 gaps（by successor），卡片上看得到；`understanding` 显示在抽屉里，人一眼能看出新 session 理解得对不对。记录指标：确认用时、首次完整与否、第一次提交的用时。
- 交付门是软的（§5.5）：没确认就交付第一次被拒，带 `acknowledgeOpen=true` 的重试通过，不会卡死在循环里。不用 LLM 打分。

## 8. 前任历史的访问

### 8.1 骨架（`server/session-history.ts`，P2）

- 从不使用：`fetch_agent_timeline`、Paseo 的聊天搜索、发送、刷新历史、恢复、`syncNative` 清 attention、session 预览。它们都会让 Paseo 整个加载历史（Codex `thread/read includeTurns:true` 作为一行读回；Claude `readFileSync` 主转录和全部子代理文件）。
- 何时建：按需（第一次检索时）；异常结束（§5.8）或 B ≥ 64 MiB 的 session 在被换下时建，因为那时需要体积构成和崩溃中途的人的话。其它情形不建，避免为不常用的恢复路径在 daemon 主机上做 IO。
- 怎么读：自己的分块读取器，一次一个、低优先级、块之间让出事件循环；**超过 256 KiB 的行不缓冲直接丢弃**，只看每行前 512 字节判断类型，所以每行仍计入体积构成。1.18 GB 文件约 10–30 秒，内存峰值约 74 MB（研究时实测）。
- 保留什么：Codex 的 `response_item` 用户与助手消息、工具名和截到 300 字符的参数、≤ 300 字符的错误；丢掉工具输出（`*_output`）、重复的 `event_msg item_completed`、图片和 `fileChange` 内容。Claude：主链文本块和可读的 `isCompactSummary` 文本；子代理文件只取文本，每个 ≤ 200 KB。
- 产出：`{ordinal, at, role, text ≤2000, tool?}` 的 jsonl（脱敏，≤ 2 MB），以及锚点和体积构成。
- 可选的快路径（P3，§19）：Codex 的 `thread_history_1.sqlite` `thread_items WHERE item_type IN ('userMessage','agentMessage')`，只读打开，读不了就退回流式。

### 8.2 工具 `flowly_session_history`（只读）

`{ session: "#1" | agentId, query?, around?: ordinal, roles?: [user|assistant|tool], limit ≤ 20 }` → 命中或一段窗口（带 ordinal 和相对时间），每次 ≤ 8 KB。只能查本卡台账里的 session；执行者、评审者、被换下的 session 都可用。骨架还没建好时回答 “Skeleton not ready (building); try again in a minute”，从不在调用里读原始文件。skill：只在记录缺东西时用，从不 `cat`、`grep`、`tail` provider 文件。

### 8.3 拿不回的

Codex 的推理和压缩摘要是加密的；工具输出和图片有意不留。

## 9. 被换下的 session

### 9.1 名单与识别

一个 session 对卡 X 是**被换下的**：它在 X 的 job 的 `retired` 或 `reviewers` 里，或在 X 的交接台账里，或带 label `flowly-task=X` 和任一 `flowly-automation` 角色（`automation.ts:1104` 创建时设）；并且不是当前的 `implementerId` / `reviewerId`；并且 job 活着或 `delivered`。

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

Stop automation 之后（job `stopped` 或 `failed`）守卫解除，它又是普通的管理 session：人要有意在旧 session 里接着做，就先 Stop。

`retiredChecklist`（被换下的 session 读到的 `turnChecklist`，3 条）：
1. “This session was replaced by session #3 (<id8>) on <time> (<reason>); the card's work continues there. Read flowly_get_task only for context.”
2. “Do not change files, the card or its sub-cards. If you know something the new session needs (a background task's result, a fact), add it with flowly_update_handoff note, then end your turn.”
3. “If a person here asks you to work on the card, tell them it continues in session #3 and that working here runs two sessions at once; follow their decision.”

### 9.3 被换下的 session 的回合结束

- 照 §5.7 捕获：人的话成为 `open` 输入（`via: retired_session`）；后台通知关闭对应条目并加一条 background 便签（首行、退出状态、≤ 600 字符的尾部，脱敏）。
- 清除 `retiredTurn`。然后：
  - job `working`、当前 session 空闲、没有待发指令 → 发 `[Flowly automation] Since your last turn: <the replaced session's background task finished | a person wrote in the replaced session>; see the handoff (inputs d-12, notes nt-4).`，`kind: wake`，走 §3.3；
  - job `delivered` 或 `needs_human` → 只记录，抽屉显示 “A person wrote in replaced session #1 (not handled)”，带 **Send to session #3**（发送原文，按 AUTOMATION-SPEC §4.2 重开）和 **Mark handled**。Flowly 不替人判断那是不是反馈。

### 9.4 后台任务

Async shell 和 exec/PTY session 属于注册它的 session：`list_async_shells` 只列“你的”，通知只发给注册者，Flowly 不能改投。所以：
1. **预防**（skill）：自动化下注册 async shell 必须同时写 `running` 条目（是什么、句柄、完成后做什么）；父卡不为子卡注册等待者（Flowly 会唤醒它，SUB-CARDS-SPEC §5）；收尾回合里停掉结果已落盘的，其余列出来。
2. **机械捕获**：timeline 里的注册与取消自动更新台账（§5.7）。
3. **通知捕获**：§9.3，加上被换下 session 自己的便签。
4. 接班者的确认要求处置每个未结束条目：检查、自己重新注册一个，或标为 obsolete。

Flowly 看不到的进程（裸 `nohup`、浏览器标签以外的东西）只有 agent 写了才保留，是已知缺口；接班者被要求用 `ps`、锁文件核实。被换下 session 的显示：Flowly 的 session 视图有横幅 “Replaced: handed over to session #3 at 05:00; messages here are recorded on the card”；若 SDK 允许改标题，加 “(replaced)” 前缀（§19）。

## 10. 评论路由

`tasks.comment` 增加 `deliver?: "auto" | { agentId } | "fresh" | "save" | "quick"` 和 When running 偏好。daemon 照旧先记录（CARD-COMMENTS-SPEC §4 不变），再路由，按卡经 `deliver()` 串行。每条评论同时成为一个输入（`via: comment`，原文）：送达工作 session 且处理它的回合正常完成 → `received`；只记录未送达 → `open`。

### 10.1 自动化卡（job 活着、`delivered` 或 `needs_human`），`auto`（默认 To: “Card's agent (Flowly picks warm or fresh)”）

1. **轮换或创建进行中**（有 `rotation`、`pendingOp`，或该角色有未发出的指令）：不发送，记入 `pendingInputs`。接班者正是为这条评论建的 → 它就是首条消息；其余在接班者首条消息里按 id 和首行列出，`get_task` 里未读全文。客户端提示 “Session #3 is starting: your comment is part of its first instructions.” 之后不再发送（不会执行两次），也从不发给 `from`。
2. **执行者在跑**：按人的 When running 偏好（steer / queue / interrupt），同今天。
3. **执行者空闲**：`rotationDecision`（`kind: comment`，其它边界）。保持 → 发原文。轮换 → **不收尾**（有人在等）；建新 session，**首条消息就是评论原文**，自动化标记在 system prompt；`delivered` 的 job 先设为 `working` 并 `reopened`（与今天 `turnStarted` 的效果相同）。发送失败不算回合失败：job 回到原状态，客户端显示 “Saved on the card; not delivered” 与 Resend。
4. **已停止或失败的 job**：同今天，发给活着、未被换下的执行者，否则只记录；不重启自动化。

### 10.2 显式选择（所有卡）

- `{ agentId }`：选中的 session（被换下的列出但从不默认）。
- `fresh`（“New session with the handoff”）：为人开一个带连续性说明的 session，首条是评论原文；自动化下是原因为 `requested` 的轮换。
- `save`（“Save on the card (the next turn reads it)”）：只记录、不唤醒，下一回合读卡时未读。适合事故后补充事实、给以后的 session 留长期规则，零 token。
- `quick`（P3，“Quick answer from the card: does not reach the agent”）：
  - 一个**不受管理**的临时子 session（同卡片摘要：label `flowly=summarizer`、`paseo-rate-fallback=off`、没有 context file、用完硬删除，模型按 [SUMMARY-MODELS-SPEC](SUMMARY-MODELS-SPEC.md) 的顺序取最便宜的）。它不触发 A1、不算接管、不占目录，也没有卡片工具。
  - 输入（≤ 24,000 字符）：问题原文；标题、泳道、`automation` 摘要；交接默认视图（≤ 12,000）；未完成的 workpad 项（≤ 3,000）；最近 10 条活动；最近的交付说明；记录的年龄。
  - 输出 `{ answer ≤1200, asOf, result: answered | partial | not_in_record }`，记为事件 `comment_answered`（system，链接 `commentId`），输入标为 `answered`。
  - `partial`：显示答案和 **Send to agent**。`not_in_record`、失败或 2 分钟没结果：**按 `auto` 发给 agent**（误判时偏向工作 session），附说明 “Flowly could not answer from the card; sent to the agent”，并记一个 gap（by answerer）：记录答不上来的问题就是交接的一次演练失败。
  - 不自动分类：v1 只在人选它时运行。

客户端的默认收件人逻辑（`client/card-comments.ts` `commentTargets`）排除 `job.retired` 和 label 识别出的被换下 session。没有活着的 job 的手动卡：今天的规则（CARD-COMMENTS-SPEC §1），加上 `fresh`、`save`、`quick` 三个选项。

## 11. 评审者、小组评审、评审级别、父卡与依赖卡

### 11.1 评审 session

- 一个周期内保留（它记得自己的发现）；R0–R4 用它自己的 C、B、K 和空闲时间；从不收尾（它不能写交接，发现都在 `reviews` 里）。
- **新周期总是新评审者**（人的反馈或 Run again 开始的周期）。这改变今天跨周期复用一个评审 session 的做法：新上下文评审更好，上一周期的发现在 `reviews` 里一条不少（§19）。Run again 也不沿用评审者，这比 §5.2.3 的“只沿用 Standard 轮、不在小组或级别槽上的评审 session”更进一步，两条测试都仍然成立。
- 一轮中途因体积或上下文换评审者：重做**同一轮**（轮次不加），`reviewDelivery` 重新绑定，**沿用 job 上记录的本轮计划**（§5.2 的 `review`：级别、原因、上限、人数）以及 `seat` / `panel`，不重新解析；标题取 `reviewTitle(job)`（`Deep review:` / `Light review:` / `Panel review:` / `Review:`）。§5.2.3 已要求“同一轮的重发（备用模型、历史过大的轮换、重试、对账恢复）用 job 上记录的本轮计划”。更早各轮来自 `reviews`；更早的风险由 §5.2.4 照常附在每一轮的说明里。被换下评审者的迟到结论 `NOT_REVIEWER`。

### 11.2 交接检查（`reviewPrompt` 的公共尾部，在 §5.2.4 风险一段之后，所有级别，约 450 字符）

> `Handoff check (does not block approval by itself): from the card's handoff alone, can a fresh agent tell (1) where the work stands and at which commit, (2) the main decisions and why, (3) what was tried and ruled out, (4) the next step and its gate, (5) what is still running and where the outputs are? Report what is missing in handoff.gaps (at most 5). A handoff that contradicts git or the workpad is a finding.`

具体的探针，而不是开放式的“新 agent 能接着做吗”，避免评审者总能找出一点缺口而导致过度返工（Claude Code 的提醒）。小组评审只由牵头者回答，子评审者不做。

### 11.3 `flowly_submit_review`

输入增加可选的 `handoff: { gaps: string(1–300)[] ≤ 5 }`，与 §5.2 的 `risks` 一起校验（`reviewInputSchema` 是严格对象，两个分支都在加可选字段，合并时并在一处）。gaps 写入 `job.handoffGaps`、`reviews[].gaps` 和交接的 `gaps`（by reviewer）。从不单独阻止批准：
- 与 `changes` 一起：附在修改要求末尾（“also close these handoff gaps; informational unless also a finding”）；
- 与 `approve` 一起：显示在卡片上（“Handoff gaps the reviewer noted (2)”）；卡片因人的反馈重开时，执行者的下一个 Flowly 工具结果提醒它们。**没有**批准之后再派一个收尾回合（见 §18.1）。

### 11.4 小组评审

状态机不变（AUTOMATION-SPEC §5.1）。B 计入 Claude 子代理文件和（P3）Codex 子线程，小组子代理就在那里；Deep（§5.2：从第 1 轮起小组评审）最可能超过 64 MiB，下一轮就是新的小组 session。小组说明里“交给每个子评审者”的内容不变（交接检查只归牵头者）。

### 11.5 父卡

- 父卡 session 最长寿（21–23 小时、13–36 个回合、唤醒前空闲中位 36–99 分钟）。唤醒是“其它”边界，R2–R4 常让它轮换；Codex 2 小时内仍热，所以多数能收尾。
- 父卡的记录最重要：编排决定、子卡的验收与合并状态、集成分支、等待者。轮换后的父卡收到已有的唤醒列表（`childrenPrompt`）和自己的交接。
- 子卡交给父卡：唤醒消息和 `get_task` 链接里每张子卡加一行交接 `state`（≤ 300）和 “problems: n”，放在 §5.2.4 的风险之后、证据之前，共用 SUB-CARDS-SPEC §8 的 16,000 字符总预算与每条 6,000。子卡的人的原话从不传给父卡。
- `supervised` 跟随 `implementerId`（`agent-service.ts:233`），不受影响。被换下的父卡 session 对 `flowly_create_card` / `flowly_update_card` 得到 `RETIRED_SESSION`，不会出现两个管子卡的人。
- `subCardActive`（SUB-CARDS-SPEC §5）本来就把“任一管理 session 在回合中”算作推进，被换下的子卡 session 被 async shell 唤醒时父卡会等，这是对的。

### 11.6 依赖卡

`cardHandoff`（`server/automation-handoff.ts`）给每个 blocker 加上它交接的 `state`、`pitfalls` 和 `env`（合计 ≤ 1,500），在每条链接 6,000 的预算内，排在风险（§5.2.4）与交付说明之后、检查之前。

## 12. 界面

- **卡面**：正常时没有新芯片。`rotation.phase = finalizing` 时自动化信号为 “Agent handing over”（脉冲点）；`creating` 时 “Starting a fresh session…”；`hold = history_runaway` 时 “History keeps growing too large”（需要人）；严重体积时 “Session history N MB, still growing”（warning）；job `delivered` 或 `needs_human` 且 `handoffIndex.fresh = false` 时加 “Handoff stale”（warning 色）。
- **抽屉，Agent automation 区**：
  - “Session #3 of this run · fresh after Run again · acknowledged 05:01”，下一行是它的 understanding；
  - “Handoff updated 6 min ago at dc26c13 (= HEAD)”或 “Handoff 41 min old; HEAD moved 2 commits”；
  - “Earlier sessions (2)”：标题 · 角色 · 原因 · 时间；
  - 被换下的 session 暂扣当前 session 时：“Waiting for an earlier session to finish its turn”；
  - Run again 与 ⋯ Run again in session #n（§3.4）；job 活着时的 **Continue in a fresh session**（设 `rotateRequested`）；
  - 失败后的 “Add what the next session should know”；
  - 评审者的交接缺口、quick answer 答不上来的次数。
- **抽屉，新的可移动分区 Handoff**（默认在 Workpad 之后，DRAWER-SPEC 的分区顺序；只在展开时按 etag 读）：
  - 标题行：revision、上次更新（session 号与相对时间）、新鲜或过期（以及变了什么）；
  - agent 的各段：State、Next、Open problems、Running / background（所属 session、年龄、结束与结果）、Pitfalls、Decisions、Ruled out、Where、Environment；
  - **Person's directions**：原文，状态（open / received / done / answered / superseded）和处理者；人可标 done 或 superseded；
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
- **SKILL.md 新增一节 “Handoff and fresh sessions”**：各段写什么；检查点的时机（§5.4）；通常 ≤ 4,000 字符、指向文件而不是复制、从不写密钥；把人的长期指示加引号、注明谁何时说的写进 pitfalls；描述与卡片有关的、人给的图片；按 `handoffDue` 行事；第一回合确认接手；从不打开前任，只用 `flowly_session_history`；批量文件用脚本生成。
- **“Automated runs”**：无人值守模式的标志是首条消息的 `[Flowly automation]` 前缀**或** system prompt 的自动化标记；收尾回合只写交接然后结束；被换下的 session 怎么做；后台任务规则（§9.4）；卫生规则（§4）。
- 工具说明：`flowly_update_handoff`、`flowly_session_history`、`flowly_get_task` 的 `handoff` 输入、`flowly_submit_review` 的 `handoff.gaps`。

## 14. 错误码（daemon 英文）

| 码 | 何时 | 记录了什么 |
| --- | --- | --- |
| `HANDOFF_STALE` | §5.5 的交付门：记录过期、缺 state/next、或接手未确认 | 无；同回合带 `acknowledgeOpen=true` 重试通过 |
| `HANDOFF_INVALID` | 结构不对（指出字段） | 无 |
| `HANDOFF_TOO_LARGE` | agent 各段合计超过 16,000（给出各段大小） | 无 |
| `HANDOFF_CONFLICT` | 碰到的条目自 `handoffRevision` 后变了（给出 id 与差异） | 无 |
| `HANDOFF_UNAVAILABLE` | 交接文件读不懂（已保留） | 无；轮换照常，用派生的连续性说明并记一条警告事件 |
| `ACK_MISMATCH` | 确认里的 HEAD 与 Flowly 读的不同（给出 Flowly 的值） | 无 |
| `RETIRED_SESSION` | 被换下的 session 的卡片写入（指出当前 session） | 无 |
| `FINALIZING` | 收尾回合里交接之外的卡片写入 | 无 |
| `REVIEWER_ONLY`、`NOT_REVIEWER`、`REVIEW_CLOSED`、`ARCHIVED`、`TASK_FINISHED` | 同今天 | 无 |

## 15. 兼容与迁移

### 15.1 旧版本读新看板

- 只加可选的 job 字段、一个顶层数组 `handoffIndex`、事件上可选的字段和新的事件 action；**没有**新的 `state` / `code` 值，**没有**新的项目设置，**没有**新的回执 action。旧版本丢掉这些字段，照常读取 `board.json`。
- 旧版本忽略 `handoffs/`。它的接管规则会在被换下 session 开回合时停止 job，就是今天的行为，安全。
- 旧版本遇到 `rotation.phase = creating`：看到的是普通的 `instruction` + `pendingOp`，用连续性文字创建接班者，没问题。遇到 `finalizing`：看到一条发给旧 session 的指令，按 `turnDecision` 判断它的回合结束，“静默”的收尾回合会收到一次提醒：可以接受的退化，写进发布说明。
- 降级前最好备份 `plugin-data/flowly/`。

### 15.2 已有看板

- 不迁移。没有交接文件的卡读作空记录；第一次捕获时创建。
- 已有卡片的第一次轮换**引导**记录：Flowly 用最近 20 条事件说明、workpad、`job.changes` 和评论写一条便签（“built from the card's activity”）；旧 session 满足收尾条件时收尾回合照常（记录必然“过期”）。
- 升级时活着的 session 在下一次回合结束时补上台账；`job.reviewers` 里的 id 照旧受保护；升级前被替换的执行者靠 label 识别（§9.1）。
- 64 MiB 的字节轮换比今天的 200 MB 早；不读不发的 200 MiB 不变。

### 15.3 与评审级别（AUTOMATION-SPEC §5.2，`feat/review-levels`）的配合

§5.2 在另一个分支上并行完成、尚未合并。顺序：**先合并 §5.2，再把本分支 rebase 上去**，两边的测试都要跑。

| 文件或部位 | §5.2 加的 | 本 spec 加的 | 合并方式 |
| --- | --- | --- | --- |
| `reviewPrompt` | 级别、Deep 视角、风险一段、更早的风险 | 交接检查一段 | 交接检查放在风险一段之后 |
| `reviewInputSchema`（严格） | `risks` | `handoff.gaps` | 都是可选字段，一处校验 |
| job schema | `review`、`seat`、`risks`、`risksFrom` | `sessions`、`rotation`、`retired` 等 | 互不重叠 |
| 评审 session 的选择 | 级别或槽变了就新建；Run again 只沿用 Standard 轮的 | 新周期和 Run again 总是新建；一轮中途轮换沿用 `job.review` 与 `seat` | 本 spec 的规则是 §5.2 的超集；§5.2 的测试仍成立 |
| 链接 handoff 预算 | 风险先扣，再扣证据 | 子卡交接状态行 | 顺序：风险 → 交接状态 → 证据 |
| 唤醒消息 | 风险一行 | 交接状态一行 | 并列 |
| 活动文字 | 评审开始写级别与原因 | 不改评审文字 | — |

§5.2.6 的“Standard 活动文字不变”仍成立；评审说明的文字断言会因交接检查一段而更新。实现者清单只由本 spec 改动（第 5 条），评审者清单的第 3 条（§5.2 改过）不动。

### 15.4 随实现修改的 spec

- AGENTS.md：§1.1 的例外一行。
- AUTOMATION-SPEC：§3（新字段）、§4.1（Run again 不再沿用 session、`fresh` 文字）、§4.3（接管不含被换下的 session）、§4.4（轮换阶段的对账）、§4.5（经 `beginRotation`）、§4.6（缩为指向本 spec，阈值 64 / 128 / 200 / 300 MiB）、§5（新周期新评审者、交接检查）、§6、§7、§8。
- CARD-COMMENTS-SPEC §1–§3：daemon 路由、`deliver` 选项、评论状态。
- WORKPAD-SPEC §1：“不做 Notes 段（progress note 已覆盖）”的决定被交接记录取代（2026-10-24 用户决定；证据：每卡 100 条事件、agent 只看 20 条、C5b.2 已到上限、C5b.3 最后 23 分钟无记录）。workpad 本身不变。
- TURN-CHECKLIST-SPEC §2：第 5 条的新措辞（1,790 字符）。
- SUB-CARDS-SPEC §5：唤醒时的轮换与子卡交接状态行。
- ONBOARDING-SPEC：`card-handoff` 提示。

### 15.5 代码布局

`server/automation.ts` 已 1,521 行，不能再长很多：轮换放进同级文件。新模块：`shared/handoff.ts`、`shared/session-rotation.ts`、`server/handoff-store.ts`、`server/handoff-capture.ts`、`server/provider-usage.ts`、`server/session-history.ts`、`server/automation-rotation.ts`、`server/comment-routing.ts`、`client/task-handoff.tsx`。

## 16. 故障模式

| # | 故障 | 处理 | 仍会丢的 |
| --- | --- | --- | --- |
| 1 | 一个回合里长了 466 MB | 检查点提醒、128 MiB 便签、可选的 steer、卫生规则；下一个边界 R1 | 用户不开 steer 时，单回合仍可能超过 500 MB |
| 2 | 崩溃时记录过期（沉默 23 分钟） | 检查点提醒；Flowly 的 incident 便签；骨架、lastWords、锚点；Run again 时人的便签 | 最后一次检查点之后、不在 git 或骨架里的工作 |
| 3 | 收尾回合不结束或做了工作 | 从不打断；20 分钟便签；交接之外的写入 `FINALIZING`；工作区变化记便签；从不同时有两个 session | — |
| 4 | 封存与创建之间重启 | `rotation.phase` 加以 `rotation.id` 为键的台账；`carry` 保住指令 | — |
| 5 | 创建结果未知 | 今天的 `unconfirmedStart` 与 `needs_human`；不盲发 | — |
| 6 | 软触发的创建明确失败 | 回滚到旧 session（§6.4） | — |
| 7 | 人、等待者或队列唤醒被换下的 session | 不算接管；暂扣；捕获并记录；队列改投；`RETIRED_SESSION` | 当前 session 正在回合中时，人自己的操作会让两个 session 同时运行 |
| 8 | 一个 workspace 两个 session | occupancy 与对方忙检查包含被换下的 session；封存和创建前都重新取快照 | — |
| 9 | 接班者重做已完成的工作或重复死路 | `done` 与 `ruledOut`（带理由）；确认要求逐项处置；输入状态；已读播种 | — |
| 10 | 过时的说法被当成事实 | 相对时间；`ACK_MISMATCH`；workpad 的 sha 新鲜度；“card data: verify” | — |
| 11 | 修改要求被路由给只读回答 | `quick` 只在人选时运行；答不上或失败就发给 agent；评论保持为 open 输入 | — |
| 12 | 人的话超出 20 条评论窗口，或打在 session 里 | 单独保存 ≤ 200 条原文与状态，更早的进 `archive.jsonl` | — |
| 13 | 更早的评审轮次丢失 | `reviews` 30 轮、每条发现有状态；结论事件单独保留 10 条 | — |
| 14 | 轮换抖动 | §3.5 | — |
| 15 | 记录膨胀、读不全 | agent 各段 16k 上限；视图写明省略并指向 `handoff:"full"`；墓碑而不是重写 | — |
| 16 | agent 覆盖或删除条目 | 补丁操作、墓碑、封存快照；agent 不能删人写的条目 | — |
| 17 | 交接文件损坏 | 保留文件；写入 `HANDOFF_UNAVAILABLE`；轮换用派生的说明并记警告；从不重置 | 损坏之后到修复之前的写入 |
| 18 | provider 升级让解析器失效 | 返回 `unknown` → `lastUsage` → 保存的测量 → 代理规则；B 仍守着 | 只是精度 |
| 19 | 读历史时加载了巨大的 session | 从不经 Paseo；流式读取跳过长行；≥ 200 MiB 不发 | — |
| 20 | 接班者去 grep provider 文件 | skill 与连续性说明禁止；`flowly_session_history` 是唯一途径 | 模型不遵守时（无法强制） |
| 21 | 密钥或私人内容被复制 | 脱敏；0600；人的话不进链接 handoff 和子卡说明 | 脱敏规则认不出的密钥格式 |
| 22 | 评审者过度挑交接的毛病 | 五个固定探针；≤ 5 条；gaps 不单独阻止 | — |
| 23 | 评论作首条消息丢了自动化标志 | system prompt 的自动化标记与 skill 的识别 | — |
| 24 | 1M 窗口的成本 | 250k / 300k 的绝对上限 | — |
| 25 | 已有的过大 session 让 daemon 重启后崩溃循环 | Flowly 管不到（`before("agent.session_open")` 抛错否决加载未经测试，§19） | 主机可用性 |

## 16.1 信息损失分析：今天只在 session 里的信息

| 信息 | 怎样保留 | 明知会丢的 |
| --- | --- | --- |
| 决定及理由 | `decisions`（理由必填），检查点与回合结束前写；计划内轮换时热 session 收尾；评审者的交接检查；兜底：骨架里的 agent 消息可检索 | 从没写下也没说出的细微考虑；Codex 加密的推理与压缩摘要 |
| 试过的死路 | `ruledOut`（理由必填）、收尾说明；Flowly 的体积构成写成 hazard 便签；骨架保留 ≤ 300 字符的错误 | 只在工具输出里的细节（工具输出有意不留） |
| 当前步骤、在跑的进程与锁 | `state`、`running`；回合中途的检查点提醒（20 分钟、HEAD 变化、60% 填充、体积）；兜底：lastWords（标为未核实） | 崩溃发生在两次检查点之间时最多约 20 分钟的进行中状态 |
| 人打进 session 的话（真实卡片上 22 次，评论 4 次） | 每次回合结束原文捕获（脱敏），带状态；崩溃中途的回合从骨架补回；Flowly 输入框发的在发送时就记 | 不经 Flowly 管理的 session（工作区里原生开的） |
| 图片 | 开工图片在删除前复制并重新附给接班者；Flowly 输入框的图片保留；`[Image: source: …]` 占位指向的本机文件复制 | 没有占位、只在 provider 里的图片（`user_message` 不带图片） |
| 评论与哪些已处理 | 每条成为输入（原文，不受 50 / 20 名额影响），状态由 agent、人或只读回答设；已读按安全时间播种；open 的给全文；确认逐条处置 open 的 | — |
| 更早各轮的修改要求、风险与缺口 | `reviews` 30 轮全文、每条发现有状态；结论事件单独保留 10 条 | — |
| job 状态 | `get_task.automation`；接班者首条消息 | — |
| 环境与外部状态（安装、服务、版本） | `env`；人和 Flowly 的带时间便签；`git` 由 Flowly 读 | 没人写下的 |
| 旧 session 的后台任务 | 工具调用自动入台账；收尾时要求停掉或列出；被唤醒时捕获通知并告诉当前 session；确认时逐条处置 | 不能把等待者转给接班者；输出只留 600 字符尾部（全文在 shell 日志里） |
| 外部标识（SHA、分支、PR、fixture 账本） | Flowly 读的 git；PR 作为 output artifact（已有规则）；`where`；锚点索引 | 标签页与 exec session 的 id 只作清单标签 |
| 未提交的修改 | 文件留在磁盘；`git.dirtyFiles` 与 diffstat | 半成品的用意，除非检查点或骨架里有 |
| 测量与验证结果 | workpad（带 sha 与过期判断，不变）；`done` 指向证据 | 最后几分钟没记录的数字（接班者重新测） |
| session 自己不知道的危险、session 结束后才有的事实 | Flowly 的 hazard / incident 便签；人的便签（Run again 时提示） | 没有人写的事实 Flowly 无从得知 |
| Plan | 每个 session 的 plan 快照保留，`get_task` 给前任的（标明） | 只在中断回合里存在的 plan（快照在回合结束时取） |
| 旧 session 未用的 next moves | 标签进台账 | 建议本身（接班者的 `next` 取代） |
| 按 session 的门与提醒（交付门、ideas 提醒） | — | 重新开始：最多多一次拒绝或提醒 |
| provider 自己压缩掉的内容 | 60% 时提醒写记录（Codex 在 66–95% 压缩）；`L_tight` 低于观测到的压缩点；压缩后在其它边界轮换 | 单个回合在下一个边界之前就越过压缩点时 |
| 热缓存与隐含的工作记忆 | — | 每次轮换都丢；规则只在更便宜或更安全时轮换（§16.2） |
| 记录本身 | 墓碑、封存快照、坏文件保留不重置；删卡先备份到 `removed/` | — |

## 16.2 代价

估算，单位是基础输入 token 当量，不计输出与质量，数字来自本机证据。

- **一次轮换**：新 session 定向约 108k，首个请求 1.25× 写入，约 135k，之后按 0.1× 读。对比：热的 330k session 每个请求约 33k，新 session 在 3–5 个请求后就更便宜（一个回合有几十个请求，C5b.3 #2 是 79 个）；冷恢复从第一个请求起就更贵（C5b.2：430k 未命中再立刻压缩）。C < 100k 时规则保持 session，不增加代价。
- **收尾回合**：只在热时，约 3–6 个请求 × 0.1 × C 加 1–3k 输出，C = 300k 时约 100–200k；记录不过期时跳过。人多等 1–3 分钟。
- **维护记录**：每回合一两次补丁写入，每次约 1–3 KB 历史；对比今天一次“读卡 + 写入”约 220 KB。交付门最多多一次被拒的调用。
- **`get_task`**：首次多 5–10 KB，之后每次 ≤ 1 KB。
- **只读回答**（P3，只在人选时）：最便宜的模型，≤ 24,000 字符的输入，用完删除；本机需求为 0。
- **daemon**：回合结束时一次 `refresh()`；60 秒的 `stat`（Claude 子代理目录每 5 分钟一次）；文件尾读取最多 16 MiB，只在需要时；骨架只按需或对异常 / 大 session，1.18 GB 约 10–30 秒、约 74 MB 内存。
- **存储**：交接文件通常 20–60 KB/卡，最坏约 1 MB；骨架 ≤ 2 MB/session；图片 ≤ 20 MB/卡；`board.json` 多约 150 字节/卡（索引）和约 0.5 KB/job，手机的看板读取基本不变。
- **实现**：约 4–6k 行（含测试），分三期；风险集中在轮换阶段和被换下 session 的守卫，新代码放在同级文件（§15.5）。

## 17. 验收

### 17.1 纯函数（`shared/session-rotation.test.ts`、`shared/handoff.test.ts`）

- `rotationDecision` 表：R0–R6 在每类边界上；各模型的 `L_cold` / `L_tight`；C 未知时的代理；紧密边界 2.8 分钟、55% → 保持，72% → 轮换并收尾；提醒或重试在 90% → 保持，在 70 MB → 强制；Codex 唤醒 3 小时、214k（sol）→ R4，90 分钟 → 保持；Opus 1 小时档空闲 70 分钟、200k → R4 轮换，30 分钟 → 保持；Opus 5 分钟档空闲 10 分钟、150k、其它边界 → R4 轮换，同样的数在紧密边界 → 保持；Opus 260k 在其它边界 → R3；210 MB → 强制不收尾；少于 2 个回合或增长 < 30k → 不软轮换；第 5 次软轮换 → 忽略；第 3 次字节轮换 → `hold`；紧密边界上的压缩 → 保持，其它边界 → 轮换；人的 Run again → 新；父卡的 `action=start` → 按规则。
- 收尾条件：冷、未加载（插件运行 id 不同）、≥ 128 MiB、上一回合失败、评论边界、记录不过期 → 不收尾。
- 过期判定：只有 §5.5 的实质变化算；agent 在回合结束前写过的不算。
- 交接：上限、按条目合并与冲突、墓碑、视图预算与省略计数、相对时间与 SHA 漂移、脱敏规则、存根与 `seen`、确认的校验（漏 id、HEAD 不符、需 note）。
- 输入提取：过滤 Flowly 前缀、async-shell 与 `<paseo-system>` 通知、路由评论的 messageId；摘要去重在 timeline 重建后不重复；`received` 与 `open` 的判定；`[Image: source: …]` 的图片引用。
- 清单仍 6 条且 < 1,800 字符，skill 逐字一致。

### 17.2 解析器（`server/provider-usage.test.ts`、`server/session-history.test.ts`，合成文件）

- Codex rollout：末尾前 9.3 MB 的 `token_count`、2.3 MB 的长行、`info:null`、带与不带 `latest_token_usage_record` 的 `compacted`；Claude 1M 转录带 `compact_boundary` 与子代理文件，缓存写入档。
- 超过 256 KiB 的行不缓冲跳过，内存峰值有上限；脱敏、锚点、体积构成。
- **一个桩断言没有发生任何 Paseo timeline、refresh-history、发送或恢复调用。**

### 17.3 服务（假 SDK，`server/automation-rotation*.test.ts`、`server/comment-routing.test.ts`、`server/handoff-*.test.ts`）

- **C5b.3 回放**：字节在回合中越过 128 MiB → 下一个工具结果带 `handoffDue`；steer 只在开启时、每个 session 一次；下一条指令 → 强制轮换不收尾；接班者的 system prompt 有标记与连续性说明；首条消息有原因、要做的事、定向步骤与待办 id；incident 便签有体积构成。
- 收尾 → 封存 → 创建 → 确认，待发的修改要求原子带过去；收尾失败、超时、长时间收尾（不出现第二个 session）、收尾回合里的交付被 `FINALIZING` 拒绝；在每个阶段模拟重启都只得到一个、同一个 agentId 的接班者。
- 回滚：软触发的创建明确失败到预算用完 → 旧 session 收到延后的指令；未知结果 → `needs_human`，不回滚。
- 强制轮换（备用模型、中毒、过大）不收尾；Run again 在 `session_unavailable` 之后用继续说明而不是从头开始；过期恢复不发裸 `startPrompt`。
- 被换下的 session：后台通知的回合不算 `taken_over`、不触发 A1、暂扣发送、关闭 `running`、加便签、告诉当前 session；人的话的回合捕获原文、`delivered` 时只记录并提供 Send；写入 `RETIRED_SESSION`、`kind=progress` 通过、`get_task` `writable:false`；只靠 label 识别的被换下 session 同样处理；队列在提交和 `drainAll` 时改投；25 个被换下的评审者全部保留 `REVIEWER_ONLY` 与接管豁免。
- 评论：热 → 原文；冷且大 → 新 session 首条就是原文、system prompt 有标记、`delivered` 的 job 重开；轮换期间 → 待办，出现在首条消息，不发给旧 session、不发两次；`save` 不唤醒；`quick` → 不受管理的子 session、用完删除、`comment_answered`、job 和泳道不变、答不上就发给 agent 并记 gap。
- 已读播种：完成回合里处理过的评论不重做；只在崩溃回合里读过的评论对接班者未读；`open` 的评论给全文。
- 评审者：新周期新评审者；一轮中途轮换保留轮次、`job.review`、`seat`、`panel` 与标题，绑定 `reviewDelivery`；旧评审者 `NOT_REVIEWER`；`handoff.gaps` 与 `changes` / `approve`。
- 父卡与子卡：唤醒时轮换的父卡拿到子卡的交接状态行且在预算内；被换下的父卡不能接受子卡。
- 开工图片在删除前复制、重新附给执行者接班者；`handoffIndex` 在旧 schema 下被丢弃而看板仍可读；带全部新字段的看板能被上一版 `automationJobSchema` 解析；`state` / `code` 与冻结列表比对，没有新值；回执 action 列表不变。
- 单元测试绝不能碰到真实 daemon（open-paseo-plugins/AGENTS.md）：改动 CLI、SDK 或子进程调用后确认桩仍然拦截，跑完用 `paseo project ls` 等检查有没有多出来的资源。

### 17.4 真实 daemon 与 Web UI

按 open-paseo-plugins/AGENTS.md：安装到本机 daemon，app.paseo.sh，fixture 项目 `plugin-test-2026-10-xx`，最便宜的模型，阈值经 `plugin-settings/flowly/rotation.json` 调低；fixture 卡的描述驱动 agent 行为（agent 会拒绝转来的提示）。场景：紧密循环里带收尾的轮换；Run again 默认新 session；冷评论到新 session 的原文首条；轮换期间的评论；Save on the card；被 async shell 唤醒的被换下 session；抽屉 Handoff 区在刷新后仍在；确认与 understanding 显示；被换下的横幅。桌面与窄布局截图存 `docs/verification/session-handoff.md`，记 daemon 版本、插件路径与 commit、fixture id、没验证到的部分；清理后在 Paseo 与 Flowly 里各确认一次。

### 17.5 交接演练（可重复）

从一份封存快照开一个只有卡片的廉价新 session，用固定的五个探针（召回、产物、继续、决定、坑）对照 fixture 的标准答案打分，每个探针一次廉价调用。目标：≥ 80% 的运行第一次确认就完整；首个有效动作的用时不差于 C5b.3 的基线（约 20 分钟完成一个回合）。同一演练决定 `flowly_session_history` 值不值得用。

### 17.6 上线后的指标

按原因统计的每卡轮换数；收尾成功率；首次确认完整率；轮换后第一次提交的用时；重做工作的迹象（重复的 PR URL、重开的发现）；`flowly_session_history` 的使用；每卡 token（取自用量数据）；轮换的 session 与保留的 session 首个请求的缓存命中率（只在本机记录，用来校准 TTL，§19）。

## 18. 分期

- **P1 核心**：job 新字段与轮换阶段（`beginRotation`、收尾、封存、创建、提交、回滚、防抖）；测量（`lastUsage`、回合结束时保存、Codex 与 Claude 的字节）；阈值与决策表；回合内的提醒与便签；交接存储、工具、`get_task` 视图与存根、交付门、确认；派生捕获（人的话、图片占位、开工图片、后台清单、git、台账、锚点）；不带骨架的意外结束便签；被换下的 session 的名单、守卫、label 兜底、队列改投；连续性说明与接班者首条消息；Run again 默认新 session 与可选的同 session；新周期新评审者；已读播种；评论的 `save` 选项、轮换期间的待办、默认收件人排除被换下的；抽屉 Handoff 区；清单、skill 与 spec 修改；测试。
- **P2**：provider 文件尾读取（重启后的 token、Claude 缓存档、压缩标记）；骨架、`flowly_session_history`、体积构成、lastWords、崩溃中途的人的话；评审者交接检查与 gaps；父卡与依赖卡的交接状态行；daemon 侧的评论 `auto` 路由（热 / 冷）与 `fresh`。
- **P3**：`quick` 只读回答；steer（用户决定后）；Codex 子线程字节与 `thread_history_1.sqlite` 快路径；其它写入工具的小回执与 `get_task` 增量视图（Flowly 工具结果占普通历史 32.5%）；按观测到的缓存命中率自动校准 TTL。

## 18.1 不做

- 打断或归档旧 session；在严重体积时自动停止它（人用 Paseo 自己停）。
- 每条评论开一个新 session（Multica 也不这样，§0）。
- 自动把评论分类为进度提问。
- 批准之后再派收尾回合（“批准后的尾声”）：它要 A1、重开和接管的例外，可能让批准失效，也违背 `delivered` 的含义 “the user decides what happens next”（`shared/automation-schema.ts` 的 `automationStates`）。
- 因泳道移动、限额重试、宿主临时故障或紧密边界上的压缩而轮换。
- 经 Paseo 读前任；让 agent 自己读 provider 文件。
- 把等待者或 exec session 转给接班者（Paseo 不支持）。
- 把交接放进 `board.json` 或项目文件夹快照。
- 阈值做成项目设置。
- “把这个旧 session 设为工作 session”的按钮：Stop automation 后在旧 session 里继续即可，再 Run again 时记录已捕获人的话。
- 用 LLM 给确认打分；用 LLM 把转录摘要进交接（Flowly 派生的只做确定性的事）。
- 给 `artifact-reads.json` 加逐条的已读模型。

## 19. 待用户决定

1. **回合中途的 steer**（§4 第 3 条）：128 MiB 或预测 10 分钟内到 200 MiB 时，每个 session 一次 `[Flowly automation]` steer。Paseo 0.12 的 steer 可能退化为 interrupt，与“不主动打断”冲突。推荐开启（崩溃循环会断开主机上所有 session，更糟）；决定之前实现为关闭。
2. **被换下 session 的回合**：推荐不再算接管（job 继续，暂扣发送，捕获原话；`delivered` 时由人决定是否转给当前 session）。还是保留今天的 `taken_over`？
3. **Run again** 默认新执行者与新评审者，⋯ 里可选在原 session 继续：确认？
4. **新评审周期总是新评审者**（改变今天跨周期复用）：确认？
5. **隐私**：人打进本卡任何 session 的消息按原文（脱敏）保存在交接文件，抽屉、评审者和接班者看得到，不进链接 handoff、子卡说明、导出与项目文件夹快照。可以吗？只限自动化卡，还是所有管理 session？
6. **只读回答**只作 To: 的显式选项（P3），不自动分类：确认？
7. **交付门与确认**只在开启自动化的项目里生效（推荐，不需要新设置），还是对所有 Flowly 管理的执行者 session？
8. **Codex 缓存阈值**用本机实测（2 小时内热、2–6 小时看大小、6 小时冷），而不是 OpenAI 文档的 30 分钟下限；以后按观测自动校准？
9. **64 MiB 的主机安全轮换**在紧密循环里也生效？真实卡片上的正常 session 从没到过（C5b.2 合计 54.6 MB）。
10. 清单第 5 条的新措辞（1,790 字符）与 WORKPAD-SPEC “不做 Notes” 被取代：确认。
11. SDK 能力：插件能否改 session 标题或 label 以标出 “(replaced)”；能否在 timeline 里拿到图片本身；Codex 的 `state_5.sqlite` / `thread_history_1.sqlite`（未公开、带版本号）能否作为尽力而为的只读来源。
12. 在 `before("agent.session_open")` 里抛错，否决对 ≥ 200 MiB session 的加载，能否止住重启后的崩溃循环？未测试，也可能挡住人有意的打开、影响其它客户端。
13. Claude 在 API key 或用量额度上只有 5 分钟缓存：P2 之前按 55 分钟处理（偶尔多一次冷恢复，只花钱不丢信息），可以吗？
14. 合并顺序：先合 `feat/review-levels`，本分支再 rebase：确认。

## 20. 评审意见的处理

两轮评审选出“零损失”为主体（一轮选“故障优先”、一轮选“从简”），并指出以下缺陷。逐条去向：

| 缺陷 | 处理 |
| --- | --- |
| 交接视图每次 `get_task` 都多 5–10 KB（最多 28 KB） | 每个 session 每个新 revision 只给一次，其余是存根（§5.9） |
| 交接工具用签名请求，新回执 action 让旧版本拒绝 `board.json`、占 5,000 条回执 | session 凭据认证、不记回执，同 `flowly_submit_review`（§5.6） |
| 说 session 图片“timeline 暴露时”能捕获，而 `user_message` 只有文字 | 只捕获 `[Image: source: …]` 占位指向的本机文件，其余明确记为丢失（§5.7） |
| 清单长度算错（1,781） | 实算 1,790（§13） |
| 每条人的话都要逐条确认、闲聊变待办 | 回合正常完成的工作 session 收到的话为 `received`，不要求处置；确认只覆盖 open 项（§5.7、§7.5） |
| 冷 session 也收尾（约 C×1.25）、给 ≤ 200 MB 的 session 发收尾 | 只在热、已加载、记录确实过期、< 128 MiB 时收尾（§6.2） |
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
| 每分钟 stat 上万个 Claude 子代理文件；每次换下都流式读 GB 级 rollout | 子代理目录每 5 分钟最多一次、按 mtime 缓存；骨架只按需或在异常 / 大 session 时建（§2、§8.1） |
| 回合内增长靠轮换挡不住 | 提醒、便签、卫生规则；steer 交给用户决定（§4、§19） |

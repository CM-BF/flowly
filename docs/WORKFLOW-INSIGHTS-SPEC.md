## 12. Agent habits：next moves 与 ideas 的使用率

状态：**已实现，待用户验收**（2026-10-20，卡片 `5aaa5b01` “Insights: next-move and idea rates per session and model”；用户在评估后确认下面的调整）。

### 12.1 目的与依据

2026-10-19 在 Flowly 项目的 flow log 里有 57 次 `next_moves_suggested`（落在 56 个 turn；其中 47 个是交付或结果的 turn，这类 turn 共 77 个）和 7 条 `idea_proposed`（74 次交付）。2026-10-20 到 10:50 为止，12 次交付里只有 1 次带 next moves（全天共 5 次调用），ideas 4 条。没有任何界面提示，是用户发现输入框上方的 chip 不见了才注意到。同一块数据还显示规则对不同会话的约束力不同：窗口内交付 ≥10 次的三个 session，一个 0 次 next moves，一个 2 次，一个 6 次。本节把这件事变成每天可见的数字，让改规则（skill 措辞、交付时提醒）有数据可比。

**数据源必须是 flow log，不是 `board.json`**：看板每张卡只保留最近 100 条事件（`BoardStore.event`），所以从 `board.json` 数事件会少数。2026-10-20 评估时用 `board.json` 数出的 “10-19 共 65 次 next moves” 就是这样偏低的：flow log（不裁剪）里 10-19 全部四个项目共 79 次，Flowly 一个项目 57 次。

### 12.2 与本文其余部分的关系（偏离卡片原文的两处）

- **不受 Workflow insights 开关控制**。本节只是规则统计：不调用模型、不花 token、不采集新的内容，读取的就是已有的 flow log。要做到“一天内发现”，它必须对所有人默认可见；放进默认关闭的 Workflow insights 区块就看不到。所以代码在新文件 `shared/agent-habits.ts`，不放进 `shared/workflow-insights.ts`（那是另一个尚未验收的功能，混在一起会让两件事无法分开提交）。Insights 页上它是独立的区块，不属于 Workflow insights。
- **分母不含 question**。skill 规定提问走 `kind=question`，“not next moves”，所以把提问算进 next moves 的分母会把比率结构性压低。question 的 turn 单独列出。

### 12.3 口径

数据源是项目的 flow log（`flow/<projectId>.jsonl`，每个看板事件，不裁剪，卡片被删除后用量仍保留）。只看 `actor=agent` 的事件和 `system` 的 turn 边界；时间切天用 Insights 的时区（`dayKey`）。

- **turn**：同一 `agentId` 从 `agent.turn_started` 到下一次 `turn_started` 或它自己的 `agent.turn_ended`。session 的事件归入它最近的一个 turn（进行中或刚结束的）；没有任何 turn 的事件（日志从 turn 中间开始）自成一个以该事件时间为准的 turn。turn 的日期取它最后一个事件的日期。
- **交付类型**（一个 turn 只算一次，按优先级）：
  1. `delivery`：agent 把卡片 `status_changed` 到 `in_review`；
  2. `result`：没有交付，但有 `reportKind=result` 的汇报；
  3. `question`：以上都没有，但有 `reportKind=question` 的汇报。
  - **分母 `base` = delivery + result**。
- **next moves**：turn 内至少一次 `next_moves_suggested`（同一 turn 的后一次覆盖前一次，所以按 turn 计一次，不按事件计）。
  - 比率 = `base` 中带 next moves 的 turn / `base`（字段 `moves` / `deliveries + results`）；
  - `movesAny` 是全部带 next moves 的 turn（含 base 之外的），只用于核对事件数，不进比率。
- **ideas**：`idea_proposed` 事件数；“每次交付的 ideas” = ideas / `deliveries`（只算 in_review 交付）；没有交付时不显示比率。idea 的数量取自 agent 所有 turn，不只交付 turn，因为 skill 说的是“通常在交付时”。
- **显式“没有下一步”（`none`）**：`next_moves_suggested` 的 `moves` 为空列表（NEXT-MOVES-SPEC §8 的 `nextMoves: []`）。flow log 里记为 `offered: 0`。
  - turn 里以**最后一次** next-moves 调用为准：最后一次非空算 `moves`，为空算 `none`（先建议后改成 none，或反之，都按最后一次）；
  - `none` 只统计 base（交付 + 结果）里的 turn，单列，不进 `moves`，也不改分母；
  - 一个 `none` 的 turn 没有可采纳的建议，不进 picked 的 `offered`；
  - 它算“用了这个工具”：下面的标记不会因为模型一直声明 none 而报“没有 next moves”。`none` 的汇总数显示在模型行里，让“一直说没有”也看得见。
- **picked（用户采纳）**：每次 turn 结束时没被覆盖的那一组 next moves 叫一个 *set*（挂在提出它的 turn 上，日期和模型也归那个 turn）。set 被 *回答* 时有结果：
  - 同一 session 的下一个 turn 开始（用户发了消息）：结果取自那个 turn 的 `agent.turn_ended` 上的 `pick`（§12.4）：`≥0` 是采纳了第几条，`-1` 是回答了但没采纳，缺失是未知（旧数据，或钩子没拿到消息），**未知不进比率**；
  - 该卡片被人移到 Done，且 set 里有 `moveTo:"done"` 的建议：算采纳。**局限**：点“移至 Done”和手动拖到 Done 走同一条路径、事件完全相同，无法区分，所以这里的“采纳”包含手动拖动（界面文案不写“点按”）；
  - 没有被回答的 set（会话从此无人回复、卡片被收尾）不进比率。
  - 比率 = `picked / offered`，`offered` 是有明确结果的 set 数。
- **分组**：
  - 日：最近 7 天（到所选日期止，同 Last 7 days）；
  - 项目合计：窗口内所有 turn；
  - 模型：turn 上的 `model`（`provider/model`）。没有时按 §12.5 补；仍然未知归入 “Unknown model”；
  - session：`agentId`，只用于标记（§12.6），用卡片标题和模型显示。
- **标记**：窗口内一个模型或 session，满足下列任一条就标出来。
  - `deliveries + results ≥ 10` 且 `moves = 0` 且 `none = 0`：“没有 next moves”（既没建议、也没声明过 none，也就是根本没用这个工具）；
  - `deliveries ≥ 10` 且 `ideas = 0`：“没有 ideas”。
  - 阈值 `FLAG_MIN = 10`。ideas 本来就可以为 0（skill：没有值得提的就不提），所以这一条只是提示，不是错误。

### 12.4 数据变化（都是可选字段，旧数据不用迁移）

- `agent.turn_ended` 事件（`BoardEvent` 与 flow log）新增：
  - `model`：session 在这个 turn 结束时的 `provider/model`，取自 `paseo.agents.ref(id).refresh()` 的 `runtimeInfo.model`（缺失用 `model`）；拿不到就不写。钩子里 `PluginHookAgent` 只有 `provider`，没有 model；session 中途可以换模型（timeline 有 `model_changed`），所以按 turn 记，而不是按 session 记；
  - `pick`：整数。**只在这个 turn 开始时该 session 有未过期的 next moves 时写**（`openNextMoves` 取 turn 开始之前的那一组）。取 turn timeline 里的 `user_message` 文本，与这一组每条消息型建议的 `prompt` 比较（`matchPick`）：返回采纳的下标，没有匹配返回 `-1`；没有消息文本时不写。
- `matchPick`：文本去掉多余空白后比较。消息等于 prompt，或 prompt 不少于 12 个字符且消息包含它（点选后在已有输入后追加，见 NEXT-MOVES-SPEC §4），算采纳；否则取 prompt 的字符三元组被消息覆盖的比例，≥0.8 算采纳（用户改了几个字再发送）；多条同时匹配取覆盖比例最高、再取下标小的。没有 `prompt` 的动作建议不参与。
- `next_moves_suggested` 在 flow log 里新增 `offered`（建议条数，空列表为 0）与 `offersDone`（含 `moveTo:"done"`）：flow log 不保存 `moves`，也不保存 `note`，所以“显式 none”只能靠 `offered: 0` 区分。旧条目没有这两个字段，服务端读取时用 board 上同 id 事件补上；board 每张卡只保留最近 100 条事件，被裁掉的旧条目补不上，视为有建议、不含 Done 建议（那时还不存在 none）。
- 写入点：`recordLifecycle` 增加可选的 `model` / `pick`；`index.server.ts` 的 `agent.turn_ended` 钩子在 `store.mutate` 之前取 model（异步），在 mutate 内同步算 `pick`。取不到 model 或消息只是少一个字段，不影响钩子的其他工作。

### 12.5 历史 turn 的模型

没有 `model` 字段的 turn（本功能上线前的全部历史）：服务端在窗口内存在这样的 turn 时才调用一次 `agents.list({ includeArchived: true })`，用 session 当前的 `provider/model` 补上；列表里找不到的（已被清理）归入 “Unknown model”。**已知偏差**：中途换过模型的历史 session 会被算到它当前的模型上。上线 7 天后窗口内不再有这样的 turn，这个调用也随之消失。

### 12.6 视图与界面

- `ProjectInsights`（`insights.project`）新增 `habits`，不新增 RPC，沿用现有的 etag 读取：
  `{ days: [{ day, ...counts }] (7 天), total: counts, models: [{ model, ...counts }] (按 base 降序), flags: [{ kind: "model"|"session", miss: "moves"|"ideas", model, n, agentId?, taskId? }] }`，其中 `counts = { deliveries, results, questions, moves, none, movesAny, ideas, offered, picked }`。
- Insights 页新增区块 **Agent habits**，放在 Workflow insights 之后、Token use 之前，桌面与紧凑布局都显示：
  - 标题行右侧是窗口合计：“Next moves 54/69 · Ideas 13”；
  - 一排 7 天：每天一列，显示星期、next moves 比率（`moves/base`，无交付显示 “–”）和 ideas 数，比率低于该窗口平均的一半用警示色；
  - 每个模型一行：模型名、`moves/base`、ideas、`picked/offered`；
  - 标记行：“{model} made no next moves in {n} deliveries (7 days)” / “… no ideas …”，session 用 “{card title} · {model}”，点按打开卡片；
  - 窗口内没有任何交付或汇报时整块显示一行 “No deliveries in these 7 days.”。
- 无设置项，无新手引导提示（这是诊断行，不是需要宣传的功能，也不应对所有用户弹一次提示）；README 的 Insights 亮点补半句。新文案加入全部 9 个语言目录。

### 12.7 不在范围内

- 明确的 “none” 声明与它的计数（见 12.3）；
- 比率下降时的推送或 Attention 项：先看数据和行里的标记；
- 按人统计；跨项目汇总；
- 修改 next moves / ideas 的规则本身（卡片 `Sidebar UI/UX 调整` 上的两个相关 idea）。

### 12.8 验收

单元测试（`shared/agent-habits.test.ts`）：
- turn 边界：turn 内的事件归该 turn；`turn_ended` 之后到下一次 `turn_started` 之前的 agent 事件归刚结束的 turn；没有 `turn_started` 的事件自成一个 turn；同一 turn 两次 next moves 只计一次；一个 turn 同时有交付和 result 只算 delivery；
- 分母：question 不进 base；单独计数；ideas 每次交付；
- 日期与时区：turn 跨午夜按最后一个事件；`tz` 影响切天；
- 分组：按模型、缺失 model 时用回退函数、仍未知的归 Unknown；
- 显式 none：最后一次调用决定；只算 base；不进 offered；不触发 “没有 next moves” 标记；旧条目没有 `offered` 时按有建议处理；
- picked：整句、追加在已有输入后、改了几个字、短 prompt 只认全等、多条取最接近、只有动作建议、未知不进比率、Done 采纳、未回答不计、覆盖的 set 不计；`turnPick` 取 turn 开始前的那一组；
- 标记：恰好 10 次且 0；9 次不标；有 1 次不标；ideas 同理；
- flow log：`flowEntry` 保留 `model`、`pick`（含 0）、`offered`、`offersDone`。

服务端：`recordLifecycle` 写入 `model` / `pick`；`analyze` 带 `habits`；旧 flow 条目用 board 补 `offersDone`。

实测：冻结 flow log 与 `board.json` 的一份副本，用独立脚本（`docs/verification/fixtures/agent-habits/handcount.mjs`，不引用 `shared/agent-habits.ts`）按日、按 session 手工计数，与计数器逐项对照（`compare.test.ts`，设 `HABITS_FROZEN_DIR` 才运行）；多组日期与时区都要一致。差异与原因写进 `docs/verification/agent-habits.md`，其中包括卡片里示例数字（10-19 为 65 次 next moves / 11 条 ideas，10-20 为 1 / 0）与当前数据不符的原因：65 是 `board.json` 里还留着的 next moves 事件数（被每卡 100 条的上限裁过），不是当天的实际数；11 条 ideas 与 flow log（全部项目）一致；10-20 的 1 / 0 是当天早些时候的数，之后又有调用。UI 在运行中的 Paseo 上目视检查；没有桌面窗口控制工具时记为 UNRUN。

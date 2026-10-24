# 卡片树：分层查看子卡片与 blocks 依赖（CARD-TREE-SPEC）

状态：2026-10-24 用户提出，设计已评审（大纲优先方案），§1.2 的三项决定由用户于 2026-10-24 定为默认值。Stage 1 写 spec，Stage 2 纯模型，Stage 3 界面已实现（§1.5）；Web UI、真机未验证。用户原话：

1. “Card dependencies are hard to see. We have card/sub-card relations, but the blocking relations between cards are not clear to me. I suggest a DAG or another way to show their relations.”
2. “I expect sub-cards within sub-cards, nested level after level from the whole to the parts. Add a way to hide sub-cards, e.g. hide sub-cards below level 1/2/3, so that I can clearly run several items in one project.”

本 spec 推翻 [CARD-LINKS-SPEC](CARD-LINKS-SPEC.md) §1（看板不嵌套卡片）、§5.1（卡面不显示其他关系）和 §9（不做关联图视图），并修订 [SUB-CARDS-SPEC](SUB-CARDS-SPEC.md) §6、[CARD-DISPLAY-SPEC](CARD-DISPLAY-SPEC.md)、[DRAWER-SPEC](DRAWER-SPEC.md)、[AUTOMATION-SPEC](AUTOMATION-SPEC.md) §6、[SHORTCUTS-SPEC](SHORTCUTS-SPEC.md)、[FINISHED-CARDS-SPEC](FINISHED-CARDS-SPEC.md)、[ONBOARDING-SPEC](ONBOARDING-SPEC.md) §5 与 [PERFORMANCE-SPEC](PERFORMANCE-SPEC.md)（§8）。

本功能只改显示：不改看板数据、revision、links、自动化或 daemon；不新增 RPC、轮询或依赖。唯一新增的持久化值是 host 级 `board-view` 设置里的 `subCardLevels`。唯一的数据写入入口是已有的：抽屉 Held 行的移除链接走现有 `links.delete`，菜单里的 Run with agent / New sub-card / Link to a card… 走现有 RPC。

## 1. 决定

### 1.1 方案

采用“大纲优先”方案，由三部分组成：

1. 项目页 **Card tree**：可虚拟化的分层大纲，按 blocks 关系给同一组兄弟卡片编步骤号。
2. 看板的 **Levels**：按层级隐藏子卡片，被隐藏卡片的状态汇总（roll-up）到最近的可见祖先上。
3. 抽屉新区块 **Dependencies**：小型的邻域图。

不做整个项目的二维 DAG 画布。原因：

- host 没有 SVG、canvas 或缩放组件（AGENTS.md：只用 React Native 原语，不用 SVG/DOM）。
- 用户的树在 Detail 密度下约 2.8k pt 宽，手机上只能退化为大纲。
- 大纲加链路高亮加邻域图已经能看清“谁先谁后、谁卡住谁”。

二维图留作以后的 spec，可直接复用 `shared/card-tree.ts` 的步骤和提升边。

### 1.2 用户决定（2026-10-24，记为默认值）

1. **Level 编号。** “Level 1”指只显示顶层卡片（depth = 0），Level L 显示 depth < L 的卡片。在深度上限 3 下，选项是 Levels 1 / 2 / 3 / All，四个互不相同。菜单文案写明含义：“Top-level cards only / Down to level 2 / Down to level 3 / All levels”。
2. **深度上限不变。** 子卡片最多在顶层卡下 3 层（`subCardLimits.depth = 3`，`shared/links.ts`；`depthOf(父) + 1 + heightOf(子) ≤ 3`）。用户的 main → C5 → C5a → C5a.1 已到上限。“level after level” 要更深，需要另做决定，涉及 daemon、自动化、建卡预算和服务端校验。本 spec 的所有层级选项都从 `subCardLimits.depth` 推出，以后提高上限只是多一个选项。
3. **“Held”按 dispatcher 的含义（`readiness()`，`shared/automation.ts`）。** 有排队中（`queued`）自动化 job 的卡，若某个未 Done 的 blocker 为 Cancelled 或已归档，则显示为 **Held**（“Held by {title}”），与 `readiness().cancelled` 完全一致：dispatcher 永不放行它，直到人删掉链接（AUTOMATION-SPEC §4.1）。没有排队 job 的卡，Cancelled 或归档的 blocker 仍按 `isResolved` 视为已解决（今天的行为不变）。
   - “Blocked” 一词只作泳道名。依赖关系的文案用 “Waiting on / Waits for / Held”。
4. **隐藏的子卡片不能藏住需要人的工作**（用户要求）：被隐藏卡片的 needs-you、error、unread 与 running 状态汇总到最近的可见祖先卡面（§2.4），泳道底部提供 “Show {n} hidden sub-cards”（§2.3）。Attention 列表、角标与总览不受 Levels 影响。

推迟（不在本期，§10）：自由二维图、悬停追踪链路、拖拽建立链接、提高深度上限。

### 1.3 关于用户的实际看板

三张 research 卡和 C1 之间没有 blocks 链接，因此卡片树如实显示为 1 1 1 1 2 3 4 5：C1 与 research 并行，dispatcher 也不等它们。这不是布局错误。交付说明要讲明这一点，并建议 agent 在顺序重要时传 `blockedBy`。

### 1.4 对照现有代码的调整（相对草案）

草案写于上游同步（#9，`2b00cf6`）之前。核对当前代码后作如下调整：

1. Command Center 条目沿用现有 `Flowly: …` 前缀（`index.client.tsx` 的 `intentItems`），标题为 “Flowly: Open card tree”；`BoardIntent` 与 `parseBoardIntent` 的 `intents` 增加 `tree`。
2. intent 有效期在代码里已是 5 s（`intentMaxAgeMs`，`client/shortcuts.ts`），SHORTCUTS-SPEC 还写着 30 s：只改文档。I/B/M/E/⇧H/⇧L 与 `welcome` intent 已实现，SHORTCUTS-SPEC 没写：一并补上。
3. 抽屉区块在 Details 之前都是立即挂载的，只有 Details、Usage、Activity 在打开动画后挂载（`useSettled`，`client/drawer.tsx`），所以它们“上方什么都不动”。Dependencies 在可移动区块中间，若整个区块晚挂载，下方的 Links、Details 会被推开。改为：区块头立即渲染；正文的高度由纯函数 `neighbourhoodLayout()` 按节点数算出并立即占位，节点和边在 `useSettled` 之后才挂载（§2.6）。
4. 父卡面包屑的图标用 `CornerLeftUp`，不用草案的 `CornerDownRight`：后者已是卡片菜单 “New follow-up task” 的图标。
5. Levels 计算 depth 时只数当前范围内的祖先（§2.3）：Show archived 关闭时，已归档的父卡不在看板上，若仍按原 depth 折叠，它的未归档子卡会在 Level 1 下没有可见祖先承接汇总。
6. Levels 的选项为 1..maxDepth 与 All（maxDepth 为本项目范围内最深卡片的 depth）；Level maxDepth+1 与 All 相同，不单列。
7. 欢迎页 More features 的行是标题加正文（`client/onboarding.tsx` `MoreFeatures`，key 为图标），只改 “Sub-cards” 行的正文（§6）。
8. `saveMerged`（`client/board-view.ts`）现在只接受对象补丁；`subCardLevels` 需要在重新读到的文档上重建 record，所以 `saveMerged`/`useBoardView().update` 增加函数补丁 `(base) => Partial<BoardView>`。
9. `automationSignal(job, task)`（`client/task-automation.tsx`）不读看板；拆分排队芯片需要传入该卡的 blocker 状态（`blockerIndex` 的结果，§3）。
10. 卡片树页的列表用 host `FlatList`，检测写 `!!FlatList`（同 `client/session-transcript.tsx` 的注释：host 的 FlatList 可能是 memo/forwardRef 对象），不用 `client/lane-list.tsx` 的 `typeof FlatList !== "function"`。后者可能让手机上的泳道列表静默退回普通 ScrollView，本功能不改它，记入 PROGRESS 待真机核实。

### 1.5 Stage 3 实现说明（2026-10-24，相对 §2 的细节调整）

1. **Attention 行的父卡**：`Row` 只有一行 detail，所以 “in {title}” 作为 detail 的前缀（“in Main · Project · Lane · …”），不是单独一行。
2. **waits-for 芯片里的 stuck**：只在这张卡被 Held（有 queued job）时显示 “… · Cancelled/Archived, holds this”。没有排队 job 时，Cancelled 或归档的 blocker 按 §1.2 第 3 条视为已解决，不显示芯片。
3. **步骤连线**：只画在相邻的兄弟行之间（前一张的子卡片收起时）。前一张展开时，中间是它的子卡片，连线不穿过它们，结构由树轨表示。
4. **Command Center** 的 “Flowly: Open card tree” 总是打开页面；`T` 和 Tree 芯片是切换。
5. **keep**：被 Levels 隐藏的卡拖不起来，所以 keep 里放的是“刚放下的卡”（泳道底部展开后拖到别的泳道的卡），本次访问内保持可见，不是“正在拖拽的卡”。
6. **链路高亮栏**与图例共用头部下的一行（同高），高亮时换成 “Chain of {title} · {n} before · {n} after · Clear”，所以不会造成布局跳动。离开页面或切换项目时清除高亮。
7. **卡片树页的 Levels**：桌面 `Choices` 的选项文字为 “1 / 2 / 3 / All”；compact 用与看板芯片相同的菜单。
8. **Dependencies 邻域图**：按 §2.6 的 420 pt 阈值，默认 440 pt 宽的侧栏（内容约 408 pt）显示竖排；侧栏拉宽后才是三列。
9. **perf 名称**：`tree.build`、`tree.flags`、`tree.rows`、`tree.mount`（挂载大纲那次渲染到提交）、`drawer.deps.mount`、`levels.change`（选择 Levels 到看板按新值渲染）都已记录，数字待真机测量。
10. **Stage 4（i18n 与 onboarding 收尾）**：`card-tree` 提示改为 “Open Tree in the bar above to see each item from the whole to its parts, with its steps in order. Levels hides deeper sub-cards on the board.”，因为其他提示都说明入口在哪里，原文没有（提示就显示在 OverviewBar 下方，Tree 芯片在这一栏里）。链路栏的 “{n} before” / “{n} after” 按 §7 改用 tn。韩语把 Levels 译为 “계층”，不用 “단계”，因为 “단계” 已是步骤（Step）的译名，同一页上两者会混淆。

## 2. 行为

### 2.1 共享模型（每次看板变化算一次）

`buildCardTree(tasks, links)` 对当前项目一次遍历建好以下内容：

- **parent**：每张子卡取第一条 subtask 链接，与 `parentOf`（`shared/links.ts`）相同。第二个父卡计入 anomalies。subtask 成环时，闭环的那张卡当作根。
- **children**：按链接（创建）顺序排列。
- **depth、roots**。
- **blockers / blocked**：每条 blocks 链接都记，不管两端状态。另一端不在本项目或已不存在的链接计入 anomalies，不进树。
- **兄弟边提升**：对 blocks 边 u→v，比较两条祖先链（root..u 与 root..v，长度不超过 4），找第一个不同的下标 i。
  - 一条是另一条的前缀，说明是祖先边。服务端禁止这种边，此处忽略。
  - 否则把 chain_u[i] → chain_v[i] 加到父卡 chain_u[i-1] 的组里（i = 0 时为根组），去重。
  - 端点有变化的真实边标记为 `lifted`。例：C4b→C5a.1 提升为 C4→C5，与已有的 C4→C5 合并。
- **步骤（step）**：每组用 Kahn 最长路径分层，step(x) = 1 + max(step(前驱))。Kahn 停住时，只放行剩下的卡里第一张（按成员顺序）在环上的卡，排在已放好的卡之后，再继续 Kahn；只是排在环之后的卡（例如等 A 的 C，A 在环上）照常排在它的 blocker 之后，不会先于环。环上的卡带 `cyclic` 标记，例如跨分支提升出的 A1→B2 加 B1→A2。
- **兄弟排序**：(step, createdAt, id)。

**blockerState(blocker)** 取值：

- `done`
- `open`：未完成（不是 Done、Cancelled，也未归档）
- `stuck`：Cancelled，或在 Done 之前被归档
- `gone`：卡片已不存在（`readiness()` 同样忽略它）

**isHeld(card)** = 卡未归档、不在 Done/Cancelled、有 `queued` job，且至少一个 blocker 为 stuck。等价于 `readiness(board, id)` 为 `{ reason: "blockers" }` 且 `cancelled` 非空；属性测试保证两者一致。

复杂度 O(n + e·d)，d ≤ 4。客户端不再按卡调用 `shared/links.ts` 的 `parentOf / childrenOf / linksOf / waitingOn`（抽屉 Links 区块的一跳列表除外）。

### 2.2 卡片树页面（Card tree）

位置：项目页槽位，与 Insights、Ideas、Memory 并列（`client/board.tsx` 的 `page` 增加 `"tree"`，页面组件 `client/card-tree-page.tsx`）。

入口：

- OverviewBar 芯片 “Tree”（`Workflow` 图标），放在 Ideas、Memory、Insights 旁边：项目有任何 subtask 或 blocks 链接时显示。
- 快捷键 `T`（桌面 web，焦点在看板内）。
- Command Center 条目 “Flowly: Open card tree”（BoardIntent `tree`）。
- 项目标签右键菜单的 pages 组（`projectTabMenu`，在 Insights、Ideas、Memory 之后）。
- 卡片右键菜单（`cardMenu`）、手机操作表、抽屉 Dependencies 区块里的 “Show in tree”。

“Show in tree” 的行为：打开页面，展开该卡的祖先，滚到该行，闪一次（沿用现有的状态闪烁 opacity，Reduce Motion 下不闪），并开启链路高亮。`Esc` 和 Back 照常离开页面。展开祖先与点 waits-for 芯片一样写入 Chevron 覆盖（`withRevealed`），所以清除链路高亮后这张卡仍然可见，不会因为链路不再撑开祖先而折回、让列表跳动。闪烁的边框在 900 ms 内淡出后才卸载。

页面头部：

- Back、标题 “Card tree”、Levels 控件（桌面为 `Choices` 分段，compact 为 Levels 芯片加菜单）。
- 一行灰色图例：“Same number = parallel · arrow = later step”。

范围：

- 本项目卡片；打开 Show archived 时含归档卡片。
- 不受搜索、类型、优先级、标签筛选影响，同 Insights。

主体是一个 host `FlatList`（initialNumToRender 12，windowSize 7；没有 FlatList 时退回 ScrollView），行来自纯函数 `outlineRows()`，分三段：

1. **Items**：有子卡片或 blocks 链接的顶层卡片。未完成的在前，按 createdAt 新到旧，保证位置不随泳道变化而跳动。
2. **Other cards**：没有任何关系的单卡。分组行，默认折叠，带数量。
3. **Finished**：根为 Done 或 Cancelled 的整棵树。分组行，默认折叠。

**根行：**

- 较大标题、泳道名、自动化信号。
- 4 pt 的整棵子树进度条，最多 5 段 View：done、active、needs you、waiting/held、其余。
- 一行 “Now: … · Next: … · Needs you: …”，每部分最多 2 个标题加 “+{n}”：
  - **Now**：有 running/initializing session，或 job 处于 starting/working/reviewing/retry_wait 的卡。
  - **Next**：按大纲顺序，未完成、未在推进、不需要人、没有未完成子卡片，且它自己和各祖先的每个 blocker 都已 Done 或正在推进（在 Now 里）的卡。job 为 queued 时加 “(queued)”。Cancelled 或归档未完成的 blocker 永远不放行。（Stage 2 调整：原文要求 blocker 全为 Done，与下面示例 “Now: C3 · Next: C4” 矛盾；正在推进的 blocker 也放行，Next 才是“当前工作之后轮到谁”。没有未完成子卡片的条件使有子卡片的卡把位置让给它的第一张可做子卡片。）
  - **Needs you**：有未消除 attention 的卡。

这一行就是“在一个项目里同时跑几个事项”时每个事项的状态行。

**卡片行（最小 56 pt，触控目标 44 pt），从左到右：**

1. **树轨**：每个仍在延续的祖先层画一条 1 px 绝对定位 View（来自 `outlineRows` 的 bitmask），本行再加一个肘形。
   - 缩进：桌面每层 20 pt，compact 每层 14 pt，最多 3 层。
   - 线用 top:0/bottom:0，不需要测量。
2. **步骤槽**（24 pt，触屏 44 pt）：18 pt 圆圈里写步骤号，填充或描边表示状态：
   - done：success 填充
   - active：accent 填充
   - needs you：warning 填充
   - held：warning 描边
   - waiting：border 描边
   - ready：accent 描边

   同组相邻行之间连一条 1 px 竖线。下一行步骤号更大时，竖线末端加 4 pt 边框三角箭头；步骤相同则只有直线，表示并行。
3. 有子卡片时显示 Chevron（22 pt，触屏 44 pt）。触屏上步骤槽和 Chevron 都用实际宽度做 44 pt 命中区，不用 hitSlop：后一个控件会盖住前一个的 slop。Chevron 是静态的 `ChevronRight` / `ChevronDown` 图标，不用抽屉里会转动的 disclosure Chevron：后者走 JS driver，改 Levels 或开启链路时几十行会同时转。
4. StatusIcon 和标题，最多 2 行。
5. **meta 行**：泳道 · 自动化信号 · “Sub-cards 1/2” · waits-for 芯片。芯片只在以下情况出现，所以一条直链只看编号就能读懂：
   - blocker 未完成：显示 “{title}”。
   - blocker 不在本组兄弟里：显示 “{title} (in {parent})”。
   - stuck：warning 色 “{title} · Cancelled, holds this” 或 “{title} · Archived, holds this”。

   点芯片会展开所需的祖先、滚到那张卡并闪一次。blocker 不在当前范围里（归档且 Show archived 关闭）时，大纲里没有它的行，点芯片改为在抽屉里打开它，不展开任何行。
6. 折叠的行另加子树进度条和 “{done}/{total} done · {n} running · {n} needs you”。

**交互：**

- 点行打开抽屉（`openTaskById`）。桌面上抽屉在页面旁边；手机上抽屉盖住页面，页面保持挂载（`covered`，同 Insights 的 `active={!(compact && drawer.active)}`），Back 后滚动位置不变。
- 桌面右键、手机长按：现有卡片菜单（`menuFor` / `cardMenu`）。Run with agent、New sub-card、Link to a card… 都走现有 RPC。
- 点步骤圆圈（44 pt 命中区）切换**链路高亮**：
  - 上游：传递的 blocker，加上祖先的 blocker（较浅色，“inherited”）。
  - 下游：传递的被阻塞卡及其子卡片。
  - 链上卡片的祖先和所在分组展开，链上行用 accent 底色，其他行 opacity 0.45（native driver）。开启新链路时，清掉这些行上之前按 Chevron 留下的折叠，整条链因此可见；之后再按 Chevron 仍以它为准。
  - 头部出现一条栏：“Chain of {title} · {n} before · {n} after · Clear”。
- 每行 Chevron 可覆盖当前 Levels 的展开状态，也覆盖链路的展开（review 修正：原来链路撑开的行按 Chevron 没有反应，存下的折叠在清除链路后才突然生效）。覆盖只存在客户端内存里（按项目），切换项目或改 Levels 时清空，同 `olderShown`。分组行（Other cards、Finished）同样。
- 一行显示示例（用户的树，Levels All）：

```
main card · Now: C3 · Next: C4 (queued) · Needs you: C5b
  1 inventory   1 behaviour   1 architecture   1 C1
  2 C2
  3 C3
  4 C4 ▸            4a 1 → 4b 2
  5 C5
      1 C5a         1 → 2 → 3
      2 C5b         1 → 2 → 3
```

### 2.3 看板 Levels（隐藏深层子卡片）

**取值。** 每个项目一个 “Levels shown” 值：1、2、3、All（存储时不写入 = All）。

- **层级深度**按当前范围计算：一张卡的 level depth 是它在当前范围（本项目；Show archived 关闭时不含归档卡）内的祖先数。祖先全部不在范围内的卡按顶层卡处理。
- 只提供 1..maxDepth 与 All（maxDepth 为范围内最深卡片的 level depth；Level maxDepth+1 等于 All，不单列）。
- 项目没有子卡片时不显示控件，`1/2/3/0` 快捷键也不做任何事。

**控件：**

- OverviewBar 芯片（`ListTree` 图标），紧跟任务总数之后：
  - 默认读 “Levels: All”；受限时为 accent 强调，如 “Levels: 1 · 11 hidden”（hidden 为筛选后本应显示、被 Levels 隐藏的卡数）。
  - 按下后，桌面打开 ContextMenu（`client/context-menu.tsx`），手机打开操作表。各选项带勾选，各附 “hides {n}”（由深度直方图得出）。
- Card tree 页头部有同一控件，同一个值。
- 快捷键 `1` `2` `3` 设层级，`0` 为 All。只在桌面 web、焦点在看板内、无修饰键时生效，写入 `shortcutHelp` 与 ? 对话框。不在本项目选项里的层级（大于 maxDepth）不做任何事。
- 卡片菜单和手机操作表：卡有被隐藏的后代（§2.4 的同一批）时显示 “Show its sub-cards”，已展开时显示 “Hide its sub-cards”。卡片树页上的卡片菜单不含这两项：页面的行只跟随页面自己的 Levels 和 Chevron，这两项只改看板。卡片 Pressable 同时提供同名 accessibilityActions。展开的效果是显示这张卡的整棵子树，只在本次访问有效，切换项目或改 Levels 时清空。
- 泳道底部：该泳道有被 Levels 隐藏的卡片时，显示 “Show {n} hidden sub-cards / Hide sub-cards”。
  - 复用 `OlderToggle`（`client/columns.tsx`）的样式，图标换成 `ListTree`，只在本次访问有效。
  - 位置：泳道的当前卡片之后、“Show {n} older tasks” 之前。展开后，这些卡按看板排序回到泳道里；其中较旧的已完成卡照常折叠在 Show older 下。
  - 手机列表把它作为 `laneRows` 的一种行（`kind: "levels"`），`sameRows` 一并比较。

**Levels 是视图设置，不是筛选：**

- 不计入 `filterCount` 和 Filter 按钮角标。
- Reset filters 不清除它。
- session 链接的筛选重置不需要碰它（目标卡会成为打开的卡，见下面的 keep）。
- 桌面 “{n} shown” 在筛选或 Levels 隐藏了卡片时都显示（今天只在 `filterCount > 0` 时显示）。

**流水线（`client/board.tsx`）：**

```
tasks（含 Show archived）
  → visible（搜索/优先级/类型/标签）
  → levelHidden = foldByLevel(tree, level, revealed, keep)   // 在整棵项目树上算，不在筛选后的列表上算
  → visibleLevel = visible − levelHidden（泳道底部展开时加回该泳道）
  → older finished 折叠（olderFinished）
  → onScreen
```

- 搜索框非空时暂停折叠，保证搜索总能找到被隐藏的子卡。此时芯片读 “Levels: {n} (paused while searching)”。
- **keep** = 打开的卡（`taskId`）加正在拖拽的卡。从 Attention、session 芯片深链、workspace 面板打开的卡都成为打开的卡，所以总是可见。
- 泳道表头计数、compact 泳道选择行（`laneAll.length`）、状态表计数、首次自动打开的泳道（`autoLane`）都用 visibleLevel：
  - 被 Levels 隐藏的卡不计数（同筛选）；
  - 被折叠的旧完成卡仍计数（不变）；
  - 既旧又被隐藏的卡按“被隐藏”处理。
- 泳道只剩被隐藏的卡时，空泳道文案为 “{n} sub-cards hidden at this level”，下面是展开按钮。
- J/K/H/L 导航、拖放槽位和手动位置锚点都跟 onScreen 走（同旧卡折叠）。`DesktopColumns` 的 `cancelKey` 加入 level、revealed 和搜索暂停状态。

**持久化。** `board-view.subCardLevels: z.record(z.string().max(200), z.number().int().min(1).max(9)).catch({}).default({})`（`shared/settings.ts`）。

- host 级，desktop 与手机共享，这是有意的（同其他 board-view 值）。
- 写入走 `useBoardView().update` / `saveMerged`，使用函数式补丁：在重新读到的文档上重建 record，这样另一台设备改的另一个项目不会丢（§1.4 第 8 条）。
- 写入时清掉已不在看板上的项目 key，最多保留 100 个。
- 读取时值大于等于 `subCardLimits.depth + 1` 视为 All。

### 2.4 汇总（roll-up）

**标志。** `cardFlags()` 用看板已有的数据给每张卡算一个 bitmask：

- NEEDS：未消除的 attention 有提问或权限请求，或自动化需要人（与 `client/attention.ts` 的 `automationNeedsYou` 同义：needs_human；failed 且未被收回；评审需要人）。
- ERROR：attention 有错误。
- UNREAD：有未读结果。
- ACTIVE：卡的 workspace 里有 running/initializing session，或 job 处于 starting/working/reviewing/retry_wait。
- HELD：§2.1 的 isHeld。

**归属。** 汇总的隐藏卡与芯片的 “{n} hidden” 是同一批（`boardLevels().folded`）：通过了筛选、被 Levels 隐藏、且所在泳道的底部没有展开的卡。被筛选掉的子卡不汇总，也不让卡片菜单出现 “Show its sub-cards”（按下也看不到它们）；它们的 act-now 状态仍在不受筛选影响的 Attention 里。泳道底部已展开的卡就在屏幕上，同样不算。（review 修正：原来用整棵项目树上 Levels 隐藏的全部卡，与芯片不一致。）`rollupBelow()` 把每张隐藏卡只算给一张卡：它在屏幕上的最近祖先。中间被隐藏的层会跳过。没有在屏幕上的祖先（例如祖先被筛选掉）时，只计入芯片总数，Attention 里照常列出，泳道底部的展开按钮也能把它显示出来。

**可见祖先卡面，在 “Sub-cards n/m” 之后依次显示：**

- “{n} hidden below”：`ChevronsDownUp` 图标，muted。始终显示（它说明这张卡为什么与平常不同）。
- “{n} below needs you”：warning，始终显示（act-now）。
- “{n} below with errors”：danger，始终显示。
- “{n} below held”：warning，始终显示。
- “{n} below running”：accent。
- “{n} below unread”：success。

running 和 unread 两项受 Card display 的 Session activity 开关（`sessions`）控制。无障碍标签合成一句，如 “11 sub-cards hidden: 1 needs you, 2 running”。

**其他规则：**

- “Sub-cards n/m” 仍只数直接子卡。卡片树页显示整棵子树的合计。
- 被隐藏的卡不会冲回泳道：状态一直在变，冲回会让卡片跳来跳去。act-now 信号靠 roll-up 和不受筛选影响的 Attention 保持可达。
- 不变：`attentionItems`、Attention 按钮计数、侧栏角标、`boardOverview`。它们仍按整个看板计算。
- Attention 行（`attentionRow`）对子卡片加一行灰色 “in {title}”（父卡标题）。

### 2.5 卡面

- **父卡面包屑**：子卡片在 CardMeta 层显示 `CornerLeftUp` 图标加父卡短标题，1 行，最多占 40% 宽度。
  - 无障碍标签 “Sub-card of {title}”（完整路径，用 › 连接）。
  - 新增 Card display 字段 `parent`（`shared/card-display.ts` 的 `cardFields`），默认开，可在 Settings → Cards 关闭（“Parent card”，说明 “Show which card a sub-card belongs to”）。
- **Held**：isHeld 的卡在信号行显示 warning 色 “Held by {title}”，多个时加 “+{n}”。属 act-now，不可隐藏。
- **“Waiting on {n}”**：含义不变，仍是未完成（open）的 blocker 数。有排队 job 的卡里，stuck 的 blocker 走 Held。
- **自动化芯片拆分**（`automationSignal` 增加 blocker 参数）：
  - queued 且 `readiness()` ready（只等名额、冷却或目录）：“Queued for agent”（不变）。
  - 被未完成 blocker 挡住：“Queued after blockers”（`Hourglass`）。
  - stuck：不显示自动化芯片，由 Held 信号表示。
- **不加** “Blocks N” 和关系行，避免噪音。“谁被我挡住”在抽屉和卡片树里看。

### 2.6 抽屉 Dependencies 区块

- 新的可移动区块 `dependencies`（`shared/drawer-sections.ts`）：默认展开，默认排在 Links 之前（Ideas 之后）。
- `drawerSectionOrder` 对已存储的顺序也会插入它（缺失的 id 插在默认顺序里它前一个区块之后，现有逻辑）。用户存过的展开/收起选择仍然优先。
- 只在卡有父卡、子卡片或 blocks 链接时渲染；否则同 Workpad/Ideas 关闭时一样原位跳过。
- 区块头（`Section`，`client/disclosure.tsx`）立即渲染；收起时的摘要为 “Waits for {n} · Blocks {n}”（两项各自为 0 时省略）。Waits for 的 n 只数这张卡仍在等的 blocker：未完成的，加上卡被 Held 时 hold 住它的 Cancelled/归档 blocker；不 hold 卡的 Cancelled/归档 blocker 按 §1.2 第 3 条算已解决，与卡面和 Links 的 “Was waiting on” 一致。（review 修正：原来数所有非 Done 的 blocker。）
- 内容，从上到下：
  1. **面包屑**：“Sub-card of Main › C5 › C5a”，各段可点。
  2. **邻域图**：三列 “Waits for | This card | Blocks”。
     - 节点固定高 40 pt（触屏 44），内容为 1 行标题、泳道标签、状态点。
     - 每侧最多 4 个，多出的合成 “+{n} more” 节点，点它打开卡片树并高亮链路。
     - 位置由纯函数 `neighbourhoodLayout(left, right, nodeH, gap)`（`client/geometry.ts`）给出。
     - 边：列间 16 pt 宽的 View，每个节点一条水平短线连到竖直总线，总线一条短线连到中间节点，末端为边框三角。颜色：done 为 success 浅色，open 为 muted，stuck 为 warning。
     - 区块宽度不足 420 pt 或 compact 时改为竖排：blocker 在上，本卡居中，被阻塞卡在下，一条竖轨加箭头。默认 440 pt 的侧栏也是竖排（内容宽约 408 pt）。竖排时 blocker 组上方和被阻塞组上方各有一行 18 pt 的小标题 “Waits for” / “Blocks”（三列时的列标题），该侧没有卡就不留这一行；`neighbourhoodLayout(…, { caption })` 把这两行算进预留高度，高度仍然精确。
     - 每个节点的无障碍标签带上它的关系：“Waits for: Open task {title}, {lane}”、“Blocks: …”，本卡为 “This card: {title}”，“+{n} more” 节点同样带前缀。两种排法都一样，读屏用户不靠位置也能分清。
  3. **“{n} more upstream”**：传递的未完成 blocker 数，点它打开卡片树。
  4. **Sub-cards 条**：直接子卡片按步骤排成芯片，带步骤号，之间用小箭头相连。
  5. **Held 行**：文案 “Holds this card until the link is removed”，带 X，乐观地调用现有 `deleteLink`（同 LinkRow）。
  6. **页脚 “Show in tree”**。
- 点任何节点或芯片，用 `openTaskById` 在抽屉中打开那张卡。
- **挂载时机**：正文高度由 `neighbourhoodLayout()` 按节点数立即算出并占位；节点和边只在抽屉打开动画结束后挂载（`useSettled`），所以下方区块不移动（§1.4 第 3 条）。
- **Links 区块不变**：仍是一跳、默认收起。唯一改动：`groupOf`（`client/link-rows.ts`）把有 queued job 的卡的 Held blocker 放进 “Waiting on”，不再放进 “Was waiting on”。

## 3. 数据与纯函数

无看板数据、RPC、daemon 或自动化改动。输入来自现有的 etag/patch 看板查询、实时 agent 流和现有 attention 计算（`allAttention`）。

**`shared/card-tree.ts`**（不 import react / react-native，vitest）：

- `buildCardTree(tasks, links): CardTree`，含 `{ ids, parent, children, depth, roots, chain(id), blockers, blocked, siblingEdges, step, cyclic, lifted, anomalies }`。
- `cardTreeOf(board, projectId)`：以 board.links 身份加项目形状键（id、archived、createdAt 拼接）缓存最近一次结果。看板、抽屉和卡片树页共用。
- `blockerState(task)`、`isHeld(tree, tasksById, job)`。
- `blockerIndex(tree, tasksById, jobsById)`：每张卡 `{ open, stuck, titles }`，一次线性遍历，替代 `client/board.tsx` 里按卡调用 `waitingOn` 的 `waitingIndex`（O(n·e)）。服务端的 `waitingOn` 不变。
- `levelHistogram(tree, inScope)`、`levelChoices(tree, inScope, cap)`。
- `foldByLevel(tree, level, revealed, keep, inScope): Set<string>`。
- `rollupBelow(tree, hidden, onScreen, flags): Map<id, Below>`。没有在屏幕上的祖先的隐藏卡不进 Map（只计入芯片总数）。
- `cardFlag` 位与 `statusFlags(tree, tasksById, jobsById)`：看板数据得出的位（done、cancelled、archived、waiting = 有 open blocker、stuck = 有 stuck blocker、held）；NEEDS、ERROR、UNREAD、ACTIVE 由 `client/card-flags.ts` 加上。`subtreeTotals` 把每个后代（不含自身）归入唯一一类，顺序为 done（Done 或 Cancelled）、needs（needs you 或 error）、active、waiting（held、stuck 或 open blocker）、rest。
- `scopeOf(tree, showArchived)`、`levelDepths(tree, inScope)`、`scopedChildren(tree, id, inScope)`：范围外的卡由它的子卡片顶替位置，大纲、Levels 与 Next 共用。
- `subtreeTotals(tree, flags)`、`chainOf(tree, id): { up, inherited, down }`、`nextUp(tree, root, flags)`。
- `outlineRows(tree, opts): Row[]`：字段全为基本类型，有 id、kind (card|group)、depth、step、nextStepHigher、hasKids、open、rails、last、inChain、dim。
- `sameRowList(prev, next)`：保持行对象身份，同 `sameRows`。

**`shared/card-levels.ts`**：`levelOf(view, projectId)`、`withSubCardLevel(record, projectId, level, liveIds)`。

**修改的 shared 模块：**

- `shared/settings.ts`：`subCardLevels`。
- `shared/card-display.ts`：`parent` 字段。
- `shared/drawer-sections.ts`：`dependencies` 区块。

**客户端：**

- `client/card-flags.ts`（纯）：`cardFlags({ tasks, attention, agents, automation, tree }) → Map<id, number>`。
- `client/geometry.ts`（纯）：增加 `neighbourhoodLayout()`。
- `client/lane-rows.ts`：`levels` 行。
- `client/board-view.ts`：函数补丁。
- `client/task-automation.tsx`：`automationSignal` 的 blocker 参数。
- `client/link-rows.ts`：`groupOf` 的 Held。
- `client/shortcuts.ts`：`tree`、`level-1/2/3`、`level-all` 动作，`tree` intent。
- 新组件：`client/card-tree-page.tsx`（页面）、`client/task-dependencies.tsx`（抽屉区块）。

## 4. UI 细节

### 4.1 桌面（宽度 ≥ 760）

- 卡片树页占泳道区域。行最宽 960 pt，居中。抽屉在右侧时页面变窄，不重排数据。
- 头部 Levels 用 `Choices` 分段。链路高亮栏在头部下方，同高淡入淡出，不造成布局跳动。
- 右键行打开卡片菜单。T、1、2、3、0 在页面里同样有效。`Esc` 的顺序：session 预览 → 关闭抽屉 → 清除链路高亮 → 离开页面。
- 看板 OverviewBar：Levels 芯片在任务总数之后，Tree 芯片在 Ideas、Memory、Insights 旁边。

### 4.2 Compact（手机或宽度 < 760）

- 同一个大纲，缩进 14 pt。根行的 Now/Next 行最多 2 行。
- Levels 芯片打开操作表。泳道选择行只属于泳道视图，卡片树页本来就没有它。
- 抽屉邻域图竖排。
- 长按行打开操作表。点行打开卡片覆盖层，页面保持挂载，Back 后滚动位置不变。
- 不加新的头部按钮。所有入口都在 OverviewBar（横向滚动）、菜单、操作表和抽屉里。

### 4.3 动效与无障碍

- 只用共享 motion 原语（`client/motion.tsx`）：opacity 和 transform，native driver，可打断。Reduce Motion 下直接切换。
- 不对节点位置做动画。展开就是插入行。
- 线条 View 设 `pointerEvents="none"`，并对无障碍隐藏。坐标经 `PixelRatio.roundToNearestPixel` 取整。
- 行的无障碍标签示例：“C3, Development, Agent working, step 3 of 5 under main card, waits for C2”。cyclic 卡加 “order is circular”。
- Chevron 的标签带卡名：“Show sub-cards of {title}” / “Hide sub-cards of {title}”。
- waits-for 芯片在行的 Pressable 里面，VoiceOver 把整行读成一个元素，够不到芯片；所以每个芯片也是行的一个 accessibilityAction（标签 “waits for {titles}”），效果与点芯片相同。
- 按 Hermes 规则（AGENTS.md），所有行和节点的处理函数都用 map 或 forEach 加 `useStableCallback(id)` 构建，不在 for 循环里建闭包。

## 5. 性能

- **树。** 按 board.links 身份加项目形状键缓存，状态、标题和实时 agent 的变化都复用它。19 张卡约 0.15 ms，300 张卡 jitless 约 11 ms 以内（node 基准估计，需真机核实）。
- **标志与汇总。** 依赖 [tree, board.tasks, allAttention, agents.data, board.automation] 做 memo，O(n·d)。卡片收到的 `below` 是小对象：加入 `client/card.tsx` 的 `contentProps`，并加入 `cardDerived` 的依赖。这样只有计数变化的卡才重渲染。
- **卡片树页：**
  - FlatList 虚拟化，每行约 12 到 16 个 View，首屏约 200 个 View。
  - 首次挂载由 `useSettled` 门控，在页面转场之后。
  - 行的 props 全是基本类型；`sameRowList` 让每 3 秒的轮询不重渲染没变的行；链路高亮只改两个布尔值。
  - 页面本身 `memo(…, samePageProps)`：看板传入的 props 都稳定（`nameOf` 按项目 `useCallback`），所以抽屉开合、toast、菜单引起的看板渲染不会让每个挂载的行重算 view。手机上卡片覆盖层盖住页面时（`active` 前后都为 false）页面完全不渲染，回到页面时按最新 props 渲染一次。
- **抽屉邻域图**：最多约 20 个节点、约 80 个 View，只在区块展开且抽屉打开结束后挂载；占位高度立即算出。
- **看板**：Levels 1 或 2 时挂载的卡片变少，泳道更便宜。`blockerIndex` 替换二次方的 `waitingIndex`。
- **perf 名称**：`tree.build`、`tree.flags`、`tree.rows`、`tree.mount`、`drawer.deps.mount`、`levels.change`。在 SM-S911B 上测后才能写数字；没有可测收益的优化撤回。
- **冷启动**：估计约 1,100 行、约 40 KB 未压缩。实测（Stage 4，2026-10-24，Paseo.app 自带的 esbuild 0.25.12，按 daemon `compiler.js` 的 client 选项在内存中编译 `index.client.tsx`，含 CommonJS 包装）：`2b00cf6` 1,287,613 字节 / 25,170 行，本分支 1,374,922 字节 / 26,855 行，**+87,309 字节（+6.8%）、+1,685 行**，约为估计的两倍。最大的是 `client/card-tree-page.tsx` 23.7 KB、`client/task-dependencies.tsx` 19.9 KB、`shared/card-tree.ts` 17.2 KB、`client/board.tsx` +9.8 KB。本机 V8 编译（`vm.Script`，25 次中位数）10.2 → 10.9 ms。插件加载时不做任何工作，不加依赖，不加静态表，bundle 里没有 `shared/i18n-all.ts` 或 catalog（已核对 metafile）。手机上的 `plugin.load` 差值未测。

## 6. Onboarding

- 新一次性提示 `card-tree`（`client/onboarding-logic.ts` 的 `tipIds`，文案在 `client/board.tsx` 的 `tipText`）：
  - 条件 fact `hasCardTree`：项目里有 depth ≥ 2 的卡，或有 ≥ 2 条 blocks 链接（纯函数 `cardTreeTipDue()`，`client/onboarding-logic.ts`），且没有打开的卡、页面或对话框。
  - 排在 `sub-cards` 之后（`nextTip` 的 order）。
  - 用户已看过 `sub-cards`，所以改那条提示的文案到不了他们；用新 id 才会对每个用户显示一次。
- 欢迎页 More features 的 “Sub-cards” 行改写正文，提到 Card tree 和 Levels。标题与图标（`ListTree`，唯一 key）不变。
- ONBOARDING-SPEC 提示表加一行。README.md 和 README.zh-CN.md 的亮点（“Cards and sub-cards” 一段）更新。

## 7. i18n 字符串（全部经 t()/tn()/msg()，`shared/i18n/` 的 9 个 catalog 都要有）

**页面与入口：**

- "Card tree"
- "Tree"
- "Flowly: Open card tree"（Command Center）
- "Show in tree"
- "Same number = parallel · arrow = later step"
- "Items"
- "Other cards"
- "Finished"（已存在，复用）
- "Now: {cards}"
- "Next: {cards}"
- "Needs you: {cards}"
- "(queued)"
- "+{n}"
- "Step {step} of {total}"
- "order is circular"
- "{title} (in {parent})"
- "{title} · Cancelled, holds this"
- "{title} · Archived, holds this"
- "Chain of {title}"
- "Levels"（页头 Choices 和 Levels 菜单的标题）
- "Sub-card levels shown: {text}"（Levels 芯片与 compact 页头按钮的无障碍标签）
- "Show sub-cards of {title}" / "Hide sub-cards of {title}"（行 Chevron 的无障碍标签，review 加入）
- "waits for {titles}"、"under {title}"（行与芯片的无障碍标签，§4.3）
- tn "{n} before"
- tn "{n} after"
- "Clear"
- "{done}/{total} done"

**Levels：**

- "Levels: All"
- "Levels: {n}"
- tn "1 hidden" / "{n} hidden"
- "Levels: {n} (paused while searching)"
- "Top-level cards only"
- "Down to level 2"
- "Down to level 3"
- "All levels"
- tn "hides {n}"
- "Show its sub-cards"
- "Hide its sub-cards"
- tn "Show {n} hidden sub-card" / "Show {n} hidden sub-cards"
- "Hide sub-cards"
- tn "{n} sub-card hidden at this level" / "{n} sub-cards hidden at this level"

**汇总：**

- tn "{n} hidden below"
- tn "{n} below needs you" / "{n} below need you"
- tn "{n} below with errors"
- tn "{n} below held"
- tn "{n} below running"
- tn "{n} below unread"
- tn "{n} sub-card hidden: {details}" / "{n} sub-cards hidden: {details}"

**卡面：**

- "Held by {title}"
- "Queued after blockers"
- "Parent card"（Card display 字段）
- "Show which card a sub-card belongs to"
- "Checkout redesign"（Settings → Cards 预览里示例父卡的标题）
- "Sub-card of {title}"（已存在，复用）

**抽屉：**

- "Dependencies"
- "Waits for"
- "Waits for {n}"（收起摘要）
- "Blocks {n}"（收起摘要）
- "Blocks"（已存在）
- "This card"（已存在）
- tn "+{n} more"
- tn "{n} more upstream"
- "Holds this card until the link is removed"

**Attention：**

- "in {title}"

**快捷键帮助：**

- "Open card tree"
- "Show top-level cards only"
- "Show down to level 2"
- "Show down to level 3"
- "Show all levels"
- "Back from session, then close sidebar, then clear the chain, then leave Insights, Ideas, Memory or Card tree"（替换现有 Esc 说明）

**Onboarding：**

- tip："Open Tree in the bar above to see each item from the whole to its parts, with its steps in order. Levels hides deeper sub-cards on the board."（Stage 4 改写：原文没说页面从哪里打开，见 §1.5 第 10 条）
- 欢迎页 Sub-cards 行正文："Agents split work into sub-cards with their own workspaces; a supervised parent waits and accepts them. Card tree shows each item's steps in order, and Levels hides deeper sub-cards on the board."

## 8. 修订的 spec

- **CARD-LINKS-SPEC**：
  - §1：卡片树页与 Levels 纳入范围。
  - §2.5：Held 的定义，只适用于有 queued job 的卡。
  - §5.1：父卡面包屑、Held、roll-up 可上卡面；仍不加 Blocks N。
  - §5.2：groupOf 的 Held。
  - §9：删除“关联图视图”，改为“二维图另行 spec”。
- **SUB-CARDS-SPEC §6**：卡片树、Levels、汇总。
- **CARD-DISPLAY-SPEC**：`parent` 字段；“hidden below”“below needs you / errors / held” 和 Held 属始终显示。
- **DRAWER-SPEC**：Dependencies 区块。
- **AUTOMATION-SPEC §6**：排队芯片拆分。
- **SHORTCUTS-SPEC**：加 T 和 0–3；补 I/B/M/E/⇧H/⇧L 与 Welcome tour；intent 有效期改为 5 s；Command Center 条目名改为 `Flowly: …`。
- **FINISHED-CARDS-SPEC**：流水线顺序和计数规则。
- **ONBOARDING-SPEC**：提示表与优先级。
- **PERFORMANCE-SPEC**：卡片树预算。
- **SPEC-OUTLINE** 条目，以及 PROGRESS 中区分“已运行 / 未运行”的检查。

## 9. 验收

### 9.1 单元测试（vitest，npm test；先 typecheck）

**card-tree**，用镜像用户 19 张卡的 fixture，不是真实看板：

- depth 0 到 3。
- 真实形状下 research ×3 与 C1 的 step 都是 1，C2..C5 为 2..5；若 C1 waits for research，则 C1..C5 为 2..6。
- C4a = 1，C4b = 2；C5a = 1，C5b = 2；x.1..x.3 = 1..3。
- 兄弟排序与 DFS 大纲顺序确定。

**提升：**

- C4b→C5a.1 提升为 C4→C5 并与已有边去重，真实边标记 lifted。
- 两棵树之间的边落到根组。
- 祖先边被忽略。
- A1→B2 加 B1→A2 能结束，带 cyclic，结果确定。

**健壮性：** subtask 环、两个父卡、指向缺失或跨项目卡的链接、归档的父卡（Show archived 关与开）、blocks 自环、300 节点随机 DAG，都能在时间上限内结束。

**isHeld 与 readiness() 一致：** 每个 queued job 上，isHeld 为真当且仅当 `readiness()` 的 reason 是 blockers 且 cancelled 非空。没有 job 的卡，Cancelled blocker 视为已解决。

**blockerIndex：** 对每张卡，open 的数量等于 `waitingOn().length`。

**foldByLevel：**

- 用户 fixture 下 1 / 2 / 3 / All 分别显示 1 / 9 / 13 / 19 张卡。
- keep 让打开的 C5a.2 可见。
- revealed 显示整棵子树；改 level 时清空 revealed；搜索暂停折叠。
- 归档父卡在 Show archived 关闭时不在范围内，它的子卡按顶层卡处理。

**rollupBelow：**

- 隐藏孙卡的 needs you 只算在最近的可见祖先上，跳过隐藏的中间层，从不重复计数。
- 已消除的 attention 不计。
- running 只看 session 和 live job。
- 祖先被筛掉时上移到更高祖先，或只计入芯片总数。

**Attention 不变：** level 1 与 All 下，`attentionItems`、`attentionFromSources`、`boardOverview` 结果完全相同。

**outlineRows / sameRowList：**

- 默认展开跟随 level，逐行覆盖优先。
- rails 与 last 正确；Other / Finished 分组行正确。
- 链路高亮强制展开祖先。
- 只有无关卡变化时返回原数组。

**chainOf 与 nextUp：** 规则见 §2.2。

**neighbourhoodLayout：** 每侧 0 到 5 个节点、“+n” 合并、竖排变体、占位高度与挂载后的高度相同。

**cardFlags：** bitmask。

**lane-rows：** `levels` 行的位置（当前卡片之后、older 之前）、空泳道、`sameRows` 比较。

**settings：**

- `subCardLevels` 默认为 {}。
- 非法值经 `.catch` 回到 {}，不重置文档其他字段；`shared/settings.test.ts` 第一个测试的两个完整对象加上 `subCardLevels: {}`。
- `withSubCardLevel` 清理已删项目，最多 100 个，并保留并发写入的其他 key；`saveMerged` 的函数补丁在冲突重试时基于重新读到的值。

**card-display / drawer-sections：** `parent` 默认开；`dependencies` 会插入已存储的顺序（Ideas 之后），默认展开。

**shortcuts：** T 和 1/2/3/0 正确解析；有修饰键、按键重复或 IME 输入时忽略；shortcutHelp 列出；`tree` intent 能被 `parseBoardIntent` 接受，Command Center 条目里有它。

**automationSignal：** ready 时为 “Queued for agent”，被未完成 blocker 挡住时为 “Queued after blockers”，Held 时为 null。

**link-rows groupOf：** Held blocker 放在 “Waiting on”。

**onboarding-logic：** `card-tree` 的触发、排序和抑制条件。

**i18n catalog：** 所有新字符串都在 9 个 catalog 里，占位符一致。

**测试后：** `paseo project ls` 与测试前相同，没有多出资源；单测不碰真实 daemon 或 `~/.paseo`。

### 9.2 实测（app.paseo.sh 连本机 daemon；桌面 1440 和 compact 390）

先核对 host 名与 serverId，并看到 Tree 芯片，证明加载的是刚 reload 的版本。

fixture 为项目 `plugin-test-2026-10-24-card-tree`，放在临时目录，用插件 RPC 建一份 19 张卡的同形树：subtask 加 blocks；一张卡带提问；一个 failed job；一张 queued 卡的 blocker 是 Cancelled（自动化开启，但只排队这张被 hold 的卡，不会有 agent 启动）。先记下 ID。不用 “Better workspace” 的真实卡片。

每个场景截图（`docs/promo/shot-lib.mjs`）：

- (a) Levels 1/2/3/All：泳道计数、roll-up 信号、空泳道文案、泳道底部展开按钮。
- (b) 刷新后 level 仍在，且不影响第二个 fixture 项目。
- (c) 从 Attention 打开一张被隐藏的卡，它显示出来；Attention 行有 “in {parent}”。
- (d) Show/Hide its sub-cards。
- (e) 卡片树：步骤号、箭头、waits-for 芯片、Now/Next 行、折叠、链路高亮；从卡片菜单和抽屉 Show in tree；T 和 0–3；Esc。
- (f) 抽屉 Dependencies：面包屑跳转、邻域图、compact 下竖排、移除 Held 链接、打开抽屉时下方区块不跳动。
- (g) Held 卡面与 “Queued after blockers”。

截图与记录放在 `docs/verification/card-tree.md`，写明 daemon 版本、插件路径与 commit、fixture ID、结果和未验证的部分。结束后删除 fixture，并在原生 Paseo 和插件看板里各确认一次。

手机性能（可选，有设备时）：`tree.build`、`tree.mount`、`drawer.deps.mount`、level 1 与 All 下的 `board.render`。没跑的记为 UNRUN。

## 10. v1 不做

- 子卡片超过 3 层（需改 `subCardLimits`、daemon、自动化、预算）。
- 整个项目的二维 DAG 画布（嵌套盒子、平移、固定缩放档位）。
- 看板上的 hover 或固定链路追踪、卡面上的 “Blocks N” 与关系行、短标题。
- 在树、邻域图里拖拽建立或删除链接，以及兄弟或根的手动排序。
- 卡片树页内的键盘导航（J/K/H/L、Enter）。
- 把 Held 卡加入 Attention 列表和角标。
- 时间估算或加权关键路径（没有估算字段）。
- 在树里画 follow-up 和 related 边（仍在抽屉 Links 列表里）。
- 按设备而不是按 host 存 level。
- 卡片树页套用看板筛选并保留祖先上下文。
- 没有自动化的卡也按 dispatcher 语义显示 “Waiting on”。
- 显示 dispatchPlan 的下一个名额或 moving/held 运动状态。
- 点卡面 roll-up 芯片直接展开（v1 只用菜单和 accessibilityAction）。
- 修正 `client/lane-list.tsx` 的 FlatList 检测（§1.4 第 10 条，另行核实）。

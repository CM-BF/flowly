# Ideas 卡片：agent 提议下一步任务

状态：用户 2026-10-15 确认设计（来源 A：agent 工具；显示 A：来源卡侧栏 + 角标；建卡 A：预填新建表单），并要求直接实现、不再审阅 spec。卡片任务 `fa62fb3d`。

## 1. 目的

agent 工作时常发现本卡范围之外、值得做的后续工作（顺带发现的 bug、重构机会、下一阶段功能）。现在这些只留在对话里，用户要自己记、自己重新描述上下文。

Ideas 让 agent 把它们作为结构化建议挂到来源卡上；用户觉得好就一键打开预填好的新建表单，带着上下文建出新卡；不好就忽略。

idea 不是任务卡：不进泳道、不占 workspace、不改来源卡状态或 task revision。只有用户点 **Good idea** 并保存表单才会产生卡片；agent 永远不自行建卡或派活（v1 不做自动分配）。

## 2. 数据

### 2.1 Idea

存在 `board.json` 的 `ideas` 数组（与卡片、事件、回执同一个文件），使提出 idea 与回执、从 idea 建卡与标记 accepted 都在同一次原子事务中完成，客户端也随现有 etag 看板读取拿到 ideas，不新增轮询。旧文件没有该字段时读作 `[]`；看板版本仍为 v4，不迁移。

```
{ id, taskId（来源卡）, projectId, agentId, eventId（提出时的 Activity 事件）,
  title    ≤120 字符，非空
  detail   ≤4000：要做什么、验收标准
  rationale ≤1000：为什么值得做、由什么触发
  context  ≤4000：新任务需要的文件、分支、发现（新卡的 agent 看不到来源卡对话）
  type?: TaskType, priority?: Priority,
  status: "open" | "accepted" | "dismissed",
  acceptedTaskId?: string,
  createdAt, updatedAt }
```

- 每张卡最多 10 个 `open` idea；每张卡最多保存 50 个 idea，超出时删除最早的非 open idea。
- `accepted` 是终态，不能再改。

### 2.2 Task.origin

卡片新增可选字段 `origin: { taskId, ideaId }`，表示由哪张卡的哪个 idea 建出。旧卡没有该字段，不迁移。来源卡或 idea 后来被删除时字段保留，界面显示为已删除。

### 2.3 回执与事件

- 回执 `action` 新增 `"idea"`；`status` 记录提出时卡片的状态。
- Activity 事件：
  - `idea_proposed`（agent，来源卡，note=标题）
  - `idea_accepted`（human，来源卡，note=`标题 → 新卡标题`）
  - `idea_dismissed`、`idea_restored`（human，来源卡，note=标题）

## 3. Agent 工具 `kanban_propose_idea`

输入（strict）：

```
{ expectedRevision, request,             // 同其他写工具，来自 kanban_get_task
  title, detail, rationale,
  context?: string = "",
  type?: "feature"|"bugfix"|"research"|"refactor"|"docs"|"chore",
  priority?: "low"|"normal"|"high"|"urgent" }
```

- 与 `kanban_report_progress` 相同的身份、签名、过期、revision、归档和已完成检查；不改卡片状态或 revision。
- 重放：同一 request 同一参数返回原回执与原 `ideaId`（`replayed: true`）；参数不同报 `REQUEST_REUSED`。
- 错误：
  - `IDEA_DUPLICATE`：本卡已有同标题的 open idea（去首尾空白、忽略大小写），消息中带已有 idea ID。
  - `IDEA_LIMIT`：本卡已有 10 个 open idea。
- 输出：`toolResultSchema`，多一个 `ideaId`。
- `kanban_get_task` 的上下文新增 `ideas: [{ id, title, status, acceptedTaskId? }]`（本卡全部 idea），供 agent 避免重复。
- CLI 新增 `idea` 子命令：`idea --request-file <snapshot> --title … --detail … --rationale … [--context …] [--type …] [--priority …]`（不需要 `--note`）。HTTP `/api` 的 `action` 新增 `"idea"`。

## 4. Skill 规则（新增一条）

- 工作中发现**超出本卡范围**的后续工作时用 `kanban_propose_idea` 提出，通常在交付时；本卡自身未完成的部分不是 idea。
- 每次交付最多 3 个；先看 `ideas` 避免重复。
- `context` 写清新任务需要的文件、分支和结论，因为新卡的 agent 看不到本对话。
- idea 只是建议：不要自行开始、不要建卡。

## 5. UI

### 5.1 看板卡片

有 open idea 时，在卡片底部信号行显示灯泡图标（`Lightbulb`）加数量；为 0 时不显示。无障碍文本包含 “N ideas”。

### 5.2 侧栏 Ideas 区块

位置：Sessions 之后、Details 之前（2026-10-15 用户反馈：放到 Sessions 下面）。卡片没有任何 idea 时整个区块不渲染。

- 标题 `Ideas`，计数为 open 数。
- 每个 open idea 一张小卡片（2026-10-16 用户要求优化设计、交互与动效，接受按钮改为 Good idea）：
  - 标题（加粗）；一行元信息：类型、优先级（仅非 Normal；High/Urgent 带箭头图标，Low 显示为不带图标的 “Low priority”）、提出时间（相对时间）；理由最多 2 行。
  - 有更多内容时点击卡片展开 “What to do”（detail）与 “Context”，不截断；右上角 chevron 随展开旋转 180°，高度与透明度一起过渡（展开 220 ms 减速、收起 160 ms 加速）。
  - 左下角按钮（2026-10-16 用户反馈改为左对齐，主操作在前）：**Good idea**（主操作，`ThumbsUp` 图标，打开预填新建表单）、**Not now**（安静按钮，忽略）。按钮使用紧凑尺寸（2026-10-16 用户反馈移动端过大）：手机 32 pt 高、桌面 28 px，12 号字，触控区域仍通过 hitSlop 保持 44 pt；Closed 分组的 Restore 同样紧凑。无障碍名称分别为 “Not now: dismiss …”、“Good idea: create a task from …”。
  - Not now 为乐观更新：卡片立即在原位收起（高度、透明度与轻微缩放一起过渡 160 ms），保存失败时恢复并弹 error toast。idea 被转成卡片后同样收起离开列表。
  - 抽屉打开时已有的 idea 不播放进场；打开期间新到达（agent 提出）或被 Restore 的 idea 上浮淡入。
  - 所有动效使用 `client/motion.tsx` 原语，遵循 Reduce Motion、可打断；收起中的卡片不可交互、对读屏隐藏。
- 没有 open idea 但有已关闭的 idea 时显示 “No open ideas. Agents add them when they find follow-up work.”
- 非 open 的 idea 收在默认折叠的 `Closed · N` 分组：
  - accepted（`ThumbsUp` 图标）：显示 “→ 新卡标题”，点击打开该卡；新卡已删除时显示 “→ deleted card”。
  - dismissed：显示弱化标题与 **Restore**。
- 卡片已归档或项目已归档时按钮禁用。
- Not now / Restore 成功不弹 toast（列表本身即反馈），失败用 error toast。

### 5.3 新卡侧栏

有 `origin` 时，在描述之前显示一行 “From idea on <来源卡标题>”，点击打开来源卡；来源卡已删除时显示 “From idea on a deleted card”，不可点。

## 6. 从 idea 建卡

1. 点 **Good idea** 打开现有新建任务表单（同一组件），预填：
   - 标题、类型、优先级 = idea 的值（未给则为表单默认）；状态 = 该项目第一个可用的起始泳道（与普通新建相同的默认）。
   - 描述 = `ideaDescription()`（`shared/ideas.ts`）：

     ```
     <detail>

     Why: <rationale>

     Context:
     <context>

     From card: <来源卡标题> (<来源卡 ID>)
     Source progress:            // 仅当来源卡有 summary
     <target>
     <recap>
     ```

     超过描述上限 20000 时截断并以 `…` 结尾。
   - workspace 与 “Start agent” 照常可选；第一条指令不预填（现有规则）。
   - 表单标题为 “Create task from idea”。
2. 保存时 `tasks.create` 的输入带 `ideaId`。服务端：
   - 创建 workspace **之前**检查 idea 存在、为 open、属于同一项目，否则报 “This idea is no longer open.”，不留下 workspace。
   - 写入新卡的同一事务中再检查一次，写 `origin`，把 idea 改为 accepted 并记录 `acceptedTaskId`，在来源卡记 `idea_accepted` 事件。
   - 同一 `operationId` 的重复提交返回首次创建的卡（现有行为），不重复处理 idea。
3. 新卡的 agent 会话上下文在任务类型之后加一行 `Derived from card: <来源卡标题> (<ID>)`。

## 7. 人工 RPC

| 方法 | 输入 | 行为 |
| --- | --- | --- |
| `ideas.update` | `{ id, status: "open" \| "dismissed" }` | open ↔ dismissed；accepted 报错；恢复为 open 时受 10 个上限约束；状态不变时不写 |

看板 revision 随之增加，客户端经现有 etag 读取刷新。

## 8. 删除与归档

- 永久删除卡片：一并删除以它为来源的 idea，写入 `removed/task-…json` 备份。由这些 idea 建出的卡保留 `origin`。
- 移除项目：一并删除并备份该项目的 idea。
- 归档卡片：idea 保留；agent 不能再提出（与其他写工具一致）；Good idea / Not now 禁用。

## 9. 不做

- summarizer 自动生成 idea；项目级 Ideas 收件箱；虚拟 Ideas 泳道。
- 自动建卡或自动给新卡派 agent；idea 排序、投票、编辑。

## 10. 验收

- 单元：
  - 提出：回执重放、`REQUEST_REUSED`、`IDEA_DUPLICATE`、`IDEA_LIMIT`、归档/已完成拒绝、不改 task revision、50 个上限修剪。
  - 建卡：预检与事务内复检、`origin` 与 accepted 原子写入、非 open idea 报错且不创建 workspace、跨项目拒绝。
  - `ideas.update` 状态约束；删除卡片与移除项目的级联与备份；旧 `board.json`（无 `ideas`）可读。
  - `ideaDescription()` 输出与截断；`sessionContext` 的来源行。
- 工具服务：注册 `kanban_propose_idea`；`/api` 的 `idea` 动作；`kanban_get_task` 返回 `ideas`。
- typecheck、全量测试；安装并 reload 本插件；用 Luna 6 全权限测试 session 在 fixture 卡片上走通“提出 → 侧栏显示 → 建卡 → 双向链接”，结束后清理。

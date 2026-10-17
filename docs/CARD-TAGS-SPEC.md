# 卡片自定义标签（Tags）

状态：2026-10-18 用户确认设计（agent 不能删人打的标签、每卡 12 个、agent 改标签不改 task revision、词表由卡片统计），已实现。卡片任务 `11122d9a`。验证见 [verification/card-tags.md](verification/card-tags.md)。

实现与设计的差异：侧栏 Tags 行用内联编辑器（点 `+` 展开，`✓` 收起），没有使用锚定下拉。

## 1. 目的

`type`（TASK-TYPE-SPEC）回答“这是什么类型的工作”，取值固定六种。标签回答“这项工作落在哪里、往哪个方向”：功能模块（`drawer`、`session-composer`、`i18n`）、优化方向（`performance`、`a11y`、`mobile`）、横切主题（`security`、`onboarding`）。取值由项目自己长出来，人和 agent 都能打。

原则：

- 标签是**自由文本 + 项目内词表**：不要先建标签再使用，词表从本项目卡片上已有的标签统计得出，用来提示复用、避免同义词泛滥。
- 标签只用于**展示、筛选和搜索**：不改业务状态、不触发自动动作、不进入状态规则。
- agent 通过专用工具给**自己的卡**打标签；不能改其他卡，也不能删除人打的标签。
- 为将来的搜索准备：标签是规范化的精确匹配字段（§7）。

## 2. 数据

### 2.1 字段

`taskSchema` 新增可选字段：

```
tags?: Array<{
  tag: string,                 // 规范化后的值（§2.2）
  by: "human" | "agent",
  agentId?: string,            // by=agent 时
  at: timestamp,
}>
```

- 缺失读作空数组；旧卡无需迁移，看板版本不变（同 `type`）。
- 数组顺序即显示顺序（按添加先后）。同一卡内 `tag` 唯一。
- 记录来源是为了 §4 的权限规则和界面上区分 agent 打的标签；搜索与筛选只看 `tag`。
- 人编辑一个 agent 打的标签（在表单里保留它）不改变来源；人删掉再加回则变为 `human`。

`shared/model.ts` 新增 `tagLimits = { length: 32, perTask: 12, perCall: 12, suggestions: 50 }`、`normalizeTag()` 和 `tagSchema`。

### 2.2 规范化

输入在客户端与服务端用同一个 `normalizeTag`（`shared/tags.ts`）：

1. NFKC，去首尾空白，转小写（`toLocaleLowerCase("en")`，不受设备语言影响）。
2. 去掉开头的 `#`（方便从搜索框或对话里粘贴）。
3. 连续空白和 `_` 折叠为 `-`；连续 `-` 合并，去掉首尾 `-`。
4. 允许字符：Unicode 字母与数字、`-`、`.`、`/`。中文等非拉丁标签直接可用（`抽屉`、`性能`）。
5. 长度 1–32（按字符计）。

不合规的输入报错，不静默改写成别的值：`Tags can only use letters, numbers, "-", "." and "/".`、`Tags can be at most 32 characters.`。

`/` 用作可选的层级前缀（`module/drawer`、`perf/startup`）。v1 不解释层级，只在筛选与搜索中支持前缀匹配（§6.4、§7）。

### 2.3 项目词表

不单独存储。服务端从本项目**未归档**卡片的标签统计 `{ tag, count, lastUsedAt }`，按 count 降序、再按 lastUsedAt 降序，取前 50 个：

- 客户端从已有的 etag 看板读取里自行计算，不新增 RPC 和轮询。
- `kanban_get_task` 返回 `projectTags`（同样的前 50 个），让 agent 优先复用已有写法。

重命名、合并、删除标签见 §9（v1 不做）。

### 2.4 事件与 revision

- 人在新建/编辑表单里改标签：属于普通 `edited`，按现有规则增加 task revision。
- 人在侧栏直接加/删单个标签、agent 用工具改标签：**只增加看板 revision，不改 task revision**（同 artifacts）。这样 agent 打标签不会让同卡其他 session 手里的 request/revision 失效，也不会让正在打开的编辑表单冲突。
- 每次实际变化记一条事件 `tags_changed`，note 为 `+drawer +performance −old-tag`；actor 为 human 或 agent（带 agentId）。没有变化（重复添加、删除不存在的标签）不记事件。

### 2.5 并发合并

编辑表单保存的是一整组标签，但打开表单之后 agent 可能又加了标签。为了不悄悄丢掉它们，`tasks.update` 的标签按三方合并处理：

- 客户端提交 `tags`（表单里的最终集合）和 `tagsBase`（打开表单时看到的集合）。
- 服务端：`结果 = 当前 − (base − tags) + (tags − base)`，保持当前顺序，新增的追加在后。
- 合并后超过 12 个时拒绝：`A card can have at most 12 tags.`

## 3. 人工 RPC

| 方法 | 输入 | 行为 |
| --- | --- | --- |
| `tasks.create` | 增加可选 `tags: string[]` | 规范化、去重后写入，来源 `human` |
| `tasks.update` | 增加可选 `tags: string[]` 与 `tagsBase: string[]`（必须同时给出） | 按 §2.5 合并；只给其中一个时报 schema 错误 |
| `tasks.tags` | `{ taskId, add?: string[], remove?: string[] }` | 侧栏单个增删；不需要 task revision，按 §2.4 只增看板 revision |

人可以删除任何标签，包括 agent 打的。卡片或项目已归档时写操作拒绝：`Archived cards can't be changed.`

## 4. Agent 侧

### 4.1 工具

新增 MCP 工具 `kanban_set_tags`（CLI 同步提供 `tags` 子命令：`tags --request-file <f> --add drawer,performance --remove old-tag`），遵循现有签名 request + expectedRevision 协议，幂等，不改 task revision：

```
{ expectedRevision, request,
  add?: string[],      // ≤ 12 个
  remove?: string[] }  // ≤ 12 个
```

- `add` 与 `remove` 至少给一个非空；同一个值不能同时出现在两边。
- 规范化规则同 §2.2；任一值不合规则整次调用拒绝，不部分写入。
- 已存在的标签再次 add 是空操作（来源不变）。
- `remove` 只能移除 agent 打的标签（任一 session 均可，同卡 session 共享工作）。移除人打的标签拒绝：`Only the user can remove tags they added.`；移除不存在的标签是空操作。
- 返回 `{ receipt, tags, current }`，`current` 同其他写工具，是刷新后的 get_task 内容。

`kanban_get_task` 的 `task` 带上 `tags`，并新增顶层 `projectTags`。

工具描述（写进 description 与 skill）：

> Tag this card with the functional areas it touches and the improvement directions it serves (for example a module like "drawer" or "session-composer", or a direction like "performance", "a11y", "mobile"), so the user can filter and search cards later. Tags are not the task type, status or priority; do not repeat those. Reuse a tag from projectTags in get_task when one fits instead of inventing a synonym. Use 1–4 short lowercase tags, add them once you understand the scope, and adjust them if the scope changes. You can only remove tags an agent added.

### 4.2 会话上下文

`sessionContext` 在 `Task type` 行后加 `Tags: drawer, performance`（有标签时才加）。普通 follow-up 不附带，遵守“只发送用户原文”的约定。

### 4.3 Ideas

`kanban_propose_idea` 增加可选 `tags: string[]`（≤ 12，同规范化）。从 idea 新建卡片时，表单预填这些标签，建卡后来源为 `human`（用户确认过）。`ideaSchema` 增加 `tags?: string[]`。

### 4.4 Skill

`skills/paseo-ultra-kanban/SKILL.md` 与 `server/skill-source.ts` 加一条：理解范围后用 `kanban_set_tags` 给本卡打 1–4 个模块/方向标签，优先复用 `projectTags`。

## 5. 错误

| 情况 | 错误 |
| --- | --- |
| 非法字符 | `Tags can only use letters, numbers, "-", "." and "/".` |
| 超长 / 空 | `Tags can be at most 32 characters.` / `A tag can't be empty.` |
| 超过 12 个 | `A card can have at most 12 tags.` |
| agent 删人打的标签 | `Only the user can remove tags they added.` |
| add 与 remove 重叠 | `A tag can't be both added and removed.` |
| 归档卡片 | `Archived cards can't be changed.` |

daemon 与工具错误保持英文。存储里出现非法标签时，看板校验失败但保留数据文件，不重置（同其他字段）。

## 6. 界面

### 6.1 新建 / 编辑表单

Type 下方新增 **Tags** 字段：已选标签显示为可删除的 chip，后跟一个 `TextBox`。输入时在下方列出词表中前缀匹配的建议（最多 6 个），回车、逗号或点建议添加；退格在空输入上删除最后一个。规范化错误显示在字段下方，不阻塞其他字段编辑。输入框遵守 `TextBox` 约定（不回填 value）。

### 6.2 卡片

meta 行在优先级/类型 pill 之后显示标签：中性小号文字 chip（无图标，前缀 `#`），最多 2 个，其余显示 `+N`。无标签不占位。卡片宽度不足时只显示 `+N`。

### 6.3 侧栏（drawer）

Status / Priority / Type 下方新增 **Tags** 行：显示全部标签，agent 打的带一个小的机器人图标（无障碍标签 “Added by an agent”）。末尾 `+` 按钮打开与表单同样的输入与建议（桌面为锚定下拉，手机为底部 sheet），每个 chip 可删除；通过 `tasks.tags` 立即保存并 toast。点击 chip 本身把它加入看板筛选（§6.4）。

Details & workspace 增加 Tags 行。

### 6.4 筛选与搜索

- 筛选面板新增 **Tags**：词表多选，命中任一即显示（OR）；以 `/` 结尾的选项（如 `module/`，当词表里有层级标签时自动出现）按前缀匹配。保存在看板视图设置 `filterTags: string[]`（默认 `[]`，最多 20 个），计入筛选角标，Reset filters 清空。
- 现有搜索框：普通文字同时匹配标题、描述和标签；`#drawer` 形式的词按标签精确匹配，`#module/` 按前缀匹配，多个 `#` 词之间为 AND。

### 6.5 Onboarding

- 欢迎引导的特色功能页加一句：“Tag cards by module or direction — agents tag their own cards too — then filter and search by tag.”
- 新增一次性提示 `tags`：看板上第一次出现 agent 打的标签时显示 “Agents tag their cards by module and direction. Click a tag to filter by it.”；`nextTip` 优先级排在 ideas 之后。更新 `client/onboarding-logic.test.ts` 与 ONBOARDING-SPEC 提示表；README highlights 同步。

所有新文案进入 `shared/i18n/` 全部语言目录。

## 7. 将来的搜索

本 spec 只做看板内的本地筛选，但字段按搜索的需要设计：

- 标签是规范化后的精确值，搜索索引可直接以 `tag` 作为关键字字段，不需要分词。
- 查询语法预留：`#tag` 精确、`#prefix/` 前缀、`-#tag` 排除（v1 搜索框只实现前两种）。
- 跨项目搜索时按标签值聚合，不同项目的同名标签视为同一个关键字。
- `tags_changed` 事件保留增删历史，将来可用于“这个模块最近改了什么”。

## 8. 实现落点

- `shared/tags.ts`：`normalizeTag`、`parseTagInput`（逗号/空白分割）、`mergeTags`（§2.5）、`projectTagStats`。
- `shared/model.ts`：`taskSchema.tags`、`ideaSchema.tags`、`tagLimits`。
- `shared/rpc.ts` / `server/service.ts` / `server/store.ts`：`tasks.create/update` 字段、`tasks.tags`，事件 `tags_changed`。
- `shared/tools.ts` / `server/tool-server.ts` / `server/cli-source.ts`：`kanban_set_tags`、`tags` 子命令、`get_task.projectTags`。
- `shared/scope.ts`：`sessionContext` 的 Tags 行。
- `shared/settings.ts`：`filterTags`。
- `client/forms.tsx`、`client/board.tsx`、`client/drawer.tsx`：§6；新增 `client/tag-input.tsx`（表单与侧栏共用，memo 化，建议列表只在输入时计算）。

## 9. 不在 v1

- 项目级标签管理（重命名、合并、删除，批量改写所有卡）和标签颜色。词表只是统计结果；如果使用中出现同义词泛滥，再加管理页。
- 标签的层级展开/树形筛选。
- 按标签的统计（Insights）。
- 跨项目或全局搜索 UI。

## 10. 验证

- 单元：`normalizeTag` 各规则（大小写、`#`、空白/下划线、中文、非法字符、长度）；`mergeTags` 三方合并（agent 在表单打开后新增的标签被保留，人删掉的不复活）；上限；词表统计排除归档卡并正确排序。
- store / service：表单编辑增 task revision；`tasks.tags` 与工具只增看板 revision；事件 note 与“无变化不记事件”；归档拒绝；非法存储值不重置文件。
- tool-server：`kanban_set_tags` 幂等重放、整次拒绝不部分写入、agent 不能删人打的标签、add/remove 重叠、`get_task` 的 `tags` 与 `projectTags`；CLI `tags` 子命令。
- `sessionContext` 仅有标签时含 Tags 行；ideas 带标签并预填新建表单。
- 设置：`filterTags` 默认 `[]`、上限；看板筛选 OR 与前缀；搜索 `#tag` AND。
- onboarding-logic：`tags` 提示规则。
- typecheck、全量 `npm test`；按 AGENTS.md 用 full-access `codex/gpt-6-luna` session 做安装后的工具与 UI 验收，结果记入 `docs/verification/card-tags.md`。

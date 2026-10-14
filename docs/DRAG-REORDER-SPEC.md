# F3：列内拖拽排序与跨列定点放置

状态：2026-10-15 增量 spec，先于实现编写。上游：[UI-UX-SPEC §3](UI-UX-SPEC.md#3-desktop-drag-to-change-status)、[MOTION-SPEC](MOTION-SPEC.md)、[UI-REFRESH-SPEC](UI-REFRESH-SPEC.md)。本文只扩展桌面拖拽的落点，其余拖拽规则（整卡鼠标拖拽、8 pt 阈值、点击抑制、文本不可选、横向边缘滚动、取消条件）保持不变。

## 1. 可观察行为

- 桌面（展开布局、鼠标主键）拖拽卡片时，指针所在列内显示一条 2 pt 的 accent 插入线，位于将要插入的两张卡片之间（或列首/列尾）。插入线位置随指针即时变化，不对坐标做缓动；出现/消失使用共享的 120 ms 透明度过渡，并遵循 Reduce Motion。
- 同列拖拽：放到新位置即调整顺序。落点等于卡片原位置（插入线将紧邻自身）时不显示插入线，松手不写入。
- 跨列拖拽：目标列高亮（既有 accent 覆盖层），插入线指示落点；空列显示既有的虚线 “Drop to move here” 占位，落点为列尾。松手后卡片以一次写入同时改变状态与位置。
- 插入位置按“指针 y 与每张可见卡片中线比较”决定：指针在某卡中线之上则插到该卡之前；在所有卡中线之下则插到列尾。被拖拽的卡片本身不参与比较。列标题、列间隙、工具栏、侧栏、看板外均不是落点。
- 列的纵向滚动偏移参与命中测试（拖拽中用滚轮滚动列仍得到正确位置）。横向边缘自动滚动、拖拽中禁用横向手势滚动等现有行为不变。
- 浮动预览的副标题：跨列为 “Move to <Status>”；同列有效落点为 “Reorder in <Status>”；其余为 “Drag to reorder or move”。
- 成功：跨列显示既有原生 toast “Moved to <Status>”；同列重排不弹 toast（卡片位置变化即反馈）。失败：显示既有错误条，刷新看板，不做乐观更新、不自动以新 revision 重试。
- 取消（responder 被终止、指针取消、切换项目/筛选/布局、卡片消失）、拖出看板、或 pending 写入期间：不写入。
- 手机/触摸/紧凑布局不安装拖拽 responder，排序仍使用操作菜单的 Move up / Move down（`tasks.move`，行为不变）。

## 2. 数据契约：`tasks.place`

新 RPC `tasks.place`，输入（strict）：

```ts
{ id: string; revision: int > 0; status: Status;
  beforeId: string | null;   // 插到该卡之前
  afterId: string | null }   // 插到该卡之后；两者至多一个非空，皆空表示列尾
```

客户端按可见卡片选锚点：落点后面有可见卡 → `beforeId` = 紧随落点的那张；落点为可见列尾且列非空 → `afterId` = 最后一张可见卡；空列 → 均为 null。锚点基于可见卡，因此被筛选隐藏的卡片保持相对顺序。

服务端（`BoardStore.placeTask`，在 store 的串行事务中执行，原子替换写 board.json）：

1. 卡片不存在 → `Task not found.`；revision 不匹配 → `Revision conflict: this card changed. Reload before moving.`（CAS，不写入）。
2. 卡片或其项目已归档 → 拒绝，不写入。
3. 锚点等于自身、锚点不存在、属于其他项目或不在目标状态列 → `Drop position changed. Reload and try again.`，不写入。
4. 目标列 = 同项目、目标状态的其他卡片（包括已归档卡，保证筛选显示归档卡时锚点有效），按 `position`、`createdAt` 排序。
5. 同列且计算出的插入下标等于当前下标 → 无变化，不写文件、不增加 revision，返回原卡。
6. 新 `position` 取前后邻居的中点；列首为首卡 −1，列尾为末卡 +1，空列为 0。若邻居 position 相等导致无法严格夹在中间，先把目标列其他卡的 position 规范化为 0..n−1（只改 position，不改 revision/updatedAt/其他字段），再取中点。
7. 只修改被移动卡片的 `status`、`position`，`revision` +1，`updatedAt` 更新；标题、描述、优先级、workspace、归档、范围等字段不变；其他卡片的 revision 不变（不会让其他卡的编辑草稿或 agent 快照失效）。
8. 状态发生变化时记录 `status_changed` 事件（actor human，from/to），与侧栏改状态一致；同列重排不记录事件。
9. 同列或跨列都只有一次事务、一次原子写；board revision 只 +1。

`tasks.create` 的新卡 position 改为目标列最大 position + 1（列为空时为 0），使分数/负数 position 存在时新卡仍排在列尾。`tasks.move`（菜单上移/下移）保持原行为。

## 3. 客户端结构

- `client/geometry.ts` 新增纯函数：
  - `dropSlot(contentY, cards, draggedId)`：按中线返回插入下标（不含被拖卡）、`beforeId`/`afterId` 锚点和插入线的内容坐标 y。
  - `placementUpdate(task, target, slot, column)`：返回 `tasks.place` 输入，或在拖出看板、同列原位、同列尚未测得列表位置时返回 null（跨列未测得时落到列尾）。
- `client/columns.tsx`：记录每张卡在列内容中的布局（`onLayout`）、每列纵向滚动偏移与列表顶部窗口坐标（拖拽开始时 `measureInWindow`），在拖拽中计算 slot 并绘制绝对定位的插入线（不插入布局元素，避免卡片位移导致抖动）。
- `client/board.tsx`：`onDrop` 改为调用 `tasks.place`，沿用 `doAction` 互斥、错误条与刷新。
- 不使用 DOM/HTML 拖拽事件或全局监听；仅 React Native 原语与宿主主题色。

## 4. 验收

| 项 | 预期 |
|---|---|
| 命中测试 | 中线上下、列首、列尾、空列、被拖卡自身被排除、滚动偏移，均有纯函数测试 |
| 同列无变化 | 原位松手不调用 RPC；服务端同位置请求不写文件、revision 不变 |
| 同列重排 | 一次写入，只改该卡 position/revision/updatedAt，其他卡 revision 不变 |
| 跨列定点 | 一次写入同时改 status 与 position，记录 status_changed |
| CAS | 旧 revision 被拒绝且文件不变；并发两次同 revision 请求只有一次成功 |
| 锚点失效 | 锚点不在目标列/不存在/为自身被拒绝且不写 |
| position 冲突 | 邻居 position 相等时规范化后插入顺序正确 |
| 取消/拖出/失败 | 不写入；失败显示错误且无乐观更新 |
| 回归 | 横向边缘滚动、点击打开、触摸布局菜单排序不变 |

实际桌面 UI（插入线外观、拖拽手感）需在宿主中人工或 Luna 验收；本卡按用户要求不 install/reload 插件，记为 UNRUN。

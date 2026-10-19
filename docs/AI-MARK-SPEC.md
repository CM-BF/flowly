# AI 标记（AI-MARK-SPEC）— 2026-10-19

卡片请求“所有AI feature增加星星标记”：已有的 AI 功能（进度摘要、每日摘要、Ideas、agent 添加的产物与标签等）和下一步建议一样，用星星图标标明“这是 AI 写的或建议的”。

## 1. 标记

- 共享组件 `AiMark`（`client/ui.tsx`）：`Sparkles` 图标，主题 `accent` 色，默认 13 px，与下一步建议行首的图标相同。
- 带 `label` 时作为一个无障碍图像，名称 “AI generated”；行内或已在按钮无障碍名称中写明来源时为装饰性（不单独朗读）。
- `SectionHeader` 新增 `ai` 属性：标题后显示带标签的标记。
- `Sparkles` 只用于 AI 内容。原来用 `Sparkles` 的卡片类型 `feature` 改为 `Puzzle`（TASK-TYPE-SPEC），避免把功能卡误读为 AI 内容。设置里 “AI features” 分组的图标本来就是 `Sparkles`，保持。

## 2. 标记位置

| 位置 | AI 内容 | 标记 |
| --- | --- | --- |
| 会话输入框上方的下一步建议 | agent 建议的下一条消息 | 行首图标（已有，NEXT-MOVES-SPEC） |
| 卡片正文的进度行 | 摘要模型写的 state | 行首图标替换原来的 `Flag`（12 px） |
| 侧栏 “Progress” 分组 | 摘要的 state / target / recap / next | 分组标题 |
| 侧栏 “Ideas” 分组 | agent 提出的 idea | 分组标题 |
| Ideas 页面标题栏 | 全项目的 idea | “Ideas” 标题后 |
| Insights “Summary”（每日摘要） | 摘要模型写的当天总结 | 分组标题 |
| 产物行 | agent 添加的产物 | 来源图标由 `Bot` 改为标记；用户添加的仍为 `User` |
| 标签胶囊 | agent 打的标签 | 由 `Bot` 改为标记 |

不标记：Insights “Suggestions”（规则计算，不是模型生成）、卡片上的 idea 数（`Lightbulb` 计数，含义已明确）、agent 设的卡片类型（与用户设的类型无从区分，且只是固定值）。

## 3. 新用户引导

欢迎页第 3 页（What makes it different）标题下加一句 “Anything marked with the sparkle was written or suggested by AI.”。不加一次性提示：标记不需要操作，带标签的标记有无障碍名称。

## 4. 不变

无数据、RPC、工具或 skill 变化；无迁移。新增 2 个字符串，已加入全部 9 个语言包。

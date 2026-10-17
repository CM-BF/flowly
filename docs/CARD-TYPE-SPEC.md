# 卡片类型：agent 补全（CARD-TYPE-SPEC）

## 1. 目标

卡片的 type（feature / bugfix / research / refactor / docs / chore）是可选字段。没设 type 的卡片，由在其中工作的 agent 在理解任务后补上；已经有的 type（无论人设还是 agent 设）不被 agent 改动。

## 2. Agent 工具 `kanban_set_type`

- 输入：`expectedRevision`、`request`（照抄 get_task）、`type`（上述六种之一，其他值为 `INVALID_INPUT`）。
- 卡片没有 type：写入 type，task revision +1（让人打开的旧表单发生 revision 冲突，不会把 type 清回空），记录事件 `type_set`（actor=agent，note 为 type id），回执 action=`type`。
- 卡片已有相同 type：不改任何东西，回执 `eventId` 为空，revision 不变。
- 卡片已有不同 type：拒绝，`TYPE_ALREADY_SET`，不改任何东西。agent 不应换个 type 重试。
- 其余校验与其它写工具相同（签名、revision、过期、归档、Done/Cancelled 拒绝、精确重放返回原回执）。
- CLI：`set-type <type> --request-file <snapshot>`。HTTP API action `type`。

## 3. 界面

活动列表把 `type_set` 显示为「设置了任务类型」，note 显示本地化的类型名。人仍可在表单和抽屉里随时改 type。

## 4. 新手引导

不新增 tour 文案或提示：这是 agent 侧的行为，人看到的只是卡片出现了类型。

## 5. 验收

- `server/agent-service.test.ts`：缺失时设置并 +revision、重放、已设不同值拒绝、相同值无变化、人设的值不被替换、非法值拒绝。
- `server/tool-server.test.ts`：MCP 工具列表包含 `kanban_set_type`。
- Skill 文本（`server/skill-source.ts` 与 `skills/paseo-ultra-kanban/SKILL.md` 一致）说明何时调用。

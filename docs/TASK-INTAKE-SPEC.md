# 单一任务输入与执行默认值

用户决定：2026-10-22，建卡默认启动 agent，任务信息只输入一次，由 agent 整理标题、描述、标签和类型。项目设置必须支持 Fast 与权限。此决定优先于上游的表单及元数据限制。

## 使用流程

- 新建卡只有一个必填“任务”输入。保留完整原文为 `task.brief`，初始 description 与原文一致，title 用首个非空行的简短预览；该预览不是 AI 生成结果。
- 每次新建默认启动 agent，不继承旧的 `startAgentOnCreate=false`。工作区、状态与本次暂不运行放在展开的更多选项里；编辑已有卡仍使用标题/描述等字段。
- agent 首轮读取任务，调用 `flowly_update_metadata` 整理自己的标题、描述、优先级，再用现有类型/标签工具补齐分类。描述忠实保留用户要求、路径、技术名和验收项，不编造任务范围。原文不可通过元数据工具修改，后续 session 的上下文仍可读取它。
- 参考 Multica 的默认 Agent mode、单 prompt、agent 整理 title/description、Todo 自动执行。Flowly 复用同一执行 session 完成整理与工作，不额外创建整理 session。
- 项目自动化开启时，默认创建走自动化队列，受并发/依赖约束，父卡能等待并被唤醒。关闭时直接启动现有 managed session 路径。两种路径都使用同一份任务信息，不再要求单独 Instruction。
- 排队的首次模型/权限/Fast 和图片以私有启动文件持久保存，job 只保存引用，不把图片传进 board 轮询。失败时保留卡片和原文；稳定的创建/首条消息标识防止重试产生第二个 session。

## 模型、速度和权限

- 项目默认模型、自动化执行者与评审者可选择权限和 Fast，能力由 Paseo `providers.listModes/listFeatures` 返回。配置保存 `modeId`（空串代表显式 provider 默认）和 `featureValues`，通过 SDK `config` 传入。
- 支持继承、明确 Standard/off、Fast/on。Claude 使用 `fast_mode`，Codex 使用返回的 `service_tier` 选项。切 provider 清空旧 provider 的配置；更换模型时不发送该模型不支持的特性。
- 自动化角色明确设置优先于同 provider 的项目默认，再回退到旧 `fullAccess` 行为。显式 provider 默认不被旧 fullAccess 覆盖。
- 这些是新 session 的启动默认，不静默重配已经运行的 session。全局及摘要模型选择器不展示尚不能保存的执行设置。

## 数据与授权

- `brief` 可选，旧卡无需迁移。`flowly_update_metadata` 只改工具身份绑定的卡，使用既有签名 request、版本检查、receipt 与活动。重复请求不会重复修改；人工编辑导致旧版本被拒绝；结束/归档卡不能改。
- 新 brief 卡的初始化缺项包含 metadata：get_task、写入提醒和 In review 的现有 SETUP_INCOMPLETE 检查都会要求整理。agent 同时提交 title 与 description 后标记 intakeOrganized（允许原值确认）；仅改 priority 不算完成。人手动编辑标题或描述也会确认，后续 agent 保留人的选择。旧卡没有 brief 不受影响。
- agent 不得借整理描述覆盖原文要求；人工标签归属、直接子卡管理、顶层 Done 权限继续由各自接口约束。
- UI、agent skill、README、引导与九语言目录同步更新。

## 验收

- 单输入保留原文并派生有效临时标题，旧关闭偏好不再影响新卡默认。
- 项目及角色的 modeId/Fast 包含显式 off/default，直接启动和自动化创建均传递；旧配置保持可读。
- metadata 更新、重放、请求复用、版本冲突、结束状态均用行为测试覆盖。
- 本机 daemon + app.paseo.sh：桌面与窄布局单输入创建；真实 agent 整理卡片；刷新持久化；自动化路径与图片输入；测试资源按 ID 清理。安装前检查非 fixture 活跃任务，避免打断用户的工作。

参考：[Multica quick-create](https://github.com/multica-ai/multica/blob/ff674c4e1df2d63185a45d724a6a5cc0cdb4da05/server/internal/daemon/prompt.go#L284)。

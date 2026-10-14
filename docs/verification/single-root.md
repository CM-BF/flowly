# Single-root 独立验收

日期：2026-10-13。范围：对已安装的 `paseo-ultra-kanban` 在真实 Paseo daemon 上做非 UI 验收；未修改实现、spec、依赖或项目约束文件。

## 结论

| 范围 | 状态 | 结果 |
| --- | --- | --- |
| Single-root 项目、卡片、workspace 与 scope | **PASS** | run-03、run-04 各 13 项资源检查均通过；额外的 project root/native binding 不可变检查通过。 |
| Legacy 多 repo 数据与 reload | **PASS** | 旧项目、卡片、上下文、workspace 关联及 native owner 保持不变；插件 reload 前后 `board.json` 字节哈希一致。 |
| 真实 Luna MCP 工具调用 | **PASS** | full-access `codex/gpt-6-luna` fixture actor 调用 `kanban_get_task`，返回 scope 只包含 common parent root；ID 与卡片/workspace 匹配。 |
| 只读及文件影响 | **PASS** | 卡片字段/status/revision 未变，没有 Agent 状态或进度写入事件；fixture repo 工作区干净。Board revision 增加是 Paseo turn lifecycle 观察事件。 |
| Paseo UI | **UNRUN** | CUA 未提供可明确绑定的窗口 ID 与几何；未操作任何 Paseo 窗口。 |

## 会话、插件与隔离资源

- 独立验收 session：`2113042d-0934-454d-bf58-af71751f926c`。`paseo inspect` 显示 `codex / gpt-6-luna`、`full-access`。
- 真实工具 fixture actor：`193101d5-5f16-4fe1-a5db-b379b25b3e2e`，由 `tools.prepare-session` 预分配 ID，再通过 Paseo SDK 在卡片 workspace 中创建；创建配置显式设为 `provider: codex/gpt-6-luna`、`modeId: full-access`。创建后 `paseo inspect` 再次确认 provider、model 和 full-access mode。Paseo 返回的 `PASEO_AGENT_ID` 与预分配 ID 相同。
- 插件：`paseo-ultra-kanban`，验收结束时 `enabled=true`、`status=running`。没有重启 daemon；仅通过 `paseo plugin reload paseo-ultra-kanban` 做 reload 验证。
- 隔离根：`/tmp/ultra-kanban-single-root-20261013/`。run-01 至 run-04 创建的 fixture 目录、native project、board project、卡片和 workspace 均保留；没有删除、归档、移动或重挂任何既有用户资源。run-04 验收后 board 共有 11 个 board project、22 张 task、53 个 Paseo workspace，包含此前测试及本次 fixture。
- 之前的 typecheck、43/43 tests（7 files）和 skill validator 结果记录在 [PROGRESS.md](../PROGRESS.md)；本次独立 live 验收未重复运行这些检查。

## 资源与 RPC 检查

| 检查 | 状态 | 证据与结果 |
| --- | --- | --- |
| 两个 child repo 位于共同父目录；注册并创建/关联 native project | **PASS** | [run-04 evidence](fixtures/single-root-run-04-evidence.json)。Board project 的 `primaryPath` 是父 root，`repos` 只有 `[root]`；输入旧 `repos` 字段由 schema 拒绝，且没有 mutation。 |
| 新 directory 卡片的 source、scope、workspace owner 与 Agent context | **PASS** | [run-04 evidence](fixtures/single-root-run-04-evidence.json)。返回 task 的 `projectId` 与本轮 board project 相同；`sourcePath`、`repoPaths`、workspace path 和 `tasks.context` 目录均为父 root。真实 Agent MCP 检查见下节。 |
| 子 repo 不能作为新卡片的独立 source/scope；root 外 workspace 不可选 | **PASS** | 输入 `sourcePath` / `repoPaths` 被 strict schema 拒绝且无 mutation；root 外 workspace 通过 `mode=existing` 关联时被拒绝且卡片/workspace 数量不变。 |
| 链接父目录内已有 workspace | **PASS** | [run-04 evidence](fixtures/single-root-run-04-evidence.json)。既有 workspace 位于父目录内、由另一个 native project 拥有；卡片仍使用父 root，workspace 原 native owner 未改变。 |
| Legacy 多 repo 项目/卡片、scope、上下文、workspace 与 owner | **PASS** | 选取既有两 repo 卡片（scope 数量 2）；project/card/context hash 及 workspace native owner 在 reload 前后相同。reload 前后 board v3 read view 一致，`board.json` SHA-256 为 `399dedba9972499e32f5d0ea01e718b420bf31b9fd29b01ea8b510027128bbfb`。 |
| worktree 限制在 native root 本身为 Git repository | **PASS** | 两个 child repo 各自是 Git repo、common parent 非 Git 时，worktree 创建在 workspace provision 前失败；native root 本身是 Git 的另一 fixture 成功创建 worktree，source/scope/owner/context 仍绑定该 native root。 |
| project root 和 native project binding 不可编辑重绑 | **PASS** | [immutable RPC evidence](fixtures/single-root-run-04-immutable-evidence.json)。project edit 对 `repos`、`primaryPath`、`paseoProjectId` 输入均拒绝；board read 与文件哈希不变。 |
| 错误、持久化与 reload 后读取 | **PASS** | 被拒绝的 RPC 均无卡片/workspace mutation；run-04 的 project/card 在 reload 后可读。reload 前后哈希相同，context、legacy records 和 owner 均保持一致。 |

## 真实 Agent tool 检查

run-04 directory workspace 中的 full-access Luna actor 通过插件提供的 MCP server 成功调用 `kanban_get_task`。`tools.access-state` 显示 `methods` 包含 `mcp`、`lastAction=get`。工具返回的 `identity.agentId/taskId/workspaceId` 与 `PASEO_AGENT_ID`、预分配 ID、run-04 task 和 workspace 一致；`scope.repoPaths` 与 `scope.directories` 都只包含 `/private/tmp/ultra-kanban-single-root-20261013/run-04/common-parent`。

Paseo SDK timeline 显示恰好一次已完成的 Kanban MCP `kanban_get_task` 调用；另有一次已完成的 provider `shell` 调用，用于读取并回报 `PASEO_AGENT_ID`。因此“只调用 Kanban 工具”成立（没有调用其他 Kanban MCP 工具），但不能表述为 Agent 全程只调用了一种工具。脱敏 timeline 摘要见 [tool trace evidence](fixtures/single-root-agent-tool-trace-evidence.json)；原始命令和输出未保存。只读谓词另核对卡片、状态、revision、无 Agent 状态/进度写事件和干净的 fixture repo。

初次写只读断言时使用“整个 board revision/hash 必须不变”条件，结果被记为 FAIL；这项断言过严。Board revision 从 94 到 96，card status/revision 保持 `todo/1`。task event 中新增的仅有 `system / agent.turn_started` 与 `system / agent.turn_ended` 两条 Paseo lifecycle observation，没有 Agent `status_changed` 或 `progress_reported` 写事件。最终谓词检查卡片字段 hash/status/revision、Agent 状态/进度事件和 fixture 文件状态，并允许 lifecycle event 改变 board revision；最终两项真实 Agent 检查为 PASS。

真实 actor 首次 turn 的脱敏结果保留在 [first-turn evidence](fixtures/single-root-agent-tool-evidence.json)；初次 board hash 断言过严产生的原始 FAIL 未覆盖。最终的 scope、身份、board 前后摘要与只读复核在 [final Agent evidence](fixtures/single-root-agent-tool-final-evidence.json)。随后的只读复核复用了相同 actor，先核对 ID，没有再创建 actor，也没有重复调用 MCP 工具。Board 在复核前后稳定，SHA-256 均为 `cb9ffe2a995341b1f4f65653391fc5374358f997bd19a7ee1ea4ce36db8cef2b`；两个 child repo 的工作区干净，父 root 没有 root-level 文件。

## 夹具假失败与证据保留

- **run-01：夹具路径断言失败。** macOS 下 `/tmp` 解析为 `/private/tmp`；脚本比较未 canonicalize 的字符串，把相同目录误判为不同路径。原始输出保留在 [run-01 evidence](fixtures/single-root-run-01-evidence.json)。
- **run-02：夹具 operationId 复用。** 创建卡片复用了 run-01 的 operationId，`BoardService` 正确按幂等语义返回 run-01 卡片，测试再把旧卡与 run-02 project/native owner 对比后报错。原始输出保留在 [run-02 retry evidence](fixtures/single-root-run-02-retry-evidence.json)。
- 后续脚本对 `commonRoot` / `gitRoot` 使用 `realpath`，每轮 operationId 带随机 run 标识，并核对返回卡片 `projectId`；run-03 与 run-04 的 13 项资源检查均 PASS。对应证据：[run-03](fixtures/single-root-run-03-evidence.json)、[run-04](fixtures/single-root-run-04-evidence.json)。
- 中间一次只读复核脚本因漏导入 `execFileSync` 失败，未创建 actor、未调用工具；原始脚本错误保留在 [audit attempt](fixtures/single-root-agent-tool-audit-attempt.json)。修正后复用原 actor 的最终只读复核 PASS，见上述 final Agent evidence。

验证脚本：[single-root-live.mjs](fixtures/single-root-live.mjs)、[single-root-immutable-rpc.mjs](fixtures/single-root-immutable-rpc.mjs)、[single-root-agent-tool.mjs](fixtures/single-root-agent-tool.mjs)。所有 evidence 均不含 bearer、签名请求或原始 MCP 授权头。

## UI 边界

CUA 能列出 Paseo app 并读取当前 app window 内容，但 macOS 界面没有提供可明确绑定的窗口 ID 与几何信息，无法区分/绑定用户的未全屏窗口。没有点击或输入任何 Paseo 窗口；UI 验收 **UNRUN**。历史截图不作为本次 single-root UI 证据。

# Corrected provider MCP retry timing

All timestamps UTC on 2026-10-13. The session was created with `codex/gpt-6-luna`, `modeId=full-access`, a preallocated agent ID, the original workspace, original stub port 41983, and the original Authorization value. Authorization values are omitted; the runner records only a SHA-256 comparison.

| Event | Timestamp | Relative timing |
| --- | --- | --- |
| `workspace.agents.create` call started | 06:43:47.388 | 0 ms |
| Daemon `CreatedAt` | 06:43:48.062 | +674 ms |
| MCP `initialize` (protocol `2025-06-18`) | 06:43:48.281 | +893 ms; 219 ms after daemon CreatedAt |
| `notifications/initialized` | 06:43:48.303 | +915 ms |
| MCP `tools/list` | 06:43:48.308 | +920 ms |
| `workspace.agents.create` returned | 06:43:48.346 | +958 ms; 38 ms after tools/list |
| First MCP `tools/call` for `probe` | 06:44:12.101 | +24.713 s; 23.755 s after create returned |
| Probe verified the exact agent ID | 06:44:12.112 | +24.724 s; 11 ms after the call request |

Provider request order was `initialize → notifications/initialized → tools/list → tools/call(probe)`. The Luna timeline also shows `printenv PASEO_AGENT_ID` before `phase-02-smoke.probe`, and its final response reports the same preallocated ID plus `probe-ok`. The control client separately verified `initialize → notifications/initialized → tools/list → tools/call(probe)` against the corrected Node adapter before the provider session started.

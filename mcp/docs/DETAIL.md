# cfind MCP 连接

把 [conversation_finder](../../README.md) 暴露成 MCP 工具，让 agent 用原生工具检索**自己的会话历史**。

## 为什么值得接

DSH 的 `/compact` 只是让模型**看不见**旧消息，原文仍留在 `session.v4.jsonl.zstd` 里。
接上之后，agent 能自己把压缩掉的内容找回来，而不是靠人复述。

## 提供的工具

| 工具 | 作用 |
|---|---|
| `mcp__cfind__search` | 检索，返回命中 + 片段（默认只搜**当前会话**） |
| `mcp__cfind__show` | 取某条事件的原文窗口 |
| `mcp__cfind__outline` | 会话摘要：标题 + 每回合一行 + 压缩检查点 |
| `mcp__cfind__audit` | 隐私/涉密扫描（输出强制脱敏） |
| `mcp__cfind__stats` / `mcp__cfind__index` | 索引统计 / 手动增量 |

## 安装

1. 把 `cordis.patch.yml` 里的 `__CFIND_MCP__` 换成 `bin/cfind-mcp.mjs` 的绝对路径。
2. 用 `plugin_manager` 安装本 bundle，或把 patch 内容合并进 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。
3. 重启 profile（manifest 不热更新）。
4. 验证：让 agent 调用 `mcp__cfind__stats`。

## 协议说明

本服务端**只实现 legacy MCP 握手**（对 `server/discover` 回 `-32601`）。
DSH 的 MCP client 会先派一个临时兄弟进程探测 2026-07-28 现代协议，探测不认即回落 legacy——
这是官方支持的路径，已在真实 SDK 上验证（`getProtocolEra() === 'legacy'`）。

## 数据位置

索引在 `$CFIND_HOME` → `$XDG_DATA_HOME/cfind` → `~/.local/share/cfind/index.db`，
**不放在** `~/.dsh` 下：它以后要同时索引多个 agent 的会话。

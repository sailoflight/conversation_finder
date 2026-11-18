# 多来源适配器契约

> 目标：同一套检索层服务多个 agent。接一个新 agent **只写一个适配器**，不碰检索层。

**状态：四个源全部已实现并通过测试**（DSH / Claude Code / Codex / OpenCode）。

```bash
cfind 挂载 --all                     # 一次搜四家
cfind 项目 --all --source claude     # 收窄到某个来源
```

实测（本机导出的真实会话样本）：

| source | 会话 | 文档 | 说明 |
|---|---|---|---|
| `dsh` | 55 | 3957 | zstd 多帧，压缩由 `surfaceOp` 表达 |
| `claude` | 2 | 106 | 明文 JSONL，压缩由 `compact_boundary` 表达 |
| `codex` | 3 | 6 | rollout JSONL + `.jsonl.zst` 归档态 |
| `opencode` | 1 | 251 | SQLite（2.x `session_message`）；也支持聚合 jsonl |

> 数字差异大是**样本差异**，不是解析问题：Codex 的三条样本几乎全是 developer 注入指令
> （按设计不入索引），助手最终答复 `last_agent_message` 为 null，所以只有 6 条文档。

## 1. 为什么这么切

| 层 | 文件 | 行数 | 换 agent 要不要改 |
|---|---|---|---|
| 检索层 | `schema` `cjk` `store` `query` `outline` `audit` `format` | 1316 | ❌ 一行不改 |
| 适配层 | `decode` `extract` `paths` | 362 | ✅ 全换 |

约 **78% 与来源无关**。所以扩到 N 个 agent 的成本是 N 个适配器，不是 N 个产品。

## 2. 归一化模型（适配器的唯一输出形状）

不管源是什么格式，最终都产出下面这个形状，由检索层消费：

```js
/** 一个可索引文档。 */
{
  seq: number,        // 源内的位置标识（同一会话内唯一、单调）
  kind: string,       // user | assistant | reasoning | tool-call | tool-result | compaction | title | other
  body: string,       // 可检索正文（纯文本；不要塞原始 JSON）
  time: number,       // epoch ms（缺就 0）
  surface: 'current' | 'shadowed'   // 模型现在还看不看得见
}

/** 会话元数据。 */
{
  id: string,
  source: string,     // 'dsh' | 'claude-code' | 'codex' | 'opencode'
  cwd: string|null,
  title: string|null,
  created_at: number,
  agent_preset: string|null,
  parent_id: string|null,
  event_count: number,
  first_time: number,
  last_time: number
}
```

**最小公共集原则**：只依赖「会话 id + 时间 + 文本 + cwd + 角色」。不要为了还原某家语义
去绑定它的内部字段——Claude Code 官方已书面声明其 transcript 格式随时可能变。

## 3. 适配器接口

```js
export default {
  id: 'dsh',
  /** 该源是否存在于本机（决定要不要出现在默认扫描里）。 */
  detect(): boolean,
  /** 列出候选会话文件/记录。 */
  discover(): Array<{ ref: string, size: number, mtime: number, sessionHint?: string }>,
  /** 读取：返回归一化后的事件流。 */
  read(ref): { header: { id, cwd, title, createdAt, agentPreset, parentId }, events: NormalizedEvent[] },
  /** 增量：从已索引位置继续读（可选；不支持就返回 null 表示整文件重读）。 */
  readFrom(ref, offset): { events: NormalizedEvent[], consumed: number } | null,
  /** 事件 → 可检索文档（各源的文本提取规则不同，必须各自实现）。 */
  toDocs(event): Array<{ kind: string, body: string }>,
  /** 遮蔽判定：哪些事件已被压缩掉（各源表达方式不同）。 */
  surfaceOf(events): Map<number, 'current' | 'shadowed'>
};
```

`read()` 与 `toDocs()` 的职责边界：`read` 只做**格式**归一（把各家的 JSON 形状拉平），
`toDocs` 做**语义**提取（哪种 block 值得索引）。两者分开，是因为同一家里"格式"比"语义"更稳定。

## 4. 各源已知差异（实现时按此对照）

| 维度 | DSH（已实现） | Claude Code | Codex | OpenCode |
|---|---|---|---|---|
| 存储 | 每会话 `session.v4.jsonl.zstd` | 每会话 `.jsonl`，**不压缩** | `.jsonl`，**7 天后转 `.jsonl.zst`** | **单一 SQLite DB** |
| 位置 | `$DSH_HOME/sessions/<enc-cwd>/<dir>/` | `~/.claude/projects/<enc-cwd>/<sid>.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `~/.local/share/opencode/opencode.db` |
| 内容模型 | 类型化事件 + `seq` | 行 = DAG 节点（`uuid`/`parentUuid`） | 扁平事件 + `call_id` 配对 | 消息表 + `data` JSON |
| 压缩表达 | `surfaceOp:{op:'replace',startSeq,endSeq}` | `system` + `subtype:"compact_boundary"`，`parentUuid:null` | `compacted` 事件 | `compaction` 消息类型 |
| 分支 | `parentSession` / `delegationDepth` | `isSidechain` + `agentId` + `/branch` | `codex fork`（独立 thread） | `parent_id`（仅 subagent） |
| 明文可读性 | 需 zstd | 直接读 | 需 zstd（归档态） | 需 SQL |

难度：**Claude Code < Codex < OpenCode**。

## 5. 「默认搜自己」怎么按源分派

调用方是"此刻正在被追加日志的那个会话"。各源能给到的线索不同：

| 源 | 精确手段 | 退化手段 |
|---|---|---|
| DSH（CLI） | `$DSH_SESSION_ID`（官方 shell-env 注入） | — |
| DSH（MCP） | ❌ 拿不到：client 会 scrub 所有 `DSH_*`，且调用链无会话上下文 | **mtime 最新会话** |
| Claude Code | hook 的 `transcript_path` 可传 | mtime |
| Codex | ❌ 无环境变量 | mtime |
| OpenCode | ❌ | mtime（DB 是单文件，需按 `time_updated` 列） |

mtime 启发式对四家通用：空闲会话不会写日志，所以最新者几乎必然就是调用方。
**这条比任何单家专用变量都更有移植价值**，建议作为统一兜底。

## 6. 落地顺序（建议）

1. 把 `lib/store.mjs` 里 DSH 专属的那段（`SOURCE` 常量 + `listSessionFiles` 调用）抽成 `lib/sources/dsh.mjs`
2. `syncIndex` 改为遍历 `adapters.filter(a => a.detect())`
3. 接 **Claude Code**（最易：纯 JSONL、语义字段最全），用一个真实会话验证召回
4. 验证通过再接 Codex（注意 `.jsonl` 与 `.jsonl.zst` 两种形态并存）
5. OpenCode 最后（要兼容 1.x/2.x 两代表结构，且需拼 message + part）

## 7. 需要同步改的地方

- `lib/schema.mjs`：`sessions.source` / `docs.source` 已在 v2 就位，无需迁移
- `lib/query.mjs` / `audit.mjs`：作用域 SQL 加 `source` 过滤即可（可选）
- CLI：`--source dsh,claude-code` 之类的多选参数
- `describeScope`：展示时带上来源（如 `claude-code session abc12345`）

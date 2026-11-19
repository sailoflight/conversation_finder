# 同类项目比对（2026-11）

写下来是为了避免重复造轮子，也为了记住「哪些设计判断已经被别人验证过」。
比对对象按 GitHub star 与定位相关度挑选，全部为 2025 年末之后活跃的项目。

## 一句话结论

这个领域已经很挤，但**分成了两个阵营**：

- **重型**：TUI/Web UI、语义搜索、多机同步、30+ 来源适配器（cass、sessionwiki、agent-sessions）
- **轻量**：一个命令、管道友好、给 agent 调用（我们的位置）

我们的差异点不是功能更多，而是**接口更小**：2 个工具、9 个参数、324 token 的接口税。
上面这些项目没有一个按「agent 的接口预算」来设计过 —— 它们的 CLI 动辄 30+ 子命令。

## 主要对象

| 项目 | ★ | 语言 | 定位 |
|---|---|---|---|
| [cass](https://github.com/Dicklesworthstone/coding_agent_session_search) | 1215 | Rust | TUI + CLI，30+ 来源，可选本地语义搜索 |
| [agent-sessions](https://github.com/jazzyalex/agent-sessions) | 951 | Swift | macOS 原生 App |
| [claude-pulse](https://github.com/nikitadoudikov/claude-pulse) | 247 | JS | 仪表盘 + 全文搜索 |
| [session-indexer](https://github.com/valpere/session-indexer) | 42 | Go | 向量 + Ollama 语义检索 |
| [agent-hop](https://github.com/hetpatel-11/agent-hop) | 36 | Rust | 多 agent 运行时 + 会话搜索 |
| [sessionwiki](https://github.com/youdie006/sessionwiki) | 34 | Rust | 12 来源 + `trace` 代码溯源 + 归档 |
| [claude-session-index](https://github.com/lee-fuhr/claude-session-index) | 31 | Python | SQLite FTS5，单来源 |

## 已经验证过、我们同向的judgments

- **stdout 只放数据，诊断走 stderr**（cass 明确写进契约）—— 我们已实现，`hitNotes`/`showNotes` 走 stderr。
- **`--max-tokens` / 字段裁剪**控制输出体积（cass 有 `--fields minimal`）—— 我们用 `--max-chars` + 逐行预算。
- **退出码要有语义**（cass 有一张 0/1/2/3/5/7… 的表）—— 我们用 0/1/2/3，够用。
- **默认排除工具输出噪音**（sessionwiki 默认 `tool-output summary`）—— 我们用 `exclude: ['tool','reasoning']`，实测排掉 85% 命中。
- **CJK 要专门处理**（sessionwiki 用 `trigram`）—— 我们用 bigram 列，2 字词也能命中；trigram 做不到 2 字。

## 吸收了什么（本轮实做）

### 1. 原始会话被删除后不能失效 —— **最大的收获**

两台项目都把「工具会定期清理旧会话」当核心问题：
- sessionwiki 叫 **archive mode**：索引过后即便原文件被删，`search`/`trace`/`brief` 继续可用
- cass 也叫 archive

我们原来的行为是错的，实测两个缺陷：

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 单个会话文件被删 | `sync` 把它从索引里**删掉** | 标记 `archived=1`，内容保留 |
| 整个会话目录不存在 | 所有命令直接退出码 3 | 有索引就继续，只在 stderr 提醒 |
| 删掉后 `show` | 抛 `session file not found` | 从索引重建窗口，标注"蒸馏副本" |

改动：`files.archived` 列（schema v4）、`lib/context.mjs::windowFromIndex`、
`bin/cfind.mjs` 的目录检查、`cfind index --gc` 显式回收。

为什么不自动删：工具清理掉的旧会话，往往正是「想不起某件事」时最该找回的那部分。
归档让索引只增不减，所以必须提供显式 `--gc` —— 但绝不自动执行。

## 明确**没有**吸收的

| 能力 | 谁有 | 为什么不跟 |
|---|---|---|
| 语义/向量搜索 | cass、session-indexer | 需要嵌入模型（cass 默认模型 90MB）。与"装好即用、零依赖"冲突 |
| TUI / Web UI | cass、sessionwiki、agent-sessions | 目标用户是 agent 和管道，不是人肉浏览 |
| 30+ 来源适配器 | cass（30+）、sessionwiki（12） | 适配器要维护。我们 4 个（DSH/Claude/Codex/OpenCode）覆盖主流 |
| `trace <file>` 代码溯源 | sessionwiki | 需要解析各工具的编辑调用，是独立的大功能。**但值得关注**——见下 |
| 多机同步 / SSH | deja-vu、cass | 单机够用 |
| `resume` / `brief` | sessionwiki | 重新打开会话是本工具之外的事，交给原工具 |
| 标签 / 笔记 / 摘要缓存 | sessionwiki | 是"知识管理"，不是"检索" |
| 几十个退出码 | cass | agent 只会区分「有结果 / 没结果 / 用法错」，细分的实际收益低于文档成本 |

## 值得再看一眼的

**`trace <file>`（sessionwiki）**：从代码文件反查「哪个对话写的它」。
两者都强调这是 agent 时代的 `git blame`。它不是 search 的变体 —— 需要从工具调用里
抽出编辑过的文件路径，建一条 `session ↔ file` 关系。

对我们来说最接近的现有能力是「直接搜文件路径」：

```bash
cfind 'src/auth.ts' --all --exclude reasoning,tool-result
```

能凑合，但没有精确的文件级关系。如果以后要加，它应该是一个**新工具**
（`trace`）而不是 search 的第 10 个参数 —— 否则会破坏 grep 形状。

**索引时降噪 vs 查询时降噪**：sessionwiki 在索引时就把工具输出压成摘要，
省空间也省查询时间。我们保留全文、在查询时用 `exclude` 过滤。
查询时更灵活（同一份索引支持两种视角），代价是索引更大、全表扫更慢。
目前 6.8M 字符 / 91ms 还可以接受，不值得为此牺牲灵活性。

## 数字对照（本机实测）

| | 我们 | cass | sessionwiki |
|---|---|---|---|
| 接口 | 2 工具 / 9 参数 / 324 tok | 30+ 子命令 | 20+ 子命令 |
| 索引 | 零依赖（`node:sqlite`） | Rust 二进制 | Rust 二进制 |
| 检索延迟 | 6.6 ms（FTS）/ 91 ms（正则） | 声明 <60ms（引擎查询） | 未声明 |
| 正则 | 支持，带 ReDoS 超时保护 | 未提及 | 未提及 |
| 中文 | bigram，2 字词可命中 | 可选 multilingual 模型 | trigram 默认 |
| 归档 | 支持（`--gc` 回收） | 支持 | 支持 |

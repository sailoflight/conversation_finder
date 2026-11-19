# CONTRACT.md — 并行开发的唯一共享契约

> 本文件由 lead 维护。**任何子代理都不得修改本文件或 `lib/` 下的地基文件**。
> 遇到地基 bug：在最终报告里写清楚，不要自己改。

## 0. 运行环境与硬规则

- Node **22**，纯 ESM，**零第三方依赖**（只用 `node:` 内置模块）。
- 数据库用 `node:sqlite` 的 `DatabaseSync`（自带 FTS5），会打印一条 `ExperimentalWarning`，属正常。
- 测试用 `node --test`。每个代理只跑**自己的**测试文件，不要跑全量。
- **文件所有权**：只创建/修改"你的交付物"里列出的文件。别的文件一行都别动。
- 代码风格：Kahn 式紧凑写法，注释用中文，关键判定要写清"为什么"。
- 语料根：`$DSH_HOME/sessions`（本机 `/home/d_demo1/.dsh/sessions`）。测试请用 fixture，别依赖真实语料漂移。

## 1. 地基模块（已由 lead 写好，直接 import，不要改）

```js
// lib/decode.mjs
scanFrameOffsets(raw: Buffer): number[]
decodeFramesFrom(raw: Buffer, fromByte = 0): { text: string, consumed: number, frames: number }
decodeFile(path: string): string
parseJsonl(text: string): object[]
readSessionFile(path: string): { header: object|null, events: object[], text: string }
```
- `consumed` 是**帧对齐**的字节位置，可直接当增量水位线；末帧不完整时停在上一个完整帧。
- 铁律：**永远不要**对整文件做一次 `zstdDecompressSync`（只解第一帧且不报错）。

```js
// lib/extract.mjs
KIND_WEIGHTS: Record<'user'|'compaction'|'title'|'assistant'|'tool-call'|'tool-result'|'reasoning'|'other', number>
docsOf(ev): Array<{ kind: string, body: string }>
classifySurface(events): Map<number, 'current'|'shadowed'>
sessionDocs(events): Array<{ seq, kind, body, time, surface }>
contentText(blocks): string
```

```js
// lib/cjk.mjs
bigrams(text: string): string                                  // '幂等性' -> '幂等 等性'
buildMatchQuery(text: string): { match: string } | { like: string }
```

```js
// lib/schema.mjs
SCHEMA_VERSION: number
DDL: string
KIND_WEIGHTS                                     // re-export
openDb(path: string, { readonly = false } = {}): DatabaseSync
```
- `openDb` **自愈**：先判定已有库（版本号 + 实际列），不符就整库重建并在 `meta.rebuilt_reason`
  记原因。索引是派生数据，可丢；所以永不需要用户手动删库。
- **改任何 DDL 都必须同时 bump `SCHEMA_VERSION`** —— 否则版本号对不上实际形状。

```js
// lib/paths.mjs
dataHome(): string                 // $CFIND_HOME > $XDG_DATA_HOME/cfind > ~/.local/share/cfind
indexPath(): string               // <dataHome>/index.db（**不放在任何 agent 家目录下**）
dshHome(): string                 // 被索引方：$DSH_HOME，默认 ~/.dsh
sessionsRoot(home?): string
listSessionFiles(root?): Array<{ path, projectDir, dirId, size, mtime }>
resolveScope({ session?, project?, all?, cwd?, env? }): Scope
describeScope(scope): string
shortId(id): string
```

## 2. 作用域 Scope（全项目统一形状）

```ts
type Scope =
  | { mode: 'session', id: string }
  | { mode: 'project', cwd: string }
  | { mode: 'all' }
```

### 输出契约（grep 形状）

默认文本输出为 `renderHits()` 的 **grep 形状**：`<session>:<seq>:<text>`，一行一条。

硬规则：
- stdout **只有结果行**，不含 scope 首行、不含「还有 N 条」提示、不含装饰；
  `| head` / `| wc -l` / `| cut -d: -f1` 必须能直接用。
- 工具自己的话术（命中总数、模糊放宽、去重折叠）由 `hitNotes()` 返回，
  CLI 写 **stderr**。这与 grep 把警告写 stderr 一致。
- 富格式（kind/surface/标题/截断后缀）只在 `verbose: true` 时出现。
- 输出必须以换行结尾（否则 `| wc -l` 少数一行）。

### show 的 L2/L3 一致性（硬规则）

**`show` 的正文必须包含检索命中的那段内容。**

`renderEvent()` 是「人读视角」：只给 `text` 块；`toDocs()` 是「索引视角」：还含 reasoning 等。
两者不一致时会出现最尴尬的 bug：search 说命中在 `#86`，`show #86` 里却完全找不到那个词。

因此：
- 传了 `find` 时，若渲染正文里没有它，必须退回 `toDocs()` 的正文（那正是被索引的字节）；
- 一条事件可能有几万字符，`find` 还要把窗口**居中到命中处**，而不是从第 0 字符开始截；
- 没传 `find` 且索引内容明显多于显示内容时，必须报告 `target.hidden` 并提示用 `find`。
  静默丢掉内容会让用户误判"命中是错的"。

### surface 语义（`--recall` 的全部依据）

| surface | 含义 | 对 agent 的价值 |
|---|---|---|
| `current` | 模型仍看得见（最近一次压缩之后） | 低 —— 它本来就在上下文里 |
| `shadowed` | 已被压缩掉，原文仍在磁盘 | **高 —— 这是唯一「想不起来」的部分** |
| `all` | 两者之和 | 默认，适合人用 |

`current + shadowed` 必须**恰好覆盖**全部文档（`tests/recall.test.mjs` 锁死这条）。
`--recall` ≡ `--surface shadowed`；MCP 里是独立的 `recall` 工具，因为它是本项目的
核心用途，值得一个自解释的名字。

## 3. 数据库 schema（**这是模块间唯一的耦合面**）

所有读模块直接对这个 schema 写 SQL，**不要** import `lib/store.mjs` 的函数。

```sql
meta(key TEXT PRIMARY KEY, value TEXT) STRICT;

sessions(id TEXT PK, source TEXT NOT NULL DEFAULT 'dsh', cwd TEXT, title TEXT,
         created_at INTEGER, agent_preset TEXT, parent_id TEXT, event_count INTEGER,
         first_time INTEGER, last_time INTEGER) STRICT;

files(path TEXT PK, session_id TEXT, size INTEGER, mtime INTEGER,
      frame_offset INTEGER, event_count INTEGER, indexed_at INTEGER) STRICT;

events(session_id TEXT, seq INTEGER, type TEXT, time INTEGER, surface TEXT,
       PRIMARY KEY (session_id, seq)) STRICT;

-- FTS5 虚拟表
docs(body, sh, source UNINDEXED, session_id UNINDEXED, seq UNINDEXED, kind UNINDEXED,
     time UNINDEXED, surface UNINDEXED, tokenize='unicode61');
```

- `sh` = `bigrams(body)`，指向 CJK；查询必须同时匹配 `body`/`sh`（FTS5 对整表 MATCH 即可）。
- `files.frame_offset` = 已索引到的**帧边界字节位置**，增量用。
- `meta.schema_version` 由 `openDb` 维护，代理不要自己写它。
- `source` 为多 agent 预留（当前恒为 `'dsh'`）。适配器契约见 `docs/sources.md`。

## 4. 各代理交付物与 API

### 4.1 `store` 代理 → `lib/store.mjs`

```js
syncIndex(db, { root, now = Date.now() }): {
  filesScanned: number, filesRebuilt: number, filesAppended: number, filesSkipped: number,
  sessions: number, events: number, docs: number, errors: string[], ms: number
}
stats(db): { sessions: number, events: number, docs: number, dbBytes: number }
```
规则：
- 初次见到的文件 → 全量解析建索引；`size`/`mtime` 未变 → 跳过（0 次解码）。
- `size` 变大 → 从 `frame_offset` 起只解新帧，`INSERT` 新事件与新文档，更新水位线。
- `size` 变小（重写/fork）→ 删掉该 session 的 `events`/`docs` 行后整文件重建。
- 磁盘上已消失的文件 → 清掉 `files` 行及其 `sessions`/`events`/`docs`。
- 会话 id 取 `header.id`（**session 事件字段在顶层**），取不到才退回目录名。
- `sessions` 行要填 `cwd/title/created_at/agent_preset/event_count/first_time/last_time`；
  title 取最后一条 `session/title`。
- 全部写入包在一个事务里（`BEGIN`/`COMMIT`），失败要 `ROLLBACK` 并记进 `errors`。
- 文档写入时 `sh = bigrams(body)`；`kind` 原样；`surface` 来自 `sessionDocs`。

测试 `tests/store.test.mjs` 必须覆盖：首建 → 空跑跳过 → 追加帧增量 → 截断重建 → 消失文件清理。

### 4.2 `query` 代理 → `lib/query.mjs` + `lib/outline.mjs`

```js
// lib/query.mjs
resolveSessionIds(db, scope): string[]

search(db, {
  query, scope, limit = 10, includeReasoning = true, surface = 'all',
  dedupe = true,        // 折叠同会话内近似重复命中
  fuzzy = true,         // 精确 0 命中时启用放宽级联
}): {
  total: number,        // **始终是原始命中数**，不因 dedupe 变小
  collapsed?: number,   // 被折叠掉的条数（0 条时字段不出现）
  fuzzy?: { what: 'prefix' | 'spelling' | 'cjk-loose' | 'loosened', applied: string },
                        // 结果是被放宽后才拿到的，必须如实上报

  // 说明：hits 里的 title 现在按 `sessions.source` 走对应适配器；show 亦然。
  hits: Array<{
    sessionId, short, title, cwd,
    seq, kind, surface, time, score,
    snippet            // ≤240 字符，命中处用 [ ] 包裹
  }>
}

show(db, { sessionId, seq, before = 3, after = 3, find? }): {
  sessionId, short, title, cwd,
  target: { seq, type, time, kind, hidden },  // hidden = 索引有、显示没给的字符数
  events: Array<{ seq, type, time, surface, role, text, isTarget }>
}
```
Scope 额外支持两个**可选收窄**字段（不改变 mode 语义，只在已框定的范围上做减法）：
- `sources?: string[]` —— 只保留这些来源（`docs.source IN`）。
- `exclude?: string[]` —— 排除这些会话（`docs.session_id NOT IN`）。
`search` / `outline` / `audit` **三者都必须实现**：audit 有自己的一套 scopeWhere，
早先漏掉这两个条件，导致 `audit --exclude-self` 静默失效。

规则：
- 查询串用 `buildMatchQuery`；返回 `{like}` 时走 `docs.body LIKE ?`（单字 CJK 兜底）。
- **模糊级联**（仅在精确匹配 `total === 0` 时启动，逐级放宽、命中即停）：
  1. `prefix`：`buildPrefixQuery` → `settle*` 之类，救「只记得词头」；
  2. `spelling`：用 `docs_vocab`（FTS5 词表虚拟视图，零额外存储）做编辑距离纠错，
     按 FTS5 的 token 粒度（`_` `.` `/` 是分隔符）逐个子词纠正；
  3. `cjk-loose`：`buildCjkLooseQuery`，把单条 CJK 词的 bigram 用 OR 连起来，
     救「尾字写错」（`预研旧` → `"预研" OR "研旧"`）。中文没有拼写概念，
     编辑距离纠错对 CJK 用不上 —— 缺了这一级，模糊搜索对中文等于无效。
     限制：只处理单个 CJK token、bigram 数 2–3（再长必须整体命中，否则等于放弃精确性）。
  4. `loosened`：`buildOrQuery` 把 AND 放宽成 OR，救「多词里有一个写错」。
  顺序不能颠倒：先纠错会让本可前缀命中的查询被拉偏。
  放宽失败就返回 0 命中，**绝不编造**。
- 词表缓存挂在 db 上的 WeakMap，用 `store.contentVersion()` 失效；
  并预建首字母分桶（全表扫 3.3 万词约 20 ms，桶内约 1 ms）。
- `renderHits/renderOutline` 支持 `terse: true`：省 scope 首行、压缩前缀、
  同会话标题不重复、surface 仅在 shadowed 时标注。实测每 token 换到更多命中。
- 排序：先按 `bm25(docs)` 取候选（多取 4×limit），再在 JS 里乘 `KIND_WEIGHTS[kind]` 重排；
  分数定义必须**越大越好**（把负的 bm25 取反后再乘权重）。`score` 需保留 3 位小数。
- `includeReasoning=false` → 过滤 `kind='reasoning'`；`surface` 可选 `'current'|'shadowed'|'all'`。
- `snippet` 用 FTS5 的 `snippet(docs, 0, '[', ']', '…', 24)`，再压空白到 240 字符内。
- `show` 的重建：只读该会话的原始文件（`listSessionFiles` 找到 path → `readSessionFile`），
  不要试图从 `docs` 表拼正文（未索引事件如 `request/header` 也要能显示，但默认跳过噪声类型）。
  `role`：`user` / `assistant` / `tool` / `system` / `event`。
  `text`：取 `contentText` 能拿到的正文；拿不到时给一行占位（如 `[tool/call bash] cmd…`）。

```js
// lib/outline.mjs
outline(db, { scope, promptLimit = 60, responseLimit = 120 }): {
  sessions: Array<{
    sessionId, short, title, cwd, createdAt, eventCount,
    turns: Array<{ turn, seq, prompt, response }>,
    checkpoints: Array<{ seq, time, shadowedTokenCount, range: {start, end}, preview }>
  }>
}
```
规则（对齐官方 `dsh-session-turn-outline`）：
- 回合以 `turn/start` 为锚；`prompt` 取该回合第一条 `user/message` 的 text，压空白后截断补 `…`；
  `response` 取该回合最后一条 `assistant/message` 的 text（无则空串）。
- `checkpoints` 来自 `compaction/summary`：`preview` 取 `contentText(summary)` 前 200 字。

测试 `tests/query.test.mjs` / `tests/outline.test.mjs` 必须覆盖：
中文 2 字/多字查询、单字 LIKE 兜底、`includeReasoning` 过滤、`surface` 过滤、
**被压缩（shadowed）的内容仍能搜到**、`show` 能取回 shadowed 原文、outline 回合与检查点。

### 4.3 `audit` 代理 → `lib/audit.mjs` + `lib/format.mjs`

```js
// lib/audit.mjs
DEFAULT_PATTERNS: Array<{ id: string, label: string, re: RegExp }>
redact(secret: string): string        // 前 4 + '…' + 后 2 + `(len=N)`；长度 <7 时全遮
audit(db, { patterns = DEFAULT_PATTERNS, scope, limit = 50, includeReasoning = true }): {
  scanned: { sessions: number, docs: number },
  findings: Array<{ patternId, label, sessionId, short, seq, kind, time, redacted, length }>
}
```
规则：
- 沿用 query 的作用域语义（自己写 SQL 过滤，不要 import query）。
- **绝不回显完整凭据**：`redacted` 必须经 `redact()`。
- 模式集至少覆盖：`sk-` 类 key、`AKIA`、`ghp_`、`AIza`、`xoxb-`、PEM 私钥块、`Bearer <token>`、
  `password|passwd|pwd|api_key|secret|token` 赋值、URL 内嵌凭据、以及 `~/.dsh/.credentials.yaml` 里的高熵串形态。
- 同一 `(sessionId, seq, kind, patternId)` 去重。

```js
// lib/format.mjs
renderHits(result, { json = false, maxChars = 1500 }): string
renderShow(result, { json = false, maxChars = 0 }): string
renderOutline(result, { json = false, maxChars = 3000 }): string
renderAudit(result, { json = false }): string
renderStats(stats, { json = false }): string
clip(text, max): string
```
规则：
- `json=true` → `JSON.stringify(result)`（单行、稳定字段、不加解释）。
- 人类可读：一行一命中，格式 `[kind/surface] <short> #<seq> <title> :: <snippet>`；
  作用域与总数放首行。
- `maxChars > 0` 时按行截断并追加 `… (+N more)`，保证输出不超预算。

测试 `tests/audit.test.mjs` / `tests/format.test.mjs` 必须覆盖：
`redact` 不泄露原文（含长度边界）、去重、`json` 输出可 `JSON.parse`、
`maxChars` 真的不超预算、`clip` 补省略号。

## 5. 测试语料

```bash
node tests/fixtures/make-fixture.mjs    # 生成 tests/fixtures/sessions（确定性、含压缩事务）
```
会话 A = `aaaaaaaa-…`（无压缩）；会话 B = `bbbbbbbb-…`（含一次压缩，**seq 3–5 为 shadowed**）。

自测命令（只跑自己的）：

```bash
node --test tests/store.test.mjs
node --test tests/query.test.mjs tests/outline.test.mjs
node --test tests/audit.test.mjs tests/format.test.mjs
```

## 6. 回报格式（保持精简，别贴大段代码）

```
DONE <模块名>
files: lib/x.mjs, tests/x.test.mjs
tests: <通过数>/<总数> passed
API 偏差: <无 | 具体说明>（有偏差必须写清，lead 会整合）
备注: <最多 3 条要点>
```

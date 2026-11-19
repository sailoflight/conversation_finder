# CONTRACT.md — 并行开发的唯一共享契约

> 本文件由 lead 维护。**任何子代理都不得修改本文件或 `lib/` 下的地基文件**。
> 遇到地基 bug：在最终报告里写清楚，不要自己改。

## 0. 运行环境与硬规则

- Node **22**，纯 ESM，**零第三方依赖**（只用 `node:` 内置模块）。
- 数据库用 `node:sqlite` 的 `DatabaseSync`（自带 FTS5），会打印一条 `ExperimentalWarning`，属正常。
- 测试用 `node --test`。每个代理只跑**自己的**测试文件，不要跑全量。
- **文件所有权**：只创建/修改"你的交付物"里列出的文件。别的文件一行都别动。
- 代码风格：Kahn 式紧凑写法，注释用中文，关键判定要写清"为什么"。
- 语料根：`$DSH_HOME/sessions`（默认 `~/.dsh/sessions`）。测试请用 fixture，别依赖真实语料漂移。

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

### MCP 接口预算（硬规则）

**工具 ≤ 2 个；新概念 ≤ 2 个；接口税 ≤ 500 tok。**

预算不是「参数总数」，而是「**新概念**数」。理由：

- 与 grep 同款的参数**不算限制** —— agent 早已内化 `-r/-C/-l/-m/-E`，
  它们不产生认知负担，只是把已知动作接到新数据源上；
- 真正要克制的是 grep 里没有的东西，agent 得先学会。

映射的唯一事实来源是 `lib/interface.mjs`：

| grep 同款（不计入） | grep | |
|---|---|---|
| `query` | `pattern` | |
| `all` | `-r` | |
| `context` | `-C` | |
| `list` | `-l` | |
| `limit` | `-m` | |
| `regex` | `-E` | |

| 新概念（计入，≤2） | 为什么 grep 没有 |
|---|---|
| `exclude` | grep 只能按**文件**过滤；会话语料还有「工具输出/思考/答复」这一层，实测占 85% 命中 |
| `deep` | grep 没有"再扫一遍低精度启发式"这回事 |

`tests/mcp.test.mjs` 会机械校验：
- 出现未归类的参数 → 失败（逼你在 `lib/interface.mjs` 表态）；
- 新概念超预算 → 失败；
- 映射里登记了却没有对应参数 → 失败（防映射过期）；
- 接口税超 500 tok → 失败。

token 是实打实的成本，与"熟不熟"无关，所以另有预算，不因"grep 同款"而豁免。

### 同义扩展（硬规则）

`grep` 没有任何同义词能力 —— 这点必须写清楚，因为我们是在**主动偏离** grep 语义。

三道护栏缺一不可，任何一条失效都会导致「返回无关命中」，比搜不到更糟：

1. **只在精确匹配为 0 时触发**（模糊级联内、fuzzy=false 时不触发）。
2. **扩展词不得比原词更常见**：`doc <= max(base, SMALL_CORPUS_FLOOR)`；
   原词语料频率为 0 时用绝对上限 `max(corpus*10%, SMALL_CORPUS_FLOOR)`。
   `SMALL_CORPUS_FLOOR = 5` 存在的理由：频率比是统计判据，文档数只有 1–3 时
   差一条就让比值翻倍，那是噪声。实测小语料上 `自我调用`(0) → `递归`(3)
   会被 `3 > 18×10%` 误拒，然后级联掉到 OR 放宽、返回无关概念。
3. **短语整体匹配**（`buildMatchQuery`），不是拆词 OR。

级联顺序 = 精度排序，**同义必须在 cjk-loose / OR 之前**：
`查表同义词 > bigram OR > 整句 OR`。实测 `响应慢` 若先走 bigram-OR
会返回 27 条只含「响应」的无关命中。

`SYNONYM_GROUPS` 的约束（由 `tests/synonyms.test.mjs` 强制）：
- 一个词只能出现在一组里（否则产生错误传递性：`校验≈验证` + `校验≈测试` ⇒ `测试≈验证`）；
- 不收跨语言对（超时↔timeout）：噪声特征不同，且实测全部 >3x 会被护栏拒绝。

### 归档策略（硬规则）

原始会话文件消失时 **归档，不删除**：

- `files.archived = 1`，`sessions` / `events` / `docs` 全部保留；
- 文件重新出现时 upsert 会把 `archived` 清回 0（**归档必须可逆**）；
- 会话目录整体不存在时，只要有索引就继续工作，只在 stderr 提醒（不许直接退出）；
- `show` 在原始文件缺失时退到 `lib/context.mjs::windowFromIndex`，
  返回 `archived: true`，并由 `showNotes()` 在 stderr 说明「蒸馏副本」。

理由：agent 工具会定期清理旧会话，而「找回想不起来的对话」最依赖那些记录。
删掉等于抹掉工具最该记住的部分。同类项目（sessionwiki 的 archive mode、
cass 的 archive）都独立得出同一结论。

代价是索引只增不减 → 必须提供 `cfind index --gc` 显式回收。
**绝不自动执行**：磁盘上删掉文件 ≠ 用户想忘掉这段对话。

### show 的 L2/L3 一致性（硬规则）

**`show` 的正文必须包含检索命中的那段内容。**

`renderEvent()` 是「人读视角」：只给 `text` 块；`toDocs()` 是「索引视角」：还含 reasoning 等。
两者不一致时会出现最尴尬的 bug：search 说命中在 `#86`，`show #86` 里却完全找不到那个词。

因此：
- 传了 `find` 时，若渲染正文里没有它，必须退回 `toDocs()` 的正文（那正是被索引的字节）；
- 一条事件可能有几万字符，`find` 还要把窗口**居中到命中处**，而不是从第 0 字符开始截；
- 没传 `find` 且索引内容明显多于显示内容时，必须报告 `target.hidden` 并提示用 `find`。
  静默丢掉内容会让用户误判"命中是错的"。

### surface 默认值：按作用域自适应（零重复原则）

`query.search()` 默认 `surface: 'all'`；**CLI 与 MCP 用 `paths.defaultSurface()`**：

| 作用域 | 默认 surface | 理由 |
|---|---|---|
| 自己的会话 | `shadowed`（压缩前） | 压缩后的内容仍在我的上下文里，检索它只是复制 |
| 别人的会话 / 全局 | `all` | 别人的压缩前历史从没进过我的上下文，排除只丢信息 |

**不需要参数**表达这件事 —— 参数越少越好，而这条规则是确定的。
CLI 仍保留 `--surface` / `--recall` / `--visible` 供精确控制；MCP 不暴露。

### 表达式检索（`regex: true` / `--regex`）

FTS5 没有正则能力，所以这条路必须**全表扫** `docs.body`（经 SQLite 自定义函数
`regexp()`）。实测 6.8M 字符约 91ms，是 FTS 的 14 倍 —— 这是全表扫的固有代价。

**不做默认**：grep 默认正则，是因为它没有索引；我们默认走 FTS，因为中文 bigram、
拼写纠错、模糊放宽都是正则给不了的。两种能力互斥，用 flag 分开。

**必须隔离执行**：grep 用 DFA（线性），JS `RegExp` 是回溯引擎。
`(a+)+$` 在 30 个 `a` 上要 19 秒，而语料里有 64,000 字符的事件 ——
在主线程直接跑等于让 agent 的工具调用永久挂住。

因此正则跑在 `lib/regex-worker.mjs`，主线程 `Atomics.wait` 限时（默认 5s），
超时 `terminate` 并抛 `userFacing` 错误。**中止后进程必须仍可用**，有测试钉住。

正则模式下没有 bm25，`score` 用 kind 权重（与 LIKE 路径同一套），按 `time` 倒序。

### 区域排除（grep 没有的能力）

`exclude` 接受**数组**（MCP：schema 里带 `enum`，合法值一眼可见）或**逗号串/重复 flag**
（CLI：`--exclude tool,reasoning` 与 `--exclude tool --exclude reasoning` 等价），
映射见 `REGION_KINDS`：
`tool`(tool-call+tool-result) / `reasoning` / `assistant` / `user` / `title` /
`system`(other) / `compaction`。

- 实测 `tool + reasoning` 占全部文档 77%、命中 85%，排除后可把 216 条命中降到 15。
- **未知区域必须报错**，不能静默忽略 —— 那会让人以为排除了却没排除，比报错危险。
- 系统提示词默认不索引（`system/message` 在 SKIP_TYPES 里），无需额外排除。

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
audit(db, { patterns = DEFAULT_PATTERNS, scope, limit = 50, includeReasoning = true, deep = false }): {
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
- **不分"严重度"**：这个分级名不副实 —— 一个 sha256 摘要和一把 AKIA 密钥的危险程度
  天差地别，但它们只是「同一条熵模式的两类结果」。真正的区别是**模式精度**：
  `LOW_PRECISION`（`high-entropy` / `high-entropy-hex`）默认不扫，`deep: true` 才加入。
  实测默认 96 条、`deep` 396 条（多 3.1 倍），多出来的主要是长度 64/32 的哈希。
  所以参数叫 `deep`（行为），不叫 `minSeverity`（名不副实的机制）。

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

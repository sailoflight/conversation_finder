# conversation_finder · `cfind`

> **会话历史的 grep。** 一个 pattern 进去，命中行出来 —— 包括已经被压缩掉、模型看不见的那部分。
> 零第三方依赖，CLI + MCP 双形态，面向 agent 与人共用。

```bash
cfind 幂等键                      # 默认搜"自己"，不用传会话 id
cfind 幂等键 --all                # 搜全部会话（≈ grep -r）
cfind 幂等键 --all | cut -d: -f1  # 哪些会话提到它（grep 式管道）
cfind show 178bf480 2417          # 取某条命中的上下文（≈ -A/-B）
```

输出就是 `session:seq:text`，一行一条，和 `file:line:content` 同构：

```
$ cfind settlement_id --all --limit 3
e8cef3de:2122:⏵ fts5vocab 可用（注意：`settlement_id` 被切成 …
9feefbdc:79:…assert.deepEqual(suggestTerms(['set'], 'settlement_id'…
e8cef3de:3065:…cfind settlement_id --all --limit 3 2>&1…
```

**stdout 只放结果**；命中总数、模糊放宽、去重折叠这些"工具自己的话术"走 stderr
（grep 把警告写 stderr，同理），所以 `| head`、`| wc -l`、`| cut -d: -f1` 都不会被打乱。

`show` 沿用 grep 的 context 惯例 —— 命中行用 `:`、上下文行用 `-`：

```
$ cfind show 1b4094ad 186 --before 1 --after 1
1b4094ad-185-bash {"command":"f=$(find ~/.dsh/sessions …
1b4094ad:186:bash {"command":"f=$(find ~/.dsh/sessions …
1b4094ad-187-[job/registered]
```

所以 `| grep ':'` 能只留命中行，`| cut -d: -f2` 能只拿行号。

### 大事件：`--find` 定位到具体位置

`seq` 只回答"哪个事件"，不回答"事件里的哪一处"。而一条事件可以有几万字符
（reasoning 块、抓取的文档、巨型工具输出）—— 实测 13% 的文档超过 2000 字符：

```
$ cfind show 5b1626bf 86
(#86 has 62836 more chars not shown (reasoning); add --find <term> to jump to the match)

$ cfind show 5b1626bf 86 --find descending
5b1626bf:86:…er seq8 '<compacted-summary>...幂等去重' yes … score descending. Also 'settlement_id' …
```

给 `--find`（通常就传你刚搜的那个词）后，窗口**以命中处为中心**，
并且会显示普通视角省略的部分（如 reasoning 块）—— 保证 search 说命中的东西，
`show` 一定看得到。

> 这条不变量有测试锁死（`tests/show-find.test.mjs`）：`renderEvent` 是"人读视角"
> （只给 text 块），`toDocs` 是"索引视角"（还含 reasoning）。两者一旦不一致，
> 就会出现"search 说命中在 #86，show #86 里找不到那个词"这种最难解释的 bug。

想要带 kind/surface/标题的富格式就 `--verbose`。

## 参数就是行为（grep 已经内化在 agent 里）

agent 早就"会" grep。所以参数不该是新的抽象，而该是它已有的动作：

| 参数 | grep | 行为 |
|---|---|---|
| `query` | pattern | 找什么 |
| `all` | `-r` | 全库找 |
| `context` | `-C N` | 看命中周围 |
| `list` | `-l` | 只问哪些会话 |
| `limit` | `-m N` | 最多几条 |
| `recall` | — | 想不起早先的东西时，搜那半边 |

6 个里 5 个是 grep 原样的 flag。只有 `recall` 是新概念，所以它的措辞是**行为**而不是机制
（早先叫 `surface: shadowed` —— 那是实现细节，agent 无从直觉）。

## 默认只搜"压缩之后"

`/compact` 之后，你的上下文里只剩「摘要 + 之后的新消息」。所以默认**排除上一次压缩之前**
的内容 —— 那些是归档日志，grep 的直觉也是这样：搜现存文件，要搜归档得显式说。

```
default      = current   压缩之后（你看得见的）
recall: true = shadowed  压缩之前（你看不见的）—— 那半边
```

实测两边**完全不重叠**，各占约一半：

| 查询 | 默认(current) | `recall` | 各占比 |
|---|---|---|---|
| 幂等键 | 11 行 | 11 行 | 50 / 50 |
| zstd | 11 | 13 | 54 / 46 |
| 压缩 | 14 | 16 | 53 / 47 |
| 预研究 | 9 | 12 | 57 / 43 |

CLI 还多一个 `--surface all` 取两边之和。

> **什么时候该用 `all`**：搜**别的会话**时。别人的压缩前历史不在你的上下文里，
> 排除它只是丢信息，省不到任何 token。默认的"排除压缩前"是针对自己会话的优化。


MCP 只暴露 **2 个工具、8 个参数**（实测接口税 **264 token**）：

| 工具 | 参数 |
|---|---|
| `search` | `query` `all` `context` `surface` `limit` `list` |
| `audit` | `all` `minSeverity` |

工具数靠**换成 flag** 压下来，不是砍功能：

| 原本是个工具 | 现在 | grep 对应 |
|---|---|---|
| `show`（取原文窗口） | `context: N` | `grep -C` |
| `outline`（会话目录） | `list: true` | `grep -l` |
| `index`（建索引） | 每次调用前自动同步 | — |
| `stats` | 不需要（对检索没帮助） | — |

`find` 这个参数也**消失了**：它原本只是替 `show` 补上「查询词」，
折进 `search` 之后查询词本来就在手上，窗口自动居中 —— 参数凭空消失。

两种形态，同一套内核：

| 形态 | 入口 | 适用 |
|---|---|---|
| **CLI** | `cfind` / `./cfind` | 人在终端、脚本、沙箱里（`--no-index` 内存模式） |
| **MCP** | `bin/cfind-mcp.mjs` + `mcp/` bundle | agent 用**原生工具**（`mcp__cfind__search`），常驻进程、无 Node 启动开销 |

## 刻意不像 grep 的三处

对着 grep 抄的时候，这三处我故意没抄 —— 因为抄了会更难用：

| grep 的行为 | cfind | 为什么 |
|---|---|---|
| **大小写敏感** | 不敏感 | 你记不住 `settlement_id` 还是 `SettlementId`；记错了 grep 直接 0 命中 |
| **按文件顺序输出** | 按相关度（bm25 × 来源权重） | 你要的是"哪条最可能是答案"，不是"哪条先出现" |
| **只搜磁盘上现存的文本** | 包括**已被压缩掉**的历史 | 这正是它存在的理由；grep 没有这个概念 |

其余都照抄：一个 pattern、一行一条、`session:seq:text`、管道友好、`0/1` 退出码、
`:`/`-` 区分命中与上下文、警告走 stderr。

## 为什么需要它

agent 的 `/compact`（或自动压缩）只让模型**看不见**旧消息，**原文仍留在磁盘上**。
实测本机一个 2498 事件的 DSH 会话：

| | 事件数 | 占比 |
|---|---|---|
| `current`（模型仍可见） | 959 | 38% |
| `shadowed`（已压缩，模型不可见） | **1539** | **62%** |

```bash
$ cfind 自举 --all --recall
178bf480:8:来检查这一整套DSH的更新…一别读凭证 二别着急操作
```

压缩之后再问"我们最初要干什么"，模型答不出来，`cfind` 一秒取回。

## 为什么不用现成的

| 现成方案 | 为什么不够 |
|---|---|
| `rg` / `grep` | 会话是 **zstd 多帧压缩**的 JSONL，`rg` 没法直接搜；且 `zstdDecompressSync(整文件)` 会**静默只解第一帧** |
| 官方 `dsh-session-query-sqlite` | 分词器硬编码 `unicode61`，连续中文被当成一个 token —— 实测搜「幂等性」**命中 0** |
| `trigram` 分词 | 2 字查询「幂等」**命中 0**，而中文 2 字词极多 |

核心算法只有一处：**CJK bigram**（写入侧切 `幂等 等性`，查询侧转短语）。其余全部复用成熟实现
（SQLite FTS5 的 BM25 与 snippet、Node 内置 zstd）。**零第三方依赖。**

## 安装

要求 Node ≥ 22.19（自带 `node:sqlite` 的 FTS5 与 `zlib` 的 zstd）。

```bash
git clone <this> && cd conversation_finder
./cfind 幂等            # 直接用
npm link                # 或装到 PATH，之后直接 `cfind`
```

索引落在**中立数据目录**（`$CFIND_HOME` → `$XDG_DATA_HOME/cfind` → `~/.local/share/cfind/index.db`），
不放在任何一家 agent 的家目录下 —— 因为它以后要同时索引多个 agent 的会话。

### 接成 MCP（给 agent 用）

见 [`mcp/`](mcp/)：一个配置型 bundle，把服务端接到 `@deepseek-ai/dsh-mcp-client` 上。

```bash
sed -i "s#__CFIND_MCP__#$PWD/bin/cfind-mcp.mjs#" mcp/cordis.patch.yml
```

然后装进 profile，重启后即得 `mcp__cfind__search` / `show` / `outline` / `audit` / `stats` / `index`。

> 协议说明：服务端**只讲 legacy MCP 握手**（对 `server/discover` 回 `-32601`）。
> DSH 的 client 会先派临时兄弟进程探测现代协议，探测不认即回落 legacy——官方支持路径，
> 已在真实 SDK 上断言 `getProtocolEra() === 'legacy'`。

## 沙箱里也能用

agent 常跑在 workspace-write 沙箱里，写不到数据目录。此时自动降级为内存索引：

```bash
cfind 幂等 --no-index      # 现建现查，零磁盘写，实测 ~0.9s / 5MB 语料
```

MCP 服务端同样自动降级（打不开磁盘库就用 `:memory:`）。

## 模糊搜索：拼错/只记词头也能搜到

精确匹配 0 命中时，自动依次放宽，**命中即停**：

| 级别 | 解决什么 | 例子 |
|---|---|---|
| `prefix` | 只记得词头 | `settle` → 命中 `settlement` |
| `spelling` | 拼错字母 / 相邻换位 | `reconclie` → `reconcile` |
| `cjk-loose` | 中文尾字写错 | `预研旧` → 靠 `预研` 命中 |
| `loosened` | 多词里有一个写错 | `reconcile qqqq` → 按 `reconcile` 命中 |

放宽只发生在**精确匹配失败之后**，所以不会污染本来就有答案的查询。结果被放宽过时
输出会明确标注：

```
$ cfind reconclie --all --terse
e8cef3de#2122 assistant … :: …[reconcile] the ledger…
(spelling→reconclie→reconcile)
```

实测（`bench/fuzzy-eval.mjs`，228 个精确 0 命中的查询）：

| 指标 | 结果 |
|---|---|
| 漏一个字母 / 多一个字母 / 相邻换位 / 只记词头 | 均 **100%** 从 0 救回 |
| 中文尾字写错 | **100%**（40/40） |
| 误报（随机串本不该命中） | **0**（0/20） |
| 纠错精确率（与正确词命中文档的重合度） | **93%** |

成本：纠错热路径 **0.7–3.6 ms**；首次调用建词表缓存约 140 ms（常驻进程只付一次）。
`--no-fuzzy` 可关闭。

## 召回：`--recall` —— 找回你已经被压缩掉的记忆

这是整个工具存在的理由，也是平时最该用的一个开关。

压缩之后，你的上下文里只剩「摘要 + 之后的新消息」。那些东西**你本来就看得见**，
再搜一遍是浪费。真正想不起来的，恰恰是被压缩掉的那一半：

```bash
cfind 预研 --recall        # 只搜被压缩掉的部分（= --surface shadowed）
cfind 预研 --recall --all  # 跨会话召回
```

实测（我这个会话）：2,810 条事件里 **1,567 条已看不见**（56%）。

```
$ cfind 预研究 --recall
e8cef3de#8 user/shadowed … :: 先预研究一项目 一个专门用于在DSH会话记录中快速找内容的项目   ← 最初的指令
```

同一条命令不带 `--recall` 时，首条命中会变成我几秒前刚敲的 bash 命令 —— 而那是我
本来就知道的东西。MCP 里对应 `recall` 工具。

## 排除自己：`--exclude-self`

cfind 索引的是**会话历史**，而 agent 的每条工具调用都在历史里 —— 所以你刚敲的命令
下一刻就成了可检索内容。找「别的会话里的知识」时这层噪音很大：

```bash
cfind 挂载 --all --exclude-self      # 只看别人/别的会话，不看自己
cfind audit --all --exclude-self     # 审计时排除自己（最常见用法）
```

「自己」的判定顺序：`$DSH_SESSION_ID` → `files` 表里 mtime 最新的会话
（后者对四个源都成立：调用方正在被追加日志，所以它几乎必然是最近被改的那个）。

MCP 有同名参数 `excludeSelf`。

## 精简输出：给 agent 省 token

`--terse` 砍掉的是**排版**不是信息：无 `scope` 首行、前缀压成 `short#seq kind`、
同会话标题只出现一次、`surface` 仅在 shadowed 时标注 —— 但 `short#seq` 都还在，
agent 依然能接着调 `show`。实测在同样预算下能装下**更多命中**（tok/hit 降 7–29%）。

## 三层递进（强制，避免烧上下文）

| 层 | 命令 | 给什么 | 默认预算 |
|---|---|---|---|
| **L1 摘要** | `cfind outline` | 标题 + 每回合一行（问/答）+ 压缩检查点 | 3000 字符 |
| **L2 选择** | `cfind <query>` | 命中列表 + 240 字片段 + `current/shadowed` 标记 | 1500 字符 |
| **L3 全文** | `cfind show <s> <seq>` | 事件窗口原文，按事件均分预算截断 | 1500 字符，`--full` 不限 |

L2 **永远不给全文**：agent 需要细节必须显式再调一次 `show`。

## 隐私 / 涉密检查

```bash
cfind audit                        # 默认只看高精度模式（key 前缀、PEM、Bearer、xxx= 赋值…）
cfind audit --min-severity all      # 加熵启发式（误报高：路径、sha256 摘要都会命中）
cfind audit --fail-on-findings      # CI 门禁：有命中则退出码 1
```

输出**强制脱敏**，审计器自身不会变成泄露源：

```
[secret-assignment] 178bf480 #630 tool-result :: hsiX…Wc(len=43)
```

## 退出码

`0` 有命中 · `1` 无命中（同 grep，**不是错误**）· `2` 用法/索引错误 · `3` 语料不可读。

## 实测数字

| 指标 | 数值（52 会话 / 5.5MB 压缩语料） |
|---|---|
| 冷建索引 | **0.96 s**（5580 事件 → 3146 文档） |
| 热查询（含增量同步 + 检索） | **≈50 ms**（墙钟 80–90 ms，其余是 Node 启动） |
| MCP 常驻进程单次工具调用 | **≈10 ms**（无 Node 启动开销） |
| 索引体积 | 9.9 MB（≈压缩语料 1.8×） |
| 内存模式（`--no-index`） | 0.9 s |
| 中文 2 字 / 多字 / 英文 | 全部命中 |

## 多来源（已实现四个）

一次搜四家 agent 的会话历史：

```bash
cfind 挂载 --all                     # DSH + Claude Code + Codex + OpenCode
cfind 项目 --all --source claude     # 收窄到某个来源
```

| source | 存储形态 | 压缩怎么表达 |
|---|---|---|
| `dsh` | `.jsonl.zstd` 多帧 | `surfaceOp:{op:'replace'}` |
| `claude` | 明文 `.jsonl`（DAG 节点） | `system` + `compact_boundary` |
| `codex` | `rollout-*.jsonl` + `.jsonl.zst` 归档 | `compacted` 事件 |
| `opencode` | SQLite（2.x `session_message`） | `compaction` 消息 |

实测本机真实样本：61 会话 / 7780 事件 / 4360 文档，全量建索引 **1.4 s**。
接第五个 agent 只需加一个适配器，**检索层一行不改**（约 78% 代码与来源无关）。
契约与各源差异见 [`docs/sources.md`](docs/sources.md)。

## 开发

```bash
node tests/fixtures/make-fixture.mjs   # 确定性语料（含一次真实压缩事务）
node --test tests/*.test.mjs           # 135 个测试
```

- [`docs/prestudy.md`](docs/prestudy.md) — 预研报告：格式、压缩语义、分词对比、选型
- [`docs/sources.md`](docs/sources.md) — 多来源适配器契约
- [`CONTRACT.md`](CONTRACT.md) — 模块契约（数据库 schema 是唯一耦合面）
- [`proto/probe.mjs`](proto/probe.mjs) — 最早的可行性验证脚本

## 已知限制

1. DSH 侧依赖 session format **v4**；宿主升版后解析会显式报错而不是猜。
2. 索引不可写时降级为内存模式，大语料（>100MB）会慢；建议先在有写权限的环境预热。
3. 运行中的会话末帧可能不完整 —— 跳过该帧、水位线不动，下次查询自动补。
4. `audit` 的熵启发式误报偏高（默认关闭），`secret-assignment` 仍可能命中散文里的 `token=`。
5. MCP 下拿不到 `$DSH_SESSION_ID`（client 会 scrub 所有 `DSH_*`），"搜自己"改用
   **mtime 最新会话**启发式；CLI 下仍优先用环境变量，更精确。

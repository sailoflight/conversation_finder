# conversation_finder · `cfind`

> **会话历史的 grep。** 一个 pattern 进去，命中行出来 —— 包括已经被压缩掉、模型看不见的那部分。
> 零第三方依赖，CLI + MCP 双形态，面向 agent 与人共用。

```bash
cfind 幂等键                      # 默认搜"自己"，不用传会话 id
cfind 幂等键 --all                # 搜全部会话（≈ grep -r）
cfind 幂等键 --all | cut -d: -f1  # 哪些会话提到它（grep 式管道）
cfind show aaaaaaaa 2             # 取某条命中的上下文（≈ -A/-B）
```

输出就是 `session:seq:text`，一行一条，和 `file:line:content` 同构：

```
$ cfind 幂等键 --all --limit 3
aaaaaaaa:1:[幂等键]与重复扣款排查
aaaaaaaa:2:POST 请求重复提交会导致重复扣款，需要[幂等键]。
```

**stdout 只放结果**；命中总数、模糊放宽、去重折叠这些"工具自己的话术"走 stderr
（grep 把警告写 stderr，同理），所以 `| head`、`| wc -l`、`| cut -d: -f1` 都不会被打乱。

`show` 沿用 grep 的 context 惯例 —— 命中行用 `:`、上下文行用 `-`：

```
$ cfind show aaaaaaaa 2 --before 1 --after 1
aaaaaaaa-1-幂等键与重复扣款排查
aaaaaaaa:2:POST 请求重复提交会导致重复扣款，需要幂等键。
aaaaaaaa-3-⏵ 查一下订单服务的写入路径 先看去重逻辑在哪。 bash {"command":"grep -rn dedupe src/order"}
```

所以 `| grep ':'` 能只留命中行，`| cut -d: -f2` 能只拿行号。

### 大事件：`--find` 定位到具体位置

`seq` 只回答"哪个事件"，不回答"事件里的哪一处"。而一条事件可以有几万字符
（reasoning 块、抓取的文档、巨型工具输出）—— 实测 13% 的文档超过 2000 字符：

```
$ cfind show <session> 86
(#86 has 62836 more chars not shown (reasoning); add --find <term> to jump to the match)

$ cfind show <session> 86 --find 命中处
<session>:86:…窗口以命中处为中心，而不是从第 0 字符截断…
```

给 `--find`（通常就传你刚搜的那个词）后，窗口**以命中处为中心**，
并且会显示普通视角省略的部分（如 reasoning 块）—— 保证 search 说命中的东西，
`show` 一定看得到。

> 这条不变量有测试锁死（`tests/show-find.test.mjs`）：`renderEvent` 是"人读视角"
> （只给 text 块），`toDocs` 是"索引视角"（还含 reasoning）。两者一旦不一致，
> 就会出现"search 说命中在 #86，show #86 里找不到那个词"这种最难解释的 bug。

想要带 kind/surface/标题的富格式就 `--verbose`。

## 参数就是行为（grep 已经内化在 agent 里）

agent 早就"会" grep。所以参数不该是新的抽象，而该是它已有的动作。
**与 grep 同款的参数不算限制** —— 它们不占认知，只是把已知动作接到新数据源上：

| 参数 | grep | 行为 |
|---|---|---|
| `query` | pattern | 找什么 |
| `all` | `-r` | 全库找 |
| `context` | `-C N` | 看命中周围 |
| `list` | `-l` | 只问哪些会话 |
| `limit` | `-m N` | 最多几条 |
| `regex` | `-E` | 当正则 |

真正要克制的是 grep 里没有的东西。现在只有 **2 个**：

| 新概念 | 为什么 grep 没有 |
|---|---|
| `exclude` | grep 只能按**文件**过滤；会话语料还有「工具输出 / 思考 / 答复」这一层，实测占 85% 命中 |
| `deep` | grep 没有"再扫一遍低精度启发式"这回事 |

预算据此定义：**工具 ≤ 2、新概念 ≤ 2、接口税 ≤ 500 tok**。
新增参数时必须在 `lib/interface.mjs` 里声明它属于哪一类，否则测试直接失败 ——
免得"这个算不算 grep 同款"变成每次都要吵的主观判断。

## 默认按作用域自适应（零重复原则）

**自己的会话 → 搜压缩前**：压缩之后的内容仍在我的上下文里，检索它只是把已经占着窗口的
字节再复制一遍。真正想不起来的，恰好是被压掉的那一半。

**别人的会话 / 全局 → 搜全部**：它们的压缩前历史从来没进过我的上下文，排除只是丢信息。

| 调用 | 默认搜哪半 | 为什么 |
|---|---|---|
| `search(query)` | 自己会话的 `shadowed`（压缩前） | 压缩后的我已经看得见 |
| `search(query, all: true)` | 所有会话的 `all` | 别人的历史我从没见过 |

不需要参数——这是"零重复"的直接落地。CLI 仍可用 `--visible` / `--surface all` 精确控制。

## 区域排除：grep 没有的能力

grep 只有"文件"，而会话语料里有明显不同的区域。实测本机索引：

| 区域 | 文档占比 | 字符占比 |
|---|---|---|
| `tool`（调用+输出） | **59.5%** | 58% |
| `reasoning`（思考） | 18.0% | 31% |
| `assistant`（答复） | 14.2% | 1.6% |
| `user`（提问） | 6.6% | 8.4% |

**85% 的命中来自工具输出和思考过程**：

```bash
cfind 幂等键 --all --limit 10                  # 216 条命中，多数是命令转储
cfind 幂等键 --all --exclude tool,reasoning    # 15 条，几乎全是正文
```

| 查询 | 全部命中 | 排除 tool+reasoning | 噪音 |
|---|---|---|---|
| 幂等键 | 216 | 15 | 93% |
| settlement | 149 | 11 | 93% |
| zstd | 223 | 18 | 92% |
| 压缩 | 427 | 61 | 86% |
| 实现 | 230 | 72 | 69% |

可用区域：`tool` `reasoning` `assistant` `user` `title` `system` `compaction`
（直接写 kind 名也行，如 `tool-result`）。写错会**报错**而不是静默忽略。

> 系统提示词本来就**默认不索引**（DSH 的 `system/message` 在跳过列表里），
> 所以没有"排除系统提示词"这个负担。


## 表达式检索：`--regex`（grep 同款）

```bash
cfind 'settlement_id|幂等键' --regex --all
cfind '返回 ?[0-9]{3}' --regex
cfind '幂等键.*(冲突|重复)' --regex --exclude tool,reasoning
```

**为什么不默认开**：grep 的默认就是正则，但它没有索引可用 —— 正则必须全表扫。
我们默认走的 FTS 索引能做中文 bigram（`幂等` 这种 2 字词）、拼写纠错、模糊放宽，
这些是正则给不了的。所以：**默认关键词（快），要表达式就 `--regex`（慢但任意）**。

| 方式 | 延迟 | 能力 |
|---|---|---|
| 关键词（默认） | **6.6 ms** | 中文 bigram、纠错、模糊 |
| 正则 `--regex` | **91 ms** | 任意表达式 |

慢 14 倍是全表扫的固有代价（6.8M 字符），不是实现问题。

### 一个 grep 没有的问题：回溯爆炸

grep 用 DFA，正则匹配是线性的 —— 所以 `(a+)+$` 伤不到它。
JS 的 `RegExp` 是回溯引擎，同一个模式在 30 个 `a` 上要跑 **19 秒**，
而语料里有 64,000 字符的事件。

所以正则**跑在 worker 里**，主线程用 `Atomics.wait` 限时等（默认 5s），
超时就 `terminate` 掉并报错：

```
$ cfind '(a+)+$' --regex --all
cfind: 正则超过 5000ms 仍未完成，已中止。可能是灾难性回溯（如 (a+)+$）；请简化模式或改用关键词搜索。
```

而且中止之后进程仍然可用 —— 这个也有测试钉住。

## 默认严格：每条命中都真的含你输入的词

这一条是整个工具的地基。

```
默认      cfind X  有命中  ⇒  这段记录确实提到过 X
--fuzzy   cfind X  有命中  ⇒  这段记录**可能**只是提到了相近的东西
```

因为 agent 会把它当 grep 用。一旦默认放宽，`完全不存在zzzqq` 这种查询也会通过
「省略一个」返回十几条（实测过），而 agent 没有能力分辨"真命中"与"近似命中"——

- 假阴性的代价：agent 改写查询重试一次。**这个回路本来就可靠。**
- 假阳性的代价：agent 基于错误证据继续推理，且**不会回头怀疑**。

所以默认严格，放宽全部收进一个显式开关。

## `--fuzzy`：显式放宽（含同义替换）

```bash
cfind 排重 --all --fuzzy     # → 去重
```

一次打开全部放宽，按精度排序执行：

| 级 | 做什么 | 举例 |
|---|---|---|
| 前缀 | 词头匹配 | `settle` → `settlement` |
| 拼写纠错 | 编辑距离（只对拉丁词） | `reconclie` → `reconcile` |
| 同义替换 | 查表换说法 | `排重` → `去重` |
| CJK 容错 | bigram 少一个 | `预研旧` → `预研` |

**同义替换能救回什么**（`bench/synonym-eval.mjs`，受控语料）：

| 指标 | 结果 |
|---|---|
| 罕见说法 0 命中 → 救回 | **6/6** |
| 扩展结果真的属于该概念 | **6/6** |
| 通用词/无关串被误扩展 | **0/4** |

### 三道护栏（为什么它不会乱带无关词）

| 护栏 | 作用 |
|---|---|
| 只在精确为 0 时触发 | 本来能搜到的查询，一行都不会变 |
| **扩展词不得比原词更常见** | 用文档频率自动判断，不需要手写黑名单 |
| 短语整体匹配 | `"等待 待太 太久"`，不是 `等待 OR 太久` |

第二条的数字来自实测：

| 好同义词 | 频率比 | 坏扩展 | 频率比 |
|---|---|---|---|
| 等待太久 | 0.0x | 调用 | **6.8x** |
| 防止过载 | 0.1x | 同时 | **4.0x** |
| 自我调用 | 0.0x | 重复 | **2.4x** |

高频通用词会把整个语料拉进来；`等待太久` 只在真讨论超时时出现。
**频率本身就是精度的代理。**

### 连「放宽一个词」都不给全放

早期实现里 OR 放宽是「任一词命中即算」，一个三段查询退化到只对上 1 段：

```
缓存加速  →  "缓存" OR "存加" OR "加速"   →  83 条，多数只含「缓存」
```

现在改成**最多省略一个单元**（三段里必须对上两段）：

```
缓存加速  →  "缓存 加速"                  →  9 条，全部真的在讲缓存加速
```

43 条噪音消失，而「一个词写错」的场景仍然救得回来。

### 刻意不做

- **不做跨语言**（超时↔timeout）：是"翻译"不是"同义词"，实测 timeout 3.6x、cache 3.1x、error 3.0x 全会被频率护栏拒绝。
- **不做自动挖掘**：同现统计会把「和/与/因为」挖成同义词。
- **不追求覆盖率**：表只有 13 组。漏一个只是多搜一次，错扩却要逐条排除。

## 归档：工具删掉的会话，索引替你留着

Claude Code 和 Codex 都会**定期清理旧会话**。而「想不起某件事」时最该找回的，
恰恰是那些已经不在磁盘上的记录。

所以原始文件消失时：**归档，不删除**。

```bash
cfind index                # 消失的文件会被标记 archived，内容保留
cfind 幂等键 --all         # 归档的内容照常搜得到
cfind show <id> <seq>      # 原始文件没了也能取正文（从索引重建）
cfind index --gc           # 显式回收；不自动执行
```

`show` 在归档状态下会明确提示：

```
aaaaaaaa:2:POST 请求重复提交会导致重复扣款，需要幂等键。
(原始会话文件已被删除（工具清理旧会话）；以下内容从索引重建，是蒸馏副本)
```

为什么不自动清理：**磁盘上删掉文件 ≠ 你想忘掉这段对话**。这两件事只有你能分清。

整个会话目录都不存在时也照常工作（只要有索引），只在 stderr 提醒一句。


## 为什么需要它

agent 的 `/compact`（或自动压缩）只让模型**看不见**旧消息，**原文仍留在磁盘上**。
实测本机一个 2498 事件的 DSH 会话：

| | 事件数 | 占比 |
|---|---|---|
| `current`（模型仍可见） | 959 | 38% |
| `shadowed`（已压缩，模型不可见） | **1539** | **62%** |

```bash
$ cfind 最初 --all --recall
aaaaaaaa:1:先调研一个会话检索工具，要求能找回被压缩掉的历史
```

压缩之后再问"我们最初要干什么"，模型答不出来，`cfind` 一秒取回。

## 为什么不用现成的

这个方向已经有不少项目（详见 [`docs/prior-art.md`](docs/prior-art.md)），
但**没有一个按「agent 的接口预算」设计**：

| | 我们 | 同类（cass / sessionwiki / agent-sessions） |
|---|---|---|
| 接口 | **2 个工具 / 9 个参数 / 324 token** | 20–30+ 个子命令 |
| 定位 | agent 调用 + 管道 | 人来浏览（TUI / Web UI / 原生 App） |
| 依赖 | 零（`node:sqlite` + `node:zlib`） | Rust/Go/Swift 二进制 |
| 语义搜索 | 不做（要模型） | cass 可选（默认模型 90MB） |

它们强在**人机界面和来源覆盖**（cass 支持 30+ 种 agent）；
我们强在**从 agent 里调用几乎不花钱** —— 一次 `search` 291 token，
接口税只相当于 1.4 次搜索。

诚实的短板：没有 `trace <file>`（从代码反查对话），来源只覆盖 4 个主流工具。
这两点都写在 prior-art 里，不假装没有。


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
$ cfind 幂等建 --all
aaaaaaaa:1:[幂等键]与重复扣款排查
(spelling→幂等建→幂等键)
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

## 想不起早先的东西？默认已经在找它了

这是整个工具存在的理由。压缩之后你的上下文只剩「摘要 + 之后的新消息」，
那些东西**你本来就看得见**，再检索一遍是浪费。真正想不起来的，恰恰是被压掉的那一半。

所以**自己的会话默认就搜压缩前**，不需要任何参数：

```
$ cfind 最初
aaaaaaaa:1:先调研一个会话检索工具，要求能找回被压缩掉的历史   ← 最初的指令
```

实测我这个会话：2,810 条事件里 **1,567 条已看不见**（56%）。

想要另一半（还在上下文里的）就 `--visible`，两边都要用 `--surface all`。

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
cfind audit                      # 只扫当前会话
cfind audit --all --exclude-self # 扫全部，但跳过自己（检查"别人的会话有没有泄密"）
cfind audit --deep               # 连熵启发式一起扫
```

**默认扫 9 个高精度模式**，都靠固定前缀或明确语义，几乎不会误报：

| 模式 | 例子 |
|---|---|
| `sk-key` | `sk-...`（OpenAI/Anthropic） |
| `aws-access-key` | `AKIA...` |
| `github-token` | `ghp_...` |
| `google-api-key` | `AIza...` |
| `slack-token` | `xoxb-...` |
| `pem-private-key` | `-----BEGIN ... PRIVATE KEY-----` |
| `bearer-token` | `Authorization: Bearer ...` |
| `secret-assignment` | `password = "..."`、`api_key: "..."` |
| `url-credentials` | `https://user:pass@host` |

`--deep` 再加两个**熵启发式**（不看上下文，只算随机度）。它确实能抓到没有固定前缀的凭据，
但代价实测过：

| | 条数 |
|---|---|
| 默认（9 个高精度模式） | **96** |
| `--deep`（+2 个熵启发式） | **396**（多 3.1 倍） |

多出来的 300 条里，长度 64 的 **66 条**、长度 32 的 **13 条** —— 那是 sha256 和 md5。
所以这东西**不是"严重度"**：一个 sha256 摘要和一把 AKIA 密钥的危险程度天差地别，
但它们在这套规则里只是「同一条熵模式的两类结果」。

真正的区别是**模式精度**，不是危险程度。所以参数叫 `deep`（行为：再扫一遍），
而不是 `minSeverity`（机制：一个名不副实的分级）。

所有输出**强制脱敏**：前 4 字符 + `…` + 后 2 字符 + `(len=N)`，长度 < 7 全遮成 `***`。
完整凭据只存在于 `lib/audit.mjs` 的局部变量里，绝不进返回值。


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

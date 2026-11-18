# DSH 会话检索器（预研报告）

> 目标：在 DSH 的会话记录里"像记忆一样"快速找内容——经历多轮压缩之后仍能直接取回原文；
> 以 CLI 运作，输入尽量精简；供人和 agent 共用；分层「摘要 → 选择 → 全文」；顺带支持隐私/涉密检查。

- 状态：**预研完成**（技术路径已用真实语料验证，非纸面推演）
- 验证语料：本机 `$DSH_HOME/sessions` 全部 24 个会话 / ≈1.5–1.8 MB 压缩 / ≈5 MB 解压 JSONL
- 验证脚本：[`proto/probe.mjs`](../proto/probe.mjs)（可直接 `node proto/probe.mjs` 复跑）

> 注：预研期间本会话自身也在写入同一语料，故文中绝对数字会有小幅漂移；所有量级与
> 「可行性判断」不受影响。关键对照（中文分词 0 命中 vs 全命中）在任何一次运行中都稳定复现。

---

## 1. 结论先行

**值得做，而且必须自己建索引——不能指望 DSH 现有能力。**

五条硬结论（每条都有实测支撑，见 §5）：

| # | 结论 | 影响 |
|---|---|---|
| 1 | **压缩不删数据。** 压缩只是给旧的 surface 打 `replace` 标记；原始事件永久留在 JSONL 里 | 这是本项目成立的根本前提：被压缩掉的原文**一定还能搜到** |
| 2 | **官方 FTS5 后端对中文失效。** 索引分词器是 `unicode61`，连续中文整句被当成一个 token，搜"幂等性"命中 0 | 现成能力在本环境（中文会话）等于不可用，必须换分词策略 |
| 3 | **`rg`/`grep` 不能直接用。** 会话文件是 zstd 多帧压缩的 JSONL | "复用成熟实现"要落在 **SQLite FTS5 + zstd** 上，而不是 rg |
| 4 | **零依赖可实现。** Node 22 自带 `node:sqlite`（含 FTS5）与 `zlib.zstdDecompressSync` | 无需装任何三方包，无 sqlite3 CLI 也能跑 |
| 5 | **成本极低。** 全量建档 0.4–0.8 s；热查询 0.2–5 ms；索引约为压缩语料的 1.5× | 可以在每次查询前"顺手增量更新"，不需要常驻守护进程 |

**建议形态**：单文件 Node CLI（`cfind`），按需增量索引 + 无索引降级扫描；默认搜"当前会话"（读 `DSH_SESSION_ID`）；输出默认走「摘要 → 选择」两层，`--full` 才进全文。

---

## 2. 场景与需求拆解

| 原始诉求 | 拆解 | 设计落点 |
|---|---|---|
| 无数次压缩后仍能"像记忆一样"给出 | 压缩后的 shadowed 事件必须可检索，且反手能取回原文 | 索引全部事件（含 shadowed），`surface` 列标记 `current/shadowed` |
| 服务于 agents | 稳定机器可读输出、低延迟、小输出预算、可预测退出码 | `--json`、`--max-chars`、token 预算、退出码约定 |
| 效率 | 冷路径要短；不扫全库 | 增量索引（只解新 zstd 帧）+ FTS5 排序 |
| 摘要 > 选择 > 全文 | 三档递进，默认不给全文 | L1 摘要 / L2 片段选择 / L3 原文窗口 |
| CLI 模式 | 单命令、无守护进程、无配置 | `cfind <query>` 直接可用 |
| 输入尽量精简 | agent 调用时连"搜哪个会话"都不用传 | 默认 `--session $DSH_SESSION_ID`；缺省再退到 cwd 项目 |
| 复用成熟实现 | 不重造检索与压缩 | SQLite FTS5（BM25 + snippet）、zstd、`node:sqlite` |
| 隐私检查 | 批量扫涉密内容并定位到会话/事件 | `cfind audit`，输出**脱敏**片段 |

---

## 3. 事实基础：DSH 会话记录长什么样

### 3.1 磁盘布局

```
$DSH_HOME/sessions/
  --home-d_demo1-code-dsh-bench--/        ← projectKey(cwd)，可读的路径转义
    178bf480-e2dc-412b-a68f-55b323fcceaa/
      session.v4.jsonl.zstd               ← 唯一数据文件（zstd 多帧）
      session.lock                        ← 运行中会话的空锁文件
```

- `projectKey` 算法（官方 `dsh-session-persistence-jsonl`）：`/`、`\`、`:` → 合成一个 `-`；其余不安全字符 → `~XXXX`；结果包在 `--…--` 里，超长截断到 251 字符。
- 但**不要依赖目录名反推 cwd**：`session` 事件头里直接有 `cwd`，且目录名是 lossy 的（截断 + 分隔符合并）。
- 另有 `$DSH_HOME/storages/workspace.json`：全局目录表（workspace → path / title / sessionIds / 时间戳），适合做 L0 元数据，无需解压。
- 另有 `$DSH_HOME/storages/session_projcache/sessions/<id>.json`：DSH 自己的**增量投影缓存**（v7），含 `title`、`goal`、`plan`、`tokenUsage`、`sandboxMode` 等行，每行带 `ver`/`seq`。注意：本机 dsh-tui profile 里该项被 `disabled: true` 关掉了（性能取舍，注释称 33k 事件重放 1.28 s / 峰值 112 MB）。

### 3.2 记录格式（session format v4）

JSONL，每行一条事件：`{"type": …, "seq": N, "time": epoch_ms, "data": {…}, "surfaceOp"?: …}`。

实测出现的事件类型（全语料 ≈1.5k 条）：

| type | 数量 | 语义 | 体积占比 |
|---|---|---|---|
| `assistant/message` | 176 | 模型输出（text/reasoning/tool-call 三类 block） | **58.9%** |
| `request/header` | 21 | 每次请求的完整工具 schema 与配置 | 20.8% |
| `tool/result` | 235 | 工具输出 | 8.8% |
| `system/message` | 21 | 系统提示（整段重复写入） | 4.2% |
| `tool/call` | 237 | 工具调用参数 | 3.2% |
| `user/message` | 89 | 用户输入 / 注入上下文 | 1.9% |
| `agent/inbox/spliced` | 56 | 收件箱拼接 | 0.8% |
| `session/title` | 25 | 会话标题（**现成的摘要源**） | 0.1% |
| `compaction/start\|summary\|end` | 0（本机未发生压缩） | 压缩事务三件套 | — |
| `step/*`、`turn/*`、`approval/*`、`subagent/*`、`command/*` | 若干 | 时序骨架 | <1% |

`assistant/message` 内部构成（按字符，实测）：

| 部分 | 占比 | 检索价值 |
|---|---|---|
| `reasoning` | **65.9%** | 含推理与备选方案，**官方索引把它整段丢弃** |
| `tool-call` args | 20.6% | 命令/文件路径，高价值 |
| `replayState` | 10.1% | 模型回放数据（`thinkingSignature` 等），**纯噪声，必须排除** |
| `text` | 3.4% | 结论正文 |

### 3.3 压缩机制（本项目的地基）

依据官方 `dsh-compaction-basic` 与实机数据：

1. 压缩是一次**区间事务**：追加 `compaction/start` → 生成摘要 → 追加 `compaction/summary`（`data.summary` 为 ContentBlock[] 全文，另有 `shadowedTokenCount`）→ 追加一条**替换型** `user/message`（正文包在 `<compacted-summary>` 标签里）→ `compaction/end`。
2. 替换靠 `surfaceOp` 表达。实测只有两种形状：
   - `"append"`（563 条）
   - `{"op":"replace","startSeq":N,"endSeq":M}`（1 条）
3. 被判 `replace` 覆盖的事件 → surface 分类为 **shadowed**；其余为 **current**。两者**都还在日志里**。
4. 所以：**压缩只改变"模型还能看到什么"，从不删除"磁盘上有什么"**。`/compact` 越多次，本项目相对模型上下文的增量价值越大。

> 一句话：这个工具的定位不是"另一个 grep"，而是**压缩导致的记忆损失的外部补偿层**。

---

## 4. 可复用资产盘点（官方包，本机已装）

`~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 下 288 个包，与本项目相关的是：

| 包 | 提供什么 | 对本项目的用法 |
|---|---|---|
| `dsh-session-query` | `ctx.sessionQuery`：list/filter/read/search 统一契约；含**语义文本提取** `extractSessionEventText` | 提取规则照抄（保证"搜到的 = 模型看到的"） |
| `dsh-session-query-sqlite` | 派生 SQLite FTS5 索引（`persisted_docs` + 临时 `live_docs`），BM25、240 字 snippet、游标分页 | **schema 设计参照**；分词器必须换（见 §5.3） |
| `dsh-session-persistence-jsonl` | zstd 多帧读写、`projectKey`、会话目录布局 | 复用其格式知识；实现时对齐 |
| `dsh-session-turn-outline` | `turnOutline` 投影：每回合的 prompt/response 预览 | **L1 摘要层现成数据源** |
| `dsh-session-projection-cache` | 增量投影缓存（本机被禁用） | 可选的加速层，非必需 |
| `dsh-compaction-basic` | 压缩事务与事件 schema | 索引 `compaction/summary` 的字段依据 |
| `dsh-shell-env` | 向 bash 注入 `DSH_SESSION_ID`/`DSH_HOME`/`DSH_PROFILE` | **"默认搜自己"的实现依据** |

### 4.1 官方实现的两个缺口（本项目的立项空间）

1. **中文分词**：`persisted_docs` 硬编码 `tokenize='unicode61'`。实测连续中文句
   `这是一个关于幂等性的讨论` 搜 `幂等性` → **0 命中**（见 §5.3 表格）。本环境会话几乎全中文，结论：官方搜索在主要场景下不可用。
2. **提取口径**：`extractSessionEventText` 的 switch 只处理 `user/message`、`assistant/message`、`tool/call`、`tool/result`、`todo/write`、`turn/end`。
   - `reasoning` 被 `blockText` 丢弃（占 assistant 体积 65.9%）；
   - `compaction/summary` **没有 case**，事件本体不入索引（摘要正文只能经由带 `<compacted-summary>` 包装的替换消息被间接搜到，片段里混着 preamble 噪声）；
   - `system/message`、`request/header` 同样不入索引（这点是对的，应当沿用）。

---

## 5. 关键技术验证（全部实测）

### 5.1 zstd 多帧：三个必踩的坑

会话文件是**多个 zstd 帧首尾拼接**（实测 24 个文件 670 帧，平均 2.05 事件/帧，平均 2.2 KB/帧）。实测行为：

| 调用方式 | 结果 | 判定 |
|---|---|---|
| `zstdDecompressSync(整个文件)` | **只输出第一帧**（2.5 MB 的文件只拿到 200 字符），且**不报错** | ☠️ 静默截断，最危险 |
| `createZstdDecompress()` 流式喂整文件 | 同样只解第一帧后 `end` | ☠️ 不可用 |
| 逐帧：按 magic 切分后逐段 `zstdDecompressSync` | 完整 2.5 MB 输出，52.8 ms / 431 帧 | ✅ 唯一正确解 |

**帧边界检测**：扫 magic `28 B5 2F FD`（平均误命中率很低），逐段解码；**失败就把该段与下一段合并重试**。实测 677 段、合并失败 0 次、非换行结尾 0 次——边界判定可靠。

> 实现红线：**永远用"逐帧解码 + 失败合并"**；任何时候都不要对整文件做一次 `zstdDecompressSync`。

### 5.2 性能（本机）

| 操作 | 实测 |
|---|---|
| 全语料逐帧解码 + JSON 解析 + 提取（≈1.5 MB 压缩） | **≈370 ms**（≈3.7k 事件/s，≈3.9 MB/s） |
| 全语料解码 + 写 SQLite FTS5 索引（≈1.0k 文档） | **≈440–820 ms** |
| 增量：单文件尾部 3 帧（2 KB / 760 KB） | **1.2 ms** |
| 索引体积 | **≈2.4–2.7 MB**（FTS5 + bigram 列，约为压缩语料的 1.5×） |
| 查询延迟（BM25 + snippet，命中 1–3 条） | **0.24 – 5 ms**（首查含预热） |

结论：**"查询前顺手增量索引"完全可行**，不需要后台进程。线性外推到 100 MB 语料：冷建 ≈30 s（仅首次），热查询仍是毫秒级。

可检索文档构成（≈1.0k 条）：`tool-call` 257 / `tool-result` 256 / `reasoning` 181 / `assistant` 168 / `user` 89 / `title` 25 —— 注意 **tool 类占了一半以上**，说明工具输出才是"内容"主体，必须索引。

### 5.3 中文全文检索：分词方案对比（决定性）

同一句 `这是一个关于幂等性的讨论，压缩之后还能不能找回来`：

| 方案 | 2 字查询「幂等」 | 3 字「幂等性」 | 4 字「压缩之后」 | 结论 |
|---|---|---|---|---|
| `unicode61`（**官方所用**） | 0 | 0 | 0 | ❌ 中文不可用 |
| `trigram` | **0** | 1 | 1 | ⚠️ 2 字查询直接失效，而中文 2 字词极多 |
| 手工 bigram 列 + `unicode61` | **1** | 1 | 1 | ✅ 全部命中 |

**推荐方案**：写入侧把 CJK 连续段切成 bigram 串（`幂等性` → `幂等 等性`）存进独立列 `sh`；查询侧把 CJK 查询词转成 bigram **短语**（`"幂等 等性"`），拉丁词照常；单字 CJK 查询退化到 `LIKE` 扫描（罕见，可接受）。中英混合用 `AND` 连接，实测 `retry 幂等` 组合正确。

> 这条是本项目**唯一真正需要自己实现的核心算法**，其余全部复用。

---

## 6. 架构设计

### 6.0 先选型：四条路，为什么选 B

| 方案 | 做法 | 优点 | 否决理由 |
|---|---|---|---|
| A. 挂官方插件 | 在 profile 里 mount `dsh-session-query-sqlite`，agent 用原生 tool | 完全复用，零维护 | **中文搜不到**（`unicode61`）；index 需在 DSH 进程内、`openAt` 才生效；CLI 场景（人在终端、非 DSH 会话）根本没有 ctx |
| **B. 自建 CLI + 自建索引**（推荐） | 单文件 Node 脚本，直读 `sessions/`，自建 FTS5 | 零依赖、进程外可用、分词可控、可给非 DSH 场景用 | 需自己维护 schema 与增量逻辑（约 600–800 行） |
| C. 纯扫描不建索引 | 每次查询全量解码 + 内存匹配 | 最简单、无写副作用 | 1.5 MB 尚可（≈400 ms），>50 MB 就不可接受；无法排序/高亮复用 FTS5 |
| D. 导出纯文本给 rg | 先解压成 .txt，再用 rg | 复用最成熟的工具 | **rg 没装**；且要维护一份明文镜像（隐私风险 + 双倍磁盘 + 同步问题），与"会话涉密"直接冲突 |

结论：**B 为主，C 作为沙箱降级路径，D 明确否决**（明文镜像本身就是本项目要防的风险）。

### 6.1 形态：单文件 Node CLI，双模式

```
cfind <query>            # 最常用：默认搜当前会话，无参数配置
```

| 模式 | 触发 | 行为 |
|---|---|---|
| **索引模式**（默认） | 索引目录可写 | `stat` 所有会话文件 → 只对新增帧做增量索引 → FTS5 查询 |
| **扫描模式**（降级） | 索引目录不可写 / `--no-index` / `CFIND_NO_INDEX=1` | 直接逐帧解码 + 内存匹配（1.5 MB ≈ 400 ms，可用；>50 MB 时提示建议建索引） |

降级模式的存在是刚需：agent 常在 `workspace-write` 沙箱里跑，**写不到 `~/.dsh`**。索引默认落在
`$DSH_HOME/cache/cfind/`，不可写则自动退回扫描（无写副作用）。

### 6.2 索引 schema（`node:sqlite`，FTS5）

```sql
CREATE TABLE sessions(id TEXT PRIMARY KEY, cwd TEXT, title TEXT,
                      created_at INTEGER, agent_preset TEXT, parent_id TEXT);
CREATE TABLE files(path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER,
                   frame_offset INTEGER, event_count INTEGER, revision TEXT);
CREATE TABLE events(session_id TEXT, seq INTEGER, type TEXT, time INTEGER,
                    surface TEXT,            -- 'current' | 'shadowed'
                    PRIMARY KEY(session_id, seq));
CREATE VIRTUAL TABLE docs USING fts5(
    body, sh,                                -- sh = CJK bigram 列
    session_id UNINDEXED, seq UNINDEXED, kind UNINDEXED,   -- kind: user|assistant|reasoning|tool-call|tool-result|compaction|title
    time UNINDEXED, surface UNINDEXED,
    tokenize = 'unicode61'
);
```

- **每类文本分 kind 入库**，排序时按 kind 设权重（`bm25(docs, w_body, w_sh)` + kind 系数）：
  `user` / `compaction` 最高 → `assistant` → `tool-call` → `tool-result` → `reasoning` 最低。
- `replayState`、`request/header`、`system/message` **不入索引**（合计约占语料 35%，检索价值低）；原文仍可经 L3 取回。
- 增量水位线：`files.frame_offset` 记录已索引到的字节位置。追加写入时只解新帧（实测 1.2 ms）；`size` 变小（重写）则整文件重建。

### 6.3 三层检索协议

| 层 | 命令 | 给什么 | 预算 |
|---|---|---|---|
| **L1 摘要** | `cfind outline [--session ID\|--project\|--all]` | 会话标题 + 每回合一行（首问 + 结果预览）+ 压缩检查点清单 | ~200 字符/会话 |
| **L2 选择** | `cfind <query>`（默认） | 命中列表：`session 短 id / #seq / kind / 时间 / score / 240 字片段` | 默认总量 ≤1500 字符 |
| **L3 全文** | `cfind show <session> <seq> [--before N --after N]` | 该事件原文 + 前后上下文窗口 | 默认 ±3 事件，`--full` 不限 |
| （旁路）**审计** | `cfind audit [--pattern …]` | 涉密命中清单，片段脱敏 | 只列位置，不吐密钥 |

递进是**强制**的：L2 永远不给全文；agent 需要细节时必须显式再调一次 `show`。这正是"摘要 > 选择 > 全文"的落地方式，也是把输出 token 花在刀刃上的关键。

### 6.4 输入精简（agent 视角）

优先级决定作用域，**全部自动化，agent 不需要知道**：

1. `--session <id>` 显式指定
2. `DSH_SESSION_ID` 环境变量（官方 `dsh-shell-env` 已注入 bash 环境）→ **默认搜自己**
3. `$PWD` 对应的项目（读 `session` 头的 `cwd`，不用目录名反推）→ `--project`
4. `--all` → 全库

于是 agent 的调用就是一行：`cfind 幂等键`。想扩到全库才加 `--all`。

### 6.5 输出契约（给人 / 给 agent 两套渲染，同一份数据）

- 默认：人类可读的紧凑列表（一行一命中，片段用 `[]` 高亮）。
- `--json`：`{query, scope, total, hits:[{session, short, title, seq, kind, surface, time, score, snippet}]}`——稳定字段，agent 直接解析。
- 退出码：`0` 有命中 / `1` 无命中（同 `grep`）/ `2` 用法或索引错误 / `3` 语料不可读。**"无命中"不是错误**。
- `--max-chars` 硬截断，保证 agent 的上下文不被一次搜索撑爆。

---

## 7. 隐私 / 涉密检查

**已实测有效**：在本机 ≈5 MB 语料上跑模式扫描，命中 1 条形如 `token=<高熵串>` 的真实凭据残迹（另有 `PWD=` 一类误报）。说明"会话里会躺密钥"不是假设。

设计要点：

- 模式集：常见厂商 key（`sk-`、`AKIA`、`ghp_`、`AIza`、`xoxb-` …）、PEM 私钥块、`Bearer`/`Authorization`、`password|passwd|pwd|api_key|secret|token` 赋值、高熵串启发式（长度 + 字符分布）、本机敏感路径与 `~/.dsh/.credentials.yaml` 内容回声。
- **输出必须脱敏**：只给 `前 4 字符…后 2 字符`（长度）与位置，绝不回显完整凭据——否则审计工具自己变成泄露源。
- 复用同一索引：`audit` 不需要新索引，直接对 `docs.body` 跑正则（SQLite `REGEXP` 不可用则走 JS 侧过滤，1.5 MB 级别毫秒级）。
- 建议额外产出"待清理清单"：会话 id + seq 列表，便于后续人工处理或写擦除工具。

---

## 8. 风险与未决问题

| # | 风险 | 影响 | 应对 |
|---|---|---|---|
| 1 | **格式漂移**（v4 → v5） | 解析全盘失效 | `session.version` 硬校验，不认识的版本显式报错退出，绝不猜 |
| 2 | **索引目录不可写**（沙箱） | 索引模式失效 | 自动降级扫描模式（已设计）；或用一条不进沙箱的命令预热索引 |
| 3 | 读取运行中会话的**半截末帧** | 偶发解码失败 | 末帧失败即跳过，保留水位线在最后完整帧之前；下次查询自动补 |
| 4 | **会话重写**（`/resume`、fork、rewind 可能改写日志） | 索引与磁盘不一致 | 对比 `size`+`mtime`；`size` 变小或 `mtime` 变旧 → 整文件重建 |
| 5 | 中文 bigram 使索引**膨胀 ~1.5×** | 100 MB 语料 ≈160 MB 索引 | 可接受；必要时只对含 CJK 的文档写 `sh` 列 |
| 6 | 同一条内容在 `tool/result` 与 `assistant/reasoning` 里**重复出现** | 结果噪声、排序打架 | 按 `(session, seq, kind)` 去重 + 相同片段折叠显示 |
| 7 | 官方语义提取只认第一方事件 | 第三方插件写入的事件可能漏 | 未知 type 默认按"取 data 内所有字符串"兜底，但降权 |
| 8 | ~~压缩事件的本地样本为 0~~ | ~~`compaction/summary` 真实字段未实测~~ | **已解除**：实现完成时本机真实产生了压缩事务（§11），字段与官方 schema 一致，摘要正文 13482 字符已被正常索引 |

**待你确认的产品取舍**：
- 单次输出默认预算（1500 字符）是否合适？
- `reasoning` 是否纳入默认检索（建议纳入但降权；也有人更想彻底排除）？
- 命令名：`cfind` / `dshfind` / `q`？是否要额外提供一个 DSH 插件（让 agent 用原生 tool 而不是 bash）？

---

## 9. 建议路线

| 阶段 | 内容 | 验收 |
|---|---|---|
| ~~**P0 补验证**~~ | ~~造一次真实 `/compact`~~ | **已完成**（见 §11）：真实压缩事务落地，1539 条事件正确标为 shadowed，摘要正文可搜 |
| **P1 MVP**（1–2 天） | 逐帧解码 + bigram FTS5 + 增量水位线 + `cfind <query>` + `show` + `--json` | 本机全库 <10 ms 查询；agent 单行调用可用 |
| **P2 摘要层**（1–2 天） | `outline`（标题 + 回合一览 + 压缩检查点）；默认输出接 token 预算 | 全新会话零配置即可"回忆"老项目 |
| **P3 审计**（0.5 天） | `audit` + 脱敏输出 + 待清理清单 | 对已知含密钥的语料零泄漏命中 |
| **P4 可选** | DSH 插件包装（原生 tool）；`--watch` 常驻增量 | — |

---

## 10. 附录：已跑的验证命令

```bash
# 事件类型与体积分布
node proto/probe.mjs

# 分词方案对比（unicode61 / trigram / bigram）
node -e '…'   # 见 §5.3 结论表，脚本片段在 proto/probe.mjs 的 buildQuery/bigrams

# 压缩与表面语义
grep -n 'shadow' ~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/README.md
```

关键事实出处：
- 提取口径：`@deepseek-ai/dsh-session-query/lib/index.js` → `extractSessionEventText`
- 官方 schema 与分词器：`@deepseek-ai/dsh-session-query-sqlite/lib/index.js` → `ensurePersistentSchema`
- 压缩事务：`@deepseek-ai/dsh-compaction-basic/README.md` §"The region transaction"
- 目录命名：`@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` → `projectKey`
- 自会话标识：`@deepseek-ai/dsh-shell-env/lib/index.js` → `DSH_SESSION_ID`

---

## 11. 实现落地后的回验（预研结论 vs 实测）

本节记录 **P1–P3 实现完成后**在真实语料上的回验，用于对照预研判断是否站得住。

### 11.1 P0 风险解除：真实压缩事件

预研时本地 `compaction/*` 样本为 0，是最大未验证项。实现完成时本机真实产生了压缩事务：

| 事件 | 数量 | 说明 |
|---|---|---|
| `compaction/prune` | 5 | **预研时未预见**的类型（`dsh-compaction-tool-result-pruner` 产生），属工具结果裁剪元数据，不入索引 |
| `compaction/start` / `summary` / `end` | 各 1 | 完整事务三件套 |

`compaction/summary` 真实形状与官方 schema 完全一致：`summary` 为 `ContentBlock[]`（本次正文 13482 字符的
结构化 markdown），另带 `shadowedRange{start,end}` / `shadowedSeqs` / `shadowedTokenCount` / `provider` / `model`。
**结论：预研对压缩语义的判断成立，无需修正。**

### 11.2 核心命题的量化证据

同一会话（`178bf480`，2498 事件）压缩后：

| surface | 事件数 | 占比 |
|---|---|---|
| `current`（模型仍可见） | 959 | 38% |
| `shadowed`（已压缩，模型不可见） | **1539** | **62%** |

`cfind 自举 --surface shadowed` 能取回该会话最开始的原始需求（`#8`）——这正是
"压缩导致的记忆损失由外部补偿"的直接证据。

### 11.3 预研数字 vs 落地实测

| 指标 | 预研（1.5MB 语料） | 落地（5.3MB / 49 会话） |
|---|---|---|
| 冷建索引 | 0.37–0.44 s | **0.92 s**（4820 事件 → 2733 文档） |
| 热查询 | 0.2–5 ms | **≈50 ms**（含增量同步；墙钟 80–90 ms 主要是 Node 启动） |
| 索引体积 | ≈压缩语料的 1.5× | 8.3 MB（≈1.6×） |
| 内存模式降级 | 未测 | **0.82 s**（沙箱可用，零写副作用） |

线性关系基本保持，量级判断成立。

### 11.4 实现中暴露的三个新事实

1. **既有 FTS5 索引缺失**：官方 `extractSessionEventText` 没有 `compaction/summary` 分支，
   而它正是"记忆"本体 —— 预研的这条判断在真实压缩发生后被证实（13482 字符摘要若不索引就彻底丢失）。
2. **`job/*` 是最大的噪声源**：`job/registered` + `job/settled` 两个类型贡献了 275K 字符的纯生命周期日志。
   已改为**前缀黑名单**（`job/` `model/` `deliverables/` `compaction/`），而不是逐条列举 ——
   宿主新增同类事件时不会再漏进来。文档数因此 3312 → 2733。
3. **真实会话 id 可能带 `session-` 前缀**（如 `session-52b00666-…`），与目录名同形。
   展示层需剥前缀，否则所有短 id 都会显示成 `session-`；短 id 解析也要按剥前缀后匹配。

### 11.5 交付状态

| 阶段 | 状态 |
|---|---|
| P0 补验证 | ✅ 真实压缩事件验证通过 |
| P1 MVP | ✅ 逐帧解码 + bigram FTS5 + 增量水位线 + 检索/show/--json |
| P2 摘要层 | ✅ `outline`：标题 + 回合一览 + 压缩检查点 |
| P3 审计 | ✅ `audit` + 强制脱敏 + 精度分级 |
| P4 可选 | ⬜ 未做（DSH 原生插件包装、`--watch` 常驻） |

测试：53 个（解码/提取/分词/索引增量/检索/摘要/审计/渲染/CLI 端到端）。

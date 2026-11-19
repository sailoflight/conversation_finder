// lib/query.mjs — L2 检索（search）与 L3 原文窗口（show）
//
// 两条检索路径（契约 §4.2）：
//   1) 常规：FTS5 MATCH（body 与 sh 两列一起命中，CJK bigram 才活）→ bm25 取候选；
//   2) 单字 CJK：bigram 至少两字，MATCH 无解，退化到 docs.body LIKE '%x%'。
//
// bm25() 返回**越负越好**；契约要求 score 越大越好 ⇒ 先取反，再乘 KIND_WEIGHTS 重排。
// 排序不能全交给 SQL：kind 权重是 JS 侧的，所以 SQL 多取 4×limit 候选再在 JS 里重排。
import { describeSession, sessionLoader, windowFromIndex, windowOf } from './context.mjs';
import { buildMatchQuery } from './cjk.mjs';
import { buildDropOneQueries } from './fuzzy.mjs';
import { grepSearch } from './grep.mjs';
import { expandSynonyms } from './synonyms.mjs';
import {
  buildCjkLooseQuery,
  buildOrQuery,
  buildPrefixQuery,
  hasCorrectableLatin,
  suggestTerms,
  tokenizeQuery,
} from './fuzzy.mjs';

import { contentVersion } from './store.mjs';
import { KIND_WEIGHTS, classifySurface, contentText, docsOf } from './extract.mjs';
import { shortId } from './paths.mjs';

const DEFAULT_KIND_WEIGHT = KIND_WEIGHTS.other ?? 0.15;
const SNIPPET_MAX = 240;

/** show 默认跳过的噪声事件；target 本身永远保留（未索引事件也要能看）。 */
const NOISE_TYPES = new Set(['session', 'request/header', 'system/message', 'turn/start']);
const isNoise = (type) => NOISE_TYPES.has(type) || String(type ?? '').startsWith('step/');

const round3 = (n) => Math.round(n * 1000) / 1000;

/** LIKE 参数里的通配符转义（ESCAPE '\'）。 */
const escapeLike = (text) => String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** 压空白成单行；snippet/占位都靠它控制体积。 */
const compress = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** 候选排序用的 kind 权重（SQL 字面量来自常量表，无注入面）。 */
const KIND_ORDER = `CASE docs.kind ${Object.entries(KIND_WEIGHTS)
  .map(([kind, weight]) => `WHEN '${kind}' THEN ${-weight}`)
  .join(' ')} ELSE ${-DEFAULT_KIND_WEIGHT} END`;

/**
 * scope → docs 表的 WHERE 片段。
 * 用子查询而不是先把 id 列表取出来塞 IN：全库时 id 可能上千，省一遍往返与参数上限。
 */
/**
 * 来源收窄的 SQL 片段（--source 用）。
 * 注意筛的是 **source 列**（docs 表自带），不是 session_id —— 写成 session_id
 * 会让 `--source dsh` 变成「找 id 字面等于 'dsh' 的会话」，静默得 0 命中。
 */
function sourcesClause(scope, column = 'docs.source') {
  const sources = Array.isArray(scope?.sources) && scope.sources.length > 0 ? scope.sources : null;
  if (!sources) return { sql: '', params: [] };
  return { sql: ` AND ${column} IN (${sources.map(() => '?').join(',')})`, params: sources };
}

/**
 * 排除指定会话（`--exclude-self` 用）。
 * 排除语义放在最后拼：它是对**已经收窄过的范围**再做减法，顺序反了会写出
 * 「既等于 A 又不等于 A」这种自相矛盾的条件。
 */
function excludeClause(scope) {
  const excluded = Array.isArray(scope?.exclude) ? scope.exclude.filter((id) => typeof id === 'string' && id) : [];
  if (excluded.length === 0) return { sql: '', params: [] };
  return { sql: ` AND docs.session_id NOT IN (${excluded.map(() => '?').join(',')})`, params: excluded };
}

function scopeFilter(scope) {
  const extra = sourcesClause(scope);
  const drop = excludeClause(scope);
  if (scope?.mode === 'session') {
    return { sql: `docs.session_id = ?${extra.sql}${drop.sql}`, params: [String(scope.id), ...extra.params, ...drop.params] };
  }
  if (scope?.mode === 'project') {
    return {
      sql: `docs.session_id IN (SELECT id FROM sessions WHERE cwd = ?${extra.sql.replace('docs.source', 'source')})${drop.sql}`,
      params: [String(scope.cwd ?? ''), ...extra.params, ...drop.params],
    };
  }
  return { sql: `1 = 1${extra.sql}${drop.sql}`, params: [...extra.params, ...drop.params] };
}

/**
 * Scope → 会话 id 列表（按创建时间排，保证 outline 输出稳定）。
 * session 模式直接回传 id：即使索引里还没有它，语义也不该被静默改写。
 */
export function resolveSessionIds(db, scope) {
  if (scope?.mode === 'session') return [String(scope.id)];
  // sources 是可选的额外收窄（CLI 的 --source）。它只影响**检索范围**，
  // 与「索引哪些源」是两件事，别混在一起。
  const sources = Array.isArray(scope?.sources) && scope.sources.length > 0 ? scope.sources : null;
  const excluded = Array.isArray(scope?.exclude) ? scope.exclude.filter((id) => typeof id === 'string' && id) : [];
  const sourceSql = sources ? ` AND source IN (${sources.map(() => '?').join(',')})` : '';
  const dropSql = excluded.length > 0 ? ` AND id NOT IN (${excluded.map(() => '?').join(',')})` : '';
  const filter = sourceSql + dropSql;
  const params = [...(sources ?? []), ...excluded];
  if (scope?.mode === 'project') {
    return db
      .prepare(`SELECT id FROM sessions WHERE cwd = ?${filter} ORDER BY created_at, id`)
      .all(String(scope.cwd ?? ''), ...params)
      .map((row) => row.id);
  }
  return db
    .prepare(`SELECT id FROM sessions WHERE 1 = 1${filter} ORDER BY created_at, id`)
    .all(...params)
    .map((row) => row.id);
}

/**
 * 检索会话文档。
 * @returns {{total: number, hits: Array<object>}} total 是过滤后的命中总数（不受 limit 限制）
 */
/**
 * 区域名 → 索引里的 kind 集合。
 *
 * 为什么需要这一层：agent 脑子里的分区是「系统提示词 / 工具输出 / 我的思考」，
 * 而索引里的分区是 `tool-call` `tool-result` `reasoning` …… 直接暴露后者的话，
 * 调用方还得先知道我们有几个 kind（那是实现细节）。
 *
 * 一个区域可以对应多个 kind（`tool` = 调用 + 输出），反过来也允许直接写 kind 名。
 */
const REGION_KINDS = {
  tool: ['tool-call', 'tool-result'],
  reasoning: ['reasoning'],
  assistant: ['assistant'],
  user: ['user'],
  title: ['title'],
  system: ['other'],
  compaction: ['compaction'],
};

/** 所有可被排除的区域/kind（去重后），用于报错时的提示。 */
const KNOWN_REGIONS = [...new Set([...Object.keys(REGION_KINDS), ...Object.values(REGION_KINDS).flat()])];

/**
 * 把 `exclude: 'tool,reasoning'` 解析成 kind 列表。
 * 认不出来的一律报错 —— 静默忽略会让人以为"排除了"却没排除，比报错危险得多。
 */
export function resolveExclude(exclude) {
  if (exclude === undefined || exclude === null || exclude === '') return [];
  // 接受数组（MCP，schema 里能带 enum 提示）和逗号字符串（CLI，省 shell 引号）。
  // 两种形式都要，不是冗余：CLI 里 `--exclude tool,reasoning` 比
  // `--exclude tool --exclude reasoning` 短，而工具调用里数组能被 schema 校验。
  // 两种来源都要照顾：
  //   MCP 给数组 `['tool','reasoning']`；
  //   CLI 给数组 `['tool,reasoning']`（重复 flag 累加的结果，每项可能还是逗号串）。
  // 所以数组的每一项**再拆一次逗号**，否则 `--exclude tool,reasoning` 会把整串
  // 当成一个区域名，然后报"未知的排除区域 tool,reasoning"。
  const items = (Array.isArray(exclude) ? exclude : [exclude])
    .flatMap((item) => String(item ?? '').split(','))
    .map((item) => item.trim());
  const kinds = new Set();
  for (const item of items) {
    const key = String(item ?? '').trim().toLowerCase();
    if (!key) continue;
    const mapped = REGION_KINDS[key];
    if (mapped !== undefined) {
      for (const kind of mapped) kinds.add(kind);
      continue;
    }
    if (KNOWN_REGIONS.includes(key)) {
      kinds.add(key);
      continue;
    }
    throw new Error(`未知的排除区域 "${item}"，可选：${KNOWN_REGIONS.join(', ')}`);
  }
  return [...kinds];
}

export function search(
  db,
  {
    query,
    scope,
    limit = 10,
    includeReasoning = true,
    surface = 'all',
    dedupe = true,
    // **默认关**。默认行为 == 字面语义：每条命中都真的包含你输入的词。
    //
    // 为什么：agent 把 cfind 当 grep 用。一旦默认放宽，`完全不存在zzzqq` 这类
    // 查询也会通过"省略一个"返回十几条 —— 实测过。agent 无法分辨"真命中"与
    // "被放宽后的近似命中"，会据此得出错误结论；而返回 0 时它会自己改写查询，
    // 这个恢复回路本来就很可靠。**假阳性的代价远高于假阴性。**
    //
    // 想放宽就显式开 `fuzzy: true`（CLI `--fuzzy`），它会连带启用同义扩展，
    // 并在 stderr 报告每一步放宽（`synonym→…` / `spelling→…` / …）。
    fuzzy = false,
    context = 0,
    exclude,
    // **默认关**。同义扩展是语义替换：返回的文本里根本没有用户输入的那些词。
    // 一个把 cfind 当 grep 用的 agent 会因此误判"这份记录提到了 X"，
    // 而实际只是提到了 X 的同义词。grep 从不做这件事，我们默认也不做。
    // 需要"换说法也能搜到"时显式打开（CLI `--synonym`）。
    synonym = false,
  } = {},
) {
  const text = String(query ?? '').trim();
  const max = Math.max(1, Number.isInteger(limit) ? limit : 10);
  if (!text) return { total: 0, hits: [] };

  const scopePart = scopeFilter(scope);
  const filters = [scopePart.sql];
  const filterParams = [...scopePart.params];
  if (!includeReasoning) filters.push("docs.kind <> 'reasoning'");
  // 区域排除：`exclude: 'tool,reasoning'`。拼成 NOT IN 而不是逐个 <>，
  // 少一层括号嵌套，也便于和 includeReasoning 叠加。
  const excludedKinds = resolveExclude(exclude);
  if (excludedKinds.length > 0) {
    filters.push(`docs.kind NOT IN (${excludedKinds.map(() => '?').join(',')})`);
    filterParams.push(...excludedKinds);
  }
  if (surface === 'current' || surface === 'shadowed') {
    filters.push('docs.surface = ?');
    filterParams.push(surface);
  }
  const where = filters.join(' AND ');

  // ── 默认路径：grep 语义（pattern 是正则，子串匹配）────────────────────
  //
  // 工具叫「会话历史的 grep」，agent 就会按 grep 的预期写 pattern。
  // 关键词索引把 `foo|bar` 当成 `foo AND bar`，与预期相反且不会报错 ——
  // 这种"静默地做了别的事"是最坏的一种行为。
  //
  // `--fuzzy` 才走下面的索引级联：那是有意的"猜你想要"，不是默认语义。
  if (!fuzzy && !synonym) {
    const found = grepSearch(db, text, { where, params: filterParams, max });
    let out = { total: found.total, hits: found.hits };
    if (dedupe) out = collapseDuplicates(out);
    if (Number.isInteger(context) && context !== 0) {
      out = withContext(db, out, { context, query: text });
    }
    return out;
  }

  const wanted = buildMatchQuery(text);

  let result;
  if (wanted.like !== undefined) {
    result = searchLike(db, text, wanted.like, where, filterParams, max);
  } else {
    try {
      result = searchMatch(db, text, wanted.match, where, filterParams, max);
    } catch {
      // 查询串含 FTS5 语法元字符（如 `:`）时 MATCH 会抛错：退化为 LIKE，保证命令不炸。
      result = searchLike(db, text, text, where, filterParams, max);
    }
  }

  // 精确匹配挂了、且调用方**显式要求**才升级放宽级联：
  // 既不让纠错污染本来有答案的查询，也不让默认行为偏离字面语义。
  if ((fuzzy || synonym) && result.total === 0) {
    const loose = fuzzySearch(db, text, { where, filterParams, max, synonym });
    if (loose !== null) result = loose;
  }

  if (dedupe) result = collapseDuplicates(result);
  // `context > 0` = grep -C：给每条命中带上它周围的事件窗口。
  // 这就是「少一个工具」的来源 —— 不需要单独的 show，查询词本来就在手上，
  // 窗口还能自动以它为中心（show 得靠调用方再传一次 --find）。
  if (Number.isInteger(context) && context >= 0 && context !== 0) {
    result = withContext(db, result, { context, query: text });
  }
  return result;
}

/**
 * 给每条命中附带相邻事件窗口（grep -C 的动作）。
 *
 * 按会话分组后再读文件：10 条命中常常落在同 1–2 个会话里，
 * 逐个 readAll 会把整文件解 10 遍（每条几毫秒）。
 */
function withContext(db, result, { context, query }) {
  const loader = sessionLoader(db);
  const hits = result.hits.map((hit) => {
    const window = windowOf(loader.get(hit.sessionId), hit.seq, {
      before: context,
      after: context,
      hint: query,
    });
    // 取不到窗口（文件被删、会话被清）时保持原命中：宁可少给上下文，
    // 也不要悄悄把这条命中从结果里删掉 —— 那会让 total 与实际不符。
    return window === null ? hit : { ...hit, events: window.events };
  });
  return { ...result, hits };
}

/**
 * 折叠近似重复命中。
 *
 * 会话里同一条内容经常存两遍（工具输出既进 tool-result 又进 reasoning 回显；
 * Codex 的 assistant 文本会同时出现在 response_item 和 task_complete）。
 * 实测重复率 0–20%，limit 越大越浪费 agent 的上下文。
 *
 * 判据：**同会话 + 去噪指纹相同**。只按前 100 字符算指纹 —— 完整比对会让
 * 「同一句话后面各接不同代码块」被误合并，那两条对用户是不同的信息。
 * total 保持原始命中数不变，折叠条数记在 collapsed 里，绝不静默丢数据。
 */
function collapseDuplicates(result) {
  const seen = new Set();
  const kept = [];
  let collapsed = 0;
  for (const hit of result.hits) {
    const key = `${hit.sessionId}\u0000${fingerprint(hit.snippet)}`;
    if (seen.has(key)) {
      collapsed += 1;
      continue;
    }
    seen.add(key);
    kept.push(hit);
  }
  if (collapsed === 0) return result;
  return { ...result, hits: kept, collapsed };
}

/**
 * 模糊级联：精确匹配 0 命中时才启动，逐级放宽，**第一级有结果就停**。
 *
 * 为什么按这个顺序（而不是一次全放宽）：
 *   ① 前缀 `settle*`  —— 用户只记得词头。命中即最可能是想要的，且不会引入错词。
 *   ② 纠错           —— 拼错一个字母/换位。代价最高（要扫词表），但最贴近真实意图。
 *   ③ CJK 容错       —— 中文按 bigram OR 放宽，救「尾字写错」。
 *   ④ OR 放宽        —— 多词查询里有一个词错了。最松，只在前面都失败时才用。
 * 顺序反了会让「本可精确前缀命中的查询」被纠错拉偏成不相干结果。
 *
 * 返回 null 表示「放宽也没救」，调用方原样返回 0 命中 —— 绝不假装有结果。
 */
function fuzzySearch(db, text, { where, filterParams, max, synonym = false }) {
  const attempt = (match) => {
    try {
      return searchMatch(db, text, match, where, filterParams, max);
    } catch {
      // 放宽后的表达式仍可能触发 FTS5 语法错误：这一级视为失败，继续下一级。
      return null;
    }
  };

  // ① 前缀
  const prefix = buildPrefixQuery(text);
  if (prefix) {
    const hit = attempt(prefix);
    if (hit && hit.total > 0) return { ...hit, fuzzy: { what: 'prefix', applied: prefix } };
  }

  // ② 拼写纠错：只对拉丁词做（CJK 没有「拼写」概念，纠错会变成瞎猜）
  if (hasCorrectableLatin(text)) {
    const corrected = spellingFix(db, text);
    if (corrected !== null) {
      const wanted = buildMatchQuery(corrected.text);
      if (wanted.match !== undefined) {
        const hit = attempt(wanted.match);
        if (hit && hit.total > 0) {
          return { ...hit, fuzzy: { what: 'spelling', applied: corrected.applied.join(', ') } };
        }
      }
    }
  }

  // ②' 同义扩展（**默认关闭**，仅 `synonym: true` 时启用）：换说法也能搜到。
  //
  // **必须排在 cjk-loose / OR 放宽之前**，顺序就是精度排序：
  //   查表命中（同义词）> bigram OR（可能只对上半个词）> 整句 OR（最粗）
  //
  // 实测反例：`响应慢` 先走 cjk-loose 会被拆成 `"响应" OR "应慢"`，
  // 返回 27 条只含"响应"的无关命中 —— 正是"把无关词带上"。
  // 而它其实是 `超时` 的同义词，查表能精确对上 53 条真正讨论超时的文档。
  //
  // 三道护栏见 lib/synonyms.mjs：只在精确为 0 时触发、扩展词不得比原词常见、
  // 短语整体匹配。任何一条不满足就放弃这一级。
  if (synonym) {
    const hit = synonymSearch(db, text, { where, filterParams, max });
    if (hit !== null) return hit;
  }

  // ③ 「最多省略一个单元」——比 OR 严格得多的放宽。
  //
  // 为什么加它：OR 放宽的语义是"任一词命中即算"，`缓存加速` 会被放宽成
  // `"缓存" OR "存加" OR "加速"`，实测返回 83 条，多数只含「缓存」。
  // agent 把它当 grep 用会误判「这份记录在讲缓存加速」，而那只是顺带提了一句。
  //
  // 这里要求"三段里对上两段"，仍能救一个词写错的场景，但不会退化成单字匹配。
  for (const variant of buildDropOneQueries(text)) {
    const hit = attempt(variant.expr);
    if (hit && hit.total > 0) {
      return {
        ...hit,
        fuzzy: {
          what: variant.kind === 'bigram' ? 'cjk-loose' : 'loosened',
          applied: `${variant.expr}（省略「${variant.dropped}」）`,
        },
      };
    }
  }

  // ③' 单元数只有 2 时的 CJK 容错：中文没有拼写概念，纠错用不上；
  //     靠 bigram OR 让写错的尾字不至于全灭（`预研旧` → `"预研" OR "研旧"`）。
  //     这一级**只在很短的中文查询上**有意义：再长就能用上面的"省略一个"了。
  const cjkLoose = buildCjkLooseQuery(text);
  if (cjkLoose) {
    const hit = attempt(cjkLoose);
    if (hit && hit.total > 0) return { ...hit, fuzzy: { what: 'cjk-loose', applied: cjkLoose } };
  }

  // ④ OR 放宽：多词里有一个写错时，AND 语义会全灭，这里改成任一命中
  const loose = buildOrQuery(text);
  if (loose) {
    const hit = attempt(loose);
    if (hit && hit.total > 0) return { ...hit, fuzzy: { what: 'loosened', applied: loose } };
  }
  return null;
}

/**
 * 同义扩展检索：逐个查已通过护栏的同义词，把结果合并。
 *
 * 为什么**逐个查**而不是拼一条 OR：这样能记住"哪条命中来自哪个同义词"，
 * 报告成 `synonym→防止过载→限流`，用户一眼知道工具替他放宽了什么。
 * 拼 OR 就只剩一团命中，无法解释来源 —— 而"能解释为什么给你这些结果"
 * 正是这个工具与 grep 并存的前提。
 */
function synonymSearch(db, text, { where, filterParams, max }) {
  const { expansions } = expandSynonyms(db, text);
  if (expansions.length === 0) return null;

  const merged = [];
  const seen = new Set();
  const applied = [];
  let total = 0;
  for (const { term } of expansions) {
    const wanted = buildMatchQuery(term);
    if (wanted.match === undefined) continue;
    let hit;
    try {
      // 传 term 而不是原查询：snippet 里出现的是**同义词**，
      // 用原词做高亮兜底会对不上（FTS 自己给的 [ ] 不受影响，兜底会失效）。
      hit = searchMatch(db, term, wanted.match, where, filterParams, max);
    } catch {
      continue;
    }
    if (!hit || hit.total === 0) continue;
    applied.push(`${term}(${hit.total})`);
    total += hit.total;
    for (const each of hit.hits) {
      // 同一个事件可能同时被多个同义词命中，按 seq 去重（保留先到的）。
      const key = `${each.sessionId}\u0000${each.seq}\u0000${each.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(each);
    }
  }
  if (applied.length === 0) return null;

  return { total, hits: merged.slice(0, max), fuzzy: { what: 'synonym', applied: applied.join(', ') } };
}

/**
 * 按词表纠正拼写，返回纠正后的**整条查询文本**（而不是 MATCH 表达式）。
 * 这样能直接复用 buildMatchQuery，CJK bigram / 单字退化等既有语义一行都不用重写。
 */
function spellingFix(db, text) {
  const vocab = latinVocab(db);
  const known = vocab.set;
  const applied = [];
  let corrected = String(text);

  for (const token of tokenizeQuery(text)) {
    if (token.kind !== 'latin') continue;
    // FTS5 的 unicode61 把 `_` `.` `/` 等当分隔符，所以词表里是子词粒度
    // （`settlement_id` → `settlement` + `id`）。纠错必须按同样的粒度做。
    for (const sub of token.text.split(/[_.\-/@:+]+/).filter(Boolean)) {
      if (sub.length < 3 || known.has(sub.toLowerCase())) continue;
      const [best] = bestSuggestion(vocab, sub);
      if (best === undefined || best.toLowerCase() === sub.toLowerCase()) continue;
      corrected = corrected.replace(sub, best);
      applied.push(`${sub}→${best}`);
    }
  }
  return applied.length === 0 ? null : { text: corrected, applied };
}

/**
 * 取最接近的候选词，**先走首字母分桶，空了才扫全表**。
 *
 * 为什么分桶是安全的：编辑距离 ≤2 时，首字母只有在「错误发生在第 0 位」时才会变，
 * 属于少数情况。所以常规路径（桶内）覆盖绝大多数拼写错误；真的没找到时回退全表扫描，
 * **召回率不受影响**，只是那一类错误慢一次。全表扫 3.3 万词约 20ms，桶内约 1ms。
 */
function bestSuggestion(vocab, sub) {
  const maxDistance = sub.length >= 7 ? 2 : 1;
  const bucket = vocab.buckets.get(sub[0]?.toLowerCase());
  if (bucket !== undefined) {
    const [hit] = suggestTerms(bucket, sub, { maxDistance, limit: 1 });
    if (hit !== undefined) return [hit];
  }
  return suggestTerms(vocab.list, sub, { maxDistance, limit: 1 });
}

/**
 * 词表缓存。fts5vocab 扫一遍 3.3 万词约 100ms —— 放在一次 5ms 的 MCP 调用里不可接受。
 * 用 WeakMap 挂在 db 上，靠 store 的 contentVersion 失效：索引内容变了才重建。
 * 同时预建首字母分桶，把「常见拼写错误」的检索成本从 20ms 降到 1ms。
 */
const VOCAB_CACHE = new WeakMap();

function latinVocab(db) {
  const version = contentVersion();
  const cached = VOCAB_CACHE.get(db);
  if (cached !== undefined && cached.version === version) return cached;

  let terms = [];
  try {
    terms = db
      .prepare("SELECT DISTINCT term FROM docs_vocab WHERE col = 'body'")
      .all()
      .map((row) => String(row.term));
  } catch {
    // 老库还没建 docs_vocab（schema 自检会重建）：纠错临时不可用，别让搜索整体失败。
    terms = [];
  }
  const buckets = new Map();
  for (const term of terms) {
    const key = term[0]?.toLowerCase();
    if (key === undefined) continue;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [term]);
    else bucket.push(term);
  }
  const entry = { version, list: terms, set: new Set(terms.map((term) => term.toLowerCase())), buckets };
  VOCAB_CACHE.set(db, entry);
  return entry;
}

/** 指纹：去掉标记/空白/常见分隔符后取前 100 字符（同一段文字的排版差异不该影响判重）。 */
function fingerprint(snippet) {
  return String(snippet ?? '')
    .replace(/[\[\]…\s]+/g, '')
    .slice(0, 100);
}

/** FTS5 路径：取 4×limit 候选，JS 里乘 kind 权重后重排。 */
function searchMatch(db, text, match, where, filterParams, max) {
  const total = db
    .prepare(`SELECT count(*) AS n FROM docs WHERE docs MATCH ? AND ${where}`)
    .get(match, ...filterParams).n;

  const rows = db
    .prepare(
      `SELECT docs.session_id AS sessionId, docs.seq AS seq, docs.kind AS kind,
              docs.surface AS surface, docs.time AS time, bm25(docs) AS bm,
              snippet(docs, 0, '[', ']', '…', 24) AS snip,
              sessions.title AS title, sessions.cwd AS cwd
       FROM docs JOIN sessions ON sessions.id = docs.session_id
       WHERE docs MATCH ? AND ${where}
       ORDER BY bm25(docs)
       LIMIT ?`,
    )
    .all(match, ...filterParams, max * 4);

  const hits = rows.map((row, order) => ({
    sessionId: row.sessionId,
    short: shortId(row.sessionId),
    title: row.title ?? '',
    cwd: row.cwd ?? '',
    seq: row.seq,
    kind: row.kind,
    surface: row.surface,
    time: row.time,
    score: round3(-row.bm * (KIND_WEIGHTS[row.kind] ?? DEFAULT_KIND_WEIGHT)),
    snippet: tidySnippet(row.snip, text),
    order,
  }));
  hits.sort((a, b) => b.score - a.score || a.order - b.order);
  return { total, hits: hits.slice(0, max).map(stripOrder) };
}

/** LIKE 路径（单字 CJK 兜底）：没有 bm25，用 kind 权重当分数。 */
function searchLike(db, text, needle, where, filterParams, max) {
  const pattern = `%${escapeLike(needle)}%`;
  const total = db
    .prepare(`SELECT count(*) AS n FROM docs WHERE docs.body LIKE ? ESCAPE '\\' AND ${where}`)
    .get(pattern, ...filterParams).n;

  const rows = db
    .prepare(
      `SELECT docs.session_id AS sessionId, docs.seq AS seq, docs.kind AS kind,
              docs.surface AS surface, docs.time AS time, docs.body AS body,
              sessions.title AS title, sessions.cwd AS cwd
       FROM docs JOIN sessions ON sessions.id = docs.session_id
       WHERE docs.body LIKE ? ESCAPE '\\' AND ${where}
       ORDER BY ${KIND_ORDER}, docs.time DESC
       LIMIT ?`,
    )
    .all(pattern, ...filterParams, max * 4);

  const hits = rows.map((row, order) => ({
    sessionId: row.sessionId,
    short: shortId(row.sessionId),
    title: row.title ?? '',
    cwd: row.cwd ?? '',
    seq: row.seq,
    kind: row.kind,
    surface: row.surface,
    time: row.time,
    score: round3(KIND_WEIGHTS[row.kind] ?? DEFAULT_KIND_WEIGHT),
    snippet: tidySnippet(likeSnippet(row.body, needle), text),
    order,
  }));
  hits.sort((a, b) => b.score - a.score || a.order - b.order);
  return { total, hits: hits.slice(0, max).map(stripOrder) };
}

const stripOrder = ({ order, ...hit }) => hit;

/** snippet 压缩到 ≤240 字符；FTS5 对 CJK 命中常不给方括号（命中在 sh 列），补一次。 */
function tidySnippet(snippet, query) {
  let text = compress(snippet);
  if (!text.includes('[')) text = markToken(text, query);
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX - 1)}…` : text;
}

/** 在片段里给查询词补一层 [ ]，让 CJK 命中也有可读高亮。 */
function markToken(text, query) {
  const tokens = String(query ?? '').match(/[\u4e00-\u9fff]+|[A-Za-z0-9_.\-/@:+]+/g) ?? [];
  tokens.sort((a, b) => b.length - a.length);
  for (const token of tokens) {
    if (token.length < 2) continue;
    const at = text.toLowerCase().indexOf(token.toLowerCase());
    if (at >= 0) return `${text.slice(0, at)}[${text.slice(at, at + token.length)}]${text.slice(at + token.length)}`;
  }
  return text;
}

/** LIKE 路径的片段：手动截窗口并给命中词加括号。 */
function likeSnippet(body, needle) {
  const src = String(body ?? '');
  const at = src.toLowerCase().indexOf(String(needle).toLowerCase());
  if (at < 0) return compress(src).slice(0, SNIPPET_MAX);
  const from = Math.max(0, at - 90);
  const to = Math.min(src.length, at + needle.length + 90);
  const raw = src.slice(from, to);
  const rel = at - from;
  const marked = `${raw.slice(0, rel)}[${raw.slice(rel, rel + needle.length)}]${raw.slice(rel + needle.length)}`;
  return compress(`${from > 0 ? '…' : ''}${marked}${to < src.length ? '…' : ''}`);
}

/**
 * L3 原文窗口：只读原始文件重放，绝不从 docs 表拼正文。
 * 这样未入索引的事件（request/header 等）也能显示，只是默认跳过噪声邻居。
 */
/**
 * L3 原文窗口：只读原始文件重放，绝不从 docs 表拼正文。
 * 这样未入索引的事件（request/header 等）也能显示，只是默认跳过噪声邻居。
 *
 * 具体窗口逻辑在 lib/context.mjs —— 它同时服务 `show` 与 `search(context)`，
 * 两处必须给出完全一致的结果（否则管道里的 `:`/`-` 标记会对不上）。
 */
export function show(db, { sessionId, seq, before = 3, after = 3, find } = {}) {
  const id = String(sessionId ?? '');
  const session = sessionLoader(db).get(id);

  if (session) {
    const window = windowOf(session, seq, { before, after, hint: find });
    if (window !== null) {
      return { ...describeSession(session, id), target: window.target, events: window.events, archived: false };
    }
  }

  // 原始文件可能已经被工具删掉（Claude Code / Codex 都会定期清理旧会话）。
  // search 走索引所以照常工作，此时 `show` 必须也能只靠索引回答 ——
  // 否则会出现「搜得到、看不到」这种最让人困惑的状态。
  const fallback = windowFromIndex(db, id, seq, { before, after, hint: find });
  if (fallback === null) {
    if (!session) throw new Error(`session file not found（原始文件已删除，索引里也没有该事件）: ${id}`);
    throw new Error(`event seq not found: ${id}#${seq}`);
  }
  const meta = db.prepare('SELECT id, title, cwd FROM sessions WHERE id = ?').get(id) ?? null;
  const source = db.prepare('SELECT source FROM sessions WHERE id = ?').get(id)?.source ?? 'dsh';
  return {
    sessionId: id,
    short: shortId(id),
    title: meta?.title ?? '',
    cwd: meta?.cwd ?? '',
    source,
    target: fallback.target,
    events: fallback.events,
    // 明确标注：这是索引里的蒸馏副本，不是原始文件的逐字节重放。
    // 不标会让调用方以为读到的是原文（某些字段如 request/header 已在索引时略去）。
    archived: true,
  };
}

/** type → 契约规定的人类角色。 */
function roleOf(type) {
  const name = String(type ?? '');
  if (name === 'user/message' || name.startsWith('user/')) return 'user';
  if (name.startsWith('assistant/')) return 'assistant';
  if (name.startsWith('tool/')) return 'tool';
  if (name.startsWith('system/')) return 'system';
  return 'event';
}

/** 单行占位（tool 参数等），避免把巨型 JSON 塞进一行。 */
function oneLine(value, max = 160) {
  const text = compress(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 一个事件的正文：contentText 拿得到就用，拿不到给一行占位。 */
function eventText(ev) {
  const data = ev?.data ?? {};
  const type = String(ev?.type ?? '');
  if (type === 'user/message') return contentText(data.content) || '[user/message]';
  if (type === 'assistant/message') {
    return contentText(data.message?.content ?? data.content) || '[assistant/message]';
  }
  if (type === 'tool/call') {
    const args = oneLine(data.arguments);
    return `[tool/call ${data.name ?? 'unknown'}]${args ? ` ${args}` : ''}`;
  }
  if (type === 'tool/result') return contentText(data.message?.content) || '[tool/result]';
  if (type === 'compaction/summary') {
    return contentText(data.summary) || oneLine(data.rawOutput) || '[compaction/summary]';
  }
  if (type === 'session/title') return String(data.title ?? '') || '[session/title]';
  if (type === 'turn/end') return `[turn/end ${data.reason?.kind ?? 'completed'}]`;
  return (
    contentText(data.content ?? data.message?.content) ||
    (data.title ? String(data.title) : `[${type}]`)
  );
}

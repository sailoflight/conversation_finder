// lib/fuzzy.mjs — 查询侧的模糊匹配（纯函数，零 IO、零第三方依赖）
//
// 职责边界：
//   - CJK 的 bigram 切分**只有一份实现**，这里直接 import `bigrams` 复用；重复实现会导致
//     索引侧与查询侧的切分范围漂移，直接静默漏召回。
//   - 本模块只做「切 token / 编辑距离 / 候选词 / FTS5 表达式」的纯计算，
//     不碰 DB、不读文件，这样 query 层可以随意组合并单测。
import { bigrams } from './cjk.mjs';

// 与 lib/cjk.mjs 的 CJK_CHAR 保持同一范围（\u4e00-\u9fff）。
// 范围必须一致：索引侧按这个范围切 bigram，查询侧若换范围就对不上。
const CJK_CHAR = /[\u4e00-\u9fff]/;
const CJK_CHAR_ONE = /^[\u4e00-\u9fff]$/;
const CJK_RUN_G = /[\u4e00-\u9fff]+/g;

// 拉丁 token：允许 _ . - / @ : + 出现在标识符内部（如 settlement_id、lib/cjk.mjs、
// user@example.com、a:b）；首尾允许连接符，但整个 token 必须至少含一个字母/数字，
// 这样 `hello,` 末尾的逗号、`...` 这类纯标点会被自然忽略。
// 不用 \p{L}：项目里的标识符全是 ASCII，ASCII 范围也能避免把全角标点卷进来。
const CONNECTOR = '_.\\-/@:+';
const LATIN_TOKEN_SRC = `[${CONNECTOR}]*[A-Za-z0-9]+(?:[${CONNECTOR}]+[A-Za-z0-9]+)*`;
// 交替顺序：CJK 段优先；拉丁段不会匹配 CJK，二者互不重叠。
const TOKEN_G = new RegExp(`[\\u4e00-\\u9fff]+|${LATIN_TOKEN_SRC}`, 'g');

// FTS5 的裸 token 只放行字母/数字/下划线；- / @ : 等会被查询语法当成特殊字符
// （实测 `lib/cjk.mjs*` 直接报 syntax error，`foo-bar*` 报 no such column）。
// 这类 token 改用短语 + 尾部 *：`"lib/cjk.mjs"*`，既合法语义也基本不变。
const FTS_SAFE_TOKEN = /^[a-z0-9_]+$/;

/** 单字符 CJK 判定；锚定首尾，多字符串一律 false。 */
export function isCjkChar(ch) {
  return typeof ch === 'string' && CJK_CHAR_ONE.test(ch);
}

/**
 * 查询串 → token 列表（保序）。
 * CJK 连续段整体作为一个 token；拉丁标识符按上面的字符集聚合，标点当作分隔符丢弃。
 * @returns {Array<{kind: 'cjk'|'latin', text: string}>}
 */
export function tokenizeQuery(text) {
  const out = [];
  for (const [raw] of String(text ?? '').matchAll(TOKEN_G)) {
    out.push({ kind: CJK_CHAR.test(raw) ? 'cjk' : 'latin', text: raw });
  }
  return out;
}

/**
 * OSA（最优字符串对齐）距离：相邻字符换位只算 1 次编辑。
 * 与真的 Damerau-Levenshtein 的区别是「同一子串不重复编辑」，足够做拼写纠错；
 * 而且 OSA 的 DP 可以只用带内格子在 O(len * max) 内算完。
 *
 * 超过 max 时提前返回 max+1（不是真实距离）——调用方（suggestTerms）有几十万词要扫，
 * 必须能廉价地判定「已经超了」。返回 max+1 而非 max 是为了让 `> max` 的过滤稳定成立。
 *
 * 实现用「对角线带」而不是「行最小值提前退出」：OSA 不是度量、带换位的 DP 行最小值
 * 不保证单调，按行截断有算错风险；|i-j| > max 的格子则一定不在长度 ≤ max 的编辑路径上，
 * 把带外视作 INF 是严格安全的，且 max=1 时每行只算 3 格。
 *
 * @param {string} a
 * @param {string} b
 * @param {number} [max=Infinity]
 * @returns {number}
 */
export function osaDistance(a, b, max = Infinity) {
  const s = String(a ?? '');
  const t = String(b ?? '');
  if (s === t) return 0;

  const n = s.length;
  const m = t.length;
  const finite = Number.isFinite(max);
  const limit = finite ? Math.max(0, Math.floor(max)) : Infinity;

  // 空串：答案就是长度和；同样要遵守 max 语义。
  if (n === 0 || m === 0) {
    const d = n + m;
    return finite && d > limit ? limit + 1 : d;
  }
  // 每步编辑最多让长度差变化 1，差距超限直接判超。
  if (Math.abs(n - m) > limit) return limit + 1;

  const band = finite ? limit : Math.max(n, m);
  const INF = band + 1;
  // 三个一维数组轮换，避免每行分配；对几万词的热路径这点很重要。
  let prevPrev = new Int32Array(m + 1).fill(INF);
  let prev = new Int32Array(m + 1).fill(INF);
  let cur = new Int32Array(m + 1).fill(INF);
  for (let j = 0; j <= Math.min(m, band); j += 1) prev[j] = j;

  for (let i = 1; i <= n; i += 1) {
    cur.fill(INF);
    const lo = Math.max(1, i - band);
    const hi = Math.min(m, i + band);
    if (i <= band) cur[0] = i;
    for (let j = lo; j <= hi; j += 1) {
      const cost = s.charCodeAt(i - 1) === t.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      // 相邻换位：只有 a[i-1]==b[j-2] 且 a[i-2]==b[j-1] 时才来自 i-2/j-2。
      if (
        i > 1 &&
        j > 1 &&
        s.charCodeAt(i - 1) === t.charCodeAt(j - 2) &&
        s.charCodeAt(i - 2) === t.charCodeAt(j - 1)
      ) {
        v = Math.min(v, prevPrev[j - 2] + 1);
      }
      cur[j] = v;
    }
    // 轮换：prevPrev ← prev，prev ← cur，cur ← 旧 buffer。
    const spare = prevPrev;
    prevPrev = prev;
    prev = cur;
    cur = spare;
  }

  const d = prev[m];
  return finite && d > limit ? limit + 1 : d;
}

/**
 * 从词表里找最接近 term 的候选。
 * - 先按长度差筛（长度差 > maxDistance 的词不可能在阈值内），再算 OSA；
 * - 距离相同按词长升序、再按字典序，结果稳定可复现；
 * - term 少于 3 个字符直接放弃：2 字符的候选空间太大，纠错误报率极高。
 * - 大小写按小写比较（FTS 本身大小写不敏感，用户不会记得原词大小写），但返回词表原词。
 *
 * @param {readonly string[]} vocab
 * @param {string} term
 * @param {{maxDistance?: number, limit?: number}} [opts]
 * @returns {string[]}
 */
export function suggestTerms(vocab, term, opts = {}) {
  const needle = String(term ?? '').trim();
  if (needle.length < 3 || !Array.isArray(vocab) || vocab.length === 0) return [];

  // 非法配置回落到文档默认值，避免 NaN 把过滤条件全部放行。
  const rawMax = opts?.maxDistance;
  const maxDistance =
    rawMax === undefined || rawMax === null
      ? 1
      : rawMax === Infinity
        ? Infinity
        : Number.isInteger(rawMax) && rawMax >= 0
          ? rawMax
          : 1;
  const rawLimit = opts?.limit;
  const limit =
    rawLimit === undefined || rawLimit === null || rawLimit === Infinity
      ? rawLimit === Infinity
        ? Infinity
        : 3
      : Math.max(0, Math.floor(rawLimit));
  if (limit <= 0) return [];

  const lowerNeedle = needle.toLowerCase();
  const minLen = needle.length - maxDistance;
  const maxLen = needle.length + maxDistance;
  const seen = new Set();
  const hits = [];

  for (const word of vocab) {
    if (typeof word !== 'string') continue;
    // 先筛长度，再降级大小写和算距离：5 万词里绝大多数会死在这一行。
    if (word.length < minLen || word.length > maxLen) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    const d = osaDistance(lowerNeedle, word.toLowerCase(), maxDistance);
    if (d > maxDistance) continue;
    hits.push({ word, d });
  }

  hits.sort(
    (x, y) =>
      x.d - y.d ||
      x.word.length - y.word.length ||
      (x.word < y.word ? -1 : x.word > y.word ? 1 : 0),
  );
  return hits.slice(0, limit).map((hit) => hit.word);
}

/** CJK token → bigram 短语（与 buildMatchQuery 完全同构）；单字无法进 bigram 索引。 */
function cjkPart(token) {
  if (token.length < 2) return null;
  const grams = bigrams(token);
  return grams ? `"${grams}"` : null;
}

/** 拉丁 token → FTS5 词元；prefix=true 时加尾部 * 做前缀匹配。 */
function latinPart(token, prefix) {
  const lower = token.toLowerCase();
  // 不含危险语法字符时保持裸词，输出最贴近契约里的 'settlement_id*'；
  // 含 : - / @ 等时加双引号，否则 MATCH 阶段会抛语法错。
  const body = FTS_SAFE_TOKEN.test(lower) ? lower : `"${lower}"`;
  return prefix ? `${body}*` : body;
}

/**
 * 前缀查询：拉丁词加 `*`，CJK 段继续用 bigram 短语。
 * 任一 CJK token 是单字时返回 null：bigram 索引里没有单字，硬构造只会静默漏词，
 * 交给调用方退化到 LIKE 更诚实。
 * @returns {string|null}
 */
export function buildPrefixQuery(text) {
  const parts = [];
  for (const token of tokenizeQuery(text)) {
    if (token.kind === 'cjk') {
      const part = cjkPart(token.text);
      if (part === null) return null;
      parts.push(part);
    } else {
      parts.push(latinPart(token.text, true));
    }
  }
  return parts.length > 0 ? parts.join(' AND ') : null;
}

/**
 * OR 放宽：所有 token 用 OR 连接，用于「多词查询里只有一个词写错」。
 * 单字 CJK 无法用 bigram 表示：若还有其他 token 就跳过它（OR 本就是放宽），
 * 若整条查询只剩单字则返回 null（与契约一致）。
 * @returns {string|null}
 */
export function buildOrQuery(text) {
  const parts = [];
  for (const token of tokenizeQuery(text)) {
    if (token.kind === 'cjk') {
      const part = cjkPart(token.text);
      if (part !== null) parts.push(part);
    } else {
      parts.push(latinPart(token.text, false));
    }
  }
  return parts.length > 0 ? parts.join(' OR ') : null;
}

/**
 * CJK 容错查询：把一条**纯 CJK 词**的 bigram 用 OR 连起来。
 *
 * 为什么需要它：bigram 短语（`"预研 研旧"`）要求**所有** bigram 同时命中，
 * 所以只要有一个字写错，整条查询就归零。而中文没有「拼写」，
 * `suggestTerms` 那套编辑距离纠错对 CJK 根本用不上 —— 结果就是
 * 「模糊搜索对中文等于没有」。实测正是如此（`预研旧` 原本 0 命中）。
 *
 * 覆盖的场景：末尾字写错/多字少字（`预研旧` → `"预研" OR "研旧"`，
 * 靠活下来的前缀 bigram 命中）。**不覆盖**中间字写错：那样两个 bigram 都脏，
 * 谁也救不了，硬救只能退化到单字匹配，噪音不可接受。
 *
 * 三重限制，都是为了不被噪音淹掉：
 *   1. 只处理**单个 CJK token**（FTS5 没有括号分组，多 token 没法表达
 *      「词内 OR、词间 AND」的语义）；
 *   2. bigram 数 2–3（即 3–4 个字）：共享一个 bigram 才算有意义的证据；
 *      再长就必须所有 bigram 命中，否则等于放弃精确性；
 *   3. bigram 数 1（2 个字）时不生成 —— 那和精确查询完全一样，白跑一次。
 * @returns {string|null}
 */
export function buildCjkLooseQuery(text) {
  const tokens = tokenizeQuery(text);
  if (tokens.length !== 1 || tokens[0].kind !== 'cjk') return null;
  const grams = bigrams(tokens[0].text).split(' ').filter(Boolean);
  if (grams.length < 2 || grams.length > 3) return null;
  return grams.map((gram) => `"${gram}"`).join(' OR ');
}

/** 查询里所有 CJK 单字（去重、保序），供 char 级 LIKE 兜底。 */
export function cjkChars(text) {
  const seen = new Set();
  const out = [];
  for (const ch of String(text ?? '')) {
    if (!CJK_CHAR.test(ch) || seen.has(ch)) continue;
    seen.add(ch);
    out.push(ch);
  }
  return out;
}

/** 是否含有可做纠错的拉丁词（长度 ≥ 3；长度 2 的纠错候选爆炸，不做）。 */
export function hasCorrectableLatin(text) {
  return tokenizeQuery(text).some(
    (token) => token.kind === 'latin' && token.text.length >= 3,
  );
}


/**
 * 「最多省略一个单元」的放宽查询（比 OR 严格得多）。
 *
 * 为什么需要：OR 放宽的语义是「任一词命中即算」，一个 3 段的查询会退化到
 * 只要 1 段对上就返回 —— 实测 `缓存加速` 被放宽成 `"缓存" OR "存加" OR "加速"`
 * 后返回 83 条，其中多数只含「缓存」一个词。agent 把它当 grep 用就会误判
 * 「这份记录在讲缓存加速」，而那只是顺带提到了缓存。
 *
 * 这里改成：**保留其余全部单元，只允许缺一个**。
 *   `缓存加速` → `"缓存 存加"` / `"缓存 加速"` / `"存加 加速"`
 * 三段里必须对上两段，仍然能救「一个词写错」的场景，但不会退化成单字匹配。
 *
 * 单元的定义：
 *   - CJK 连续段 → 每个 bigram 是一个单元（保留短语邻接语义，不是拆成 OR）；
 *   - 拉丁标识符 → 整个 token 是一个单元。
 *
 * 只有在单元数 ≥ 3 时才产生候选。单元数为 2 时「省略一个」等于「任一命中」，
 * 那是另一种放宽（由 caller 里的旧级联负责，且只在很短的中文查询上启用）。
 *
 * @returns {Array<{expr: string, dropped: string, kind: 'bigram'|'token'}>} 按"丢掉越靠后越优先"排序
 */
export function buildDropOneQueries(text) {
  const source = String(text ?? '').trim();
  if (!source) return [];
  const tokens = tokenizeQuery(source);
  if (tokens.length === 0) return [];

  // 单条 CJK 段（最常见：中文短语没有被空格切开）
  if (tokens.length === 1 && tokens[0].kind === 'cjk') {
    const chars = tokens[0].text;
    if (chars.length < 4) return []; // bigram 数 < 3，交给短查询那条路
    const grams = [];
    for (let i = 0; i < chars.length - 1; i += 1) grams.push(chars.slice(i, i + 2));
    if (grams.length < 3) return [];
    const variants = [];
    for (let drop = 0; drop < grams.length; drop += 1) {
      const kept = grams.filter((_, index) => index !== drop);
      // 必须保留连续两段以上，否则短语约束名存实亡。
      if (kept.length < 2) continue;
      variants.push({ expr: `"${kept.join(' ')}"`, dropped: grams[drop], kind: 'bigram' });
    }
    return variants;
  }

  // 多 token 查询：整 token 级别的省略，要求 ≥3 个 token
  if (tokens.length < 3) return [];
  const parts = tokens.map((token) => {
    if (token.kind === 'cjk') {
      return `"${bigramsOf(token.text).join(' ')}"`;
    }
    return latinToken(token.text);
  });
  const variants = [];
  for (let drop = 0; drop < tokens.length; drop += 1) {
    const kept = parts.filter((_, index) => index !== drop);
    if (kept.length < 2) continue;
    variants.push({ expr: kept.join(' AND '), dropped: tokens[drop].text, kind: 'token' });
  }
  return variants;
}

/** CJK 段的 bigram 列表（与索引侧同一切分，见 lib/cjk.mjs）。 */
function bigramsOf(text) {
  const out = [];
  for (let i = 0; i < text.length - 1; i += 1) out.push(text.slice(i, i + 2));
  return out;
}

/** 单个拉丁 token → FTS 安全表达式（与 buildMatchQuery 内部同规则）。 */
function latinToken(text) {
  const raw = String(text);
  return FTS_SAFE_TOKEN.test(raw.toLowerCase()) ? `${raw.toLowerCase()}*` : `"${raw}"*`;
}

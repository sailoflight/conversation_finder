// lib/synonyms.mjs — 换说法也能搜到（**保守**的查询侧同义扩展）
//
// ## 为什么 grep 不需要这个
//
// grep 不做同义词扩展 —— 它就是个字面/正则匹配器，你写什么就匹配什么。
// 正因为它从不"体贴"用户，所以它也从不产出「我以为搜的是 A，结果给我 B」。
// 换句话说：grep 不是解决了这个问题，而是**根本不去碰它**。
//
// 我们一旦开始扩展，就自动承担了 grep 没有的风险。所以这里的原则是
// **每一步都必须证明自己不会带来噪音**，而不是"扩展得越多越智能"。
//
// ## 三道护栏（都是可量化的，不是凭感觉）
//
// 1. **只在精确匹配为 0 时才扩展**（级联的最后一级之前）。
//    已经能搜到东西的查询，行为与 grep 完全一致 —— 扩展不可能污染它。
//
// 2. **扩展词不能比原词更常见**（文档频率比 ≤ 1）。
//    这是核心护栏，直接来自实测：同一份语料上，
//      好同义词：等待太久 0.0x、防止过载 0.1x、自我调用 0.0x、加速 0.1x
//      坏扩展  ：调用 6.8x、重复 2.4x、同时 4.0x
//    为什么"调用/同时"是坏扩展：它们是高频通用词，会把整个语料拉进来。
//    而"等待太久"只在真的讨论超时时出现 —— 频率本身就是精度的代理。
//    **所以不需要手写"无关词黑名单"，用频率自动判定。**
//
// 3. **短语整体匹配**，不是拆词 OR。`等待太久` 走 buildMatchQuery 得到
//    `"等待 待太 太久"` 短语，要求 bigram 连续命中；拆成 `等待 OR 太久`
//    会命中所有"等待"和所有"太久"，那正是"无关介词被带上"的那条路。
//
// ## 刻意不做的事
//
// - **不做跨语言**（超时↔timeout）。实测 cross-language 全部 >3x
//   （timeout 3.6x、cache 3.1x、error 3.0x），会被护栏 2 全部拒绝 ——
//   而且它们不是"同义词"，是"翻译"，噪音特征完全不同，不该混进来。
// - **不做自动挖掘**（同现统计找候选）。同现很容易把"和/与/因为"这类
//   句法邻居挖成"同义词"。手写一张小而准的表 + 频率护栏，精度可控得多。
import { buildMatchQuery } from './cjk.mjs';

/**
 * 同义词组。组内任意两个成员互为同义。
 *
 * 收录标准（三条都要满足）：
 *   1. 真的同义，不是"相关"（相关是 embedding 的活，不是查表的活）；
 *   2. 至少一个是用户真的会输入的**规范词**；
 *   3. 能在真实语料上找到它救回命中的例子（`tests/synonyms.test.mjs` 锁住）。
 *
 * 不追求覆盖率。表越长，噪声面越大；宁可漏，不可错。
 *
 * **一个词只能出现在一组里**（`tests/synonyms.test.mjs` 会强制检查）。
 * 出现在两组会产生错误的传递性：`校验≈验证` 且 `校验≈测试`，
 * 于是「测试」会等价于「验证」—— 而它们根本不是一回事。
 *
 * **不收跨语言**（超时↔timeout、压缩↔compact）。它们是"翻译"不是"同义词"，
 * 噪声特征不同：翻译对几乎总是双向高频（实测 timeout 3.6x、cache 3.1x、error 3.0x），
 * 混进来会系统性地把频率护栏撑松。要跨语言该靠 embedding，不是查表。
 */
export const SYNONYM_GROUPS = [
  ['超时', '等待太久', '响应慢'],
  ['限流', '频率限制', '防止过载'],
  ['递归', '自我调用', '自调用'],
  ['去重', '避免重复', '排重'],
  ['报错', '出问题', '异常'],
  ['回滚', '撤销部署'],
  ['部署', '上线'],
  ['缓存', '暂存'],
  ['并发', '并行'],
  ['性能', '速度'],
  ['校验', '验证'],
  ['配置', '设置'],
  ['权限', '授权'],
];

/**
 * 纯功能词（虚词）。扩展里**一个内容词都没有**时视为噪声，直接拒绝。
 *
 * 这不是"无关词黑名单"——它只拦"整个扩展词都是虚词"这种退化情况
 * （比如有人把 `是因为` 当同义词）。高频的通用**实词**（调用/同时）
 * 由文档频率护栏拒绝，那个更可靠。
 */
const PARTICLES = new Set([
  '的', '了', '在', '和', '与', '及', '或', '是', '有', '个', '这', '那', '就', '都', '也',
  '很', '太', '不', '没', '我', '你', '他', '它', '们', '一', '上', '下', '中', '里', '到',
  '去', '来', '说', '会', '能', '要', '可', '以', '因', '为', '所', '但', '如', '果', '吧',
  '呢', '吗', '啊', '呀', '着', '过', '把', '被', '让', '给', '对', '从', '向', '而', '且',
  '并', '却', '只', '再', '又', '还', '更', '最', '想', '做', '用', '好', '多少', '什么',
  '怎么', '这个', '那个', '一个', '可以', '因为', '所以', '但是', '如果',
]);

/** 一个扩展词里至少要有这么多"内容字符"，否则视为噪声。 */
const MIN_CONTENT_CHARS = 2;

/** 单次扩展最多接受几个同义词（限制成本与噪声面）。 */
export const MAX_EXPANSIONS = 3;

/**
 * 语料里查不到原词时的绝对上限：扩展词不得出现在超过 10% 的文档里。
 *
 * 为什么这个情形要放宽到 10%（而 base>0 时是严格的"不得超过原词"）：
 * 原词在语料里出现 0 次，说明用户用的说法没人用过，我们没有任何基线 ——
 * 此时唯一可依赖的是**这张表本身是人工精选的**，所以允许它去找规范词。
 * 实测 `排重`（0 次）应当能找到 `去重`（133 次 = 2.1%）；
 * 而 base>0 的那些通用词（并行 52 > 并发 30）仍会被比例护栏挡住。
 */
const ABSOLUTE_MAX_DOC_RATIO = 0.1;

/**
 * 小语料地板：绝对文档数不超过这个值时，允许扩展词超过原词频率。
 *
 * 为什么需要：频率比是**统计**判据。文档数只有 1–3 时，差一条就会让比值翻倍，
 * 那种差异是噪声不是信号。实测在小语料上：
 *   `响应慢`(1) → `超时`(2) 被 "2 > 1" 拒掉
 *   `自我调用`(0) → `递归`(3) 被 "3 > 18×10%" 拒掉
 * 两个都是想要的规范词，却被统计噪声挡住 —— 结果级联一路掉到 OR 放宽，
 * 返回**无关概念**的命中（正是"把无关词带上"那条路）。
 *
 * 地板只在小数字范围内放宽，真实语料（数千文档）不受影响：
 * `并行`(52) 对 `并发`(30) 依然被拒。
 */
const SMALL_CORPUS_FLOOR = 5;

/**
 * 词 → **短语**文档频率（含整条短语的文档数）。
 *
 * 为什么必须是"短语"而不是子串近似：早先我用 bigram 取 max 近似，
 * 结果把 `自调用` 判成 229（因为它的 bigram `调用` 单独出现 229 次），
 * 于是把「递归 ↔ 自调用」当噪声拒了 —— 而它的真实短语频率是 0/1。
 * 近似方向虽然保守（多拒），但会把正确的同义词也一起拒掉，等于白做。
 *
 * 按 buildMatchQuery 拼成 FTS 短语（`"自调 调用"`）去 COUNT，拿到的才是
 * 「真的讨论这个概念」的文档数。单个候选词一次 COUNT，而这条路只在
 * 精确匹配为 0 时才走，调用次数是常数级。
 */
function docFrequency(db, term, cache) {
  const text = String(term ?? '').trim();
  if (!text) return 0;
  const key = text.toLowerCase();
  if (cache?.has(key)) return cache.get(key);

  let count = 0;
  try {
    const wanted = buildMatchQuery(text);
    if (wanted.match !== undefined) {
      count = Number(db.prepare('SELECT count(*) AS c FROM docs WHERE docs MATCH ?').get(wanted.match)?.c ?? 0);
    } else if (wanted.like !== undefined) {
      // 单字 CJK：bigram 不成立，只能 LIKE，与主检索路径的兜底一致。
      count = Number(
        db.prepare(`SELECT count(*) AS c FROM docs WHERE docs.body LIKE ? ESCAPE '\\'`).get(`%${wanted.like}%`)?.c ?? 0,
      );
    }
  } catch {
    // 查询语法异常（极端输入）视为"查不到"，宁可少扩展。
    count = 0;
  }
  cache?.set(key, count);
  return count;
}

/** 是否含至少一个内容字符（非虚词的中文字、或字母数字）。 */
function hasContent(text) {
  const source = String(text ?? '');
  for (const ch of source) {
    if (/[A-Za-z0-9]/.test(ch)) return true;
    if (/[\u4e00-\u9fff]/.test(ch) && !PARTICLES.has(ch)) return true;
  }
  // 整词是虚词表里的多字虚词（如"可以""因为"）
  if (PARTICLES.has(source)) return false;
  return [...source].filter((ch) => /[\u4e00-\u9fff]/.test(ch)).length >= MIN_CONTENT_CHARS;
}

/** 查表：给定查询文本，返回同组的其它成员（不含自己）。 */
export function lookupSynonyms(text) {
  const wanted = String(text ?? '').trim().toLowerCase();
  if (!wanted) return [];
  const out = [];
  for (const group of SYNONYM_GROUPS) {
    const normalized = group.map((term) => term.toLowerCase());
    if (!normalized.includes(wanted)) continue;
    for (const term of group) {
      if (term.toLowerCase() !== wanted) out.push(term);
    }
  }
  return out;
}

/**
 * 按护栏筛选可用扩展。
 *
 * @param {object} db
 * @param {string} text 用户查询原文
 * @param {{max?: number}} [opts]
 * @returns {{expansions: Array<{term: string, doc: number}>, rejected: Array<{term: string, why: string, doc: number}>}}
 */
export function expandSynonyms(db, text, { max = MAX_EXPANSIONS } = {}) {
  const candidates = lookupSynonyms(text);
  if (candidates.length === 0) return { expansions: [], rejected: [] };

  const corpus = Number(db.prepare('SELECT count(*) AS c FROM docs').get()?.c ?? 0);
  if (corpus === 0) return { expansions: [], rejected: [] };
  const cache = new Map();
  const base = docFrequency(db, text, cache);

  const expansions = [];
  const rejected = [];
  for (const term of candidates) {
    if (!hasContent(term)) {
      rejected.push({ term, why: '只有虚词', doc: 0 });
      continue;
    }
    const doc = docFrequency(db, term, cache);
    // 语料里根本不存在的扩展词救不了任何东西，只会让报告更长。
    if (doc === 0) {
      rejected.push({ term, why: '语料里不存在', doc });
      continue;
    }
    // 核心护栏：扩展词不能比原词更常见。
    // 原词频率为 0 时没有基线，改用"不得超过语料 2%"的绝对上限。
    if (base > 0) {
      // 严格比例，但给小语料留一个绝对数地板（见 SMALL_CORPUS_FLOOR）。
      if (doc > Math.max(base, SMALL_CORPUS_FLOOR)) {
        rejected.push({ term, why: `太常见（${doc} > ${base}）`, doc });
        continue;
      }
    } else {
      // 原词在语料里 0 次：没有基线，只能用绝对上限。
      // 同样带地板 —— 小语料上 10% 可能连 1 都不到（18 篇 × 10% = 1），
      // 那样连正确的规范词都会被拒（实测 `自我调用` → `递归` 就是这样被挡的）。
      const cap = Math.max(corpus * ABSOLUTE_MAX_DOC_RATIO, SMALL_CORPUS_FLOOR);
      if (doc > cap) {
        rejected.push({ term, why: `太常见（${doc} > ${Math.floor(cap)}）`, doc });
        continue;
      }
    }
    expansions.push({ term, doc });
  }

  // 越"稀有"越精确：按文档频率升序取前 max 个。
  expansions.sort((a, b) => a.doc - b.doc);
  return { expansions: expansions.slice(0, max), rejected };
}

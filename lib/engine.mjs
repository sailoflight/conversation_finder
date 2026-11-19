// lib/engine.mjs — 检索引擎的选择层
//
// 语义由 pattern 决定（grep 正则），**引擎只影响速度，不影响结果**。
// 这是这个模块存在的唯一理由：语料是数百 MB 级别时，全表扫会从 20ms 涨到 1s 以上，
// 而语义绝不能因此改变 —— 所以索引只能用来**缩小候选集**，最终判定永远由正则做。
//
// 三条候选通路，按 pattern 形态自动选：
//
//   ① trigram 索引（docs_tri，≥3 字符）—— 实测选择性 pattern 快 53–134 倍
//   ② CJK bigram 索引（docs.sh，≥2 字中文）—— 实测快 40–60 倍，且**结果与全扫完全一致**
//   ③ 全表扫 —— 兜底，任何 pattern 都能算，稠密命中时反而最快
//
// 「索引 + 验证」而不是「索引直接给结果」：
//   trigram/bigram 都是近似候选（trigram 给的候选一定是超集，bigram 对 2 字词是精确的，
//   但 3+ 字的中文短语经 bigram 短语匹配也可能有边界差异）。
//   所以候选行必须再用真正的正则验一遍 —— 这样**任何引擎选择都不会改变输出**，
//   只有快慢的区别。这一点由 tests/engine.test.mjs 逐条比对锁定。
import { needsRegexEngine, literalAlternatives } from './grep.mjs';

/** 候选集超过这个规模就放弃索引：验证成本已经接近全表扫，不值得。
 *  140MB 语料实测：2 万候选（2%）索引仍快 3.4x，但到 20% 命中就只剩 1.1x，
 *  所以阈值取 4000 —— 那大约是"能靠索引省下时间"的上限。 */
const MAX_CANDIDATES = 4000;

/** trigram 索引只对 ≥3 字符的 pattern 有效（3 字窗口）。 */
const TRIGRAM_MIN = 3;

/** CJK bigram 索引要求 ≥2 个汉字。 */
const CJK_MIN = 2;

const CJK_ONLY = /^[\u4e00-\u9fff]+$/;

/** 索引是否可用（老库可能还没建）。 */
export function hasTrigramIndex(db) {
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE name = 'docs_tri'").get() !== undefined;
  } catch {
    return false;
  }
}

/**
 * 为一条**字面**（无正则元字符）挑候选通路。
 *
 * @returns {{engine: 'trigram'|'bigram'|null, sql: string|null, param: string|null}}
 *   engine=null 表示这条字面无法用索引，必须扫。
 */
export function planLiteral(db, literal) {
  const text = String(literal ?? '');
  if (text.length === 0) return { engine: null, sql: null, param: null };

  // 中文 2 字（trigram 覆盖不到）→ 走已有的 bigram 列。
  // 用 FTS5 短语匹配：`"缓存"` 要求 sh 列里出现该 bigram，等价于"正文含这两个连续汉字"。
  if (CJK_ONLY.test(text) && text.length >= CJK_MIN && text.length < TRIGRAM_MIN) {
    const grams = [];
    for (let i = 0; i < text.length - 1; i += 1) grams.push(text.slice(i, i + 2));
    // 完整的子查询，而不是可替换的片段 —— 拼接字符串的写法太脆（早先试过 replace）。
    return { engine: 'bigram', sql: 'SELECT rowid FROM docs WHERE docs MATCH ?', param: `"${grams.join(' ')}"` };
  }

  // ≥3 字符：trigram 索引能覆盖任意脚本（中文 3 字也在内）。
  if (text.length >= TRIGRAM_MIN && hasTrigramIndex(db)) {
    return {
      engine: 'trigram',
      sql: "SELECT rowid FROM docs_tri WHERE body LIKE ? ESCAPE '\\'",
      param: `%${escapeLike(text)}%`,
    };
  }

  return { engine: null, sql: null, param: null };
}

const escapeLike = (text) => String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`);

/**
 * 用索引捞候选 rowid。
 *
 * @param {object} db
 * @param {string} pattern 原始 pattern（可能是 `a|b` 交替）
 * @param {{where: string, params: unknown[]}} filter 已拼好的过滤条件
 * @returns {{rowids: number[], engines: string[]}|null} null = 用不了索引
 */
export function candidates(db, pattern, { where, params }) {
  const text = String(pattern ?? '');
  if (text.length === 0) return null;

  // 只有「纯字面」和「纯字面交替」能安全地走索引。
  // 含真元字符（`.` `*` `(` …）无法反推候选，必须全表扫。
  const literals = literalAlternatives(text) ?? (needsRegexEngine(text) ? null : [text]);
  if (literals === null) return null;

  const rowids = new Set();
  const engines = [];
  for (const literal of literals) {
    const plan = planLiteral(db, literal);
    if (plan.engine === null) {
      // 只要有一条字面用不了索引，整体退回扫描 —— 否则会漏掉那条的命中。
      return null;
    }
    try {
      // 过滤条件同时作用在 docs 上：子查询给出的 rowid 再 join 回 docs 校验作用域，
      // 避免「先取全部候选再过滤」把无关会话的行也读出来。
      const rows = db
        .prepare(`SELECT rowid FROM docs WHERE ${where} AND rowid IN (${plan.sql}) LIMIT ?`)
        .all(...params, plan.param, MAX_CANDIDATES);
      for (const row of rows) rowids.add(Number(row.rowid));
      engines.push(plan.engine);
      // 候选撞到上限 = 命中太稠密，索引没起到筛选作用。
      // 这时继续验证反而比全表扫更慢（实测 140MB 稠密词：索引查 1.8s + 验证，
      // 不如直接扫）。退回扫描，让「不会比全表扫更慢」成立。
      if (rows.length >= MAX_CANDIDATES) return null;
    } catch {
      return null;
    }
  }
  return { rowids: [...rowids], engines: [...new Set(engines)] };
}

/**
 * 引擎统计（供 stats / 调试）。
 * 只报告"当前能提供哪些加速"，不做承诺 —— 具体用哪个由 pattern 形态决定。
 */
export function engineStatus(db) {
  const count = (sql) => {
    try {
      return Number(db.prepare(sql).get()?.c ?? 0);
    } catch {
      return 0;
    }
  };
  return {
    trigram: hasTrigramIndex(db),
    docs: count('SELECT count(*) AS c FROM docs'),
    tri: count('SELECT count(*) AS c FROM docs_tri'),
  };
}

// lib/grep.mjs — 默认检索：**grep 语义**（pattern 是正则，子串匹配）
//
// 为什么默认是正则而不是关键词索引：
//
//   工具叫「会话历史的 grep」，agent 就会按 grep 的预期写 pattern。
//   `cfind 'foo|bar'` 在关键词模式下会被切成 `foo AND bar`（`|` 当分隔符），
//   而 grep 用户期待的是「foo 或 bar」。一旦语义和预期不符，agent 会得出错误结论，
//   而且不会怀疑工具。所以默认必须真的是正则。
//
// 两条执行路径，语义**完全一致**（都是「body 里出现该 pattern」），只有速度不同：
//
//   ① 纯字面模式（无正则元字符）→ SQL `body LIKE '%…%'`。
//      LIKE 就是子串匹配，和 `re.test(body)` 对纯字面完全等价；实测快 5 倍
//      （20ms vs 110ms / 7.8M 字符）。转义 `%` `_` `\` 之后没有语义差异。
//   ② 含元字符 → worker 里的 RegExp（带 ReDoS 超时保护，见 lib/regex.mjs）。
//
// 刻意不做 relevance 排序：grep 没有 bm25。这里按 kind 权重（human 内容优先）
// 再按时间倒序 —— 那是*可解释*的顺序，不是"猜你想看什么"。
import { DatabaseSync } from 'node:sqlite';
import { regexScan } from './regex.mjs';
import { KIND_WEIGHTS } from './extract.mjs';
import { shortId } from './paths.mjs';

const SNIPPET_MAX = 240;
const SNIPPET_PAD = 90;

/** 正则元字符：出现任一字符就要走真正则路径。 */
const META = /[.^$*+?()[\]{}|\\]/;

/** 一条 pattern 是否需要正则引擎（而不是纯字面 LIKE）。 */
export function needsRegexEngine(pattern) {
  return META.test(String(pattern ?? ''));
}

/**
 * 把「纯字面交替」拆成多个字面：`foo|bar|baz` → ['foo','bar','baz']。
 *
 * 为什么值得单独处理：grep 最常见的用法就是 `a|b|c` 找几个词中的任一个。
 * 走正则引擎实测 164ms，而 LIKE 只要 20ms —— 因为正则要在 JS 里逐条跑，
 * LIKE 是 SQLite 的 C 实现。拆开后用 `(LIKE ? OR LIKE ? ...)` 一次扫完，
 * 语义完全相同（分隔符两侧都没有其他元字符时，`|` 就是纯粹的"或"）。
 *
 * @returns {string[]|null} 拆不开（含其它元字符、或部分分支为空）时返回 null
 */
export function literalAlternatives(pattern) {
  const text = String(pattern ?? '');
  // 先把 `a|b` 里的 `|` 拿掉，看剩下还有没有元字符；有就说明不是纯字面交替。
  const parts = text.split('|');
  if (parts.length < 2) return null;
  if (parts.some((part) => part === '' || META.test(part))) return null;
  return parts;
}

/** LIKE 转义：`%` `_` 是通配符，`\` 是转义符本身。 */
const escapeLike = (text) => String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** 与 query.mjs 一致的 kind 排序（human 内容优先，reasoning 最低）。 */
const KIND_ORDER = `CASE docs.kind ${Object.entries(KIND_WEIGHTS)
  .map(([kind, weight]) => `WHEN '${kind}' THEN ${-weight}`)
  .join(' ')} ELSE 0 END, docs.time DESC`;

const compress = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * 围绕命中取片段，并用 `[ ]` 标出命中。
 *
 * 标记是**给人看**的：grep 用 `--color` 干这件事，我们用括号，
 * 因为括号在管道里不会变成转义序列。
 */
function snippetAround(body, index, length) {
  const src = String(body ?? '');
  if (index < 0) return compress(src).slice(0, SNIPPET_MAX);
  const from = Math.max(0, index - SNIPPET_PAD);
  const to = Math.min(src.length, index + length + SNIPPET_PAD);
  const raw = src.slice(from, to);
  const rel = index - from;
  const end = Math.min(rel + length, raw.length);
  const marked = `${raw.slice(0, rel)}[${raw.slice(rel, end)}]${raw.slice(end)}`;
  const text = compress(`${from > 0 ? '…' : ''}${marked}${to < src.length ? '…' : ''}`);
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX - 1)}…` : text;
}

/**
 * 默认检索。
 *
 * @param {object} db
 * @param {string} pattern 正则或字面
 * @param {object} opts
 * @param {string} opts.where   已拼好的过滤条件（作用域/surface/exclude）
 * @param {unknown[]} opts.params
 * @param {number} opts.max     结果上限
 * @returns {{total: number, hits: object[], engine: 'like'|'regex'}}
 */
export function grepSearch(db, pattern, { where, params = [], max = 10 }) {
  const text = String(pattern ?? '');
  const meta = db.prepare('SELECT id, title, cwd FROM sessions WHERE id = ?');
  const decorate = (row, snippet) => {
    const session = meta.get(row.session_id ?? row.sessionId);
    return {
      sessionId: row.session_id ?? row.sessionId,
      short: shortId(row.session_id ?? row.sessionId),
      title: session?.title ?? '',
      cwd: session?.cwd ?? '',
      seq: row.seq,
      kind: row.kind,
      surface: row.surface,
      time: row.time,
      // score 是**对外的分数**，必须非负（契约）；排序另用 rankOf。
      score: KIND_WEIGHTS[row.kind] ?? 1,
      snippet,
    };
  };

  // 纯字面交替（`a|b|c`）→ 一次 LIKE OR 查询，比正则引擎快 8 倍。
  const alternatives = literalAlternatives(text);
  if (alternatives !== null) {
    const needles = alternatives.map((part) => `%${escapeLike(part)}%`);
    const clause = needles.map(() => `docs.body LIKE ? ESCAPE '\\'`).join(' OR ');
    const total = Number(
      db.prepare(`SELECT count(*) AS c FROM docs WHERE ${where} AND (${clause})`).get(...params, ...needles)?.c ?? 0,
    );
    if (total === 0) return { total: 0, hits: [], engine: 'like' };
    const rows = db
      .prepare(
        `SELECT rowid, session_id, seq, kind, surface, time FROM docs
         WHERE ${where} AND (${clause})
         ORDER BY ${KIND_ORDER} LIMIT ?`,
      )
      .all(...params, ...needles, max * 4);
    const bodyOf = db.prepare('SELECT body FROM docs WHERE rowid = ?');
    const lowered = alternatives.map((part) => part.toLowerCase());
    const hits = rows.map((row) => {
      const body = String(bodyOf.get(row.rowid)?.body ?? '');
      const lower = body.toLowerCase();
      // 片段以**最先出现**的那个分支为中心（与 grep 同一行的行为一致）。
      let best = { index: -1, length: 0 };
      for (const needle of lowered) {
        const index = lower.indexOf(needle);
        if (index >= 0 && (best.index < 0 || index < best.index)) best = { index, length: needle.length };
      }
      return decorate(row, snippetAround(body, best.index, best.length));
    });
    return finalize(hits, total, max, 'like');
  }

  // 正则路径：worker 直接回 hit 形状（含已标好 [ ] 的片段）。
  if (needsRegexEngine(text)) {
    const scanned = regexScan({
      db,
      dbPath: typeof db.location === 'function' ? db.location() : null,
      sql: `SELECT rowid, session_id, seq, kind, surface, time FROM docs WHERE ${where} AND docs.body REGEXP ?`,
      params,
      pattern: text,
      limit: max * 4,
    });
    const hits = scanned.rows.map((row) => decorate(row, row.snippet));
    return finalize(hits, scanned.total, max, 'regex');
  }

  // 字面路径：LIKE 子串匹配（与正则对纯字面等价，实测快 5 倍）。
  const needle = `%${escapeLike(text)}%`;
  const total = Number(
    db.prepare(`SELECT count(*) AS c FROM docs WHERE ${where} AND docs.body LIKE ? ESCAPE '\\'`).get(...params, needle)?.c ?? 0,
  );
  if (total === 0) return { total: 0, hits: [], engine: 'like' };

  const rows = db
    .prepare(
      `SELECT rowid, session_id, seq, kind, surface, time FROM docs
       WHERE ${where} AND docs.body LIKE ? ESCAPE '\\'
       ORDER BY ${KIND_ORDER} LIMIT ?`,
    )
    .all(...params, needle, max * 4);

  const bodyOf = db.prepare('SELECT body FROM docs WHERE rowid = ?');
  const needleLower = text.toLowerCase();
  const hits = rows.map((row) => {
    const body = String(bodyOf.get(row.rowid)?.body ?? '');
    const index = body.toLowerCase().indexOf(needleLower);
    return decorate(row, snippetAround(body, index, text.length));
  });
  return finalize(hits, total, max, 'like');
}

/**
 * 统一收尾：排序 + 截断。
 *
 * 两条路径都在 JS 里排一次，保证**同一 pattern 换个写法不会改变输出顺序**。
 * 排序依据是可解释的：human 内容优先（kind 权重），同权重按时间倒序。
 * 不做 bm25 —— grep 没有 relevance，我们也不假装有。
 */
function finalize(hits, total, max, engine) {
  hits.sort((a, b) => rankOf(a.kind) - rankOf(b.kind) || (b.time ?? 0) - (a.time ?? 0) || (b.seq ?? 0) - (a.seq ?? 0));
  return { total, hits: hits.slice(0, Math.max(0, max)), engine };
}

/** kind → 越小越靠前（分数用同一套，保证与 FTS 路径的字段语义一致）。 */
function rankOf(kind) {
  const weight = KIND_WEIGHTS[kind];
  return weight === undefined ? 0 : -weight;
}

/** 逐条求首次匹配（每次都新建实例，避免 lastIndex 串味）。 */
function makeTester(pattern) {
  return (body) => {
    let re;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      return { index: -1, length: 0 };
    }
    const match = re.exec(String(body ?? ''));
    return match === null ? { index: -1, length: 0 } : { index: match.index, length: match[0].length };
  };
}

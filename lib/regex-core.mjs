// lib/regex-core.mjs — 正则扫描的实际逻辑
//
// 单独一个文件的原因：worker 和主进程（内存库退路）必须跑**完全一样**的代码。
// 两份实现迟早会漂移，然后出现「CLI 和测试结果不一致」这种最难查的 bug。
import { DatabaseSync } from 'node:sqlite';

/** 一条命中最多取多少字符做片段（与 likeSnippet 的 90+90 保持一致）。 */
const SNIPPET_PAD = 90;
const SNIPPET_MAX = 240;

/**
 * 编译用户给的正则。
 *
 * flags 的选择都有理由：
 *   g —— 除了判命中，还要找出**所有**出现位置来决定片段中心。
 *   i —— 搜会话记录时不区分大小写更实用（grep 需要 -i，这里默认开，见 README）。
 *   m —— **grep 是行导向的**：`^`/`$` 应当匹配每一行的首尾，而不是整条记录的
 *        首尾。没有 m 时 `^POST` 只能命中"整条 body 以 POST 开头"，
 *        而 grep 用户期待的是"某一行以 POST 开头"。
 */
export function compilePattern(source) {
  const text = String(source ?? '');
  if (text === '') throw new Error('正则不能为空');
  try {
    return new RegExp(text, 'gim');
  } catch (error) {
    const wrapped = new Error(`正则语法错误：${error.message}`);
    wrapped.userFacing = true;
    throw wrapped;
  }
}

/** 压空白成单行（与 query.compress 同语义，体积控制用）。 */
function compress(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 围绕命中位置取一段带 `[ ]` 标记的片段。
 *
 * 与 `likeSnippet` 的区别：那边只有一个 needle 的首次位置，这里可能一次匹配到
 * 一段变长文本（如 `幂等键.*冲突`），所以标记的是**整个匹配**而不是固定长度的词。
 */
function snippetAt(body, index, length) {
  const src = String(body ?? '');
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
 * 跑一次扫描。
 *
 * @param {object} db  DatabaseSync 连接
 * @param {object} opts
 * @param {string} opts.sql     过滤条件已拼好，模式占位符是最后一个 `?`
 * @param {unknown[]} opts.params
 * @param {string} opts.pattern
 * @param {number} opts.limit   需要计算 snippet 的条数
 * @returns {{total: number, rows: object[]}}
 */
export function runScan(db, { sql, params, pattern, limit, cache }) {
  const regex = cache?.get(pattern) ?? compilePattern(pattern);
  cache?.set(pattern, regex);
  // `.test()` 会改 lastIndex，所以命中判断统一用无状态副本。
  const test = new RegExp(regex.source, 'im');

  db.function('regexp', { deterministic: true }, (needle, text) => {
    if (text === null || text === undefined) return 0;
    test.lastIndex = 0;
    return test.test(String(text)) ? 1 : 0;
  });

  // 只取元数据：body 可能有几万字符，先把「哪些行命中」定下来，
  // 再对真正要展示的那几条按 rowid 点查正文。
  const rows = db.prepare(sql).all(...params, pattern);

  const total = rows.length;
  // 没有 bm25 可用，按时间倒序 —— 「最近发生的事」最可能是想找的。
  rows.sort((a, b) => (b.time ?? 0) - (a.time ?? 0) || (b.seq ?? 0) - (a.seq ?? 0));

  const shown = rows.slice(0, Math.max(0, limit));
  const bodyOf = db.prepare('SELECT body FROM docs WHERE rowid = ?');
  const hits = shown.map((row) => {
    const body = String(bodyOf.get(row.rowid)?.body ?? '');
    // 重新跑一次匹配以拿到**首次**出现的位置（grep 也是取第一个匹配）。
    regex.lastIndex = 0;
    const match = regex.exec(body);
    return {
      sessionId: row.session_id,
      seq: row.seq,
      kind: row.kind,
      surface: row.surface,
      time: row.time,
      snippet: match ? snippetAt(body, match.index, match[0].length) : compress(body).slice(0, SNIPPET_MAX),
    };
  });

  return { total, rows: hits };
}

// lib/context.mjs — 「一条命中周围长什么样」
//
// 为什么单独一个模块：这件事有**两个**调用方，而且它们必须给出完全一致的结果：
//   · `show`（人用：我知道 seq，给我看周围）
//   · `search(context: N)`（agent 用：grep -C）
//
// 如果各写一份，就会重复出同一类 bug：`show` 里看得到的东西 `search -C` 里看不到，
// 或者两者的 `:` / `-` 行标记不一致，管道直接失效。所以逻辑只在这里。
import { adapterOf, ADAPTERS } from './sources/index.mjs';
import { shortId } from './paths.mjs';

/**
 * 找到某会话的原始文件并交给对应来源的适配器读取。
 *
 * 关键：**必须按 header.id 匹配**（目录名可能是 `session-<uuid>`，与真实 id 不同），
 * 而且要用 `sessions.source` 选适配器 —— 不同 agent 的格式完全不同。
 * 先走 files 表的快路径（索引时记下了 path↔session 映射），失败再全盘扫描。
 * @returns {{adapter: object, ref: object, header: object|null, events: object[]}|null}
 */
export function findSessionFile(db, sessionId) {
  const id = String(sessionId ?? '');
  const row = db.prepare('SELECT source FROM sessions WHERE id = ?').get(id);
  const sourceId = row?.source ?? 'dsh';
  const adapter = adapterOf(sourceId) ?? ADAPTERS[0];
  const known = db.prepare('SELECT path FROM files WHERE session_id = ? LIMIT 1').get(id);

  const load = (ref) => {
    try {
      return adapter.readAll(ref);
    } catch {
      return null;
    }
  };

  if (known?.path) {
    const file = load({ ref: known.path, size: 0, mtime: 0 });
    // header 缺失时信任索引里的映射；有 header 则必须是同一会话。
    if (file && (file.header?.id === id || !file.header?.id)) {
      return { adapter, ref: { ref: known.path }, header: file.header, events: file.events };
    }
  }
  for (const candidate of adapter.discover()) {
    if (known?.path && candidate.ref === known.path) continue;
    const file = load(candidate);
    if (file?.header?.id === id) {
      return { adapter, ref: candidate, header: file.header, events: file.events };
    }
  }
  return null;
}

/**
 * 一次调用内的会话缓存。
 *
 * 为什么需要：`search(context: 3)` 的 10 条命中常常落在同 1–2 个会话里。
 * 不缓存就是 10 次整文件解码（每次几毫秒），缓存后只解 1 次。
 * 缓存的生命周期严格限制在**单次调用**内 —— 会话文件随时在被追加，
 * 跨调用缓存会读到旧内容，那种 bug 极难复现。
 */
export function sessionLoader(db) {
  const cache = new Map();
  return {
    /** @returns {{adapter, events, surfaces, meta}|null} */
    get(sessionId) {
      const id = String(sessionId ?? '');
      if (cache.has(id)) return cache.get(id);
      let entry = null;
      try {
        const found = findSessionFile(db, id);
        if (found) {
          entry = {
            adapter: found.adapter,
            events: found.events.filter((event) => Number.isInteger(event.seq)).sort((a, b) => a.seq - b.seq),
            surfaces: found.adapter.surfaceOf(found.events),
            meta: db.prepare('SELECT id, title, cwd FROM sessions WHERE id = ?').get(id) ?? null,
          };
        }
      } catch {
        entry = null;
      }
      cache.set(id, entry);
      return entry;
    },
  };
}

/** 一条事件用于显示的正文：优先「人读视角」，但必须包含 hint（查询词）。 */
function textFor(adapter, event, hint) {
  const body = String((adapter.renderEvent(event) ?? {}).text ?? '').trim();
  if (!hint) return body;
  const needle = String(hint).toLowerCase();
  if (needle === '' || body.toLowerCase().includes(needle)) return body;
  // renderEvent 只给 text 块；命中可能落在 reasoning 块里（被索引、却不在「人读视角」）。
  // 这时退回 toDocs 的正文 —— 那正是被索引的那份字节，保证 L2 说的命中 L3 看得到。
  for (const doc of adapter.toDocs(event) ?? []) {
    const candidate = String(doc.body ?? '');
    if (candidate.toLowerCase().includes(needle)) return candidate.trim();
  }
  return body;
}

/**
 * 取 seq 周围的事件窗口。
 *
 * @param {{adapter, events, surfaces, meta}|null} session  sessionLoader().get() 的结果
 * @param {{before?: number, after?: number, hint?: string}} opts
 *   hint：用于决定取哪份正文（见 textFor）。调用方通常传查询词。
 * @returns {{target: object, events: object[], hidden: number}|null}
 */
export function windowOf(session, seq, { before = 3, after = 3, hint } = {}) {
  if (!session) return null;
  const { adapter, events, surfaces } = session;
  const targetSeq = Number(seq);
  const at = events.findIndex((event) => event.seq === targetSeq);
  if (at < 0) return null;

  const nBefore = Math.max(0, Number.isInteger(before) ? before : 3);
  const nAfter = Math.max(0, Number.isInteger(after) ? after : 3);
  const span = events.slice(Math.max(0, at - nBefore), at + nAfter + 1);

  const rendered = [];
  for (const event of span) {
    const isTarget = event.seq === targetSeq;
    // 跳过的是**结构性噪声**（request/header、system 提示、step/*），不是「没正文」：
    // turn/end 这类空正文事件仍是时序的一部分，留着更利于理解上下文。
    if (!isTarget && adapter.isNoise?.(event) === true) continue;
    rendered.push({
      seq: event.seq,
      type: event.type ?? '',
      time: event.time ?? 0,
      surface: surfaces.get(event.seq) ?? 'current',
      role: (adapter.renderEvent(event) ?? {}).role ?? 'event',
      text: textFor(adapter, event, hint) || `[${event.type}]`,
      isTarget,
    });
  }

  const targetEvent = events[at];
  // 索引里有、但「人读视角」没显示出来的字符数（reasoning 块是主要来源）。
  // 大于 0 就说明「命中的东西可能不在默认显示里」，必须让调用方知道，
  // 否则会误判成"命中是错的"。
  let hidden = 0;
  if (!hint) {
    const indexed = (adapter.toDocs(targetEvent) ?? []).reduce((sum, doc) => sum + String(doc.body ?? '').length, 0);
    // 显式取长度再减：`a - b ?? 0` 里 ?? 优先级低于 -，NaN 不是 nullish，
    // 一旦 find 不到就会得到 NaN 并一路传下去。
    const shownLen = rendered.find((item) => item.seq === targetSeq)?.text?.length ?? 0;
    hidden = Math.max(0, indexed - shownLen);
  }

  return {
    target: {
      seq: targetEvent.seq,
      type: targetEvent.type ?? '',
      time: targetEvent.time ?? 0,
      kind: (adapter.toDocs(targetEvent) ?? [])[0]?.kind ?? 'other',
      hidden,
    },
    events: rendered,
    hidden,
  };
}

/** show 的返回形状（对外契约，别随手改字段）。 */
export function describeSession(session, sessionId) {
  return {
    sessionId: String(sessionId),
    short: shortId(sessionId),
    title: session?.meta?.title ?? '',
    cwd: session?.meta?.cwd ?? '',
    source: session?.adapter?.id ?? 'dsh',
  };
}

// ── 原始文件已被删除时的退路 ──────────────────────────────────────────────
//
// Claude Code 和 Codex 会**定期删掉旧会话**（sessionwiki 的 "archive mode" 与
// cass 的 archive 都在处理这件事）。我们的 search 走索引，所以照常工作；
// 但 `show` 原本只读原始文件 —— 文件一删就彻底失效，而正文明明还在 docs 表里。
//
// 这不是理论问题：实测删掉 fixture 的会话目录后 `show` 直接抛
// "session file not found"。所以补一条退路：从索引重建窗口，并明确标注
// `archived: true`，让调用方知道看到的是蒸馏副本而不是逐字节原文。

/** 同一 seq 有多条 doc 时的拼接顺序（reasoning 通常在正文之前产生）。 */
const KIND_ORDER = ['title', 'compaction', 'user', 'reasoning', 'assistant', 'tool-call', 'tool-result', 'other'];

/** kind → 人读角色（与 renderEvent 的取值保持一致）。 */
const KIND_ROLE = {
  user: 'user',
  assistant: 'assistant',
  reasoning: 'reasoning',
  'tool-call': 'tool',
  'tool-result': 'tool',
  title: 'title',
  compaction: 'summary',
};

/**
 * 从索引重建一个窗口。返回形状与 `windowOf` 完全一致，外加 `archived: true`。
 *
 * @param {object} db
 * @param {string} sessionId
 * @param {number} seq
 * @param {{before?: number, after?: number, hint?: string}} opts
 * @returns {{target: object, events: object[], hidden: number, archived: true}|null}
 */
export function windowFromIndex(db, sessionId, seq, { before = 3, after = 3, hint } = {}) {
  const id = String(sessionId ?? '');
  const rows = db
    .prepare(
      `SELECT seq, kind, time, surface, body FROM docs
       WHERE session_id = ? ORDER BY seq, kind`,
    )
    .all(id);
  if (rows.length === 0) return null;

  // 一条事件可能被拆成多条 doc（实测 15% 的 seq 有多条，主要是 reasoning + assistant）。
  // 必须按 seq 合回一条事件，否则窗口里的「条数」会与 show 的语义不符。
  const bySeq = new Map();
  for (const row of rows) {
    const entry = bySeq.get(row.seq) ?? { seq: row.seq, time: row.time, surface: row.surface, parts: [] };
    entry.parts.push(row);
    // surface 取最"新"的那条：同一事件的各部分通常同时产生。
    entry.time = Math.max(entry.time ?? 0, row.time ?? 0);
    bySeq.set(row.seq, entry);
  }

  const seqs = [...bySeq.keys()].sort((a, b) => a - b);
  const targetSeq = Number(seq);
  const at = seqs.indexOf(targetSeq);
  if (at < 0) return null;

  const nBefore = Math.max(0, Number.isInteger(before) ? before : 3);
  const nAfter = Math.max(0, Number.isInteger(after) ? after : 3);
  const window = seqs.slice(Math.max(0, at - nBefore), at + nAfter + 1);

  const events = window.map((each) => {
    const entry = bySeq.get(each);
    const parts = [...entry.parts].sort(
      (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
    );
    const primary = parts[0];
    // 给了 hint 就把包含它的那段排在前面：几万字符的 reasoning 里，
    // 命中片段可能在第 6 万字符处，默认显示会完全看不到。
    if (hint) {
      const needle = String(hint).toLowerCase();
      const hitAt = parts.findIndex((part) => String(part.body ?? '').toLowerCase().includes(needle));
      if (hitAt > 0) parts.unshift(...parts.splice(hitAt, 1));
    }
    return {
      seq: each,
      type: primary.kind,
      time: entry.time ?? 0,
      surface: entry.surface ?? 'current',
      role: KIND_ROLE[primary.kind] ?? 'event',
      text: parts
        .map((part) => String(part.body ?? '').trim())
        .filter(Boolean)
        .join('\n'),
      isTarget: each === targetSeq,
    };
  });

  return {
    target: {
      seq: targetSeq,
      type: events.find((event) => event.isTarget)?.type ?? '',
      time: bySeq.get(targetSeq).time ?? 0,
      kind: bySeq.get(targetSeq).parts[0].kind,
      // 索引重建时不存在「索引有、显示无」：拿到的就是被索引的那份字节。
      hidden: 0,
    },
    events,
    hidden: 0,
    archived: true,
  };
}

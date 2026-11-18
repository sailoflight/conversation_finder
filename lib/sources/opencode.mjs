// lib/sources/opencode.mjs — OpenCode 适配器
//
// OpenCode 目前有**两种真实落盘形态**，本文件都支持：
//
//   1) 2.x 原生 SQLite（生产路径）
//      `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`
//      · session_message(id, session_id, type, seq, time_created, data)
//        data 是 JSON 字符串；type ∈ user / assistant / idle / compaction / ...
//      · session_v2（或旧一点的 session）存 title / directory / time_created / agent / parent_id。
//      表名从 sqlite_master 实际探测，而不是信某个 version 字段——schema 演进时版本号不一定可靠。
//
//   2) 1.x SQLite 三表
//      · session / message / part。message.data 只有 role/time，正文在 part.data；
//        tool 的 part 用 `tool`（不是 name）、state.output 是**字符串**（不是 content 数组）。
//      这里把 part 拼回 2.x / 导出器同款的 `assistant.data.content[]`，后面的提取逻辑只写一份。
//
//   3) 导出器聚合 jsonl（样本形态）
//      每行 {type, seq, data}；本适配器按**物理行号**给 seq（任务约定），
//      因为导出器写出的 seq 是原库 seq、可能跳号（实测样本 4,5,14,...），行号才是稳定的文件位置。
//
// 为什么“无法识别就抛错”：返回空数组会让索引器以为文件没变化，永远静默漏索引；
// 抛清晰错误才能让 `store.syncIndex` 的 errors 里看见根因。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

/** 单条文档正文上限（与 lib/extract.mjs 一致，防止巨型工具输出撑爆索引）。 */
const MAX_BODY = 64_000;

/** 标题取第一条 user 正文的前 N 个字符（按 code point 数，避免切碎 emoji）。 */
const TITLE_CHARS = 60;

/**
 * titleOf(events) 的契约只接收 events，但 db 里的 session title 优先级更高。
 * 用 WeakMap 把 readAll 时读到的 title 挂到 events 数组上：store 调 titleOf 时传的是同一个数组，
 * 因此不会破坏接口；数组被 clone 后则自然退回“第一条 user”的规则。
 */
const dbTitles = new WeakMap();

// ── 路径 ────────────────────────────────────────────────────────────────

/** OpenCode 数据目录：$XDG_DATA_HOME/opencode 或 ~/.local/share/opencode。 */
function opencodeDataDir() {
  const xdg = process.env.XDG_DATA_HOME;
  return xdg ? join(xdg, 'opencode') : join(homedir(), '.local', 'share', 'opencode');
}

/**
 * DB 位置。OPENCODE_DB 是显式覆盖（调试/测试用）；
 * OPENCODE_DIR 下若放了 fixture db 也认，方便测试不污染真实 XDG 目录。
 */
function dbFile() {
  if (process.env.OPENCODE_DB) return process.env.OPENCODE_DB;
  const primary = join(opencodeDataDir(), 'opencode.db');
  const alt = process.env.OPENCODE_DIR ? join(process.env.OPENCODE_DIR, 'opencode.db') : null;
  if (!existsSync(primary) && alt && existsSync(alt)) return alt;
  return primary;
}

/** jsonl 的扫描根：OPENCODE_DIR（测试/导出目录）优先，否则数据目录。 */
function jsonlRoot() {
  return process.env.OPENCODE_DIR || opencodeDataDir();
}

/**
 * DB 的 freshness 取「主文件 + -wal」：OpenCode 长时间运行时 SQLite 是 WAL 模式，
 * 新消息先写 -wal，主库的 size/mtime 可能很久不变。只看主文件会让 store 误判“没变化”
 * 而跳过整库重读。把 -wal 的大小和 mtime 合并进来，任何写入都能被看见。
 */
function statFreshDb(path) {
  const info = statSync(path);
  let size = info.size;
  let mtime = info.mtimeMs;
  try {
    const wal = statSync(`${path}-wal`);
    size += wal.size;
    mtime = Math.max(mtime, wal.mtimeMs);
  } catch {
    /* 没有 -wal 就是普通 journal 模式 */
  }
  return { size, mtime, isFile: info.isFile() };
}

/** 递归找 .jsonl。不用 statSync 跟符号链接，避免目录环。 */
function listJsonl(root) {
  const out = [];
  const visit = (path) => {
    let info;
    try {
      info = statSync(path);
    } catch {
      return;
    }
    if (info.isFile()) {
      if (/\.jsonl$/i.test(path)) out.push({ path, size: info.size, mtime: info.mtimeMs });
      return;
    }
    if (!info.isDirectory()) return;
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return; // 没权限就跳过，别让一个坏目录拖垮整个 discover
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      visit(join(path, entry.name));
    }
  };
  visit(root);
  return out.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

// ── 通用小工具 ──────────────────────────────────────────────────────────

/** 从导出文件名还原 session id：session-ses_xxx-2026-10-23.jsonl → ses_xxx。 */
function idFromFilename(path) {
  const base = basename(path).replace(/\.jsonl$/i, '');
  const dated = base.match(/^session-(.+?)-\d{4}-\d{2}-\d{2}(?:[T-].*)?$/);
  if (dated) return dated[1];
  return base.replace(/^session-/, '');
}

/** 容忍 data 是“JSON 字符串”或“已经解析好的对象”。 */
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** 事件时间：统一戳成 epoch ms（OpenCode 各代字段名略有差异）。 */
function timeOf(data) {
  const value = data?.time?.created ?? data?.time?.completed ?? data?.time_created ?? data?.created;
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function intOrNull(value) {
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

function clip(text) {
  return text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text;
}

/** 按 code point 截断，避免把代理对切成半个字符。 */
function clipChars(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

/** 标题压成一行（原始 prompt 常带换行/缩进，直接塞进 sessions.title 很难看）。 */
function normalizeTitle(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 第一条 user 的正文（前 60 字）。 */
function firstUserTitle(events) {
  for (const event of events ?? []) {
    if (event?.type !== 'user') continue;
    const raw = typeof event.data?.text === 'string' ? event.data.text : contentText(event.data?.content);
    const title = normalizeTitle(raw);
    if (title) return clipChars(title, TITLE_CHARS);
  }
  return null;
}

/** 拼接 text 块（tool 块不在这里；各角色自己有规则）。 */
function contentText(blocks) {
  return (blocks ?? [])
    .flatMap((block) => (block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n');
}

/** tool 输入：对象要 JSON 化，不能变成 [object Object]。 */
function inputText(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/** tool 结果正文：2.x 在 state.content[].text，1.x 在 state.output。 */
function toolResultText(block) {
  const state = block?.state ?? {};
  const parts = [];
  let fromContent = false;
  if (Array.isArray(state.content)) {
    for (const item of state.content) {
      if (typeof item?.text !== 'string') continue;
      parts.push(item.text);
      fromContent = true;
    }
  }
  // 1.x 的 state.output 和 legacyToolState() 补出的 content 是同一份内容，别重复拼。
  if (!fromContent && typeof state.output === 'string') parts.push(state.output);
  if (typeof state.error === 'string') parts.push(state.error);
  else if (typeof state.error?.message === 'string') parts.push(state.error.message);
  return parts.filter(Boolean).join('\n');
}

function firstString(events, pick) {
  for (const event of events) {
    const value = pick(event.data ?? {});
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

// ── SQLite 表结构探测 ───────────────────────────────────────────────────

function tablesOf(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all();
  return new Set(rows.map((row) => String(row.name)));
}

function columnsOf(db, table) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((row) => String(row.name)));
}

const SESSION_META_COLUMNS = [
  'id',
  'title',
  'directory',
  'cwd',
  'time_created',
  'agent',
  'parent_id',
  'parentID',
];

/** 读 session / session_v2 的元数据（只取我们认识的列）。 */
function sessionMeta(db, tables) {
  const table = ['session_v2', 'session'].find((name) => tables.has(name));
  if (!table) return new Map();
  const columns = columnsOf(db, table);
  const present = SESSION_META_COLUMNS.filter((name) => columns.has(name));
  if (!present.includes('id')) return new Map();
  const rows = db.prepare(`SELECT ${present.join(', ')} FROM ${table}`).all();
  return new Map(rows.map((row) => [String(row.id), row]));
}

function headerOf(sessionIds, metaMap, events, onlySession, fallbackId) {
  // 一个 db ref 覆盖多个会话时是“db 级聚合”：不能借用第一个会话的 title/cwd，
  // 否则检索结果会把 A 会话的标题挂到 B 会话的内容上。单会话才读 session 表元数据。
  const multi = !onlySession && sessionIds.length > 1;
  const primary = onlySession ?? sessionIds[0] ?? null;
  const meta = multi ? null : primary ? metaMap.get(primary) : null;
  const header = {
    id: String(multi ? fallbackId : (primary ?? meta?.id ?? fallbackId)),
    cwd: meta?.directory || meta?.cwd || firstString(events, (data) => data.cwd ?? data.path?.cwd ?? data.directory),
    title: meta?.title || firstUserTitle(events),
    createdAt: intOrNull(meta?.time_created) ?? events[0]?.time ?? null,
    agentPreset: meta?.agent ?? firstString(events, (data) => data.agent),
    parentId:
      meta?.parent_id ??
      meta?.parentID ??
      firstString(events, (data) => data.parentID ?? data.parent_id ?? data.parentId),
  };
  // 把真实会话 id 带出去，方便上层以后按 session_id 拆成“一会话一行”。
  if (multi) header.sessions = sessionIds;
  return header;
}

// ── 2.x：session_message ────────────────────────────────────────────────

function readSessionMessage(db, tables, onlySession, fallbackId) {
  const columns = columnsOf(db, 'session_message');
  for (const required of ['type', 'data']) {
    if (!columns.has(required)) {
      throw new Error(
        `opencode: session_message 缺少必需列 ${required}（实际列=${[...columns].sort().join(', ') || '(空)'}）`,
      );
    }
  }
  if (onlySession && !columns.has('session_id')) {
    throw new Error('opencode: session_message 缺少 session_id，无法按会话过滤');
  }

  const where = onlySession ? 'WHERE session_id = ?' : '';
  const order = [columns.has('session_id') && 'session_id', columns.has('seq') && 'seq', 'rowid']
    .filter(Boolean)
    .join(', ');
  const rows = db.prepare(`SELECT * FROM session_message ${where} ORDER BY ${order}`).all(
    ...(onlySession ? [onlySession] : []),
  );

  const events = [];
  const sessionIds = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    let data = parseMaybeJson(row.data);
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
    const sessionId = columns.has('session_id') ? String(row.session_id ?? '') : '';
    if (sessionId && !sessionIds.includes(sessionId)) sessionIds.push(sessionId);
    const seq = columns.has('seq') && Number.isInteger(row.seq) ? row.seq : index + 1;
    events.push({
      seq,
      time: intOrNull(row.time_created) ?? timeOf(data),
      type: String(row.type ?? data.type ?? 'unknown'),
      data,
      ...(sessionId ? { sessionId } : {}),
    });
  }

  // 一个 db ref 混了多个会话时，原生 seq 会重复；改成全局序号，保证
  // `events(session_id, seq)` 的唯一性。单会话（normal 情况）仍保留原生 seq。
  if (!onlySession && sessionIds.length > 1) {
    events.forEach((event, index) => {
      event.seq = index + 1;
    });
  }

  const metaMap = sessionMeta(db, tables);
  const header = headerOf(sessionIds, metaMap, events, onlySession, fallbackId);
  const title = onlySession
    ? metaMap.get(onlySession)?.title
    : sessionIds.length === 1
      ? metaMap.get(sessionIds[0])?.title
      : null;
  return { header, events, title, sessionIds };
}

// ── 1.x：session / message / part ───────────────────────────────────────

/** 把 1.x 的 tool state 拉成 2.x 形状（output 字符串 → content 数组）。 */
function legacyToolState(state) {
  if (!state || typeof state !== 'object') return { status: 'unknown', input: {} };
  const content = Array.isArray(state.content)
    ? state.content
    : typeof state.output === 'string' && state.output
      ? [{ type: 'text', text: state.output }]
      : [];
  return { ...state, input: state.input ?? {}, content };
}

function readLegacy(db, tables, onlySession, fallbackId) {
  const messageColumns = columnsOf(db, 'message');
  const partColumns = columnsOf(db, 'part');
  if (!messageColumns.has('data')) throw new Error('opencode: 1.x message 表缺少 data 列');
  if (!partColumns.has('data')) throw new Error('opencode: 1.x part 表缺少 data 列');
  if (!partColumns.has('message_id')) throw new Error('opencode: 1.x part 表缺少 message_id，无法把正文拼回消息');
  if (onlySession && !messageColumns.has('session_id')) {
    throw new Error('opencode: 1.x message 表缺少 session_id，无法按会话过滤');
  }

  const messageWhere = onlySession ? 'WHERE session_id = ?' : '';
  const messageOrder = [messageColumns.has('time_created') && 'time_created', 'rowid'].filter(Boolean).join(', ');
  const messageRows = db
    .prepare(`SELECT * FROM message ${messageWhere} ORDER BY ${messageOrder}`)
    .all(...(onlySession ? [onlySession] : []));

  const partWhere = onlySession && partColumns.has('session_id') ? 'WHERE session_id = ?' : '';
  const partOrder = [partColumns.has('time_created') && 'time_created', 'rowid'].filter(Boolean).join(', ');
  const partRows = db
    .prepare(`SELECT * FROM part ${partWhere} ORDER BY ${partOrder}`)
    .all(...(partWhere ? [onlySession] : []));

  const partsByMessage = new Map();
  for (const row of partRows) {
    const messageId = String(row.message_id ?? '');
    if (!messageId) continue;
    const data = parseMaybeJson(row.data);
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    if (!partsByMessage.has(messageId)) partsByMessage.set(messageId, []);
    partsByMessage.get(messageId).push(data);
  }

  const events = [];
  const sessionIds = [];
  for (let index = 0; index < messageRows.length; index += 1) {
    const row = messageRows[index];
    let data = parseMaybeJson(row.data);
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
    const sessionId = messageColumns.has('session_id') ? String(row.session_id ?? '') : '';
    if (sessionId && !sessionIds.includes(sessionId)) sessionIds.push(sessionId);

    const parts = partsByMessage.get(String(row.id ?? '')) ?? [];
    const content = [];
    let compacted = false;
    for (const part of parts) {
      if (part.type === 'text' && typeof part.text === 'string' && !part.ignored) {
        content.push({ type: 'text', text: part.text });
      } else if (part.type === 'reasoning' && typeof part.text === 'string') {
        content.push({ type: 'reasoning', text: part.text });
      } else if (part.type === 'tool') {
        content.push({
          type: 'tool',
          id: part.id ?? part.callID,
          name: part.tool ?? part.name,
          executed: part.state?.status === 'completed',
          state: legacyToolState(part.state),
          time: part.time ?? {},
        });
      } else if (part.type === 'compaction') {
        // 1.x 的压缩不是独立消息，而是挂在某条消息上的 part；用标记让 surfaceOf 识别边界。
        compacted = true;
      }
    }

    const role = String(data.role ?? data.type ?? 'unknown');
    events.push({
      seq: index + 1, // 1.x message 表没有 seq 列，按时间顺序给行号
      time: intOrNull(row.time_created) ?? timeOf(data),
      type: role,
      data: { ...data, text: contentText(content), content, ...(compacted ? { compacted: true } : {}) },
      ...(sessionId ? { sessionId } : {}),
    });
  }

  const metaMap = sessionMeta(db, tables);
  const header = headerOf(sessionIds, metaMap, events, onlySession, fallbackId);
  const title = onlySession
    ? metaMap.get(onlySession)?.title
    : sessionIds.length === 1
      ? metaMap.get(sessionIds[0])?.title
      : null;
  return { header, events, title, sessionIds };
}

// ── readAll 的两条分支 ──────────────────────────────────────────────────

function readJsonl(path) {
  let text = readFileSync(path, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM，否则第一行 JSON.parse 必炸
  const lines = text.split(/\r?\n/);
  const events = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    let raw;
    try {
      raw = JSON.parse(lines[index]);
    } catch {
      continue; // 坏行不崩：导出器/并发写都可能留下半行
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    let data = parseMaybeJson(raw.data);
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
    events.push({
      // 物理行号（1-based）。样本里原生 seq 有跳号（4,5,14…），不能当“文件位置”用。
      seq: index + 1,
      time: timeOf(data),
      type: String(raw.type ?? data.type ?? 'unknown'),
      data,
    });
  }

  return {
    header: {
      id: idFromFilename(path),
      cwd: firstString(events, (data) => data.cwd ?? data.path?.cwd ?? data.directory),
      title: firstUserTitle(events),
      createdAt: events[0]?.time ?? null,
      agentPreset: firstString(events, (data) => data.agent),
      parentId: firstString(events, (data) => data.parentID ?? data.parent_id ?? data.parentId),
    },
    events,
    consumed: statSync(path).size,
  };
}

function readDb(path, onlySession) {
  if (!existsSync(path)) throw new Error(`opencode: 数据库不存在: ${path}`);
  let db;
  try {
    // 只读打开：索引过程绝不能改用户的生产库（也避免拿到写锁）。
    db = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    throw new Error(`opencode: 无法以只读方式打开数据库 ${path}: ${error.message}`);
  }
  try {
    const tables = tablesOf(db);
    let result;
    const fallbackId = basename(path, '.db');
    if (tables.has('session_message')) {
      result = readSessionMessage(db, tables, onlySession, fallbackId);
    } else if (tables.has('message') && tables.has('part')) {
      result = readLegacy(db, tables, onlySession, fallbackId);
    } else {
      throw new Error(
        `opencode: 无法识别的数据库结构（${path}）：` +
          `期望 session_message（2.x）或 message+part（1.x），实际表=${[...tables].sort().join(', ') || '(空)'}`,
      );
    }
    if (result.title) dbTitles.set(result.events, result.title);
    return {
      header: result.header,
      events: result.events,
      consumed: statSync(path).size,
    };
  } finally {
    db.close();
  }
}

// ── 适配器本体 ──────────────────────────────────────────────────────────

export const opencodeSource = {
  id: 'opencode',
  label: 'OpenCode',

  detect() {
    return existsSync(dbFile()) || listJsonl(jsonlRoot()).length > 0;
  },

  discover() {
    const out = [];
    const dbPath = dbFile();
    if (existsSync(dbPath)) {
      try {
        const info = statFreshDb(dbPath);
        if (info.isFile) {
          out.push({
            ref: dbPath,
            kind: 'db',
            size: info.size,
            mtime: info.mtime,
            sessionHint: basename(dbPath, '.db'),
          });
        }
      } catch {
        /* 没权限/状态变化：当作没发现，别让整个 discover 抛 */
      }
    }
    for (const file of listJsonl(jsonlRoot())) {
      out.push({
        ref: file.path,
        kind: 'jsonl',
        size: file.size,
        mtime: file.mtime,
        sessionHint: idFromFilename(file.path),
      });
    }
    return out;
  },

  readAll(ref) {
    const resolved =
      typeof ref === 'string'
        ? { path: ref, kind: /\.jsonl$/i.test(ref) ? 'jsonl' : 'db', sessionId: undefined }
        : {
            path: ref?.ref ?? ref?.path,
            kind: ref?.kind ?? (/\.jsonl$/i.test(String(ref?.ref ?? ref?.path ?? '')) ? 'jsonl' : 'db'),
            sessionId: ref?.sessionId,
          };
    if (!resolved.path) throw new Error('opencode: readAll 需要 { ref, kind } 或路径字符串');
    return resolved.kind === 'jsonl'
      ? readJsonl(resolved.path)
      : readDb(resolved.path, resolved.sessionId);
  },

  toDocs(event) {
    const data = event?.data ?? {};
    const type = String(event?.type ?? '');
    const out = [];
    const push = (kind, body) => {
      const text = typeof body === 'string' ? body.trim() : '';
      if (text.length >= 2) out.push({ kind, body: clip(text) });
    };

    if (type === 'user') {
      // 任务约定 user.data.text 是纯字符串；content 兜底给 1.x / 其它导出器。
      push('user', typeof data.text === 'string' ? data.text : contentText(data.content));
      return out;
    }

    if (type === 'assistant') {
      const blocks = Array.isArray(data.content) ? data.content : [];
      push(
        'assistant',
        blocks
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n'),
      );
      push(
        'reasoning',
        blocks
          .filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n'),
      );
      for (const block of blocks) {
        if (block?.type !== 'tool') continue;
        push('tool-result', toolResultText(block));
        push('tool-call', [block.name ?? block.tool, inputText(block.state?.input ?? block.input)].filter(Boolean).join('\n'));
      }
      // 少数导出器把 assistant 正文放 text，没有 content[]。
      if (blocks.length === 0) push('assistant', data.text);
      return out;
    }

    if (type === 'compaction') {
      // 压缩摘要是“记忆”本体，必须可检索；它不是 idle，不能丢。
      push('compaction', typeof data.summary === 'string' ? data.summary : contentText(data.content));
      return out;
    }

    // idle 明确不索引；未知类型也不猜（避免把生命周期日志塞进索引）。
    return out;
  },

  surfaceOf(events) {
    const list = Array.isArray(events) ? events : [];
    const boundaries = [];
    for (const event of list) {
      if (!Number.isInteger(event?.seq)) continue;
      const type = String(event?.type ?? '');
      let isBoundary = event?.data?.compacted === true; // 1.x：compaction 是 part
      // 2.x：compaction 消息本体。running/failed 还没真正替换上下文，不能算边界。
      if (type === 'compaction') isBoundary = event?.data?.status !== 'running' && event?.data?.status !== 'failed';
      if (isBoundary) boundaries.push({ seq: event.seq, sessionId: event.sessionId });
    }

    // 边界只遮蔽**同一会话**里更早的事件：一个 db ref 聚合多会话时，
    // B 会话的压缩不能把 A 会话的内容标成 shadowed。
    // 本样本没有 compaction，因此全部 current；有压缩的会话才产生 shadowed。
    const result = new Map();
    for (const event of list) {
      if (!Number.isInteger(event?.seq)) continue;
      const shadowed = boundaries.some(
        (boundary) =>
          boundary.seq > event.seq &&
          (boundary.sessionId === undefined || event.sessionId === undefined || boundary.sessionId === event.sessionId),
      );
      result.set(event.seq, shadowed ? 'shadowed' : 'current');
    }
    return result;
  },

  renderEvent(event) {
    const type = String(event?.type ?? '');
    const data = event?.data ?? {};
    if (type === 'user') {
      return { role: 'user', text: (typeof data.text === 'string' ? data.text : contentText(data.content)).trim() };
    }
    if (type === 'assistant') {
      const blocks = Array.isArray(data.content) ? data.content : [];
      const text = blocks
        .filter((block) => block?.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n')
        .trim();
      if (text) return { role: 'assistant', text };
      const reasoning = blocks
        .filter((block) => block?.type === 'reasoning')
        .map((block) => block.text ?? '')
        .join('\n')
        .trim();
      if (reasoning) return { role: 'assistant', text: reasoning };
      const tools = blocks.filter((block) => block?.type === 'tool');
      if (tools.length > 0) {
        return {
          role: 'tool',
          text: tools
            .map((block) => [block.name ?? block.tool, inputText(block.state?.input ?? block.input)].filter(Boolean).join(' '))
            .join('\n'),
        };
      }
      return { role: 'assistant', text: '' };
    }
    if (type === 'compaction') {
      return { role: 'event', text: String(data.summary ?? '[compaction]') };
    }
    if (type === 'idle') {
      return { role: 'event', text: data.outcome ? `idle (${data.outcome})` : '[idle]' };
    }
    return { role: 'event', text: '' };
  },

  titleOf(events) {
    // db 的 session.title 优先（用户可能手动改名）；其次第一条 user 正文前 60 字。
    const fromDb = dbTitles.get(events);
    if (typeof fromDb === 'string' && fromDb.trim()) return fromDb.trim();
    return firstUserTitle(events);
  },
};

export default opencodeSource;

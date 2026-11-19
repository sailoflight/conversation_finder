// lib/store.mjs — 增量索引器（唯一写入口）
//
// 从 0.2 起**不再认识任何一家 agent 的格式**：所有格式差异都收在 lib/sources/*.mjs 里。
// 本文件只负责三件事：判断哪个文件变了、按适配器读事件、把文档写进 FTS5。
//
// 增量策略：
//   · size + mtime 都没变 → 整文件跳过，一次读取都不做（热查询的主要收益来源）。
//   · 变了且适配器支持 readFrom、且文件只增长 → 只读新增部分（DSH 的 zstd 逐帧）。
//   · 其它情况（变小/重写/适配器不支持增量）→ 整文件重建。
//     为什么不强行增量：各源的重写语义不同（Claude 会 fork 出全新 sessionId、
//     OpenCode 是单库），重建既正确又便宜（单会话 <1MB）。
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { bigrams } from './cjk.mjs';
import { activeAdapters } from './sources/index.mjs';

const intOrNull = (value) => (Number.isInteger(value) ? value : null);

/**
 * 索引内容版本号：每写出新文档就 +1。
 * 用途：query 侧缓存「词表」（拼写纠错要用），靠它判断缓存是否过期。
 * 为什么不直接缓存到磁盘：fts5vocab 扫 3 万词要 60ms，而那正是**每次**模糊查询的开销；
 * 内存缓存 + 版本号能把常驻进程里的重复成本降到 0，且不会读到陈旧词表。
 */
let indexVersion = 0;

/** 当前索引内容版本（内容变了才变）。 */
export const contentVersion = () => indexVersion;
const mtimeOf = (file) => Math.round(file.mtime);

/** 一次 sync 内复用的预编译语句（prepare 有成本，别放进循环）。 */
function prepare(db) {
  return {
    getFile: db.prepare(
      'SELECT path, session_id, size, mtime, frame_offset, event_count FROM files WHERE path = ?',
    ),
    allFiles: db.prepare('SELECT path, session_id, archived FROM files'),
    upsertFile: db.prepare(`
      INSERT INTO files (path, session_id, size, mtime, frame_offset, event_count, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        session_id   = excluded.session_id,
        size         = excluded.size,
        mtime        = excluded.mtime,
        frame_offset = excluded.frame_offset,
        event_count  = excluded.event_count,
        indexed_at   = excluded.indexed_at,
        -- 文件重新出现 = 解除归档。归档必须是可逆的：工具恢复了会话，
        -- 或用户从备份搬回来，继续把它当"蒸馏副本"会给出降级的内容。
        archived     = 0`),
    archiveFile: db.prepare('UPDATE files SET archived = 1 WHERE path = ?'),
    delFile: db.prepare('DELETE FROM files WHERE path = ?'),
    countFilesForSession: db.prepare('SELECT COUNT(*) AS c FROM files WHERE session_id = ?'),
    delEvents: db.prepare('DELETE FROM events WHERE session_id = ?'),
    delDocs: db.prepare('DELETE FROM docs WHERE session_id = ?'),
    delSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
    insEvent: db.prepare(
      'INSERT OR REPLACE INTO events (session_id, seq, type, time, surface) VALUES (?, ?, ?, ?, ?)',
    ),
    insDoc: db.prepare(
      'INSERT INTO docs (body, sh, source, session_id, seq, kind, time, surface) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    shadowEvents: db.prepare(
      "UPDATE events SET surface = 'shadowed' WHERE session_id = ? AND seq BETWEEN ? AND ?",
    ),
    shadowDocs: db.prepare(
      "UPDATE docs SET surface = 'shadowed' WHERE session_id = ? AND seq BETWEEN ? AND ?",
    ),
    agg: db.prepare(
      'SELECT COUNT(*) AS c, MIN(time) AS first, MAX(time) AS last FROM events WHERE session_id = ?',
    ),
    insertSession: db.prepare(`
      INSERT INTO sessions (id, source, cwd, title, created_at, agent_preset, parent_id, event_count, first_time, last_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    upsertSession: db.prepare(`
      INSERT INTO sessions (id, source, cwd, title, created_at, agent_preset, parent_id, event_count, first_time, last_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source       = excluded.source,
        cwd          = COALESCE(excluded.cwd, sessions.cwd),
        title        = COALESCE(excluded.title, sessions.title),
        created_at   = COALESCE(excluded.created_at, sessions.created_at),
        agent_preset = COALESCE(excluded.agent_preset, sessions.agent_preset),
        parent_id    = COALESCE(excluded.parent_id, sessions.parent_id),
        event_count  = excluded.event_count,
        first_time   = excluded.first_time,
        last_time    = excluded.last_time`),
  };
}

/** 事务包装：失败 ROLLBACK，把错误抛给调用方决定是否记 errors[]。 */
function inTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 事务已自行中止：忽略二次 ROLLBACK 的报错，保留原始错误 */
    }
    throw error;
  }
}

const referencedElsewhere = (stmts, sessionId) => (stmts.countFilesForSession.get(sessionId)?.c ?? 0) > 0;

/** 写事件行 + 文档行；surface 由适配器给。 */
function writeEventsAndDocs(stmts, source, sessionId, events, surfaceOf, toDocs) {
  let docCount = 0;
  for (const event of events) {
    stmts.insEvent.run(sessionId, event.seq, event.type ?? null, intOrNull(event.time), surfaceOf.get(event.seq) ?? 'current');
    for (const doc of toDocs(event) ?? []) {
      const body = String(doc.body ?? '').trim();
      if (body.length < 2) continue;
      stmts.insDoc.run(
        body,
        bigrams(body),
        source,
        sessionId,
        event.seq,
        doc.kind,
        intOrNull(event.time) ?? 0,
        surfaceOf.get(event.seq) ?? 'current',
      );
      docCount += 1;
    }
  }
  return docCount;
}

/** 整文件重建（首次见到 / 变小 / 重写 / 适配器不支持增量）。 */
function rebuildSession(db, stmts, adapter, file, now) {
  const { header, events } = adapter.readAll(file);
  const sessionId = String(header?.id ?? '');
  if (!sessionId) throw new Error('adapter returned no session id');

  stmts.delEvents.run(sessionId);
  stmts.delDocs.run(sessionId);
  stmts.delSession.run(sessionId);

  const surface = adapter.surfaceOf(events);
  const docs = writeEventsAndDocs(stmts, adapter.id, sessionId, events, surface, (event) => adapter.toDocs(event));

  const agg = stmts.agg.get(sessionId);
  const title = typeof adapter.titleOf === 'function' ? adapter.titleOf(events) : (header.title ?? null);
  stmts.insertSession.run(
    sessionId,
    adapter.id,
    header.cwd ?? null,
    title ?? header.title ?? null,
    intOrNull(header.createdAt),
    header.agentPreset ?? null,
    header.parentId ?? null,
    agg.c,
    agg.first,
    agg.last,
  );
  stmts.upsertFile.run(file.ref, sessionId, file.size, mtimeOf(file), file.size, agg.c, now);
  return { sessionId, events: events.length, docs };
}

/**
 * 增量追加：只读新增部分。
 * 返回 null 表示「没有新的完整片段」（例如 DSH 尾部半帧仍在写入），保留旧水位线等下次。
 */
function appendSession(db, stmts, adapter, file, row, now) {
  const from = row.frame_offset ?? 0;
  const read = adapter.readFrom(file, from);
  if (read === null || read === undefined) return null;
  const { events: fresh, consumed } = read;
  if ((fresh?.length ?? 0) === 0 && consumed === from) return null;

  const sessionId = row.session_id;

  // 压缩语义必须**增量传播**：新事件里出现的替换区间要把旧 events/docs 标成 shadowed。
  // 各源表达不同（DSH 用 surfaceOp，Claude 用 compact_boundary），所以由适配器给出区间。
  const ranges = typeof adapter.shadowRanges === 'function' ? adapter.shadowRanges(fresh) : [];
  for (const [start, end] of ranges) {
    stmts.shadowEvents.run(sessionId, start, end);
    stmts.shadowDocs.run(sessionId, start, end);
  }

  const surface = adapter.surfaceOf(fresh);
  const docs = writeEventsAndDocs(stmts, adapter.id, sessionId, fresh, surface, (event) => adapter.toDocs(event));

  const agg = stmts.agg.get(sessionId);
  // 增量模式下不覆盖会话元数据：upsertSession 用 COALESCE 保留旧值，
  // 只刷新 title（可能刚出现）与聚合计数。header 放在增量里不可靠，
  // 因为很多源只在文件首行写一次 header，尾部追加根本不包含它。
  const title = typeof adapter.titleOf === 'function' ? adapter.titleOf(fresh) : null;
  stmts.upsertSession.run(
    sessionId,
    adapter.id,
    null,
    title,
    null,
    null,
    null,
    agg.c,
    agg.first,
    agg.last,
  );
  stmts.upsertFile.run(file.ref, sessionId, file.size, mtimeOf(file), consumed, agg.c, now);

  return { sessionId, events: fresh.length, docs };
}

/**
 * 重建一个文件；若它的 session id 变了（例如 header 首次可读），顺手清掉旧 id 的孤儿会话。
 */
function reindexFile(db, stmts, adapter, file, now) {
  const previous = stmts.getFile.get(file.ref)?.session_id ?? null;
  const written = rebuildSession(db, stmts, adapter, file, now);
  if (previous && previous !== written.sessionId && !referencedElsewhere(stmts, previous)) {
    stmts.delEvents.run(previous);
    stmts.delDocs.run(previous);
    stmts.delSession.run(previous);
  }
  return written;
}

/**
 * 增量同步索引（唯一写入口）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{root?: string, now?: number, only?: string[]}} [options]
 *   root: 覆盖 DSH 的 sessions 根目录（测试/多实例用）
 *   only: 只扫这些来源 id（缺省=全部已检测到的源）
 * @returns {{filesScanned: number, filesRebuilt: number, filesAppended: number, filesSkipped: number,
 *            sessions: number, events: number, docs: number, errors: string[], ms: number,
 *            sources: string[]}}
 *   sessions/events/docs 是**本次实际写入**的行数（不是库内总量，总量用 stats()）。
 */
export function syncIndex(db, { root, now = Date.now(), only } = {}) {
  const started = performance.now();
  const result = {
    filesScanned: 0,
    filesRebuilt: 0,
    filesAppended: 0,
    filesSkipped: 0,
    sessions: 0,
    events: 0,
    docs: 0,
    errors: [],
    ms: 0,
    sources: [],
  };

  // root 只是**给适配器的提示**（DSH 用它覆盖 sessions 根目录，其它源忽略），
  // 绝不能因为传了 root 就把扫描收窄成 DSH —— 那会让多源索引静默失效。
  const adapters = activeAdapters(only);
  const option = root === undefined ? {} : { root };
  result.sources = adapters.map((adapter) => adapter.id);

  const stmts = prepare(db);
  const disk = [];
  for (const adapter of adapters) {
    let refs = [];
    try {
      refs = adapter.discover(option) ?? [];
    } catch (error) {
      result.errors.push(`${adapter.id}: discover failed: ${error.message}`);
      continue;
    }
    for (const ref of refs) disk.push({ ...ref, adapter });
  }
  // 排序只为确定性（readdir 顺序不保证）。
  disk.sort((left, right) => (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0));
  const diskRefs = new Set(disk.map((file) => file.ref));
  const touchedSessions = new Set();
  result.filesScanned = disk.length;

  for (const file of disk) {
    const { adapter } = file;
    const row = stmts.getFile.get(file.ref);
    const mtime = mtimeOf(file);
    // 硬规则：size+mtime 都没变 → 整文件跳过，一次读取都不做。
    if (row && row.size === file.size && row.mtime === mtime) {
      result.filesSkipped += 1;
      continue;
    }

    try {
      const canAppend =
        row &&
        row.session_id &&
        file.size > row.size &&
        typeof adapter.readFrom === 'function' &&
        (row.frame_offset ?? 0) <= file.size;
      const written = inTransaction(db, () =>
        canAppend ? appendSession(db, stmts, adapter, file, row, now) : reindexFile(db, stmts, adapter, file, now),
      );
      if (canAppend) {
        if (written === null) {
          // 尾部不完整：既不改水位线也不改 size/mtime，下次变化时重试。
          result.filesSkipped += 1;
          continue;
        }
        result.filesAppended += 1;
      } else {
        result.filesRebuilt += 1;
      }
      touchedSessions.add(written.sessionId);
      result.events += written.events;
      result.docs += written.docs;
    } catch (error) {
      result.errors.push(`${file.ref}: ${error.message}`);
    }
  }

  // 消失的文件 → **归档，不删除**。
  //
  // 为什么不是删：agent 工具会定期清理旧会话（Claude Code / Codex 都这样），
  // 而「找回想不起来的对话」恰好最依赖那些已经不在磁盘上的记录。
  // 删掉等于把工具最该记住的那部分抹了 —— 这是从同类项目学到的最重要一条
  // （sessionwiki 的 "archive mode"、cass 的 archive 都在处理同一件事）。
  //
  // 归档后：docs / events 保留 → search 照常命中，show 走 windowFromIndex 重建正文。
  // 代价是索引不自动缩水，所以提供显式的 `cfind index --gc` 清理。
  const vanished = stmts.allFiles.all().filter((row) => !diskRefs.has(row.path) && row.archived !== 1);
  if (vanished.length > 0) {
    try {
      inTransaction(db, () => {
        for (const row of vanished) {
          stmts.archiveFile.run(row.path);
        }
      });
      result.archived = vanished.length;
    } catch (error) {
      result.errors.push(`archive: ${error.message}`);
    }
  }

  // 有文档写入（或清理）才算内容变化：只有 mtime 变化而正文没变的情况不该让缓存失效。
  if (result.docs > 0 || vanished.length > 0) indexVersion += 1;

  result.sessions = touchedSessions.size;
  result.ms = Math.round(performance.now() - started);
  return result;
}

/**
 * 索引统计。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{sessions: number, events: number, docs: number, dbBytes: number, bySource: object}}
 */
export function stats(db) {
  const count = (sql) => Number(db.prepare(sql).get()?.c ?? 0);
  const pageCount = Number(db.prepare('PRAGMA page_count').get()?.page_count ?? 0);
  const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size ?? 0);
  const bySource = {};
  for (const row of db.prepare('SELECT source, COUNT(*) AS c FROM sessions GROUP BY source').all()) {
    bySource[row.source] = Number(row.c);
  }
  return {
    sessions: count('SELECT COUNT(*) AS c FROM sessions'),
    events: count('SELECT COUNT(*) AS c FROM events'),
    docs: count('SELECT COUNT(*) AS c FROM docs'),
    dbBytes: pageCount * pageSize,
    bySource,
    // 已归档（原始文件被工具删除）的文件数。这个数字不该是隐藏的：
    // 它既是"索引为什么不缩水"的解释，也是 `index --gc` 能回收多少的依据。
    archived: count('SELECT COUNT(*) AS c FROM files WHERE archived = 1'),
  };
}

/**
 * 清掉已归档（原始文件已消失）的内容。
 *
 * 归档策略让索引只增不减（见 syncIndex 里的注释），所以必须给一条显式的回收路径。
 * 不做成自动的：用户删掉的是"磁盘上的文件"，不等于"我要忘掉这段对话"——
 * 这两件事只有用户自己能分清。
 *
 * @returns {{sessions: number, docs: number, events: number}}
 */
export function purgeArchived(db) {
  const rows = db.prepare('SELECT path, session_id FROM files WHERE archived = 1').all();
  const result = { sessions: 0, docs: 0, events: 0 };
  if (rows.length === 0) return result;

  const countFiles = db.prepare('SELECT COUNT(*) AS c FROM files WHERE session_id = ? AND archived = 0');
  const delDocs = db.prepare('DELETE FROM docs WHERE session_id = ?');
  const delEvents = db.prepare('DELETE FROM events WHERE session_id = ?');
  const delSession = db.prepare('DELETE FROM sessions WHERE id = ?');
  const delFile = db.prepare('DELETE FROM files WHERE path = ?');

  inTransaction(db, () => {
    for (const row of rows) {
      delFile.run(row.path);
      result.sessions += 1;
      const id = row.session_id;
      if (!id) continue;
      // 同一会话可能还有别的文件（未归档）引用着，那部分内容不能删。
      if ((countFiles.get(id)?.c ?? 0) > 0) continue;
      result.docs += delDocs.run(id).changes ?? 0;
      result.events += delEvents.run(id).changes ?? 0;
      delSession.run(id);
    }
  });
  return result;
}

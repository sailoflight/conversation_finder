// tests/store.test.mjs — 索引器（lib/store.mjs）的契约测试
//
// 用固定 fixture 的**临时副本**做破坏性操作（append/truncate/删除），绝不污染 tests/fixtures。
// 覆盖 CONTRACT §4.1 要求的五种情形：首建 → 空跑跳过 → 追加增量 → 截断重建 → 消失清理。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { openDb } from '../lib/schema.mjs';
import { syncIndex, stats } from '../lib/store.mjs';
import { bigrams, buildMatchQuery } from '../lib/cjk.mjs';
import { readSessionFile } from '../lib/decode.mjs';
import { SESSION_IDS, buildFixture, FIXTURE_DIR, writeSessionFile } from './fixtures/make-fixture.mjs';

const { A, B } = SESSION_IDS;
const T0 = 1794990000000; // 与 make-fixture.mjs 的基准时间一致
const PROJECT = '--tmp-fixture-demo--';
const COPY_PREFIX = 'cfind-store-';

// fixture 是确定性语料；若尚未生成则生成一次（存在时绝不重建，避免踩到别的测试）。
if (!existsSync(FIXTURE_DIR)) buildFixture();

/** fixture 的临时副本（每个测试一份，互不影响）。 */
function copyFixture() {
  const root = mkdtempSync(join(tmpdir(), COPY_PREFIX));
  cpSync(FIXTURE_DIR, root, { recursive: true });
  return root;
}

const fileOf = (root, id) => join(root, PROJECT, id, 'session.v4.jsonl.zstd');
const freshDb = () => openDb(':memory:');
const count = (db, sql, ...params) => Number(db.prepare(sql).get(...params).c);

/** 追加事件：一个事件一帧，模拟真实 DSH 的写入方式。 */
function appendEvents(path, events) {
  const frames = events.map((ev) => zstdCompressSync(Buffer.from(`${JSON.stringify(ev)}\n`, 'utf8')));
  appendFileSync(path, Buffer.concat(frames));
}

/** 在 fixture 副本的会话 A 上追加 4 个事件（含一次压缩，验证增量传播 shadowed）。 */
function newEventsAfterA() {
  return [
    {
      type: 'user/message',
      seq: 8,
      time: T0 + 8000,
      data: { content: [{ type: 'text', text: '增量追加测试标记：新的幂等键逻辑' }] },
    },
    {
      type: 'compaction/summary',
      seq: 9,
      time: T0 + 9000,
      data: { summary: [{ type: 'text', text: '压缩摘要：幂等键已确认。' }] },
    },
    {
      type: 'user/message',
      seq: 10,
      time: T0 + 10000,
      data: { content: [{ type: 'text', text: '<compacted-summary>幂等键</compacted-summary>' }] },
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 },
    },
    { type: 'session/title', seq: 11, time: T0 + 11000, data: { title: '增量后的新标题' } },
  ];
}

test('首建：全量解析 fixture，sessions/events/docs 与会话元数据正确', () => {
  const root = copyFixture();
  const db = freshDb();
  try {
    const result = syncIndex(db, { root });
    assert.equal(result.filesScanned, 2);
    assert.equal(result.filesRebuilt, 2);
    assert.equal(result.filesAppended, 0);
    assert.equal(result.filesSkipped, 0);
    assert.equal(result.sessions, 2);
    assert.equal(result.events, 17); // A: 7 + B: 10
    assert.equal(result.docs, 15); // A: 7 + B: 8
    assert.deepEqual(result.errors, []);
    assert.ok(result.ms >= 0);

    const totals = stats(db);
    assert.equal(totals.sessions, 2);
    assert.equal(totals.events, 17);
    assert.equal(totals.docs, 15);
    assert.ok(totals.dbBytes > 0);

    const files = db.prepare('SELECT path, session_id, size, frame_offset FROM files ORDER BY path').all();
    assert.equal(files.length, 2);
    assert.equal(files[0].session_id, A);
    assert.equal(files[1].session_id, B);
    for (const file of files) {
      // 完整文件：水位线应等于文件大小（帧对齐）
      assert.equal(file.frame_offset, file.size);
      assert.equal(file.size, statSync(file.path).size);
    }

    const a = db.prepare('SELECT * FROM sessions WHERE id = ?').get(A);
    assert.deepEqual(
      {
        id: a.id,
        cwd: a.cwd,
        title: a.title,
        created_at: a.created_at,
        agent_preset: a.agent_preset,
        parent_id: a.parent_id,
        event_count: a.event_count,
        first_time: a.first_time,
        last_time: a.last_time,
      },
      {
        id: A,
        cwd: '/tmp/fixture-demo',
        title: '幂等键与重复扣款排查',
        created_at: T0,
        agent_preset: 'standard',
        parent_id: null, // fixture 无 parentSession
        event_count: 7,
        first_time: T0 + 1000,
        last_time: T0 + 7000,
      },
    );
    const b = db.prepare('SELECT * FROM sessions WHERE id = ?').get(B);
    assert.equal(b.title, '订阅计费与退款对账');
    assert.equal(b.event_count, 10);
    assert.equal(b.last_time, T0 + 100000 + 10000);

    // sh 列必须逐行等于 bigrams(body)。
    for (const row of db.prepare('SELECT body, sh FROM docs').all()) {
      assert.equal(row.sh, bigrams(row.body));
    }

    // fixture 的压缩事务：B 的 seq 3–5 是 shadowed，其余 current。
    const surfaces = db
      .prepare('SELECT seq, surface FROM docs WHERE session_id = ? ORDER BY seq, kind')
      .all(B);
    const shadowed = surfaces.filter((row) => row.surface === 'shadowed').map((row) => row.seq);
    assert.deepEqual([...new Set(shadowed)].sort((x, y) => x - y), [3, 4, 5]);

    // CJK bigram 能命中（查询侧构建的短语直接对 docs 生效）。
    const q = buildMatchQuery('幂等键');
    assert.ok(q.match);
    assert.ok(count(db, 'SELECT COUNT(*) AS c FROM docs WHERE docs MATCH ?', q.match) >= 1);
    const q2 = buildMatchQuery('对账');
    assert.ok(count(db, 'SELECT COUNT(*) AS c FROM docs WHERE docs MATCH ?', q2.match) >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('空跑：size/mtime 未变则整文件跳过，零解码零写入', () => {
  const root = copyFixture();
  const db = freshDb();
  const pathA = fileOf(root, A);
  try {
    syncIndex(db, { root });
    const before = {
      stats: stats(db),
      files: db.prepare('SELECT path, indexed_at, frame_offset FROM files ORDER BY path').all(),
      docs: db.prepare('SELECT session_id, seq, kind, body FROM docs ORDER BY session_id, seq, kind').all(),
    };

    const result = syncIndex(db, { root });
    assert.equal(result.filesScanned, 2);
    assert.equal(result.filesSkipped, 2);
    assert.equal(result.filesRebuilt, 0);
    assert.equal(result.filesAppended, 0);
    assert.equal(result.sessions, 0);
    assert.equal(result.events, 0);
    assert.equal(result.docs, 0);
    assert.deepEqual(result.errors, []);

    assert.deepEqual(stats(db), before.stats);
    assert.deepEqual(db.prepare('SELECT path, indexed_at, frame_offset FROM files ORDER BY path').all(), before.files);

    // 零解码的直接证据：把文件设成不可读，跳过路径仍然成功（若真去读会 EACCES 进 errors）。
    // 以 root 运行时 chmod 挡不住读取，则该断言无意义，直接略过。
    if (process.getuid?.() !== 0) {
      chmodSync(pathA, 0o000);
      try {
        const blocked = syncIndex(db, { root });
        assert.equal(blocked.filesSkipped, 2);
        assert.deepEqual(blocked.errors, []);
        assert.deepEqual(stats(db), before.stats);
      } finally {
        chmodSync(pathA, 0o644);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('追加帧：只解新帧并新增对应文档，压缩语义增量传播', () => {
  const root = copyFixture();
  const db = freshDb();
  const pathA = fileOf(root, A);
  try {
    syncIndex(db, { root });
    const oldSize = statSync(pathA).size;
    const before = stats(db);

    appendEvents(pathA, newEventsAfterA());
    const newSize = statSync(pathA).size;
    assert.ok(newSize > oldSize);

    const result = syncIndex(db, { root });
    assert.equal(result.filesScanned, 2);
    assert.equal(result.filesAppended, 1);
    assert.equal(result.filesSkipped, 1);
    assert.equal(result.filesRebuilt, 0);
    assert.equal(result.sessions, 1); // 只有 A 被触碰
    assert.equal(result.events, 4);
    assert.equal(result.docs, 4);
    assert.deepEqual(result.errors, []);

    // 水位线推进到新文件末尾（帧对齐）。
    const fileRow = db.prepare('SELECT size, frame_offset, event_count FROM files WHERE path = ?').get(pathA);
    assert.equal(fileRow.size, newSize);
    assert.equal(fileRow.frame_offset, newSize);
    assert.equal(fileRow.event_count, 11);

    const after = stats(db);
    assert.equal(after.events, before.events + 4);
    assert.equal(after.docs, before.docs + 4);
    assert.equal(after.sessions, 2);
    assert.equal(after.events, 21);
    assert.equal(after.docs, 19);

    // 只新增了对应文档：A 的文档数 7 -> 11，新标记恰好 1 条。
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM docs WHERE session_id = ?', A), 11);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM docs WHERE body LIKE ?', '%增量追加测试标记%'), 1);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM docs WHERE session_id = ? AND seq = 11', A), 1);

    // 新事件可被 FTS 检索（走 CJK bigram）。
    const q = buildMatchQuery('增量追加测试标记');
    assert.ok(q.match);
    assert.equal(
      count(db, 'SELECT COUNT(*) AS c FROM docs WHERE docs MATCH ? AND session_id = ?', q.match, A),
      1,
    );

    // 会话元数据增量更新：标题取最新、事件数/最后时间推进。
    const a = db.prepare('SELECT title, event_count, first_time, last_time FROM sessions WHERE id = ?').get(A);
    assert.equal(a.title, '增量后的新标题');
    assert.equal(a.event_count, 11);
    assert.equal(a.first_time, T0 + 1000); // 首条时间保持不变
    assert.equal(a.last_time, T0 + 11000);

    // 新事件里的 replace(2,3) 必须把旧 events/docs 标成 shadowed。
    const surfaces = db
      .prepare('SELECT seq, surface FROM docs WHERE session_id = ? ORDER BY seq, kind')
      .all(A);
    const shadowed = new Set(surfaces.filter((row) => row.surface === 'shadowed').map((row) => row.seq));
    assert.deepEqual([...shadowed].sort((x, y) => x - y), [2, 3]);
    for (const row of surfaces.filter((r) => r.seq >= 4)) assert.equal(row.surface, 'current');
    assert.equal(
      db.prepare('SELECT surface FROM events WHERE session_id = ? AND seq = 2').get(A).surface,
      'shadowed',
    );

    // 另一个会话完全没动。
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM docs WHERE session_id = ?', B), 8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('截断/重写：size 变小则清旧行后整文件重建', () => {
  const root = copyFixture();
  const db = freshDb();
  const pathA = fileOf(root, A);
  try {
    syncIndex(db, { root });
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM docs WHERE body LIKE ?', '%landlock partial%'), 1);

    // 只保留 header + title(seq1) + user(seq2)：文件明显变小。
    const { events } = readSessionFile(pathA);
    writeSessionFile(pathA, events.slice(0, 3));
    const newSize = statSync(pathA).size;

    const result = syncIndex(db, { root });
    assert.equal(result.filesRebuilt, 1);
    assert.equal(result.filesAppended, 0);
    assert.equal(result.filesSkipped, 1);
    assert.equal(result.events, 2);
    assert.equal(result.docs, 2);
    assert.deepEqual(result.errors, []);

    const fileRow = db.prepare('SELECT size, frame_offset, event_count FROM files WHERE path = ?').get(pathA);
    assert.equal(fileRow.size, newSize);
    assert.equal(fileRow.frame_offset, newSize);
    assert.equal(fileRow.event_count, 2);

    // A 只剩 title + user 两篇文档，旧内容被真正清掉。
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM docs WHERE session_id = ?', A), 2);
    assert.deepEqual(
      db.prepare('SELECT kind FROM docs WHERE session_id = ? ORDER BY seq').all(A).map((r) => r.kind),
      ['title', 'user'],
    );
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM docs WHERE body LIKE ?', '%landlock partial%'), 0);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM events WHERE session_id = ?', A), 2);
    const a = db.prepare('SELECT title, event_count, last_time FROM sessions WHERE id = ?').get(A);
    assert.equal(a.title, '幂等键与重复扣款排查');
    assert.equal(a.event_count, 2);
    assert.equal(a.last_time, T0 + 2000);

    // 另一个会话保持原样。
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM events WHERE session_id = ?', B), 10);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM docs WHERE session_id = ?', B), 8);
    assert.deepEqual(
      [stats(db).sessions, stats(db).events, stats(db).docs],
      [2, 12, 10],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('消失文件：删除文件后清掉 files 行及孤儿会话', () => {
  const root = copyFixture();
  const db = freshDb();
  try {
    syncIndex(db, { root });
    rmSync(join(root, PROJECT, A), { recursive: true, force: true });

    const result = syncIndex(db, { root });
    assert.equal(result.filesScanned, 1);
    assert.equal(result.filesRebuilt, 0);
    assert.equal(result.filesAppended, 0);
    assert.deepEqual(result.errors, []);

    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM files').get().c, 1);
    assert.equal(db.prepare('SELECT path FROM files').get().path, fileOf(root, B));
    assert.equal(db.prepare('SELECT id FROM sessions').all().length, 1);
    assert.equal(db.prepare('SELECT id FROM sessions').get().id, B);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM events WHERE session_id = ?', A), 0);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM docs WHERE session_id = ?', A), 0);

    const totals = stats(db);
    assert.equal(totals.sessions, 1);
    assert.equal(totals.events, 10);
    assert.equal(totals.docs, 8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('单文件失败：记 errors[] 并继续处理其他文件，不整体崩溃', () => {
  const root = copyFixture();
  const db = freshDb();
  const brokenDir = join(root, PROJECT, 'session-broken-0000');
  try {
    // 在期望是会话文件的位置放一个目录：listSessionFiles 会把它算进去，readFileSync 抛 EISDIR。
    mkdirSync(join(brokenDir, 'session.v4.jsonl.zstd'), { recursive: true });

    const result = syncIndex(db, { root });
    assert.equal(result.filesScanned, 3);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /session-broken-0000/);
    assert.equal(result.filesRebuilt, 2); // A/B 仍然建索引
    assert.equal(result.sessions, 2);
    assert.equal(result.events, 17);
    assert.equal(result.docs, 15);
    const totals = stats(db);
    assert.equal(totals.sessions, 2);
    assert.equal(totals.events, 17);
    assert.equal(totals.docs, 15);
    // 账目平衡：扫描数 = 重建 + 追加 + 跳过 + 失败
    assert.equal(
      result.filesScanned,
      result.filesRebuilt + result.filesAppended + result.filesSkipped + result.errors.length,
    );
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM files'), 2);
    assert.equal(count(db, 'SELECT COUNT(*) AS c FROM files WHERE path LIKE ?', '%session-broken-0000%'), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('会话 id 兜底与 parentSession：header 缺失退回目录名，parent_id 取顶层字段', () => {
  const root = mkdtempSync(join(tmpdir(), COPY_PREFIX));
  const fallbackDirId = 'session-fallback-0001';
  try {
    // 没有 session 事件的会话文件 → 会话 id 退回目录名。
    const noHeaderPath = join(root, '--tmp-fb--', fallbackDirId, 'session.v4.jsonl.zstd');
    writeSessionFile(noHeaderPath, [
      {
        type: 'user/message',
        seq: 1,
        time: T0 + 1000,
        data: { content: [{ type: 'text', text: '目录名兜底的会话标识测试' }] },
      },
    ]);

    // header 带顶层 parentSession / cwd / agentPreset → parent_id 必须落库。
    const childId = 'cccccccc-3333-4333-8333-333333333333';
    const childPath = join(root, '--tmp-fb--', childId, 'session.v4.jsonl.zstd');
    writeSessionFile(childPath, [
      {
        type: 'session',
        version: 4,
        id: childId,
        createdAt: T0 + 5000,
        cwd: '/tmp/fixture-demo',
        parentSession: fallbackDirId,
        isSeeded: false,
        delegationDepth: 1,
        agentPreset: 'research',
      },
      {
        type: 'user/message',
        seq: 1,
        time: T0 + 6000,
        data: { content: [{ type: 'text', text: '子会话：从父会话分叉出来的检索测试' }] },
      },
    ]);

    const db = freshDb();
    const result = syncIndex(db, { root });
    assert.deepEqual(result.errors, []);
    assert.equal(result.filesRebuilt, 2);
    assert.equal(result.sessions, 2);

    const fallback = db.prepare('SELECT * FROM sessions WHERE id = ?').get(fallbackDirId);
    assert.ok(fallback, 'header 缺失时应退回目录名作为会话 id');
    assert.equal(fallback.event_count, 1);
    assert.equal(fallback.cwd, null);

    const child = db.prepare('SELECT * FROM sessions WHERE id = ?').get(childId);
    assert.equal(child.parent_id, fallbackDirId);
    assert.equal(child.cwd, '/tmp/fixture-demo');
    assert.equal(child.created_at, T0 + 5000);
    assert.equal(child.agent_preset, 'research');
    assert.equal(child.event_count, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

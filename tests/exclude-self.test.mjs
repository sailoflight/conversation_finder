// tests/exclude-self.test.mjs — `--exclude-self`（排除调用方自己的会话）
//
// 为什么需要这个功能：cfind 索引的是**会话历史**，而 agent 的每条工具调用都在历史里。
// 所以「用 --all 找别的会话里的知识」时，结果会被自己刚才敲的命令淹没。
//
// 这里不测 mtime 启发式的准确性（那取决于运行时磁盘状态，不可复现），
// 而是测三件确定的事：
//   1. selfSessionId 的优先级：$DSH_SESSION_ID > files 表 mtime 最新；
//   2. scope.exclude 真的把那个会话排除掉了（检索 + outline 都生效）；
//   3. 排除到空是 0 命中，而不是偷偷换范围。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/schema.mjs';
import { search, resolveSessionIds } from '../lib/query.mjs';
import { outline } from '../lib/outline.mjs';
import { selfSessionId, describeScope } from '../lib/paths.mjs';
import { bigrams } from '../lib/cjk.mjs';

const MINE = 'sess-mine-0001';
const OTHER = 'sess-other-0002';

/**
 * 造两个会话：MINE 的 files.mtime 更新（模拟「我正在被写入」）。
 * body 用同一个词，这样「有没有排除」一眼能看出来。
 */
function makeDb() {
  const db = openDb(':memory:');
  const insertSession = db.prepare(
    `INSERT INTO sessions (id, source, cwd, title, created_at, agent_preset, parent_id, event_count, first_time, last_time)
     VALUES (?, 'dsh', '/tmp/x', ?, 1700000000000, null, null, 1, 1700000000000, 1700000000000)`,
  );
  insertSession.run(MINE, '我的会话');
  insertSession.run(OTHER, '别人的会话');

  const insertDoc = db.prepare(
    'INSERT INTO docs (body, sh, source, session_id, seq, kind, time, surface) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertDoc.run('幂等键在这个会话里被讨论了', bigrams('幂等键在这个会话里被讨论了'), 'dsh', MINE, 1, 'user', 1700000000000, 'current');
  insertDoc.run('幂等键在另一个会话里也被讨论了', bigrams('幂等键在另一个会话里也被讨论了'), 'dsh', OTHER, 1, 'user', 1700000001000, 'current');

  const insertFile = db.prepare(
    'INSERT INTO files (path, session_id, size, mtime, frame_offset, event_count, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insertFile.run('/tmp/x/a/session.v4.jsonl.zstd', OTHER, 10, 1_000, 10, 1, 1_000);
  // MINE 的 mtime 更大 → 启发式应当选中它
  insertFile.run('/tmp/x/b/session.v4.jsonl.zstd', MINE, 10, 2_000, 10, 1, 2_000);
  return db;
}

test('selfSessionId: $DSH_SESSION_ID 优先于 mtime 启发式', () => {
  const db = makeDb();
  // mtime 最新的是 MINE，但环境变量说我是 OTHER —— 环境变量更可信
  assert.equal(selfSessionId(db, { DSH_SESSION_ID: OTHER }), OTHER);
  // 没有环境变量（MCP 的真实情况：被 scrub 掉了）→ 回退 mtime 最新
  assert.equal(selfSessionId(db, {}), MINE);
});

test('selfSessionId: 没有 files 记录时返回 undefined 而不是崩', () => {
  const db = openDb(':memory:');
  assert.equal(selfSessionId(db, {}), undefined);
  assert.equal(selfSessionId(undefined, {}), undefined);
});

test('search 排除指定会话；不排除时两个都命中', () => {
  const db = makeDb();
  const scope = { mode: 'all' };

  const all = search(db, { query: '幂等键', scope, limit: 10 });
  assert.equal(all.total, 2);

  const withoutMine = search(db, { query: '幂等键', scope: { ...scope, exclude: [MINE] }, limit: 10 });
  assert.equal(withoutMine.total, 1);
  assert.equal(withoutMine.hits[0].sessionId, OTHER);
});

test('排除在 project 模式下同样生效', () => {
  const db = makeDb();
  const scope = { mode: 'project', cwd: '/tmp/x', exclude: [MINE] };
  const result = search(db, { query: '幂等键', scope, limit: 10 });
  assert.equal(result.total, 1);
  assert.equal(result.hits[0].sessionId, OTHER);
});

test('排除到自己头上：诚实地 0 命中，不偷偷换范围', () => {
  const db = makeDb();
  // 显式只看 MINE，同时又排除 MINE：结果必须是空，而不是"那就给你看看别的吧"
  const result = search(db, { query: '幂等键', scope: { mode: 'session', id: MINE, exclude: [MINE] }, limit: 10 });
  assert.equal(result.total, 0);
  assert.deepEqual(result.hits, []);
});

test('resolveSessionIds / outline 也遵守排除', async () => {
  const db = makeDb();
  const ids = resolveSessionIds(db, { mode: 'all', exclude: [MINE] });
  assert.deepEqual(ids, [OTHER]);

  const result = outline(db, { scope: { mode: 'all', exclude: [MINE] } });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].sessionId, OTHER);
});

test('describeScope 标出排除，避免用户误读作用域', () => {
  assert.equal(describeScope({ mode: 'all' }), 'all sessions');
  assert.match(describeScope({ mode: 'all', exclude: [MINE] }), /−self/);
  assert.match(describeScope({ mode: 'project', cwd: '/tmp/x', exclude: [MINE] }), /−self/);
});

test('exclude 传空数组或非法值等于不排除', () => {
  const db = makeDb();
  for (const exclude of [[], undefined, null, ['', null, 42]]) {
    const result = search(db, { query: '幂等键', scope: { mode: 'all', exclude }, limit: 10 });
    assert.equal(result.total, 2, `exclude=${JSON.stringify(exclude)} 不应改变结果`);
  }
});

test('audit 也遵守 exclude 与 sources（曾经完全没生效）', async () => {
  // 这是一条真实回归：audit 有自己的一套 scopeWhere，早先只认 session/project/all，
  // 于是 `audit --exclude-self` 静默地连自己的会话一起扫了。
  const { audit } = await import('../lib/audit.mjs');
  const db = makeDb();
  const insertDoc = db.prepare(
    'INSERT INTO docs (body, sh, source, session_id, seq, kind, time, surface) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
  insertDoc.run(`key=${secret}`, bigrams(`key=${secret}`), 'dsh', MINE, 2, 'user', 1700000002000, 'current');
  // docs.source 由适配器在写入时落库，与 sessions.source 应保持一致：
  // 两处都改，才能测出「收窄真正作用于扫描面」而不是「筛了个不相干的列」。
  db.prepare("UPDATE sessions SET source = 'claude' WHERE id = ?").run(OTHER);
  db.prepare("UPDATE docs SET source = 'claude' WHERE session_id = ?").run(OTHER);

  const all = audit(db, { scope: { mode: 'all' }, limit: 50 });
  assert.ok(all.findings.length >= 1, '不排除时应扫到我的密钥');

  const withoutMine = audit(db, { scope: { mode: 'all', exclude: [MINE] }, limit: 50 });
  assert.equal(withoutMine.findings.length, 0, '排除我的会话后不应看到我的密钥');
  assert.ok(withoutMine.scanned.sessions < all.scanned.sessions, 'scanned.sessions 必须体现排除');

  const onlyClaude = audit(db, { scope: { mode: 'all', sources: ['claude'] }, limit: 50 });
  assert.equal(onlyClaude.scanned.sessions, 1, 'sources 收窄必须影响扫描面');
});

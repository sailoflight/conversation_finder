// tests/query.test.mjs — search / show 契约测试（只依赖 fixture 合成语料）
//
// 索引直接复用 store.syncIndex（真实索引路径）；会话 A = 无压缩，
// 会话 B = 含一次压缩（seq 3–5 shadowed），会话 C = 噪声事件演示。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../lib/schema.mjs';
import { syncIndex } from '../lib/store.mjs';
import { resolveSessionIds, search, show } from '../lib/query.mjs';
import { buildFixture, writeSessionFile, SESSION_IDS } from './fixtures/make-fixture.mjs';

const HOME = mkdtempSync(join(tmpdir(), 'cfind-query-'));
process.env.DSH_HOME = HOME; // show 的文件发现走 sessionsRoot()，先指向临时语料
const SESSIONS = join(HOME, 'sessions');
buildFixture(SESSIONS);

const C_ID = 'cccccccc-3333-4333-8333-333333333333';

/** 会话 C：窗口里塞满噪声类型，验证 show 默认跳过。 */
function sessionC() {
  const ev = [];
  let seq = 0;
  ev.push({
    type: 'session',
    version: 4,
    id: C_ID,
    createdAt: 1794990000000,
    cwd: '/tmp/fixture-demo',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  });
  seq += 1;
  const add = (type, data) => {
    ev.push({ type, seq, time: 1794990000000 + seq * 1000, data });
    seq += 1;
  };
  add('session/title', { title: '噪声过滤演示' });
  add('user/message', { content: [{ type: 'text', text: '窗口上下文。' }] });
  add('request/header', { tools: [{ name: 'bash' }] });
  add('step/start', { step: 1 });
  add('assistant/message', {
    message: { role: 'assistant', content: [{ type: 'text', text: '可显示的答案。' }] },
  });
  add('step/end', { step: 1 });
  add('turn/end', { reason: { kind: 'completed' } });
  return ev;
}

writeSessionFile(join(SESSIONS, '--tmp-noise-demo--', C_ID, 'session.v4.jsonl.zstd'), sessionC());

const db = openDb(join(HOME, 'index.db'));
syncIndex(db, { root: SESSIONS, only: ['dsh'] });

after(() => {
  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
  rmSync(HOME, { recursive: true, force: true });
});

const SCOPE_A = { mode: 'session', id: SESSION_IDS.A };
const SCOPE_B = { mode: 'session', id: SESSION_IDS.B };

/** score 必须越大越好，且保留 3 位小数。 */
function assertScores(hits) {
  for (let i = 0; i < hits.length; i += 1) {
    const score = hits[i].score;
    assert.ok(score >= 0, `score 应为非负数: ${score}`);
    assert.ok(Math.abs(score * 1000 - Math.round(score * 1000)) < 1e-6, `score 应保留 3 位小数: ${score}`);
    if (i > 0) assert.ok(score <= hits[i - 1].score, 'hits 必须按 score 降序');
  }
}

test('resolveSessionIds: session / project / all', () => {
  assert.deepEqual(resolveSessionIds(db, SCOPE_A), [SESSION_IDS.A]);

  const all = resolveSessionIds(db, { mode: 'all' });
  assert.equal(all.length, 3);
  assert.ok(all.includes(SESSION_IDS.A) && all.includes(SESSION_IDS.B) && all.includes(C_ID));

  const project = resolveSessionIds(db, { mode: 'project', cwd: '/tmp/fixture-demo' });
  assert.equal(project.length, 3);
  assert.deepEqual(resolveSessionIds(db, { mode: 'project', cwd: '/nope' }), []);
});

test('中文 2 字查询真的命中（title + user）', () => {
  const result = search(db, { query: '扣款', scope: SCOPE_A });
  assert.equal(result.total, 2);
  assert.equal(result.hits.length, 2);
  assert.deepEqual(result.hits.map((hit) => hit.kind).sort(), ['title', 'user']);
  for (const hit of result.hits) {
    assert.ok(hit.snippet.includes('扣款'), `片段应含命中词: ${hit.snippet}`);
    assert.ok(hit.snippet.length <= 240);
    assert.equal(hit.short, SESSION_IDS.A.slice(0, 8));
    assert.equal(hit.title, '幂等键与重复扣款排查');
  }
  assertScores(result.hits);
});

test('中文多字查询按 bigram 短语命中', () => {
  const result = search(db, { query: '重复扣款', scope: SCOPE_A });
  assert.equal(result.total, 2);
  assert.deepEqual(result.hits.map((hit) => hit.seq).sort((a, b) => a - b), [1, 2]);
  for (const hit of result.hits) assert.ok(hit.snippet.includes('重复扣款'));
  assertScores(result.hits);
});

test('英文查询命中并可返回 shadowed 文档', () => {
  const result = search(db, { query: 'settlement_id', scope: SCOPE_B });
  assert.equal(result.total, 6);
  assert.equal(result.hits.length, 6);
  for (const hit of result.hits) assert.ok(hit.snippet.includes('settlement_id'));
  assert.ok(result.hits.some((hit) => hit.surface === 'shadowed'));
  assertScores(result.hits);
});

test('单字 CJK 走 LIKE 兜底并手动加括号', () => {
  const result = search(db, { query: '幂', scope: SCOPE_A });
  assert.equal(result.total, 3);
  assert.equal(result.hits.length, 3);
  for (const hit of result.hits) {
    assert.ok(hit.snippet.includes('[幂]'), `LIKE 片段应高亮: ${hit.snippet}`);
    assert.ok(hit.snippet.length <= 240);
  }
  assertScores(result.hits);

  const noReasoning = search(db, { query: '幂', scope: SCOPE_A, includeReasoning: false });
  assert.equal(noReasoning.total, 2);
  assert.deepEqual(noReasoning.hits.map((hit) => hit.kind).sort(), ['title', 'user']);
});

test('includeReasoning=false 过滤 reasoning', () => {
  const all = search(db, { query: '幂等性', scope: SCOPE_A });
  assert.equal(all.total, 1);
  assert.equal(all.hits[0].kind, 'reasoning');

  // 精确匹配下过滤后应为空 —— 关掉模糊才能只看这个事实：
  // 否则 CJK 容错会把「幂等」相关但非 reasoning 的文档也放宽进来（那是对的，见下）。
  const filtered = search(db, { query: '幂等性', scope: SCOPE_A, includeReasoning: false, fuzzy: false });
  assert.equal(filtered.total, 0);
  assert.deepEqual(filtered.hits, []);

  // 开着模糊时：结果允许变多，但**绝不能**出现 reasoning。
  const loosened = search(db, { query: '幂等性', scope: SCOPE_A, includeReasoning: false });
  assert.ok(
    loosened.hits.every((hit) => hit.kind !== 'reasoning'),
    'includeReasoning=false 必须对每一条命中生效，包括模糊放宽产生的结果',
  );
});

test('surface 过滤：current / shadowed 各自可达', () => {
  const shadowed = search(db, { query: 'settlement_id', scope: SCOPE_B, surface: 'shadowed' });
  assert.equal(shadowed.total, 3);
  assert.deepEqual(shadowed.hits.map((hit) => hit.seq).sort((a, b) => a - b), [3, 4, 5]);
  assert.ok(shadowed.hits.every((hit) => hit.surface === 'shadowed'));

  const current = search(db, { query: 'settlement_id', scope: SCOPE_B, surface: 'current' });
  assert.equal(current.total, 3);
  assert.deepEqual(current.hits.map((hit) => hit.seq).sort((a, b) => a - b), [7, 8, 10]);
  assert.ok(current.hits.every((hit) => hit.surface === 'current'));
});

test('核心：被压缩（shadowed）的内容仍能搜到', () => {
  const result = search(db, { query: 'settlement_id', scope: SCOPE_B, includeReasoning: true });
  // seq 3 是压缩前的 reasoning 原文，surface 已是 shadowed，但必须可检索。
  const hit = result.hits.find((item) => item.seq === 3);
  assert.ok(hit, 'shadowed 的 reasoning 文档必须出现在结果里');
  assert.equal(hit.surface, 'shadowed');
  assert.equal(hit.kind, 'reasoning');
  assert.ok(hit.snippet.includes('settlement_id'));

  const toolResult = result.hits.find((item) => item.seq === 5);
  assert.ok(toolResult);
  assert.equal(toolResult.surface, 'shadowed');
});

test('show 取回 shadowed 原始事件与正文', () => {
  const result = show(db, { sessionId: SESSION_IDS.B, seq: 5, before: 2, after: 2 });
  assert.equal(result.sessionId, SESSION_IDS.B);
  assert.equal(result.short, SESSION_IDS.B.slice(0, 8));
  assert.equal(result.title, '订阅计费与退款对账');
  assert.equal(result.cwd, '/tmp/fixture-demo');
  assert.equal(result.target.seq, 5);
  assert.equal(result.target.type, 'tool/result');
  assert.equal(result.target.kind, 'tool-result');

  const target = result.events.find((ev) => ev.isTarget);
  assert.equal(result.events.filter((ev) => ev.isTarget).length, 1);
  assert.equal(target.surface, 'shadowed');
  assert.equal(target.role, 'tool');
  // 原文来自磁盘重放，不是 docs 表拼出来的
  assert.ok(target.text.includes('billing/reconcile.py:17'));
  assert.ok(target.text.includes('settlement_id'));
});

test('show 窗口、角色与边界', () => {
  const result = show(db, { sessionId: SESSION_IDS.A, seq: 5, before: 3, after: 3 });
  assert.deepEqual(result.events.map((ev) => ev.seq), [2, 3, 4, 5, 6, 7]);
  assert.deepEqual(
    result.events.map((ev) => ev.role),
    ['user', 'assistant', 'tool', 'tool', 'assistant', 'event'],
  );
  assert.equal(result.target.kind, 'tool-result');

  const only = show(db, { sessionId: SESSION_IDS.A, seq: 3, before: 0, after: 0 });
  assert.deepEqual(only.events.map((ev) => ev.seq), [3]);
  assert.equal(only.events[0].role, 'assistant');

  assert.throws(() => show(db, { sessionId: 'deadbeef', seq: 1 }), /session file not found/);
  assert.throws(
    () => show(db, { sessionId: SESSION_IDS.A, seq: 999 }),
    /event seq not found/,
  );
});

test('show 默认跳过噪声事件（target 例外）', () => {
  const result = show(db, { sessionId: C_ID, seq: 5, before: 3, after: 3 });
  assert.deepEqual(result.events.map((ev) => ev.seq), [2, 5, 7]);
  const target = result.events.find((ev) => ev.isTarget);
  assert.equal(target.text, '可显示的答案。');
  assert.equal(target.role, 'assistant');
});

// ── 默认语义 = grep 正则 ────────────────────────────────────────────────

test('默认：交替真的"或"（不是被切成 AND）', () => {
  // 关键词索引会把 `foo|bar` 当分隔符切成 `foo AND bar`，与 grep 预期相反，
  // 而且不报错 —— 这种"静默地做了别的事"是最坏的一类行为。
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO sessions (id, source, cwd, title, created_at, agent_preset, parent_id, event_count, first_time, last_time)
     VALUES ('g-1', 'dsh', '/tmp', 't', 1700000000000, null, null, 0, 1700000000000, 1700000000000)`,
  ).run();
  const insert = db.prepare(
    'INSERT INTO docs (body, sh, source, session_id, seq, kind, time, surface) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const add = (seq, body) => insert.run(body, body, 'dsh', 'g-1', seq, 'user', 1700000000000 + seq, 'current');
  add(1, 'alpha 的内容');
  add(2, 'beta 的内容');
  add(3, 'gamma 的内容');

  const scope = { mode: 'session', id: 'g-1' };
  const only = (query) => search(db, { query, scope, limit: 10 }).total;

  assert.equal(only('alpha'), 1);
  // 交替 = 或：两个都该出现
  assert.equal(only('alpha|beta'), 2, '交替必须是真的"或"');
  // 锚点按行
  assert.equal(only('^alpha'), 1);
  assert.equal(only('^beta'), 1);
  // 元字符真的生效
  assert.equal(only('a.*内容'), 3);
  // 完全没有：必须 0，不做任何替换
  assert.equal(only('zzz_不存在_qqq'), 0);
});

test('默认：不区分大小写（与 grep 的唯一刻意差异）', () => {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO sessions (id, source, cwd, title, created_at, agent_preset, parent_id, event_count, first_time, last_time)
     VALUES ('g-2', 'dsh', '/tmp', 't', 1700000000000, null, null, 0, 1700000000000, 1700000000000)`,
  ).run();
  db.prepare(
    'INSERT INTO docs (body, sh, source, session_id, seq, kind, time, surface) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('The Settlement Process Runs Nightly', 'x', 'dsh', 'g-2', 1, 'user', 1700000000001, 'current');
  const scope = { mode: 'session', id: 'g-2' };
  assert.equal(search(db, { query: 'settlement', scope, limit: 5 }).total, 1);
  assert.equal(search(db, { query: 'SETTLEMENT', scope, limit: 5 }).total, 1);
});

test('默认：正则语法错误要干净报错，不吐堆栈', () => {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO sessions (id, source, cwd, title, created_at, agent_preset, parent_id, event_count, first_time, last_time)
     VALUES ('g-3', 'dsh', '/tmp', 't', 1700000000000, null, null, 0, 1700000000000, 1700000000000)`,
  ).run();
  db.prepare(
    'INSERT INTO docs (body, sh, source, session_id, seq, kind, time, surface) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('x', 'x', 'dsh', 'g-3', 1, 'user', 1700000000001, 'current');
  assert.throws(
    () => search(db, { query: '未闭合(', scope: { mode: 'session', id: 'g-3' }, limit: 5 }),
    (error) => {
      assert.match(error.message, /正则/);
      assert.equal(error.userFacing, true, '参数类错误要给用户看人话');
      return true;
    },
  );
});

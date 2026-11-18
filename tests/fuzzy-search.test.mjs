// tests/fuzzy-search.test.mjs — 检索层的模糊级联 / 去重 / 精简输出
//
// tests/fuzzy.test.mjs 验的是纯函数；这里验的是**接进 search() 之后**的行为：
// 精确命中不该被放宽污染、拼错能救回、完全不存在的词不能无中生有。
//
// 用内存库 + 直接插 docs，避免依赖真实会话语料（那玩意会随会话增长而变，
// 而且我们自己敲的命令也会被索引进去，写死的测试串下一刻就可能真的存在）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/schema.mjs';
import { search } from '../lib/query.mjs';
import { bigrams } from '../lib/cjk.mjs';
import { renderHits, renderOutline } from '../lib/format.mjs';

const SESSION = 'sess-fuzzy-0001';

/** 造一个只含指定正文的库。每行一条 doc，同 session，seq 递增。 */
function makeDb(bodies) {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO sessions (id, source, cwd, title, created_at, agent_preset, parent_id, event_count, first_time, last_time)
     VALUES (?, 'dsh', '/tmp/fuzzy', '模糊测试会话', 1700000000000, null, null, ?, 1700000000000, 1700000100000)`,
  ).run(SESSION, bodies.length);
  const insert = db.prepare(
    'INSERT INTO docs (body, sh, source, session_id, seq, kind, time, surface) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  bodies.forEach((body, index) => {
    insert.run(body, bigrams(body), 'dsh', SESSION, index + 1, 'user', 1700000000000 + index, 'current');
  });
  return db;
}

const scope = { mode: 'all' };

test('精确命中时不触发模糊级联', () => {
  const db = makeDb(['the settlement_id field is required', 'unrelated text here']);
  const result = search(db, { query: 'settlement_id', scope, limit: 5 });
  assert.ok(result.total > 0);
  // 关键：精确命中就该原样返回，不该多此一举地去纠错（那会把别的词拉进来）
  assert.equal(result.fuzzy, undefined);
});

test('拼错一个字母仍能搜到（纠错路径）', () => {
  const db = makeDb(['we must reconcile the ledger carefully', 'another document']);
  const broken = search(db, { query: 'reconclie', scope, limit: 5 }, );
  const exactOnly = search(db, { query: 'reconclie', scope, limit: 5, fuzzy: false });
  assert.equal(exactOnly.total, 0, '精确匹配本来搜不到');
  assert.ok(broken.total > 0, '纠错后应当搜到');
  assert.equal(broken.fuzzy?.what, 'spelling');
  assert.match(broken.fuzzy.applied, /reconclie→reconcile/);
});

test('只记得词头也能搜到（前缀路径）', () => {
  const db = makeDb(['the settlement process runs nightly', 'another document']);
  const result = search(db, { query: 'settle', scope, limit: 5 });
  assert.equal(search(db, { query: 'settle', scope, limit: 5, fuzzy: false }).total, 0);
  assert.ok(result.total > 0);
  assert.equal(result.fuzzy?.what, 'prefix');
});

test('完全不存在的词不无中生有', () => {
  const db = makeDb(['some ordinary content about ledgers', 'more text']);
  const result = search(db, { query: 'zqxjvbkwnplm', scope, limit: 5 });
  assert.equal(result.total, 0);
  assert.equal(result.fuzzy, undefined, '救不回来时不应编造层级说明');
});

test('fuzzy:false 只做精确匹配', () => {
  const db = makeDb(['we must reconcile the ledger carefully']);
  assert.equal(search(db, { query: 'reconclie', scope, limit: 5, fuzzy: false }).total, 0);
  assert.ok(search(db, { query: 'reconclie', scope, limit: 5, fuzzy: true }).total > 0);
});

test('近似重复命中被折叠，且 collapsed 如实上报', () => {
  const same = 'settlement_id is the idempotency key for settlement records';
  const db = makeDb([same, same, 'a completely different sentence about payments']);
  const raw = search(db, { query: 'settlement_id', scope, limit: 10, dedupe: false });
  const folded = search(db, { query: 'settlement_id', scope, limit: 10, dedupe: true });
  assert.equal(raw.collapsed, undefined, '关闭折叠时不应有 collapsed 字段');
  assert.ok(folded.collapsed > 0, '重复内容应被折叠');
  assert.equal(folded.total, raw.total, 'total 必须保持原始命中数，不能悄悄变小');
  assert.ok(folded.hits.length < raw.hits.length);
});

test('terse 输出省掉排版，但不丢可定位信息', () => {
  const db = makeDb([
    'settlement_id 是幂等键的第一步',
    'settlement_id 还出现在对账脚本里',
  ]);
  const result = search(db, { query: 'settlement_id', scope, limit: 5 });
  const normal = renderHits(result, { scope: 'all sessions', maxChars: 0 });
  const terse = renderHits(result, { scope: 'all sessions', maxChars: 0, terse: true });

  assert.ok(terse.length < normal.length, 'terse 应当更短');
  assert.doesNotMatch(terse, /^scope:/m, 'terse 不应有 scope 首行');
  // 每个命中仍然带着「哪个会话 + 第几条」，否则 agent 没法接着调 show
  for (const hit of result.hits) {
    assert.ok(terse.includes(`${hit.short}#${hit.seq}`), `缺少定位信息 ${hit.short}#${hit.seq}`);
  }
});

test('terse 会把「结果被放宽过」说出来', () => {
  const db = makeDb(['we must reconcile the ledger carefully']);
  const result = search(db, { query: 'reconclie', scope, limit: 5 });
  const terse = renderHits(result, { scope: 'all sessions', maxChars: 0, terse: true });
  assert.match(terse, /spelling→/, '放宽事实必须可见，否则用户会以为这就是精确结果');
});

test('outline 的 terse 省略 scope 首行', () => {
  const result = { sessions: [] };
  const normal = renderOutline(result, { scope: 'all sessions', maxChars: 0 });
  const terse = renderOutline(result, { scope: 'all sessions', maxChars: 0, terse: true });
  assert.match(normal, /^scope:/);
  assert.doesNotMatch(terse, /^scope:/);
});

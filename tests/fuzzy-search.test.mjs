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
import { hitNotes, renderHits, renderOutline } from '../lib/format.mjs';

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

test('默认输出就是 grep 形状，逐行可定位', () => {
  const db = makeDb([
    'settlement_id 是幂等键的第一步',
    'settlement_id 还出现在对账脚本里',
  ]);
  const result = search(db, { query: 'settlement_id', scope, limit: 5 });
  const out = renderHits(result, { scope: 'all sessions', maxChars: 0 });
  // 每个命中都带着「哪个会话 + 第几条」，agent 能直接接着调 show
  for (const hit of result.hits) {
    assert.ok(out.includes(`${hit.short}:${hit.seq}:`), `缺少定位信息 ${hit.short}:${hit.seq}`);
  }
  // 没有装饰性首行，管道直接用
  assert.ok(!out.includes('scope:'));
  assert.equal(out.split('\n').length, result.hits.length);
});

test('「结果被放宽过」通过 hitNotes 汇报，而不是塞进结果行', () => {
  const db = makeDb(['we must reconcile the ledger carefully']);
  const result = search(db, { query: 'reconclie', scope, limit: 5 });
  // 结果行保持纯净（grep 形状）
  const out = renderHits(result, { scope: 'all sessions', maxChars: 0 });
  assert.doesNotMatch(out, /spelling/);
  // 但放宽这件事必须让调用方知道 —— 否则会以为这就是精确结果
  assert.match(hitNotes(result, { shown: 1 }).join(' '), /spelling→/);
});

test('outline 默认省略 scope 首行（与 renderHits 同一原则）', () => {
  const result = { sessions: [] };
  const plain = renderOutline(result, { scope: 'all sessions', maxChars: 0 });
  const rich = renderOutline(result, { scope: 'all sessions', maxChars: 0, verbose: true });
  assert.doesNotMatch(plain, /^scope:/);
  assert.match(rich, /^scope:/);
});

test('中文尾字写错仍能召回（CJK 容错级）', () => {
  // 回归：早先的模糊级联全是拉丁逻辑 —— prefix 对 CJK 返回同构短语、
  // 拼写纠错只认拉丁、OR 放宽对单条 CJK 也返回短语，等于**对中文完全无效**。
  const db = makeDb(['最初指令：先预研究一个会话检索项目、还要支持涉密检查']);
  const typo = search(db, { query: '预研旧', scope, limit: 5 });
  assert.equal(search(db, { query: '预研旧', scope, limit: 5, fuzzy: false }).total, 0, '精确匹配本来搜不到');
  assert.ok(typo.total > 0, '尾字写错应被 CJK 容错救回');
  assert.equal(typo.fuzzy?.what, 'cjk-loose');
});

test('中文容错不会把长查询放宽（防止噪音）', () => {
  // 「会话冗余项目」是 5 个 bigram：共享一个 bigram 不构成证据，必须整体命中。
  // 若这里放宽成 OR，任何含「会话」的文档都会命中 —— 那就等于放弃精确性。
  const db = makeDb(['关于会话检索项目的讨论', '另一个只提到会话的文档']);
  const long = search(db, { query: '会话冗余项目', scope, limit: 5 });
  assert.notEqual(long.fuzzy?.what, 'cjk-loose', '长查询不该走 CJK 容错');
  assert.equal(long.total, 0, '长查询救不回来时应当诚实返回 0');

  // 同样 5 个 bigram 的精确查询当然要能命中
  assert.ok(search(db, { query: '会话检索项目', scope, limit: 5 }).total > 0);
});

test('CJK 容错与 surface=shadowed 组合可用（召回场景）', () => {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO sessions (id, source, cwd, title, created_at, agent_preset, parent_id, event_count, first_time, last_time)
     VALUES ('sess-cjk-0001', 'dsh', '/tmp', 't', 1700000000000, null, null, 2, 1700000000000, 1700000000000)`,
  ).run();
  const insert = db.prepare(
    'INSERT INTO docs (body, sh, source, session_id, seq, kind, time, surface) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insert.run('最初指令：先预研究一个项目', bigrams('最初指令：先预研究一个项目'), 'dsh', 'sess-cjk-0001', 1, 'user', 1700000000000, 'shadowed');
  insert.run('现在的进度是模糊搜索', bigrams('现在的进度是模糊搜索'), 'dsh', 'sess-cjk-0001', 2, 'user', 1700000001000, 'current');

  const recalled = search(db, { query: '预研旧', scope: { mode: 'session', id: 'sess-cjk-0001' }, limit: 5, surface: 'shadowed' });
  assert.ok(recalled.total > 0);
  assert.ok(recalled.hits.every((hit) => hit.surface === 'shadowed'));
});

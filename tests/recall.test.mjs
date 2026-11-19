// tests/recall.test.mjs — 「召回被压缩掉的记忆」
//
// 这个文件锁住的是项目最核心的价值主张，也是最容易被误实现的地方：
//
//   压缩之后，模型能看到的是「摘要 + 压缩之后的新消息」（surface=current）。
//   那些内容**它本来就有**，再搜一遍是浪费。真正想不起来的，
//   恰恰是被压缩掉的那一半（surface=shadowed）。
//
// 所以 recall 与 search 的唯一区别就是 surface 固定为 shadowed。
// 这个语义必须钉死，否则「召回」会退化成「再搜一遍我已经看得见的东西」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/schema.mjs';
import { search } from '../lib/query.mjs';
import { bigrams } from '../lib/cjk.mjs';

const SESSION = 'sess-recall-0001';

/**
 * 造一个「压缩过」的会话：
 *   seq 1–3 是压缩前的历史（shadowed），seq 4 是摘要，seq 5–6 是压缩后的新消息（current）。
 * 这个形状和真实 DSH 会话一致（真实样本里 shadowed 占 56%）。
 */
function makeDb() {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO sessions (id, source, cwd, title, created_at, agent_preset, parent_id, event_count, first_time, last_time)
     VALUES (?, 'dsh', '/tmp/recall', '压缩测试', 1700000000000, null, null, 6, 1700000000000, 1700000006000)`,
  ).run(SESSION);
  const insert = db.prepare(
    'INSERT INTO docs (body, sh, source, session_id, seq, kind, time, surface) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const rows = [
    // 压缩前：用户最初下达的指令 —— 这正是「想不起来」时要召回的东西
    [1, 'user', '最初指令：先预研究一个会话检索项目', 'shadowed'],
    [2, 'assistant', '明白，我来做预研究。', 'shadowed'],
    [3, 'user', '补充：还要能查涉密内容', 'shadowed'],
    // 摘要（本身是 current）
    [4, 'compaction', '摘要：用户要求做会话检索项目，并支持涉密检查。', 'current'],
    // 压缩后：模型看得见
    [5, 'user', '现在把模糊搜索做掉', 'current'],
    [6, 'assistant', '模糊搜索已完成。', 'current'],
  ];
  for (const [seq, kind, body, surface] of rows) {
    insert.run(body, bigrams(body), 'dsh', SESSION, seq, kind, 1700000000000 + seq * 1000, surface);
  }
  return db;
}

const scope = { mode: 'session', id: SESSION };

test('recall 只返回 shadowed，search 默认返回全部', () => {
  const db = makeDb();
  // 「预研究」这个词只出现在被压缩掉的 #1 里 → 两种都该命中
  assert.ok(search(db, { query: '预研究', scope, limit: 10 }).total > 0);
  const recalled = search(db, { query: '预研究', scope, limit: 10, surface: 'shadowed' });
  assert.ok(recalled.total > 0);
  assert.ok(recalled.hits.every((hit) => hit.surface === 'shadowed'));
});

test('召回能拿回「最初下达的指令」', () => {
  const db = makeDb();
  const recalled = search(db, { query: '最初指令', scope, limit: 10, surface: 'shadowed' });
  assert.equal(recalled.total, 1);
  const hit = recalled.hits[0];
  assert.equal(hit.seq, 1);
  assert.equal(hit.kind, 'user');
  assert.match(hit.snippet, /预研究/);
});

test('压缩后的新内容不会被误当成召回结果', () => {
  const db = makeDb();
  // 「模糊搜索」只在压缩后出现（#5/#6）→ shadowed 里必然为 0
  const recalled = search(db, { query: '模糊搜索', scope, limit: 10, surface: 'shadowed' });
  assert.equal(recalled.total, 0, '还没被压缩掉的内容不该出现在召回结果里');
  // 但普通 search 能搜到 —— 这说明它不是"没有"，只是"还看得见"
  assert.ok(search(db, { query: '模糊搜索', scope, limit: 10 }).total > 0);
});

test('surface=current 与 shadowed 互补，加起来等于 all', () => {
  const db = makeDb();
  const all = search(db, { query: '的', scope, limit: 50 });
  const cur = search(db, { query: '的', scope, limit: 50, surface: 'current' });
  const sha = search(db, { query: '的', scope, limit: 50, surface: 'shadowed' });
  assert.equal(cur.total + sha.total, all.total, 'current + shadowed 必须恰好覆盖全部');
  // 两边不相交
  const curSeqs = new Set(cur.hits.map((hit) => hit.seq));
  assert.ok(sha.hits.every((hit) => !curSeqs.has(hit.seq)));
});

test('召回也走模糊级联（记错词也能想起来）', () => {
  const db = makeDb();
  // 「预研旧」是错字，但应通过纠错/前缀召回 #1
  const recalled = search(db, { query: '预研旧', scope, limit: 10, surface: 'shadowed', fuzzy: true });
  assert.ok(recalled.total > 0, '召回路径不能绕过模糊匹配');
  assert.ok(recalled.hits.every((hit) => hit.surface === 'shadowed'));
});

test('没有压缩过的会话：召回为空且不应崩', () => {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO sessions (id, source, cwd, title, created_at, agent_preset, parent_id, event_count, first_time, last_time)
     VALUES ('fresh-0001', 'dsh', '/tmp', '新会话', 1700000000000, null, null, 1, 1700000000000, 1700000000000)`,
  ).run();
  db.prepare(
    'INSERT INTO docs (body, sh, source, session_id, seq, kind, time, surface) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('刚写的消息', bigrams('刚写的消息'), 'dsh', 'fresh-0001', 1, 'user', 1700000000000, 'current');

  const recalled = search(db, { query: '刚写的', scope: { mode: 'session', id: 'fresh-0001' }, limit: 10, surface: 'shadowed' });
  assert.equal(recalled.total, 0);
  assert.deepEqual(recalled.hits, []);
});

test('默认排除上一次压缩之前（CLI/MCP 的默认值是 current）', () => {
  // 语义：把压缩前的内容当成"归档日志"。grep 搜现存文件，要搜归档得显式说 ——
  // 这条默认就是照这个直觉定的。
  // 断言放在 CLI 与 MCP 的默认解析上（query 层本身仍允许 'all'）。
  const db = makeDb();

  // 压缩前的 #1 在默认视角下不该出现
  const asDefault = search(db, { query: '最初指令', scope, limit: 10, surface: 'current' });
  assert.equal(asDefault.total, 0, '默认（current）看不到压缩前的指令');

  // 想找它必须显式 recall
  const asRecall = search(db, { query: '最初指令', scope, limit: 10, surface: 'shadowed' });
  assert.ok(asRecall.total > 0, 'recall 才能看到压缩前的指令');

  // 两者相加恰好是全部（保证默认没有"多丢"）
  const asAll = search(db, { query: '最初指令', scope, limit: 10, surface: 'all' });
  assert.equal(asAll.total, asDefault.total + asRecall.total);
});

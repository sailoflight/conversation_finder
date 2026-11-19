// tests/engine.test.mjs — 引擎选择不能改变结果
//
// 这是整个 index 加速的唯一契约：**引擎只影响速度，不影响答案**。
// 索引（trigram / CJK bigram）只用来缩小候选集，最终判定永远由正则做。
// 所以这里的原则很简单：同一条 pattern，开索引和关索引，结果必须逐条相同。
//
// 为什么这条这么重要：agent 用 cfind 得到的是"证据"。如果换台机器
// （大库有索引、小库没索引）答案就不一样，那这个工具就没法用来下结论。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../lib/schema.mjs';
import { search } from '../lib/query.mjs';
import { setIndexEnabled } from '../lib/grep.mjs';
import { candidates, hasTrigramIndex, planLiteral } from '../lib/engine.mjs';

const SCOPE = { mode: 'all' };

/**
 * 造一个够复杂的语料：中英混排、CJK 2/3/4 字、稀疏与稠密混合、
 * 以及"看起来像命中其实不是"的近似串（验证索引候选必须被正则剔除）。
 */
function makeDb() {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO sessions (id, source, cwd, title, created_at, agent_preset, parent_id, event_count, first_time, last_time)
     VALUES ('e-1', 'dsh', '/tmp', 't', 1700000000000, null, null, 0, 1700000000000, 1700000000000)`,
  ).run();
  const insert = db.prepare(
    'INSERT INTO docs (body, sh, source, session_id, seq, kind, time, surface) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const tri = db.prepare('INSERT INTO docs_tri (rowid, body) VALUES (?, ?)');
  const last = db.prepare('SELECT last_insert_rowid() AS r');

  const bodies = [
    'settlement_id 是幂等键的一部分',
    'settlement_id 的另一个用法',
    // 近似串：含 settlement 与 id，但不是 settlement_id
    'settlement id 中间有空格，不该命中 settlement_id',
    'settlementXid 也不该命中',
    '幂等键与重复扣款排查',
    '幂等性设计说明',
    '缓存加速是关键优化手段',
    '限流与超时处理',
    'plain english text about routing',
    'routing table 与 settlement 相关',
    '压缩之后的记录也能搜到',
  ];
  bodies.forEach((body, index) => {
    insert.run(body, bigramsOf(body), 'dsh', 'e-1', index + 1, 'user', 1700000000000 + index, 'current');
    tri.run(last.get().r, body);
  });
  return db;
}

/** 与生产代码同一套 bigram 切法（避免测试与实现漂移）。 */
function bigramsOf(text) {
  const out = [];
  for (const run of String(text).matchAll(/[\u4e00-\u9fff]+/g)) {
    for (let i = 0; i < run[0].length - 1; i += 1) out.push(run[0].slice(i, i + 2));
  }
  return out.join(' ');
}

const patterns = [
  // 拉丁
  'settlement_id',
  'settlement',
  'settle',
  'routing',
  'xyz_不存在',
  // 近似串必须靠正则剔除，索引候选是超集
  'settlement id',
  'settlementXid',
  // CJK 2 字（走 bigram 索引）
  '幂等',
  '缓存',
  '限流',
  // CJK 3 字（走 trigram）
  '幂等键',
  '缓存加',
  // CJK 短语
  '压缩之后',
  // 交替
  '幂等键|routing',
  'settlement_id|缓存',
  // 含元字符（必须全表扫，不能走索引）
  'set.*id',
  '幂等.*设计',
  '^plain',
];

test('引擎：开索引与关索引结果逐条一致', () => {
  const db = makeDb();
  try {
    for (const pattern of patterns) {
      setIndexEnabled(true);
      const indexed = search(db, { query: pattern, scope: SCOPE, limit: 100 });
      setIndexEnabled(false);
      const scanned = search(db, { query: pattern, scope: SCOPE, limit: 100 });

      assert.equal(indexed.total, scanned.total, `「${pattern}」总数不一致：索引 ${indexed.total} vs 全扫 ${scanned.total}`);
      assert.deepEqual(
        indexed.hits.map((hit) => hit.seq),
        scanned.hits.map((hit) => hit.seq),
        `「${pattern}」命中序列不一致`,
      );
      assert.deepEqual(
        indexed.hits.map((hit) => hit.snippet),
        scanned.hits.map((hit) => hit.snippet),
        `「${pattern}」片段不一致（片段也必须是引擎无关的）`,
      );
    }
  } finally {
    setIndexEnabled(true);
    db.close();
  }
});

test('引擎：索引候选必须被正则剔除（超集不能当答案）', () => {
  const db = makeDb();
  try {
    // `settlement_id` 的 trigram 候选会包含 `settlement id`（空格版）吗？
    // 不一定，但 `settle` 的候选一定包含所有 settlement* —— 必须靠验证剔除。
    const picked = candidates(db, 'settle', { where: '1 = 1', params: [] });
    assert.ok(picked !== null, 'settle 应当能走索引');
    const rows = db
      .prepare(
        `SELECT body FROM docs WHERE rowid IN (${picked.rowids.map(() => '?').join(',')})`,
      )
      .all(...picked.rowids)
      .map((row) => row.body);
    // 候选里有不含 settle 的行（索引是超集）—— 但最终结果里不能有
    setIndexEnabled(true);
    const result = search(db, { query: 'settle', scope: SCOPE, limit: 100 });
    for (const hit of result.hits) {
      assert.match(hit.snippet.toLowerCase(), /settle/, '最终结果必须真的含 pattern');
    }
  } finally {
    setIndexEnabled(true);
    db.close();
  }
});

test('引擎：含正则元字符的 pattern 不走索引', () => {
  const db = makeDb();
  try {
    for (const pattern of ['set.*id', '^plain', '幂等|缓存', '(a)+']) {
      const picked = candidates(db, pattern, { where: '1 = 1', params: [] });
      // `幂等|缓存` 是纯字面交替，允许走索引；其余含真元字符必须返回 null
      if (pattern === '幂等|缓存') continue;
      assert.equal(picked, null, `「${pattern}」含元字符，必须全表扫`);
    }
  } finally {
    db.close();
  }
});

test('引擎：纯字面交替走索引，且一条字面用不了就整体退回', () => {
  const db = makeDb();
  try {
    const ok = candidates(db, '幂等键|routing', { where: '1 = 1', params: [] });
    assert.ok(ok !== null, '两条都能走索引时应返回候选');
    assert.ok(ok.rowids.length > 0);

    // `x` 太短（<3 且非中文）走不了索引 → 整体必须退回扫描，
    // 否则会漏掉 `x` 的命中。
    const mixed = candidates(db, '幂等键|xy', { where: '1 = 1', params: [] });
    assert.equal(mixed, null, '有一条走不了索引就必须整体退回，否则漏命中');
  } finally {
    db.close();
  }
});

test('引擎：planLiteral 按 pattern 形态选通路', () => {
  const db = makeDb();
  try {
    assert.equal(hasTrigramIndex(db), true, '新库必须有 trigram 索引');
    // CJK 2 字 → bigram 列（trigram 需要 ≥3 字符）
    assert.equal(planLiteral(db, '幂等').engine, 'bigram');
    // CJK 3 字 → trigram
    assert.equal(planLiteral(db, '幂等键').engine, 'trigram');
    // 拉丁 ≥3 → trigram
    assert.equal(planLiteral(db, 'settlement').engine, 'trigram');
    // 太短且非中文 → 无索引可用
    assert.equal(planLiteral(db, 'xy').engine, null);
  } finally {
    db.close();
  }
});

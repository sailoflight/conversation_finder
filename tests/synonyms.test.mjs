// tests/synonyms.test.mjs — 同义扩展：效果与护栏
//
// 这个模块的风险不对称：
//   漏掉一个同义词 → 用户多搜一次，无损失；
//   错误地扩展     → 返回一堆无关命中，比搜不到更糟（还得逐条排除）。
// 所以测试的重点是**护栏**，而不是覆盖率。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/schema.mjs';
import { search } from '../lib/query.mjs';
import { bigrams } from '../lib/cjk.mjs';
import { expandSynonyms, lookupSynonyms, SYNONYM_GROUPS, MAX_EXPANSIONS } from '../lib/synonyms.mjs';

/**
 * 受控语料：每条文档只谈一个概念，语言里**不含**要测的罕见说法。
 *
 * 为什么不读 `tests/fixtures/sessions`：那份语料是为别的东西造的，
 * 同义词效果需要「概念 ↔ 说法」的精确对应，只有现造才能自动判定精度。
 */
function makeCorpus() {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO sessions (id, source, cwd, title, created_at, agent_preset, parent_id, event_count, first_time, last_time)
     VALUES ('syn-1', 'dsh', '/tmp/syn', '同义词语料', 1700000000000, null, null, 0, 1700000000000, 1700000000000)`,
  ).run();
  const insert = db.prepare(
    'INSERT INTO docs (body, sh, source, session_id, seq, kind, time, surface) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const owner = new Map();
  let seq = 1;
  const add = (concept, texts) => {
    for (const text of texts) {
      insert.run(text, bigrams(text), 'dsh', 'syn-1', seq, 'user', 1700000000000 + seq, 'current');
      owner.set(seq, concept);
      seq += 1;
    }
  };
  add('超时', ['请求超时后重试了三次', '连接超时，需要加大上限', '超时阈值设为 30 秒']);
  add('限流', ['接口加了限流，每秒 10 次', '触发限流后返回 429', '限流窗口滑动计算']);
  add('递归', ['递归遍历目录树', '递归层级过深会爆栈', '递归的终止条件写错会溢出']);
  add('去重', ['对结果做去重处理', '去重后再写入数据库', '去重逻辑放在写入之前']);
  add('报错', ['这里报错是因为类型不匹配', '报错信息里带堆栈', '抛错时要保留原始原因']);
  // 干扰概念：故意让"通用词"出现在这里，检验护栏不会把它们当同义词
  add('干扰', ['我们同时做了两件事', '同时触发两个流程', '重复调用没有副作用']);
  return { db, owner };
}

const SCOPE = { mode: 'session', id: 'syn-1' };

test('lookupSynonyms：组内互为同义，不含自己', () => {
  assert.deepEqual(lookupSynonyms('超时').sort(), ['响应慢', '等待太久'].sort());
  assert.deepEqual(lookupSynonyms('等待太久').sort(), ['响应慢', '超时'].sort());
  // 表里没有的词不编造
  assert.deepEqual(lookupSynonyms('紫色的大象'), []);
  assert.deepEqual(lookupSynonyms(''), []);
  // 表里刻意不收跨语言对（超时↔timeout）：那是"翻译"不是"同义词"，
  // 混进来会把频率护栏撑松。这条断言防止有人顺手加回去。
  assert.deepEqual(lookupSynonyms('timeout'), []);
  assert.deepEqual(lookupSynonyms('超时').filter((t) => /^[a-z]/i.test(t)), []);
});

test('每组内部不得重复，也不得把一个词放进两组以上', () => {
  const seen = new Map();
  for (const group of SYNONYM_GROUPS) {
    for (const term of group) {
      const key = term.toLowerCase();
      // 同一词出现在两组会让扩展方向变得不确定（先匹配到哪组就只扩哪组）。
      assert.ok(!seen.has(key), `「${term}」同时出现在两组：${seen.get(key)} 与 ${group.join('/')}`);
      seen.set(key, group.join('/'));
    }
    // 组内不能有重复项
    assert.equal(new Set(group.map((t) => t.toLowerCase())).size, group.length, `组内有重复：${group.join('/')}`);
  }
});

test('罕见说法能救回规范词的文档（召回增益 6/6）', () => {
  const { db, owner } = makeCorpus();
  const cases = [
    ['等待太久', '超时'],
    ['防止过载', '限流'],
    ['自我调用', '递归'],
    ['避免重复', '去重'],
    ['排重', '去重'],
    ['出问题', '报错'],
  ];
  for (const [query, concept] of cases) {
    // 前置条件：这个说法本身在语料里不存在，所以精确匹配必为 0
    const exact = search(db, { query, scope: SCOPE, limit: 50, fuzzy: false, synonym: false });
    assert.equal(exact.total, 0, `前置条件不成立：「${query}」在语料里本来就存在`);

    const wide = search(db, { query, scope: SCOPE, limit: 50 });
    assert.ok(wide.total > 0, `「${query}」应当被扩展后救回`);
    assert.equal(wide.fuzzy?.what, 'synonym', `「${query}」应当是同义扩展救的，实际 ${wide.fuzzy?.what}`);

    // 精度：返回的每一条都必须属于期望概念
    for (const hit of wide.hits) {
      assert.equal(owner.get(hit.seq), concept, `「${query}」混入了无关概念：${owner.get(hit.seq)}`);
    }
  }
});

test('通用词与无关串不得被扩展', () => {
  const { db } = makeCorpus();
  // 「并行 / 同时 / 调用」这类高频通用词会造成大面积误报，必须被频率护栏挡住
  for (const trap of ['同时', '重复调用', 'zzqqxxjwplm', '紫色的大象在跳舞', 'qwertyuiop']) {
    const result = search(db, { query: trap, scope: SCOPE, limit: 50, fuzzy: true, synonym: true });
    assert.notEqual(result.fuzzy?.what, 'synonym', `「${trap}」不该走同义扩展，实际扩展成 ${result.fuzzy?.applied}`);
  }
});

test('扩展词不得比原词更常见（频率护栏）', () => {
  const { db } = makeCorpus();
  // 「递归」在语料里 3 篇；若把「调用」当同义词会命中干扰概念，必须拒绝。
  const { expansions, rejected } = expandSynonyms(db, '递归');
  assert.ok(expansions.every((item) => item.term !== '调用'), '「调用」是高频通用词，不该被接受');
  assert.ok(rejected.some((item) => item.term === '调用' || item.term === '自调用'), '拒绝原因要能解释');
  // 报告必须说明理由，不能静默丢
  for (const item of rejected) assert.ok(typeof item.why === 'string' && item.why.length > 0);
});

test('精确命中存在时**不扩展**（不污染本来有答案的查询）', () => {
  const { db } = makeCorpus();
  // 「超时」在语料里本来就有 3 篇
  const result = search(db, { query: '超时', scope: SCOPE, limit: 50 });
  assert.equal(result.fuzzy, undefined, '本来就能搜到，不该再扩展');
  assert.equal(result.total, 3);
});

test('扩展数量有上限，且按稀有度优先', () => {
  const { db } = makeCorpus();
  const { expansions } = expandSynonyms(db, '排重');
  assert.ok(expansions.length <= MAX_EXPANSIONS);
  // 升序：越稀有越精确，应当排在前面
  for (let i = 1; i < expansions.length; i += 1) {
    assert.ok(expansions[i - 1].doc <= expansions[i].doc, '扩展词应按文档频率升序');
  }
});

test('--no-synonym / synonym:false 可只关同义扩展', () => {
  const { db } = makeCorpus();
  const on = search(db, { query: '等待太久', scope: SCOPE, limit: 50, synonym: true });
  const off = search(db, { query: '等待太久', scope: SCOPE, limit: 50, synonym: false });
  assert.ok(on.total > 0);
  assert.equal(off.total, 0, '关掉之后应当回到精确语义（0 条）');
});

test('同义扩展的报告能说清"用了哪个词、救回几条"', () => {
  const { db } = makeCorpus();
  const result = search(db, { query: '等待太久', scope: SCOPE, limit: 50 });
  assert.match(result.fuzzy.applied, /超时\(\d+\)/, '报告里要带同义词与实际命中数');
});

test('空语料不崩、也不乱扩展', () => {
  const db = openDb(':memory:');
  const { expansions } = expandSynonyms(db, '超时');
  assert.deepEqual(expansions, []);
  const result = search(db, { query: '超时', scope: { mode: 'all' }, limit: 5 });
  assert.equal(result.total, 0);
});

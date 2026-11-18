// tests/fuzzy.test.mjs — lib/fuzzy.mjs 的纯函数测试
// 只跑本文件：node --test tests/fuzzy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { bigrams } from '../lib/cjk.mjs';
import {
  buildOrQuery,
  buildPrefixQuery,
  cjkChars,
  hasCorrectableLatin,
  isCjkChar,
  osaDistance,
  suggestTerms,
  tokenizeQuery,
} from '../lib/fuzzy.mjs';

/** 朴素 OSA：直接照定义写，用来交叉验证带内 DP 的实现。 */
function naiveOsa(a, b) {
  const n = a.length;
  const m = b.length;
  const d = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i += 1) d[i][0] = i;
  for (let j = 0; j <= m; j += 1) d[0][j] = j;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[n][m];
}

test('isCjkChar：只认真实 CJK 单字', () => {
  assert.equal(isCjkChar('幂'), true);
  assert.equal(isCjkChar('a'), false);
  assert.equal(isCjkChar('，'), false);
  assert.equal(isCjkChar('幂等'), false); // 多字符串不是「单字」
  assert.equal(isCjkChar(''), false);
});

test('osaDistance：相同/插入/删除/替换', () => {
  assert.equal(osaDistance('', ''), 0);
  assert.equal(osaDistance('settlement_id', 'settlement_id'), 0);
  assert.equal(osaDistance('settlemet', 'settlement'), 1); // 漏字母
  assert.equal(osaDistance('settlement', 'settlemet'), 1); // 多字母
  assert.equal(osaDistance('settlemenx', 'settlement'), 1); // 替换
  assert.equal(osaDistance('', 'abc'), 3);
  assert.equal(osaDistance('abc', ''), 3);
});

test('osaDistance：相邻换位只算 1 次', () => {
  assert.equal(osaDistance('ab', 'ba'), 1);
  assert.equal(osaDistance('settelment', 'settlement'), 1);
  assert.equal(osaDistance('se tt le', 'se tt le'), 0);
  // 非相邻的换位不能白送
  assert.equal(osaDistance('abc', 'cba'), 2);
});

test('osaDistance：max 提前退出，返回 max+1 而不是真实距离', () => {
  assert.equal(osaDistance('kitten', 'sitting'), 3); // 默认 Infinity 给真实值
  assert.equal(osaDistance('kitten', 'sitting', 1), 2); // 2 > 1，且不是 3
  assert.equal(osaDistance('kitten', 'sitting', 2), 3); // 3 > 2
  assert.equal(osaDistance('kitten', 'sitting', 3), 3); // 刚好够，返回真实值
  assert.equal(osaDistance('abc', 'abd', 0), 1); // 超过 0
  assert.equal(osaDistance('abcdef', 'abc', 1), 2); // 长度差提前退出
  assert.equal(osaDistance('abcdef', 'abc', 3), 3);
});

test('osaDistance：对称性', () => {
  const pairs = [
    ['', 'abc'],
    ['kitten', 'sitting'],
    ['settelment_id', 'settlement_id'],
    ['幂等性', '幂等键'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(osaDistance(a, b), osaDistance(b, a));
    assert.equal(osaDistance(a, b, 1), osaDistance(b, a, 1));
  }
});

test('osaDistance：与朴素 OSA 实现逐对一致（含 max 语义）', () => {
  const strings = [''];
  for (let len = 1; len <= 4; len += 1) {
    for (let mask = 0; mask < 2 ** len; mask += 1) {
      let s = '';
      for (let bit = 0; bit < len; bit += 1) s += (mask >> bit) & 1 ? 'b' : 'a';
      strings.push(s);
    }
  }
  for (const a of strings) {
    for (const b of strings) {
      const real = naiveOsa(a, b);
      assert.equal(osaDistance(a, b), real, `${a} vs ${b}`);
      for (const max of [0, 1, 2]) {
        const expected = real > max ? max + 1 : real;
        assert.equal(osaDistance(a, b, max), expected, `${a} vs ${b} max=${max}`);
      }
    }
  }
});

test('suggestTerms：漏字母 / 多字母 / 相邻换位都能命中', () => {
  // 词表故意夹杂容易混淆的干扰项，确认最短距离优先。
  const vocab = [
    'settlement_id',
    'settlement_at',
    'statement_id',
    'setlement',
    'settling',
    'payment_id',
  ];
  assert.equal(suggestTerms(vocab, 'settlemet_id')[0], 'settlement_id');
  assert.equal(suggestTerms(vocab, 'settlementt_id')[0], 'settlement_id');
  assert.equal(suggestTerms(vocab, 'settelment_id')[0], 'settlement_id');
  // 大小写不敏感，但返回词表原词
  assert.equal(suggestTerms(vocab, 'Settlemet_ID')[0], 'settlement_id');
});

test('suggestTerms：短词直接放弃，避免高误报', () => {
  const vocab = ['ab', 'ac', 'ad', 'abc'];
  assert.deepEqual(suggestTerms(vocab, ''), []);
  assert.deepEqual(suggestTerms(vocab, '  '), []);
  assert.deepEqual(suggestTerms(vocab, 'ab'), []);
  assert.deepEqual(suggestTerms(vocab, ' a '), []);
  assert.deepEqual(suggestTerms(vocab, '..'), []);
});

test('suggestTerms：maxDistance 先生效', () => {
  const vocab = ['settlement_id'];
  assert.deepEqual(suggestTerms(vocab, 'settlemet_id', { maxDistance: 0 }), []);
  assert.deepEqual(suggestTerms(vocab, 'settlemet_id', { maxDistance: 1 }), ['settlement_id']);
  // 长度差超过 maxDistance 的词不参与距离计算
  assert.deepEqual(suggestTerms(['set'], 'settlement_id', { maxDistance: 2 }), []);
});

test('suggestTerms：排序 = 距离 → 词长 → 字典序，且去重', () => {
  const vocab = ['abcf', 'abc', 'abcd', 'abce', 'abcf', 'abc'];
  assert.deepEqual(suggestTerms(vocab, 'abcd', { limit: 10 }), [
    'abcd', // 距离 0
    'abc', // 距离 1，词长 3 优先
    'abce', // 距离 1，词长 4，字典序 e
    'abcf', // 距离 1，词长 4，字典序 f
  ]);
});

test('suggestTerms：limit 生效', () => {
  const vocab = ['abc1', 'abc2', 'abc3', 'abc4'];
  assert.equal(suggestTerms(vocab, 'abcd', { limit: 2 }).length, 2);
  assert.deepEqual(suggestTerms(vocab, 'abcd', { limit: 0 }), []);
  assert.equal(suggestTerms(vocab, 'abcd', { limit: 2 })[0], 'abc1');
});

test('suggestTerms：太远的词不返回，非字符串项被忽略', () => {
  const vocab = ['completely_different', null, 42, 'settlement_id'];
  assert.deepEqual(suggestTerms(vocab, 'settlemet_id'), ['settlement_id']);
});

test('tokenizeQuery：CJK 连续段 / 拉丁词 / 中英混排', () => {
  assert.deepEqual(tokenizeQuery('幂等 键 settlement_id'), [
    { kind: 'cjk', text: '幂等' },
    { kind: 'cjk', text: '键' },
    { kind: 'latin', text: 'settlement_id' },
  ]);
  assert.deepEqual(tokenizeQuery('修复 settlement_id 的 bug，幂等。'), [
    { kind: 'cjk', text: '修复' },
    { kind: 'latin', text: 'settlement_id' },
    { kind: 'cjk', text: '的' },
    { kind: 'latin', text: 'bug' },
    { kind: 'cjk', text: '幂等' },
  ]);
  // CJK 紧贴拉丁也要切开
  assert.deepEqual(tokenizeQuery('幂等foo键'), [
    { kind: 'cjk', text: '幂等' },
    { kind: 'latin', text: 'foo' },
    { kind: 'cjk', text: '键' },
  ]);
});

test('tokenizeQuery：标识符里的 _ . - / @ : 不被切开', () => {
  const text = 'settlement_id lib/cjk.mjs user@example.com a:b v1.2-rc foo_bar';
  assert.deepEqual(tokenizeQuery(text), [
    { kind: 'latin', text: 'settlement_id' },
    { kind: 'latin', text: 'lib/cjk.mjs' },
    { kind: 'latin', text: 'user@example.com' },
    { kind: 'latin', text: 'a:b' },
    { kind: 'latin', text: 'v1.2-rc' },
    { kind: 'latin', text: 'foo_bar' },
  ]);
});

test('tokenizeQuery：标点被忽略，空串/纯空格/纯标点为空', () => {
  assert.deepEqual(tokenizeQuery('hello, world!'), [
    { kind: 'latin', text: 'hello' },
    { kind: 'latin', text: 'world' },
  ]);
  assert.deepEqual(tokenizeQuery('《检索》，幂等。'), [
    { kind: 'cjk', text: '检索' },
    { kind: 'cjk', text: '幂等' },
  ]);
  assert.deepEqual(tokenizeQuery(''), []);
  assert.deepEqual(tokenizeQuery('   '), []);
  assert.deepEqual(tokenizeQuery('，。！？...---'), []);
});

test('buildPrefixQuery：纯拉丁加 *', () => {
  assert.equal(buildPrefixQuery('settlement_id'), 'settlement_id*');
  assert.equal(buildPrefixQuery('settle'), 'settle*');
  assert.equal(buildPrefixQuery('Settlement'), 'settlement*'); // 与 buildMatchQuery 一样小写
  assert.equal(buildPrefixQuery('settle met'), 'settle* AND met*');
});

test('buildPrefixQuery：CJK 用 bigram 短语，与 buildMatchQuery 同构', () => {
  assert.equal(buildPrefixQuery('幂等'), `"${bigrams('幂等')}"`);
  assert.equal(buildPrefixQuery('幂等性'), `"${bigrams('幂等性')}"`);
  assert.equal(buildPrefixQuery('幂等性'), '"幂等 等性"');
  // 中英混合：一边短语一边前缀
  assert.equal(buildPrefixQuery('幂等 settlement'), '"幂等" AND settlement*');
});

test('buildPrefixQuery：单字 CJK / 空查询无法构造', () => {
  assert.equal(buildPrefixQuery('幂'), null);
  assert.equal(buildPrefixQuery('幂 等'), null);
  assert.equal(buildPrefixQuery('幂等 键'), null); // 有一个单字就整体退化
  assert.equal(buildPrefixQuery(''), null);
  assert.equal(buildPrefixQuery('   '), null);
  assert.equal(buildPrefixQuery('，。！'), null);
});

test('buildPrefixQuery：FTS5 特殊字符改用短语，保证表达式合法', () => {
  assert.equal(buildPrefixQuery('lib/cjk.mjs'), '"lib/cjk.mjs"*');
  assert.equal(buildPrefixQuery('foo-bar'), '"foo-bar"*');
  assert.equal(buildPrefixQuery('a:b'), '"a:b"*');
  assert.equal(buildPrefixQuery('user@example.com'), '"user@example.com"*');
});

test('buildOrQuery：多词 OR / 单词也合理', () => {
  assert.equal(buildOrQuery('settlemet_id settlement_id'), 'settlemet_id OR settlement_id');
  assert.equal(buildOrQuery('Alpha Beta'), 'alpha OR beta');
  assert.equal(buildOrQuery('settlement'), 'settlement');
});

test('buildOrQuery：CJK 用 bigram 短语；单字被跳过', () => {
  assert.equal(buildOrQuery('幂等 settlement'), '"幂等" OR settlement');
  assert.equal(buildOrQuery('幂等性 键'), '"幂等 等性"'); // 单字键跳过，还剩可表达的词
  assert.equal(buildOrQuery('幂 等'), null); // 只有单字 CJK
  assert.equal(buildOrQuery('幂'), null);
  assert.equal(buildOrQuery(''), null);
  assert.equal(buildOrQuery('...'), null);
});

test('buildOrQuery：特殊字符同样加引号', () => {
  assert.equal(buildOrQuery('lib/cjk.mjs settlement'), '"lib/cjk.mjs" OR settlement');
});

test('cjkChars：去重且保序', () => {
  assert.deepEqual(cjkChars('幂等性键值幂'), ['幂', '等', '性', '键', '值']);
  assert.deepEqual(cjkChars('幂等, settlemet 幂'), ['幂', '等']);
  assert.deepEqual(cjkChars('settlement only'), []);
  assert.deepEqual(cjkChars(''), []);
});

test('hasCorrectableLatin：有长度 >= 3 的拉丁词', () => {
  assert.equal(hasCorrectableLatin('settle'), true);
  assert.equal(hasCorrectableLatin('abc'), true);
  assert.equal(hasCorrectableLatin('ab'), false);
  assert.equal(hasCorrectableLatin('ab cd'), false);
  assert.equal(hasCorrectableLatin('幂等'), false);
  assert.equal(hasCorrectableLatin('幂等 settlement'), true);
  assert.equal(hasCorrectableLatin('，。...'), false);
});

test('边界：超长串不崩', () => {
  const longLatin = 'settlement_id '.repeat(5000);
  assert.equal(tokenizeQuery(longLatin).length, 5000);
  assert.equal(buildOrQuery(longLatin).split(' OR ').length, 5000);
  assert.ok(buildPrefixQuery(longLatin).length > 0);

  // 等长且只差最后一个字符：带内 DP 只需要 O(n) 行，不应卡住。
  const a = 'x'.repeat(20000);
  const b = `${'x'.repeat(19999)}y`;
  assert.equal(osaDistance(a, b, 1), 1);
  assert.equal(osaDistance(a, a), 0);
  assert.deepEqual(suggestTerms(['settlement_id'], longLatin), []);
});

test('性能哨兵：5 万词 suggestTerms', () => {
  // 固定种子的 LCG，结果可复现；词长 6..12，模拟真实标识符长度。
  let seed = 0x12345678;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const vocab = [];
  for (let i = 0; i < 50000; i += 1) {
    const len = 6 + Math.floor(rand() * 7);
    let word = '';
    for (let j = 0; j < len; j += 1) word += alphabet[Math.floor(rand() * alphabet.length)];
    vocab.push(word);
  }

  // 拿词表里真实存在的词删一个字母当 typo：大词表下既测耗时，也测还能不能召回目标。
  const target = vocab[12345];
  const typo = `${target.slice(0, 3)}${target.slice(4)}`;

  const started = performance.now();
  const found = suggestTerms(vocab, typo);
  const elapsed = performance.now() - started;

  // 不严格卡时间（不同机器/CI 差异大），只保证结果形状并打印可观测值。
  assert.ok(found.includes(target), `应召回 ${target}，实际 ${JSON.stringify(found)}`);
  console.log(`[perf] 5万词 suggestTerms = ${elapsed.toFixed(1)}ms（命中 ${found.length}）`);
});

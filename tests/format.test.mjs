// tests/format.test.mjs — format 模块自测（只跑这个文件：node --test tests/format.test.mjs）
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clip,
  renderHits,
  renderShow,
  renderOutline,
  renderAudit,
  renderStats,
} from '../lib/format.mjs';

const SCOPE = { mode: 'project', cwd: '/tmp/x' };

const HITS_RESULT = {
  total: 2,
  hits: [
    {
      sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
      short: 'aaaaaaaa',
      title: '幂等键排查',
      cwd: '/tmp/x',
      seq: 3,
      kind: 'user',
      surface: 'current',
      time: 123,
      score: 1.234,
      snippet: '需要 [幂等键] 去重',
    },
    {
      sessionId: 'bbbbbbbb-2222-4222-8222-222222222222',
      short: 'bbbbbbbb',
      title: '退款\n对账',
      cwd: '/tmp/x',
      seq: 8,
      kind: 'assistant',
      surface: 'shadowed',
      time: 456,
      score: 0.9,
      snippet: 'line1\nline2 [结算]',
    },
  ],
};

const SHOW_RESULT = {
  sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
  short: 'aaaaaaaa',
  title: '幂等键排查',
  cwd: '/tmp/x',
  target: { seq: 2, type: 'user/message', time: 123, kind: 'user' },
  events: [
    { seq: 1, type: 'session/title', time: 100, surface: 'current', role: 'event', text: '标题事件', isTarget: false },
    { seq: 2, type: 'user/message', time: 123, surface: 'current', role: 'user', text: '重复提交会导致重复扣款', isTarget: true },
  ],
};

const OUTLINE_RESULT = {
  sessions: [
    {
      sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
      short: 'aaaaaaaa',
      title: '幂等键排查',
      cwd: '/tmp/x',
      createdAt: 100,
      eventCount: 9,
      turns: [
        { turn: 1, seq: 10, prompt: '排查重复扣款', response: '已定位到唯一索引' },
        { turn: 2, seq: 30, prompt: '补测试', response: '' },
      ],
      checkpoints: [
        { seq: 20, time: 200, shadowedTokenCount: 1234, range: { start: 3, end: 5 }, preview: '压缩摘要预览' },
      ],
    },
  ],
};

const AUDIT_RESULT = {
  scanned: { sessions: 1, docs: 5 },
  findings: [
    {
      patternId: 'sk-key',
      label: 'OpenAI/Anthropic 风格 sk- 密钥',
      sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
      short: 'aaaaaaaa',
      seq: 2,
      kind: 'user',
      time: 123,
      redacted: 'sk-a…ef(len=25)',
      length: 25,
    },
  ],
};

const STATS = { sessions: 2, events: 10, docs: 7, dbBytes: 2048 };

test('clip：补省略号且不超预算', () => {
  assert.equal(clip('abcdef', 10), 'abcdef');
  assert.equal(clip('abcdef', 6), 'abcdef');
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip('abcdef', 2), 'a…');
  assert.equal(clip('abcdef', 1), '…');
  assert.equal(clip('abcdef', 0), 'abcdef'); // 0 = 不限
  assert.equal(clip('', 10), '');
  const long = clip('x'.repeat(100), 10);
  assert.equal(long.length, 10);
  assert.ok(long.endsWith('…'));
});

test('renderHits：json 可 JSON.parse 还原', () => {
  const out = renderHits(HITS_RESULT, { json: true });
  assert.equal(typeof out, 'string');
  assert.ok(!out.includes('\n'));
  assert.deepEqual(JSON.parse(out), HITS_RESULT);
});

test('renderHits：首行含作用域与总数，一行一命中', () => {
  const out = renderHits(HITS_RESULT, { scope: SCOPE });
  const lines = out.split('\n');
  assert.equal(lines.length, 3); // 首行 + 2 条命中
  assert.ok(lines[0].includes('project /tmp/x'));
  assert.ok(lines[0].includes('total 2'));
  assert.equal(lines[1], '[user/current] aaaaaaaa #3 幂等键排查 :: 需要 [幂等键] 去重');
  // 标题/片段里的换行必须被压平，保持「一行一命中」
  assert.equal(lines[2], '[assistant/shadowed] bbbbbbbb #8 退款 对账 :: line1 line2 [结算]');
});

test('renderHits：空结果也有首行', () => {
  const out = renderHits({ total: 0, hits: [] }, { scope: { mode: 'all' } });
  assert.ok(out.split('\n')[0].includes('all sessions'));
  assert.ok(out.includes('(no hits)'));
});

test('renderHits：maxChars 真的不超预算并追加 … (+N more)', () => {
  const hits = Array.from({ length: 40 }, (_, i) => ({
    sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
    short: 'aaaaaaaa',
    title: '标题'.repeat(20),
    cwd: '/tmp/x',
    seq: i + 1,
    kind: 'user',
    surface: 'current',
    time: 0,
    score: 1,
    snippet: '内容'.repeat(30),
  }));
  const out = renderHits({ total: hits.length, hits }, { scope: SCOPE, maxChars: 300 });
  assert.ok(out.length <= 300, `超预算: ${out.length}`);
  const lines = out.split('\n');
  const m = lines.at(-1).match(/^… \(\+(\d+) more\)$/u);
  assert.ok(m, `缺少截断后缀: ${lines.at(-1)}`);
  const included = lines.length - 2; // 去掉首行与后缀行
  assert.equal(Number(m[1]), hits.length - included);
});

test('renderHits：极小预算退化为省略号但绝不超过', () => {
  const out = renderHits(HITS_RESULT, { scope: SCOPE, maxChars: 20 });
  assert.ok(out.length <= 20, `超预算: ${out.length}`);
});

test('renderHits：maxChars=0 不截断', () => {
  const out = renderHits(HITS_RESULT, { scope: SCOPE, maxChars: 0 });
  assert.ok(out.includes('#8'));
});

test('renderHits：maxChars=0 与 json 同时给出时 json 优先', () => {
  assert.deepEqual(JSON.parse(renderHits(HITS_RESULT, { json: true, maxChars: 10 })), HITS_RESULT);
});

test('renderShow：文本包含目标标记，json 可还原', () => {
  const out = renderShow(SHOW_RESULT, { scope: SCOPE });
  assert.ok(out.includes('aaaaaaaa 幂等键排查 · /tmp/x'));
  assert.ok(out.includes('target #2'));
  assert.ok(out.includes('▶ #2 [user/message/current] user :: 重复提交会导致重复扣款'));
  assert.ok(out.includes('  #1 [session/title/current] event :: 标题事件'));
  assert.deepEqual(JSON.parse(renderShow(SHOW_RESULT, { json: true })), SHOW_RESULT);
});

test('renderShow：maxChars 生效', () => {
  const out = renderShow(SHOW_RESULT, { maxChars: 60 });
  assert.ok(out.length <= 60, `超预算: ${out.length}`);
  assert.ok(out.includes('more)'));
});

test('renderOutline：回合与检查点都渲染，json 可还原', () => {
  const out = renderOutline(OUTLINE_RESULT);
  assert.ok(out.split('\n')[0].includes('1 sessions'));
  assert.ok(out.includes('▸ aaaaaaaa 幂等键排查'));
  assert.ok(out.includes('T1 #10 > 排查重复扣款'));
  assert.ok(out.includes('< 已定位到唯一索引'));
  assert.ok(out.includes('T2 #30 > 补测试'));
  assert.ok(!out.includes('< \n')); // 空 response 不占一行
  assert.ok(out.includes('⧉ #20 range 3-5 (1234 tok) 压缩摘要预览'));
  assert.deepEqual(JSON.parse(renderOutline(OUTLINE_RESULT, { json: true })), OUTLINE_RESULT);
});

test('renderOutline：maxChars 生效', () => {
  const out = renderOutline(OUTLINE_RESULT, { maxChars: 80 });
  assert.ok(out.length <= 80, `超预算: ${out.length}`);
  assert.ok(out.includes('more)'));
});

test('renderAudit：只展示脱敏值，首行含扫描面与命中数', () => {
  const out = renderAudit(AUDIT_RESULT, { scope: SCOPE });
  const first = out.split('\n')[0];
  assert.ok(first.includes('audit project /tmp/x'));
  assert.ok(first.includes('scanned 1 sessions / 5 docs'));
  assert.ok(first.includes('1 findings'));
  assert.ok(out.includes('[sk-key] aaaaaaaa #2 user :: sk-a…ef(len=25)'));
  assert.deepEqual(JSON.parse(renderAudit(AUDIT_RESULT, { json: true })), AUDIT_RESULT);
});

test('renderStats：文本含各项计数，json 可还原', () => {
  const out = renderStats(STATS);
  for (const part of ['2 sessions', '10 events', '7 docs', '2048 bytes']) assert.ok(out.includes(part));
  assert.deepEqual(JSON.parse(renderStats(STATS, { json: true })), STATS);
});

test('所有 render*：json 输出是单行且可被 JSON.parse', () => {
  const pairs = [
    [renderHits(HITS_RESULT, { json: true }), HITS_RESULT],
    [renderShow(SHOW_RESULT, { json: true }), SHOW_RESULT],
    [renderOutline(OUTLINE_RESULT, { json: true }), OUTLINE_RESULT],
    [renderAudit(AUDIT_RESULT, { json: true }), AUDIT_RESULT],
    [renderStats(STATS, { json: true }), STATS],
  ];
  for (const [out, original] of pairs) {
    assert.ok(!out.includes('\n'));
    assert.deepEqual(JSON.parse(out), original);
  }
});

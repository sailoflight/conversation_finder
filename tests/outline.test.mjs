// tests/outline.test.mjs — L1 摘要层契约测试
//
// fixture A/B 本身没有 turn/start（真实语料才有），所以这里用 make-fixture 写盘助手
// 追加一个确定性会话 D：3 个回合 + 1 个 compaction/summary 检查点。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../lib/schema.mjs';
import { syncIndex } from '../lib/store.mjs';
import { outline } from '../lib/outline.mjs';
import { buildFixture, writeSessionFile, SESSION_IDS } from './fixtures/make-fixture.mjs';

const HOME = mkdtempSync(join(tmpdir(), 'cfind-outline-'));
process.env.DSH_HOME = HOME;
const SESSIONS = join(HOME, 'sessions');
buildFixture(SESSIONS);

const D_ID = 'dddddddd-4444-4444-8444-444444444444';
const D_PROJECT = '--tmp-outline-demo--';
const T0 = 1794995000000;

/** 会话 D：三级回合（正常 / 无回答 / 仅 reasoning）+ 一个压缩检查点。 */
function sessionD() {
  const ev = [];
  let seq = 0;
  ev.push({
    type: 'session',
    version: 4,
    id: D_ID,
    createdAt: T0,
    cwd: '/tmp/fixture-demo',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  });
  seq += 1;
  const add = (type, data) => {
    ev.push({ type, seq, time: T0 + seq * 1000, data });
    seq += 1;
  };
  add('session/title', { title: '回合与检查点测试' });
  add('turn/start', { turn: 1 });
  add('user/message', {
    content: [
      { type: 'text', text: '第一回合：帮我看看幂等键和重复扣款问题，这段特意写得很长很长很长以便验证截断。' },
    ],
  });
  add('assistant/message', {
    message: { role: 'assistant', content: [{ type: 'text', text: '第一回合的第一个回答。' }] },
  });
  add('tool/call', { name: 'bash', arguments: '{"command":"ls"}' });
  add('assistant/message', {
    message: { role: 'assistant', content: [{ type: 'text', text: '第一回合的最后一个回答。' }] },
  });
  add('turn/end', { reason: { kind: 'completed' } });

  add('turn/start', { turn: 2 });
  add('user/message', { content: [{ type: 'text', text: '第二回合：继续排查' }] });
  add('turn/end', { reason: { kind: 'completed' } });

  add('turn/start', { turn: 3 });
  add('user/message', { content: [{ type: 'text', text: '第三回合：只做推理' }] });
  add('assistant/message', {
    message: { role: 'assistant', content: [{ type: 'reasoning', text: '只有推理，没有正文。' }] },
  });
  add('turn/end', { reason: { kind: 'completed' } });

  add('compaction/summary', {
    compactionId: 'cmp-test',
    summary: [{ type: 'text', text: '压缩摘要：settlement_id 为空导致重复退款。' }],
    shadowedRange: { start: 3, end: 6 },
    shadowedSeqs: [3, 4, 5, 6],
    shadowedTokenCount: 999,
  });
  add('compaction/end', { compactionId: 'cmp-test' });
  return ev;
}

writeSessionFile(join(SESSIONS, D_PROJECT, D_ID, 'session.v4.jsonl.zstd'), sessionD());

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

test('outline 返回作用域内所有会话', () => {
  const result = outline(db, { scope: { mode: 'all' } });
  assert.equal(result.sessions.length, 3);
  const ids = result.sessions.map((session) => session.sessionId);
  assert.ok(ids.includes(SESSION_IDS.A) && ids.includes(SESSION_IDS.B) && ids.includes(D_ID));

  const one = outline(db, { scope: { mode: 'session', id: D_ID } });
  assert.equal(one.sessions.length, 1);
  assert.equal(one.sessions[0].short, 'dddddddd');
  assert.equal(one.sessions[0].title, '回合与检查点测试');
  assert.equal(one.sessions[0].cwd, '/tmp/fixture-demo');
  assert.ok(one.sessions[0].createdAt > 0);
  assert.ok(one.sessions[0].eventCount > 0);
});

test('outline 回合以 turn/start 为锚：首问 + 末答', () => {
  const result = outline(db, { scope: { mode: 'session', id: D_ID } });
  const session = result.sessions[0];
  assert.equal(session.turns.length, 3);
  assert.deepEqual(session.turns.map((turn) => turn.turn), [1, 2, 3]);
  assert.deepEqual(session.turns.map((turn) => turn.seq), [2, 8, 11]);

  // 第一回合：prompt 取第一条 user/message；response 取最后一条 assistant/message。
  assert.equal(
    session.turns[0].prompt,
    '第一回合：帮我看看幂等键和重复扣款问题，这段特意写得很长很长很长以便验证截断。',
  );
  assert.equal(session.turns[0].response, '第一回合的最后一个回答。');

  // 第二回合没有 assistant/message → 空串。
  assert.equal(session.turns[1].prompt, '第二回合：继续排查');
  assert.equal(session.turns[1].response, '');

  // 第三回合最后一条 assistant/message 只有 reasoning → contentText 为空串。
  assert.equal(session.turns[2].prompt, '第三回合：只做推理');
  assert.equal(session.turns[2].response, '');
});

test('outline prompt/response 截断补省略号', () => {
  const result = outline(db, {
    scope: { mode: 'session', id: D_ID },
    promptLimit: 30,
    responseLimit: 8,
  });
  const turn = result.sessions[0].turns[0];
  assert.equal(turn.prompt.length, 30);
  assert.ok(turn.prompt.startsWith('第一回合：'));
  assert.ok(turn.prompt.endsWith('…'));
  assert.equal(turn.response.length, 8);
  assert.ok(turn.response.endsWith('…'));
});

test('outline 检查点来自 compaction/summary', () => {
  const result = outline(db, { scope: { mode: 'all' } });
  const d = result.sessions.find((session) => session.sessionId === D_ID);
  assert.equal(d.checkpoints.length, 1);
  const checkpoint = d.checkpoints[0];
  assert.equal(checkpoint.seq, 15);
  assert.deepEqual(checkpoint.range, { start: 3, end: 6 });
  assert.equal(checkpoint.shadowedTokenCount, 999);
  assert.equal(checkpoint.preview, '压缩摘要：settlement_id 为空导致重复退款。');
  assert.ok(checkpoint.time > 0);

  // 会话 B 的压缩事务：seq 3–5 shadowed，token 数 1234。
  const b = result.sessions.find((session) => session.sessionId === SESSION_IDS.B);
  assert.equal(b.turns.length, 0);
  assert.equal(b.checkpoints.length, 1);
  assert.deepEqual(b.checkpoints[0].range, { start: 3, end: 5 });
  assert.equal(b.checkpoints[0].shadowedTokenCount, 1234);
  assert.ok(b.checkpoints[0].preview.includes('settlement_id'));
  assert.ok(b.checkpoints[0].preview.length <= 200);
});

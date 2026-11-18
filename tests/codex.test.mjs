// tests/codex.test.mjs — Codex 适配器契约测试
//
// 只用 mkdtempSync 造合成语料，绝不依赖 /home/d_demo1/conversations（真实语料会漂移）。
// 覆盖：header、坏行/行号连续性、developer 不入索引、task_complete 最终答复、
//       function_call/output、turn_context summary、噪声过滤、compacted shadow 判定、
//       .jsonl.zst 归档态读取、合成标题。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { codexSource } from '../lib/sources/codex.mjs';

const HOME = mkdtempSync(join(tmpdir(), 'cfind-codex-'));
const SESSIONS = join(HOME, 'sessions');
const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME;
process.env.CODEX_HOME = HOME; // discover/detect 每次调用都会读，放在顶层即可

const ID1 = '01a1de0e-000b-7061-9eec-3366aaa3a615';
const ID2 = '01a1e7b3-a80d-7e00-ab07-1adefab6461d';
const BASE_TIME = Date.parse('2026-11-15T07:13:48.000Z');

/** 一行 Codex rollout；ordinal/timestamp 都补齐，模拟真实文件形状。 */
function makeLine(ordinal, type, payload) {
  return JSON.stringify({
    timestamp: new Date(BASE_TIME + ordinal * 1000).toISOString(),
    ordinal,
    type,
    payload,
    metadata: {},
  });
}

// ── 会话 1：活跃态 .jsonl，含坏行与一次压缩 ──────────────────────────────
const lines1 = [];
let ordinal = 0;
const add1 = (type, payload) => {
  lines1.push(makeLine(ordinal, type, payload));
  ordinal += 1;
  return lines1.length - 1;
};

add1('session_meta', {
  session_id: ID1,
  id: ID1,
  timestamp: new Date(BASE_TIME).toISOString(),
  cwd: '/tmp/codex-fixture',
  cli_version: '0.163.0',
  model_provider: 'custom',
  context_window: { window_id: 'win-1' },
});
add1('response_item', {
  type: 'message',
  role: 'developer',
  content: [{ type: 'input_text', text: 'developer instructions: do not index me' }],
});
add1('response_item', {
  type: 'message',
  role: 'user',
  // 宿主注入的环境上下文也是 role=user；标题必须跳过它，不能变成 XML 片段。
  content: [{ type: 'input_text', text: '<environment_context><cwd>/tmp/codex-fixture</cwd></environment_context>' }],
});
add1('response_item', {
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: 'Fix the login bug in lib/auth.mjs' }],
});
add1('response_item', {
  type: 'function_call',
  name: 'exec_command',
  arguments: '{"cmd":"rg TODO lib"}',
  call_id: 'call_1',
});

const BAD_LINE_INDEX = lines1.length; // 4
lines1.push('{"timestamp":"broken"'); // 故意坏行：必须跳过且不打断后续行号

add1('response_item', {
  type: 'function_call_output',
  call_id: 'call_1',
  output: 'lib/auth.mjs:42: TODO',
});
add1('turn_context', { cwd: '/tmp/codex-fixture', model: 'gpt-6.1-sol', summary: 'Investigated the login flow.' });
add1('event_msg', { type: 'task_started', turn_id: 'turn-1' });
const COMPACTED_INDEX = add1('compacted', { reason: 'context_window' });
add1('response_item', {
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: 'Now add a regression test' }],
});
add1('event_msg', { type: 'task_complete', last_agent_message: 'Fixed the login bug and added a test.', error: null });
add1('event_msg', { type: 'token_count', total_tokens: 1234 });
add1('world_state', { full: true, state: { cwd: '/tmp/codex-fixture' } });
add1('response_item', { type: 'additional_tools', tools: [{ name: 'shell' }] });
add1('event_msg', { type: 'item_completed', item: { type: 'UserMessage' } });
add1('event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6.1-sol' } });

const JSONL_DIR = join(SESSIONS, '2026', '11', '15');
const JSONL_PATH = join(JSONL_DIR, `rollout-2026-11-15T15-13-48-${ID1}.jsonl`);
mkdirSync(JSONL_DIR, { recursive: true });
writeFileSync(JSONL_PATH, `${lines1.join('\n')}\n`);

// ── 会话 2：归档态 .jsonl.zst，用 payload.type=compacted 表达压缩 ──────────
const lines2 = [];
let ordinal2 = 0;
const add2 = (type, payload) => {
  lines2.push(makeLine(ordinal2, type, payload));
  ordinal2 += 1;
};

add2('session_meta', {
  session_id: ID2,
  id: ID2,
  timestamp: new Date(BASE_TIME + 86_400_000).toISOString(),
  cwd: '/tmp/codex-archive',
  cli_version: '0.163.0',
});
add2('response_item', {
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: '# AGENTS.md instructions for /tmp/codex-archive\n<INSTRUCTIONS>noise</INSTRUCTIONS>' }],
});
add2('response_item', {
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: 'Archived conversation about zstd decoding' }],
});
add2('event_msg', { type: 'compacted' });
add2('response_item', {
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: 'After compaction message' }],
});
add2('turn_context', { cwd: '/tmp/codex-archive', model: 'gpt-6.1-sol', summary: 'none' });

const ZST_DIR = join(SESSIONS, '2026', '11', '16');
const ZST_PATH = join(ZST_DIR, `rollout-2026-11-16T12-11-13-${ID2}.jsonl.zst`);
mkdirSync(ZST_DIR, { recursive: true });
writeFileSync(ZST_PATH, zstdCompressSync(Buffer.from(`${lines2.join('\n')}\n`)));

after(() => {
  if (ORIGINAL_CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = ORIGINAL_CODEX_HOME;
  rmSync(HOME, { recursive: true, force: true });
});

const session1 = codexSource.readAll(JSONL_PATH);
const archived = codexSource.readAll({ ref: ZST_PATH });

const payloadOf = (event) => event?.data?.payload ?? {};
const findEvent = (events, predicate) => events.find(predicate);
const userTexts = (event) =>
  (payloadOf(event).content ?? [])
    .filter((block) => block?.type === 'input_text')
    .map((block) => block.text)
    .join('\n');

test('detect/discover: 同时发现 .jsonl 与 .jsonl.zst', () => {
  assert.equal(codexSource.detect(), true);
  const refs = codexSource.discover();
  assert.equal(refs.length, 2);
  assert.ok(refs.some((file) => file.ref === JSONL_PATH));
  const zst = refs.find((file) => file.ref === ZST_PATH);
  assert.ok(zst, '.jsonl.zst 归档态必须能被发现');
  for (const file of refs) {
    assert.ok(file.size > 0, `${file.ref} size 应大于 0`);
    assert.ok(file.mtime > 0, `${file.ref} mtime 应大于 0`);
    assert.equal(typeof file.sessionHint, 'string');
  }
});

test('readAll: header 提取、坏行跳过、seq 保持行号连续', () => {
  const { header, events } = session1;
  assert.equal(header.id, ID1);
  assert.equal(header.cwd, '/tmp/codex-fixture');
  assert.equal(header.createdAt, BASE_TIME);
  assert.equal(header.title, null, 'Codex 没有标题字段，header.title 必须为 null');
  assert.equal(header.agentPreset, null);
  assert.equal(header.parentId, null);

  assert.equal(events[0].seq, 0);
  assert.equal(events[0].type, 'session_meta');
  assert.equal(events[0].time, BASE_TIME);

  const seqs = events.map((event) => event.seq);
  assert.ok(!seqs.includes(BAD_LINE_INDEX), '坏行不应产生事件');
  assert.ok(seqs.includes(BAD_LINE_INDEX + 1), '坏行之后的事件必须用真实行号');
  assert.equal(new Set(seqs).size, seqs.length, 'seq 不能重复');
  for (let i = 1; i < seqs.length; i += 1) assert.ok(seqs[i] > seqs[i - 1], 'seq 必须单调递增');
});

test('toDocs: developer 不入索引，user 正常提取', () => {
  const developer = findEvent(
    session1.events,
    (event) => payloadOf(event).type === 'message' && payloadOf(event).role === 'developer',
  );
  const user = findEvent(
    session1.events,
    (event) => payloadOf(event).type === 'message' && payloadOf(event).role === 'user' && userTexts(event).includes('login bug'),
  );
  assert.ok(developer && user);
  assert.deepEqual(codexSource.toDocs(developer), [], '注入的 developer 指令是噪声，必须不索引');
  assert.deepEqual(codexSource.toDocs(user), [{ kind: 'user', body: 'Fix the login bug in lib/auth.mjs' }]);
});

test('toDocs: task_complete.last_agent_message 变成 assistant 文档', () => {
  const complete = findEvent(
    session1.events,
    (event) => event.data.type === 'event_msg' && payloadOf(event).type === 'task_complete',
  );
  assert.ok(complete, 'task_complete 事件必须存在');
  assert.deepEqual(codexSource.toDocs(complete), [
    { kind: 'assistant', body: 'Fixed the login bug and added a test.' },
  ]);
});

test('toDocs: function_call / function_call_output 可提取', () => {
  const call = findEvent(session1.events, (event) => payloadOf(event).type === 'function_call');
  const result = findEvent(session1.events, (event) => payloadOf(event).type === 'function_call_output');
  assert.ok(call && result);

  const callDocs = codexSource.toDocs(call);
  assert.equal(callDocs.length, 1);
  assert.equal(callDocs[0].kind, 'tool-call');
  assert.match(callDocs[0].body, /exec_command/);
  assert.match(callDocs[0].body, /rg TODO lib/);

  const resultDocs = codexSource.toDocs(result);
  assert.deepEqual(resultDocs, [{ kind: 'tool-result', body: 'lib/auth.mjs:42: TODO' }]);
});

test('toDocs: turn_context summary → other；占位 none 与噪声事件不索引', () => {
  const turn = findEvent(session1.events, (event) => event.data.type === 'turn_context');
  assert.ok(turn);
  assert.deepEqual(codexSource.toDocs(turn), [{ kind: 'other', body: 'Investigated the login flow.' }]);

  const noneSummary = findEvent(archived.events, (event) => event.data.type === 'turn_context');
  assert.ok(noneSummary);
  assert.deepEqual(codexSource.toDocs(noneSummary), [], 'summary="none" 是占位值，不能索引');

  for (const type of ['session_meta', 'world_state']) {
    const event = findEvent(session1.events, (candidate) => candidate.data.type === type);
    assert.ok(event, `${type} 应存在`);
    assert.deepEqual(codexSource.toDocs(event), [], `${type} 不应入索引`);
  }
  for (const noise of ['task_started', 'token_count', 'item_completed', 'thread_settings_applied', 'additional_tools']) {
    const event = findEvent(
      session1.events,
      (candidate) => payloadOf(candidate).type === noise || candidate.data.type === noise,
    );
    assert.ok(event, `${noise} 应存在`);
    assert.deepEqual(codexSource.toDocs(event), [], `${noise} 不应入索引`);
  }
  const compacted = session1.events.find((event) => event.seq === COMPACTED_INDEX);
  assert.ok(compacted);
  assert.deepEqual(codexSource.toDocs(compacted), [], '压缩标记本身不应入索引');
});

test('.jsonl.zst 归档态可按相同语义读取', () => {
  assert.equal(archived.header.id, ID2);
  assert.equal(archived.header.cwd, '/tmp/codex-archive');
  assert.equal(archived.events.length, 6);
  const text = archived.events.map((event) => userTexts(event)).join('\n');
  assert.match(text, /Archived conversation about zstd decoding/);
  assert.match(text, /After compaction message/);
});

test('surfaceOf: compacted 之前 shadowed，之后 current；无标记保守全 current', () => {
  const surface = codexSource.surfaceOf(session1.events);
  assert.equal(surface.size, session1.events.length);

  const beforeUser = findEvent(
    session1.events,
    (event) => payloadOf(event).role === 'user' && userTexts(event).includes('login bug'),
  );
  const afterUser = findEvent(
    session1.events,
    (event) => payloadOf(event).role === 'user' && userTexts(event).includes('regression'),
  );
  const call = findEvent(session1.events, (event) => payloadOf(event).type === 'function_call');
  const complete = findEvent(session1.events, (event) => payloadOf(event).type === 'task_complete');
  assert.ok(beforeUser && afterUser && call && complete);

  assert.equal(surface.get(beforeUser.seq), 'shadowed');
  assert.equal(surface.get(call.seq), 'shadowed');
  assert.equal(surface.get(COMPACTED_INDEX), 'current', '压缩标记本身代表新上下文，应 current');
  assert.equal(surface.get(afterUser.seq), 'current');
  assert.equal(surface.get(complete.seq), 'current');

  // 第二种形状：event_msg.payload.type === 'compacted'
  const archiveSurface = codexSource.surfaceOf(archived.events);
  const archiveBefore = archived.events.find((event) => userTexts(event).includes('Archived conversation'));
  const archiveAfter = archived.events.find((event) => userTexts(event).includes('After compaction'));
  assert.ok(archiveBefore && archiveAfter);
  assert.equal(archiveSurface.get(archiveBefore.seq), 'shadowed');
  assert.equal(archiveSurface.get(archiveAfter.seq), 'current');

  const plain = codexSource.surfaceOf([{ seq: 0, data: { type: 'session_meta' } }]);
  assert.deepEqual([...plain.values()], ['current']);
});

test('titleOf: 第一条真正的 user 消息前 60 字，压空白；无 user 返回 null', () => {
  assert.equal(codexSource.titleOf(session1.events), 'Fix the login bug in lib/auth.mjs');
  assert.equal(codexSource.titleOf(archived.events), 'Archived conversation about zstd decoding');
  assert.equal(codexSource.titleOf([]), null);
  assert.ok(!String(codexSource.titleOf(session1.events)).startsWith('<environment_context>'));
  assert.ok(!String(codexSource.titleOf(archived.events)).startsWith('# AGENTS.md'));

  const long = [
    {
      seq: 0,
      data: {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `  hello\n\n world ${'x'.repeat(80)}` }],
        },
      },
    },
  ];
  const title = codexSource.titleOf(long);
  assert.equal(title.length, 60);
  assert.ok(!/\s{2}/.test(title), '标题必须压掉连续空白');
});

test('renderEvent: role 限定在 user/assistant/tool/event', () => {
  const user = findEvent(
    session1.events,
    (event) => payloadOf(event).role === 'user' && userTexts(event).includes('login bug'),
  );
  const complete = findEvent(session1.events, (event) => payloadOf(event).type === 'task_complete');
  const call = findEvent(session1.events, (event) => payloadOf(event).type === 'function_call');
  const compacted = session1.events.find((event) => event.seq === COMPACTED_INDEX);
  assert.ok(user && complete && call && compacted);

  assert.deepEqual(codexSource.renderEvent(user), { role: 'user', text: 'Fix the login bug in lib/auth.mjs' });
  assert.equal(codexSource.renderEvent(complete).role, 'assistant');
  assert.equal(codexSource.renderEvent(call).role, 'tool');
  assert.deepEqual(codexSource.renderEvent(compacted), { role: 'event', text: 'compacted' });
  for (const event of session1.events) {
    assert.ok(['user', 'assistant', 'tool', 'event'].includes(codexSource.renderEvent(event).role));
  }
});

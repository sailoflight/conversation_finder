// tests/claude.test.mjs — Claude Code 适配器
//
// 测试**只依赖合成 fixture**（mkdtempSync），绝不读真实语料目录
// 那种私有样本：样本会被移走，而适配器的契约不该跟着漂。
// 覆盖：header/title、行号 seq 稳定性、_truncated 跳过、坏行/空文件容错、
// 各类块的文档映射、tool_result 数组递归、renderEvent 角色、compact_boundary 遮蔽。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeSource } from '../lib/sources/claude.mjs';

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const NESTED_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const CWD = '/tmp/claude-fixture-project';
const TS = '2026-01-02T03:04:05.000Z';

const root = mkdtempSync(join(tmpdir(), 'cfind-claude-'));
const projects = join(root, 'projects');
const projectDir = join(projects, '-tmp-fixture-demo');
const nestedDir = join(projects, '-nested-fixture', 'deep');
const fakeHome = join(root, 'home');
const iirDir = join(fakeHome, '.local', 'state', 'iir', 'domains', 'dom-a', 'home', '.claude', 'projects', '-tmp-iir');
mkdirSync(projectDir, { recursive: true });
mkdirSync(nestedDir, { recursive: true });
mkdirSync(iirDir, { recursive: true });

const mainPath = join(projectDir, `${SESSION_ID}.jsonl`);
const nestedPath = join(nestedDir, `${NESTED_ID}.jsonl`);
const iirPath = join(iirDir, 'iir-session.jsonl');
const compactPath = join(projectDir, 'compact-session.jsonl');
const badPath = join(projectDir, 'bad-lines.jsonl');
const emptyPath = join(projectDir, 'empty-session.jsonl');

/** 行数组 → JSONL 文本；字符串原样写（用来造坏行）。 */
const jsonl = (records) => `${records.map((record) => (typeof record === 'string' ? record : JSON.stringify(record))).join('\n')}\n`;

const userRecord = (content, extra = {}) => ({
  type: 'user',
  parentUuid: null,
  isSidechain: false,
  uuid: 'u-1',
  timestamp: TS,
  sessionId: SESSION_ID,
  cwd: CWD,
  version: '2.1.306',
  gitBranch: 'main',
  message: { role: 'user', content },
  ...extra,
});

// 主 fixture 的每一行都对应一个确定的 seq；中间故意塞坏行和 _truncated 来验证不重排。
const mainRecords = [
  { type: 'mode', mode: 'normal', sessionId: SESSION_ID }, // 0 噪声
  userRecord('开始排查登录问题'), // 1 user（字符串 content）
  { type: 'file-history-snapshot', messageId: 'm-1', snapshot: {}, isSnapshotUpdate: false }, // 2 噪声
  {
    // 3 assistant：text + thinking + tool_use 三种块
    type: 'assistant',
    parentUuid: 'u-1',
    uuid: 'a-1',
    timestamp: '2026-01-02T03:04:06.000Z',
    sessionId: SESSION_ID,
    cwd: CWD,
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '先看日志', signature: 'sig' },
        { type: 'text', text: '我先检查登录日志。' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls /tmp' } },
      ],
    },
  },
  {
    // 4 user 记录里回灌 tool_result；content 是块数组，正文还要再递归一层
    type: 'user',
    parentUuid: 'a-1',
    uuid: 'u-2',
    timestamp: '2026-01-02T03:04:07.000Z',
    sessionId: SESSION_ID,
    cwd: CWD,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: '日志里有一条 401' }] }],
    },
  },
  { type: 'ai-title', aiTitle: '登录问题排查', sessionId: SESSION_ID }, // 5 title
  { type: 'attachment', attachment: { type: 'environment' }, rendered: [{ content: 'env' }] }, // 6 噪声
  { type: 'api-request', sessionId: SESSION_ID, params: { model: 'claude-opus-5-5' } }, // 7 噪声
  { type: '_truncated', note: '原文很长，这里只留头尾', head_lines: 8, tail_lines: 1, total_lines: 99 }, // 8 跳过
  {
    // 9 system local_command：正文降权为 other
    type: 'system',
    subtype: 'local_command',
    content: '<local-command-stdout>ok</local-command-stdout>',
    timestamp: '2026-01-02T03:04:08.000Z',
    sessionId: SESSION_ID,
    cwd: CWD,
  },
  { type: 'queue-operation', operation: 'enqueue', content: 'noise', sessionId: SESSION_ID }, // 10 噪声
  { type: 'cost-state', totalCostUSD: 1, sessionId: SESSION_ID }, // 11 噪声
  { type: 'ai-title', aiTitle: '登录问题排查（更新）', sessionId: SESSION_ID }, // 12 最后一条 title
];
writeFileSync(mainPath, jsonl(mainRecords));

writeFileSync(nestedPath, jsonl([userRecord('嵌套目录里的会话', { sessionId: NESTED_ID })]));
writeFileSync(iirPath, jsonl([userRecord('IIR 边界内家目录的会话', { sessionId: 'cccccccc-3333-4333-8333-333333333333' })]));

const compactRecords = [
  userRecord('压缩前的旧问题', { uuid: 'c-1' }), // 0 shadowed
  {
    // 1 shadowed
    type: 'assistant',
    uuid: 'c-2',
    timestamp: '2026-01-02T03:04:06.000Z',
    sessionId: SESSION_ID,
    cwd: CWD,
    message: { role: 'assistant', content: [{ type: 'text', text: '压缩前的旧回答' }] },
  },
  {
    // 2 第一个压缩边界
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    timestamp: '2026-01-02T03:04:07.000Z',
    sessionId: SESSION_ID,
    cwd: CWD,
  },
  userRecord('第一次压缩摘要', { uuid: 'c-3', isCompactSummary: true }), // 3 shadowed（被第二次压缩覆盖）
  userRecord('第一次压缩后的新问题', { uuid: 'c-4' }), // 4 shadowed
  {
    // 5 最后一个压缩边界
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    timestamp: '2026-01-02T03:04:08.000Z',
    sessionId: SESSION_ID,
    cwd: CWD,
  },
  userRecord('第二次压缩摘要', { uuid: 'c-5', isCompactSummary: true }), // 6 current
  userRecord('第二次压缩后的新问题', { uuid: 'c-6' }), // 7 current
];
writeFileSync(compactPath, jsonl(compactRecords));

const goodUser = userRecord('坏行之前', { uuid: 'b-1' });
const goodUser2 = userRecord('坏行之后', { uuid: 'b-2' });
writeFileSync(badPath, `${JSON.stringify(goodUser)}\n{"type":"user", "message": 这不是合法 JSON\n${JSON.stringify(goodUser2)}\n`);
writeFileSync(emptyPath, '');

after(() => rmSync(root, { recursive: true, force: true }));

const eventAt = (events, seq) => events.find((event) => event.seq === seq);

// ── 测试 ─────────────────────────────────────────────────────────────────

test('discover: CLAUDE_HOME 下递归发现 .jsonl，并带 sessionHint/size/mtime', () => {
  const previous = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = projects; // 覆盖家目录下的 .claude/projects
  try {
    const refs = claudeSource.discover();
    const main = refs.find((file) => file.ref === mainPath);
    assert.ok(main, '应发现主 fixture 文件');
    assert.equal(main.sessionHint, SESSION_ID);
    assert.equal(main.size, statSync(mainPath).size);
    assert.equal(typeof main.mtime, 'number');

    const nested = refs.find((file) => file.ref === nestedPath);
    assert.ok(nested, '应递归发现嵌套目录里的 .jsonl');
    assert.equal(nested.sessionHint, NESTED_ID);
    assert.equal(claudeSource.detect(), true);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_HOME;
    else process.env.CLAUDE_HOME = previous;
  }
});

test('discover: 扫描 IIR 边界内 home/.claude/projects（真实样本的来源路径）', () => {
  const previousHome = process.env.HOME;
  const previousClaudeHome = process.env.CLAUDE_HOME;
  delete process.env.CLAUDE_HOME; // 走真实家目录分支
  process.env.HOME = fakeHome;
  try {
    const refs = claudeSource.discover();
    const found = refs.find((file) => file.ref === iirPath);
    assert.ok(found, '应发现 ~/.local/state/iir/domains/*/home/.claude/projects 下的会话');
    assert.equal(found.sessionHint, 'iir-session');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousClaudeHome === undefined) delete process.env.CLAUDE_HOME;
    else process.env.CLAUDE_HOME = previousClaudeHome;
  }
});

test('readAll: header 取 sessionId/cwd，title 取最后一条 ai-title', () => {
  const { header, events } = claudeSource.readAll(mainPath);
  assert.equal(header.id, SESSION_ID);
  assert.equal(header.cwd, CWD);
  assert.equal(header.createdAt, Date.parse(TS));
  assert.equal(header.parentId, null);
  assert.equal(header.agentPreset, null);
  assert.equal(claudeSource.titleOf(events), '登录问题排查（更新）');
  // 只有第一条 user 记录带 timestamp，后面的噪声不影响 createdAt。
  assert.equal(eventAt(events, 1).time, Date.parse(TS));
});

test('readAll: seq 用物理行号，_truncated 被跳过且不重排后续 seq', () => {
  const { events } = claudeSource.readAll(mainPath);
  assert.equal(events.length, mainRecords.length - 1, '_truncated 不应产生事件');
  assert.deepEqual(
    events.map((event) => event.seq),
    [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12],
  );
  assert.ok(events.every((event) => event.data.type !== '_truncated'));
  // _truncated 在 8，system 在 9：若按过滤后重排，这里会变成 8。
  assert.equal(eventAt(events, 9).type, 'system');
});

test('toDocs: 各类块映射正确，噪声类型一个文档都不产生', () => {
  const { events } = claudeSource.readAll(mainPath);
  const docsBySeq = new Map(events.map((event) => [event.seq, claudeSource.toDocs(event)]));

  assert.deepEqual(docsBySeq.get(1), [{ kind: 'user', body: '开始排查登录问题' }]);
  assert.deepEqual(
    docsBySeq.get(3).map((doc) => doc.kind),
    ['assistant', 'reasoning', 'tool-call'],
  );
  assert.match(docsBySeq.get(3).find((doc) => doc.kind === 'tool-call').body, /Bash/);
  assert.match(docsBySeq.get(3).find((doc) => doc.kind === 'tool-call').body, /ls \/tmp/);

  // tool_result 的 content 是 [{type:'text'}]，必须递归取出文本。
  const toolDocs = docsBySeq.get(4);
  assert.equal(toolDocs.length, 1);
  assert.equal(toolDocs[0].kind, 'tool-result');
  assert.match(toolDocs[0].body, /401/);

  assert.equal(docsBySeq.get(5)[0].kind, 'title');
  assert.equal(docsBySeq.get(5)[0].body, '登录问题排查');
  assert.equal(docsBySeq.get(9)[0].kind, 'other');
  assert.equal(docsBySeq.get(12)[0].body, '登录问题排查（更新）');

  // 噪声：mode / file-history-snapshot / attachment / api-request / queue-operation / cost-state
  for (const seq of [0, 2, 6, 7, 10, 11]) assert.deepEqual(docsBySeq.get(seq), [], `seq ${seq} 是噪声`);
});

test('renderEvent: user/assistant/tool/system/event 角色映射', () => {
  const { events } = claudeSource.readAll(mainPath);

  assert.deepEqual(claudeSource.renderEvent(eventAt(events, 1)), { role: 'user', text: '开始排查登录问题' });

  const assistant = claudeSource.renderEvent(eventAt(events, 3));
  assert.equal(assistant.role, 'assistant');
  assert.match(assistant.text, /我先检查登录日志/);
  assert.match(assistant.text, /\[thinking\] 先看日志/);
  assert.match(assistant.text, /\[tool_use Bash\]/);

  const tool = claudeSource.renderEvent(eventAt(events, 4));
  assert.equal(tool.role, 'tool');
  assert.match(tool.text, /401/);

  const system = claudeSource.renderEvent(eventAt(events, 9));
  assert.equal(system.role, 'system');
  assert.match(system.text, /<local-command-stdout>ok/);

  assert.deepEqual(claudeSource.renderEvent(eventAt(events, 0)), { role: 'event', text: '' });
  assert.deepEqual(claudeSource.renderEvent(eventAt(events, 5)), { role: 'event', text: '登录问题排查' });
});

test('surfaceOf: compact_boundary 之前的历史 shadowed，多次压缩取最后一个边界', () => {
  const { events } = claudeSource.readAll(compactPath);
  const surface = claudeSource.surfaceOf(events);
  for (const seq of [0, 1, 2, 3, 4]) assert.equal(surface.get(seq), 'shadowed', `seq ${seq} 应 shadowed`);
  for (const seq of [5, 6, 7]) assert.equal(surface.get(seq), 'current', `seq ${seq} 应 current`);

  // 摘要仍然要被索引（它是压缩后模型真正看得见的记忆本体）。
  const summary = claudeSource.toDocs(eventAt(events, 6));
  assert.equal(summary[0].kind, 'user');
  assert.match(summary[0].body, /第二次压缩摘要/);
});

test('readAll: 没有 compact_boundary 的会话全部 current', () => {
  const { events } = claudeSource.readAll(mainPath);
  const surface = claudeSource.surfaceOf(events);
  assert.ok([...surface.values()].every((value) => value === 'current'));
});

test('readAll: 坏行只跳过该行，seq 仍是物理行号', () => {
  const { header, events } = claudeSource.readAll(badPath);
  assert.equal(header.id, SESSION_ID);
  assert.deepEqual(events.map((event) => event.seq), [0, 2]);
  assert.deepEqual(events.map((event) => event.data.message.content), ['坏行之前', '坏行之后']);
});

test('readAll: 空文件不崩，id 回退到文件名，事件为空', () => {
  const { header, events, consumed } = claudeSource.readAll(emptyPath);
  assert.deepEqual(events, []);
  assert.equal(header.id, 'empty-session');
  assert.equal(header.cwd, null);
  assert.equal(header.createdAt, null);
  assert.equal(consumed, 0);
});

// tests/opencode.test.mjs — OpenCode 适配器的契约测试
//
// 全部用 mkdtempSync 造合成语料，**不依赖**任何真实样本目录
// （真实样本会漂移；它只在开发时手动核对，见最终回报）。
//
// 覆盖：
//   · 聚合 jsonl（user/assistant/reasoning/tool/idle/坏行/行号 seq）
//   · 2.x SQLite：session_message + session_v2，只读打开、原生 seq、db title 优先
//   · 1.x SQLite：session/message/part，part 拼正文、state.output 当 tool-result
//   · 压缩边界（compaction 之前 shadowed）、idle 不索引、未知表结构抛清晰错误
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { opencodeSource } from '../lib/sources/opencode.mjs';

const SID = 'ses_test_fixture';
const USER1 = '第一条用户消息：请解释幂等性';
const ASST_TEXT = '幂等性是指同一操作重复执行结果一致。';
const REASONING = '先回忆幂等性的定义。';
const TOOL_OUT = 'file-a.txt\nfile-b.txt';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cfind-opencode-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 临时设置/恢复环境变量（detect/discover 都按调用时读 env）。 */
function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function writeJsonl(path, records) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    records.map((record) => (typeof record === 'string' ? record : JSON.stringify(record))).join('\n') + '\n',
    'utf8',
  );
}

/** 2.x 形态：session_message（data JSON）+ session_v2（title/元数据）。 */
function makeDb2(t, { title = 'DB 会话标题', rows = [], sessionId = SID } = {}) {
  const dir = tempDir(t);
  const path = join(dir, 'opencode.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, agent TEXT, parent_id TEXT
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT
    );
  `);
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)').run(
    sessionId,
    title,
    '/work/demo',
    500,
    'build',
    'parent-1',
  );
  const insert = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)');
  for (const row of rows) insert.run(row.id, row.sessionId ?? sessionId, row.type, row.seq, row.time, JSON.stringify(row.data));
  db.close();
  return path;
}

function assistantData() {
  return {
    time: { created: 2000, completed: 2100 },
    agent: 'build',
    content: [
      { type: 'text', text: ASST_TEXT },
      { type: 'reasoning', text: REASONING },
      {
        type: 'tool',
        id: 'call_1',
        name: 'shell',
        state: {
          status: 'completed',
          input: { command: 'ls' },
          content: [{ type: 'text', text: TOOL_OUT }],
          metadata: {},
        },
      },
    ],
  };
}

test('opencode jsonl：行号 seq、文本/推理/工具提取、坏行跳过、idle 不索引', (t) => {
  const dir = tempDir(t);
  const path = join(dir, `session-${SID}-2026-10-23.jsonl`);
  writeJsonl(path, [
    { type: 'user', seq: 4, data: { time: { created: 1000 }, text: USER1, files: [], agents: [] } },
    { type: 'assistant', seq: 5, data: assistantData() },
    { type: 'idle', seq: 9, data: { time: { created: 2200 }, outcome: 'succeeded' } },
    '{ 这不是 JSON，导出器可能留下半行',
    { type: 'user', seq: 14, data: { time: { created: 3000 }, text: '第二条用户消息' } },
  ]);

  const result = opencodeSource.readAll({ ref: path, kind: 'jsonl' });

  // seq 用物理行号：坏行占第 4 行被跳过，下一条是 5（不是 4）。
  assert.deepEqual(
    result.events.map((event) => [event.seq, event.type]),
    [
      [1, 'user'],
      [2, 'assistant'],
      [3, 'idle'],
      [5, 'user'],
    ],
  );
  assert.equal(result.header.id, SID);
  assert.equal(result.header.createdAt, 1000);
  assert.equal(result.header.agentPreset, 'build');
  assert.equal(result.header.cwd, null);
  assert.equal(opencodeSource.titleOf(result.events), USER1);
  assert.ok(result.consumed > 0);

  const docs = result.events.flatMap((event) => opencodeSource.toDocs(event));
  const kinds = docs.map((doc) => doc.kind).sort();
  assert.deepEqual(kinds, ['assistant', 'reasoning', 'tool-call', 'tool-result', 'user', 'user']);
  const toolResult = docs.find((doc) => doc.kind === 'tool-result');
  assert.equal(toolResult.body, TOOL_OUT);
  const toolCall = docs.find((doc) => doc.kind === 'tool-call');
  assert.match(toolCall.body, /^shell/);
  assert.match(toolCall.body, /command/);

  // idle 明确不产文档。
  assert.deepEqual(opencodeSource.toDocs(result.events[2]), []);

  const surface = opencodeSource.surfaceOf(result.events);
  assert.deepEqual([...surface.values()], ['current', 'current', 'current', 'current']);

  assert.deepEqual(opencodeSource.renderEvent(result.events[0]), { role: 'user', text: USER1 });
  assert.deepEqual(opencodeSource.renderEvent(result.events[1]), { role: 'assistant', text: ASST_TEXT });
  assert.deepEqual(opencodeSource.renderEvent(result.events[2]), { role: 'event', text: 'idle (succeeded)' });
});

test('opencode titleOf：第一条 user 前 60 字，换行压成单行', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'session-ses_title-2026-01-01.jsonl');
  const long = `第一行标题\n    第二行   ${'x'.repeat(100)}`;
  writeJsonl(path, [{ type: 'user', data: { text: long } }]);

  const { events } = opencodeSource.readAll({ ref: path, kind: 'jsonl' });
  const title = opencodeSource.titleOf(events);
  assert.equal(Array.from(title).length, 60);
  assert.equal(title.includes('\n'), false);
  assert.match(title, /^第一行标题 第二行/);
});

test('opencode sqlite 2.x：session_message 只读读取、原生 seq、db title 优先、compaction 遮蔽', (t) => {
  const path = makeDb2(t, {
    title: 'DB 里的会话标题',
    rows: [
      {
        id: 'msg_1',
        type: 'user',
        seq: 3,
        time: 1000,
        data: { time: { created: 1000 }, text: '数据库用户问题' },
      },
      {
        id: 'msg_2',
        type: 'assistant',
        seq: 7,
        time: 2000,
        data: assistantData(),
      },
      {
        id: 'msg_3',
        type: 'idle',
        seq: 9,
        time: 3000,
        data: { time: { created: 3000 }, outcome: 'succeeded' },
      },
      {
        id: 'msg_4',
        type: 'compaction',
        seq: 12,
        time: 4000,
        data: { status: 'completed', summary: 'DB 压缩摘要', time: { created: 4000 } },
      },
    ],
  });

  const result = opencodeSource.readAll({ ref: path, kind: 'db' });
  assert.equal(result.header.id, SID);
  assert.equal(result.header.cwd, '/work/demo');
  assert.equal(result.header.createdAt, 500);
  assert.equal(result.header.agentPreset, 'build');
  assert.equal(result.header.parentId, 'parent-1');
  assert.deepEqual(
    result.events.map((event) => event.seq),
    [3, 7, 9, 12],
  );

  // db 的 title 优先于第一条 user。
  assert.equal(opencodeSource.titleOf(result.events), 'DB 里的会话标题');

  // compaction（seq 12）之前的历史被压缩掉；它自己是 current。
  const surface = opencodeSource.surfaceOf(result.events);
  assert.deepEqual(
    result.events.map((event) => surface.get(event.seq)),
    ['shadowed', 'shadowed', 'shadowed', 'current'],
  );

  const docs = result.events.flatMap((event) => opencodeSource.toDocs(event));
  assert.deepEqual(
    docs.map((doc) => doc.kind).sort(),
    ['assistant', 'compaction', 'reasoning', 'tool-call', 'tool-result', 'user'],
  );
  assert.equal(docs.find((doc) => doc.kind === 'tool-result').body, TOOL_OUT);
  assert.match(docs.find((doc) => doc.kind === 'compaction').body, /DB 压缩摘要/);

  // 按 sessionId 过滤也走同一条 db 路径。
  const filtered = opencodeSource.readAll({ ref: path, kind: 'db', sessionId: SID });
  assert.equal(filtered.events.length, 4);
  const missing = opencodeSource.readAll({ ref: path, kind: 'db', sessionId: 'ses_missing' });
  assert.equal(missing.events.length, 0);
  assert.equal(missing.header.id, 'ses_missing');
});

test('opencode sqlite：单 db ref 混多会话时聚合为 db 级会话，seq 不冲突', (t) => {
  const path = makeDb2(t, {
    rows: [{ id: 'msg_a', type: 'user', seq: 3, time: 1000, data: { time: { created: 1000 }, text: 'A 会话' } }],
  });
  const db = new DatabaseSync(path);
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)').run(
    'ses_other',
    '另一个标题',
    '/other',
    600,
    'build',
    null,
  );
  db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(
    'msg_b',
    'ses_other',
    'user',
    3,
    2000,
    JSON.stringify({ time: { created: 2000 }, text: 'B 会话' }),
  );
  // 只压缩 A 会话；按旧实现（全局 seq）它会把 B 会话也更早的事件一起标成 shadowed。
  db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(
    'msg_c',
    SID,
    'compaction',
    9,
    3000,
    JSON.stringify({ status: 'completed', summary: 'A 会话压缩摘要', time: { created: 3000 } }),
  );
  db.close();

  const result = opencodeSource.readAll({ ref: path, kind: 'db' });
  // 两个会话的原生 seq 都是 3；聚合时必须重新编号，否则 events 主键会撞。
  assert.deepEqual(result.events.map((event) => event.seq), [1, 2, 3]);
  assert.deepEqual(
    result.events.map((event) => event.sessionId),
    ['ses_other', SID, SID],
  );
  // 多会话不借用某个会话的 title/cwd；id 用 db 名，sessions 里保留真实 id。
  assert.equal(result.header.id, 'opencode');
  assert.deepEqual(result.header.sessions.sort(), ['ses_other', 'ses_test_fixture']);
  assert.equal(opencodeSource.titleOf(result.events), 'B 会话');

  // 压缩边界按会话隔离：A 的 compaction 只遮蔽 A 的 user，不碰 B 的 user。
  const surface = opencodeSource.surfaceOf(result.events);
  assert.deepEqual(
    result.events.map((event) => surface.get(event.seq)),
    ['current', 'shadowed', 'current'],
  );
});

test('opencode sqlite 1.x：session/message/part 三表 + state.output 工具结果', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'opencode.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_created INTEGER, agent TEXT, parent_id TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT
    );
  `);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run(
    SID,
    '1.x 会话标题',
    '/legacy/dir',
    500,
    'build',
    'parent-0',
  );
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
    'msg_1',
    SID,
    1000,
    JSON.stringify({ role: 'user', time: { created: 1000 } }),
  );
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(
    'prt_1',
    'msg_1',
    SID,
    1100,
    JSON.stringify({ type: 'text', text: '1.x 用户问题' }),
  );
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
    'msg_2',
    SID,
    2000,
    JSON.stringify({ role: 'assistant', agent: 'build', time: { created: 2000 } }),
  );
  for (const [id, time, data] of [
    ['prt_2', 2100, { type: 'reasoning', text: '1.x 推理' }],
    ['prt_3', 2200, { type: 'text', text: '1.x 回答' }],
    [
      'prt_4',
      2300,
      {
        type: 'tool',
        callID: 'call_legacy',
        tool: 'shell',
        state: { status: 'completed', input: { command: 'pwd' }, output: '/tmp/legacy' },
      },
    ],
  ]) {
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(id, 'msg_2', SID, time, JSON.stringify(data));
  }
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
    'msg_3',
    SID,
    3000,
    JSON.stringify({ role: 'user', time: { created: 3000 } }),
  );
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(
    'prt_5',
    'msg_3',
    SID,
    3100,
    JSON.stringify({ type: 'compaction', auto: true }),
  );
  db.close();

  const result = opencodeSource.readAll({ ref: path, kind: 'db' });
  assert.deepEqual(
    result.events.map((event) => event.type),
    ['user', 'assistant', 'user'],
  );
  assert.deepEqual(
    result.events.map((event) => event.seq),
    [1, 2, 3],
  );
  assert.equal(result.header.id, SID);
  assert.equal(result.header.cwd, '/legacy/dir');
  assert.equal(result.header.parentId, 'parent-0');
  assert.equal(opencodeSource.titleOf(result.events), '1.x 会话标题');

  // 1.x 的正文在 part 里：text/reasoning 拼回 content，output 变 tool-result。
  const docs = result.events.flatMap((event) => opencodeSource.toDocs(event));
  assert.deepEqual(docs.map((doc) => doc.kind).sort(), [
    'assistant',
    'reasoning',
    'tool-call',
    'tool-result',
    'user',
  ]);
  assert.equal(docs.find((doc) => doc.kind === 'tool-result').body, '/tmp/legacy');
  assert.equal(docs.find((doc) => doc.kind === 'tool-result').body.match(/\/tmp\/legacy/g).length, 1);
  assert.match(docs.find((doc) => doc.kind === 'tool-call').body, /^shell/);

  assert.deepEqual(opencodeSource.renderEvent(result.events[0]), { role: 'user', text: '1.x 用户问题' });
  assert.deepEqual(opencodeSource.renderEvent(result.events[1]), { role: 'assistant', text: '1.x 回答' });

  // 1.x compaction 是 part：msg_3 是边界，之前两条 shadowed。
  const surface = opencodeSource.surfaceOf(result.events);
  assert.deepEqual(
    result.events.map((event) => surface.get(event.seq)),
    ['shadowed', 'shadowed', 'current'],
  );
});

test('opencode sqlite：未知表结构抛清晰错误，不返回空数组', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'weird.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE foo (id TEXT)');
  db.close();

  assert.throws(() => opencodeSource.readAll({ ref: path, kind: 'db' }), /无法识别的数据库结构/);
  assert.throws(() => opencodeSource.readAll({ ref: path, kind: 'db' }), /foo/);

  // 表名对但缺必需列，同样不能静默。
  const partial = join(dir, 'partial.db');
  const broken = new DatabaseSync(partial);
  broken.exec('CREATE TABLE session_message (id TEXT)');
  broken.close();
  assert.throws(() => opencodeSource.readAll({ ref: partial, kind: 'db' }), /缺少必需列/);

  assert.throws(() => opencodeSource.readAll({ ref: join(dir, 'nope.db'), kind: 'db' }), /不存在/);
});

test('opencode discover：db 与 OPENCODE_DIR 下的 **/*.jsonl 都产出候选', (t) => {
  const xdg = tempDir(t);
  const jsonlDir = tempDir(t);
  mkdirSync(join(xdg, 'opencode'), { recursive: true });
  makeEmptyDb(join(xdg, 'opencode', 'opencode.db'));
  writeJsonl(join(jsonlDir, 'nested', `session-${SID}-2026-01-01.jsonl`), [
    { type: 'user', data: { text: 'jsonl fixture' } },
  ]);

  withEnv({ XDG_DATA_HOME: xdg, OPENCODE_DIR: jsonlDir, OPENCODE_DB: undefined }, () => {
    const refs = opencodeSource.discover();
    assert.equal(opencodeSource.detect(), true);
    assert.deepEqual(refs.map((ref) => ref.kind), ['db', 'jsonl']);
    assert.equal(refs[0].ref, join(xdg, 'opencode', 'opencode.db'));
    assert.equal(refs[1].ref, join(jsonlDir, 'nested', `session-${SID}-2026-01-01.jsonl`));
    assert.equal(refs[1].sessionHint, SID);
    assert.ok(refs.every((ref) => Number.isInteger(ref.size) && ref.mtime));
  });
});

test('opencode detect：没有任何 db/jsonl 时为 false 且 discover 为空', (t) => {
  const empty = tempDir(t);
  withEnv({ XDG_DATA_HOME: empty, OPENCODE_DIR: undefined, OPENCODE_DB: undefined }, () => {
    assert.equal(opencodeSource.detect(), false);
    assert.deepEqual(opencodeSource.discover(), []);
  });
});

test('opencode toDocs：idle/未知类型不索引，空文本不产文档', () => {
  assert.deepEqual(opencodeSource.toDocs({ type: 'idle', data: { outcome: 'succeeded' } }), []);
  assert.deepEqual(opencodeSource.toDocs({ type: 'mystery', data: { text: '不该被兜底索引' } }), []);
  assert.deepEqual(opencodeSource.toDocs({ type: 'user', data: { text: ' ' } }), []);
});

/** 只建空表，给 discover 测试一个可 stat 的合法 db 文件。 */
function makeEmptyDb(path) {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)');
  db.close();
}

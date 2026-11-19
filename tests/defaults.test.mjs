// tests/defaults.test.mjs — 作用域自适应的默认表面 + 区域排除
//
// 两条规则都来自「零重复」这一个原则：
//
//   1. 自己的会话 → 默认搜**压缩前**（shadowed）。
//      理由：压缩之后的内容仍在我的上下文里，检索它只会把已经占着窗口的字节
//      再复制一遍。真正想不起来的，恰好是被压掉的那一半。
//
//   2. 别人的会话 / 全局 → 默认搜**全部**（all）。
//      理由：它们的压缩前历史从来没进过我的上下文，排除它只是丢信息，
//      一个 token 也省不下来。
//
//   3. 区域排除（`exclude`）：grep 没有这个概念，但会话语料里
//      `tool-call + tool-result` 占六成以上、`reasoning` 又占近两成 ——
//      真实数据里排除它们能把命中量从 209 降到 15（93% 噪音）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/schema.mjs';
import { search, resolveExclude } from '../lib/query.mjs';
import { defaultSurface } from '../lib/paths.mjs';
import { bigrams } from '../lib/cjk.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const MINE = 'sess-mine-1111';
const OTHER = 'sess-other-2222';

/** 两个会话各一条 user + 一条 tool-result，且都含同一个词。 */
function makeDb() {
  const db = openDb(':memory:');
  const insertSession = db.prepare(
    `INSERT INTO sessions (id, source, cwd, title, created_at, agent_preset, parent_id, event_count, first_time, last_time)
     VALUES (?, 'dsh', '/tmp/d', ?, 1700000000000, null, null, 2, 1700000000000, 1700000000000)`,
  );
  insertSession.run(MINE, '我的会话');
  insertSession.run(OTHER, '别人的会话');

  const insert = db.prepare(
    'INSERT INTO docs (body, sh, source, session_id, seq, kind, time, surface) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const add = (sessionId, seq, kind, body, surface) =>
    insert.run(body, bigrams(body), 'dsh', sessionId, seq, kind, 1700000000000 + seq, surface);

  // 我的会话：压缩前（shadowed）是我早就忘了的；压缩后（current）是还在上下文里的
  add(MINE, 1, 'user', '最初的指令：先预研究一个会话检索项目', 'shadowed');
  add(MINE, 2, 'user', '现在的进度：模糊搜索已经做完了', 'current');
  // 别人的会话：两种 surface 都算
  add(OTHER, 1, 'user', '别人写的：会话检索项目的一些想法', 'shadowed');
  add(OTHER, 2, 'assistant', '别人的答复：项目还在设计中', 'current');
  return db;
}

test('defaultSurface：自己的会话 → shadowed，别人的/全局 → all', () => {
  assert.equal(defaultSurface({ mode: 'session', id: MINE }, MINE), 'shadowed');
  assert.equal(defaultSurface({ mode: 'session', id: OTHER }, MINE), 'all');
  assert.equal(defaultSurface({ mode: 'all' }, MINE), 'all');
  assert.equal(defaultSurface({ mode: 'project', cwd: '/tmp/d' }, MINE), 'all');
  // 推断不出"我是谁"时保守取 all：漏搜比重复好（少了用户会以为工具坏了）
  assert.equal(defaultSurface({ mode: 'session', id: MINE }, undefined), 'all');
});

test('自己的会话默认能搜到压缩前的指令', () => {
  const db = makeDb();
  const result = search(db, {
    query: '预研究',
    scope: { mode: 'session', id: MINE },
    surface: defaultSurface({ mode: 'session', id: MINE }, MINE),
    limit: 10,
  });
  assert.ok(result.total > 0, '压缩前的内容应当可被默认搜到');
  assert.ok(result.hits.every((hit) => hit.surface === 'shadowed'));
});

test('自己的会话默认不会重复返回「还看得见」的内容', () => {
  const db = makeDb();
  const surface = defaultSurface({ mode: 'session', id: MINE }, MINE);
  const result = search(db, { query: '模糊搜索', scope: { mode: 'session', id: MINE }, surface, limit: 10 });
  // 「模糊搜索」只在 current 里 —— 默认（shadowed）应当搜不到，
  // 而它在上下文里本来就看得见，所以这是正确行为，不是缺陷。
  assert.equal(result.total, 0);
});

test('全局默认搜全部：别人会话的压缩前内容不会被排除', () => {
  const db = makeDb();
  const surface = defaultSurface({ mode: 'all' }, MINE);
  const result = search(db, { query: '想法', scope: { mode: 'all' }, surface, limit: 10 });
  assert.ok(result.total > 0, '别人会话的 shadowed 内容不能被默认排除');
  assert.ok(result.hits.some((hit) => hit.surface === 'shadowed'));
});

test('resolveExclude：区域名 → kind 集合，未知值报错而不是静默忽略', () => {
  assert.deepEqual(resolveExclude('tool'), ['tool-call', 'tool-result']);
  assert.deepEqual(resolveExclude('tool,reasoning').sort(), ['reasoning', 'tool-call', 'tool-result']);
  assert.deepEqual(resolveExclude('tool-result'), ['tool-result']);
  assert.deepEqual(resolveExclude(undefined), []);
  assert.deepEqual(resolveExclude(''), []);
  assert.deepEqual(resolveExclude([]), []);
  // 静默忽略会让人以为排除了却没排除，比报错危险得多
  assert.throws(() => resolveExclude('nonsense'), /未知的排除区域/);
});

test('exclude 真的把区域排掉了，且不影响其它 region', () => {
  const db = openDb(':memory:');
  db.prepare(
    `INSERT INTO sessions (id, source, cwd, title, created_at, agent_preset, parent_id, event_count, first_time, last_time)
     VALUES ('s1', 'dsh', '/tmp', 't', 1700000000000, null, null, 3, 1700000000000, 1700000000000)`,
  ).run();
  const insert = db.prepare(
    'INSERT INTO docs (body, sh, source, session_id, seq, kind, time, surface) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const add = (seq, kind, body) =>
    insert.run(body, bigrams(body), 'dsh', 's1', seq, kind, 1700000000000 + seq, 'current');
  add(1, 'user', '用户说了幂等键这件事');
  add(2, 'tool-result', '工具输出里也有幂等键这几个字');
  add(3, 'reasoning', '思考时提到幂等键');
  add(4, 'assistant', '答复里再次提到幂等键');

  const all = search(db, { query: '幂等键', scope: { mode: 'session', id: 's1' }, limit: 20 });
  assert.equal(all.total, 4);

  // 这里只有一条 tool-result（没有 tool-call），所以排除 tool 只少一条
  const noTool = search(db, { query: '幂等键', scope: { mode: 'session', id: 's1' }, limit: 20, exclude: 'tool' });
  assert.equal(noTool.total, 3);
  assert.ok(noTool.hits.every((hit) => hit.kind !== 'tool-result' && hit.kind !== 'tool-call'));

  const noNoise = search(db, {
    query: '幂等键',
    scope: { mode: 'session', id: 's1' },
    limit: 20,
    exclude: 'tool,reasoning',
  });
  assert.equal(noNoise.total, 2);
  assert.deepEqual(noNoise.hits.map((hit) => hit.kind).sort(), ['assistant', 'user']);
});

test('exclude 与 surface 可以叠加', () => {
  const db = makeDb();
  // 我的会话 shadowed 里只有 #1 一条 user
  const base = search(db, { query: '预研究', scope: { mode: 'session', id: MINE }, surface: 'shadowed', limit: 10 });
  assert.equal(base.total, 1);
  // 再排除 user → 应当为空（且不能报错）
  const excluded = search(db, {
    query: '预研究',
    scope: { mode: 'session', id: MINE },
    surface: 'shadowed',
    limit: 10,
    exclude: 'user',
  });
  assert.equal(excluded.total, 0);
});

test('CLI: --exclude 写错时干净报错、退出码 2、不吐堆栈', () => {
  // grep 不会因为 glob 写错就打印 C 栈帧。参数错误只该给人话 ——
  // 而且必须是**报错**而不是静默忽略：否则用户以为排除了，其实没排除。
  const result = spawnSync(process.execPath, ['--no-warnings', 'bin/cfind.mjs', 'x', '--exclude', 'nope'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CFIND_HOME: mkdtempSync(join(tmpdir(), 'cfind-excl-')) },
  });
  assert.equal(result.status, 2, '用法错误退出码应为 2');
  assert.match(result.stderr, /未知的排除区域/);
  assert.ok(!result.stderr.includes('at resolveExclude'), '不该打印堆栈');
  assert.ok(!result.stderr.includes('node:internal'), '不该打印堆栈');
});

test('resolveExclude：逗号串、数组、重复 flag 三种写法等价', () => {
  // CLI 的重复 flag 会被累加成数组 `['tool','reasoning']`，
  // 而 `--exclude tool,reasoning` 会变成 `['tool,reasoning']` ——
  // 后者如果不在数组项里再拆一次逗号，就会被当成一个叫 "tool,reasoning" 的区域名。
  const expected = ['reasoning', 'tool-call', 'tool-result'];
  assert.deepEqual(resolveExclude('tool,reasoning').sort(), expected);
  assert.deepEqual(resolveExclude(['tool', 'reasoning']).sort(), expected);
  assert.deepEqual(resolveExclude(['tool,reasoning']).sort(), expected, '数组项里的逗号串也要拆');
  assert.deepEqual(resolveExclude(['tool, reasoning']).sort(), expected, '允许逗号后带空格');
  assert.deepEqual(resolveExclude([' tool ', 'reasoning']).sort(), expected, '允许项首尾空格');
});

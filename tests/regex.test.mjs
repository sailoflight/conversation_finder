// tests/regex.test.mjs — 表达式检索（grep 同款）
//
// 分两类断言：
//   1. 语义正确：正则该匹配什么、不该匹配什么，且能与 scope/surface/exclude 叠加；
//   2. 安全：灾难性回溯必须被超时中止，而不是把调用方永久挂住。
//
// 第 2 类是重点 —— grep 用 DFA，所以 `(a+)+$` 伤不到它；JS 的 RegExp 是回溯引擎，
// 30 个 a 就要 19 秒，而语料里有 64,000 字符的事件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/schema.mjs';
import { search } from '../lib/query.mjs';
import { regexScan, REGEX_TIMEOUT_MS } from '../lib/regex.mjs';
import { bigrams } from '../lib/cjk.mjs';

/** 建一个**文件**索引：正则的隔离执行需要可共享的 dbPath。 */
function makeFileDb() {
  const dir = mkdtempSync(join(tmpdir(), 'cfind-re-'));
  const db = openDb(join(dir, 'index.db'));
  db.prepare(
    `INSERT INTO sessions (id, source, cwd, title, created_at, agent_preset, parent_id, event_count, first_time, last_time)
     VALUES ('sess-re-0001', 'dsh', '/tmp/d', '正则测试', 1700000000000, null, null, 5, 1700000000000, 1700000000000)`,
  ).run();
  const insert = db.prepare(
    'INSERT INTO docs (body, sh, source, session_id, seq, kind, time, surface) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const add = (seq, kind, body, surface = 'current') =>
    insert.run(body, bigrams(body), 'dsh', 'sess-re-0001', seq, kind, 1700000000000 + seq, surface);

  add(1, 'user', '初版实现：幂等键与重复扣款');
  add(2, 'assistant', '已修正：幂等键冲突时返回 409');
  add(3, 'tool-result', 'bash: grep -n "幂等键" src/db.js');
  add(4, 'user', '另一个话题：settlement_id 为空导致对账失败');
  add(5, 'reasoning', '思考：幂等键要不要存整串');
  // 回溯炸弹的引信：(a+)+$ 在一个长 a 串 + 结尾不匹配时会指数爆炸。
  // 真实语料里就有 64,000 字符的事件，所以这不是假想威胁。
  add(6, 'other', `${'a'.repeat(40)}X`);
  return { db, dir };
}

const SCOPE = { mode: 'session', id: 'sess-re-0001' };
const run = (db, query, extra = {}) => search(db, { query, scope: SCOPE, regex: true, limit: 20, ...extra });

test('正则：字面量匹配（grep 同款，不再走模糊纠错）', () => {
  const { db } = makeFileDb();
  const result = run(db, 'settlement_id');
  assert.equal(result.total, 1);
  assert.equal(result.hits[0].seq, 4);
  // 正则模式下不该"贴心"地纠错成 settlementId 之类
  assert.equal(run(db, 'settlementid').total, 0);
});

test('正则：交替 / 字符类 / 量词都生效', () => {
  const { db } = makeFileDb();
  // 交替
  assert.equal(run(db, 'settlement_id|幂等键').total, 5);
  // 字符类 + 量词
  assert.equal(run(db, '返回 ?[0-9]{3}').total, 1);
  // 锚点
  assert.equal(run(db, '^初版').total, 1);
  assert.equal(run(db, '^另一个话题').total, 1, '每行独立匹配');
});

test('正则：默认不区分大小写，且 CJK 正常工作', () => {
  const { db } = makeFileDb();
  assert.equal(run(db, 'BASH').total, 1);
  assert.equal(run(db, '幂等键.*(409|冲突)').total, 1);
});

test('正则：命中片上带 [ ] 标记，且围绕命中位置', () => {
  const { db } = makeFileDb();
  const [hit] = run(db, 'settlement_id').hits;
  assert.match(hit.snippet, /\[settlement_id\]/);
});

test('正则：能与 surface / exclude 叠加', () => {
  const { db } = makeFileDb();
  // 全部
  assert.equal(run(db, '幂等键').total, 4);
  // 排除工具输出后少一条
  assert.equal(run(db, '幂等键', { exclude: ['tool'] }).total, 3);
  // 再排 reasoning
  const noNoise = run(db, '幂等键', { exclude: ['tool', 'reasoning'] });
  assert.equal(noNoise.total, 2);
  assert.deepEqual(noNoise.hits.map((hit) => hit.kind).sort(), ['assistant', 'user']);
});

test('正则：语法错误立即报错（带 userFacing，不打印堆栈）', () => {
  const { db } = makeFileDb();
  assert.throws(() => run(db, '未闭合('), (error) => {
    assert.match(error.message, /正则语法错误/);
    assert.equal(error.userFacing, true);
    return true;
  });
});

test('正则：灾难性回溯被超时中止，且进程之后仍可用', () => {
  const { db } = makeFileDb();
  // 用很短的超时：这个模式在真实语料上要跑十几秒。
  const started = Date.now();
  assert.throws(
    () =>
      regexScan({
        db,
        dbPath: db.location(),
        sql: 'SELECT rowid, session_id, seq, kind, surface, time FROM docs WHERE 1=1 AND body REGEXP ?',
        params: [],
        pattern: '(a+)+$',
        limit: 1,
        timeoutMs: 300,
      }),
    (error) => {
      assert.match(error.message, /正则超过|灾难性回溯/);
      assert.equal(error.userFacing, true, '这种错误要给用户看人话而不是堆栈');
      return true;
    },
  );
  const elapsed = Date.now() - started;
  // 中止必须**接近**超时值：跑飞了就说明 terminate 没生效。
  assert.ok(elapsed < 3000, `中止太慢：${elapsed}ms`);

  // worker 被杀掉后主进程必须还能正常工作
  const after = run(db, 'settlement_id');
  assert.equal(after.total, 1);
});

test('正则：默认超时是个有限值（不能是 Infinity）', () => {
  assert.ok(Number.isFinite(REGEX_TIMEOUT_MS));
  assert.ok(REGEX_TIMEOUT_MS > 0 && REGEX_TIMEOUT_MS <= 30_000);
});

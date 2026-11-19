// tests/show-find.test.mjs — 「search 命中的位置，show 必须能定位到」
//
// 锁住一条容易静默违反的不变量：**L3（原文）必须包含 L2（检索）说命中了的那些内容**。
// 破坏它的方式很隐蔽：`renderEvent` 是"人读视角"（只给 text 块），
// `toDocs` 是"索引视角"（还包含 reasoning 块）。只要两者不一致，就会出现：
//
//   search 说「命中在 #86」→ show #86 → 里面根本找不到那个词
//
// 用户会以为命中是错的，而实际是显示层把内容丢了。
// 另外一条：一条事件可以有几万字符，命中可能在第 6 万字符处；从第 0 字符开始截同样看不到。
// 这两个坑都由 `find` 参数解决。
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../lib/schema.mjs';
import { syncIndex } from '../lib/store.mjs';
import { search, show } from '../lib/query.mjs';
import { renderShow, showNotes } from '../lib/format.mjs';
import { writeSessionFile } from './fixtures/make-fixture.mjs';

const SESSION = 'sess-bigfind-0001';
const PROJECT = '--tmp-find--';

/** reasoning 在前（很大）、可见 text 在后（很小）—— 真实 assistant/message 就是这个形状。 */
const DEEP_TERM = 'quarantine_marker';
// 关键：把这个词放在 reasoning 的**正中间**（前后各 2 万字符）。
// 放末尾的话，居中裁剪会被边界钳住、命中自然贴右缘 —— 那测不出"是否居中"。
const reasoning = `${'前置推理内容。'.repeat(3400)}这里藏着关键结论 ${DEEP_TERM} 结论完毕。${'后续推理内容。'.repeat(3400)}`;
const visible = '已经定位到唯一索引，准备补测试。';

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'cfind-find-'));
  writeSessionFile(join(root, PROJECT, SESSION, 'session.v4.jsonl.zstd'), [
    {
      type: 'session',
      version: 4,
      id: SESSION,
      createdAt: 1_700_000_000_000,
      cwd: '/tmp/find',
    },
    {
      type: 'assistant/message',
      seq: 1,
      time: 1_700_000_001_000,
      data: {
        message: {
          content: [
            { type: 'reasoning', text: reasoning },
            { type: 'text', text: visible },
          ],
        },
      },
    },
  ]);
  return root;
}

/**
 * 每个测试建一份独立的 root 与库。
 *
 * 注意**不能**在 setup 里删掉 root：`show` 是 L3，它的契约就是「回到磁盘重放原文」，
 * 文件不在就取不回来（这是设计，不是缺陷）。清理统一放 after()。
 */
const ROOTS = [];
function setup() {
  const root = makeRoot();
  ROOTS.push(root);
  const db = openDb(':memory:');
  syncIndex(db, { root, only: ['dsh'] });
  return db;
}

after(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

test('前提：命中的词在 reasoning 里，普通渲染视角看不到', () => {
  const db = setup();
  // 检索能命中（说明它确实被索引了）
  const result = search(db, { query: DEEP_TERM, scope: { mode: 'session', id: SESSION } });
  assert.ok(result.total > 0, '索引里应当有它');

  // 但默认的 show 正文里没有它 —— 这正是要修的问题
  const plain = show(db, { sessionId: SESSION, seq: 1, before: 0, after: 0 });
  assert.ok(!plain.events[0].text.includes(DEEP_TERM), '默认视角确实看不到（renderEvent 只给 text 块）');
  // 而且必须**明确告知**有多少内容没显示，否则用户会以为命中是错的
  const notes = showNotes(plain).join(' ');
  assert.match(notes, /more chars not shown/, `缺少提示: ${notes}`);
});

test('show --find 能定位到 reasoning 里的命中位置', () => {
  const db = setup();
  const found = show(db, { sessionId: SESSION, seq: 1, before: 0, after: 0, find: DEEP_TERM });
  assert.ok(found.events[0].text.includes(DEEP_TERM), 'show 必须能看到命中的词');

  // 渲染后仍然可见，并且被裁到预算内、居中显示
  const out = renderShow(found, { maxChars: 600, find: DEEP_TERM });
  assert.ok(out.includes(DEEP_TERM), '渲染后仍要包含命中词');
  assert.ok(out.length <= 700, `超预算: ${out.length}`);
  // 居中：命中词两侧都该有内容，而不是贴边
  const at = out.indexOf(DEEP_TERM);
  assert.ok(at > 100, `命中贴太左（${at}），说明没有居中`);
  assert.ok(out.length - at > 100, `命中贴太右（${at}/${out.length}），说明没有居中`);
});

test('给了 find 就不再提示「还有内容没显示」（已经看到了）', () => {
  const db = setup();
  const found = show(db, { sessionId: SESSION, seq: 1, before: 0, after: 0, find: DEEP_TERM });
  assert.deepEqual(showNotes(found, { find: DEEP_TERM }), []);
});

test('find 找不到时优雅退回，不崩也不吞掉原文', () => {
  const db = setup();
  const found = show(db, { sessionId: SESSION, seq: 1, before: 0, after: 0, find: '完全不存在的词zzz' });
  const out = renderShow(found, { maxChars: 400, find: '完全不存在的词zzz' });
  assert.ok(out.length > 0);
  assert.ok(out.includes('已定位') || out.includes('思考内容') || out.includes(SESSION.slice(0, 8)));
});

test('show 的 hidden 计数反映「索引有、显示无」的差额', () => {
  const db = setup();
  const plain = show(db, { sessionId: SESSION, seq: 1, before: 0, after: 0 });
  // reasoning 约 4.5 万字符，可见 text 只有十几个字符
  assert.ok(plain.target.hidden > 30_000, `hidden 应反映 reasoning 的量，实际 ${plain.target.hidden}`);
  // 给了 find 时不需要这个计数（已经直接定位了）
  const withFind = show(db, { sessionId: SESSION, seq: 1, before: 0, after: 0, find: DEEP_TERM });
  assert.equal(withFind.target.hidden, 0);
});

// tests/archive.test.mjs — 原始会话被删除后，`show` 必须还能用
//
// 这不是防御性编程，是真实场景：Claude Code 和 Codex 都会定期清理旧会话
// （sessionwiki 的 "archive mode"、cass 的 archive 都在处理它）。
//
// 没有这条退路时的症状特别迷惑：`search` 因为走索引照常给出命中，
// 但 `show` 读原始文件，一删就抛 "session file not found" ——
// 从用户视角看就是「刚搜到的东西忽然打不开了」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { buildFixture } from './fixtures/make-fixture.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../lib/schema.mjs';
import { syncIndex } from '../lib/store.mjs';
import { search, show } from '../lib/query.mjs';
import { renderShow, showNotes } from '../lib/format.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 测试语料**必须现生成**，不能读 `tests/fixtures/sessions`：
 * 那个目录是 .gitignore 的（会话文件入不了库），所以全新 clone 下来并不存在。
 * 直接读会在本地通过、在 CI / 别人机器上挂 —— 这类问题最难查。
 */
const fixtureRoot = () => buildFixture();

/** 建索引 → 找到一条命中 → 删掉原始会话目录。 */
function indexThenPrune() {
  const home = mkdtempSync(join(tmpdir(), 'cfind-archive-'));
  const root = join(home, 'sessions');
  cpSync(fixtureRoot(), root, { recursive: true });
  const db = openDb(join(home, 'index.db'));
  syncIndex(db, { root, now: 1700000000000, only: ['dsh'] });
  const hit = search(db, { query: 'settlement_id', scope: { mode: 'all' }, limit: 1 }).hits[0];
  assert.ok(hit, '前置条件：索引里应当有 settlement_id 的命中');
  rmSync(root, { recursive: true, force: true });
  return { db, home, hit };
}

test('原始文件被删除后 show 仍能从索引取回正文', () => {
  const { db, home, hit } = indexThenPrune();
  try {
    const result = show(db, { sessionId: hit.sessionId, seq: hit.seq });
    assert.ok(result.events.length > 0, '应当从索引重建出事件');
    assert.equal(result.archived, true, '必须标注为归档副本');
    // 正文必须真的含有检索词，否则就是「搜得到看不到」
    const joined = result.events.map((event) => event.text).join('\n');
    assert.match(joined, /settlement_id/, '重建的正文里必须包含命中的词');
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('原始文件被删除后，show 的上下文窗口仍然成立', () => {
  const { db, home, hit } = indexThenPrune();
  try {
    const narrow = show(db, { sessionId: hit.sessionId, seq: hit.seq, before: 0, after: 0 });
    const wide = show(db, { sessionId: hit.sessionId, seq: hit.seq, before: 3, after: 3 });
    assert.equal(narrow.events.length, 1, 'before=0/after=0 时只该有目标事件');
    assert.ok(wide.events.length >= narrow.events.length, '窗口放大后事件数不应减少');
    assert.ok(wide.events.some((event) => event.isTarget));
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('原始文件存在时 archived=false（不能把正常情况也标成归档）', () => {
  const home = mkdtempSync(join(tmpdir(), 'cfind-archive-live-'));
  try {
    const root = join(home, 'sessions');
    cpSync(fixtureRoot(), root, { recursive: true });
    const db = openDb(join(home, 'index.db'));
    syncIndex(db, { root, now: 1700000000000, only: ['dsh'] });
    const hit = search(db, { query: 'settlement_id', scope: { mode: 'all' }, limit: 1 }).hits[0];
    const result = show(db, { sessionId: hit.sessionId, seq: hit.seq });
    assert.equal(result.archived, false);
    db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('归档状态下要在输出里明确提示（否则会误以为读的是原文）', () => {
  const { db, home, hit } = indexThenPrune();
  try {
    const result = show(db, { sessionId: hit.sessionId, seq: hit.seq });
    const notes = showNotes(result);
    assert.ok(
      notes.some((note) => note.includes('已被删除') && note.includes('索引')),
      `提示应当说明内容来自索引重建：${JSON.stringify(notes)}`,
    );
    // 提示文字不能进 stdout（会被 | cut -d: 之类的管道当成命中行）
    const body = renderShow(result, { maxChars: 500 });
    assert.ok(!body.includes('原始会话文件已被删除'), '提示必须走 stderr，不能混进 stdout');
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('原始文件与索引都没有时，错误信息要说清楚', () => {
  const { db, home } = indexThenPrune();
  try {
    assert.throws(
      () => show(db, { sessionId: 'no-such-session-at-all', seq: 1 }),
      (error) => {
        assert.match(error.message, /session file not found/);
        assert.match(error.message, /索引里也没有/, '要区分"文件没了"与"这个事件不存在"');
        return true;
      },
    );
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 归档策略对索引的副作用：只增不减，所以需要显式回收 ──────────────────

test('sync 把消失的文件标记归档，而不是删掉内容', async () => {
  const { cpSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'cfind-sync-arch-'));
  try {
    const root = join(home, 'sessions');
    cpSync(fixtureRoot(), root, { recursive: true });
    const db = openDb(join(home, 'index.db'));
    syncIndex(db, { root, now: 1700000000000, only: ['dsh'] });
    const docsBefore = db.prepare('SELECT COUNT(*) AS c FROM docs').get().c;

    rmSync(join(root, '--tmp-fixture-demo--', 'aaaaaaaa-1111-4111-8111-111111111111'), {
      recursive: true,
      force: true,
    });
    const again = syncIndex(db, { root, now: 1700000000000, only: ['dsh'] });

    assert.equal(again.archived, 1);
    // 内容一条都不能少：这正是"归档"与"删除"的分界
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM docs').get().c, docsBefore);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 2);
    db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('purgeArchived 只在显式调用时清理，且不碰未归档的内容', async () => {
  const { cpSync } = await import('node:fs');
  const { purgeArchived } = await import('../lib/store.mjs');
  const home = mkdtempSync(join(tmpdir(), 'cfind-purge-'));
  try {
    const root = join(home, 'sessions');
    cpSync(fixtureRoot(), root, { recursive: true });
    const db = openDb(join(home, 'index.db'));
    syncIndex(db, { root, now: 1700000000000, only: ['dsh'] });
    rmSync(join(root, '--tmp-fixture-demo--', 'aaaaaaaa-1111-4111-8111-111111111111'), {
      recursive: true,
      force: true,
    });
    syncIndex(db, { root, now: 1700000000000, only: ['dsh'] });

    const purged = purgeArchived(db);
    assert.equal(purged.sessions, 1);
    assert.ok(purged.docs > 0 && purged.events > 0);

    // 未归档的那个会话必须完好
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 1);
    assert.equal(db.prepare('SELECT id FROM sessions').get().id, 'bbbbbbbb-2222-4222-8222-222222222222');
    const found = search(db, { query: 'settlement_id', scope: { mode: 'all' }, limit: 5 });
    assert.ok(found.total > 0, '未归档的会话必须仍可搜索');

    // 再清一次应当无事可做（幂等）
    assert.equal(purgeArchived(db).sessions, 0);
    db.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

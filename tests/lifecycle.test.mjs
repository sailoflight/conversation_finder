// tests/lifecycle.test.mjs — 索引的寿命：会到期、能回收、不自我触发
//
// 索引是**单向增长**的（归档内容 + FTS 墓碑 + 空闲页）。这里锁定四件事：
//   1. 归档带时间戳，所以"多久了"答得出来
//   2. --gc --max-age 只回收够老的，不是全清
//   3. optimize 与 VACUUM 的触发条件分开（否则 optimize 会让 freelist 上升，
//      进而再次触发 optimize —— 一个自我触发的循环，实测每次白跑 643ms）
//   4. VACUUM 真的把空间还给操作系统
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../lib/schema.mjs';
import { purgeArchived, stats, syncIndex } from '../lib/store.mjs';
import { buildFixture } from './fixtures/make-fixture.mjs';
import {
  FREE_RATIO_THRESHOLD,
  archivedAge,
  indexHealth,
  optimizeHint,
  optimizeIndex,
  vacuumIndex,
} from '../lib/lifecycle.mjs';

const DAY = 86_400_000;

/** 造一个带内容的库（用真实索引路径，不手搓 docs）。 */
function makeDb({ sessions = 3 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cfind-life-'));
  const db = openDb(join(home, 'index.db'));
  const root = join(home, 'sessions');
  buildFixture(root);
  syncIndex(db, { root, now: 1_700_000_000_000, only: ['dsh'] });
  // 造更多内容，让体积足够大到 VACUUM 有明显效果
  const ins = db.prepare(
    'INSERT INTO docs (body, sh, source, session_id, seq, kind, time, surface) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insTri = db.prepare('INSERT INTO docs_tri (rowid, body) VALUES (?, ?)');
  const last = db.prepare('SELECT last_insert_rowid() AS r');
  const ids = db.prepare('SELECT id FROM sessions LIMIT ?').all(sessions).map((row) => row.id);
  for (let i = 0; i < 300; i += 1) {
    const body = `填充内容 ${i} 关于缓存与幂等的讨论 settlement_id`.repeat(4);
    ins.run(body, '填充 充内 内容', 'dsh', ids[i % ids.length], 10_000 + i, 'user', 1_700_000_000_000 + i, 'current');
    insTri.run(last.get().r, body);
  }
  return { db, home };
}

const cleanup = (home, db) => {
  try {
    db.close();
  } catch {
    /* 已关 */
  }
  rmSync(home, { recursive: true, force: true });
};

test('生命周期：归档写入时间戳，"多久了"答得出来', () => {
  const { db, home } = makeDb();
  try {
    const now = 1_700_000_000_000;
    // 直接归档一个文件（模拟原文件被工具删掉）
    const row = db.prepare('SELECT path FROM files LIMIT 1').get();
    db.prepare('UPDATE files SET archived = 1, archived_at = ? WHERE path = ?').run(now - 3 * DAY, row.path);

    const aged = archivedAge(db, now);
    assert.equal(aged.count, 1);
    assert.equal(aged.oldestDays, 3, '应当能算出归档了 3 天');

    // v6 之前归档的没有时间戳：报 null，而不是假装是 0 天
    db.prepare('UPDATE files SET archived_at = NULL WHERE path = ?').run(row.path);
    assert.equal(archivedAge(db, now).oldestDays, null, '未知年龄要如实说不知道');
  } finally {
    cleanup(home, db);
  }
});

test('生命周期：sync 归档时自动带上时间戳', () => {
  const home = mkdtempSync(join(tmpdir(), 'cfind-life2-'));
  const db = openDb(join(home, 'index.db'));
  try {
    const root = join(home, 'sessions');
    buildFixture(root);
    syncIndex(db, { root, now: 1_700_000_000_000, only: ['dsh'] });
    const before = db.prepare('SELECT count(*) AS c FROM files WHERE archived = 1').get().c;

    // 下一轮扫描时这些文件已不在磁盘上 → 应被归档并记录时间
    syncIndex(db, { root: join(home, 'empty'), now: 1_700_000_500_000, only: ['dsh'] });
    const archived = db.prepare('SELECT archived_at FROM files WHERE archived = 1').all();
    assert.ok(archived.length > before, '消失的文件应被归档');
    for (const row of archived) {
      assert.equal(row.archived_at, 1_700_000_500_000, '归档时间必须写入');
    }
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('生命周期：--max-age 只回收够老的，不是全清', () => {
  const { db, home } = makeDb();
  try {
    const now = 1_700_000_000_000;
    const files = db.prepare('SELECT path FROM files LIMIT 2').all();
    // 一个 60 天前归档，一个 2 天前归档
    db.prepare('UPDATE files SET archived = 1, archived_at = ? WHERE path = ?').run(now - 60 * DAY, files[0].path);
    db.prepare('UPDATE files SET archived = 1, archived_at = ? WHERE path = ?').run(now - 2 * DAY, files[1].path);
    const total = db.prepare('SELECT count(*) AS c FROM files WHERE archived = 1').get().c;
    assert.equal(total, 2);

    // maxAge=30 → 只清 60 天前那个
    const purged = purgeArchived(db, { maxAge: 30, now });
    assert.equal(purged.sessions, 1, '只应回收超过 30 天的');
    assert.equal(db.prepare('SELECT count(*) AS c FROM files WHERE archived = 1').get().c, 1, '2 天前那个要留着');

    // 不带 maxAge → 全清
    const rest = purgeArchived(db, { now });
    assert.equal(rest.sessions, 1);
    assert.equal(db.prepare('SELECT count(*) AS c FROM files WHERE archived = 1').get().c, 0);
  } finally {
    cleanup(home, db);
  }
});

test('生命周期：optimize 按时间触发，不看空闲页（否则自我触发）', () => {
  const { db, home } = makeDb();
  try {
    const now = 1_700_000_000_000;
    // 从未整理 → 到期
    const first = indexHealth(db, now);
    assert.equal(first.optimizeDue, true);
    assert.equal(first.reason, '从未整理过');

    optimizeIndex(db, { now });
    // 刚整理完：即使空闲页变多，也不该再次判为到期 ——
    // optimize 本身就会把死段变成空闲页，用它当触发条件就是死循环。
    db.exec('CREATE TABLE waste(x BLOB)');
    const waste = db.prepare('INSERT INTO waste(x) VALUES(randomblob(1000000))');
    db.exec('BEGIN');
    for (let i = 0; i < 16; i += 1) waste.run(); // 16MB，超过绝对下限
    db.exec('COMMIT');
    db.exec('DROP TABLE waste');

    const after = indexHealth(db, now + DAY);
    assert.equal(after.optimizeDue, false, '刚整理过就不该再到期');
    assert.ok(after.freeRatio > FREE_RATIO_THRESHOLD, '空闲页确实变多了（用它触发 VACUUM，不是 optimize）');
    assert.equal(after.vacuumDue, true, '空闲页多应触发 VACUUM 判定');

    // 超过 7 天 → 再次到期
    assert.equal(indexHealth(db, now + 8 * DAY).optimizeDue, true);
  } finally {
    cleanup(home, db);
  }
});

test('生命周期：VACUUM 真的把空间还给操作系统', () => {
  const { db, home } = makeDb();
  try {
    db.exec('CREATE TABLE waste(x BLOB)');
    db.prepare('INSERT INTO waste(x) VALUES(randomblob(4000000))').run();
    db.exec('DROP TABLE waste');

    const before = db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size;
    const free = db.prepare('PRAGMA freelist_count').get().freelist_count;
    assert.ok(free > 0, '删表之后应当有空闲页');

    // optimize 只把死内容变回空闲页，文件不会变小
    optimizeIndex(db);
    const afterOptimize =
      db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size;
    assert.equal(afterOptimize, before, 'optimize 不改变文件大小（这是它的已知局限）');

    // VACUUM 才会真的缩小
    const vacuumed = vacuumIndex(db);
    assert.ok(vacuumed.bytesAfter < vacuumed.bytesBefore, `VACUUM 应缩小文件：${vacuumed.bytesBefore} → ${vacuumed.bytesAfter}`);
    assert.equal(db.prepare('PRAGMA freelist_count').get().freelist_count, 0, 'VACUUM 后不该剩空闲页');
  } finally {
    cleanup(home, db);
  }
});

test('生命周期：提示只在到期时出现（查询路径不制造噪音）', () => {
  const { db, home } = makeDb();
  try {
    const now = 1_700_000_000_000;
    optimizeIndex(db, { now });
    // 刚整理完、空闲页量很小 → 不该有任何提示。
    // 注意这里的小库天然就有 ~20% 空闲页（重建会话时删过表），
    // 所以阈值必须带绝对下限，否则每次查询都会念一句"可回收 0.1MB"。
    assert.equal(optimizeHint(db, now + 1000), null, '健康时不提示（小量空闲页不算堆积）');

    // 空闲页真的多了 → 提示指向 --gc
    db.exec('CREATE TABLE waste(x BLOB)');
    const waste = db.prepare('INSERT INTO waste(x) VALUES(randomblob(1000000))');
    db.exec('BEGIN');
    for (let i = 0; i < 16; i += 1) waste.run();
    db.exec('COMMIT');
    db.exec('DROP TABLE waste');
    const hint = optimizeHint(db, now + 1000);
    assert.match(hint, /index --gc/, '空闲页多时提示应指向 --gc');

    // 归档统计要能被 stats 用上
    const row = db.prepare('SELECT path FROM files LIMIT 1').get();
    db.prepare('UPDATE files SET archived = 1, archived_at = ? WHERE path = ?').run(now - 5 * DAY, row.path);
    assert.equal(stats(db).archived, 1);
    assert.equal(archivedAge(db, now).oldestDays, 5);
  } finally {
    cleanup(home, db);
  }
});

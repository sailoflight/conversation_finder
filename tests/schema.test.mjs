// tests/schema.test.mjs — 索引库自愈：版本不符 / 实际列缺失 都必须能自动重建
//
// 为什么要专门测：派生索引一旦出现「版本号说正常、实际少一列」，就会在 INSERT 时
// 才炸，且报错点离根因很远。这里把两种失效都钉成回归测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, SCHEMA_VERSION } from '../lib/schema.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'cfind-schema-'));
}

test('schema: 全新库建出 v2，且 sessions/docs 都带 source 列', () => {
  const dir = tempDir();
  try {
    const db = openDb(join(dir, 'index.db'));
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
    assert.equal(Number(version), SCHEMA_VERSION);
    const sessionCols = db.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name);
    const docCols = db.prepare('PRAGMA table_info(docs)').all().map((row) => row.name);
    assert.ok(sessionCols.includes('source'));
    assert.ok(docCols.includes('source'));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schema: 实际列缺失时自愈重建（即使版本号相同）', () => {
  const dir = tempDir();
  const path = join(dir, 'index.db');
  try {
    // 人为造一个「版本号是当前版本、但 docs 少了 source 列」的坏库。
    const broken = new DatabaseSync(path);
    broken.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) STRICT");
    broken.prepare('INSERT INTO meta VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    broken.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY) STRICT');
    broken.exec("CREATE VIRTUAL TABLE docs USING fts5(body, sh, session_id UNINDEXED, tokenize='unicode61')");
    broken.close();

    const db = openDb(path);
    const docCols = db.prepare('PRAGMA table_info(docs)').all().map((row) => row.name);
    assert.ok(docCols.includes('source'), '重建后应带上 source 列');
    const reason = db.prepare("SELECT value FROM meta WHERE key = 'rebuilt_reason'").get()?.value;
    assert.match(String(reason), /docs\.source/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schema: 旧版本库自动重建并记录原因', () => {
  const dir = tempDir();
  const path = join(dir, 'index.db');
  try {
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) STRICT");
    old.exec("INSERT INTO meta VALUES ('schema_version', '1')");
    old.close();

    const db = openDb(path);
    assert.equal(Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value), SCHEMA_VERSION);
    assert.match(String(db.prepare("SELECT value FROM meta WHERE key = 'rebuilt_reason'").get().value), /version 1/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

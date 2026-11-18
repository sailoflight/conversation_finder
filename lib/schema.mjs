// lib/schema.mjs — 索引库的唯一权威定义（所有模块都按这套表结构写 SQL）
//
// 设计要点：
//   · docs 是 FTS5 表；body 原样、sh 存 CJK bigram 串（见 lib/cjk.mjs）。
//   · 自建表用 STRICT，避免类型漂移；FTS5 虚拟表不能 STRICT。
//   · 想改表结构必须同时升 SCHEMA_VERSION，openDb 会拒绝版本不匹配的旧库。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 3;

/**
 * 会话来源。跨 agent 是设计目标之一，所以从 v2 起每一行都带来源，
 * 后续接 Claude Code / Codex / OpenCode 只需新增取值，不用再迁库。
 */
export const SOURCES = ['dsh'];

export const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL DEFAULT 'dsh',
  cwd          TEXT,
  title        TEXT,
  created_at   INTEGER,
  agent_preset TEXT,
  parent_id    TEXT,
  event_count  INTEGER,
  first_time   INTEGER,
  last_time    INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS files (
  path         TEXT PRIMARY KEY,
  session_id   TEXT,
  size         INTEGER,
  mtime        INTEGER,
  frame_offset INTEGER,
  event_count  INTEGER,
  indexed_at   INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  type       TEXT,
  time       INTEGER,
  surface    TEXT,
  PRIMARY KEY (session_id, seq)
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
  body,
  sh,
  source     UNINDEXED,
  session_id UNINDEXED,
  seq        UNINDEXED,
  kind       UNINDEXED,
  time       UNINDEXED,
  surface    UNINDEXED,
  tokenize = 'unicode61'
);

-- 词表视图：fts5vocab 直接读 FTS5 索引的 term 表，**不占额外存储**。
-- 模糊搜索靠它做拼写纠错（找编辑距离最近的词），所以它必须和 docs 一起建。
CREATE VIRTUAL TABLE IF NOT EXISTS docs_vocab USING fts5vocab(docs, 'col');

CREATE INDEX IF NOT EXISTS events_session_seq ON events (session_id, seq);
CREATE INDEX IF NOT EXISTS events_type ON events (type);
CREATE INDEX IF NOT EXISTS sessions_cwd ON sessions (cwd);
`;

/** 文档种类权重（与 lib/extract.mjs 的 KIND_WEIGHTS 保持一致）。 */
export { KIND_WEIGHTS } from './extract.mjs';

/**
 * 已存库的状态判定（在建表之前跑，避免对坏库执行 DDL 时报「no such column」这种
 * 离根因很远的错）。
 * @returns {{kind: 'fresh'|'ok'|'stale', stale?: number, missing?: string[]}}
 */
function inspect(db) {
  const hasMeta = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  if (hasMeta === undefined) return { kind: 'fresh' };
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (row === undefined) return { kind: 'fresh' };
  const stale = Number(row.value);
  if (stale !== SCHEMA_VERSION) return { kind: 'stale', stale };
  const missing = missingColumns(db);
  if (missing.length > 0) return { kind: 'stale', stale, missing };
  // 表列齐全但缺派生的词表视图（v3 新增）：同样重建，否则模糊搜索会静默不可用。
  const hasVocab = db
    .prepare("SELECT name FROM sqlite_master WHERE name = 'docs_vocab'")
    .get();
  if (hasVocab === undefined) return { kind: 'stale', stale, missing: ['docs_vocab(missing view)'] };
  return { kind: 'ok' };
}

/**
 * 校验实际表结构与版本号声明的形状一致。
 * 为什么需要：`schema_version` 只是个数字，开发期出现过「版本已是 v2 但 DDL 少了一列」
 * 的情况——数字匹配就不会触发重建，然后在 INSERT 时炸。派生索引可丢，所以宁可
 * 自检后重建，也不要留一个「看起来正常、一写就错」的库。
 * @returns {string[]} 缺失的列（空数组表示结构正确）
 */
function missingColumns(db) {
  const expected = { sessions: ['source'], docs: ['source'] };
  const missing = [];
  for (const [table, columns] of Object.entries(expected)) {
    let present;
    try {
      present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    } catch {
      return [`${table}(missing table)`];
    }
    for (const column of columns) if (!present.has(column)) missing.push(`${table}.${column}`);
  }
  return missing;
}

/** 删库并重建（派生数据，可丢）。 */
function recreate(path) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${path}${suffix}`, { force: true });
    } catch {
      /* 删不掉就让后续 open 报错，别吞掉真正的问题 */
    }
  }
  const fresh = new DatabaseSync(path);
  fresh.exec('PRAGMA journal_mode = WAL');
  fresh.exec('PRAGMA synchronous = NORMAL');
  fresh.exec(DDL);
  fresh.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  return fresh;
}

/**
 * 打开（并按需初始化）索引库。
 *
 * 顺序很重要：先**判定**已有库的状态，再决定是建表还是重建。反过来会踩坑——
 * 对一个缺列的旧库直接跑 DDL 会先在 `CREATE INDEX ... (cwd)` 上炸掉。
 * @param {string} path 数据库路径
 * @param {{readonly?: boolean}} [options]
 */
export function openDb(path, { readonly = false } = {}) {
  if (!readonly) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, readonly ? { readOnly: true } : {});
  if (readonly) return db;

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');

  const state = inspect(db);
  if (state.kind === 'ok') {
    db.exec(DDL); // 幂等：补上可能新增的索引
    return db;
  }

  if (state.kind === 'fresh') {
    db.exec(DDL);
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    return db;
  }

  // 派生索引可丢：版本不符或实际列缺失时直接重建（实测 <1s / 5MB 语料），
  // 比要求用户手动删库更合适，也避免留下「数字正常、写就报错」的库。
  const reason =
    state.missing !== undefined ? `missing columns: ${state.missing.join(',')}` : `version ${state.stale} -> ${SCHEMA_VERSION}`;
  db.close();
  const fresh = recreate(path);
  fresh.prepare("INSERT INTO meta (key, value) VALUES ('rebuilt_reason', ?)").run(reason);
  return fresh;
}

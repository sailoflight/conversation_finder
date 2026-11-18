#!/usr/bin/env node
// DSH 会话检索器 — 预研验证脚本（不是最终实现）
//
// 目的：把「能不能做」变成「实测数字」。跑一遍即可复现 docs/prestudy.md 里的全部结论。
//
//   node proto/probe.mjs                 # 对 $DSH_HOME/sessions 建索引并跑样例查询
//   node proto/probe.mjs --db /tmp/x.db  # 指定索引库位置
//
// 关键结论（本脚本即证据）：
//   1. 会话文件是 zstd 多帧拼接，必须逐帧解码；整文件一次解压会静默只返回第一帧。
//   2. 官方 FTS5 分词器 unicode61 对中文失效；CJK bigram 列可以把 2/3/4 字查询全部救回来。
//   3. 全量建档 ~0.4s、查询 ~1ms 级，说明「查询前顺手增量索引」成立。
import { readFileSync, readdirSync, existsSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'node:path';

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const HOME = process.env.DSH_HOME ?? join(process.env.HOME ?? '/', '.dsh');
const ROOT = join(HOME, 'sessions');
const DB = argOf('--db', join(HOME, 'cache', 'cfind', 'probe.db'));

if (!existsSync(ROOT)) {
  console.error(`no sessions dir: ${ROOT}`);
  process.exit(3);
}

// ── 1. 解码：zstd 多帧，逐帧解 + 失败合并 ────────────────────────────────
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 必须是逐帧解码：zstdDecompressSync(整文件) 只返回第一帧且不报错。 */
function decodeFile(raw) {
  const cuts = [];
  for (let i = raw.indexOf(MAGIC); i >= 0; i = raw.indexOf(MAGIC, i + 4)) cuts.push(i);
  if (cuts.length === 0) return '';
  const bounds = [...cuts, raw.length];
  let out = '';
  let k = 0;
  while (k < bounds.length - 1) {
    let j = k + 1;
    let decoded = null;
    // magic 可能误命中压缩数据内部；失败就并入下一段重试。
    while (j < bounds.length) {
      try {
        decoded = zstdDecompressSync(raw.subarray(bounds[k], bounds[j]));
        break;
      } catch {
        j += 1;
      }
    }
    if (decoded === null) break; // 末帧可能正在写入，跳过
    out += decoded.toString('utf8');
    k = j;
  }
  return out;
}

// ── 2. 提取：官方口径的超集 ──────────────────────────────────────────────
// 官方 extractSessionEventText 丢弃 reasoning，且没有 compaction/summary 分支。
// 本项目两者都要：reasoning 是 65.9% 的内容，compaction/summary 是「记忆」本体。
const contentText = (blocks) =>
  (blocks ?? [])
    .flatMap((b) => (b.type === 'text' ? [b.text] : b.type === 'tool-call' ? [b.name, b.arguments ?? ''] : []))
    .join('\n');

function docsOf(ev) {
  switch (ev.type) {
    case 'user/message':
      return [['user', contentText(ev.data.content)]];
    case 'assistant/message': {
      const blocks = ev.data.message?.content ?? [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const reasoning = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text).join('\n');
      return [...(text ? [['assistant', text]] : []), ...(reasoning ? [['reasoning', reasoning]] : [])];
    }
    case 'tool/call':
      return [['tool-call', [ev.data.name, ev.data.arguments].filter(Boolean).join('\n')]];
    case 'tool/result':
      return [['tool-result', contentText(ev.data.message?.content)]];
    case 'compaction/summary': {
      const body = Array.isArray(ev.data.summary) ? contentText(ev.data.summary) : String(ev.data.summary ?? '');
      return [['compaction', body]];
    }
    case 'session/title':
      return [['title', ev.data.title ?? '']];
    default:
      return []; // request/header、system/message、replayState 一律不入索引
  }
}

// ── 3. 中文分词：CJK bigram 列 ───────────────────────────────────────────
// unicode61 会把整段中文当一个 token；trigram 又救不了 2 字查询。
// 写入侧切 bigram、查询侧转 bigram 短语，三段全中（见 prestudy.md §5.3）。
const CJK = /[\u4e00-\u9fff]/;

function bigrams(s) {
  const out = [];
  for (let i = 0; i < s.length - 1; i += 1) {
    if (CJK.test(s[i]) && CJK.test(s[i + 1])) out.push(s[i] + s[i + 1]);
  }
  return out.join(' ');
}

function buildQuery(q) {
  const parts = [];
  const re = /[\u4e00-\u9fff]+|[A-Za-z0-9_.\-/@:]+/g;
  for (const m of q.matchAll(re)) {
    const tok = m[0];
    if (CJK.test(tok)) {
      if (tok.length === 1) return { like: tok }; // 单字：FTS 无解，走 LIKE
      const bg = [];
      for (let i = 0; i < tok.length - 1; i += 1) bg.push(tok.slice(i, i + 2));
      parts.push(`"${bg.join(' ')}"`);
    } else {
      parts.push(tok.toLowerCase());
    }
  }
  return { match: parts.join(' AND ') };
}

/** surface 分类：surfaceOp 只有 "append" 或 {op:'replace', startSeq, endSeq}。 */
function shadowedSeqs(events) {
  const shadowed = new Set();
  for (const ev of events) {
    const op = ev.surfaceOp;
    if (op && typeof op === 'object' && op.op === 'replace' && Number.isInteger(op.startSeq)) {
      for (let s = op.startSeq; s <= (op.endSeq ?? op.startSeq); s += 1) shadowed.add(s);
    }
  }
  return shadowed;
}

// ── 4. 建库 ─────────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.zstd')) out.push(p);
  }
  return out;
}

mkdirSync(dirname(DB), { recursive: true });
if (existsSync(DB)) rmSync(DB, { force: true });
const db = new DatabaseSync(DB);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, cwd TEXT, title TEXT, created_at INTEGER, event_count INTEGER)`);
db.exec(`CREATE TABLE events(session_id TEXT, seq INTEGER, type TEXT, time INTEGER, surface TEXT, PRIMARY KEY(session_id, seq))`);
db.exec(`CREATE VIRTUAL TABLE docs USING fts5(
  body, sh,
  session_id UNINDEXED, seq UNINDEXED, kind UNINDEXED, time UNINDEXED, surface UNINDEXED,
  tokenize = 'unicode61')`);

const files = walk(ROOT);
const insSession = db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?,?,?,?)');
const insEvent = db.prepare('INSERT OR REPLACE INTO events VALUES(?,?,?,?,?)');
const insDoc = db.prepare('INSERT INTO docs(body,sh,session_id,seq,kind,time,surface) VALUES(?,?,?,?,?,?,?)');

const t0 = performance.now();
let docCount = 0;
let eventCount = 0;
db.exec('BEGIN');
for (const file of files) {
  const text = decodeFile(readFileSync(file));
  const events = [];
  let header = null;
  let title = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // 末帧损坏：跳过
    }
    if (ev.type === 'session') header = ev;
    if (ev.type === 'session/title') title = ev.data.title;
    events.push(ev);
  }
  const sid = String(header?.id ?? file.split('/').at(-2));
  const cwd = header?.cwd ?? null;
  const shadowed = shadowedSeqs(events);

  for (const ev of events) {
    if (!Number.isInteger(ev.seq)) continue;
    eventCount += 1;
    const surface = shadowed.has(ev.seq) ? 'shadowed' : 'current';
    insEvent.run(sid, ev.seq, ev.type, ev.time ?? 0, surface);
    for (const [kind, body] of docsOf(ev)) {
      const t = (body ?? '').trim();
      if (t.length < 2) continue;
      insDoc.run(t, bigrams(t), sid, ev.seq, kind, ev.time ?? 0, surface);
      docCount += 1;
    }
  }
  insSession.run(sid, cwd, title, header?.createdAt ?? 0, events.length);
}
db.exec('COMMIT');
db.exec('ANALYZE');
const buildMs = performance.now() - t0;

const compressed = files.reduce((a, f) => a + statSync(f).size, 0);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const pageCount = db.prepare('PRAGMA page_count').get().page_count;
const pageSize = db.prepare('PRAGMA page_size').get().page_size;

console.log(`corpus: ${files.length} sessions, ${(compressed / 1e6).toFixed(2)}MB compressed`);
console.log(`index : ${docCount} docs / ${eventCount} events in ${buildMs.toFixed(0)}ms, ${(pageCount * pageSize / 1e6).toFixed(2)}MB`);

// ── 5. 样例查询 ─────────────────────────────────────────────────────────
const SQL = `SELECT docs.session_id, docs.seq, docs.kind, docs.surface,
                    snippet(docs, 0, '[', ']', '…', 14) AS snip,
                    bm25(docs) AS score, s.title
             FROM docs JOIN sessions s ON s.id = docs.session_id
             WHERE docs MATCH ? ORDER BY score LIMIT ?`;

for (const q of ['幂等', '压缩之后', 'credentials', 'privacy', '订阅']) {
  const bq = buildQuery(q);
  if (bq.like) {
    const rows = db.prepare(`SELECT session_id, seq, kind, substr(body,1,80) AS snip FROM docs WHERE body LIKE ? LIMIT 3`).all(`%${bq.like}%`);
    console.log(`\nq ${JSON.stringify(q)}  (single CJK char → LIKE)  hits=${rows.length}`);
    continue;
  }
  const started = performance.now();
  const rows = db.prepare(SQL).all(bq.match, 3);
  console.log(`\nq ${JSON.stringify(q)}  ${(performance.now() - started).toFixed(2)}ms  hits=${rows.length}`);
  for (const r of rows) {
    console.log(`   [${r.kind}/${r.surface}] ${r.session_id.slice(0, 8)} #${r.seq} ${(r.title ?? '').slice(0, 14)} :: ${r.snip.replace(/\s+/g, ' ').slice(0, 100)}`);
  }
}

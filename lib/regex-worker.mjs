// lib/regex-worker.mjs — 正则扫描的隔离子进程
//
// 这个文件只做一件事：打开索引、跑 lib/regex-core.mjs 的扫描、把结果写到临时文件。
// 任何可能卡死的计算都在这里，所以主线程可以放心 terminate 它。
import { workerData } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runScan } from './regex-core.mjs';

const { dbPath, sql, params, pattern, limit, outPath, flag } = workerData;

let payload;
try {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  // busy_timeout 与主连接一致：索引可能正被另一个进程追加。
  db.exec('PRAGMA busy_timeout = 5000');
  const result = runScan(db, { sql, params, pattern, limit, cache: new Map() });
  db.close();
  payload = { ok: true, total: result.total, rows: result.rows };
} catch (error) {
  payload = { error: error?.message || String(error) };
}

// 顺序很重要：**先写文件、后通知**。反过来主线程可能读到尚未写完的文件。
writeFileSync(outPath, JSON.stringify(payload), 'utf8');
// flag 是从主线程传进来的 Int32Array（结构化克隆会保留 SharedArrayBuffer 的共享语义）。
// 必须由 worker 自己写标志位：主线程此刻正卡在 Atomics.wait 里，
// 事件循环是停的，'message' 回调根本没有机会执行。
Atomics.store(flag, 0, 1);
Atomics.notify(flag, 0);

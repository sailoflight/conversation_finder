// lib/regex.mjs — 表达式检索（grep 同款）的隔离执行
//
// 为什么需要**隔离**而不是直接 `db.prepare('... body REGEXP ?').all()`：
//
//   grep 用 DFA，正则匹配是线性的，所以 `(a+)+$` 这种模式也伤不到它。
//   JS 的 RegExp 是回溯引擎，同一个模式在 30 个 a 上要跑 19 秒。
//   而我们的语料里有 64,000 字符的事件 —— 一个手滑写出的模式足以把
//   agent 的工具调用永久挂住（没有输出、没有超时、只能杀进程）。
//
// 所以正则只在 worker 里跑，主线程用 Atomics.wait 限时等：
// 超时就 terminate 掉 worker 并报错。宁可回一句「这个模式太慢」，
// 也不能让调用方无限期卡死。
//
// 代价只有正则这条路要付（FTS 主路径完全不受影响），worker 启动实测约 30ms。
import { Worker } from 'node:worker_threads';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compilePattern, runScan } from './regex-core.mjs';

/** 正则扫描的墙上时间上限。超过就认定模式病态，而不是继续等。 */
export const REGEX_TIMEOUT_MS = 5000;

/** 带 `userFacing` 的错误：CLI/MCP 只打印 message，不打印堆栈。 */
function userError(message) {
  const error = new Error(message);
  error.userFacing = true;
  return error;
}

/**
 * 执行一次正则扫描。
 *
 * @param {object} opts
 * @param {object} opts.db      调用方手上的连接（没有 dbPath 时用它原地跑）
 * @param {string|null} opts.dbPath  索引文件路径；`:memory:` 时为 null
 * @param {string} opts.sql     已拼好过滤条件的 SQL，**模式占位符必须是最后一个 `?`**
 * @param {unknown[]} opts.params SQL 里除模式外的参数
 * @param {string} opts.pattern 正则源码（字符串形式，在 worker 里编译）
 * @param {number} opts.limit   需要计算 snippet 的条数
 * @param {number} [opts.timeoutMs]
 * @returns {{total: number, rows: object[]}}
 */
export function regexScan({ db, dbPath, sql, params, pattern, limit, timeoutMs = REGEX_TIMEOUT_MS }) {
  // 先在主进程编译一次：语法错了要立刻报给用户，而不是等 worker 超时。
  compilePattern(pattern);

  // 内存库没有可共享的路径，worker 读不到 —— 就地执行。
  // 只有测试用内存库，模式可控；真实 CLI/MCP 永远是文件库，永远走隔离路径。
  if (!dbPath) return runScan(db, { sql, params, pattern, limit, cache: new Map() });

  const dir = mkdtempSync(join(tmpdir(), 'cfind-re-'));
  const outPath = join(dir, 'out.json');
  const flag = new Int32Array(new SharedArrayBuffer(4));

  // 直接传 Int32Array：结构化克隆会保留 SharedArrayBuffer 的共享语义，
  // worker 里的 Atomics.store 才真正能被主线程的 Atomics.wait 看到。
  // （传裸的 SharedArrayBuffer 会静默失效 —— Atomics 需要的是视图。）
  let payload = null;
  const worker = new Worker(new URL('./regex-worker.mjs', import.meta.url), {
    workerData: { dbPath, sql, params, pattern, limit, outPath, flag },
  });

  // 注意：主线程此刻会阻塞在 Atomics.wait 上，事件循环是停的，
  // 所以这里的 message/error 回调**不可依赖**。真正的同步靠 worker 自己写 flag。
  // 保留监听只是为了在 worker 崩溃时拿到错误信息（超时路径下会读到 payload=null）。
  worker.on('message', (value) => {
    payload = value;
  });
  worker.on('error', (error) => {
    payload = { error: error?.message ?? String(error) };
  });

  try {
    const waited = Atomics.wait(flag, 0, 0, timeoutMs);
    if (waited === 'timed-out') {
      // 必须 terminate：卡在回溯里的 worker 不会响应消息，只能直接杀。
      void worker.terminate();
      throw userError(
        `正则超过 ${timeoutMs}ms 仍未完成，已中止。可能是灾难性回溯（如 (a+)+$）；请简化模式或改用关键词搜索。`,
      );
    }
    if (payload?.error) throw userError(`正则执行失败：${payload.error}`);
    // worker 是「先写结果文件、后通知」，所以这里文件一定已就绪。
    if (!existsSync(outPath)) throw userError('正则执行失败：没有拿到结果');
    return JSON.parse(readFileSync(outPath, 'utf8'));
  } finally {
    void worker.terminate();
    rmSync(dir, { recursive: true, force: true });
  }
}

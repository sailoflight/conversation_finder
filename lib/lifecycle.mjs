// lib/lifecycle.mjs — 索引的寿命管理
//
// 索引会随时间**单向增长**，原因有四个，每一个都要有对应机制：
//
//   ① 归档内容（原文件被工具删掉，我们留着）—— 只增不减，除非显式回收
//   ② FTS5 删除留下的墓碑段 —— 删了行，但倒排索引里的死内容还在
//   ③ 空闲页 —— SQLite 复用页，文件不会自己变小
//   ④ 新会话（合法的增长，不需要处理）
//
// 实测（7.8MB 文本 / 45MB 库，模拟 5 轮删除+重建）：
//
//   文件大小     47.2 → 48.3MB          基本不变（页被复用，但死内容留在 FTS 段里）
//   空闲页        1.1 →  5.7MB          慢慢攒起来
//   optimize 后   空闲页 5.7 → 11.6MB   死段被整理成可回收页（645ms）
//   VACUUM 后     47.2 → 36.5MB         真正还给操作系统（354ms，-23%）
//
// 所以有两级维护，代价差别很大，不能混为一谈：
//
//   optimize  合并 FTS 段，把死内容变回空闲页。只写索引，快。
//   VACUUM    重建整个文件。要临时空间，慢，但只有它能缩小文件。
//
// 策略：
//   · 查询路径**绝不**做维护 —— 用户敲一条 grep 不该等几百毫秒的 optimize。
//     只读一个 PRAGMA，超过阈值就在 stderr 提示一句（不阻塞、不改行为）。
//   · `cfind index` 到期就 optimize（那是维护命令，本来就该花时间）。
//   · `cfind index --gc` 才做 VACUUM + 归档回收，因为要额外磁盘和时间。

/** 空闲页占比超过这个值就认为索引在堆积。 */
export const FREE_RATIO_THRESHOLD = 0.08;

/**
 * 但占比必须配一个**绝对下限**，否则小库会天天报「可回收 0.1MB」。
 *
 * 实测：刚建好的 5MB 库因为重建会话时的删除，天然就有 ~20% 空闲页 ——
 * 占比很高但绝对量毫无意义，VACUUM 它只会白花时间。
 * 所以两个条件同时满足才算值得回收。
 */
export const FREE_BYTES_FLOOR = 8 * 1024 * 1024;

/** 距离上次 optimize 超过这么久就再做一次。 */
export const OPTIMIZE_INTERVAL_MS = 7 * 86_400_000;

const META_OPTIMIZED = 'optimized_at';
const META_VACUUMED = 'vacuumed_at';

const pageBytes = (db) => {
  const count = Number(db.prepare('PRAGMA page_count').get()?.page_count ?? 0);
  const size = Number(db.prepare('PRAGMA page_size').get()?.page_size ?? 0);
  return count * size;
};

const freeBytes = (db) => {
  const free = Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count ?? 0);
  const size = Number(db.prepare('PRAGMA page_size').get()?.page_size ?? 0);
  return free * size;
};

function metaGet(db, key) {
  try {
    return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  } catch {
    return null;
  }
}

function metaSet(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}

/** FTS5 的 optimize：合并所有段，把墓碑里的内容真正释放成空闲页。 */
export function optimizeIndex(db, { now = Date.now() } = {}) {
  const started = performance.now();
  const before = pageBytes(db);
  for (const table of ['docs', 'docs_tri']) {
    try {
      db.exec(`INSERT INTO ${table}(${table}) VALUES('optimize')`);
    } catch {
      // 表不存在（老库/内存库）就跳过，不该因此让维护失败。
    }
  }
  metaSet(db, META_OPTIMIZED, now);
  return { ms: Math.round(performance.now() - started), bytesBefore: before, bytesAfter: pageBytes(db) };
}

/**
 * VACUUM：把空闲页还给操作系统。
 *
 * 唯一能真正缩小文件的动作，但需要临时空间（约等于库大小）且会锁库，
 * 所以只由 `index --gc` 触发，绝不自动跑。
 */
export function vacuumIndex(db, { now = Date.now() } = {}) {
  const started = performance.now();
  const before = pageBytes(db);
  db.exec('VACUUM');
  metaSet(db, META_VACUUMED, now);
  return { ms: Math.round(performance.now() - started), bytesBefore: before, bytesAfter: pageBytes(db) };
}

/**
 * 索引健康度（只读 PRAGMA + meta，很便宜，可以每查询调用）。
 */
export function indexHealth(db, now = Date.now()) {
  const bytes = pageBytes(db);
  const free = freeBytes(db);
  const ratio = bytes === 0 ? 0 : free / bytes;
  const lastOptimizedAt = Number(metaGet(db, META_OPTIMIZED) ?? 0) || null;

  // optimize 与 VACUUM 的触发条件**必须分开**，理由来自实测：
  // optimize 会把 FTS 死段整理成空闲页，于是 freelist 占比**上升**。
  // 若拿 freelist 当 optimize 的触发条件，就会每次运行都 optimize 一遍（实测 643ms），
  // 而且永远不达标 —— 一个自我触发的循环。
  //
  //   · optimize 按**时间**：合并上次至今新攒的段。
  //   · VACUUM   按**空闲页占比**：那才是"能还给操作系统多少"的信号，且只能手动。
  let optimizeReason = null;
  if (lastOptimizedAt === null) {
    optimizeReason = '从未整理过';
  } else if (now - lastOptimizedAt > OPTIMIZE_INTERVAL_MS) {
    optimizeReason = `上次整理在 ${Math.floor((now - lastOptimizedAt) / 86_400_000)} 天前`;
  }

  // 占比 + 绝对量：两个都满足才值得 VACUUM（小库的空闲页没有回收价值）。
  const vacuumDue = bytes > 0 && ratio >= FREE_RATIO_THRESHOLD && free >= FREE_BYTES_FLOOR;

  return {
    bytes,
    freeBytes: free,
    freeRatio: ratio,
    lastOptimizedAt,
    optimizeDue: optimizeReason !== null,
    reason: optimizeReason,
    vacuumDue,
  };
}

/** 给 stderr 用的提示行；不到期时返回 null。 */
export function optimizeHint(db, now = Date.now()) {
  const health = indexHealth(db, now);
  // 空闲页多 -> 需要 VACUUM（只有 --gc 会做），这个提示最有用。
  if (health.vacuumDue) {
    return `索引空闲页 ${(health.freeBytes / 1e6).toFixed(1)}MB（${(health.freeRatio * 100).toFixed(0)}%），cfind index --gc 可回收`;
  }
  if (health.optimizeDue) {
    return `索引${health.reason}，cfind index 可整理（不影响检索结果）`;
  }
  return null;
}

/**
 * 归档内容的老化统计：给「寿命」一个可观察的量。
 *
 * 不自动删除 —— 工具删掉的旧会话恰恰是"想不起某件事"时要找的东西。
 * 但必须能看到它在攒多少、攒多久，否则就只能靠感觉。
 */
export function archivedAge(db, now = Date.now()) {
  let rows;
  try {
    rows = db.prepare('SELECT archived_at FROM files WHERE archived = 1').all();
  } catch {
    return { count: 0, oldestDays: null };
  }
  if (rows.length === 0) return { count: 0, oldestDays: null };
  let oldest = null;
  for (const row of rows) {
    if (row.archived_at === null) {
      return { count: rows.length, oldestDays: null }; // 有未知年龄的（v6 之前归档）
    }
    const days = Math.floor((now - Number(row.archived_at)) / 86_400_000);
    if (oldest === null || days > oldest) oldest = days;
  }
  return { count: rows.length, oldestDays: oldest };
}

// ── 段级别的观察（诊断用，需要 dbstat 编译支持）─────────────────────

/** SQLite 是否带 dbstat 虚拟表（部分构建没有）。 */
export function hasDbstat(db) {
  try {
    db.prepare('SELECT 1 FROM dbstat LIMIT 1').get();
    return true;
  } catch {
    return false;
  }
}

/** 各表/索引占用，按大小降序。没有 dbstat 时返回空数组。 */
export function tableSizes(db, limit = 8) {
  if (!hasDbstat(db)) return [];
  try {
    return db
      .prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT ?')
      .all(limit)
      .map((row) => ({ name: row.name ?? '(匿名)', bytes: Number(row.bytes ?? 0) }));
  } catch {
    return [];
  }
}

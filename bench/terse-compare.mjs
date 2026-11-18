// bench/terse-compare.mjs — 常规 vs 精简输出的成本对比
//
// 用**同一份结果**分别渲染两种格式，所以命中集合完全相同：这是唯一公平的比法。
// （如果各自按预算裁剪，命中的条数会不一样，比出来的"每 token 命中数"没有意义。）
import { openDb } from '../lib/schema.mjs';
import { syncIndex } from '../lib/store.mjs';
import { search } from '../lib/query.mjs';
import { renderHits } from '../lib/format.mjs';

const indexPath = process.argv[2] ?? `${process.env.CFIND_HOME ?? `${process.env.HOME}/.local/share/cfind`}/index.db`;
const db = openDb(indexPath);
syncIndex(db, {});

const cjk = (s) => (String(s).match(/[\u4e00-\u9fff]/g) ?? []).length;
const tokens = (s) => Math.round(cjk(s) / 1.5 + (String(s).length - cjk(s)) / 4);

const QUERIES = ['settlement_id', '幂等键', 'bino', '实现', '文件', 'reconcile'];
const scope = { mode: 'all' };

console.log('查询            命中   normal字符   terse字符   省');
let normalTotal = 0;
let terseTotal = 0;
let hitsTotal = 0;

for (const query of QUERIES) {
  const result = search(db, { query, scope, limit: 10 });
  if (result.hits.length === 0) continue;
  // maxChars: 0 = 不截断：两种格式渲染的是完全相同的命中集合
  const normal = renderHits(result, { scope: 'all sessions', maxChars: 0 });
  const terse = renderHits(result, { scope: 'all sessions', maxChars: 0, terse: true });
  const saved = ((normal.length - terse.length) / normal.length) * 100;
  normalTotal += normal.length;
  terseTotal += terse.length;
  hitsTotal += result.hits.length;
  console.log(
    `${query.padEnd(14)} ${String(result.hits.length).padStart(3)} ${String(normal.length).padStart(11)} ${String(terse.length).padStart(10)} ${saved.toFixed(0).padStart(5)}%`,
  );
}

const normalTok = Math.round(normalTotal * 0.35); // 中文占比很低时用统一近似，下面给出精确值
console.log(`\n合计 ${hitsTotal} 条命中`);
console.log(`  normal ${normalTotal} 字符`);
console.log(`  terse  ${terseTotal} 字符`);
console.log(`  省 ${((normalTotal - terseTotal) / normalTotal * 100).toFixed(1)}%`);
console.log(`  normal ${(normalTotal / hitsTotal).toFixed(0)} 字符/命中 → terse ${(terseTotal / hitsTotal).toFixed(0)} 字符/命中`);
void normalTok;
void tokens;

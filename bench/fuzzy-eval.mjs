// bench/fuzzy-eval.mjs — 模糊搜索的质量评测
//
// 为什么必须「运行时生成」测试串：cfind 检索的是会话历史，而**我们自己敲的命令也会被索引**
// （工具调用进语料）。任何字面写死的测试串下一刻就可能真的存在于语料里，导致误报测试永远为 0。
// 所以同步在生成之前完成，测试串只存在于内存。
//
// 用法：CFIND_HOME=… node bench/fuzzy-eval.mjs
import { openDb } from '../lib/schema.mjs';
import { syncIndex } from '../lib/store.mjs';
import { search } from '../lib/query.mjs';

const indexPath = process.argv[2] ?? `${process.env.CFIND_HOME ?? `${process.env.HOME}/.local/share/cfind`}/index.db`;
const db = openDb(indexPath);
syncIndex(db, {});                       // 先同步：之后的随机串必然不在语料里

const scope = { mode: 'all' };
const hits = (q, fuzzy) => search(db, { query: q, scope, limit: 20, fuzzy });
const cnt = (q, fuzzy) => hits(q, fuzzy).total;

const words = db
  .prepare("SELECT DISTINCT term FROM docs_vocab WHERE col = 'body'")
  .all()
  .map((row) => String(row.term))
  .filter((term) => /^[a-z]{8,13}$/.test(term));

if (words.length < 50) {
  console.error(`词表太小（${words.length} 个 8–13 字母词），无法评测`);
  process.exit(1);
}

// 确定性采样：保证同一语料可复现（不用 Math.random 抽样）
const step = Math.max(1, Math.floor(words.length / 60));
const sample = words.filter((_, index) => index % step === 0).slice(0, 60);

const MUTATIONS = {
  '漏字母': (w) => w.slice(0, 4) + w.slice(5),
  '多字母': (w) => w.slice(0, 4) + 'zk' + w.slice(4),
  '相邻换位': (w) => w.slice(0, 4) + w[5] + w[4] + w.slice(6),
  '只记得词头': (w) => w.slice(0, Math.max(4, w.length - 3)),
};

console.log(`语料词表 ${words.length} 个可评测词，采样 ${sample.length} 个\n`);
console.log('类型          样本  精确命中  模糊命中  从0救回   救回率');

let totalRecoverable = 0;
let totalRecovered = 0;
for (const [name, mutate] of Object.entries(MUTATIONS)) {
  let exact = 0;
  let fuzzy = 0;
  let recoverable = 0;
  let recovered = 0;
  let n = 0;
  for (const word of sample) {
    const typo = mutate(word);
    if (typo === word || typo.length < 4) continue;
    n += 1;
    const before = cnt(typo, false);
    const after = cnt(typo, true);
    if (before > 0) exact += 1;
    if (after > 0) fuzzy += 1;
    if (before === 0) {
      recoverable += 1;
      if (after > 0) recovered += 1;
    }
  }
  totalRecoverable += recoverable;
  totalRecovered += recovered;
  const rate = recoverable === 0 ? '—' : `${((recovered / recoverable) * 100).toFixed(0)}%`;
  console.log(`${name.padEnd(12)} ${String(n).padStart(4)} ${String(exact).padStart(8)} ${String(fuzzy).padStart(9)} ${String(recovered).padStart(8)}   ${rate.padStart(6)}`);
}
console.log(
  `\n总救回率 ${((totalRecovered / Math.max(1, totalRecoverable)) * 100).toFixed(0)}% ` +
    `(${totalRecovered}/${totalRecoverable} 个精确 0 命中的查询被模糊救回)`,
);

// 误报：随机串必然不在语料里，模糊**不应该**无中生有
const randomWord = (length) =>
  Array.from({ length }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
let falsePositives = 0;
const ROUNDS = 20;
for (let i = 0; i < ROUNDS; i += 1) {
  const garbage = randomWord(8 + (i % 5));
  if (cnt(garbage, true) > 0) {
    falsePositives += 1;
    console.log(`  误报: ${garbage}`);
  }
}
console.log(`\n误报率 ${falsePositives}/${ROUNDS} = ${((falsePositives / ROUNDS) * 100).toFixed(0)}%（随机串应当 0 命中）`);

// 精确率：纠错后返回的文档，是否就是含「正确词」的那批
const idsOf = (q) => new Set(hits(q, true).hits.map((hit) => `${hit.sessionId}#${hit.seq}`));
let precisionSum = 0;
let checked = 0;
for (const word of sample.slice(0, 30)) {
  const typo = MUTATIONS['漏字母'](word);
  if (cnt(typo, false) > 0) continue;          // 只评估「本来搜不到」的情况
  const correct = idsOf(word);
  const repaired = idsOf(typo);
  if (repaired.size === 0) continue;
  checked += 1;
  let overlap = 0;
  for (const key of repaired) if (correct.has(key)) overlap += 1;
  precisionSum += overlap / repaired.size;
}
if (checked > 0) {
  console.log(`纠错精确率 ${((precisionSum / checked) * 100).toFixed(0)}%（${checked} 个样本，与正确词命中的文档重合度）`);
}

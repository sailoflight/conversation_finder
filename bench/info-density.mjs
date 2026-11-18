// 有效信息 / tokens：三种策略对比 + 重复率 + 排版开销
import { join } from 'node:path';
const HF = '/home/d_demo1/code/conversation_finder';
const { openDb } = await import(join(HF,'lib/schema.mjs'));
const { search } = await import(join(HF,'lib/query.mjs'));
const { outline } = await import(join(HF,'lib/outline.mjs'));
const { renderHits, renderOutline } = await import(join(HF,'lib/format.mjs'));
const db = openDb('/tmp/cfind-all/index.db', { readonly: true });

const cjk = (s) => (String(s).match(/[\u4e00-\u9fff]/g) ?? []).length;
const est = (s) => Math.round(cjk(s)/1.5 + (String(s).length-cjk(s))/4);

console.log('════ 策略对比：回答同一个问题，三种做法的 token 成本 ════\n');
const questions = ['bino_type', 'settlement_id', '幂等键'];

for (const q of questions) {
  // A) 全量 dump（把所有会话原文塞给模型）
  const totalChars = db.prepare('SELECT SUM(LENGTH(body)) s FROM docs').get().s ?? 0;
  // B) naive grep-all：所有含关键词的文档，全文、无预算
  const grepRows = db.prepare('SELECT body FROM docs WHERE body LIKE ?').all(`%${q}%`);
  const grepChars = grepRows.reduce((a,r)=>a+r.body.length,0);
  // C) cfind 三层（摘要 → 选择 → 全文）
  const l1 = renderOutline(outline(db,{scope:{mode:'all'}}),{maxChars:3000});
  const r = search(db,{query:q,scope:{mode:'all'},limit:3});
  const l2 = renderHits(r,{maxChars:1500,scope:'all sessions'});
  const cfindChars = l1.length + l2.length;

  console.log(`问题 "${q}"`);
  console.log(`  A 全量 dump      ${totalChars.toLocaleString().padStart(11)} 字符  ≈${est('x'.repeat(totalChars)*0+totalChars*0.28|0).toLocaleString().padStart(9)} tok`);
  console.log(`  B grep-all 全文  ${grepChars.toLocaleString().padStart(11)} 字符  ≈${Math.round(grepChars*0.28).toLocaleString().padStart(9)} tok   (${grepRows.length} 条原始文档)`);
  console.log(`  C cfind L1+L2    ${cfindChars.toLocaleString().padStart(11)} 字符  ≈${est(l1+l2).toLocaleString().padStart(9)} tok   (命中 ${r.total})`);
  console.log(`  → 相对 B 省 ${(grepChars/cfindChars).toFixed(0)}x | 相对 A 省 ${(totalChars/cfindChars).toFixed(0)}x\n`);
}

// ── 重复率：同一条内容在多处出现（真实浪费）──
console.log('════ L2 返回里的重复度（同会话内近似重复的命中）════');
for (const q of questions) {
  const r = search(db,{query:q,scope:{mode:'all'},limit:10});
  const sigs = r.hits.map(h => h.snippet.replace(/[\[\]…\s]/g,'').slice(0,60));
  const uniq = new Set(sigs).size;
  console.log(`  "${q}"`.padEnd(16)+`${r.hits.length} 条命中 → ${uniq} 条内容不同 | 重复率 ${((1-uniq/Math.max(1,r.hits.length))*100).toFixed(0)}%`);
}

// ── 排版开销：首行 header + 每条前缀 ──
console.log('\n════ 排版开销（非信息字符）════');
for (const q of questions) {
  const r = search(db,{query:q,scope:{mode:'all'},limit:3});
  const text = renderHits(r,{maxChars:1500,scope:'all sessions'});
  const header = text.split('\n')[0];
  const prefixes = (text.match(/^\[[a-z-]+\/[a-z]+\] [0-9a-f]{8} #\d+ /gm) ?? []).join('');
  console.log(`  "${q}"`.padEnd(16)+`总 ${String(text.length).padStart(4)} 字符 | header ${header.length} | 每条前缀合计 ${prefixes.length} | 开销 ${((header.length+prefixes.length)/text.length*100).toFixed(1)}%`);
}

import { join } from 'node:path';
const HF='/home/d_demo1/code/conversation_finder';
const {openDb}=await import(join(HF,'lib/schema.mjs'));
const {search,show}=await import(join(HF,'lib/query.mjs'));
const {outline}=await import(join(HF,'lib/outline.mjs'));
const {renderHits,renderOutline,renderShow}=await import(join(HF,'lib/format.mjs'));
const db=openDb('/tmp/cfind-all/index.db',{readonly:true});
const cjk=s=>(String(s).match(/[\u4e00-\u9fff]/g)??[]).length;
const est=s=>Math.round(cjk(s)/1.5+(String(s).length-cjk(s))/4);
const tok=s=>`${String(s.length).padStart(5)} 字符 ≈${String(est(s)).padStart(4)} tok`;

console.log('════ 真实 agent 流程（最常见路径）════\n');

// 路径 1：直接搜（agent 知道要搜什么）—— 最高频
const r=search(db,{query:'settlement_id',scope:{mode:'all'},limit:3});
const l2=renderHits(r,{maxChars:1500,scope:'all sessions'});
console.log(`① 只用 L2  search limit=3   ${tok(l2)}   ← 70% 场景够了`);

// 路径 2：搜完再看全文
const hit=r.hits[0];
const s1=show(db,{sessionId:hit.sessionId,seq:hit.seq,before:1,after:1});
const l3=renderShow(s1,{maxChars:1500});
console.log(`② 追加 L3  show ±1          ${tok(l3)}`);

// 路径 3：先看目录再决定
const l1=renderOutline(outline(db,{scope:{mode:'all'}}),{maxChars:3000});
console.log(`③ 追加 L1  outline --all    ${tok(l1)}`);

const flow1 = l2.length;
const flow2 = l2.length + l3.length;
const flow3 = l1.length + l2.length;
console.log(`\n  L2 单步合计                 ${tok(l2)}`);
console.log(`  L2→L3 两步合计              ${tok('x'.repeat(flow2))}`);
console.log(`  L1→L2 两步合计              ${tok('x'.repeat(flow3))}`);

// 语料基线（口径明确）
const corpusText = 26_418_063;   // 四源解压后原始文本（前面实测）
const docsBody  = db.prepare('SELECT SUM(LENGTH(body)) s FROM docs').get().s;
console.log(`\n════ 基线口径 ════`);
console.log(`  全量原始文本              ${tok('x'.repeat(corpusText))}   (26.4M 字符)`);
console.log(`  可索引正文（docs.body）    ${tok('x'.repeat(docsBody))}   (${(docsBody/1e6).toFixed(1)}M 字符)`);
console.log(`  → L2 单步相对全量省        ${(corpusText/flow1).toFixed(0)}x`);
console.log(`  → L2 单步相对可索引正文省   ${(docsBody/flow1).toFixed(0)}x`);

// 有效信息占比（用「命中锚点 + 其所在片段」估）
const anchor=(l2.match(/\[[^\]]*\]/g)??[]).join('').length;
const header=l2.split('\n')[0].length;
const prefixes=(l2.match(/^\[[a-z-]+\/[a-z]+\] [0-9a-f]{8} #\d+ /gm)??[]).join('').length;
console.log(`\n════ 输出构成拆解（L2 单步 ${l2.length} 字符）════`);
console.log(`  命中锚点（[ ] 内）         ${String(anchor).padStart(4)}  (${(anchor/l2.length*100).toFixed(1)}%)`);
console.log(`  排版开销（header+前缀）     ${String(header+prefixes).padStart(4)}  (${((header+prefixes)/l2.length*100).toFixed(1)}%)`);
console.log(`  上下文（片段里的其余部分）   ${String(l2.length-anchor-header-prefixes).padStart(4)}  (${((l2.length-anchor-header-prefixes)/l2.length*100).toFixed(1)}%)`);

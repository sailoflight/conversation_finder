// 测两件事：① 每层输出的真实 token 成本与信息密度 ② MCP 常驻 / CLI 的延迟
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ALL = '/tmp/cfind-all/index.db';
// 仓库根 = 本文件的上两级。硬编码绝对路径会让别人 clone 下来直接跑不了。
const HF = fileURLToPath(new URL('..', import.meta.url));

// ── token 估算：CJK 约 1.5 字/token，ASCII 约 4 字/token（DeepSeek BPE 的常见近似）──
const cjk = (s) => (String(s).match(/[\u4e00-\u9fff]/g) ?? []).length;
function estTokens(text) {
  const s = String(text);
  const c = cjk(s);
  const ascii = s.length - c;
  return Math.round(c / 1.5 + ascii / 4);
}

const { openDb } = await import(join(HF, 'lib/schema.mjs'));
const { search, show, resolveSessionIds } = await import(join(HF, 'lib/query.mjs'));
const { outline } = await import(join(HF, 'lib/outline.mjs'));
const { renderHits, renderOutline, renderShow } = await import(join(HF, 'lib/format.mjs'));

const db = openDb(ALL, { readonly: true });

// ── 基线：全量语料到底有多少字符（"直接全喂给模型"的成本）──
function decodeDsh(file) {
  const raw = readFileSync(file);
  const MAGIC = Buffer.from([0x28,0xb5,0x2f,0xfd]);
  const cuts=[]; for(let i=raw.indexOf(MAGIC);i>=0;i=raw.indexOf(MAGIC,i+4))cuts.push(i);
  if(!cuts.length) return '';
  const b=[...cuts,raw.length]; let out=''; let k=0;
  while(k<b.length-1){let j=k+1,d=null;while(j<b.length){try{d=zstdDecompressSync(raw.subarray(b[k],b[j]));break}catch{j++}}if(!d)break;out+=d.toString();k=j}
  return out;
}
let corpusChars = 0, corpusEvents = 0;
const walk = (d,o=[])=>{for(const e of readdirSync(d,{withFileTypes:true})){const p=join(d,e.name);e.isDirectory()?walk(p,o):p.endsWith('.zstd')&&o.push(p)}return o};
for (const f of walk(process.env.DSH_HOME ? `${process.env.DSH_HOME}/sessions` : `${homedir()}/.dsh/sessions`)) {
  const t = decodeDsh(f); corpusChars += t.length; corpusEvents += t.split('\n').filter(Boolean).length;
}
for (const dir of [process.env.CLAUDE_HOME, process.env.CODEX_HOME, process.env.OPENCODE_DIR].filter(Boolean)) {
  for (const f of readdirSync(dir)) { const t = readFileSync(join(dir,f),'utf8'); corpusChars += t.length; corpusEvents += t.split('\n').filter(Boolean).length; }
}

console.log('════ 基线：语料本体 ════');
console.log(`  原始文本      ${corpusChars.toLocaleString()} 字符 ≈ ${estTokens('x'.repeat(corpusChars)).toLocaleString()} tokens(纯ASCII下界)`);
console.log(`  CJK 精确估算  ${Math.round(corpusChars*0.35).toLocaleString()} tokens 量级`);
console.log(`  事件数        ${corpusEvents.toLocaleString()}`);

// ── 各层输出成本 ──
const measure = (label, text) => ({ label, chars: text.length, tokens: estTokens(text), lines: text.split('\n').length });

console.log('\n════ 各层输出成本（agent 实际吃进上下文的量）════');
const rows = [];

const oAll = outline(db, { scope: { mode: 'all' } });
rows.push(measure('L1 outline --all (61会话)', renderOutline(oAll, { maxChars: 3000 })));

const selfId = db.prepare("SELECT id FROM sessions WHERE source='dsh' ORDER BY last_time DESC LIMIT 1").get().id;
const oOne = outline(db, { scope: { mode: 'session', id: selfId } });
rows.push(measure('L1 outline --session(单个)', renderOutline(oOne, { maxChars: 3000 })));

for (const q of ['bino', '幂等键', 'settlement']) {
  const r = search(db, { query: q, scope: { mode: 'all' }, limit: 10 });
  rows.push(measure(`L2 search "${q}" limit=10`, renderHits(r, { maxChars: 1500, scope: 'all sessions' })));
  const r3 = search(db, { query: q, scope: { mode: 'all' }, limit: 3 });
  rows.push(measure(`L2 search "${q}" limit=3`, renderHits(r3, { maxChars: 1500, scope: 'all sessions' })));
}

const anyHit = search(db, { query: 'bino', scope: { mode: 'all' }, limit: 3 });
if (anyHit.hits[0]) {
  const s = show(db, { sessionId: anyHit.hits[0].sessionId, seq: anyHit.hits[0].seq, before: 1, after: 1 });
  rows.push(measure('L3 show ±1', renderShow(s, { maxChars: 1500 })));
  const s3 = show(db, { sessionId: anyHit.hits[0].sessionId, seq: anyHit.hits[0].seq, before: 3, after: 3 });
  rows.push(measure('L3 show ±3', renderShow(s3, { maxChars: 1500 })));
  const sFull = show(db, { sessionId: anyHit.hits[0].sessionId, seq: anyHit.hits[0].seq, before: 3, after: 3 });
  rows.push(measure('L3 show ±3 --full', renderShow(sFull, { maxChars: 0 })));
}

for (const r of rows) {
  console.log(`  ${r.label.padEnd(34)} ${String(r.chars).padStart(6)} 字符  ≈${String(r.tokens).padStart(5)} tok  ${String(r.lines).padStart(3)} 行`);
}

// ── 信息密度：返回文本里有多少是"命中本体" vs 排版/上下文 ──
console.log('\n════ 信息密度（L2 每 100 字符里有多少是命中本体）════');
for (const q of ['bino', '幂等键', 'settlement']) {
  const r = search(db, { query: q, scope: { mode: 'all' }, limit: 5 });
  const text = renderHits(r, { maxChars: 1500, scope: 'all' });
  // [ ] 包住的是命中词，作为"可定位锚点"的下界
  const anchored = (text.match(/\[[^\]]*\]/g) ?? []).join('').length;
  const hits = r.hits.length;
  console.log(`  "${q}"`.padEnd(16) + `命中 ${String(hits).padStart(2)} 条 | ${String(text.length).padStart(5)} 字符 | 锚点占比 ${(anchored/text.length*100).toFixed(1)}% | 每条均摊 ${Math.round(text.length/Math.max(1,hits))} 字符`);
}

// ── 有效信息覆盖：答案在第几层就能拿到 ──
console.log('\n════ 达标层：第几层就够了（省 token 的关键）════');
const probes = [
  { q: 'bino_type', answer: 'bino' },
  { q: 'settlement_id', answer: 'settlement' },
  { q: '幂等键', answer: '幂等' },
];
for (const p of probes) {
  const l1 = outline(db, { scope: { mode: 'all' } });
  const l1Text = renderOutline(l1, { maxChars: 3000 });
  const l2 = search(db, { query: p.q, scope: { mode: 'all' }, limit: 10 });
  const l2Text = renderHits(l2, { maxChars: 1500, scope: 'all' });
  const hasL1 = l1Text.includes(p.answer);   // 摘要层能否直接看到
  const hasL2 = l2Text.includes(p.answer);
  console.log(`  "${p.q}"`.padEnd(18) + `L1摘要=${hasL1?'✓':'✗'}  L2片段=${hasL2?'✓':'✗'}  该走 ${hasL2?'L2':'L3'}`);
}

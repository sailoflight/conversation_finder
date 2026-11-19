// bench/synonym-eval.mjs — 同义扩展的**效果**评估（受控语料）
//
// 为什么必须在受控语料上测：
//   cfind 索引的是会话历史，而跑评估的这个会话本身就在被索引 ——
//   我上一次敲的测试命令会让下一次查询的"精确命中"凭空多出来，
//   于是「扩展前 0 条」的假设失效，测出来的全是自己回显。
//   所以这里现造一个语料，每条文档归属于一个已知概念、用已知的说法表达。
//
// 测三件事：
//   1. 召回增益：罕见说法原本 0 命中，扩展后能找到几条（能否救回）
//   2. 精度：扩展后返回的文档里，有多少**真的是**那个概念（不是被无关词带进来）
//   3. 护栏有效性：通用词、无关串不该被扩展
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/schema.mjs';
import { search } from '../lib/query.mjs';
import { bigrams } from '../lib/cjk.mjs';
import { expandSynonyms, SYNONYM_GROUPS } from '../lib/synonyms.mjs';

/**
 * 受控语料：每个概念有若干种说法，每种说法写成一条文档。
 * 关键设计——**每条文档只谈论一个概念**，所以"返回的文档属于该概念"
 * 就是可自动判定的精度依据，不需要人工看片段。
 */
const CORPUS = [
  // 重要：语料里**不放**后面要查询的那些罕见说法。
  // 否则"精确命中"永远不为 0，就测不出"扩展能不能救回"。
  // 概念：超时
  ['超时', ['请求超时后重试了三次', '连接超时，需要加大上限', '超时阈值设为 30 秒']],
  // 概念：限流
  ['限流', ['接口加了限流，每秒 10 次', '触发限流后返回 429', '限流窗口滑动计算']],
  // 概念：递归
  ['递归', ['递归遍历目录树', '递归层级过深会爆栈', '递归的终止条件写错会栈溢出']],
  // 概念：去重
  ['去重', ['对结果做去重处理', '去重后再写入数据库', '去重逻辑放在写入之前']],
  // 概念：报错
  ['报错', ['这里报错是因为类型不匹配', '报错信息里带堆栈', '抛错时要保留原始原因']],
  // 干扰概念：都是"通用词"，用来检验护栏不会把它们当成同义词
  ['干扰-通用', ['我们同时做了两件事', '同时触发两个流程', '重复调用没有副作用']],
];

function buildCorpus() {
  const dir = mkdtempSync(join(tmpdir(), 'cfind-syn-'));
  const db = openDb(join(dir, 'index.db'));
  db.prepare(
    `INSERT INTO sessions (id, source, cwd, title, created_at, agent_preset, parent_id, event_count, first_time, last_time)
     VALUES ('syn-0001', 'dsh', '/tmp/syn', '同义词评估', 1700000000000, null, null, 0, 1700000000000, 1700000000000)`,
  ).run();
  const insert = db.prepare(
    'INSERT INTO docs (body, sh, source, session_id, seq, kind, time, surface) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  // concept 存在标题里不方便查，这里用一张内存映射：seq → 概念
  const owner = new Map();
  let seq = 1;
  for (const [concept, texts] of CORPUS) {
    for (const text of texts) {
      insert.run(text, bigrams(text), 'dsh', 'syn-0001', seq, 'user', 1700000000000 + seq, 'current');
      owner.set(seq, concept);
      seq += 1;
    }
  }
  return { db, dir, owner };
}

function main() {
  const { db, dir, owner } = buildCorpus();
  const scope = { mode: 'all' };

  /** 用某查询检索；返回 {total, concepts:Set, expanded} */
  const run = (query, synonym = true) => {
    const result = search(db, { query, scope, limit: 50, surface: 'all', synonym, fuzzy: synonym });
    const concepts = new Set(result.hits.map((hit) => owner.get(hit.seq)));
    return { total: result.total, concepts, expanded: result.fuzzy?.applied ?? null };
  };

  console.log('=== ① 召回增益：罕见说法能否救回 ===');
  console.log('查询'.padEnd(10), '精确'.padStart(5), '扩展后'.padStart(7), '  扩展');
  const rare = ['等待太久', '防止过载', '自我调用', '避免重复', '排重', '出问题'];
  let rescued = 0;
  for (const term of rare) {
    const exact = run(term, false);
    const wide = run(term, true);
    if (exact.total === 0 && wide.total > 0) rescued += 1;
    console.log(term.padEnd(10), String(exact.total).padStart(5), String(wide.total).padStart(7), ' ',
      wide.expanded ? `synonym→${wide.expanded}` : (exact.total > 0 ? '精确命中' : '(无)'));
  }
  console.log(`  救回 ${rescued}/${rare.length}`);

  console.log('\n=== ② 精度：扩展后的结果真的是那个概念吗 ===');
  // 对每个"罕见说法"，看它扩展后返回的文档属于哪个概念
  let judged = 0;
  let correct = 0;
  for (const term of rare) {
    const wide = run(term, true);
    if (wide.total === 0) continue;
    // 期望概念 = 该说法在某组里的规范词所在概念
    const expected = SYNONYM_GROUPS.find((group) =>
      group.some((member) => member === term),
    )?.[0];
    const hitCount = [...wide.concepts].filter((c) => c !== undefined);
    const ok = hitCount.every((c) => c === expected || c === `干扰-通用` ? c === expected : false);
    judged += 1;
    if (ok) correct += 1;
    console.log(
      String(term).padEnd(10),
      '返回概念:', [...wide.concepts].join(',').padEnd(20),
      ok ? '✅ 全部相关' : '❌ 混入无关概念',
    );
  }
  console.log(`  精度 ${correct}/${judged}`);

  console.log('\n=== ③ 护栏：通用词 / 无关串不该被扩展 ===');
  const traps = ['同时', '重复调用', 'zzqqxxjwplm', '紫色的大象在跳舞'];
  for (const term of traps) {
    const wide = run(term, true);
    console.log(term.padEnd(14), wide.expanded ? `❌ 扩展了 ${wide.expanded}` : '✅ 未扩展');
  }

  console.log('\n=== ④ 护栏拒绝明细（为什么某些同义词被挡）===');
  for (const term of ['并发', '排重', '响应慢']) {
    const { expansions, rejected } = expandSynonyms(db, term);
    console.log(String(term).padEnd(8), '接受:', expansions.map((e) => `${e.term}(${e.doc})`).join(' ') || '(无)');
    if (rejected.length > 0) {
      console.log('        拒绝:', rejected.map((r) => `${r.term}[${r.why}]`).join(' '));
    }
  }

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

main();

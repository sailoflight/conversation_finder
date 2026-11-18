#!/usr/bin/env node
// tests/fixtures/make-fixture.mjs — 生成确定性测试语料
//
// 为什么需要它：真实语料会随会话增长而漂移，且本地没有 compaction 事件，
// 而 compaction 恰恰是本项目的核心场景。这里合成一份固定的小语料：
//   · 多帧 zstd（每个事件一帧），覆盖帧切分与增量水位线
//   · 中文 + 英文，覆盖 CJK bigram
//   · 一次完整压缩事务（start/summary/end + replace 消息），覆盖 shadowed 分类
//   · 会话 2 是「被压缩前」的细节，用于验证「压缩后仍能搜回原文」
//
// 用法：
//   node tests/fixtures/make-fixture.mjs          # 生成到 tests/fixtures/sessions
//   import { buildFixture } from '.../make-fixture.mjs'; buildFixture(dir)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { zstdCompressSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * **每个测试进程一份** fixture，不再共享磁盘目录。
 *
 * 早先它是 `tests/fixtures/sessions`（仓库内固定路径），且生成逻辑第一步就
 * `rmSync`。而 `node --test` 会**并行跑多个测试文件**，其中 6 个都 import 本模块，
 * 于是出现真实竞态：
 *   · A 进程看到目录不存在 → 开始生成 → 先删后写；
 *   · B 进程此刻 cpSync 这份「写了一半」的目录 → 拿到残缺/多余会话；
 *   · 表现是偶发的 `8 !== 2` 这类断言失败，而且只在机器忙时出现。
 *
 * 改成按进程 mkdtemp 后：没有共享可变状态，也就不需要 existsSync 判断，
 * 每个进程 30ms 左右的生成成本完全可以接受。
 */
export const FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'cfind-fixture-'));

/** 每行一个事件，逐行压成一帧（模拟真实 DSH 的多帧布局）。 */
export function writeSessionFile(path, events) {
  mkdirSync(dirname(path), { recursive: true });
  const frames = events.map((ev) => zstdCompressSync(Buffer.from(`${JSON.stringify(ev)}\n`, 'utf8')));
  writeFileSync(path, Buffer.concat(frames));
}

const SESSION_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const SESSION_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const T0 = 1794990000000;

function sessionA() {
  const ev = [];
  let seq = 0;
  const add = (type, data, extra = {}) => {
    ev.push({ type, seq, time: T0 + seq * 1000, data, ...extra });
    seq += 1;
  };
  // 注意：session 头字段在**顶层**（实测格式），不是 data 里。
  ev.push({
    type: 'session',
    version: 4,
    id: SESSION_A,
    createdAt: T0,
    cwd: '/tmp/fixture-demo',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  });
  seq += 1;
  add('session/title', { title: '幂等键与重复扣款排查', messageSeqs: [2], source: { kind: 'provider' } });
  add('user/message', { content: [{ type: 'text', text: 'POST 请求重复提交会导致重复扣款，需要幂等键。' }] });
  add('assistant/message', {
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '用户关心的是幂等性。我应该在订单服务里加去重表，用订单号做唯一约束。' },
        { type: 'text', text: '⏵ 查一下订单服务的写入路径\n\n先看去重逻辑在哪。' },
        { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"grep -rn dedupe src/order"}' },
      ],
    },
  });
  add('tool/call', { turn: 1, step: 1, callId: 'call_1', name: 'bash', arguments: '{"command":"grep -rn dedupe src/order"}' });
  add('tool/result', {
    message: {
      role: 'tool',
      content: [{ type: 'text', text: 'src/order/write.ts:42: // TODO: dedupe by idempotency key\nstderr: landlock partial' }],
    },
    toolCallId: 'call_1',
  });
  add('assistant/message', {
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '结论：在 write.ts 加唯一索引 (tenant_id, idempotency_key)，冲突时返回上次结果。' }],
    },
  });
  add('turn/end', { reason: { kind: 'completed' } });
  return ev;
}

/** 会话 B：先有细节，再被压缩（用来验证 compressed-away 内容仍可搜到）。 */
function sessionB() {
  const ev = [];
  let seq = 0;
  const add = (type, data, extra = {}) => {
    ev.push({ type, seq, time: T0 + 100_000 + seq * 1000, data, ...extra });
    seq += 1;
  };
  ev.push({
    type: 'session',
    version: 4,
    id: SESSION_B,
    createdAt: T0 + 100_000,
    cwd: '/tmp/fixture-demo',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  });
  seq += 1;  add('session/title', { title: '订阅计费与退款对账', messageSeqs: [2], source: { kind: 'provider' } });
  add('user/message', { content: [{ type: 'text', text: '订阅扣款失败了，帮我看看对账逻辑。' }] });
  // 会被压缩掉的细节（关键：seq 3、4 之后应变成 shadowed）
  add('assistant/message', {
    message: {
      role: 'assistant',
      content: [{ type: 'reasoning', text: '对账脚本在 billing/reconcile.py，它依赖 settlement_id 唯一性。' }],
    },
  });
  add('tool/call', { turn: 1, step: 1, callId: 'call_9', name: 'bash', arguments: '{"command":"grep -rn settlement_id billing/"}' });
  add('tool/result', {
    message: { role: 'tool', content: [{ type: 'text', text: 'billing/reconcile.py:17: settlement_id = row["settlement_id"]' }] },
    toolCallId: 'call_9',
  });
  // 压缩：start → summary → replace 消息 → end
  const shadowedSeqs = [3, 4, 5];
  add('compaction/start', { compactionId: 'cmp-1', trigger: 'auto' });
  add('compaction/summary', {
    compactionId: 'cmp-1',
    summary: [
      {
        type: 'text',
        text: '早期排查发现：对账脚本在 billing/reconcile.py，通过 settlement_id 做幂等去重。' +
          '已确认重复退款源于 settlement_id 为空时的重试分支。',
      },
    ],
    shadowedRange: { start: 3, end: 5 },
    shadowedSeqs,
    shadowedTokenCount: 1234,
    provider: 'newapi',
    model: 'deepseek-flash',
  });
  add(
    'user/message',
    {
      content: [
        {
          type: 'text',
          text: '<compacted-summary>\n对账脚本在 billing/reconcile.py，通过 settlement_id 做幂等去重。\n</compacted-summary>',
        },
      ],
      source: { kind: 'compact-checkpoint', compactionId: 'cmp-1' },
    },
    { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 5 }, sourceEventSeqs: [5, 6, 3, 4, 7] },
  );
  add('compaction/end', { compactionId: 'cmp-1' });
  add('assistant/message', {
    message: { role: 'assistant', content: [{ type: 'text', text: '压缩后继续：需要修 settlement_id 为空的分支。' }] },
  });
  return ev;
}

/**
 * 生成（或重建）语料目录，返回其路径。
 * 默认写到本进程专属的 mkdtemp 目录：**会先清空目标**，所以绝不能共享。
 */
export function buildFixture(dir = FIXTURE_DIR) {
  // 只在独占目录上调用（本进程 mkdtemp 或测试自己的副本），
  // 绝不要指向仓库内的共享路径 —— 那正是竞态的来源。
  rmSync(dir, { recursive: true, force: true });
  writeSessionFile(join(dir, '--tmp-fixture-demo--', SESSION_A, 'session.v4.jsonl.zstd'), sessionA());
  writeSessionFile(join(dir, '--tmp-fixture-demo--', SESSION_B, 'session.v4.jsonl.zstd'), sessionB());
  return dir;
}

export const SESSION_IDS = { A: SESSION_A, B: SESSION_B };

/**
 * **import 时就绪**：消费方不需要（也不该）再用 `existsSync` 判断。
 * 早先的 `if (!existsSync(FIXTURE_DIR)) buildFixture();` 是错误的双保险：
 * FIXTURE_DIR 一旦换成 mkdtemp，目录是"存在但空"的，判断为真就跳过生成，
 * 于是测试拿到空目录、断言全变 0。让本模块自己负责就绪状态最省心。
 */
buildFixture();

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = buildFixture();
  console.log(`fixture written: ${dir}`);
  console.log(`  session A = ${SESSION_A}`);
  console.log(`  session B = ${SESSION_B} (has compaction; seq 3-5 shadowed)`);
}

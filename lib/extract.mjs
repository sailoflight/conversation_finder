// lib/extract.mjs — 从会话事件提取「可检索文档」
//
// 与官方 dsh-session-query 的 extractSessionEventText 的两处刻意差异：
//   1. 官方丢弃 reasoning（占 assistant 体积 65.9%），我们单独存成 reasoning 文档（降权）。
//   2. 官方没有 compaction/summary 分支，而它正是「记忆」本体 —— 必须索引。
// 两者都不索引：request/header（20.8%）、system/message、replayState 等噪声。

/** 文档种类及其检索权重（排序时乘到 BM25 上；越大越优先）。 */
export const KIND_WEIGHTS = {
  user: 1.0,
  compaction: 0.95,
  title: 0.9,
  assistant: 0.8,
  'tool-call': 0.6,
  'tool-result': 0.4,
  reasoning: 0.25,
  other: 0.15,
};

/** 明确不入索引的事件类型（体积大、检索价值低）。 */
const SKIP_TYPES = new Set([
  'session',
  'request/header',
  'request/context',
  'system/message',
  'session/title-llm-request',
  'sandbox/mode',
  'permission/preset',
  'approval/policy',
  'approval/asked',
  'approval/decided',
  'step/start',
  'step/end',
  'turn/start',
  'assistant/attempt',
  'agent/inbox/spliced',
  'command/run',
  'command/done',
  'subagent/catalog',
  'subagent/descriptor',
  'compaction/start',
  'compaction/end',
  'compaction/prune',
  'developer/message',
  'model/selection',
  'deliverables/presented',
]);

/**
 * 前缀黑名单：这些命名空间是生命周期/编排日志，不是可检索内容。
 * 用前缀而不是逐条列举，是为了避免宿主新增同类事件时又漏进来——
 * 实测 `job/registered` + `job/settled` 就曾贡献 275K 字符纯噪声。
 */
const SKIP_PREFIXES = ['job/', 'model/', 'deliverables/', 'compaction/'];

/** 单个文档正文上限，防止一条巨型工具输出撑爆索引。 */
const MAX_BODY = 64_000;

/** 拼接文本块（text 与 tool-call；丢弃 reasoning 与未知块）。 */
export function contentText(blocks) {
  return (blocks ?? [])
    .flatMap((block) => {
      if (block?.type === 'text') return [block.text ?? ''];
      if (block?.type === 'tool-call') return [block.name ?? '', block.arguments ?? ''];
      return [];
    })
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n');
}

const clip = (text) => (text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text);

/**
 * 一个事件 → 若干可检索文档。
 * @returns {Array<{kind: string, body: string}>} 空数组表示不索引
 */
export function docsOf(ev) {
  const data = ev?.data ?? {};
  const out = [];
  const push = (kind, body) => {
    const text = (body ?? '').trim();
    if (text.length >= 2) out.push({ kind, body: clip(text) });
  };

  switch (ev?.type) {
    case 'user/message':
      push('user', contentText(data.content));
      break;
    case 'assistant/message': {
      const blocks = data.message?.content ?? [];
      push('assistant', blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n'));
      push('reasoning', blocks.filter((b) => b?.type === 'reasoning').map((b) => b.text ?? '').join('\n'));
      break;
    }
    case 'tool/call':
      push('tool-call', [data.name, data.arguments].filter(Boolean).join('\n'));
      break;
    case 'tool/result': {
      const parts = [contentText(data.message?.content)];
      if (data.error?.name) parts.push(data.error.name);
      if (data.error?.message) parts.push(data.error.message);
      push('tool-result', parts.filter(Boolean).join('\n'));
      break;
    }
    case 'compaction/summary': {
      const body = Array.isArray(data.summary) ? contentText(data.summary) : String(data.summary ?? '');
      push('compaction', body || String(data.rawOutput ?? ''));
      break;
    }
    case 'session/title':
      push('title', data.title);
      break;
    case 'todo/write':
      push('other', (data.todos ?? []).flatMap((todo) => [todo.status, todo.content]).filter(Boolean).join('\n'));
      break;
    case 'turn/end':
      if (data.reason?.kind === 'error') push('other', data.reason.error?.message);
      else if (data.reason?.kind === 'aborted') push('other', 'aborted');
      break;
    default: {
      if (SKIP_TYPES.has(ev?.type)) break;
      if (SKIP_PREFIXES.some((prefix) => String(ev?.type ?? '').startsWith(prefix))) break;
      // 未识别事件：兜底抽 data 里的字符串（第三方事件），降权。
      push('other', collectStrings(data).join('\n'));
      break;
    }
  }
  return out;
}

/** 递归收集对象里的字符串（有深度与数量上限）。 */
function collectStrings(value, depth = 0, budget = { left: 200 }) {
  if (budget.left <= 0 || depth > 4 || value == null) return [];
  if (typeof value === 'string') {
    budget.left -= 1;
    return value.trim() ? [value] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item, depth + 1, budget));
  if (typeof value === 'object') {
    return Object.values(value).flatMap((item) => collectStrings(item, depth + 1, budget));
  }
  return [];
}

/**
 * surface 分类：DSH 压缩只给事件打 replace 标记，原文不删。
 * surfaceOp 实测只有两种形状：'append' 与 {op:'replace', startSeq, endSeq}。
 * @returns {Map<number, 'current'|'shadowed'>}
 */
export function classifySurface(events) {
  const shadowed = new Set();
  for (const ev of events) {
    const op = ev?.surfaceOp;
    if (op && typeof op === 'object' && op.op === 'replace' && Number.isInteger(op.startSeq)) {
      const end = Number.isInteger(op.endSeq) ? op.endSeq : op.startSeq;
      for (let seq = op.startSeq; seq <= end; seq += 1) shadowed.add(seq);
    }
  }
  const result = new Map();
  for (const ev of events) {
    if (!Number.isInteger(ev?.seq)) continue;
    result.set(ev.seq, shadowed.has(ev.seq) ? 'shadowed' : 'current');
  }
  return result;
}

/**
 * 整个会话 → 文档列表（含 seq/time/surface），供索引器直接写入。
 * @returns {Array<{seq: number, kind: string, body: string, time: number, surface: string}>}
 */
export function sessionDocs(events) {
  const surface = classifySurface(events);
  const out = [];
  for (const ev of events) {
    if (!Number.isInteger(ev?.seq)) continue;
    for (const doc of docsOf(ev)) {
      out.push({
        seq: ev.seq,
        kind: doc.kind,
        body: doc.body,
        time: ev.time ?? 0,
        surface: surface.get(ev.seq) ?? 'current',
      });
    }
  }
  return out;
}

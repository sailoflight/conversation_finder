// lib/outline.mjs — L1 摘要层：标题 + 回合（prompt/response 预览）+ 压缩检查点
//
// 跨源设计：本文件**不认识任何一家的事件名**，只依赖适配器的两个能力
//   · renderEvent(event) → { role, text }   —— 一条事件是什么角色、正文是什么
//   · checkpoints?(events) → Checkpoint[]   —— 可选：该源的压缩检查点
//
// 回合锚点为什么不统一用 `turn/start`：那是 DSH 独有的事件。通用做法是
// **以一条 user 消息开启一个回合**，response 取下一个 user 之前最后一条 assistant 文本。
// 这与 DSH 官方 turn-outline 的语义等价（官方也只在「首条 user / 末条 assistant」取值），
// 但对 Claude Code / Codex / OpenCode 同样成立。
import { shortId } from './paths.mjs';
import { findSessionFile } from './context.mjs';
import { resolveSessionIds } from './query.mjs';

const CHECKPOINT_PREVIEW = 200;

/** 压成单行。 */
const compress = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** 压空白后截断，超长补 `…`（总长 ≤ limit）。 */
function clipText(text, limit, fallback) {
  const max = Math.max(0, Number.isInteger(limit) ? limit : fallback);
  const flat = compress(text);
  if (!flat || max === 0) return '';
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * 生成作用域内所有会话的回合大纲。
 * @returns {{sessions: Array<object>}}
 */
export function outline(db, { scope, promptLimit = 60, responseLimit = 120 } = {}) {
  const ids = resolveSessionIds(db, scope);
  const metaStmt = db.prepare('SELECT id, cwd, title, created_at, event_count, source FROM sessions WHERE id = ?');
  const sessions = [];

  for (const id of ids) {
    const meta = metaStmt.get(id);
    const found = findSessionFile(db, id);
    const events = (found?.events ?? []).filter((event) => Number.isInteger(event.seq)).sort((a, b) => a.seq - b.seq);

    sessions.push({
      sessionId: id,
      short: shortId(id),
      title: meta?.title ?? '',
      cwd: meta?.cwd ?? '',
      source: meta?.source ?? 'dsh',
      createdAt: meta?.created_at ?? found?.header?.createdAt ?? null,
      eventCount: meta?.event_count ?? events.length,
      turns: turnsOf(found?.adapter, events, promptLimit, responseLimit),
      checkpoints: checkpointsOf(found?.adapter, events),
    });
  }
  return { sessions };
}

/**
 * 以 user 消息切分回合；同一回合内取首问、末答。
 * 用适配器的 renderEvent 取正文，所以任何来源都能用。
 */
function turnsOf(adapter, events, promptLimit, responseLimit) {
  // 有显式锚点（DSH 的 turn/start）就按它切分：一个回合里可能有多条 user 注入，
  // 用「首条 user」锚会在这种源上多切出回合。
  // 注意：实现了 turnAnchors 的源**始终**按它切分（哪怕返回空数组）。
  // 不能「空了就回退到 user 锚点」——DSH 的压缩检查点消息也是一条 user/message，
  // 回退会把它误算成一个新回合。
  if (typeof adapter?.turnAnchors === 'function') {
    return anchoredTurns(adapter, events, adapter.turnAnchors(events), promptLimit, responseLimit);
  }

  const out = [];
  let current = null;

  for (const event of events) {
    const view = adapter?.renderEvent?.(event) ?? {};
    const role = view.role;
    const text = String(view.text ?? '').trim();

    if (role === 'user') {
      // 新回合开始；上一回合收尾。
      if (current !== null) out.push(current);
      current = { seq: event.seq, prompt: compress(text), response: '' };
      continue;
    }
    if (current === null) continue;
    // 「最后一条」assistant 覆盖式赋值，与官方 turn-outline 一致。
    if (role === 'assistant' && text) current.response = compress(text);
  }
  if (current !== null) out.push(current);

  return out.map((turn, index) => ({
    turn: index + 1,
    seq: turn.seq,
    prompt: clipText(turn.prompt, promptLimit, 60),
    response: clipText(turn.response, responseLimit, 120),
  }));
}

/** 用显式锚点切分：每段内取首条 user 作 prompt、末条 assistant 作 response。 */
function anchoredTurns(adapter, events, anchors, promptLimit, responseLimit) {
  const indexOf = new Map(events.map((event, index) => [event.seq, index]));
  const positions = anchors.map((seq) => indexOf.get(seq)).filter((index) => index !== undefined);

  return positions.map((startIdx, turnIdx) => {
    const endIdx = positions[turnIdx + 1] ?? events.length;
    let prompt = '';
    let promptFound = false;
    let response = '';
    for (let i = startIdx + 1; i < endIdx; i += 1) {
      const view = adapter.renderEvent(events[i]) ?? {};
      const text = String(view.text ?? '');
      if (view.role === 'user' && !promptFound) {
        prompt = text; // 「第一条」优先，哪怕它是空的
        promptFound = true;
      } else if (view.role === 'assistant') {
        response = text; // 「最后一条」覆盖式赋值
      }
    }
    return {
      turn: turnIdx + 1,
      seq: events[startIdx].seq,
      prompt: clipText(prompt, promptLimit, 60),
      response: clipText(response, responseLimit, 120),
    };
  });
}

/**
 * 压缩检查点。各源表达完全不同（DSH: compaction/summary；Claude: compact_boundary），
 * 所以由适配器自己实现 `checkpoints`，这里只做兜底：没有就返回空数组。
 */
function checkpointsOf(adapter, events) {
  if (typeof adapter?.checkpoints !== 'function') return [];
  try {
    return adapter.checkpoints(events).map((checkpoint) => ({
      seq: checkpoint.seq,
      time: checkpoint.time ?? 0,
      shadowedTokenCount: Number.isInteger(checkpoint.shadowedTokenCount) ? checkpoint.shadowedTokenCount : 0,
      range: { start: checkpoint.range?.start ?? null, end: checkpoint.range?.end ?? null },
      preview: compress(checkpoint.preview).slice(0, CHECKPOINT_PREVIEW),
    }));
  } catch {
    // 检查点只是摘要层的附加信息，取不到不应该让整个 outline 失败。
    return [];
  }
}

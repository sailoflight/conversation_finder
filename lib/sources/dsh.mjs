// lib/sources/dsh.mjs — DSH 适配器（参考实现）
//
// 这条路径已经用真实语料验证过：zstd 多帧解码、surfaceOp 的 replace 语义、
// CJK 无关（分词在检索层统一做）。其它适配器照着这个形状写即可。
import { readFileSync } from 'node:fs';
import { listSessionFiles, sessionsRoot, dshHome } from '../paths.mjs';
import { readSessionFile, decodeFramesFrom } from '../decode.mjs';
import { docsOf, classifySurface } from '../extract.mjs';

/** DSH 的 session 事件字段在**顶层**（不在 data 里）。 */
function headerOf(events, ref) {
  const session = events.find((ev) => ev?.type === 'session') ?? null;
  // 兜底 id 用**原始目录名**（保留 `session-` 前缀）：它要和 sessions 表里的键一致。
  // 剥前缀只是展示层的事，由 shortId() 负责。
  const fallbackId = String(ref.dirId ?? ref.sessionHint ?? '');
  return {
    id: String(session?.id ?? fallbackId),
    cwd: session?.cwd ?? null,
    title: null, // 由 toTitle 从 session/title 事件补
    createdAt: Number.isInteger(session?.createdAt) ? session.createdAt : null,
    agentPreset: session?.agentPreset ?? null,
    parentId: PARENT_KEYS.map((key) => session?.[key]).find((value) => typeof value === 'string') ?? null,
  };
}

const PARENT_KEYS = ['parentSession', 'parentSessionId', 'parentId', 'forkedFrom', 'sourceSessionId'];

export const dshSource = {
  id: 'dsh',
  label: 'DSH',

  detect() {
    return listSessionFiles(sessionsRoot()).length > 0;
  },

  discover(options = {}) {
    const root = options.root ?? sessionsRoot();
    return listSessionFiles(root).map((file) => ({
      ref: file.path,
      dirId: file.dirId,
      sessionHint: file.dirId,
      size: file.size,
      mtime: file.mtime,
      raw: file,
    }));
  },

  readAll(ref) {
    const path = typeof ref === 'string' ? ref : ref.ref;
    const { header, events } = readSessionFile(path);
    return {
      header: headerOf(events, typeof ref === 'string' ? {} : ref),
      // DSH 自带 seq，直接沿用（不要用行号，压缩后 seq 才是稳定标识）。
      events: events
        .filter((ev) => Number.isInteger(ev?.seq))
        .map((ev) => ({ seq: ev.seq, time: ev.time ?? 0, type: ev.type ?? 'unknown', data: ev })),
      consumed: readFileSync(path).length,
    };
  },

  /** 增量：从帧边界继续解，只返回新增事件。 */
  readFrom(ref, offset) {
    const path = typeof ref === 'string' ? ref : ref.ref;
    const raw = readFileSync(path);
    if (offset >= raw.length) return { events: [], consumed: raw.length };
    const { text, consumed } = decodeFramesFrom(raw, offset);
    const events = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (Number.isInteger(ev?.seq)) events.push({ seq: ev.seq, time: ev.time ?? 0, type: ev.type ?? 'unknown', data: ev });
    }
    return { events, consumed };
  },

  toDocs(event) {
    return docsOf(event.data);
  },

  /**
   * 增量模式下的遮蔽区间：DSH 用 `surfaceOp:{op:'replace',startSeq,endSeq}`
   * 表达「这段历史被压缩成了摘要」。只从新增事件里取，所以只需返回本次新出现的区间。
   * @returns {Array<[number, number]>}
   */
  shadowRanges(events) {
    const ranges = [];
    for (const event of events) {
      const op = event.data?.surfaceOp;
      if (op && typeof op === 'object' && op.op === 'replace' && Number.isInteger(op.startSeq)) {
        ranges.push([op.startSeq, Number.isInteger(op.endSeq) ? op.endSeq : op.startSeq]);
      }
    }
    return ranges;
  },

  surfaceOf(events) {
    const surface = classifySurface(events.map((event) => event.data));
    const result = new Map();
    for (const event of events) result.set(event.seq, surface.get(event.seq) ?? 'current');
    return result;
  },

  renderEvent(event) {
    const native = event.data ?? {};
    const role = native.type === 'user/message' ? 'user' : native.type === 'assistant/message' ? 'assistant' : native.type?.startsWith('tool/') ? 'tool' : 'event';
    return { role, text: renderText(native) };
  },

  /**
   * 回合锚点。DSH 有显式的 `turn/start`，用它比「首条 user 消息」更准
   * （一个回合里可能有多条 user 注入）。没有该事件的源会退回通用锚点。
   * @returns {number[]} 升序 seq
   */
  turnAnchors(events) {
    return events.filter((event) => event.data?.type === 'turn/start').map((event) => event.seq);
  },

  /**
   * 结构性噪声：这些事件不该出现在 show 的上下文窗口里（目标事件除外）。
   * 判据是「对理解上下文没有价值」，而不是「没有正文」——
   * turn/end 之类的正文为空但仍是时序的一部分，所以不在这里。
   */
  isNoise(event) {
    const type = String(event?.type ?? '');
    return (
      type === 'session' ||
      type === 'request/header' ||
      type === 'system/message' ||
      type === 'turn/start' ||
      type.startsWith('step/')
    );
  },

  /**
   * 压缩检查点：`compaction/summary` 才是「被压缩掉的记忆」的索引。
   * range 优先取 shadowedRange，退回 shadowedSeqs 的首尾。
   */
  checkpoints(events) {
    const out = [];
    for (const event of events) {
      const data = event.data ?? {};
      if (data.type !== 'compaction/summary') continue;
      const payload = data.data ?? {};
      const seqs = Array.isArray(payload.shadowedSeqs) ? payload.shadowedSeqs.filter(Number.isInteger) : [];
      const start = Number.isInteger(payload.shadowedRange?.start)
        ? payload.shadowedRange.start
        : seqs.length
          ? Math.min(...seqs)
          : null;
      const end = Number.isInteger(payload.shadowedRange?.end)
        ? payload.shadowedRange.end
        : seqs.length
          ? Math.max(...seqs)
          : start;
      out.push({
        seq: event.seq,
        time: event.time ?? 0,
        shadowedTokenCount: payload.shadowedTokenCount ?? 0,
        range: { start, end },
        preview: renderText(data),
      });
    }
    return out;
  },

  /** 会话标题：取最后一条 session/title。 */
  titleOf(events) {
    let title = null;
    for (const event of events) {
      if (event.data?.type === 'session/title' && event.data.data?.title) title = event.data.data.title;
    }
    return title;
  },
};

/** 事件正文（DSH 专属：content blocks / tool args）。 */
function renderText(ev) {
  const contentText = (blocks) =>
    (blocks ?? [])
      .flatMap((block) => {
        if (block?.type === 'text') return [block.text ?? ''];
        if (block?.type === 'tool-call') return [`${block.name} ${block.arguments ?? ''}`];
        return [];
      })
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n');
  switch (ev.type) {
    case 'user/message':
      return contentText(ev.data?.content);
    case 'assistant/message':
      return contentText(ev.data?.message?.content);
    case 'tool/call':
      return `${ev.data?.name ?? ''} ${ev.data?.arguments ?? ''}`.trim();
    case 'tool/result':
      return contentText(ev.data?.message?.content);
    case 'compaction/summary': {
      const summary = ev.data?.summary;
      return Array.isArray(summary) ? contentText(summary) : String(summary ?? '');
    }
    case 'session/title':
      return String(ev.data?.title ?? '');
    default:
      return '';
  }
}

/** 供其它模块使用：DSH home（展示/调试用）。 */
export const dshHomePath = dshHome;

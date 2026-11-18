// lib/sources/codex.mjs — OpenAI Codex CLI 适配器
//
// Codex 的 rollout 是扁平的 JSONL：每行一个 {timestamp, ordinal, type, payload, metadata}。
// 与 DSH 最大的三个差异：
//   1. 事件语义藏在 `payload.type` 里（顶层 type 只区分 session_meta / response_item / ...）。
//   2. 工具调用不是 content block，而是独立的 function_call / function_call_output 行，靠 call_id 配对。
//   3. 助手最终答复通常不在 response_item 里，而在 event_msg/task_complete.last_agent_message。
//
// 磁盘上同时存在 `.jsonl` 与归档态 `.jsonl.zst`（约 7 天后压缩），discover 两种都要认。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { decodeFramesFrom } from '../decode.mjs';

/** 单个文档正文上限，与 lib/extract.mjs 保持一致，防止巨型工具输出撑爆索引。 */
const MAX_BODY = 64_000;

/** Codex 家目录：$CODEX_HOME > ~/.codex。 */
export function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/**
 * Codex 会话根目录：`<codexHome>/sessions`（真实布局是按日期分区）。
 *
 * 但导出/样本目录常是**扁平**的（rollout-*.jsonl 直接躺在一层）。与其要求用户
 * 摆成 sessions/YYYY/MM/DD，不如在 `sessions/` 不存在时就地扫 home —— 这不改变
 * 真机行为（真机一定有 sessions/），只是让样本与导出目录可以直接被索引。
 */
export function codexSessionsRoot(home = codexHome()) {
  const nested = join(home, 'sessions');
  try {
    if (statSync(nested).isDirectory()) return nested;
  } catch {
    /* 没有 sessions/ → 退回扁平扫描 */
  }
  return home;
}

/** 只认这两种形态：在线 `.jsonl` 与归档 `.jsonl.zst`。 */
function isSessionFile(name) {
  return name.endsWith('.jsonl') || name.endsWith('.jsonl.zst');
}

/** 递归收集会话文件；目录不存在或不可读时安静返回空数组（detect 需要这个语义）。 */
function collectSessionFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && isSessionFile(entry.name)) {
        try {
          const info = statSync(path);
          out.push({ path, size: info.size, mtime: info.mtimeMs });
        } catch {
          /* race：扫描后被删，跳过 */
        }
      }
    }
  };
  walk(root);
  return out;
}

/** 从 rollout 文件名里抠 UUID 作为 header 缺失时的兜底 id。 */
function sessionHintOf(path) {
  const name = basename(path).replace(/\.jsonl(?:\.zst)?$/, '');
  const match = name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match?.[0] ?? name;
}

/**
 * 解压归档态。
 *
 * Codex 的 `.jsonl.zst` 实测是标准单帧（不像 DSH 是多帧首尾拼接），理论上一次
 * zstdDecompressSync 就够。但单帧解压对「意外多帧」会**静默只解第一帧**，
 * 所以这里优先走 lib/decode.mjs 的 decodeFramesFrom：它对单帧同样成立
 * （扫描到一个 magic，边界就是文件尾），又不会在多帧时截断。只有连帧魔数都
 * 找不到的异常文件才退回单帧解压兜底。
 */
function decodeZst(raw) {
  const { text, frames } = decodeFramesFrom(raw, 0);
  if (frames > 0) return text;
  try {
    return zstdDecompressSync(raw).toString('utf8');
  } catch {
    return '';
  }
}

/** 时间字段统一成 epoch ms；Codex 顶层 timestamp 是 ISO 字符串。无效值给 null。 */
function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 小于 1e12 的数值按秒处理（started_at 等字段是秒）；毫秒时间戳远大于它。
    return Math.round(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 从 session_meta（+ 首个 turn_context）提取归一化 header。 */
function headerOf(events, ref) {
  const meta = events.find((event) => event.data?.type === 'session_meta')?.data ?? null;
  const payload = meta?.payload ?? {};
  const turn = events.find((event) => event.data?.type === 'turn_context')?.data?.payload ?? {};
  const fallbackId = typeof ref === 'string' ? sessionHintOf(ref) : (ref?.sessionHint ?? sessionHintOf(String(ref?.ref ?? '')));
  const parentId =
    [payload.parent_session_id, payload.parentSessionId, payload.parent_id, payload.forked_from_id].find(
      (value) => typeof value === 'string' && value.length > 0,
    ) ?? null;
  return {
    id: String(payload.session_id ?? payload.id ?? payload.thread_id ?? fallbackId ?? ''),
    cwd: payload.cwd ?? turn.cwd ?? null,
    // Codex 没有标题字段；titleOf 从第一条 user 消息合成，这里保持 null 以免两处抢写。
    title: null,
    createdAt: parseTime(payload.timestamp ?? meta?.timestamp),
    // Codex 没有 agent preset 概念（model_provider 是供应商，不是 preset），留空。
    agentPreset: null,
    parentId,
  };
}

/** 拼接 message.content 里的文本块（兼容 content 直接是字符串的旧形态）。 */
function messageText(payload) {
  const content = payload?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (typeof block === 'string' ? block : block?.text))
    .filter((text) => typeof text === 'string')
    .join('\n');
}

/** function_call.arguments 官方是 JSON 字符串；对象形态也容错。 */
function argumentsText(args) {
  if (typeof args === 'string') return args;
  if (args == null) return '';
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/** function_call_output.output 可能是字符串、content block 数组或对象。 */
function outputText(output) {
  const blockText = (block) => (typeof block === 'string' ? block : (typeof block?.text === 'string' ? block.text : ''));
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map(blockText).filter(Boolean).join('\n');
  if (output && typeof output === 'object') {
    if (typeof output.content === 'string') return output.content;
    if (Array.isArray(output.content)) return output.content.map(blockText).filter(Boolean).join('\n');
    if (typeof output.output === 'string') return output.output;
    try {
      return JSON.stringify(output);
    } catch {
      return '';
    }
  }
  return '';
}

const clip = (text) => (text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text);

/**
 * 宿主注入的「假 user 消息」：Codex 会把环境上下文和 AGENTS.md 包装成 role=user 的
 * response_item。它们确实是 user 角色，但不是用户输入；拿来做标题会得到一长串 XML。
 * 真实语料里三条会话的第一条 user 消息全部是这类包装，故标题合成时保守跳过。
 */
const INJECTED_USER_PREFIXES = ['<environment_context>', '# AGENTS.md instructions'];

function isInjectedUserText(text) {
  const trimmed = text.trimStart();
  return INJECTED_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** 是否是压缩标记事件。Codex 把压缩点写成独立的一行，历史内容本身不删。 */
function isCompacted(native) {
  return native?.type === 'compacted' || native?.payload?.type === 'compacted';
}

export const codexSource = {
  id: 'codex',
  label: 'Codex',

  detect() {
    return collectSessionFiles(codexSessionsRoot()).length > 0;
  },

  discover() {
    return collectSessionFiles(codexSessionsRoot()).map((file) => ({
      ref: file.path,
      sessionHint: sessionHintOf(file.path),
      size: file.size,
      mtime: file.mtime,
    }));
  },

  readAll(ref) {
    const path = typeof ref === 'string' ? ref : ref.ref;
    const raw = readFileSync(path);
    const text = path.toLowerCase().endsWith('.zst') ? decodeZst(raw) : raw.toString('utf8');

    // seq 用**行号**（0 起），与 ordinal 无关：坏行/空行也占一个行号，
    // 这样跳过坏行后后续 seq 仍与磁盘行一一对应，便于 show 定位。
    const events = [];
    for (const [index, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      let native;
      try {
        native = JSON.parse(line);
      } catch {
        continue; // 半截/损坏行：跳过，但行号继续递增
      }
      if (native === null || typeof native !== 'object' || Array.isArray(native)) continue;
      events.push({
        seq: index,
        time: parseTime(native.timestamp) ?? 0,
        type: typeof native.type === 'string' ? native.type : 'unknown',
        data: native,
      });
    }
    return { header: headerOf(events, ref), events };
  },

  toDocs(event) {
    const native = event?.data ?? {};
    const payload = native.payload ?? {};
    const out = [];
    const push = (kind, body) => {
      const text = String(body ?? '').trim();
      if (text.length > 0) out.push({ kind, body: clip(text) });
    };

    switch (native.type) {
      case 'response_item':
        switch (payload.type) {
          case 'message': {
            // developer 是宿主注入的开发指令（本机实测一条会话里能占 6~8 条），
            // 与用户真正的问题无关，索引进来只会稀释召回，直接丢弃。
            if (payload.role === 'user' || payload.role === 'assistant') push(payload.role, messageText(payload));
            break;
          }
          case 'function_call':
            push('tool-call', [payload.name, argumentsText(payload.arguments)].filter(Boolean).join('\n'));
            break;
          case 'function_call_output':
            push('tool-result', outputText(payload.output));
            break;
          default:
            // additional_tools 等：工具清单不是对话内容。
            break;
        }
        break;

      case 'event_msg':
        if (payload.type === 'task_complete') {
          // 这是 Codex 真正给用户的最终答复。role=user 的历史里看不到它，
          // 不索引就等于整段回答丢失。
          push('assistant', payload.last_agent_message);
        }
        // task_started / token_count / item_completed / thread_settings_applied 等
        // 都是编排/计量事件，无检索价值，不索引。
        break;

      case 'turn_context': {
        // summary 是回合摘要（常用于 /compact 后的上下文）。实测占位值是字符串
        // "none"，它不是内容，索引进去会变成高频噪声，必须跳过。
        const summary = payload.summary;
        if (typeof summary === 'string' && summary.trim() && summary.trim().toLowerCase() !== 'none') {
          push('other', summary);
        }
        break;
      }

      default:
        // session_meta / world_state / compacted 等：元数据或边界标记，不索引。
        break;
    }
    return out;
  },

  surfaceOf(events) {
    // Codex 用「压缩标记行」表达压缩：标记行**之前**的历史已从模型上下文里移除，
    // 磁盘原文还在，所以标 shadowed；标记行本身代表压缩后的新上下文，仍是 current。
    // 多个 compacted 时取最后一个（最近一次压缩之后的内容才是模型当前可见的）。
    let lastCompactedSeq = null;
    for (const event of events) {
      if (Number.isInteger(event?.seq) && isCompacted(event?.data) && (lastCompactedSeq === null || event.seq > lastCompactedSeq)) {
        lastCompactedSeq = event.seq;
      }
    }
    const result = new Map();
    for (const event of events) {
      if (!Number.isInteger(event?.seq)) continue;
      // 没有 compacted 标记 / 结构不可判时保守全 current：宁可多搜到，不要误标隐藏。
      const surface = lastCompactedSeq !== null && event.seq < lastCompactedSeq ? 'shadowed' : 'current';
      result.set(event.seq, surface);
    }
    return result;
  },

  renderEvent(event) {
    const native = event?.data ?? {};
    const payload = native.payload ?? {};
    switch (native.type) {
      case 'response_item':
        if (payload.type === 'message') {
          // developer 消息不展示正文：show 的窗口里塞满开发指令会淹没真正对话。
          if (payload.role === 'user' || payload.role === 'assistant') {
            return { role: payload.role, text: messageText(payload) };
          }
          return { role: 'event', text: '' };
        }
        if (payload.type === 'function_call') {
          return { role: 'tool', text: [payload.name, argumentsText(payload.arguments)].filter(Boolean).join(' ') };
        }
        if (payload.type === 'function_call_output') {
          return { role: 'tool', text: outputText(payload.output) };
        }
        return { role: 'event', text: '' };
      case 'event_msg':
        if (payload.type === 'task_complete') {
          const last = typeof payload.last_agent_message === 'string' ? payload.last_agent_message : '';
          // 空答复但带 error 时把错误给人看；这是该回合真实结局。
          return { role: 'assistant', text: last || (payload.error?.message ? `[error] ${payload.error.message}` : '') };
        }
        return { role: 'event', text: '' };
      case 'turn_context': {
        const summary = typeof payload.summary === 'string' ? payload.summary : '';
        return { role: 'event', text: summary && summary.toLowerCase() !== 'none' ? summary : '' };
      }
      case 'compacted':
        return { role: 'event', text: 'compacted' };
      default:
        return { role: 'event', text: '' };
    }
  },

  /**
   * 合成标题：Codex 没有标题字段，取**第一条真正的 user 消息**的前 60 字并压空白，
   * 没有就 null。为什么是「真正」：真实语料里第一条 role=user 的消息常是宿主注入的
   * environment_context / AGENTS.md 包装（见上），按字面取会把标题变成 XML 片段。
   * 这是启发式合成标题，不承诺与 Codex UI 的标题一致。
   */
  titleOf(events) {
    for (const event of events) {
      const native = event?.data ?? {};
      const payload = native.payload ?? {};
      if (native.type !== 'response_item' || payload.type !== 'message' || payload.role !== 'user') continue;
      const text = messageText(payload).replace(/\s+/g, ' ').trim();
      if (text && !isInjectedUserText(text)) return text.slice(0, 60);
    }
    return null;
  },
};

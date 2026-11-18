// lib/sources/claude.mjs — Claude Code 适配器
//
// Claude Code 的会话是**明文 JSONL**，一行一条带 `type` 的记录；与 DSH 的差异：
//   · 没有原生 seq。这里用**物理行号（0 起）**当 seq，好处是稳定：
//     追加只会让后续行号变大，导出器插入 `_truncated` 标记或出现坏行时也不重排，
//     增量/去重时同一个事件始终落在同一个 seq 上。
//   · 压缩不在事件上打 replace 标记，而是在压缩发生时写入一条
//     `system` + `subtype:"compact_boundary"` 锚点；原文仍留在文件里。
//   · 明文不压缩，故不实现 readFrom：整文件重读（单会话通常 <1MB）。
//     不实现增量的另一个原因：seq 是行号，若从字节偏移继续读会丢掉行号上下文，
//     而整文件重读既正确又便宜。
//
// 噪声类型（mode / attachment / file-history-* / api-request* / atis-latch /
// last-prompt / queue-operation / cost-state / _truncated）一律不进入索引：
// 它们是生命周期、遥测或重复的请求快照，会把检索结果淹掉。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const EXT = '.jsonl';
/** 单条文档正文上限，防止巨型工具输出撑爆索引（与 lib/extract.mjs 保持一致）。 */
const MAX_BODY = 64_000;

const pathOf = (ref) => (typeof ref === 'string' ? ref : ref?.ref);

/** readdir 的安全版本：目录不存在/无权限时返回空数组，不让 discover 整体失败。 */
function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Claude Code 的 projects 根目录（候选，按顺序去重）。
 *
 * 默认：`~/.claude/projects`。另外本机的会话样本来自 IIR 的**边界内家目录**：
 * `~/.local/state/iir/domains/<domain>/home/.claude/projects`，所以逐个 domain 拼。
 * 用 `os.homedir()` 而不是写死路径，换用户/容器也能用。
 *
 * `CLAUDE_HOME` 是给测试/嵌入方用的覆盖开关。为兼容三种常见传法，依次尝试：
 *   1. 直接就是 projects 根；
 *   2. 传的是家目录（其下有 `projects/`）；
 *   3. 传的是家目录（其下有 `.claude/projects/`）。
 * 不存在的候选只是白扫一次，不会报错。
 */
function projectsRoots() {
  const roots = new Set();
  const env = process.env.CLAUDE_HOME;
  if (env) {
    roots.add(env);
    roots.add(join(env, 'projects'));
    roots.add(join(env, '.claude', 'projects'));
  } else {
    roots.add(join(homedir(), '.claude', 'projects'));
  }

  // IIR 边界：domains/*/home/.claude/projects。逐 domain 拼，避免依赖 glob 库。
  const domains = join(homedir(), '.local', 'state', 'iir', 'domains');
  for (const entry of safeReaddir(domains)) {
    if (entry.isDirectory()) roots.add(join(domains, entry.name, 'home', '.claude', 'projects'));
  }
  return [...roots];
}

/** 递归收集 .jsonl；不跟符号链接，避免环。 */
function collectJsonl(dir, out) {
  for (const entry of safeReaddir(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonl(full, out);
    } else if (entry.isFile() && entry.name.endsWith(EXT)) {
      try {
        const info = statSync(full);
        out.push({
          ref: full,
          // 文件名本身就是 Claude 的 sessionId；header 里还会再确认一次。
          sessionHint: entry.name.slice(0, -EXT.length),
          size: info.size,
          mtime: info.mtimeMs,
        });
      } catch {
        /* 文件在扫描期间消失：忽略 */
      }
    }
  }
}

function discoverAll() {
  const found = [];
  for (const root of projectsRoots()) collectJsonl(root, found);
  // 多个根可能重叠（CLAUDE_HOME 的兼容候选），按路径去重并稳定排序。
  const unique = new Map();
  for (const file of found) unique.set(file.ref, file);
  return [...unique.values()].sort((left, right) => (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0));
}

/** ISO 时间 → epoch ms；缺失/非法一律 0（契约要求 number）。 */
function timeOf(record) {
  const parsed = Date.parse(record?.timestamp ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 递归取文本：tool_result.content 可能是字符串，也可能是 [{type:'text',...}] 块数组。 */
function blocksText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(blocksText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  // 有些记录把块藏在 content 下（例如嵌套的 tool_result / message）。
  if (value.content !== undefined) return blocksText(value.content);
  return '';
}

function toolInputText(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function toolUseText(block) {
  return [block?.name ?? '', toolInputText(block?.input)].filter(Boolean).join('\n');
}

/** 取 content 中指定类型的块（content 不是数组时返回空）。 */
function blocksOfType(content, type) {
  return Array.isArray(content) ? content.filter((block) => block?.type === type) : [];
}

function pushDoc(out, kind, body) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (text.length < 2) return;
  out.push({ kind, body: text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text });
}

/** renderEvent 用：把一条记录的 content 渲染成人类可读文本。 */
function renderContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    switch (block.type) {
      case 'text':
        parts.push(block.text ?? '');
        break;
      case 'thinking':
        parts.push(`[thinking] ${block.thinking ?? block.text ?? ''}`);
        break;
      case 'tool_use':
        parts.push(`[tool_use ${block.name ?? ''}] ${toolInputText(block.input)}`);
        break;
      case 'tool_result':
        parts.push(blocksText(block.content));
        break;
      default:
        // tool_addition / image 等对 show 没有可读正文，跳过。
        break;
    }
  }
  return parts
    .map((part) => String(part).trim())
    .filter(Boolean)
    .join('\n');
}

export const claudeSource = {
  id: 'claude',
  label: 'Claude Code',

  /** 本机是否存在可扫描的 Claude 会话文件。 */
  detect() {
    return discoverAll().length > 0;
  },

  discover() {
    return discoverAll();
  },

  /**
   * 整文件读取。
   * @param {string | { ref: string, sessionHint?: string }} ref
   * @returns {{ header: object, events: Array<{seq:number,time:number,type:string,data:object}>, consumed: number }}
   */
  readAll(ref) {
    const path = pathOf(ref);
    const raw = readFileSync(path); // ENOENT 交给 store 的 try/catch 记 errors[]
    const text = raw.toString('utf8').replace(/^\uFEFF/, ''); // 容忍 BOM
    const lines = text.split('\n');
    const events = [];
    let id = null;
    let cwd = null;
    let createdAt = null;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].replace(/\r$/, '');
      if (!line.trim()) continue;

      let record;
      try {
        record = JSON.parse(line);
      } catch {
        // 坏行/半行（导出器截断、进程写一半）只丢这一行，不能丢整个会话。
        continue;
      }
      if (!record || typeof record !== 'object') continue;

      // _truncated 是导出器插入的说明行，不是会话内容；跳过但**不重排**其它行的 seq。
      if (record.type === '_truncated') continue;

      if (id === null && typeof record.sessionId === 'string' && record.sessionId) id = record.sessionId;
      if (cwd === null && typeof record.cwd === 'string' && record.cwd) cwd = record.cwd;
      if (createdAt === null) {
        const parsed = Date.parse(record.timestamp ?? '');
        if (Number.isFinite(parsed)) createdAt = parsed;
      }

      events.push({
        // seq = 物理行号（0 起）。空行/坏行/_truncated 也占号，保证同一事件稳定。
        seq: index,
        time: timeOf(record),
        type: record.type ?? 'unknown',
        data: record,
      });
    }

    const hint = typeof ref === 'object' && ref ? ref.sessionHint : null;
    return {
      header: {
        id: String(id ?? hint ?? basename(path, EXT)),
        cwd,
        title: null, // 与 dsh 一致：标题由 titleOf 从 ai-title 记录补
        createdAt,
        agentPreset: null, // Claude 没有 DSH 的 preset 概念
        parentId: null, // 会话级没有父 id；分支信息在每条记录的 parentUuid 上
      },
      events,
      consumed: raw.length,
    };
  },

  /** 一个原生记录 → 可检索文档。噪声类型走 default 分支，返回空数组。 */
  toDocs(event) {
    const record = event?.data ?? {};
    const out = [];
    switch (record.type) {
      case 'user': {
        const content = record.message?.content;
        if (typeof content === 'string') {
          pushDoc(out, 'user', content);
        } else if (Array.isArray(content)) {
          pushDoc(out, 'user', blocksOfType(content, 'text').map((block) => block.text ?? '').join('\n'));
          // 真实语料里 tool_result 的宿主是 **user 记录**（Claude 把工具结果作为
          // user 消息回灌），不是 assistant。只按 assistant 抽会漏掉全部工具输出。
          pushDoc(
            out,
            'tool-result',
            blocksOfType(content, 'tool_result').map((block) => blocksText(block.content)).join('\n'),
          );
        }
        break;
      }
      case 'assistant': {
        const content = record.message?.content;
        if (typeof content === 'string') {
          pushDoc(out, 'assistant', content);
          break;
        }
        pushDoc(out, 'assistant', blocksOfType(content, 'text').map((block) => block.text ?? '').join('\n'));
        // thinking 单独降权索引：它占 assistant 体积大头，但常常是检索答案的来源。
        pushDoc(
          out,
          'reasoning',
          blocksOfType(content, 'thinking').map((block) => block.thinking ?? block.text ?? '').join('\n'),
        );
        pushDoc(out, 'tool-call', blocksOfType(content, 'tool_use').map(toolUseText).join('\n'));
        // 理论上 assistant 里不会出现 tool_result；按契约仍兜底处理。
        pushDoc(
          out,
          'tool-result',
          blocksOfType(content, 'tool_result').map((block) => blocksText(block.content)).join('\n'),
        );
        break;
      }
      case 'system': {
        // local_command / away_summary / compact_boundary 等子类型的正文统一降权为 other；
        // turn_duration 之类没有正文，pushDoc 会自然丢弃。
        pushDoc(out, 'other', blocksText(record.content ?? record.message?.content));
        break;
      }
      case 'ai-title': {
        pushDoc(out, 'title', record.aiTitle);
        break;
      }
      default:
        // mode / attachment / file-history-snapshot / file-history-delta / api-request /
        // api-request-blob / api-request-shape / atis-latch / last-prompt / queue-operation /
        // cost-state / permission-mode：生命周期或遥测数据，一律不索引。
        break;
    }
    return out;
  },

  /**
   * 压缩遮蔽判定。
   *
   * 依据：Claude Code 在压缩发生的那一刻写入 `system` + `subtype:"compact_boundary"`
   * 作为锚点；它之后出现的是压缩摘要与续写消息，模型从此只看得见摘要及之后的内容，
   * 而锚点之前的历史虽然仍在磁盘上，已经不在模型上下文里 → shadowed。
   *
   * 有多次压缩时取**最后一个**边界：更早的历史（包括上一次的摘要）也已被再压缩一次，
   * 同样不可见。没有 compact_boundary 时保守地全部标 current（不凭 parentUuid 猜）。
   */
  surfaceOf(events) {
    let boundary = -1;
    for (const event of events) {
      if (event?.data?.type === 'system' && event?.data?.subtype === 'compact_boundary') {
        boundary = Math.max(boundary, event.seq);
      }
    }
    const result = new Map();
    for (const event of events) {
      result.set(event.seq, boundary >= 0 && event.seq < boundary ? 'shadowed' : 'current');
    }
    return result;
  },

  /** L3 show：一条事件 → 人类可读一行。role ∈ user|assistant|tool|system|event。 */
  renderEvent(event) {
    const record = event?.data ?? {};
    const content = record.message?.content;
    switch (record.type) {
      case 'user': {
        const hasToolResult = Array.isArray(content) && content.some((block) => block?.type === 'tool_result');
        const hasUserText =
          typeof content === 'string'
            ? content.trim().length > 0
            : Array.isArray(content) && content.some((block) => block?.type === 'text' && String(block.text ?? '').trim());
        // 纯 tool_result 的 user 记录在语义上是工具输出，展示成 tool 更有用。
        return { role: hasToolResult && !hasUserText ? 'tool' : 'user', text: renderContent(content) };
      }
      case 'assistant':
        return { role: 'assistant', text: renderContent(content) };
      case 'system':
        return { role: 'system', text: blocksText(record.content ?? record.message?.content).trim() };
      case 'ai-title':
        return { role: 'event', text: String(record.aiTitle ?? '').trim() };
      default:
        return { role: 'event', text: '' };
    }
  },

  /** 会话标题：取最后一条 ai-title（与 dsh 的「最后一条 title 事件」语义一致）。 */
  titleOf(events) {
    let title = null;
    for (const event of events) {
      const value = event?.data?.type === 'ai-title' ? event?.data?.aiTitle : null;
      if (typeof value === 'string' && value.trim()) title = value.trim();
    }
    return title;
  },
};

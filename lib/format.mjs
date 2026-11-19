// lib/format.mjs — 把各模块的结构化结果渲染成 CLI 文本或 JSON。
//
// 约定：
//   · json=true 一律 `JSON.stringify(result)`，单行、原样字段，绝不夹带解释性文本。
//   · 人类可读输出「一行一条」，方便 grep / 管道；作用域与总数放首行。
//   · maxChars 预算：按行累加，超预算就停，末尾追加 `… (+N more)`；
//     最后一行也放不下时退化为纯省略号，保证输出长度永远 <= maxChars。
//
// 作用域的补充说明：query/audit 的返回结构里没有 scope（见 CONTRACT §4.2/§4.3），
// 所以 render* 额外支持 opts.scope（或 result.scope / result.scopeLabel）传入；
// 都没有时按「all sessions」展示。CLI 应把真实 scope 传进来，避免首行误导。
import { describeScope } from './paths.mjs';

/** 压缩空白：标题/片段里的换行会把「一行一条」破坏掉。 */
const flat = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** 数字兜底，避免 undefined 出现在输出里。 */
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** 作用域描述：接受 Scope 对象、字符串或带 label 的对象。 */
function scopeText(scope) {
  if (!scope) return 'all sessions';
  if (typeof scope === 'string') return scope;
  if (typeof scope.label === 'string') return scope.label;
  try {
    return describeScope(scope);
  } catch {
    return String(scope);
  }
}

/**
 * 按字符数截断并补省略号。max <= 0 表示不截断（返回值原样）。
 * 省略号本身计入 max，因此返回值长度不会超过 max。
 */
export function clip(text, max) {
  const source = String(text ?? '');
  if (!Number.isFinite(max) || max <= 0 || source.length <= max) return source;
  if (max === 1) return '…';
  return `${source.slice(0, max - 1)}…`;
}

/**
 * 行预算：能放几行放几行，放不下就停并追加 `… (+N more)`。
 * 为什么不是先拼后 slice：slice 会在行中间截断，且没法告诉用户丢了多少行。
 */
function fitLines(lines, maxChars, quiet = false) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return lines.join('\n');
  const prefix = [0];
  for (const line of lines) prefix.push(prefix.at(-1) + line.length);
  const contentLen = (k) => (k === 0 ? 0 : prefix[k] + (k - 1)); // k 行正文 + k-1 个换行
  const suffix = (k) => (k >= lines.length ? '' : `\n… (+${lines.length - k} more)`);

  let k = 0;
  while (k < lines.length && contentLen(k + 1) + suffix(k + 1).length <= maxChars) k += 1;
  if (k === lines.length) return lines.join('\n');
  // quiet：不把「还有 N 条」写进 stdout。grep 形状下这条提示会破坏管道
  // （`| cut -d: -f1` 会把它当成一个"会话名"），所以改由 hitNotes() 走 stderr 汇报。
  if (quiet) {
    // 至少留一行，但一行都放不下时仍要守住预算（宁可给省略号也不超）。
    if (k === 0) return clip(lines[0] ?? '', maxChars);
    return lines.slice(0, k).join('\n');
  }
  if (k === 0) return clip(`… (+${lines.length} more)`, maxChars);
  return lines.slice(0, k).join('\n') + suffix(k);
}

/**
 * 相邻命中的上下文窗口会大量重叠（同一条事件出现在两条命中的窗口里）。
 * 按整行去重，顺序不变 —— 保序很重要，否则时间线会乱。
 */
function dedupeLines(lines) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/** renderHits 的最终入口：JSON 原样，文本走行预算。 */
function finish(result, lines, { json, maxChars }) {
  if (json) return JSON.stringify(result);
  return fitLines(lines, maxChars);
}

/** 结果自带的 scope（部分调用方会挂在返回值上）。 */
function pickScope(result) {
  return result?.scope ?? result?.scopeLabel;
}

/**
 * 搜索结果 —— **grep 形状**：`<session>:<seq>:<text>`，一行一条命中。
 *
 * 为什么默认是这个形状（而不是带 scope 首行与 [kind/surface] 装饰）：
 *   · 可直接管道组合：`cfind foo | cut -d: -f1 | sort -u` 就是「哪些会话提到了 foo」；
 *   · 没有会破坏管道的元信息行，`| head -5` 拿到的就是 5 条命中；
 *   · 与 grep 的 `file:line:content` 同构，人和 agent 都不用学新格式。
 *
 * 工具自己的话术（命中总数、模糊放宽、折叠了几条）走 `hitNotes()` → stderr，
 * 与 grep 把警告写 stderr 的做法一致：stdout 永远是纯结果。
 *
 * @param {{verbose?: boolean}} opts verbose=true 时退回旧的富格式（带 kind/surface/标题）
 */
export function renderHits(result, { json = false, maxChars = 1500, scope, verbose = false, terse } = {}) {
  if (json) return JSON.stringify(result);

  const hits = result?.hits ?? [];
  if (hits.length === 0) return '(no hits)';

  // 带 context 时行数会膨胀到「命中数 × 窗口大小」。按行数均分预算，
  // 与 renderShow 的处理方式一致（否则预算全被第一条吃掉）。
  const windowLines = hits.reduce((sum, hit) => sum + (Array.isArray(hit.events) ? hit.events.length : 1), 0);
  const perEventBudget =
    Number.isFinite(maxChars) && maxChars > 0 && windowLines > 0
      ? Math.max(120, Math.floor(maxChars / windowLines) - 24)
      : 0;

  const lines = [];
  // 默认就是 grep 形状。`terse` 只是一个**已无作用的兼容参数**：
  // 早期版本要显式 --terse 才精简，现在默认精简，旧调用方传什么都不影响。
  // 别写成 `terse === false` 就退回富格式 —— CLI 永远显式传 false，
  // 那样等于默认永远富格式（踩过）。
  void terse;
  if (verbose) {
    // 富格式：保留 kind/surface/标题，便于人快速判断"这条是什么"。
    lines.push(`scope: ${scopeText(scope ?? pickScope(result))} · total ${num(result?.total ?? hits.length)}`);
    for (const hit of hits) {
      lines.push(`[${hit.kind}/${hit.surface}] ${hit.short} #${hit.seq} ${flat(hit.title)} :: ${flat(hit.snippet)}`);
    }
  } else {
    for (const hit of hits) {
      if (!Array.isArray(hit.events) || hit.events.length === 0) {
        lines.push(`${hit.short}:${hit.seq}:${flat(hit.snippet)}`);
        continue;
      }
      // grep -C 形状：命中行 `:`、上下文行 `-`。与 `show` 完全一致，
      // 所以 `| grep ':'` 在两种入口下行为相同。
      for (const event of hit.events) {
        // 每条事件单独限长：一条 reasoning 可以有几万字符，不限的话
        // 它一个人就吃光整个预算，真正的命中行反而被挤掉。
        const body = perEventBudget > 0 ? clip(flat(event.text), perEventBudget) : flat(event.text);
        lines.push(`${hit.short}${event.isTarget ? ':' : '-'}${event.seq}${event.isTarget ? ':' : '-'}${body}`);
      }
      // 相邻命中的窗口会重叠：同一行不重复输出，但**不吞掉**新的命中行。
      // 用 Set 按渲染后的整行去重最省事，也天然保留首次出现的位置。
    }
  }
  return fitLines(dedupeLines(lines), maxChars, !verbose);
}

/**
 * 「工具想跟你说的话」——与结果分开，便于 CLI 走 stderr。
 *
 * 这些是**确实发生了**的调整，必须让调用方知道（否则会以为结果是精确且完整的）；
 * 但它们不该污染 stdout 的管道。grep 把警告写 stderr，这里同理。
 */
export function hitNotes(result, { shown } = {}) {
  const notes = [];
  const total = num(result?.total ?? result?.hits?.length ?? 0);
  // shown 由调用方传入**实际渲染出的行数**：预算截断发生在 renderHits 内部，
  // 用 hits.length 会虚报（明明只显示了 8 条却说 20 条）。
  const actuallyShown = Number.isInteger(shown) ? shown : result?.hits?.length ?? 0;
  if (total > actuallyShown) notes.push(`${total} total, ${actuallyShown} shown`);
  if (num(result?.collapsed) > 0) notes.push(`${num(result.collapsed)} near-duplicate hidden`);
  const fuzzy = result?.fuzzy;
  if (fuzzy && fuzzy.what) {
    notes.push(fuzzy.what === 'spelling' ? `spelling→${fuzzy.applied}` : `${fuzzy.what}→${fuzzy.applied ?? 'loosened'}`);
  }
  return notes;
}

/** 单事件上下文：目标行用 ▶ 标记。 */
/**
 * 把 `text` 裁到 `budget` 以内，并**以 needle 的首次出现为中心**。
 *
 * 为什么需要它：一条事件可以有几万字符（reasoning 块、抓取下来的文档、巨型工具输出）。
 * 命中可能在第 60313 个字符处，而 `show` 默认从第 0 个字符开始截 —— 那就完全看不到命中。
 * 光有 `seq` 只能回答「哪个事件」，回答不了「事件里的哪一处」。这个函数补的就是后半句。
 *
 * @returns {{text: string, offset: number} | null} 找不到 needle 时返回 null（调用方退回默认截断）
 */
function centerOn(text, needle, budget) {
  const source = String(text ?? '');
  const term = String(needle ?? '');
  if (!term || source.length === 0) return null;
  const at = source.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0) return null;

  const flatSource = flat(source);
  // 在压平后的文本里重新定位：居中要用「渲染出来的那份文本」，否则偏移对不上。
  const flatAt = flatSource.toLowerCase().indexOf(term.toLowerCase());
  const pos = flatAt >= 0 ? flatAt : at;
  if (budget <= 0 || flatSource.length <= budget) return { text: flatSource, offset: pos };

  // 两侧各留一半；靠边时把多余预算让给另一侧，尽量多给上下文。
  const half = Math.floor(budget / 2);
  let start = Math.max(0, pos - half);
  let end = Math.min(flatSource.length, start + budget);
  start = Math.max(0, end - budget);

  const slice = flatSource.slice(start, end);
  return {
    text: `${start > 0 ? '…' : ''}${slice}${end < flatSource.length ? '…' : ''}`,
    offset: pos,
  };
}

export function renderShow(result, { json = false, maxChars = 0, scope, verbose = false, find } = {}) {
  const events = result?.events ?? [];
  const target = result?.target ?? {};
  const short = result?.short ?? '';
  const showScope =
    scope ?? pickScope(result) ?? (result?.sessionId ? { mode: 'session', id: result.sessionId } : undefined);

  // grep 的 context 惯例：命中行用 `:` 分隔，上下文行用 `-` 分隔
  // （`grep -A2 -B2` 就是这么区分"这是匹配"和"这是周围"的）。
  // 这样 `| cut -d: -f2` 只会拿到真正的命中行，上下文行天然被排除。
  const header = verbose
    ? `scope: ${scopeText(showScope)} · ${short} ${flat(result?.title)} · ${flat(result?.cwd)} · ${events.length} events · target #${target.seq ?? '?'}`
    : null;
  const budgetBase = header?.length ?? 0;
  // 逐事件截断：一条工具输出动辄几千字符，若整条当一行塞进预算，
  // 结果就是「只剩标题 + (+N more)」——窗口等于白给。这里按事件数均分预算。
  // maxChars <= 0（--full）表示完全不截断。
  const perEvent =
    maxChars > 0 && events.length > 0
      ? Math.max(120, Math.floor(Math.max(0, maxChars - budgetBase) / events.length) - 60)
      : 0;

  const lines = header === null ? [] : [header];
  for (const ev of events) {
    let body;
    if (find) {
      // 有 --find 时以命中处为中心，而不是从头开始截。
      const centered = centerOn(ev.text, find, perEvent > 0 ? perEvent : 0);
      body = centered === null ? (perEvent > 0 ? clip(flat(ev.text), perEvent) : flat(ev.text)) : centered.text;
    } else {
      body = perEvent > 0 ? clip(flat(ev.text), perEvent) : flat(ev.text);
    }
    if (verbose) {
      lines.push(`${ev.isTarget ? '▶' : ' '} #${ev.seq} [${ev.type}/${ev.surface}] ${ev.role} :: ${body}`);
      continue;
    }
    lines.push(`${short}${ev.isTarget ? ':' : '-'}${ev.seq}${ev.isTarget ? ':' : '-'}${body}`);
  }
  if (events.length === 0) lines.push('(no events)');
  return finish(result, lines, { json, maxChars });
}

/**
 * `show` 的提示：告知「某条事件太大，默认视角看不到全部」，
 * 并给出下一步该怎么做。走 stderr，不污染 stdout。
 */
export function showNotes(result, { find } = {}) {
  const notes = [];
  // ⓪ 原始文件已被删除，正文是从索引重建的。必须说清楚：
  //    这是蒸馏副本（索引时略去的 request/header 等不会在这里出现），
  //    不标会让人以为读到的是逐字节原文。
  if (result?.archived === true) {
    notes.push('原始会话文件已被删除（工具清理旧会话）；以下内容从索引重建，是蒸馏副本');
  }
  if (find) return notes;
  // ① 「索引内容比显示内容多」——reasoning 块是主要来源。
  //    这时 search 命中的词可能根本不在看到的正文里，不提醒就会被误判成命中错误。
  const hidden = Number(result?.target?.hidden ?? 0);
  if (hidden > 500) {
    notes.push(`#${result?.target?.seq} has ${hidden} more chars not shown (reasoning); add --find <term> to jump to the match`);
  }
  // ② 事件本身就很大（还没算被省略的部分）。
  if (notes.length === 0) {
    for (const ev of result?.events ?? []) {
      const length = String(ev?.text ?? '').length;
      if (length > 2000) {
        notes.push(`#${ev.seq} is ${length} chars; add --find <term> to jump to the match`);
        break;
      }
    }
  }
  return notes;
}

/** 会话大纲：每个会话一段，回合与检查点各一行。 */
export function renderOutline(result, { json = false, maxChars = 3000, scope, verbose = false, terse } = {}) {
  const sessions = result?.sessions ?? [];
  // 默认不给 scope 首行：每个会话自己就带 short id 与标题，那行是纯装饰。
  // 与 renderHits 同一原则 —— 默认输出里不该有「工具在自述」的行。
  void terse;
  const lines = verbose ? [`scope: ${scopeText(scope ?? pickScope(result))} · outline: ${sessions.length} sessions`] : [];
  for (const session of sessions) {
    lines.push(
      `▸ ${session.short} ${flat(session.title)} · ${flat(session.cwd)} · ${num(session.eventCount)} events · ${session.turns?.length ?? 0} turns · ${session.checkpoints?.length ?? 0} checkpoints`,
    );
    for (const turn of session.turns ?? []) {
      lines.push(`  T${turn.turn} #${turn.seq} > ${flat(turn.prompt)}`);
      if (turn.response) lines.push(`    < ${flat(turn.response)}`);
    }
    for (const cp of session.checkpoints ?? []) {
      const range = `${cp.range?.start ?? '?'}-${cp.range?.end ?? '?'}`;
      lines.push(`  ⧉ #${cp.seq} range ${range} (${num(cp.shadowedTokenCount)} tok) ${flat(cp.preview)}`);
    }
  }
  if (sessions.length === 0) lines.push('(no sessions)');
  return finish(result, lines, { json, maxChars });
}

/**
 * 审计结果。
 * findings.redacted 已经过 audit.redact()，这里只管排版，不要二次加工凭据。
 */
export function renderAudit(result, { json = false, scope } = {}) {
  if (json) return JSON.stringify(result);
  const findings = result?.findings ?? [];
  const scanned = result?.scanned ?? {};
  const lines = [
    `audit ${scopeText(scope ?? pickScope(result))} · scanned ${num(scanned.sessions)} sessions / ${num(scanned.docs)} docs · ${findings.length} findings`,
  ];
  for (const f of findings) {
    lines.push(`[${f.patternId}] ${f.short} #${f.seq} ${f.kind} :: ${f.redacted}`);
  }
  if (findings.length === 0) lines.push('(no findings)');
  return lines.join('\n');
}

/** 索引统计。 */
export function renderStats(stats, { json = false } = {}) {
  if (json) return JSON.stringify(stats);
  const archived = Number(stats?.archived ?? 0);
  const freeBytes = Number(stats?.freeBytes ?? 0);
  const oldestDays = stats?.archivedOldestDays;

  const notes = [];
  // 归档：报**多久了**而不只是"有几条" —— 寿命是要能看见的。
  if (archived > 0) {
    const age = Number.isFinite(oldestDays) ? `，最早 ${oldestDays} 天前` : '';
    notes.push(`${archived} archived${age}（原始文件已删除，index --gc 回收）`);
  }
  // 空闲页：只有超过阈值才提，否则是一句永远在的噪音。
  if (stats?.vacuumDue === true && freeBytes > 0) {
    notes.push(`空闲页 ${(freeBytes / 1e6).toFixed(1)}MB（index --gc 回收）`);
  }
  if (stats?.optimizeDue === true && Number(stats?.docs ?? 0) > 0) {
    notes.push(`待整理：${stats?.optimizeReason ?? '到期'}（index）`);
  }

  return (
    `index: ${num(stats?.sessions)} sessions · ${num(stats?.events)} events · ` +
    `${num(stats?.docs)} docs · ${num(stats?.dbBytes)} bytes` +
    (notes.length > 0 ? ` · ${notes.join(' · ')}` : '')
  );
}

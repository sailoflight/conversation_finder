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
function fitLines(lines, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return lines.join('\n');
  const prefix = [0];
  for (const line of lines) prefix.push(prefix.at(-1) + line.length);
  const contentLen = (k) => (k === 0 ? 0 : prefix[k] + (k - 1)); // k 行正文 + k-1 个换行
  const suffix = (k) => (k >= lines.length ? '' : `\n… (+${lines.length - k} more)`);

  let k = 0;
  while (k < lines.length && contentLen(k + 1) + suffix(k + 1).length <= maxChars) k += 1;
  if (k === lines.length) return lines.join('\n');
  if (k === 0) return clip(`… (+${lines.length} more)`, maxChars);
  return lines.slice(0, k).join('\n') + suffix(k);
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
 * 搜索结果。
 *
 * 常规：`[kind/surface] <short> #<seq> <title> :: <snippet>`
 * 精简（terse）：给 agent 用，省的是**纯排版**而不是信息：
 *   · 不输出 `scope: … · total …` 首行（调用方本来就知道自己搜什么）；
 *   · 前缀 `[kind/surface] short #seq` → `short#seq kind`；
 *   · surface 只在 shadowed 时标注（current 是常态，标注等于噪音）；
 *   · 同一会话的标题只出现一次（标题是会话级属性，重复同一行纯属浪费）。
 * 实测省约 14% 字符，且没有任何一条可用于定位的信息被删掉。
 */
export function renderHits(result, { json = false, maxChars = 1500, scope, terse = false } = {}) {
  const hits = result?.hits ?? [];
  const total = result?.total ?? hits.length;
  const lines = [];
  if (!terse) lines.push(`scope: ${scopeText(scope ?? pickScope(result))} · total ${num(total)}`);

  let lastSession = null;
  for (const hit of hits) {
    const title = flat(hit.title);
    if (!terse) {
      lines.push(`[${hit.kind}/${hit.surface}] ${hit.short} #${hit.seq} ${title} :: ${flat(hit.snippet)}`);
      continue;
    }
    const marks = hit.surface === 'shadowed' ? `${hit.kind}/shadowed` : hit.kind;
    const shownTitle = hit.short === lastSession ? '' : title;
    lastSession = hit.short;
    const head = `${hit.short}#${hit.seq} ${marks}`;
    lines.push(shownTitle ? `${head} ${shownTitle} :: ${flat(hit.snippet)}` : `${head} :: ${flat(hit.snippet)}`);
  }
  if (hits.length === 0) lines.push('(no hits)');
  const text = finish(result, lines, { json, maxChars });
  // 去重/模糊等「结果被动过」的事实必须让调用方看见，否则用户会以为没有别的命中。
  return terse ? annotate(text, result, json) : text;
}

/**
 * 在输出末尾追加一行提示（terse 专属）。只描述**确实发生了**的调整，
 * 不做事后猜测：没发生就什么都不加。
 */
function annotate(text, result, json) {
  if (json) return text;
  const notes = [];
  if (num(result?.collapsed) > 0) notes.push(`${num(result.collapsed)} near-duplicate hidden`);
  const near = result?.fuzzy;
  if (near && near.what) {
    notes.push(near.what === 'spelling' ? `spelling→${near.applied}` : `${near.what}→${near.applied ?? 'loosened'}`);
  }
  if (notes.length === 0) return text;
  return `${text}\n(${notes.join(' · ')})`;
}

/** 单事件上下文：目标行用 ▶ 标记。 */
export function renderShow(result, { json = false, maxChars = 0, scope } = {}) {
  const events = result?.events ?? [];
  const target = result?.target ?? {};
  // show 天然是单会话作用域：调用方没传 scope 时用 sessionId 反推，别默认成 all sessions。
  const showScope = scope ?? pickScope(result) ?? (result?.sessionId ? { mode: 'session', id: result.sessionId } : undefined);
  const header = `scope: ${scopeText(showScope)} · ${result?.short ?? ''} ${flat(result?.title)} · ${flat(result?.cwd)} · ${events.length} events · target #${target.seq ?? '?'}`;
  const lines = [header];
  // 逐事件截断：一条工具输出动辄几千字符，若整条当一行塞进预算，
  // 结果就是「只剩标题 + (+N more)」——窗口等于白给。这里按事件数均分预算。
  // maxChars <= 0（--full）表示完全不截断。
  const perEvent =
    maxChars > 0 && events.length > 0
      ? Math.max(120, Math.floor(Math.max(0, maxChars - header.length) / events.length) - 60)
      : 0;
  for (const ev of events) {
    const marker = ev.isTarget ? '▶' : ' ';
    const body = perEvent > 0 ? clip(flat(ev.text), perEvent) : flat(ev.text);
    lines.push(`${marker} #${ev.seq} [${ev.type}/${ev.surface}] ${ev.role} :: ${body}`);
  }
  if (events.length === 0) lines.push('(no events)');
  return finish(result, lines, { json, maxChars });
}

/** 会话大纲：每个会话一段，回合与检查点各一行。 */
export function renderOutline(result, { json = false, maxChars = 3000, scope, terse = false } = {}) {
  const sessions = result?.sessions ?? [];
  // terse 下略去首行：会话自己就带 short id 与标题，scope 行对 agent 是冗余。
  const lines = terse ? [] : [`scope: ${scopeText(scope ?? pickScope(result))} · outline: ${sessions.length} sessions`];
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
  return (
    `index: ${num(stats?.sessions)} sessions · ${num(stats?.events)} events · ` +
    `${num(stats?.docs)} docs · ${num(stats?.dbBytes)} bytes`
  );
}

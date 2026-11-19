// lib/audit.mjs — 隐私审计：在索引库的 docs 表上扫凭据，只回显「脱敏后的形状」。
//
// 安全边界（硬规则，改代码前先读）：
//   · 完整凭据只存在于本模块的局部变量里，绝不写进返回值。
//   · findings 里唯一与原文有关的字段是 redacted，而它必须经过 redact()。
//   · label / patternId 都是模式自带的静态文案，不拼接命中内容；也不要给这里
//     加「把 m[0] 放进错误信息」之类的调试输出。
//
// 关于 RegExp 的 lastIndex 陷阱：
//   导出的 DEFAULT_PATTERNS 一律**不带 g**，是「无状态模板」；audit() 每次调用
//   都会用 new RegExp(source, flags + 'g') 复制一份自己的实例。matchAll 只接受
//   带 g 的正则，且它在内部还会克隆（不推进我们实例的 lastIndex）。这样任何调用
//   方都不会因为共享同一个 lastIndex 而漏检——不要图省事直接复用导出对象。
import { shortId } from './paths.mjs';

/** 把疑似凭据变成可展示的形状：前 4 字符 + '…' + 后 2 字符 + (len=N)。 */
export function redact(secret) {
  // 用码点切，避免把 emoji/代理对切坏；len 同理按码点计。
  const chars = [...String(secret ?? '')];
  // 长度 < 7 时前后缀会暴露过多（甚至整串），直接全遮；len 也不回显。
  if (chars.length < 7) return '***';
  return `${chars.slice(0, 4).join('')}…${chars.slice(-2).join('')}(len=${chars.length})`;
}

/**
 * 默认模式集。
 * 约定：命中内容放命名捕获组 `secret`；没有该组时退回整段匹配 m[0]。
 * 注意 flags 里**不要**带 g（原因见文件头）；`i` 可用于关键字不区分大小写。
 */
export const DEFAULT_PATTERNS = [
  {
    id: 'sk-key',
    label: 'OpenAI/Anthropic 风格 sk- 密钥',
    re: /(?<secret>\bsk-[A-Za-z0-9][A-Za-z0-9_-]{7,})/,
  },
  {
    id: 'aws-access-key',
    label: 'AWS Access Key ID (AKIA)',
    re: /(?<secret>\bAKIA[0-9A-Z]{16}\b)/,
  },
  {
    id: 'github-token',
    label: 'GitHub Token (ghp_)',
    re: /(?<secret>\bghp_[A-Za-z0-9]{20,}\b)/,
  },
  {
    id: 'google-api-key',
    label: 'Google API Key (AIza)',
    re: /(?<secret>\bAIza[0-9A-Za-z_-]{20,}\b)/,
  },
  {
    id: 'slack-token',
    label: 'Slack Token (xox*)',
    re: /(?<secret>\bxox[baprs]-[A-Za-z0-9-]{10,})/,
  },
  {
    id: 'pem-private-key',
    label: 'PEM 私钥块',
    // 整块捕获：块内每一行都是敏感材料，不能只遮 BEGIN 行。
    re: /(?<secret>-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----)/,
  },
  {
    id: 'bearer-token',
    label: 'Authorization Bearer Token',
    // 只捕获 token 本体，前缀 Bearer 不进 secret（否则脱敏的前 4 位会浪费在关键词上）。
    re: /(?:Bearer\s+)(?<secret>[A-Za-z0-9._~+/=-]{8,})/i,
  },
  {
    id: 'secret-assignment',
    label: '密钥/口令赋值',
    // 值截到空白、引号、逗号、分号、尖括号为止；捕获组只含值本身。
    re: /(?:password|passwd|pwd|api[_-]?key|secret|token)\s*[:=]\s*["'`]?(?<secret>[^\s"'`,;<>]{4,})/i,
  },
  {
    id: 'url-credentials',
    label: 'URL 内嵌凭据 (scheme://user:pass@host)',
    // 捕获 userinfo（user:pass），scheme 前缀用非捕获组排除在 secret 之外。
    re: /(?:[a-z][a-z0-9+.-]*:\/\/)(?<secret>[^/\s:@]+:[^/\s@]+)@/i,
  },
  {
    id: 'high-entropy',
    label: '高熵字符串（疑似凭据）',
    // 启发式：32+ 个 base64-ish 字符，且同时含大写/小写/数字，排除普通单词与纯小写哈希。
    re: /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]{32,})(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[0-9])(?<secret>[A-Za-z0-9+/_-]{32,}={0,2})(?![A-Za-z0-9+/_-])/,
  },
  {
    id: 'high-entropy-hex',
    label: '长十六进制串（疑似凭据/摘要）',
    // 纯小写 hex 过不了 mixed-case 启发式，但 48+ 位仍可能是泄露的 token/secret。
    re: /(?<secret>\b[0-9a-f]{48,}\b)/,
  },
];

/**
 * 当前 scope 下的 docs 源与 WHERE 条件（作用域语义与 query 一致，但不 import query）。
 *
 * 注意 `exclude` / `sources`：这两个收窄条件必须在这里也实现一遍。审计是**唯一**
 * 会把命中正文回显（脱敏后）的模块，漏掉排除条件意味着 `audit --exclude-self`
 * 静默地把自己的会话也扫了 —— 而「检查别人的会话有没有泄密」正是它最常见的用法。
 * 收窄条件统一追加在最后：先框定范围，再做减法，顺序反了会写出自相矛盾的条件。
 */
function scopeWhere(scope) {
  const clauses = [];
  const params = [];
  let from = 'docs d';

  if (scope?.mode === 'session') {
    clauses.push('d.session_id = ?');
    params.push(String(scope.id));
  } else if (scope?.mode === 'project') {
    // cwd 在 sessions 表里，docs 只存 session_id，必须 join。
    from = 'docs d JOIN sessions s ON s.id = d.session_id';
    clauses.push('s.cwd = ?');
    params.push(String(scope.cwd));
  }

  const sources = Array.isArray(scope?.sources) && scope.sources.length > 0 ? scope.sources : null;
  if (sources) {
    clauses.push(`d.source IN (${sources.map(() => '?').join(',')})`);
    params.push(...sources);
  }

  const excluded = Array.isArray(scope?.exclude)
    ? scope.exclude.filter((id) => typeof id === 'string' && id.length > 0)
    : [];
  if (excluded.length > 0) {
    clauses.push(`d.session_id NOT IN (${excluded.map(() => '?').join(',')})`);
    params.push(...excluded);
  }

  return { from, where: clauses, params };
}

/**
 * 启发式模式（精度低，默认不扫）：
 *   它们不看上下文，只算熵 —— 结果里混着路径片段、sha256（64 字符）、md5（32 字符）、
 *   UUID 和随机生成的一次性 id。实测本机 299 条启发式命中里，
 *   长度 64 的有 66 条、长度 32 的有 13 条，基本都是摘要。
 *
 * 默认不扫（`deep: false`）。这不是"严重度"问题 —— 一个 sha256 摘要和一把 AKIA
 * 密钥的危险程度完全不同，但它们在这里只是「同一条熵规则的两类结果」。
 * 所以本模块**不按危险程度分级**，只按**模式精度**分成「默认扫」与「深扫」。
 */
const LOW_PRECISION = new Set(['high-entropy', 'high-entropy-hex']);

/**
 * 对索引库做隐私审计。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{patterns?: typeof DEFAULT_PATTERNS, scope?: object, limit?: number,
 *          includeReasoning?: boolean, deep?: boolean}} opts
 */
export function audit(
  db,
  {
    patterns = DEFAULT_PATTERNS,
    scope = { mode: 'all' },
    limit = 50,
    includeReasoning = true,
    deep = false,
  } = {},
) {
  const { from, where, params } = scopeWhere(scope);
  // includeReasoning 的过滤要在统计之前拼好：scanned.docs 是「实际扫过」的行数，
  // 否则调用方会看到「统计了 N 篇、却只检查了 N-1 篇」的漂移。
  const filters = [...where];
  const filterParams = [...params];
  if (!includeReasoning) filters.push("d.kind <> 'reasoning'");
  const clause = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';

  // scanned 统计先做，即使 limit=0 也要给出真实扫描面。
  const docCount = db.prepare(`SELECT COUNT(*) AS n FROM ${from}${clause}`).get(...filterParams)?.n ?? 0;
  const sessionCount =
    db.prepare(`SELECT COUNT(DISTINCT d.session_id) AS n FROM ${from}${clause}`).get(...filterParams)?.n ?? 0;
  const scanned = { sessions: Number(sessionCount), docs: Number(docCount) };
  if (limit <= 0) return { scanned, findings: [] };

  // 模式模板可能被外部改过；这里统一复制成带 g 的一次性实例（见文件头）。
  // `deep: true` = 连熵启发式一起扫（误报多，但不会漏掉没有固定前缀的凭据）。
  const active = deep ? patterns : patterns.filter((p) => !LOW_PRECISION.has(p.id));
  const compiled = active.map((p) => ({
    id: p.id,
    label: p.label,
    heuristic: LOW_PRECISION.has(p.id),
    re: new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`),
  }));

  const q = db.prepare(
    `SELECT d.session_id AS sessionId, d.seq AS seq, d.kind AS kind, d.time AS time, d.body AS body
       FROM ${from}${clause}
      ORDER BY d.session_id, d.seq, d.rowid`,
  );

  const findings = [];
  const seen = new Set();
  outer: for (const row of q.iterate(...filterParams)) {
    const body = row.body ?? '';
    for (const p of compiled) {
      for (const m of body.matchAll(p.re)) {
        const secret = m.groups?.secret ?? m[0];
        if (!secret) continue;
        // 同一文档、同一模式只报一次；跨模式命中同一串仍各自成条（模式语义不同）。
        const key = `${row.sessionId}\u0000${row.seq}\u0000${row.kind}\u0000${p.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (findings.length >= limit) break outer;
        findings.push({
          patternId: p.id,
          label: p.label,
          sessionId: row.sessionId,
          short: shortId(row.sessionId),
          seq: row.seq,
          kind: row.kind,
          time: row.time ?? 0,
          redacted: redact(secret),
          length: [...String(secret)].length,
        });
      }
    }
  }
  return { scanned, findings };
}

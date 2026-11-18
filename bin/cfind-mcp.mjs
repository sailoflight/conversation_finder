#!/usr/bin/env node
// bin/cfind-mcp.mjs — 把 cfind 暴露成 MCP server（stdio，零依赖，手写 JSON-RPC 2.0）
//
// 为什么要手写：本项目零第三方依赖，MCP 的 stdio 传输就是「换行分隔的 JSON-RPC」，
// 握手与 tools/list、tools/call 三个方法足以跑通，不需要引入 @modelcontextprotocol/sdk。
//
// ── 协议版本策略（关键，别乱改）────────────────────────────────────────────
// DSH 用的 MCP client 是「先探测、再回落」的设计：
//   1. 起一个**临时兄弟进程**，先发 `server/discover` 探测 2026-07-28 现代协议；
//   2. 探测结果解析不了 → 判定 legacy → 回头对本进程做传统 `initialize` 握手。
// 现代协议额外要求 `resultType`、`_meta` 信封等约定，实现成本高且易随版本漂移；
// 所以我们**主动只讲 legacy**：对 `server/discover` 回 -32601（Method not found），
// 让 client 干净地回落到 2025 系握手。已在真实 SDK 上验证可连通。
//
// ── 「默认搜自己」怎么实现 ────────────────────────────────────────────────
// dsh-mcp-client 起子进程用的是 scrubbedParentEnv()，会把**所有 DSH_* 变量丢掉**
// （源码判据：`!key.toUpperCase().startsWith("DSH_")`），MCP 调用链上也没有会话上下文。
// 所以拿不到 DSH_SESSION_ID。改用 **mtime 启发式**：调用方就是此刻正在被追加日志的会话，
// 它一定是 mtime 最新的那个。这条对 DSH / Claude Code / Codex / OpenCode 通用，
// 比某个产品专用的环境变量更有移植价值。
//
// ── 铁律 ─────────────────────────────────────────────────────────────────
// stdout 只准输出 JSON-RPC 消息；任何日志/诊断都走 stderr。否则 client 会解析失败。
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../lib/schema.mjs';
import { indexPath, describeScope, selfSessionId } from '../lib/paths.mjs';
import { syncIndex } from '../lib/store.mjs';
import { search, show } from '../lib/query.mjs';
import { outline } from '../lib/outline.mjs';
import { audit, DEFAULT_PATTERNS } from '../lib/audit.mjs';
import { renderHits, renderShow, renderOutline, renderAudit } from '../lib/format.mjs';
import { readSessionFile } from '../lib/decode.mjs';

const NAME = 'cfind';
const VERSION = '0.1.0';
/** 我们支持的 legacy 协议版本（与官方 SDK 的 SUPPORTED_PROTOCOL_VERSIONS 对齐）。 */
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_LEGACY = '2025-06-18';

const log = (...args) => process.stderr.write(`[cfind-mcp] ${args.join(' ')}\n`);

// ── 索引生命周期：进程常驻，只在首次打开；每次查询前做增量同步 ──────────────
let db;
function getDb() {
  if (db === undefined) {
    try {
      db = openDb(indexPath());
    } catch (error) {
      // 索引不可写（沙箱）→ 退回内存库，零磁盘写副作用。
      log(`disk index unavailable (${error.message}); falling back to in-memory`);
      db = openDb(':memory:');
    }
  }
  return db;
}

function sync(only) {
  const target = getDb();
  try {
    return syncIndex(target, only === undefined ? {} : { only });
  } catch (error) {
    log(`sync failed: ${error.message}`);
    return { errors: [error.message] };
  }
}

// ── 作用域：显式参数 > 自己 ───────────────────────────────────────────────
//
// 「自己是谁」统一由 lib/paths.mjs 的 selfSessionId() 回答（先看 $DSH_SESSION_ID，
// 再退回 files 表 mtime 最新）。不在这里另写一份 —— 两处实现迟早会不一致。
// 注意：MCP 下 DSH 会 scrub 掉所有非 DSH_ 前缀的环境变量，所以实际走的是 mtime 推断。

/** 把工具参数解析成 Scope；都不给就是「搜自己」。 */
function scopeOf(args, target) {
  const self = selfSessionId(target);
  const base = (() => {
    if (args.all === true) return { mode: 'all' };
    if (typeof args.session === 'string' && args.session.trim()) {
      return { mode: 'session', id: args.session.trim() };
    }
    if (typeof args.project === 'string' && args.project.trim()) {
      return { mode: 'project', cwd: args.project.trim() };
    }
    if (self) return { mode: 'session', id: self };
    return { mode: 'project', cwd: process.cwd() };
  })();

  const scoped = { ...base };
  if (typeof args.source === 'string' && args.source.trim()) {
    scoped.sources = args.source.split(',').map((id) => id.trim()).filter(Boolean);
  }
  // 排除自己只在「范围不是我自己」时有意义；显式 --session 时也允许排，
  // 但要注意排空了就是 0 命中 —— 那是诚实的结果，不该偷偷换范围。
  if (args.excludeSelf === true && self !== undefined) scoped.exclude = [self];
  return scoped;
}

/** 短 id 前缀 → 完整会话 id。真实 id 可能带 `session-` 前缀，展示与匹配都要剥。 */
function resolveSessionArg(target, arg) {
  const needle = String(arg).replace(/^session-/, '');
  const rows = target.prepare('SELECT id FROM sessions').all();
  const exact = rows.find((row) => row.id === arg);
  if (exact) return exact.id;
  const matches = rows.filter((row) => row.id.replace(/^session-/, '').startsWith(needle));
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) throw new Error(`会话 id 前缀 "${arg}" 不唯一，请写长一些`);
  throw new Error(`找不到会话: ${arg}`);
}

// ── 工具定义 ─────────────────────────────────────────────────────────────
// inputSchema 只用 DSH 强制支持的 JSON Schema 子集：
// type / properties / required / additionalProperties / items / enum / const / description。
const SCOPE_PROPS = {
  session: { type: 'string', description: '限定单个会话 id（支持短前缀）。省略时默认「最近活跃的会话」，即调用方自己。' },
  project: { type: 'string', description: '限定某个 cwd 的项目下所有会话。' },
  all: { type: 'boolean', description: '搜全部会话（跨项目）。' },
  excludeSelf: {
    type: 'boolean',
    description:
      '排除调用方自己那个会话。用 --all 找「别的会话里的知识」时建议开启：' +
      '否则你会搜到自己刚才敲的每条命令（本工具索引的正是会话历史，包含工具调用）。',
  },
};

const TOOLS = [
  {
    name: 'search',
    description:
      '在 agent 会话历史里检索内容，返回命中列表与片段（L2 选择层，不给全文）。' +
      '压缩过的历史同样可搜：DSH 的 /compact 只让模型看不见旧消息，原文仍在磁盘上。' +
      '中文按 bigram 处理，2 字词（如「幂等」）也能命中。默认只搜调用方自己的会话。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜的词或短语，中文/英文都行。' },
        ...SCOPE_PROPS,
        limit: { type: 'number', description: '命中条数上限，默认 10。' },
        surface: {
          type: 'string',
          description:
            'all（默认）| current（模型仍看得见）| shadowed（已被压缩掉、你看不见）。\n' +
            '**想不起早先的指令/决定时用 shadowed**：压缩后你看得见的内容本来就在上下文里，' +
            '真正想不起来的恰好是被压掉的那一半。',
          enum: ['all', 'current', 'shadowed'],
        },
        includeReasoning: { type: 'boolean', description: '是否包含模型的 reasoning（默认 true，权重最低）。' },
        source: { type: 'string', description: '限定来源，逗号分隔（dsh,claude,codex,opencode）。默认全部。' },
        fuzzy: { type: 'boolean', description: '默认 true：精确命中为 0 时依次尝试前缀/拼写纠错/OR 放宽。' },
        dedupe: { type: 'boolean', description: '默认 true：折叠同会话内近似重复的命中（折叠数会显示出来）。' },
      },
      required: ['query'],
    },
  },
  {
    name: 'show',
    description:
      '取某条事件的原文窗口（L3 全文层）。search 的 hit 里带 seq，用它来取全文。' +
      '已被压缩（shadowed）的内容同样能取回。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '会话 id（支持短前缀）。' },
        seq: { type: 'number', description: '事件序号，来自 search 结果里的 #seq。' },
        before: { type: 'number', description: '目标之前取几条，默认 3。' },
        after: { type: 'number', description: '目标之后取几条，默认 3。' },
      },
      required: ['session', 'seq'],
    },
  },
  {
    name: 'outline',
    description:
      '会话摘要（L1 摘要层）：标题 + 每个回合一行（首问 + 末答）+ 压缩检查点。\n' +
      '**什么时候别用**：已经知道要搜什么词就直接用 search —— 实测 search（约 190 token）' +
      '比 outline --all（约 1050 token）便宜 5 倍，且在多数问题上直接给答案。' +
      '只有当你完全不知道该翻哪个会话、需要先看目录时，才先用 outline。',
    inputSchema: {
      type: 'object',
      properties: {
        ...SCOPE_PROPS,
        maxChars: { type: 'number', description: '输出字符预算，默认 3000。' },
      },
    },
  },
  {
    name: 'audit',
    description:
      '隐私/涉密扫描：在会话历史里找 API key、私钥、Bearer token、赋值型口令等，输出**强制脱敏**（前 4 + 后 2 + 长度）。' +
      '用于检查「会话记录里有没有泄露凭据」。',
    inputSchema: {
      type: 'object',
      properties: {
        ...SCOPE_PROPS,
        minSeverity: {
          type: 'string',
          description: 'high（默认，固定前缀类高精度）| medium | low | all（含熵启发式，误报高）。',
          enum: ['high', 'medium', 'low', 'all'],
        },
        limit: { type: 'number', description: 'findings 上限，默认 50。' },
      },
    },
  },
  {
    name: 'stats',
    description: '索引统计：会话数、事件数、可检索文档数、索引体积。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'index',
    description: '手动触发索引增量更新（正常情况下每次查询前会自动做，不需要主动调用）。',
    inputSchema: { type: 'object', properties: {} },
  },
];

const text = (value) => ({ content: [{ type: 'text', text: value }] });

// ── 工具实现 ─────────────────────────────────────────────────────────────
function callTool(name, args) {
  const target = getDb();
  const only = typeof args.source === 'string' ? args.source.split(',').map((id) => id.trim()).filter(Boolean) : undefined;
  const synced = sync(only);

  switch (name) {
    case 'search': {
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('query 不能为空');
      const scope = scopeOf(args, target);
      const result = search(target, {
        query,
        scope,
        limit: Number.isFinite(Number(args.limit)) ? Number(args.limit) : 10,
        includeReasoning: args.includeReasoning !== false,
        surface: typeof args.surface === 'string' ? args.surface : 'all',
        fuzzy: args.fuzzy !== false,
        dedupe: args.dedupe !== false,
      });
      const body = renderHits(result, {
        json: false,
        maxChars: 2000,
        scope: describeScope(scope),
        terse: args.terse === true,
      });
      // 无命中要明确说出来，否则 agent 容易反复重试同一个词。
      const suffix =
        result.total === 0
          ? '\n\n（没有命中，模糊放宽也没救回来。可换更短的关键词，或缩小 scope 到某个会话。）'
          : '';
      return text(body + suffix);
    }
    case 'show': {
      const sessionId = resolveSessionArg(target, args.session);
      const shown = show(target, {
        sessionId,
        seq: Number(args.seq),
        before: Number.isFinite(Number(args.before)) ? Number(args.before) : 3,
        after: Number.isFinite(Number(args.after)) ? Number(args.after) : 3,
      });
      return text(renderShow(shown, { json: false, maxChars: 4000 }));
    }
    case 'outline': {
      const scope = scopeOf(args, target);
      const result = outline(target, { scope });
      return text(
        renderOutline(result, {
          json: false,
          maxChars: Number.isFinite(Number(args.maxChars)) ? Number(args.maxChars) : 3000,
          scope: describeScope(scope),
          terse: args.terse === true,
        }),
      );
    }
    case 'audit': {
      const scope = scopeOf(args, target);
      const result = audit(target, {
        patterns: DEFAULT_PATTERNS,
        scope,
        limit: Number.isFinite(Number(args.limit)) ? Number(args.limit) : 50,
        minSeverity: typeof args.minSeverity === 'string' ? args.minSeverity : 'high',
      });
      return text(renderAudit(result, { json: false, scope: describeScope(scope) }));
    }
    case 'stats': {
      const sessions = target.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.n ?? 0;
      const events = target.prepare('SELECT COUNT(*) AS n FROM events').get()?.n ?? 0;
      const docs = target.prepare('SELECT COUNT(*) AS n FROM docs').get()?.n ?? 0;
      return text(`index: ${sessions} sessions · ${events} events · ${docs} docs`);
    }
    case 'index': {
      return text(
        `synced: ${synced.sessions ?? 0} sessions · ${synced.events ?? 0} events · ` +
          `${synced.docs ?? 0} docs（appended ${synced.filesAppended ?? 0} / rebuilt ${synced.filesRebuilt ?? 0} / ` +
          `skipped ${synced.filesSkipped ?? 0}）`,
      );
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

// ── JSON-RPC over stdio ──────────────────────────────────────────────────
function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const RPC_ERROR = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 };

function handle(message) {
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    if (message?.id !== undefined) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: RPC_ERROR.INVALID_REQUEST, message: 'invalid request' } });
    }
    return;
  }
  const { id, method, params } = message;
  const isNotification = id === undefined;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      // 只回 legacy 版本：回 2026-07-28 会让 client 以为进了现代协议，
      // 进而要求 resultType / _meta 信封，那套我们没实现。
      const version = LEGACY_VERSIONS.includes(requested) ? requested : DEFAULT_LEGACY;
      write({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: NAME, version: VERSION },
          instructions:
            'cfind 检索 agent 会话历史。search 找内容（默认只搜当前你正在用的会话）、show 取原文窗口、' +
            'outline 看会话摘要、audit 做隐私扫描。压缩过的历史仍可搜到。',
        },
      });
      return;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // 通知无需响应
    case 'server/discover':
      // 明确拒绝现代协议探测 → client 回落到 legacy initialize（见文件头）。
      if (!isNotification) {
        write({ jsonrpc: '2.0', id, error: { code: RPC_ERROR.METHOD_NOT_FOUND, message: 'server/discover is not supported; this server speaks legacy MCP' } });
      }
      return;
    case 'ping':
      if (!isNotification) write({ jsonrpc: '2.0', id, result: {} });
      return;
    case 'tools/list':
      if (!isNotification) write({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    case 'tools/call': {
      if (isNotification) return;
      try {
        const name = params?.name;
        const args = params?.arguments ?? {};
        write({ jsonrpc: '2.0', id, result: callTool(name, args) });
      } catch (error) {
        // 工具级失败按 MCP 约定用 isError 表达，让模型看到可读原因，而不是把连接搞断。
        write({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `cfind error: ${error?.message ?? error}` }], isError: true },
        });
      }
      return;
    }
    default:
      if (!isNotification) {
        write({ jsonrpc: '2.0', id, error: { code: RPC_ERROR.METHOD_NOT_FOUND, message: `unknown method: ${method}` } });
      }
  }
}

function main() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.trim()) {
        try {
          handle(JSON.parse(line));
        } catch (error) {
          write({ jsonrpc: '2.0', id: null, error: { code: RPC_ERROR.PARSE, message: `parse error: ${error.message}` } });
        }
      }
      newline = buffer.indexOf('\n');
    }
  });
  process.stdin.on('end', () => {
    try {
      db?.close?.();
    } catch {
      /* 关闭失败无关紧要 */
    }
    process.exit(0);
  });
  log(`ready (pid ${process.pid}), index=${indexPath()}`);
}

main();

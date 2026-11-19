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
import { indexPath, describeScope, selfSessionId, defaultSurface } from '../lib/paths.mjs';
import { syncIndex } from '../lib/store.mjs';
import { search } from '../lib/query.mjs';
import { audit, DEFAULT_PATTERNS } from '../lib/audit.mjs';
import { renderHits, renderAudit, hitNotes } from '../lib/format.mjs';
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
//
// 设计准则：**尽量少的工具、尽量少的参数、尽量少的提示词**。
// grep 只有一个命令，靠 flag 覆盖 `-r`(递归) `-C`(上下文) `-l`(只列文件)。
// 这里照抄同一套：一个 search 工具 + 同样语义的 flag，再加一个 audit。
//
// 消掉的工具（不是功能消失，是换成了 grep 的 flag）：
//   show    → `context: N`      （grep -C）
//   outline → `list: true`      （grep -l）
//   stats   → 不再需要（统计对一个 pattern 的检索没用）
//   index   → 每次调用前本来就会自动增量同步，暴露出来只是让人误以为要手动维护
//
// 消掉的参数：session / project / includeReasoning / source / fuzzy / dedupe /
//   excludeSelf / terse / maxChars / seq / before / after / find。
//   find 尤其值得说：它原本只是替 show 补上「查询词」，折进 search 后
//   查询词本来就在手上，窗口自动居中 —— 参数因此凭空消失。
//
// inputSchema 只用 DSH 强制支持的 JSON Schema 子集：
// type / properties / required / additionalProperties / items / enum / const / description。
const TOOLS = [
  {
    name: 'search',
    description: '搜 agent 会话历史。输出 `session:seq:text`，一行一条命中。压缩掉的历史也能搜。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜的词，中文/英文都行。' },
        all: { type: 'boolean', description: '搜全部会话。默认只搜当前会话。' },
        context: { type: 'number', description: '每条命中前后各取 N 条事件（grep -C）。不给只看命中行。' },
        exclude: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['tool', 'reasoning', 'assistant', 'user', 'title', 'system', 'compaction'],
          },
          description: '排除区域。tool = 工具调用+输出（实测占六成以上，噪音大时排掉）；reasoning = 思考过程。',
        },
        regex: {
          type: 'boolean',
          description: '把 query 当正则（grep 同款）。默认走关键词索引，支持中文与模糊纠错；正则走全表扫描，较慢且有超时保护。',
        },
        limit: { type: 'number', description: '最多几条命中，默认 10。' },
        list: { type: 'boolean', description: '只列提及它的会话（grep -l），不返回命中正文。' },
      },
      required: ['query'],
    },
  },
  {
    name: 'audit',
    description: '扫描会话里的凭据泄露（API key、私钥、Bearer、口令赋值）。输出**强制脱敏**。',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: '扫全部会话。默认只扫当前会话。' },
        deep: {
          type: 'boolean',
          description: '深扫：连"高熵字符串"启发式一起查，能抓到没有固定前缀的凭据，但会把 sha256/随机 id 也算进来（实测多出 3 倍噪音）。',
        },
      },
    },
  },
];

const text = (value) => ({ content: [{ type: 'text', text: value }] });

// ── 工具实现 ─────────────────────────────────────────────────────────────
function callTool(name, args) {
  const target = getDb();
  // 每次调用前自动增量同步：index 工具因此不需要存在。
  sync();

  switch (name) {
    case 'search': {
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('query 不能为空');
      const scope = scopeOf(args, target);
      const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 10;

      // list = grep -l：只回答「哪些会话提到了它」。
      // 内部多取一些再按会话去重，否则 limit=10 会让人以为世界上只有 10 条。
      if (args.list === true) {
        const scan = search(target, { query, scope, limit: Math.min(500, Math.max(limit, 100) * 5), context: 0 });
        const seen = new Map();
        for (const hit of scan.hits) if (!seen.has(hit.sessionId)) seen.set(hit.sessionId, hit);
        if (seen.size === 0) return text('(no hits)');
        const lines = [...seen.values()].map((hit) => (hit.title ? `${hit.short}:${hit.title}` : hit.short));
        return text(`${lines.join('\n')}\n(${seen.size} sessions of ${scan.total} hits)`);
      }

      const context = Number.isFinite(Number(args.context)) ? Number(args.context) : 0;
      // surface 由作用域自适应，不需要参数：
      //   自己的会话 → shadowed（压缩前；压缩后我本来就看得到，再取就是重复）
      //   别人的会话 → all     （它们的压缩前历史我从没见过）
      const surface = defaultSurface(scope, selfSessionId(target));
      const result = search(target, {
        query,
        scope,
        limit,
        context,
        surface,
        exclude: args.exclude,
        regex: args.regex === true,
      });
      const body = renderHits(result, { json: false, maxChars: 2000, scope: describeScope(scope) });
      const notes = hitNotes(result);
      // 无命中时 renderHits 已经给了 `(no hits)`，不要再补一遍；
      // 只在「有命中、但被放宽/折叠过」时追加说明。
      const suffix = result.total === 0 ? '' : notes.length > 0 ? `\n(${notes.join(' · ')})` : '';
      return text(body + suffix);
    }
    case 'audit': {
      const scope = scopeOf(args, target);
      const result = audit(target, {
        patterns: DEFAULT_PATTERNS,
        scope,
        limit: 50,
        deep: args.deep === true,
      });
      return text(renderAudit(result, { json: false, scope: describeScope(scope) }));
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

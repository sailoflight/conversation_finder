#!/usr/bin/env node
// bin/cfind.mjs — DSH 会话检索器 CLI
//
// 设计取舍（见 docs/prestudy.md）：
//   · 默认作用域优先级：--session > $DSH_SESSION_ID > --project/cwd > --all
//     于是 agent 直接 `cfind 幂等键` 就默认搜"自己"，不需要知道会话 id。
//   · 索引不可写时（agent 常跑在 workspace-write 沙箱）自动降级为
//     `:memory:` 现建现查 —— 复用同一套 store/schema，零磁盘写副作用。
//   · 退出码与 grep 对齐：0 有命中 / 1 无命中 / 2 用法或索引错误 / 3 语料不可读。
import { existsSync } from 'node:fs';
import { openDb } from '../lib/schema.mjs';
import { indexPath, sessionsRoot, listSessionFiles, resolveScope, describeScope, shortId } from '../lib/paths.mjs';
import { syncIndex, stats } from '../lib/store.mjs';
import { search, show, resolveSessionIds } from '../lib/query.mjs';
import { outline } from '../lib/outline.mjs';
import { audit, DEFAULT_PATTERNS } from '../lib/audit.mjs';
import { renderHits, renderShow, renderOutline, renderAudit, renderStats } from '../lib/format.mjs';

const HELP = `cfind — 在 agent 会话记录里快速找内容（DSH / Claude Code / Codex / OpenCode）

用法:
  cfind <query> [选项]              搜内容（默认搜当前会话）
                                    拼错/只记词头也能搜到（自动纠错，会标注）
  cfind show <session> <seq>        取某条事件的原文窗口
  cfind outline                     会话摘要：标题 + 每回合一行 + 压缩检查点
                                    （知道要搜什么就直接搜，outline 贵约 5 倍）
  cfind audit                       隐私/涉密扫描（输出脱敏）
  cfind index                       只更新索引
  cfind stats                       索引统计

作用域（优先级从上到下，全部自动）:
  --session <id>    指定会话
  (无)              默认 $DSH_SESSION_ID —— agent 无需传参即搜自己
  --project [dir]   当前目录（或 dir）对应的项目
  --all             全部会话

选项:
  --json              机器可读输出（稳定字段）
  --max-chars <n>     输出字符预算（默认 1500）
  --limit <n>         命中条数（默认 10）
  --no-reasoning      排除 reasoning 文档（默认包含，权重最低）
  --surface <s>       all | current | shadowed（默认 all）
  --source <list>     只扫这些来源，逗号分隔（dsh,claude,codex,opencode；默认全部已检测到的）
  --before <n>        show: 目标前 n 条（默认 3）
  --after <n>         show: 目标后 n 条（默认 3）
  --full              show: 不截断
  --terse             精简输出（省排版：无 scope 首行、短前缀、标题不重复）。给 agent 用
  --no-dedupe         关闭近似重复折叠（默认开启）
  --no-fuzzy          关闭模糊级联（前缀/纠错/放宽），只做精确匹配
  --min-severity <s>  audit: high|medium|low|all（默认 high；低精度熵启发式需显式 all）
  --fail-on-findings  audit: 有命中则退出码 1（适合做 CI 门禁）
  --no-index          不读写磁盘索引，用内存索引现建现查
  -h, --help          显示帮助

退出码: 0 命中 / 1 无命中 / 2 用法错误 / 3 语料不可读
`;

const BOOL_FLAGS = new Set(['json', 'all', 'no-reasoning', 'full', 'fail-on-findings', 'no-index', 'help', 'terse', 'no-dedupe', 'no-fuzzy']);
const VALUE_FLAGS = new Set(['session', 'project', 'max-chars', 'limit', 'surface', 'before', 'after', 'pattern', 'min-severity', 'source']);

/** 解析 argv → { positional, flags }。未知选项直接报错，避免静默忽略。 */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h') {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOL_FLAGS.has(name)) {
      flags[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        // --project 可以不带值（用 cwd）
        if (name === 'project') flags.project = true;
        else throw new UsageError(`--${name} 需要一个值`);
      } else {
        flags[name] = value;
        i += 1;
      }
    } else {
      throw new UsageError(`未知选项: ${arg}`);
    }
  }
  return { positional, flags };
}

export class UsageError extends Error {}

/**
 * 打开索引库。磁盘索引不可写/未启用时退回内存库（现建现查）。
 * @returns {{db: object, mode: 'disk'|'memory'}}
 */
export function openIndex({ noIndex = false } = {}) {
  const path = indexPath();
  if (!noIndex && process.env.CFIND_NO_INDEX !== '1') {
    try {
      return { db: openDb(path), mode: 'disk' };
    } catch {
      /* 目录不可写或版本不符 → 降级 */
    }
  }
  return { db: openDb(':memory:'), mode: 'memory' };
}

/** 同步索引；磁盘模式是增量的，内存模式等于全量现建。 */
export function sync(db, { root, only } = {}) {
  // root 与 only 必须**同时**透传：早先写成 `root === undefined ? { only } : { root }`，
  // 而 main 里 root 恒等于 sessionsRoot()，于是 only 永远被丢掉 —— `--source` 只影响
  // 检索范围、不影响索引范围，看起来"正常"却静默多索引了别的源。
  return syncIndex(db, root === undefined ? { only } : { root, only });
}

/** 支持短 id 前缀（真实 id 可能带 `session-` 前缀，展示时会剥掉，所以匹配也要剥）。 */
function resolveSessionArg(db, arg) {
  const needle = String(arg).replace(/^session-/, '');
  const rows = db.prepare('SELECT id FROM sessions').all();
  const exact = rows.find((row) => row.id === arg);
  if (exact) return exact.id;
  const matches = rows.filter((row) => row.id.replace(/^session-/, '').startsWith(needle));
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) throw new UsageError(`会话 id 前缀 "${arg}" 不唯一，请写长一些`);
  throw new UsageError(`找不到会话: ${arg}`);
}

const num = (value, fallback) => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || positional.length === 0 && Object.keys(flags).length === 0) {
    process.stdout.write(HELP);
    return 0;
  }

  const root = sessionsRoot();
  if (!existsSync(root)) {
    process.stderr.write(`cfind: 找不到会话目录 ${root}\n`);
    return 3;
  }

  const [command, ...rest] = positional;
  const isCommand = ['show', 'outline', 'audit', 'index', 'stats', 'help'].includes(command);
  const scope = resolveScope({
    session: flags.session,
    project: flags.project,
    all: flags.all,
    cwd: process.cwd(),
  });
  // --source 有两个作用：收窄索引扫描，以及收窄检索范围。两者都要，否则
  // 「--source claude」会退回全库统计（曾经踩过）。
  const only = typeof flags.source === 'string' ? flags.source.split(',').map((id) => id.trim()).filter(Boolean) : undefined;
  const scopeWithSources = only === undefined ? scope : { ...scope, sources: only };

  const { db, mode } = openIndex({ noIndex: flags['no-index'] });
  try {
    // 查询前顺手增量更新：磁盘模式只解新帧（毫秒级），内存模式=全量现建。
    const synced = sync(db, { root, only });
    const json = flags.json === true;
    const maxChars = num(flags['max-chars'], 1500);
    const terse = flags.terse === true;

    if (isCommand && command === 'help') {
      process.stdout.write(HELP);
      return 0;
    }

    if (isCommand && command === 'index') {
      process.stdout.write(
        json
          ? JSON.stringify(synced)
          : `indexed: ${synced.sessions} sessions, ${synced.events} events, ${synced.docs} docs ` +
              `(${synced.filesAppended} appended, ${synced.filesRebuilt} rebuilt, ${synced.filesSkipped} skipped) ` +
              `in ${Math.round(synced.ms)}ms [${mode}]\n`,
      );
      return 0;
    }

    if (isCommand && command === 'stats') {
      process.stdout.write(renderStats({ ...stats(db), mode }, { json }));
      return 0;
    }

    if (isCommand && command === 'audit') {
      const patterns = flags.pattern
        ? [{ id: 'custom', label: `pattern:${flags.pattern}`, re: new RegExp(flags.pattern, 'i') }]
        : DEFAULT_PATTERNS;
      const result = audit(db, {
        patterns,
        scope: scopeWithSources,
        limit: num(flags.limit, 50),
        includeReasoning: flags['no-reasoning'] !== true,
        minSeverity: flags['min-severity'] ?? 'high',
      });
      process.stdout.write(renderAudit(result, { json, scope: describeScope(scope) }));
      if (flags['fail-on-findings'] === true && result.findings.length > 0) return 1;
      return 0;
    }

    if (isCommand && command === 'outline') {
      const result = outline(db, { scope: scopeWithSources });
      process.stdout.write(
        renderOutline(result, { json, maxChars: num(flags['max-chars'], 3000), scope: describeScope(scope), terse }),
      );
      return 0;
    }

    if (isCommand && command === 'show') {
      const [sessionArg, seqArg] = rest;
      if (!sessionArg || seqArg === undefined) throw new UsageError('用法: cfind show <session> <seq>');
      const sessionId = resolveSessionArg(db, sessionArg);
      const shown = show(db, {
        sessionId,
        seq: Number(seqArg),
        before: num(flags.before, 3),
        after: num(flags.after, 3),
      });
      // show 的会话来自位置参数，与 resolveScope 得到的 scope 无关：交给 renderShow 按 sessionId 反推。
      process.stdout.write(renderShow(shown, { json, maxChars: flags.full ? 0 : maxChars, terse }));
      return 0;
    }

    // 默认：检索。命令词不是保留字时，整个 positional 都算 query。
    const query = (isCommand ? rest : positional).join(' ').trim();
    if (!query) throw new UsageError('用法: cfind <query> [选项]');
    const result = search(db, {
      query,
      scope: scopeWithSources,
      dedupe: flags['no-dedupe'] !== true,
      fuzzy: flags['no-fuzzy'] !== true,
      limit: num(flags.limit, 10),
      includeReasoning: flags['no-reasoning'] !== true,
      surface: flags.surface ?? 'all',
    });
    const count = result.total;
    process.stdout.write(
      renderHits({ ...result, query }, { json, maxChars, scope: describeScope(scope), terse }),
    );
    return count > 0 ? 0 : 1;
  } finally {
    db.close?.();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`cfind: ${error.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`cfind: ${error?.stack ?? error}\n`);
      process.exitCode = 2;
    }
  }
}

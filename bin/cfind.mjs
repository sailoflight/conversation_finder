#!/usr/bin/env node
// bin/cfind.mjs — DSH 会话检索器 CLI
//
// 设计取舍（见 docs/prestudy.md）：
//   · 默认作用域优先级：--session > $DSH_SESSION_ID > --project/cwd > --all
//     于是 agent 直接 `cfind 幂等键` 就默认搜"自己"，不需要知道会话 id。
//   · 索引不可写时（agent 常跑在 workspace-write 沙箱）自动降级为
//     `:memory:` 现建现查 —— 复用同一套 store/schema，零磁盘写副作用。
//   · 退出码与 grep 对齐：0 有命中 / 1 无命中 / 2 用法或索引错误 / 3 语料不可读。
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { openDb } from '../lib/schema.mjs';
import { indexPath, sessionsRoot, listSessionFiles, resolveScope, describeScope, shortId, selfSessionId, defaultSurface } from '../lib/paths.mjs';
import { purgeArchived, syncIndex, stats } from '../lib/store.mjs';
import { search, show, resolveSessionIds, resolveExclude } from '../lib/query.mjs';
import { outline } from '../lib/outline.mjs';
import { audit, DEFAULT_PATTERNS } from '../lib/audit.mjs';
import { renderHits, renderShow, renderOutline, renderAudit, renderStats, hitNotes, showNotes } from '../lib/format.mjs';

const HELP = `cfind — 在 agent 会话记录里快速找内容（DSH / Claude Code / Codex / OpenCode）
用法（grep 形状：输出 <session>:<seq>:<text>，一行一条，可直接管道）:
  cfind <pattern>                    搜当前会话（agent 默认搜自己，无需传参）
  cfind '<正则>' --regex             表达式检索（grep 同款）
  cfind <pattern> --all              搜全部会话（相当于 grep -r）
  cfind <pattern> | cut -d: -f1      哪些会话提到了它
  cfind show <session> <seq>         取某条命中的原文上下文（相当于 -A/-B）
  cfind outline                      会话目录（相当于 grep -l：有哪些会话、聊了什么）
  cfind audit                        隐私/涉密扫描（输出强制脱敏）
  cfind index / stats                索引维护 / 统计

示例:
  cfind 幂等键                         在当前会话里找
  cfind settlement_id --all --limit 20
  cfind 幂等键 --all | sort | uniq -c    统计哪个会话提得最多（-f1 先 cut）

作用域（优先级从上到下，全部自动）:
  --session <id>    指定会话
  (无)              默认 $DSH_SESSION_ID —— agent 无需传参即搜自己
  --project [dir]   当前目录（或 dir）对应的项目
  --all             全部会话

选项:
  --limit <n>         最多几条命中（默认 10）
  --max-chars <n>     输出字符预算（默认 1500）
  --json              机器可读输出（完整字段，含 title/kind/surface/score）
  --verbose           富格式：加 scope 首行、kind/surface、会话标题（人读更舒服）
  --surface <s>       shadowed（压缩前）| current（压缩后）| all
                      默认自适应：自己的会话搜 shadowed，别的会话搜 all
  --recall            等价 --surface shadowed：只看「已被压缩掉、看不见」的那半
  --visible           等价 --surface current：只看「压缩之后、看得见」的那半
  --exclude <regions> 排除指定区域，逗号分隔或重复给：tool（调用+输出）、
                      reasoning、title、system、assistant、user、compaction
  --regex             把 pattern 当正则（grep 同款，如 '幂等键.*(冲突|重复)'）。
                      默认是关键词检索：走 FTS 索引，支持中文 bigram 与模糊纠错。
                      正则走全表扫描（约 100ms），且有超时保护（防回溯爆炸）。
  --context <n>       每条命中前后各取 N 条事件（grep -C）
  --list              只列提及它的会话（grep -l），不返回命中正文
  --exclude-self      排除当前正在写入的会话（即你自己）
  --source <list>     只扫这些来源，逗号分隔（dsh,claude,codex,opencode）
  --no-reasoning      排除 reasoning 文档（默认包含，权重最低）
  --fuzzy             放宽召回：前缀 + 拼写纠错 + CJK 容错 + 省略一个 + 同义替换。
                      默认**关闭**，默认行为是严格的字面匹配（每条命中都含你输入的词）。
                      打开后结果可能与输入不逐字相同，stderr 会报告每一步放宽。
  --no-dedupe         关闭近似重复折叠（默认开启）
  --find <term>       show: 以该词为中心显示（大事件里命中可能在几万字符处，
                      不指定就只看到开头）
  --before/--after <n>  show: 目标前后各取几条（默认 3）
  --full              show: 不截断
  --deep              audit: 连熵启发式一起扫（能抓无固定前缀的凭据，但 sha256/随机 id 会误报）
  --gc                index: 清掉已归档（原始文件已被工具删除）的内容。
                      默认是归档不删除 —— 工具清理掉的旧会话往往正是你想找回的。
  --fail-on-findings  audit: 有命中则退出码 1（CI 门禁）
  --no-index          不读写磁盘索引，用内存索引现建现查
  --terse             已无作用（默认就是精简格式），保留仅为兼容旧脚本
  -h, --help          显示帮助

stdout 只放结果；命中总数、模糊放宽、去重折叠这些"工具自己的话术"走 stderr，
所以 \`| head\`、\`| wc -l\`、\`| cut -d: -f1\` 都不会被它们打乱。

退出码: 0 命中 / 1 无命中 / 2 用法错误 / 3 语料不可读
`;

const BOOL_FLAGS = new Set(['json', 'all', 'no-reasoning', 'full', 'fail-on-findings', 'no-index', 'help', 'terse', 'verbose', 'no-dedupe', 'no-fuzzy', 'exclude-self', 'recall', 'visible', 'list', 'regex', 'deep', 'gc', 'fuzzy']);
const VALUE_FLAGS = new Set(['session', 'project', 'max-chars', 'limit', 'surface', 'context', 'before', 'after', 'pattern', 'source', 'find', 'exclude']);

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
        // --exclude 可重复，也支持逗号串：`--exclude tool --exclude reasoning`
        // 与 `--exclude tool,reasoning` 等价。grep 的 -e 也是可重复的。
        if (name === 'exclude') flags.exclude = [...(flags.exclude ?? []), value];
        else flags[name] = value;
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

  // 会话目录不存在不一定是错误：agent 可能换了 home，或者工具把旧会话清空了。
  // 这时只要索引里还有数据，命令就应当照常工作（search 走索引、show 有归档退路）。
  // 只有「目录没有 且 索引也没有」才是真的没得可查。
  const root = sessionsRoot();
  if (!existsSync(root)) {
    const probe = new DatabaseSync(indexPath(), { readOnly: true });
    const known = (() => {
      try {
        return probe.prepare('SELECT COUNT(*) AS n FROM sessions').get().n ?? 0;
      } catch {
        return 0;
      } finally {
        probe.close();
      }
    })();
    if (known === 0) {
      process.stderr.write(`cfind: 找不到会话目录 ${root}\n`);
      return 3;
    }
    // 有索引就继续；提醒一句，避免用户以为索引是最新的。
    process.stderr.write(`cfind: 会话目录 ${root} 不存在，仅使用索引中的 ${known} 个会话\n`);
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

  const { db, mode } = openIndex({ noIndex: flags['no-index'] });
  try {
    // 查询前顺手增量更新：磁盘模式只解新帧（毫秒级），内存模式=全量现建。
    const synced = sync(db, { root, only });
    const json = flags.json === true;
    const maxChars = num(flags['max-chars'], 1500);
    const terse = flags.terse === true;
    // 作用域收窄必须在 sync 之后算：selfSessionId 依赖 files 表里刚刷新的 mtime。
    // 早算会用到上一轮的 mtime，排除的可能是「上一次」正在写的会话（曾经写反过顺序）。
    const self = selfSessionId(db);
    const excludeSelf = flags['exclude-self'] === true ? self : undefined;
    const scopeFinal =
      only === undefined && excludeSelf === undefined
        ? scope
        : {
            ...scope,
            ...(only === undefined ? {} : { sources: only }),
            ...(excludeSelf === undefined ? {} : { exclude: [excludeSelf] }),
          };

    // surface 的默认按作用域自适应（见 paths.defaultSurface）：
    //   自己的会话 → shadowed（压缩前，因为压缩后我本来就看得到）
    //   别人的会话 → all     （它们的压缩前历史我从没见过，排除只是丢信息）
    // 显式 --surface 永远优先；--recall / --visible 是两种单向快捷方式。
    const surface =
      typeof flags.surface === 'string'
        ? flags.surface
        : flags.recall === true
          ? 'shadowed'
          : flags.visible === true
            ? 'current'
            : defaultSurface(scopeFinal, self);

    if (isCommand && command === 'help') {
      process.stdout.write(HELP);
      return 0;
    }

    if (isCommand && command === 'index') {
      // --gc：清掉已归档（原始文件已消失）的内容。归档让索引只增不减，
      // 所以需要一条显式的回收路径 —— 但绝不自动执行。
      if (flags.gc === true) {
        const purged = purgeArchived(db);
        process.stdout.write(
          json
            ? JSON.stringify(purged)
            : `purged: ${purged.sessions} archived sessions, ${purged.docs} docs, ${purged.events} events\n`,
        );
        return 0;
      }
      process.stdout.write(
        json
          ? JSON.stringify(synced)
          : `indexed: ${synced.sessions} sessions, ${synced.events} events, ${synced.docs} docs ` +
              `(${synced.filesAppended} appended, ${synced.filesRebuilt} rebuilt, ${synced.filesSkipped} skipped` +
              `${synced.archived ? `, ${synced.archived} archived` : ''}) ` +
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
        scope: scopeFinal,
        limit: num(flags.limit, 50),
        includeReasoning: flags['no-reasoning'] !== true,
        deep: flags.deep === true,
      });
      process.stdout.write(renderAudit(result, { json, scope: describeScope(scopeFinal) }));
      if (flags['fail-on-findings'] === true && result.findings.length > 0) return 1;
      return 0;
    }

    if (isCommand && command === 'outline') {
      const result = outline(db, { scope: scopeFinal });
      process.stdout.write(
        renderOutline(result, { json, maxChars: num(flags['max-chars'], 3000), scope: describeScope(scopeFinal), verbose: flags.verbose === true }),
      );
      return 0;
    }

    if (isCommand && command === 'show') {
      const [sessionArg, seqArg] = rest;
      if (!sessionArg || seqArg === undefined) throw new UsageError('用法: cfind show <session> <seq>');
      const sessionId = resolveSessionArg(db, sessionArg);
      const find = typeof flags.find === 'string' ? flags.find : undefined;
      const shown = show(db, {
        sessionId,
        seq: Number(seqArg),
        before: num(flags.before, 3),
        after: num(flags.after, 3),
        find,
      });
      // show 的会话来自位置参数，与 resolveScope 得到的 scope 无关：交给 renderShow 按 sessionId 反推。
      process.stdout.write(
        renderShow(shown, {
          json,
          maxChars: flags.full ? 0 : maxChars,
          verbose: flags.verbose === true,
          find,
        }) + '\n',
      );
      if (!json) {
        const notes = showNotes(shown, { find });
        if (notes.length > 0) process.stderr.write(`(${notes.join(' · ')})\n`);
      }
      return 0;
    }

    // 默认：检索。命令词不是保留字时，整个 positional 都算 query。
    const query = (isCommand ? rest : positional).join(' ').trim();
    if (!query) throw new UsageError('用法: cfind <query> [选项]');
    const wantList = flags.list === true;
    const context = num(flags.context, 0);
    // --exclude 的取值错误属于用法问题，要给人话而不是堆栈。
    try {
      resolveExclude(flags.exclude);
    } catch (error) {
      throw new UsageError(error.message);
    }
    const result = search(db, {
      query,
      scope: scopeFinal,
      dedupe: flags['no-dedupe'] !== true,
      fuzzy: flags.fuzzy === true,
      synonym: flags.fuzzy === true,
      limit: num(flags.limit, 10),
      includeReasoning: flags['no-reasoning'] !== true,
      surface,
      context: wantList ? 0 : context,
      exclude: flags.exclude,
      regex: flags.regex === true,
    });

    // --list = grep -l：只回「哪些会话提到了它」。内部多取一些再按会话去重，
    // 否则 limit=10 会让人以为世界上只有 10 条。
    if (wantList) {
      const scan = search(db, {
        query,
        scope: scopeFinal,
        limit: Math.min(500, Math.max(num(flags.limit, 10), 100) * 5),
      });
      const seen = new Map();
      for (const hit of scan.hits) if (!seen.has(hit.sessionId)) seen.set(hit.sessionId, hit);
      const lines = [...seen.values()].map((hit) => (hit.title ? `${hit.short}:${hit.title}` : hit.short));
      process.stdout.write(lines.length > 0 ? `${lines.join('\n')}\n` : '(no hits)\n');
      if (!json && seen.size > 0) process.stderr.write(`(${seen.size} sessions of ${scan.total} hits)\n`);
      return scan.total > 0 ? 0 : 1;
    }
    const count = result.total;
    const rendered = renderHits({ ...result, query }, {
      json,
      maxChars,
      scope: describeScope(scopeFinal),
      verbose: flags.verbose === true,
      terse,
    });
    // grep 的规矩：stdout 只放结果（且以换行结尾，这样 `| wc -l` 数得对），
    // 工具自己的话术走 stderr —— `| head -5` 才不会拿到一条提示行。
    process.stdout.write(rendered.endsWith('\n') ? rendered : `${rendered}\n`);
    if (!json) {
      const shown = rendered === '(no hits)' ? 0 : rendered.split('\n').filter(Boolean).length;
      const notes = hitNotes(result, { shown });
      if (notes.length > 0) process.stderr.write(`(${notes.join(' · ')})\n`);
    }
    return count > 0 ? 0 : 1;
  } finally {
    db.close?.();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (error) {
    // 参数类错误（--exclude 写错区域、未知选项…）只给人话，不吐堆栈：
    // grep 也不会因为 glob 写错就打印 C 的栈帧。
    if (error instanceof UsageError || error?.userFacing === true) {
      process.stderr.write(`cfind: ${error.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`cfind: ${error?.stack ?? error}\n`);
      process.exitCode = 2;
    }
  }
}

// lib/paths.mjs — 数据目录、会话发现、作用域解析
//
// 两条原则：
//   1. **本项目的数据目录是中立的**：索引不放在任何一家 agent 的家目录下
//      （`$CFIND_HOME` → `$XDG_DATA_HOME/cfind` → `~/.local/share/cfind`），
//      因为它要同时索引 DSH / Claude Code / Codex / OpenCode。
//   2. **会话发现是按源分派的**：每个 agent 的会话目录由各自的 host 决定
//      （DSH 在 `$DSH_HOME/sessions`），见 lib/sources/。
import { readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

/** 中立数据目录：$CFIND_HOME > $XDG_DATA_HOME/cfind > ~/.local/share/cfind。 */
export function dataHome() {
  if (process.env.CFIND_HOME) return process.env.CFIND_HOME;
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return join(xdg, 'cfind');
  return join(homedir(), '.local', 'share', 'cfind');
}

/** 索引库位置：<dataHome>/index.db。 */
export function indexPath() {
  return join(dataHome(), 'index.db');
}

/** DSH 的 home（`$DSH_HOME`，默认 `~/.dsh`）。这是**被索引方**的路径，不是我们的。 */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** DSH 会话根目录：`$DSH_HOME/sessions`。 */
export function sessionsRoot(home = dshHome()) {
  return join(home, 'sessions');
}

/**
 * 递归列出所有 DSH 会话文件。
 * 目录布局：sessions/--<projectKey>--/<dirId>/session.v4.jsonl.zstd
 * 注意：dirId 不一定是真实会话 id（可能是 `session-<uuid>`），真实 id 在文件首行 header 里。
 * @returns {Array<{path: string, projectDir: string, dirId: string, size: number, mtime: number}>}
 */
export function listSessionFiles(root = sessionsRoot()) {
  const out = [];
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = join(root, project.name);
    let dirs;
    try {
      dirs = readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const file = join(projectPath, dir.name, 'session.v4.jsonl.zstd');
      try {
        const info = statSync(file);
        out.push({ path: file, projectDir: project.name, dirId: dir.name, size: info.size, mtime: info.mtimeMs });
      } catch {
        /* 没有会话文件 */
      }
    }
  }
  return out;
}

/**
 * 解析检索作用域。优先级（越靠前越优先）：
 *   1. --session <id>
 *   2. 调用方自己的会话（$DSH_SESSION_ID；MCP 下由 mtime 启发式提供）
 *   3. --project / cwd 对应的项目会话
 *   4. --all
 * @returns {{mode: 'session', id: string} | {mode: 'project', cwd: string} | {mode: 'all'}}
 */
export function resolveScope({ session, project, all, cwd = process.cwd(), env = process.env } = {}) {
  if (session) return { mode: 'session', id: String(session) };
  if (all) return { mode: 'all' };
  if (project) return { mode: 'project', cwd: typeof project === 'string' ? project : cwd };
  if (env.DSH_SESSION_ID) return { mode: 'session', id: String(env.DSH_SESSION_ID) };
  return { mode: 'project', cwd };
}

/** 人类可读的作用域描述。 */
export function describeScope(scope) {
  if (scope.mode === 'session') return `session ${scope.id.slice(0, 8)}`;
  if (scope.mode === 'all') return 'all sessions';
  return `project ${scope.cwd}`;
}

/** 会话 id 短形式（前 8 位）。真实语料里部分 id 带 `session-` 前缀，展示时剥掉。 */
export function shortId(id) {
  return String(id ?? '').replace(/^session-/, '').slice(0, 8);
}

/** 目录名 → 猜测的 cwd 提示（仅用于展示，真实 cwd 以 header 为准）。 */
export function projectDirHint(projectDir) {
  return basename(projectDir).replace(/^--|--$/g, '').replace(/-/g, '/');
}

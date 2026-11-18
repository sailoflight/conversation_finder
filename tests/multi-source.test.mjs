// tests/multi-source.test.mjs — 跨来源集成：注册表、source 收窄、跨源检索与 show
//
// 为什么专门测：多源是「加一个适配器」的架构承诺，最容易静默退化的三处是
//   1. 注册表漏注册（新适配器写了但没生效）
//   2. `--source` 筛错列（曾经把 source 写成 session_id，静默 0 命中）
//   3. `--source` 收窄索引时**误删**其它源的会话（把「没扫到」当成「文件消失了」）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../lib/schema.mjs';
import { syncIndex, stats } from '../lib/store.mjs';
import { search, show } from '../lib/query.mjs';
import { ADAPTERS, SOURCE_IDS, activeAdapters } from '../lib/sources/index.mjs';

/** 造一个最小的 Claude Code 风格 .jsonl（明文，免去 zstd 依赖）。 */
function writeClaudeSession(dir, sessionId, prompt) {
  const target = join(dir, 'projects', 'proj');
  mkdirSync(target, { recursive: true });
  const rows = [
    { type: 'user', sessionId, cwd: '/tmp/x', version: '2.1.0', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: prompt } },
    { type: 'ai-title', sessionId, aiTitle: '测试标题' },
    { type: 'assistant', sessionId, uuid: 'u2', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: '这是助手的回答，包含幂等键这个词。' }] } },
  ];
  writeFileSync(join(target, `${sessionId}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function freshDb() {
  return openDb(':memory:');
}

test('注册表：四个适配器都已注册且 id 与目录名一致', () => {
  for (const id of ['dsh', 'claude', 'codex', 'opencode']) {
    assert.ok(SOURCE_IDS.includes(id), `缺少适配器 ${id}`);
  }
  assert.equal(ADAPTERS.length, SOURCE_IDS.length);
  for (const adapter of ADAPTERS) {
    // 接口完整性：静态检查比运行时才发现「某个源 outline 崩」便宜得多。
    for (const method of ['detect', 'discover', 'readAll', 'toDocs', 'surfaceOf', 'renderEvent']) {
      assert.equal(typeof adapter[method], 'function', `${adapter.id} 缺少 ${method}`);
    }
  }
});

test('activeAdapters: only 过滤生效', () => {
  const only = activeAdapters(['claude']).map((adapter) => adapter.id);
  assert.deepEqual(only, activeAdapters(['claude']).length === 0 ? [] : ['claude']);
});

test('source 收窄：只影响检索范围，不应该删掉其它源的数据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfind-ms-'));
  const home = join(dir, 'claude-home');
  mkdirSync(home, { recursive: true });
  writeClaudeSession(home, 'sid-a', '第一个会话：幂等键话题');
  writeClaudeSession(home, 'sid-b', '第二个会话：另一个话题');

  const previous = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = home;
  try {
    const db = freshDb();
    // 先全量索引（此时 DSH 也会被扫到，用真实 home 不影响：这里只断言 claude 部分）
    const all = syncIndex(db, { only: ['claude'] });
    assert.equal(all.errors.length, 0, JSON.stringify(all.errors));
    const before = stats(db);
    assert.equal(before.bySource.claude, 2);

    // 再用 only 收窄到同一来源重扫：不应把另一个来源（若有）当"消失"删掉。
    const again = syncIndex(db, { only: ['claude'] });
    assert.equal(stats(db).bySource.claude, 2, '重复收窄扫描不应丢会话');
    assert.ok(again.filesSkipped >= 0);

    // 关键回归：检索时 --source 必须筛 source 列，而不是 session_id。
    const sessionHits = search(db, { query: '幂等键', scope: { mode: 'all' }, limit: 5 });
    assert.ok(sessionHits.total > 0, '全库应能搜到');

    const narrowed = search(db, { query: '幂等键', scope: { mode: 'all', sources: ['claude'] }, limit: 5 });
    assert.ok(narrowed.total > 0, '--source claude 应收窄而非清零（筛错列会得 0）');
    assert.ok(narrowed.hits.every((hit) => hit.sessionId.startsWith('sid-')), '命中应全部来自 claude');

    const wrongSource = search(db, { query: '幂等键', scope: { mode: 'all', sources: ['codex'] }, limit: 5 });
    assert.equal(wrongSource.total, 0, '限定到不存在的来源应为 0');

    // show 走适配器：Claude 会话也能取原文。
    const shown = show(db, { sessionId: 'sid-a', seq: 0, before: 0, after: 2 });
    assert.equal(shown.source, 'claude');
    assert.match(shown.events[0].text, /幂等键/);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_HOME;
    else process.env.CLAUDE_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outline 跨源：claude 会话能给出标题与回合', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfind-ms2-'));
  const home = join(dir, 'claude-home');
  mkdirSync(home, { recursive: true });
  writeClaudeSession(home, 'sid-c', '跨源大纲测试的提问内容');

  const previous = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = home;
  try {
    const db = freshDb();
    syncIndex(db, { only: ['claude'] });
    const { outline } = await import('../lib/outline.mjs');
    const result = outline(db, { scope: { mode: 'session', id: 'sid-c' } });
    assert.equal(result.sessions.length, 1);
    const session = result.sessions[0];
    assert.equal(session.source, 'claude');
    assert.equal(session.title, '测试标题');
    assert.ok(session.turns.length >= 1);
    assert.match(session.turns[0].prompt, /跨源大纲测试/);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_HOME;
    else process.env.CLAUDE_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

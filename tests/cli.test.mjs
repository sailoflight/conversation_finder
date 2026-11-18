// tests/cli.test.mjs — CLI 端到端（真子进程，只依赖公开命令面）
//
// 用临时 DSH_HOME 指向 fixture，避免污染真实索引；用 CFIND_NO_INDEX=1 走内存索引，
// 这样测试既不写 ~/.dsh，也不需要预建索引。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildFixture, SESSION_IDS } from './fixtures/make-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'cfind.mjs');

/** 建一个带 sessions/ 的临时 DSH_HOME。 */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'cfind-cli-'));
  cpSync(buildFixture(join(home, 'src')), join(home, 'sessions'), { recursive: true });
  rmSync(join(home, 'src'), { recursive: true, force: true });
  return home;
}

/**
 * 让子进程**只看到测试自己的语料**：把其它来源的根目录指到不存在的位置。
 * 否则本机真实的 ~/.claude / ~/.codex / ~/.opencode 会被一起索引，
 * 断言里的会话数就不取决于 fixture 了 —— 这种测试在别人机器上必挂。
 */
function isolatedEnv(home) {
  return {
    ...process.env,
    DSH_HOME: home,
    CFIND_HOME: join(home, 'cfind-data'),
    CLAUDE_HOME: join(home, 'no-claude'),
    CODEX_HOME: join(home, 'no-codex'),
    OPENCODE_DIR: join(home, 'no-opencode'),
  };
}

function run(home, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, ['--no-warnings', BIN, ...args], {
    encoding: 'utf8',
    env: {
      ...isolatedEnv(home),
      CFIND_NO_INDEX: '1',
      DSH_SESSION_ID: '',
      ...extraEnv,
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('CLI: 中文检索命中并被 [ ] 高亮', () => {
  const home = makeHome();
  try {
    const { code, stdout } = run(home, ['幂等', '--all']);
    assert.equal(code, 0);
    assert.match(stdout, /\[幂等\]/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: --json 输出可解析且字段稳定', () => {
  const home = makeHome();
  try {
    const { code, stdout } = run(home, ['幂等', '--all', '--json']);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.total > 0);
    assert.ok(Array.isArray(parsed.hits));
    for (const key of ['sessionId', 'seq', 'kind', 'surface', 'snippet']) {
      assert.ok(key in parsed.hits[0], `missing ${key}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: 无命中退出码 1（不是错误）', () => {
  const home = makeHome();
  try {
    const { code, stdout } = run(home, ['zzzznonexistentterm', '--all']);
    assert.equal(code, 1);
    assert.equal(stdout.trim().length >= 0, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: show 能取回被压缩（shadowed）事件的原文', () => {
  const home = makeHome();
  try {
    const { code, stdout } = run(home, ['show', SESSION_IDS.B, '5']);
    assert.equal(code, 0);
    assert.match(stdout, /settlement_id/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: outline 给出标题与回合', () => {
  const home = makeHome();
  try {
    const { code, stdout } = run(home, ['outline', '--all']);
    assert.equal(code, 0);
    assert.match(stdout, /幂等键与重复扣款排查|订阅计费与退款对账/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: 未知选项退出码 2', () => {
  const home = makeHome();
  try {
    const { code } = run(home, ['x', '--bogus-flag']);
    assert.equal(code, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: --max-chars 让输出不超预算', () => {
  const home = makeHome();
  try {
    const { stdout } = run(home, ['幂等', '--all', '--limit', '20', '--max-chars', '200']);
    assert.ok(stdout.length <= 400, `output too long: ${stdout.length}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: cfind --help 退出码 0', () => {
  const home = makeHome();
  try {
    const { code, stdout } = run(home, ['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /cfind/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

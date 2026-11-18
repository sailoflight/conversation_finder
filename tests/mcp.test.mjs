// tests/mcp.test.mjs — MCP 服务端测试
//
// 两个层次：
//   1. 手写 JSON-RPC 客户端（零依赖）：验证握手、tools/list、tools/call、错误处理；
//   2. **真实 SDK 客户端**：直接 import DSH 内置的 @modelcontextprotocol/client，
//      验证它的「先探测 server/discover、再回落 legacy」流程能连上我们。
//      这一层最有价值 —— 它就是 DSH 实际使用的库，能证明 legacy 回落真的成立。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildFixture, SESSION_IDS } from './fixtures/make-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'bin', 'cfind-mcp.mjs');

/** 建一个带 sessions/ 的临时 DSH_HOME（与 CLI 测试同构）。 */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'cfind-mcp-'));
  cpSync(buildFixture(join(home, 'src')), join(home, 'sessions'), { recursive: true });
  rmSync(join(home, 'src'), { recursive: true, force: true });
  return home;
}

/**
 * 极简 MCP 客户端：换行分隔 JSON-RPC，按 id 配对响应。
 * 不用官方 SDK，这样能独立验证「服务端的线上行为」而不是被 SDK 掩盖。
 */
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

function connect(home) {
  const child = spawn(process.execPath, ['--no-warnings', SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // CFIND_HOME 必须隔离：测试是并行的，共用全局索引库会互相删对方的会话。
    // 其它来源的根目录也要指走，否则会把本机真实会话索引进来，断言就不受控了。
    env: isolatedEnv(home),
  });
  let buffer = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        const message = JSON.parse(line);
        const resolve = pending.get(message.id);
        if (resolve) {
          pending.delete(message.id);
          resolve(message);
        }
      }
      nl = buffer.indexOf('\n');
    }
  });
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 15000).unref?.();
    });
  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  return { child, request, notify, close: () => child.kill() };
}

const initParams = {
  protocolVersion: '2026-07-28',
  capabilities: {},
  clientInfo: { name: 'test-client', version: '1.0.0' },
};

test('MCP: initialize 只回 legacy 版本（不冒充现代协议）', async () => {
  const home = makeHome();
  const client = connect(home);
  try {
    const response = await client.request('initialize', initParams);
    assert.ok(response.result, JSON.stringify(response));
    assert.equal(response.result.protocolVersion, '2025-06-18');
    assert.ok(!response.result.protocolVersion.startsWith('2026'), '不能回 2026 系，否则 client 会要求 resultType/_meta');
    assert.deepEqual(response.result.capabilities.tools, {});
    assert.equal(response.result.serverInfo.name, 'cfind');
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('MCP: server/discover 明确拒绝（触发 client 的 legacy 回落）', async () => {
  const home = makeHome();
  const client = connect(home);
  try {
    const response = await client.request('server/discover', {});
    assert.equal(response.error?.code, -32601, JSON.stringify(response));
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('MCP: tools/list 暴露六个工具且 schema 在 DSH 支持的子集内', async () => {
  const home = makeHome();
  const client = connect(home);
  try {
    await client.request('initialize', initParams);
    const response = await client.request('tools/list', {});
    const names = response.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['audit', 'index', 'outline', 'search', 'show', 'stats']);
    for (const tool of response.result.tools) {
      assert.equal(tool.inputSchema.type, 'object');
      // DSH 的 assertSupportedJsonSchema 不接受 $schema / format / minimum 等关键字。
      assert.equal(tool.inputSchema.$schema, undefined);
      for (const [, prop] of Object.entries(tool.inputSchema.properties ?? {})) {
        for (const banned of ['$ref', 'format', 'minimum', 'maximum', 'pattern', 'minLength']) {
          assert.equal(prop[banned], undefined, `${tool.name} 用了不支持的 ${banned}`);
        }
      }
    }
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('MCP: search 命中中文，并且能搜到被压缩（shadowed）的内容', async () => {
  const home = makeHome();
  const client = connect(home);
  try {
    await client.request('initialize', initParams);
    // settlement_id 只存在于会话 B 被压缩掉的 tool/result 里（seq 5）。
    const response = await client.request('tools/call', {
      name: 'search',
      arguments: { query: 'settlement_id', all: true },
    });
    const body = response.result.content[0].text;
    assert.equal(response.result.isError, undefined);
    assert.match(body, /settlement_id/);
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('MCP: search 无命中时明确告知（避免 agent 反复重试）', async () => {
  const home = makeHome();
  const client = connect(home);
  try {
    await client.request('initialize', initParams);
    const response = await client.request('tools/call', {
      name: 'search',
      arguments: { query: 'qwzznonexistentterm', all: true },
    });
    assert.match(response.result.content[0].text, /没有命中/);
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('MCP: show 能取回 shadowed 事件原文', async () => {
  const home = makeHome();
  const client = connect(home);
  try {
    await client.request('initialize', initParams);
    const response = await client.request('tools/call', {
      name: 'show',
      arguments: { session: SESSION_IDS.B, seq: 5 },
    });
    assert.match(response.result.content[0].text, /settlement_id/);
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('MCP: 工具级错误用 isError 返回而不是断连', async () => {
  const home = makeHome();
  const client = connect(home);
  try {
    await client.request('initialize', initParams);
    const response = await client.request('tools/call', {
      name: 'show',
      arguments: { session: 'no-such-session', seq: 1 },
    });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /找不到会话/);
    // 连接仍然可用：再调一次正常工具
    const after = await client.request('tools/call', { name: 'stats', arguments: {} });
    assert.match(after.result.content[0].text, /sessions/);
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('MCP: stats / index / outline / audit 都能返回', async () => {
  const home = makeHome();
  const client = connect(home);
  try {
    await client.request('initialize', initParams);
    const stats = await client.request('tools/call', { name: 'stats', arguments: {} });
    assert.match(stats.result.content[0].text, /sessions/);
    const indexed = await client.request('tools/call', { name: 'index', arguments: {} });
    assert.match(indexed.result.content[0].text, /synced/);
    const tree = await client.request('tools/call', { name: 'outline', arguments: { all: true } });
    assert.match(tree.result.content[0].text, /幂等键与重复扣款排查|订阅计费与退款对账/);
    const found = await client.request('tools/call', { name: 'audit', arguments: { all: true } });
    assert.match(found.result.content[0].text, /audit/);
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('MCP: 未知方法回 -32601 而不断连', async () => {
  const home = makeHome();
  const client = connect(home);
  try {
    const response = await client.request('resources/list', {});
    assert.equal(response.error?.code, -32601);
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('MCP: 非法 JSON 只回解析错误，不崩溃', async () => {
  const home = makeHome();
  const client = connect(home);
  try {
    client.child.stdin.write('{not json}\n');
    // 之后仍能正常握手，说明进程没死
    const response = await client.request('initialize', initParams);
    assert.ok(response.result);
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 真实 SDK 集成：证明 DSH 用的那个 client 能连上（含 legacy 回落） ────────
const SDK_DIR = '/home/d_demo1/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@modelcontextprotocol/client';

test('MCP(真实 SDK): DSH 的 client 能完成版本协商并调用工具', { skip: !existsSync(SDK_DIR) }, async () => {
  const home = makeHome();
  let client;
  try {
    const { Client } = await import(join(SDK_DIR, 'dist', 'index.mjs'));
    const { StdioClientTransport } = await import(join(SDK_DIR, 'dist', 'stdio.mjs'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--no-warnings', SERVER],
      env: { ...process.env, DSH_HOME: home, CFIND_HOME: join(home, 'cfind-data') },
    });
    client = new Client({ name: 'sdk-test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    // 协商结果必须是 legacy（我们主动拒绝现代协议探测）
    const era = typeof client.getProtocolEra === 'function' ? client.getProtocolEra() : undefined;
    if (era !== undefined) assert.equal(era, 'legacy', `expected legacy era, got ${era}`);

    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === 'search'));

    const result = await client.callTool({ name: 'search', arguments: { query: 'settlement_id', all: true } });
    const body = result.content.map((block) => block.text ?? '').join('\n');
    assert.match(body, /settlement_id/);
  } finally {
    await client?.close?.();
    rmSync(home, { recursive: true, force: true });
  }
});

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

test('MCP: 只暴露 2 个工具、8 个参数（尽量少的接口税）', async () => {
  const home = makeHome();
  const client = connect(home);
  try {
    await client.request('initialize', initParams);
    const response = await client.request('tools/list', {});
    const names = response.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['audit', 'search']);
    // 接口税是实打实的成本：工具定义本身就要占上下文，且每次会话都要付。
    // 这里把「参数总量」也钉住 —— 加参数得有很硬的理由。
    const params = response.result.tools.reduce(
      (sum, tool) => sum + Object.keys(tool.inputSchema.properties ?? {}).length,
      0,
    );
    assert.equal(params, 8, `参数总数应保持 8，实际 ${params}`);
    // show / outline / stats / index 都已被 grep 式 flag 取代，不该再单独出现
    for (const gone of ['show', 'outline', 'stats', 'index']) {
      assert.ok(!names.includes(gone), `${gone} 应该被 context/list/自动同步取代`);
    }
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
    assert.match(response.result.content[0].text, /no hits/);
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('MCP: 已被压缩（shadowed）的内容仍能取回正文', async () => {
  const home = makeHome();
  const client = connect(home);
  try {
    await client.request('initialize', initParams);
    // 旧接口是 show(session, seq)。现在 fold 成 search + context：
    // 搜那个词、带上上下文，被压缩的内容同样出现在结果里。
    const response = await client.request('tools/call', {
      name: 'search',
      arguments: { query: 'settlement_id', all: true, list: false, context: 1 },
    });
    assert.match(response.result.content[0].text, /settlement_id/);
    // 命中行或上下文行都应出现（: 或 - 分隔）
    assert.match(response.result.content[0].text, /^\w+[:-]\d+[:-]/m);
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
    // 空 query 是唯一的参数错误路径（其余都由默认值兜住）。
    const response = await client.request('tools/call', { name: 'search', arguments: { query: '  ' } });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /query/);
    // 连接仍然可用：再调一次正常工具
    const after = await client.request('tools/call', { name: 'search', arguments: { query: '幂等键', all: true } });
    // grep 形状：session:seq:text（短 id 含字母，不能只匹配数字）
    assert.match(after.result.content[0].text, /^\w+:\d+:/m);
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('MCP: context 代替 show，list 代替 outline', async () => {
  const home = makeHome();
  const client = connect(home);
  try {
    await client.request('initialize', initParams);

    // context：命中行用 `:`、上下文行用 `-`（grep -C 形状）
    const withContext = await client.request('tools/call', {
      name: 'search',
      arguments: { query: '幂等键', all: true, context: 2 },
    });
    const contextText = withContext.result.content[0].text;
    assert.match(contextText, /^\w+[:-]\d+[:-]/m, '应当出现 grep -C 形状的行');
    assert.ok(contextText.split('\n').length >= 3, 'context>0 时应当多于一条命中行');

    // list：只回「哪些会话」，每行 session:标题
    const listed = await client.request('tools/call', {
      name: 'search',
      arguments: { query: '幂等键', all: true, list: true },
    });
    const listText = listed.result.content[0].text;
    assert.match(listText, /^\w+:\S/m, 'list 应当输出 session:标题');

    // audit 仍然独立存在（它的输出强制脱敏，不能折进 search）
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

test('MCP: 接口税不超标（工具数 / 参数量 / 描述长度都钉住）', async () => {
  const home = makeHome();
  const client = connect(home);
  try {
    await client.request('initialize', initParams);
    const { result } = await client.request('tools/list', {});
    const tools = result.tools;

    // 这三个数字是「尽量少的工具、尽量少的参数、尽量少的提示词」的量化形式。
    // 想加东西就得先改这里的断言 —— 那是一次有意识的决定，不是顺手膨胀。
    assert.ok(tools.length <= 2, `工具数应 <=2，实际 ${tools.length}`);
    const params = tools.reduce((sum, tool) => sum + Object.keys(tool.inputSchema.properties ?? {}).length, 0);
    assert.ok(params <= 8, `参数总数应 <=8，实际 ${params}`);

    // 粗粒度 token 估算：CJK/1.5 + ASCII/4
    const cjk = (text) => (String(text).match(/[\u4e00-\u9fff]/g) ?? []).length;
    const approx = (text) => Math.round(cjk(text) / 1.5 + (String(text).length - cjk(text)) / 4);
    const tax = tools.reduce(
      (sum, tool) => sum + approx(tool.description ?? '') + approx(JSON.stringify(tool.inputSchema)),
      0,
    );
    // 实测 264 tok。给 1.5 倍余量以免因措辞微调就挂，但能挡住"再加个工具"。
    assert.ok(tax <= 400, `接口税 ${tax} tok 超预算（<=400）`);
  } finally {
    client.close();
    rmSync(home, { recursive: true, force: true });
  }
});

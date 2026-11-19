// 延迟：MCP 常驻进程 vs CLI 每次 spawn（agent 实际感受到的速度）
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

// 仓库根 = 本文件的上两级。硬编码绝对路径会让别人 clone 下来直接跑不了。
const HF = fileURLToPath(new URL('..', import.meta.url));
const MCP = join(HF, 'bin/cfind-mcp.mjs');
const CLI = join(HF, 'bin/cfind.mjs');
const ENV = { ...process.env, CFIND_HOME: '/tmp/cfind-all',
  // 其它来源的语料位置由环境变量给，脚本不假设任何人的目录布局。
  ...(process.env.CLAUDE_HOME ? { CLAUDE_HOME: process.env.CLAUDE_HOME } : {}),
  ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
  ...(process.env.OPENCODE_DIR ? { OPENCODE_DIR: process.env.OPENCODE_DIR } : {}) };

const pct = (arr, p) => { const s=[...arr].sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(s.length*p))]; };
const stat = (arr) => `p50 ${pct(arr,0.5).toFixed(1)}ms  p95 ${pct(arr,0.95).toFixed(1)}ms  min ${Math.min(...arr).toFixed(1)}ms  max ${Math.max(...arr).toFixed(1)}ms`;

// ── MCP 常驻 ──
function connect() {
  const child = spawn(process.execPath, ['--no-warnings', MCP], { stdio: ['pipe','pipe','pipe'], env: ENV });
  let buf=''; const pending=new Map(); let id=1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (ch) => {
    buf += ch; let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl+1);
      if (line) { const m = JSON.parse(line); const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); } }
      nl = buf.indexOf('\n');
    }
  });
  const req = (method, params) => new Promise((resolve) => {
    const n = id++; pending.set(n, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc:'2.0', id:n, method, params }) + '\n');
  });
  return { child, req, close: () => child.kill() };
}

const t0 = performance.now();
const client = connect();
await client.req('initialize', { protocolVersion:'2026-07-28', capabilities:{}, clientInfo:{name:'b',version:'1'} });
const coldStart = performance.now() - t0;

const mcpTimes = [];
for (let i = 0; i < 30; i++) {
  const s = performance.now();
  await client.req('tools/call', { name:'search', arguments:{ query:'bino', all:true, limit:3 } });
  mcpTimes.push(performance.now() - s);
}
client.close();

// ── CLI 每次 spawn ──
const cliTimes = [];
for (let i = 0; i < 8; i++) {
  const s = performance.now();
  spawnSync(process.execPath, ['--no-warnings', CLI, 'bino', '--all', '--limit', '3'], { env: ENV, encoding:'utf8' });
  cliTimes.push(performance.now() - s);
}

console.log('════ 速度 ════');
console.log(`MCP 冷启动(含 initialize)   ${coldStart.toFixed(0)}ms`);
console.log(`MCP 常驻 单次 tools/call    ${stat(mcpTimes)}`);
console.log(`CLI 每次调用(含 spawn)      ${stat(cliTimes)}`);
console.log(`\n加速比                      ${(pct(cliTimes,0.5)/pct(mcpTimes,0.5)).toFixed(1)}x`);

// ── 拆分 MCP 单次调用的内部构成 ──
const { openDb } = await import(join(HF,'lib/schema.mjs'));
const { syncIndex } = await import(join(HF,'lib/store.mjs'));
const db = openDb('/tmp/cfind-all/index.db');
const syncTimes = [];
for (let i=0;i<20;i++){ const s=performance.now(); syncIndex(db, {}); syncTimes.push(performance.now()-s); }
console.log(`\n每次调用内的增量同步       ${stat(syncTimes)}  （热路径只 stat 文件，不解码）`);

// tests/audit.test.mjs — audit 模块自测（只跑这个文件：node --test tests/audit.test.mjs）
//
// 语料全部在临时目录里现造：含**假凭据**，不读真实 ~/.dsh，也不依赖 store 代理的实现。
// 建索引用最小辅助（openDb + readSessionFile + sessionDocs），store.mjs 写好后可替换。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../lib/schema.mjs';
import { readSessionFile } from '../lib/decode.mjs';
import { sessionDocs } from '../lib/extract.mjs';
import { bigrams } from '../lib/cjk.mjs';
import { listSessionFiles } from '../lib/paths.mjs';
import { audit, redact, DEFAULT_PATTERNS } from '../lib/audit.mjs';
import { writeSessionFile } from './fixtures/make-fixture.mjs';

const T0 = 1800000000000;
const SECRETS_ID = 'cccccccc-3333-4333-8333-333333333333';
const CLEAN_ID = 'dddddddd-4444-4444-8444-444444444444';
const AUDIT_CWD = '/tmp/audit-fixture';
const OTHER_CWD = '/tmp/other-project';

// 全部是假凭据（示例串），只为触发规则，不是任何真实服务的 key。
const SK_KEY = ['sk-', 'abcdef1234567890abcdef'].join('');
const AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const GITHUB_TOKEN = ['ghp_', '16C7e42F292c6912E7710c838347Ae178B4a'].join('');
const GOOGLE_KEY = ['AIza', 'SyA1234567890abcdefghijklmnopqrstuv'].join('');
const SLACK_TOKEN = ['xoxb-', '123456789012-', '123456789012-', 'abcdefghijklmnopqrstuvwx'].join('');
const BEARER_TOKEN = ['eyJhbGciOiJIUzI1NiJ9.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.', 'abcdefghijklmnopqrstuvwxyz012345'].join('');
const PASSWORD = 'hunter2pass';
const URL_PASSWORD = 's3cr3tp4ss';
const ENTROPY = 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm';
const HEX64 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const PEM_BODY = 'MIIEowIBAAKCAQEA7Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm';
const PEM_BLOCK = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----`;

const SENSITIVE_TEXT = [
  '排查部署配置时发现了一串可疑凭据：',
  `api_key=${SK_KEY}`,
  `api_key=${SK_KEY}`, // 故意重复：用于验证 (sessionId, seq, kind, patternId) 去重
  `aws_access_key_id=${AWS_KEY}`,
  `github=${GITHUB_TOKEN}`,
  `google=${GOOGLE_KEY}`,
  `slack=${SLACK_TOKEN}`,
  `Authorization: Bearer ${BEARER_TOKEN}`,
  `password=${PASSWORD}`,
  `postgres://alice:${URL_PASSWORD}@db.internal:5432/app`,
  `entropy=${ENTROPY}`,
  `digest=${HEX64}`,
  '私钥块：',
  PEM_BLOCK,
].join('\n');

const REASONING_SECRET = 'sk-reasoning0000000000';

function makeSession({ id, cwd, title, userText, reasoning }) {
  const events = [];
  let seq = 0;
  const push = (type, data) => events.push({ type, seq: seq++, time: T0 + seq * 1000, data });
  events.push({ type: 'session', seq: 0, time: T0, id, version: 4, createdAt: T0, cwd, agentPreset: 'standard' });
  seq = 1;
  push('session/title', { title });
  push('user/message', { content: [{ type: 'text', text: userText }] });
  if (reasoning) {
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: reasoning },
          { type: 'text', text: '检查完毕。' },
        ],
      },
    });
  }
  push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '收到。' }] } });
  return events;
}

/** 最小建索引辅助：只填 audit 需要的 sessions/docs（store.mjs 未就绪时自给自足）。 */
function indexFixture(db, root) {
  const insertSession = db.prepare(
    `INSERT OR REPLACE INTO sessions
       (id, cwd, title, created_at, agent_preset, parent_id, event_count, first_time, last_time)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  );
  const insertDoc = db.prepare(
    `INSERT INTO docs (body, sh, session_id, seq, kind, time, surface) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const file of listSessionFiles(root)) {
    const { header, events } = readSessionFile(file.path);
    const id = header?.id ?? file.dirId;
    const title = events.filter((ev) => ev.type === 'session/title').at(-1)?.data?.title ?? '';
    const times = events.map((ev) => ev.time ?? 0);
    insertSession.run(
      id,
      header?.cwd ?? '',
      title,
      header?.createdAt ?? 0,
      header?.agentPreset ?? '',
      events.length,
      Math.min(...times),
      Math.max(...times),
    );
    for (const doc of sessionDocs(events)) {
      insertDoc.run(doc.body, bigrams(doc.body), id, doc.seq, doc.kind, doc.time ?? 0, doc.surface);
    }
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'cfind-audit-'));
const sessionsRoot = join(tmp, 'sessions');
writeSessionFile(
  join(sessionsRoot, '--tmp-audit-fixture--', SECRETS_ID, 'session.v4.jsonl.zstd'),
  makeSession({
    id: SECRETS_ID,
    cwd: AUDIT_CWD,
    title: '凭据审计测试',
    userText: SENSITIVE_TEXT,
    reasoning: `审计推理里也混进了一把 key：${REASONING_SECRET}`,
  }),
);
writeSessionFile(
  join(sessionsRoot, '--tmp-other-project--', CLEAN_ID, 'session.v4.jsonl.zstd'),
  makeSession({ id: CLEAN_ID, cwd: OTHER_CWD, title: '干净会话', userText: '这段是干净的，没有凭据。' }),
);

const db = openDb(join(tmp, 'index.db'));
indexFixture(db, sessionsRoot);

after(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ---------- redact ----------

test('redact：长度 < 7 全遮，边界 7 开始前 4 … 后 2', () => {
  assert.equal(redact(''), '***');
  assert.equal(redact('a'), '***');
  assert.equal(redact('abcdef'), '***');
  assert.equal(redact('abcdefg'), 'abcd…fg(len=7)');
  assert.equal(redact('abcdefgh'), 'abcd…gh(len=8)');
  assert.equal(redact(SK_KEY), `sk-a…ef(len=${SK_KEY.length})`);
});

test('redact：任何长度边界都不回显完整原文', () => {
  for (const secret of ['abcdef', 'abcdefg', 'abcdefgh', SK_KEY, AWS_KEY, PASSWORD]) {
    const out = redact(secret);
    assert.equal(typeof out, 'string');
    assert.ok(!out.includes(secret), `redact 泄露了原文: ${out}`);
    assert.ok(out === '***' || /\(len=\d+\)$/.test(out));
  }
  assert.equal(redact(null), '***');
});

// ---------- 模式覆盖 ----------

test('DEFAULT_PATTERNS：契约要求的模式全部覆盖且命中', () => {
  const ids = DEFAULT_PATTERNS.map((p) => p.id);
  for (const id of ['sk-key', 'aws-access-key', 'github-token', 'google-api-key', 'slack-token', 'pem-private-key', 'bearer-token', 'secret-assignment', 'url-credentials', 'high-entropy', 'high-entropy-hex']) {
    assert.ok(ids.includes(id), `缺少模式 ${id}`);
  }
  // 导出模板必须无状态（不带 g），否则调用方共享 lastIndex 会漏检。
  for (const p of DEFAULT_PATTERNS) assert.ok(!p.re.flags.includes('g'), `${p.id} 不应带 g`);
  for (const p of DEFAULT_PATTERNS) assert.ok(typeof p.label === 'string' && p.label.length > 0);

  const { findings } = audit(db, { scope: { mode: 'session', id: SECRETS_ID } });
  const hit = new Set(findings.map((f) => f.patternId));
  for (const id of ids) assert.ok(hit.has(id), `模式 ${id} 在假凭据语料上未命中`);
});

// ---------- 不泄露 ----------

test('audit：findings 任何字段都不回显完整凭据', () => {
  const result = audit(db, { scope: { mode: 'session', id: SECRETS_ID } });
  assert.ok(result.findings.length > 0);
  const serialized = JSON.stringify(result.findings);
  const raws = [SK_KEY, AWS_KEY, GITHUB_TOKEN, GOOGLE_KEY, SLACK_TOKEN, BEARER_TOKEN, PASSWORD, URL_PASSWORD, ENTROPY, HEX64, PEM_BODY];
  for (const raw of raws) {
    const escaped = JSON.stringify(raw).slice(1, -1);
    assert.ok(!serialized.includes(raw), `findings 泄露了 ${raw.slice(0, 6)}…`);
    assert.ok(!serialized.includes(escaped), `findings 泄露了转义后的 ${raw.slice(0, 6)}…`);
  }
  for (const f of result.findings) {
    assert.ok(f.redacted === '***' || /^.{4}….{2}\(len=\d+\)$/u.test(f.redacted), `redacted 形状不对: ${f.redacted}`);
    for (const raw of [SK_KEY, AWS_KEY, GITHUB_TOKEN, GOOGLE_KEY, SLACK_TOKEN, BEARER_TOKEN, PASSWORD, URL_PASSWORD]) {
      assert.ok(!f.label.includes(raw), 'label 混入命中内容');
    }
    assert.equal(f.short, f.sessionId.slice(0, 8));
    assert.equal(f.length > 0, true);
  }
});

// ---------- 去重 / limit ----------

test('audit：同一 (sessionId, seq, kind, patternId) 只报一次', () => {
  // 用户消息里同一把 sk- key 出现两次；自定义模式应只出 1 条 user 文档 finding。
  const custom = [{ id: 'dup-sk', label: '重复测试', re: /(?<secret>\bsk-[A-Za-z0-9]{8,})/ }];
  const { findings } = audit(db, {
    patterns: custom,
    scope: { mode: 'session', id: SECRETS_ID },
    includeReasoning: false,
  });
  const userFinds = findings.filter((f) => f.kind === 'user');
  assert.equal(userFinds.length, 1);
  assert.equal(userFinds[0].seq, 2);
});

test('audit：limit 控制 findings 总数', () => {
  assert.equal(audit(db, { scope: { mode: 'all' }, limit: 2 }).findings.length, 2);
  assert.equal(audit(db, { scope: { mode: 'all' }, limit: 0 }).findings.length, 0);
  const unlimited = audit(db, { scope: { mode: 'all' }, limit: 500 }).findings.length;
  assert.ok(unlimited > 2);
});

// ---------- 作用域 / reasoning ----------

test('audit：scope 过滤（session / project / all）', () => {
  const session = audit(db, { scope: { mode: 'session', id: SECRETS_ID } });
  assert.deepEqual(session.scanned.sessions, 1);
  assert.ok(session.scanned.docs > 0);
  assert.ok(session.findings.every((f) => f.sessionId === SECRETS_ID));

  const project = audit(db, { scope: { mode: 'project', cwd: AUDIT_CWD } });
  assert.deepEqual(project.scanned.sessions, 1);
  assert.ok(project.findings.length > 0);

  const cleanProject = audit(db, { scope: { mode: 'project', cwd: OTHER_CWD } });
  assert.deepEqual(cleanProject.scanned.sessions, 1);
  assert.deepEqual(cleanProject.findings, []);

  const all = audit(db, { scope: { mode: 'all' } });
  assert.deepEqual(all.scanned.sessions, 2);
  assert.ok(all.scanned.docs > session.scanned.docs);
});

test('audit：includeReasoning 过滤 reasoning 文档', () => {
  const custom = [{ id: 'sk-any', label: 'SK', re: /(?<secret>\bsk-[A-Za-z0-9]{8,})/ }];
  const scope = { mode: 'session', id: SECRETS_ID };
  const withReasoning = audit(db, { patterns: custom, scope, includeReasoning: true });
  const without = audit(db, { patterns: custom, scope, includeReasoning: false });
  assert.ok(withReasoning.findings.some((f) => f.kind === 'reasoning'));
  assert.ok(!without.findings.some((f) => f.kind === 'reasoning'));
  assert.equal(withReasoning.scanned.docs, without.scanned.docs + 1);
});

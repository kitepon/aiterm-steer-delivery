import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { submitCodexParentAnswer, wakeCodexParentIfAsleep } from '../dist/index.js';

// 公式Codexと手元の偽のmodelで、寝ている会話を起こす所を通す。Codexが無い環境では飛ばす。実物のログインも共有の置き場も使わない。
// アプリの代わりに、リンクを開く関数が「会話を載せる別のprocess」を起こす（アプリが会話を開いた時と同じ thread/resume）。
const codex = process.env.STEER_TEST_CODEX_BINARY ?? (spawnSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { encoding: 'utf8' }).stdout ?? '').split(/\r?\n/)[0];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function connect(root, env) {
  const child = spawn(codex, ['app-server', '-c', 'analytics.enabled=false'], { cwd: root, env, stdio: ['pipe', 'pipe', 'ignore'], shell: process.platform === 'win32' });
  const exited = once(child, 'exit');
  const pending = new Map();
  const events = [];
  createInterface({ input: child.stdout }).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (!message.method && pending.has(message.id)) {
      const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
      message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
    } else if (message.method) events.push(message);
  });
  let id = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`応答timeout: ${method}`)); }, 20_000);
    pending.set(key, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id: key, method, params }) + '\n');
  });
  return {
    request,
    async initialize() {
      await request('initialize', { clientInfo: { name: 'steer_wake_test', version: '1' }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    },
    async completed(turnId) {
      for (let i = 0; i < 300; i++) {
        const found = events.find(event => event.method === 'turn/completed' && event.params.turn.id === turnId);
        if (found) return found.params.turn.status;
        await sleep(100);
      }
      throw new Error('番が終わらない');
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.stdin.end();
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited; clearTimeout(kill);
      for (const item of pending.values()) clearTimeout(item.timer);
    },
  };
}

async function stage(t, { hold = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'steer-wake-official-'));
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  const calls = [];
  let release; const gate = hold ? new Promise(resolve => { release = resolve; }) : null;
  const http = createServer(async (request, response) => {
    if (request.url !== '/v1/responses') { response.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const number = calls.push(Buffer.concat(chunks).toString());
    if (gate && number === 1) await gate;
    if (response.destroyed) return;
    const responseId = `response-${number}`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([
      { type: 'response.created', response: { id: responseId } },
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `message-${number}`, content: [{ type: 'output_text', text: `応答${number}` }] } },
      { type: 'response.completed', response: { id: responseId, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const url = `http://127.0.0.1:${http.address().port}`;
  writeFileSync(join(home, 'config.toml'), `model = "mock-model"
model_provider = "mock_provider"
approval_policy = "never"
sandbox_mode = "read-only"
cli_auth_credentials_store = "file"
mcp_oauth_credentials_store = "file"
chatgpt_base_url = "${url}"
[model_providers.mock_provider]
name = "wake test"
base_url = "${url}/v1"
wire_api = "responses"
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`, { mode: 0o600 });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: home, TMPDIR: root, RUST_LOG: 'error' };
  const clients = [];
  const client = async () => { const c = connect(root, env); clients.push(c); await c.initialize(); return c; };
  t.after(async () => {
    release?.();
    await Promise.all(clients.map(c => c.close()));
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const profile = { codex_client_name: 'steer_wake_test', display_name: 'Demo', config_root: () => join(root, 'config'), state_root: () => join(root, 'state') };
  const runtime = { executable: codex, env, timeout_ms: 20_000 };
  const queued = text => calls.filter(body => body.includes(text)).length;
  return { root, home, env, client, profile, runtime, calls, queued, release: () => release?.() };
}

const skip = !codex && 'Codexがありません';
const DELIVERY = () => crypto.randomUUID();

test('公式Codex: どこにも載っていない会話は、開かせると入れた文が番になる', { skip, timeout: 120_000 }, async t => {
  const s = await stage(t);
  const owner = await s.client();
  const { thread } = await owner.request('thread/start', { cwd: s.root });
  const first = await owner.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: '最初の文', text_elements: [] }] });
  assert.equal(await owner.completed(first.turn.id), 'completed');
  await owner.close();
  const parent = { thread_id: thread.id, codex_home: s.home };
  const delivery = DELIVERY();
  await submitCodexParentAnswer(s.profile, parent, delivery, 'WAKE_OFFICIAL_TEXT', s.runtime);
  // 載せているprocessが無いので、待っても番にならない。
  await sleep(12_000);
  assert.equal(s.queued('WAKE_OFFICIAL_TEXT'), 0, '開く前は動かない');
  const opened = [];
  const result = await wakeCodexParentIfAsleep(s.profile, parent, delivery, { delay_ms: 0, confirm_ms: 30_000, runtime: s.runtime, directory: join(s.root, 'wake'),
    open: url => { opened.push(url); void s.client().then(app => app.request('thread/resume', { threadId: thread.id })); return { ok: true }; } });
  assert.deepEqual(opened, [`codex://threads/${thread.id}`]);
  assert.equal(result.turn, 'completed');
  assert.equal(result.outcome, 'woken');
  for (let i = 0; i < 100 && s.queued('WAKE_OFFICIAL_TEXT') === 0; i++) await sleep(100);
  assert.equal(s.queued('WAKE_OFFICIAL_TEXT'), 1, '入れた文がmodelへ一度だけ届く');
});

test('公式Codex: 載っている会話は、Codexが自分で番にするので開かない', { skip, timeout: 120_000 }, async t => {
  const s = await stage(t);
  const owner = await s.client();
  const { thread } = await owner.request('thread/start', { cwd: s.root });
  const first = await owner.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: '最初の文', text_elements: [] }] });
  assert.equal(await owner.completed(first.turn.id), 'completed');
  const parent = { thread_id: thread.id, codex_home: s.home };
  const delivery = DELIVERY();
  await submitCodexParentAnswer(s.profile, parent, delivery, 'WAKE_OFFICIAL_TEXT', s.runtime);
  const opened = [];
  const result = await wakeCodexParentIfAsleep(s.profile, parent, delivery, { delay_ms: 15_000, runtime: s.runtime, directory: join(s.root, 'wake'),
    open: url => { opened.push(url); return { ok: true }; } });
  assert.equal(result.outcome, 'delivered');
  assert.deepEqual(opened, []);
  assert.equal(s.queued('WAKE_OFFICIAL_TEXT'), 1);
});

test('公式Codex: 番を途中で止めた会話は、載せているprocessが居なくなっても起こさない', { skip, timeout: 120_000 }, async t => {
  const s = await stage(t, { hold: true });
  const owner = await s.client();
  const { thread } = await owner.request('thread/start', { cwd: s.root });
  const first = await owner.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: '最初の文', text_elements: [] }] });
  while (!s.calls.length) await sleep(100);
  await owner.request('turn/interrupt', { threadId: thread.id, turnId: first.turn.id });
  assert.equal(await owner.completed(first.turn.id), 'interrupted');
  s.release();
  await owner.close();
  const parent = { thread_id: thread.id, codex_home: s.home };
  const delivery = DELIVERY();
  await submitCodexParentAnswer(s.profile, parent, delivery, 'WAKE_OFFICIAL_TEXT', s.runtime);
  const opened = [];
  const result = await wakeCodexParentIfAsleep(s.profile, parent, delivery, { delay_ms: 0, runtime: s.runtime, directory: join(s.root, 'wake'),
    open: url => { opened.push(url); return { ok: true }; } });
  assert.equal(result.outcome, 'interrupted');
  assert.equal(result.turn, 'interrupted');
  assert.deepEqual(opened, []);
  assert.equal(s.queued('WAKE_OFFICIAL_TEXT'), 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerDigest, codexInputDirectory, runCodexResultHook, submitCodexParentAnswer } from '../dist/index.js';

// 公式キューへ入らなかった配送の所有記録（pending）の扱い。
// 2026-10-13、片付け済みの会話へ入れて断られた配送の記録が残り、会話を戻した後の同じ配送IDの渡し直しが EEXIST で通らなかった。
const THREAD = '01a13309-86fc-77d3-be09-c404eef696fb';
const DELIVERY = '8b391781-1504-5e8f-93ba-694c2cf3ac45';

// 偽のApp Server。応答の仕方は、試験が書き換えるJSONから毎回読む。受けた要求のmethodを1行ずつ残す。
const server = `import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const state = JSON.parse(readFileSync(process.env.RECORD_TEST_STATE, 'utf8'));
  appendFileSync(process.env.RECORD_TEST_SEEN, message.method + '\\n');
  const answer = value => process.stdout.write(JSON.stringify({ id: message.id, ...value }) + '\\n');
  const mode = message.method === 'initialize' ? state.initialize : message.method === 'thread/queue/add' ? state.add : 'accept';
  if (mode === 'silent') return;
  if (mode === 'reject') { answer({ error: { code: -32600, message: 'session ' + (message.params.threadId ?? '') + ' is archived. Run codex unarchive first.' } }); return; }
  if (mode === 'no_receipt') { answer({ result: {} }); return; }
  answer({ result: message.method === 'thread/queue/add' ? { queuedSubmission: { id: 'q-1' } }
    : message.method === 'thread/queue/list' ? { data: state.queue ?? [], nextCursor: null }
    : message.method === 'thread/queue/delete' ? { deleted: true } : {} });
});`;

function scene(t) {
  const dir = mkdtempSync(join(tmpdir(), 'steer-rejected-record-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'app-server.mjs');
  writeFileSync(script, server);
  const home = join(dir, 'home');
  const hooks = join(dir, 'hooks');
  mkdirSync(home); mkdirSync(hooks);
  const profile = { display_name: 'Demo', codex_client_name: 'demo', codex_hook_schema: 'demo.codex-parent-hooks.v1', setup_command: 'demo-setup',
    config_root: () => join(dir, 'config'), state_root: () => join(dir, 'state') };
  writeFileSync(join(hooks, 'config.json'), JSON.stringify({ schema: profile.codex_hook_schema, enabled: true, codex_home: home,
    binary: process.execPath, command: 'demo-hook', node: process.execPath, hook: script, stale_processes: [] }));
  const stateFile = join(dir, 'state.json');
  const seenFile = join(dir, 'seen.txt');
  writeFileSync(seenFile, '');
  const set = value => writeFileSync(stateFile, JSON.stringify({ initialize: 'accept', add: 'accept', ...value }));
  set({});
  const runtime = extra => ({ executable: process.execPath, args: [script], timeout_ms: 10000, hook_directory: hooks,
    env: { ...process.env, RECORD_TEST_STATE: stateFile, RECORD_TEST_SEEN: seenFile }, ...extra });
  const parent = { thread_id: THREAD, codex_home: home };
  const inputs = codexInputDirectory(hooks, home, THREAD);
  const record = kind => join(inputs, kind, `${DELIVERY}.json`);
  const adds = () => readFileSync(seenFile, 'utf8').split('\n').filter(method => method === 'thread/queue/add').length;
  const submit = (extra = {}, text = '返信') => submitCodexParentAnswer(profile, parent, DELIVERY, text, runtime(extra));
  return { dir, profile, parent, hooks, home, inputs, record, set, runtime, adds, submit };
}
const failure = (code, unknown) => error => { assert.deepEqual([error.delivery_code, error.outcome_unknown], [code, unknown], String(error)); return true; };

test('受け口が断った配送は所有記録を残さず、会話が戻った後に同じ配送IDで渡し直せる', async t => {
  const s = scene(t);
  s.set({ add: 'reject' });
  await assert.rejects(s.submit(), failure('CODEX_RECEIVER_REJECTED', false));
  assert.equal(existsSync(s.record('pending')), false, '断られた配送の所有記録を残さない');
  assert.equal(existsSync(s.record('settled')), false);
  // 会話を戻した後（codex unarchive）。同じ配送IDで渡し直す。
  s.set({ add: 'accept' });
  assert.deepEqual(await s.submit(), { queued_submission_id: 'q-1' });
  assert.equal(s.adds(), 2);
  assert.deepEqual(JSON.parse(readFileSync(s.record('pending'), 'utf8')), { delivery_id: DELIVERY, thread_id: THREAD, text_sha256: answerDigest('返信') });
  assert.equal(existsSync(s.record('settled')), true, '受け付けた配送の記録は、今までどおり残す');
});

test('キューへ頼む前に止まった配送も、所有記録を残さない', async t => {
  const s = scene(t);
  s.set({ initialize: 'reject' });
  await assert.rejects(s.submit(), failure('CODEX_RECEIVER_REJECTED', false));
  s.set({ initialize: 'silent' });
  await assert.rejects(s.submit({ timeout_ms: 300 }), failure('CODEX_RECEIVER_TIMEOUT', false));
  await assert.rejects(s.submit({ executable: join(s.dir, '無いcodex') }), failure('CODEX_RECEIVER_TRANSPORT_FAILED', false));
  assert.equal(s.adds(), 0, 'どの回も、キューへは頼んでいない');
  assert.deepEqual(readdirSync(join(s.inputs, 'pending')), []);
  assert.equal(existsSync(join(s.inputs, 'settled', `${DELIVERY}.json`)), false);
  s.set({});
  assert.deepEqual(await s.submit(), { queued_submission_id: 'q-1' });
});

test('受け付けたか分からない配送は所有記録を残し、同じ配送IDは送らずに CODEX_DELIVERY_DUPLICATE で断る', async t => {
  for (const [add, code, timeout] of [['silent', 'CODEX_RECEIVER_TIMEOUT', 300], ['no_receipt', 'CODEX_RECEIVER_INVALID_RESPONSE', 10000]]) {
    const s = scene(t);
    s.set({ add });
    await assert.rejects(s.submit({ timeout_ms: timeout }), failure(code, true));
    assert.equal(existsSync(s.record('pending')), true, 'キューに入ったかもしれないので、hookが取り出せるように残す');
    assert.equal(existsSync(s.record('settled')), true);
    const before = readFileSync(s.record('pending'), 'utf8');
    s.set({ add: 'accept' });
    await assert.rejects(s.submit(), failure('CODEX_DELIVERY_DUPLICATE', false));
    await assert.rejects(s.submit({}, '別の本文'), failure('CODEX_DELIVERY_DUPLICATE', false));
    assert.equal(s.adds(), 1, '2回目は送っていない');
    assert.equal(readFileSync(s.record('pending'), 'utf8'), before, '前の記録に触らない');
    assert.equal(existsSync(s.record('settled')), true);
  }
});

test('受け付けた配送の配送IDも、所有記録が在る間は CODEX_DELIVERY_DUPLICATE で断る', async t => {
  const s = scene(t);
  assert.deepEqual(await s.submit(), { queued_submission_id: 'q-1' });
  await assert.rejects(s.submit(), failure('CODEX_DELIVERY_DUPLICATE', false));
  assert.equal(s.adds(), 1);
});

test('hookが無効な製品では、断られても受け付けられても所有記録を書かない', async t => {
  const s = scene(t);
  const config = JSON.parse(readFileSync(join(s.hooks, 'config.json'), 'utf8'));
  writeFileSync(join(s.hooks, 'config.json'), JSON.stringify({ ...config, enabled: false }));
  s.set({ add: 'reject' });
  await assert.rejects(s.submit(), failure('CODEX_RECEIVER_REJECTED', false));
  s.set({});
  assert.deepEqual(await s.submit(), { queued_submission_id: 'q-1' });
  assert.deepEqual(await s.submit(), { queued_submission_id: 'q-1' }, '所有記録を使わない道では、同じ配送IDを止める物も無い（今までどおり）');
  assert.equal(existsSync(join(s.hooks, 'inputs')), false);
});

test('前の版が残した、断られた配送の所有記録は、会話が動いた時にhookが拾わずに片付ける', async t => {
  const s = scene(t);
  // 0.4.6 までは、断られた配送にも pending と settled が残った。記録に本文は無い（本文のhashだけ）。
  mkdirSync(join(s.inputs, 'pending'), { recursive: true });
  mkdirSync(join(s.inputs, 'settled'), { recursive: true });
  writeFileSync(s.record('pending'), JSON.stringify({ delivery_id: DELIVERY, thread_id: THREAD, text_sha256: answerDigest('返信') }) + '\n');
  writeFileSync(s.record('settled'), JSON.stringify({ delivery_id: DELIVERY }) + '\n');
  s.set({ queue: [{ id: 'q-user', clientUserMessageId: null, input: [{ type: 'text', text: '利用者が入れた文', text_elements: [] }] }] });
  const emitted = [];
  await runCodexResultHook(s.profile, { session_id: THREAD, turn_id: 'turn-1', hook_event_name: 'Stop' }, async value => { emitted.push(value); },
    { directory: s.hooks, codex_home: s.home, runtime: s.runtime() });
  assert.deepEqual(emitted, [{}], '会話へは何も入れない');
  assert.equal(existsSync(s.record('pending')), false);
  assert.equal(existsSync(s.record('settled')), false);
  assert.equal(existsSync(join(s.inputs, 'claims', `${DELIVERY}.json`)), false);
  // 片付いた後は、同じ配送IDで渡し直せる。
  s.set({});
  assert.deepEqual(await s.submit(), { queued_submission_id: 'q-1' });
});

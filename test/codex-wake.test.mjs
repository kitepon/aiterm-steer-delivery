import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readCodexTurnTail, codexThreadUrl, codexThreadOpener, windowsInteractiveSession, wakeCodexParentIfAsleep, readCodexWakeResult, codexWakeWatchEnabled, startCodexWakeWatch,
  serializeWakeProfile, CODEX_WAKE_PAYLOAD_ENV, submitCodexParentAnswer,
} from '../dist/index.js';

const THREAD = '01a120bb-34ce-7dd3-af4b-826acd506a01';
const DELIVERY = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const event = (type, extra = {}) => JSON.stringify({ timestamp: '2026-10-09T12:00:00.000Z', type: 'event_msg', payload: { type, ...extra } });
const item = text => JSON.stringify({ timestamp: '2026-10-09T12:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });

function temp(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('会話の記録の末尾から、最後の番の状態を読む', t => {
  const dir = temp(t, 'steer-wake-tail-');
  const write = (name, lines) => { const file = join(dir, name); writeFileSync(file, lines.join('\n') + '\n'); return file; };
  assert.equal(readCodexTurnTail(write('none.jsonl', [JSON.stringify({ type: 'session_meta', payload: { id: THREAD } })])), 'none', '番が1つも無い');
  assert.equal(readCodexTurnTail(write('done.jsonl', [event('task_started'), item('答え'), event('task_complete')])), 'completed');
  assert.equal(readCodexTurnTail(write('run.jsonl', [event('task_started'), event('task_complete'), event('task_started'), item('途中')])), 'running');
  assert.equal(readCodexTurnTail(write('stop.jsonl', [event('task_started'), event('turn_aborted', { reason: 'interrupted' })])), 'interrupted');
  // 回答や道具の出力に同じ語があっても、番の境とは読まない。
  assert.equal(readCodexTurnTail(write('word.jsonl', [event('task_started'), event('task_complete'), item('task_started と turn_aborted の話')])), 'completed');
  // 境の後ろに、最初に読む範囲（256KiB）より長い行が続いても、さかのぼって読む。
  assert.equal(readCodexTurnTail(write('long.jsonl', [event('task_started'), event('turn_aborted', { reason: 'interrupted' }), item('あ'.repeat(200_000))])), 'interrupted');
  assert.equal(readCodexTurnTail(join(dir, '無い.jsonl')), 'unknown', '読めない時は起こさない側へ倒す');
});

test('開かせるリンクは codex://threads/<会話の番号>', () => {
  assert.equal(codexThreadUrl(THREAD), `codex://threads/${THREAD}`);
  assert.throws(() => codexThreadUrl('../../x'), '番号の形でない物は通さない');
});

// 偽のApp Server。キューと会話の中身は、試験が書き換えるJSONから毎回読む。
const server = `import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const state = JSON.parse(readFileSync(process.env.WAKE_TEST_STATE, 'utf8'));
  const result = message.method === 'thread/queue/list' ? { data: state.queue, nextCursor: null }
    : message.method === 'thread/read' ? { thread: { id: message.params.threadId, source: state.source, path: state.path } } : {};
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
});`;
const entry = (id, delivery) => ({ id, clientUserMessageId: delivery, input: [{ type: 'text', text: '本文', text_elements: [] }] });

function scene(t, { queue, source = 'vscode', tail = [event('task_started'), event('task_complete')] }) {
  const dir = temp(t, 'steer-wake-');
  const script = join(dir, 'app-server.mjs');
  writeFileSync(script, server);
  const rollout = join(dir, 'rollout.jsonl');
  writeFileSync(rollout, tail.join('\n') + '\n');
  const stateFile = join(dir, 'state.json');
  const set = value => writeFileSync(stateFile, JSON.stringify({ source, path: rollout, ...value }));
  set({ queue });
  const profile = { codex_client_name: 'demo', config_root: () => join(dir, 'config'), state_root: () => join(dir, 'state') };
  const parent = { thread_id: THREAD, codex_home: join(dir, 'home') };
  const opened = [];
  const options = extra => ({ delay_ms: 0, confirm_ms: 0, sleep: async () => {}, directory: join(dir, 'wake'),
    runtime: { executable: process.execPath, args: [script], timeout_ms: 10000, env: { ...process.env, WAKE_TEST_STATE: stateFile } },
    open: url => { opened.push(url); return { ok: true }; }, ...extra });
  return { dir, profile, parent, opened, options, set };
}

test('見直した時にキューに無ければ、何も開かない', async t => {
  const s = scene(t, { queue: [entry('q-other', OTHER)] });
  const result = await wakeCodexParentIfAsleep(s.profile, s.parent, DELIVERY, s.options());
  assert.equal(result.outcome, 'delivered');
  assert.deepEqual(s.opened, []);
  assert.deepEqual(readCodexWakeResult(s.profile, DELIVERY, join(s.dir, 'wake')), result, '結果を残す');
  assert.equal(readCodexWakeResult(s.profile, OTHER, join(s.dir, 'wake')), null);
});

test('走っている会話・途中で止められた会話・アプリの会話でない物・状態を読めない会話は、起こさない', async t => {
  for (const [expected, config] of [
    ['running', { tail: [event('task_started')] }],
    ['interrupted', { tail: [event('task_started'), event('turn_aborted', { reason: 'interrupted' })] }],
    ['not_app_thread', { source: 'cli' }],
    ['not_app_thread', { source: { subAgent: { thread_spawn: {} } } }],
  ]) {
    const s = scene(t, { queue: [entry('q-mine', DELIVERY)], ...config });
    const result = await wakeCodexParentIfAsleep(s.profile, s.parent, DELIVERY, s.options());
    assert.equal(result.outcome, expected);
    assert.deepEqual(s.opened, [], `${expected}では開かない`);
    assert.equal(result.opened_at, null);
  }
  const s = scene(t, { queue: [entry('q-mine', DELIVERY)] });
  s.set({ queue: [entry('q-mine', DELIVERY)], path: join(s.dir, '無い.jsonl') });
  assert.equal((await wakeCodexParentIfAsleep(s.profile, s.parent, DELIVERY, s.options())).outcome, 'unknown_state');
  assert.deepEqual(s.opened, []);
});

test('番が普通に終わって寝ている会話は、リンクを開いて起こす', async t => {
  const s = scene(t, { queue: [entry('q-mine', DELIVERY)] });
  const result = await wakeCodexParentIfAsleep(s.profile, s.parent, DELIVERY, s.options({
    open: url => { s.opened.push(url); s.set({ queue: [] }); return { ok: true }; } }));
  assert.equal(result.outcome, 'woken');
  assert.equal(result.turn, 'completed');
  assert.deepEqual(s.opened, [`codex://threads/${THREAD}`]);
  assert.ok(result.opened_at);
});

test('番が1つも無い会話（立てたばかり）も起こす', async t => {
  const s = scene(t, { queue: [entry('q-mine', DELIVERY)], tail: [JSON.stringify({ type: 'session_meta', payload: {} })] });
  const result = await wakeCodexParentIfAsleep(s.profile, s.parent, DELIVERY, s.options({
    open: url => { s.opened.push(url); s.set({ queue: [] }); return { ok: true }; } }));
  assert.equal(result.outcome, 'woken');
  assert.equal(result.turn, 'none');
});

test('前に並んでいた文が先に出た時も、起きたと数える', async t => {
  const s = scene(t, { queue: [entry('q-old', OTHER), entry('q-mine', DELIVERY)] });
  const result = await wakeCodexParentIfAsleep(s.profile, s.parent, DELIVERY, s.options({
    open: url => { s.opened.push(url); s.set({ queue: [entry('q-mine', DELIVERY)] }); return { ok: true }; } }));
  assert.equal(result.outcome, 'woken');
});

test('開いてもキューが動かない時・開けない時・開く口が無い時は、その通りに返す', async t => {
  const still = scene(t, { queue: [entry('q-mine', DELIVERY)] });
  assert.equal((await wakeCodexParentIfAsleep(still.profile, still.parent, DELIVERY, still.options())).outcome, 'opened_still_queued');
  assert.equal(still.opened.length, 1);
  const failed = scene(t, { queue: [entry('q-mine', DELIVERY)] });
  const result = await wakeCodexParentIfAsleep(failed.profile, failed.parent, DELIVERY, failed.options({ open: () => ({ ok: false, detail: 'exit=1' }) }));
  assert.equal(result.outcome, 'open_failed');
  assert.equal(result.detail, 'exit=1');
  const none = scene(t, { queue: [entry('q-mine', DELIVERY)] });
  assert.equal((await wakeCodexParentIfAsleep(none.profile, none.parent, DELIVERY, none.options({ open: null }))).outcome, 'no_opener');
});

test('同じ会話へ続けて届いた時、開くのは1回だけ', async t => {
  const s = scene(t, { queue: [entry('q-mine', DELIVERY), entry('q-next', OTHER)] });
  await wakeCodexParentIfAsleep(s.profile, s.parent, DELIVERY, s.options());
  const second = await wakeCodexParentIfAsleep(s.profile, s.parent, OTHER, s.options());
  assert.equal(s.opened.length, 1, '2通目は開き直さない');
  assert.equal(second.outcome, 'opened_still_queued');
  // 前に開いてから時間がたっていれば、開き直す。
  const stamp = join(s.dir, 'wake', 'threads', `${THREAD}.json`);
  const old = new Date(Date.now() - 120_000);
  utimesSync(stamp, old, old);
  await wakeCodexParentIfAsleep(s.profile, s.parent, OTHER, s.options());
  assert.equal(s.opened.length, 2);
});

test('見張りを起こすのは、リンクを開く口のある環境だけ', () => {
  assert.equal(codexWakeWatchEnabled('darwin', {}), true);
  assert.equal(codexWakeWatchEnabled('win32', {}), true);
  assert.equal(codexWakeWatchEnabled('linux', {}), false, 'Linux（サーバー・コンテナ）');
  // Linuxのアプリは、まだ起こせない。画面があっても見張りを起こさない。
  assert.equal(codexWakeWatchEnabled('linux', { WAYLAND_DISPLAY: 'wayland-0' }), false);
  assert.equal(codexWakeWatchEnabled('linux', { DISPLAY: ':0' }), false);
  assert.equal(codexWakeWatchEnabled('darwin', { AITERM_STEER_CODEX_WAKE: '0' }), false, '利用者が止めた');
  assert.equal(codexWakeWatchEnabled('freebsd', { DISPLAY: ':0' }), false);
});

test('Windowsでは、人の画面のあるsessionの時だけリンクを開く', () => {
  // サービスやsshのsessionは番号0。そこから開いたリンクは、人の画面のアプリへ届かない。
  assert.equal(windowsInteractiveSession({}, () => '0'), false);
  assert.equal(windowsInteractiveSession({ SESSIONNAME: 'Console' }, () => '0'), false, '番号を読めた時は、番号で決める');
  assert.equal(windowsInteractiveSession({}, () => '1\r\n'), true);
  assert.equal(windowsInteractiveSession({}, () => '3'), true);
  // 番号を読めない時（PowerShell 7が無い）は、画面のあるsessionにだけ入る環境変数で見る。
  assert.equal(windowsInteractiveSession({ SESSIONNAME: 'Console' }, () => { throw new Error('no pwsh'); }), true);
  assert.equal(windowsInteractiveSession({}, () => { throw new Error('no pwsh'); }), false);
  assert.equal(windowsInteractiveSession({ SESSIONNAME: 'RDP-Tcp#0' }, () => 'x'), true);
  assert.equal(codexThreadOpener('win32', {}, () => false), null);
  assert.equal(typeof codexThreadOpener('win32', {}, () => true), 'function');
  assert.equal(typeof codexThreadOpener('darwin', {}), 'function');
  assert.equal(codexThreadOpener('linux', {}), null);
  assert.equal(codexThreadOpener('linux', { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }), null, 'Linuxのアプリは、まだ起こせない');
  assert.equal(codexThreadOpener('freebsd', { DISPLAY: ':0' }), null);
});

test('見張りは別のprocessで起き、製品の識別情報と宛先を受け取る', async t => {
  const dir = temp(t, 'steer-wake-spawn-');
  const out = join(dir, 'payload.json');
  const script = join(dir, 'entry.mjs');
  writeFileSync(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.WAKE_TEST_OUT, process.env.${CODEX_WAKE_PAYLOAD_ENV});\n`);
  const profile = { id: 'demo', display_name: 'Demo', setup_command: 'demo-setup', codex_steer_command: 'demo-setup --codex', mcp_server: 'demo',
    dispatch_tools: ['run'], state_root: () => join(dir, 'state'), config_root: () => join(dir, 'config'), hooks: { codex: 'a.js', claude: 'b.js', cursor: 'c.js' },
    codex_client_name: 'demo_client', codex_hook_schema: 'demo.v1', backup_suffix: '.demo-backup', channels: { claude_expiry_notice: 'x' } };
  const parent = { thread_id: THREAD, codex_home: join(dir, 'home') };
  assert.equal(startCodexWakeWatch(profile, parent, DELIVERY, { platform: 'darwin', env: { ...process.env, AITERM_STEER_CODEX_WAKE: '0' }, entry: script }), false);
  assert.equal(startCodexWakeWatch(profile, parent, DELIVERY, { platform: 'linux', env: { PATH: process.env.PATH, DISPLAY: ':0' }, entry: script }), false);
  assert.equal(startCodexWakeWatch(profile, parent, DELIVERY, { platform: 'darwin', env: { ...process.env, WAKE_TEST_OUT: out }, entry: join(dir, '無い.mjs') }), false);
  assert.equal(existsSync(out), false);
  assert.equal(startCodexWakeWatch(profile, parent, DELIVERY, { platform: 'darwin', env: { ...process.env, WAKE_TEST_OUT: out }, entry: script, delay_ms: 5 }), true);
  for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise(resolve => setTimeout(resolve, 50));
  const payload = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(payload, { profile: serializeWakeProfile(profile), parent, delivery_id: DELIVERY, delay_ms: 5 });
  assert.equal(payload.profile.state_root, join(dir, 'state'), '置き場は文字列で渡す');
  assert.equal('channels' in payload.profile, false);
});

test('試験のfixtureを渡した配送では、見張りを起こさない', async t => {
  const dir = temp(t, 'steer-wake-submit-');
  const script = join(dir, 'app-server.mjs');
  // 起きた見張りは、ここへ自分の印を書く（起きなければ何も残らない）。
  writeFileSync(script, `import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  process.stdout.write(JSON.stringify({ id: message.id, result: message.method === 'thread/queue/add' ? { queuedSubmission: { id: 'q-1' } } : {} }) + '\\n');
});`);
  mkdirSync(join(dir, 'config'), { recursive: true });
  const profile = { codex_client_name: 'demo', config_root: () => join(dir, 'config'), state_root: () => join(dir, 'state') };
  const accepted = await submitCodexParentAnswer(profile, { thread_id: THREAD, codex_home: join(dir, 'home') }, DELIVERY, '本文',
    { executable: process.execPath, args: [script], timeout_ms: 10000 });
  assert.deepEqual(accepted, { queued_submission_id: 'q-1' });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(existsSync(join(dir, 'config', 'codex-parent-hooks', 'wake')), false);
});

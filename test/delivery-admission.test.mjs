import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { withDeliveryEffect, DeliveryAdmissionError, serializeWakeProfile,
  submitCodexParentAnswer, prepareCursorDelivery, submitCursorParentAnswer, runCursorReceive,
  handleCursorHook, submitClaudeParentAnswer, runClaudeResultHook } from '../dist/index.js';

const ID = '00000000-0000-4000-8000-000000000001', THREAD = '00000000-0000-4000-8000-000000000002';
const effect = { delivery_ids: [ID], stage: 'emit', vendor: 'codex', endpoint: { thread_id: THREAD } };
const refused = error => error instanceof DeliveryAdmissionError && !error.outcome_unknown;
const profile = admission => ({ id: 'synthetic', setup_command: 'synthetic-setup', dispatch_tools: [],
  state_root: () => '/synthetic/state', config_root: () => '/synthetic/config', delivery_admission: admission });
const fresh = t => { const root = mkdtempSync(join(tmpdir(), 'steer-admission-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };
const pause = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('required admission without its resolver refuses instead of falling back to the native action', async () => {
  let effects = 0;
  await assert.rejects(withDeliveryEffect(profile({ required: true }), effect, () => { effects++; }), refused);
  assert.equal(effects, 0);
});
test('admission fixes refs and endpoint at ingress and returns the actual native receipt', async () => {
  const input = structuredClone(effect), gate = pause(); let captured;
  const running = withDeliveryEffect(profile({ required: true, async run(ref, action) {
    captured = ref; await gate.promise; await action(); return 'substituted-value';
  } }), input, () => 'actual-native-receipt');
  input.delivery_ids[0] = THREAD; input.endpoint.thread_id = ID;
  gate.resolve(); assert.equal(await running, 'actual-native-receipt');
  assert.deepEqual(captured, effect);
});
test('a native refusal swallowed by a runner cannot become a successful receipt or a duplicate effect', async () => {
  let effects = 0;
  await assert.rejects(withDeliveryEffect(profile({ required: true, async run(_, action) {
    try { await action(); } catch {} return 'false-success';
  } }), effect, () => { effects++; throw Error('synthetic native response lost'); }), error => error.outcome_unknown === true);
  assert.equal(effects, 1);
  await assert.rejects(withDeliveryEffect(profile({ required: true, async run(_, action) {
    await action(); try { await action(); } catch {} return 'false-success';
  } }), effect, () => { effects++; return 'native'; }), error => error.outcome_unknown === true);
  assert.equal(effects, 2);
});
test('a runner returning before its native response is unconfirmed, and escaped callbacks cannot act later', async () => {
  const gate = pause();
  await assert.rejects(withDeliveryEffect(profile({ required: true, async run(_, action) { void action(); return 'too-early'; } }), effect,
    () => gate.promise), error => error.outcome_unknown === true);
  gate.resolve(); let escaped, effects = 0;
  await assert.rejects(withDeliveryEffect(profile({ required: true, async run(_, action) { escaped = action; } }), effect,
    () => { effects++; }), refused);
  await assert.rejects(escaped(), refused); assert.equal(effects, 0);
});
test('serialized wake profiles retain required admission and never serialize its resolver into a permissive child', async () => {
  const serialized = JSON.parse(JSON.stringify(serializeWakeProfile(profile({ required: true, async run(_, action) { return action(); } }))));
  assert.deepEqual(serialized.delivery_admission, { required: true });
  await assert.rejects(withDeliveryEffect(serialized, effect, () => assert.fail('must not open a thread')), refused);
});

test('actual Codex queue gate is after synthetic initialization and before the sole queue RPC', async t => {
  const root = fresh(t), script = join(root, 'server.mjs'), trace = join(root, 'trace.jsonl');
  writeFileSync(script, `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
    createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
    appendFileSync(process.env.SYNTHETIC_TRACE,m.method+'\\n');
    process.stdout.write(JSON.stringify({id:m.id,result:m.method==='thread/queue/add'?{queuedSubmission:{id:'existing-native-queue-id'}}:{}})+'\\n');});`);
  const parent = { thread_id: THREAD, codex_home: join(root, 'home') };
  const runtime = { executable: process.execPath, args: [script], env: { ...process.env, SYNTHETIC_TRACE: trace }, wake: false };
  await assert.rejects(submitCodexParentAnswer({ ...profile({ required: true }), codex_client_name: 'synthetic' }, parent, ID, 'synthetic', runtime), refused);
  assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), ['initialize']);
  let seen;
  const result = await submitCodexParentAnswer({ ...profile({ required: true, async run(ref, action) { seen = ref; return action(); } }), codex_client_name: 'synthetic' }, parent, ID, 'synthetic', runtime);
  assert.equal(result.queued_submission_id, 'existing-native-queue-id'); assert.equal(seen.stage, 'queue');
  assert.deepEqual(seen.endpoint, parent);
});
test('Cursor queue write and background stdout each pass an independent effect callback', async t => {
  const root = fresh(t), parent = { kind: 'cursor', hook_root: root }, stages = [];
  const p = profile({ required: true, async run(ref, action) { stages.push(ref.stage); return action(); } });
  prepareCursorDelivery(parent, ID);
  await assert.rejects(submitCursorParentAnswer(parent, ID, 'synthetic', 100, profile({ required: true })), refused);
  assert.equal(existsSync(join(root, 'deliveries', ID, 'answer.json')), false);
  const emitted = [], output = { gone: new Promise(() => {}), probe: async () => true,
    async emit(value) { emitted.push(value); }, close() {} };
  const receiving = runCursorReceive(root, ['--delivery', ID], output, undefined, p);
  await submitCursorParentAnswer(parent, ID, 'synthetic', 1000, p);
  assert.equal(await receiving, 0); assert.deepEqual(stages, ['queue', 'emit']);
  assert.equal(emitted[0].text, 'synthetic');
});
test('Cursor return-value hook has no native output boundary and required admission refuses it', async t => {
  const root = fresh(t);
  await assert.rejects(handleCursorHook(profile({ required: true }), JSON.stringify({ hook_event_name: 'postToolUse', conversation_id: THREAD }), root),
    error => error.delivery_code === 'DELIVERY_ADMISSION_UNSUPPORTED');
});
test('Cursor hook emits exactly once inside the native lease and passes its actual conversation context', async t => {
  const root = fresh(t), parent = { kind: 'cursor', hook_root: root }, output = [], refs = [];
  prepareCursorDelivery(parent, ID);
  writeFileSync(join(root, 'deliveries', ID, 'answer.json'), JSON.stringify({ delivery_id: ID, text: 'synthetic hook answer' }));
  const p = { ...profile({ required: true, async run(ref, action) { refs.push(ref); return action(); } }), dispatch_tools: ['pty_send'] };
  await handleCursorHook(p, JSON.stringify({ hook_event_name: 'afterMCPExecution', conversation_id: THREAD, tool_name: 'pty_send',
    result_json: { parent_delivery: { delivery_id: ID } } }), root);
  const result = await handleCursorHook(p, JSON.stringify({ hook_event_name: 'postToolUse', conversation_id: THREAD }), root,
    async value => { output.push(value); });
  assert.deepEqual(result, {}); assert.deepEqual(output, [{ additional_context: 'synthetic hook answer' }]);
  assert.deepEqual(refs[0].native_context, { conversation_id: THREAD, hook_event_name: 'postToolUse' });
  assert.deepEqual(refs[0].delivery_ids, [ID]);
});
test('a refused Cursor hook leaves explicit failure instead of later claiming the answer was delivered', async t => {
  const root = fresh(t), parent = { kind: 'cursor', hook_root: root };
  prepareCursorDelivery(parent, ID);
  writeFileSync(join(root, 'deliveries', ID, 'answer.json'), JSON.stringify({ delivery_id: ID, text: 'synthetic' }));
  const p = { ...profile({ required: true }), dispatch_tools: ['pty_send'] };
  await handleCursorHook(p, JSON.stringify({ hook_event_name: 'afterMCPExecution', conversation_id: THREAD, tool_name: 'pty_send',
    result_json: { parent_delivery: { delivery_id: ID } } }), root);
  let emitted = 0;
  await assert.rejects(handleCursorHook(p, JSON.stringify({ hook_event_name: 'postToolUse', conversation_id: THREAD }), root,
    async () => { emitted++; }), refused);
  assert.equal(emitted, 0);
  await assert.rejects(runCursorReceive(root, ['--delivery', ID], () => { emitted++; }, undefined, p),
    error => error.delivery_code === 'CURSOR_PARENT_DELIVERY_UNCONFIRMED');
  assert.equal(emitted, 0);
});

function claude(t) {
  const root = fresh(t), dir = join(root, 'toolu_existing'); mkdirSync(dir);
  const parent = { kind: 'claude', request_id: 'toolu_existing', session_id: THREAD, hook_root: root };
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ request_id: parent.request_id, session_id: THREAD,
    agent_id: null, parent_pid: 12345, parent_started_identity: 'synthetic-parent-start' }));
  writeFileSync(join(dir, 'delivery.json'), JSON.stringify({ delivery_id: ID }));
  return { root, dir, parent };
}
test('Claude queue refusal precedes answer publication, and emit refusal does not write a sending marker', async t => {
  const c = claude(t), p = profile({ required: true });
  await assert.rejects(submitClaudeParentAnswer(p, c.parent, ID, 'synthetic', { processes: () => [] }), refused);
  assert.equal(existsSync(join(c.dir, 'answer.json')), false);
  writeFileSync(join(c.dir, 'answer.json'), JSON.stringify({ delivery_id: ID, text: 'synthetic' }));
  let effects = 0;
  await assert.rejects(runClaudeResultHook(p, { session_id: THREAD, tool_use_id: c.parent.request_id }, () => { effects++; }, c.root,
    { identity: () => 'synthetic-hook-start', parentAlive() {}, resume() {} }), refused);
  assert.equal(effects, 0); assert.equal(existsSync(join(c.dir, 'sending.json')), false);
  assert.equal(JSON.parse(readFileSync(join(c.dir, 'failed.json'), 'utf8')).outcome_unknown, false);
});
test('actual Claude emit callback runs within admission using only synthetic native identity evidence', async t => {
  const c = claude(t), phases = [], output = [];
  writeFileSync(join(c.dir, 'answer.json'), JSON.stringify({ delivery_id: ID, text: 'synthetic' }));
  const result = await runClaudeResultHook(profile({ required: true, async run(ref, action) { phases.push(ref.stage); return action(); } }),
    { session_id: THREAD, tool_use_id: c.parent.request_id }, text => { output.push(text); }, c.root,
    { identity: () => 'synthetic-hook-start', parentAlive() {}, resume(code) { assert.equal(code, 2); } });
  assert.equal(result, 2); assert.deepEqual(output, ['synthetic']); assert.deepEqual(phases, ['emit', 'wake']);
});
test('guarded Claude main never turns an admission failure into the exit-2 resume signal', t => {
  const root = fresh(t), script = join(root, 'hook.mjs');
  writeFileSync(script, `import {runClaudeHookMain} from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist/index.js')).href)};
    await runClaudeHookMain({delivery_admission:{required:true},channels:{}},${JSON.stringify(root)});`);
  const result = spawnSync(process.execPath, [script], { input: JSON.stringify({ hook_event_name: 'PostToolUse' }), encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
});

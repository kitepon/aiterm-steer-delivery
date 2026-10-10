import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  openChannel, sendToChannel, channelDeliveryState, receiveFromChannel, runClaudeChannelWaiter, closeClaudeSessionChannels,
  handleCursorChannelHook, channelMarker, channelIdFromResult, closeChannel, readRuntimeProcesses,
} from '../dist/index.js';

function profile(root) {
  return {
    id: 'demo', display_name: 'Demo', setup_command: 'demo-setup', codex_steer_command: 'demo-setup --codex-steer enable',
    mcp_server: 'demo', dispatch_tools: ['join'], state_root: () => root, config_root: () => join(root, 'config'),
    hooks: { codex: 'demo-codex-hook.js', claude: 'demo-claude-hook.js', cursor: 'demo-cursor-hook.js' },
    codex_client_name: 'demo', codex_hook_schema: 'demo.codex-parent-hooks.v1', backup_suffix: '.demo-backup', channels: {},
  };
}
const fresh = t => { const root = mkdtempSync(join(tmpdir(), 'steer-channel-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };

function claudeParent(root, session) {
  const hookRoot = join(root, 'claude-parent-hooks'), request = `toolu_${randomUUID().replace(/-/g, '')}`;
  const self = readRuntimeProcesses().find(row => row.pid === process.pid);
  mkdirSync(join(hookRoot, request), { recursive: true });
  writeFileSync(join(hookRoot, request, 'request.json'), JSON.stringify({ request_id: request, session_id: session, agent_id: null, parent_pid: process.pid, parent_started_identity: self.started_identity }));
  return { kind: 'claude', request_id: request, session_id: session, hook_root: hookRoot };
}

test('背景受信は到着順に受け取り、受け取った本文をemittedにする', async t => {
  const p = profile(fresh(t));
  const channel = openChannel(p, null);
  const first = randomUUID(), second = randomUUID();
  assert.deepEqual(await sendToChannel(p, channel.channel_id, first, '一通目\n改行'), { state: 'queued', queued_submission_id: null });
  await new Promise(r => setTimeout(r, 5));
  await sendToChannel(p, channel.channel_id, second, '二通目');
  assert.equal(channelDeliveryState(p, channel.channel_id, first), 'queued');
  const result = await receiveFromChannel(p, channel.channel_id, { poll_ms: 10 });
  assert.equal(result.outcome, 'delivered');
  assert.deepEqual(result.deliveries.map(d => d.text), ['一通目\n改行', '二通目']);
  assert.equal(channelDeliveryState(p, channel.channel_id, first), 'emitted');
  assert.equal((await receiveFromChannel(p, channel.channel_id, { wait_ms: 30, poll_ms: 10 })).outcome, 'timeout');
  await assert.rejects(sendToChannel(p, channel.channel_id, first, '再送'), /CHANNEL_DELIVERY_DUPLICATE/);
});

test('受信processは本文が届くまで待ち、閉じたら終わる', async t => {
  const p = profile(fresh(t));
  const channel = openChannel(p, null);
  const waiting = receiveFromChannel(p, channel.channel_id, { poll_ms: 10 });
  await new Promise(r => setTimeout(r, 50));
  await sendToChannel(p, channel.channel_id, randomUUID(), '後から届く');
  assert.deepEqual((await waiting).deliveries.map(d => d.text), ['後から届く']);
  const closing = receiveFromChannel(p, channel.channel_id, { poll_ms: 10 });
  closeChannel(p, channel.channel_id);
  assert.equal((await closing).outcome, 'closed');
  await assert.rejects(sendToChannel(p, channel.channel_id, randomUUID(), 'x'), /CHANNEL_CLOSED/);
});

test('Claudeは会話ごとに待機を1つだけ張り、2通目以降も次の待機で届く', async t => {
  const root = fresh(t), p = profile(root), session = randomUUID();
  const channel = openChannel(p, claudeParent(root, session));
  const out = [];
  const waiter = runClaudeChannelWaiter(p, { session_id: session }, text => { out.push(text); }, { poll_ms: 10 });
  await new Promise(r => setTimeout(r, 50));
  // 生きている待機があれば、別のhookは待たずに終わる。
  assert.equal(await runClaudeChannelWaiter(p, { session_id: session }, () => assert.fail('二重の待機'), { poll_ms: 10 }), 0);
  const id = randomUUID();
  await sendToChannel(p, channel.channel_id, id, 'roomの発言');
  assert.equal(await waiter, 2);
  assert.deepEqual(out, ['roomの発言']);
  assert.equal(channelDeliveryState(p, channel.channel_id, id), 'emitted');
  // turn終了（Stop）で張り直した待機が次を受け取る。
  await sendToChannel(p, channel.channel_id, randomUUID(), '二通目');
  assert.equal(await runClaudeChannelWaiter(p, { session_id: session }, text => { out.push(text); }, { poll_ms: 10 }), 2);
  assert.deepEqual(out, ['roomの発言', '二通目']);
});

// channelを開いた時のprocessが居ない形の依頼元を作る（Claude Codeが起動し直した後の、前のprocessの記録）。
function deadClaudeParent(root, session) {
  const parent = claudeParent(root, session);
  const file = join(parent.hook_root, parent.request_id, 'request.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), parent_started_identity: '居ないprocessの開始時刻' }));
  return parent;
}
const self = () => { const row = readRuntimeProcesses().find(entry => entry.pid === process.pid); return { pid: row.pid, started_identity: row.started_identity }; };

test('Claudeが起動し直して同じ会話を再開した後も、前のprocessが開いたchannelの本文が今のprocessへ届く', async t => {
  const root = fresh(t), p = profile(root), session = randomUUID();
  const channel = openChannel(p, deadClaudeParent(root, session));
  const before = randomUUID(), after = randomUUID();
  await sendToChannel(p, channel.channel_id, before, '起動し直す前から残っていた答え');
  const out = [];
  // 今のhookを起こしたprocessは生きている（この試験のprocessを、そのprocessとして渡す）。
  assert.equal(await runClaudeChannelWaiter(p, { session_id: session }, text => { out.push(text); }, { poll_ms: 10, owner: self() }), 2);
  assert.deepEqual(out, ['起動し直す前から残っていた答え']);
  assert.equal(channelDeliveryState(p, channel.channel_id, before), 'emitted');
  // 次の待機は、後から届く本文も待って受け取る（すぐには終わらない）。
  const waiter = runClaudeChannelWaiter(p, { session_id: session }, text => { out.push(text); }, { poll_ms: 10, owner: self() });
  await new Promise(r => setTimeout(r, 80));
  await sendToChannel(p, channel.channel_id, after, '起動し直した後に届いた答え');
  assert.equal(await waiter, 2);
  assert.deepEqual(out, ['起動し直す前から残っていた答え', '起動し直した後に届いた答え']);
  // 前のprocessが開いたchannelと、今のprocessが開いたchannelの両方から引き取る。別の会話のchannelからは取らない。
  const current = openChannel(p, claudeParent(root, session));
  const other = openChannel(p, claudeParent(root, randomUUID()));
  const elsewhere = randomUUID();
  await sendToChannel(p, channel.channel_id, randomUUID(), '古いchannelへ');
  await sendToChannel(p, current.channel_id, randomUUID(), '新しいchannelへ');
  await sendToChannel(p, other.channel_id, elsewhere, '別の会話へ');
  out.length = 0;
  assert.equal(await runClaudeChannelWaiter(p, { session_id: session }, text => { out.push(text); }, { poll_ms: 10, owner: self() }), 2);
  assert.deepEqual(out, ['古いchannelへ\n\n新しいchannelへ']);
  assert.equal(channelDeliveryState(p, other.channel_id, elsewhere), 'queued');
});

test('hookを起こしたClaude processが居なくなっていたら、本文を取らずに待機を終える', async t => {
  const root = fresh(t), p = profile(root), session = randomUUID();
  // channelを開いたprocessは生きている（別のprocessが同じ会話を持っている形）。出す先のprocessが居ないので、取らない。
  const channel = openChannel(p, claudeParent(root, session));
  const id = randomUUID();
  await sendToChannel(p, channel.channel_id, id, '取らない');
  const gone = { pid: process.pid, started_identity: '居ないprocessの開始時刻' };
  assert.equal(await runClaudeChannelWaiter(p, { session_id: session }, () => assert.fail('出す先が居ない'), { poll_ms: 10, owner: gone }), 0);
  assert.equal(channelDeliveryState(p, channel.channel_id, id), 'queued');
});

test('hookを起こしたprocessを確かめられない時は、channelを開いた時のprocessの生き死にで決める', async t => {
  const root = fresh(t), p = profile(root), session = randomUUID();
  const dead = openChannel(p, deadClaudeParent(root, session));
  const id = randomUUID();
  await sendToChannel(p, dead.channel_id, id, '取らない');
  assert.equal(await runClaudeChannelWaiter(p, { session_id: session }, () => assert.fail('依頼元が居ない'), { poll_ms: 10, owner: null }), 0);
  assert.equal(channelDeliveryState(p, dead.channel_id, id), 'queued');
  // 生きているprocessが開いたchannelが1つでもあれば、今までどおり待って受け取る。
  openChannel(p, claudeParent(root, session));
  const out = [];
  assert.equal(await runClaudeChannelWaiter(p, { session_id: session }, text => { out.push(text); }, { poll_ms: 10, owner: null }), 2);
  assert.deepEqual(out, ['取らない']);
});

test('Claudeの出力に失敗した本文はunknownとして残し、再送しない', async t => {
  const root = fresh(t), p = profile(root), session = randomUUID();
  const channel = openChannel(p, claudeParent(root, session));
  const id = randomUUID();
  await sendToChannel(p, channel.channel_id, id, '失敗する');
  await assert.rejects(runClaudeChannelWaiter(p, { session_id: session }, () => { throw new Error('EPIPE'); }, { poll_ms: 10 }), /EPIPE/);
  assert.equal(channelDeliveryState(p, channel.channel_id, id), 'unknown');
  assert.equal(await runClaudeChannelWaiter(p, { session_id: session }, () => assert.fail('再送'), { wait_ms: 30, poll_ms: 10 }), 0);
});

test('Claudeの期限では案内文で親を起こし、SessionEndでchannelを閉じる', async t => {
  const root = fresh(t), p = { ...profile(root), channels: { claude_expiry_notice: '受信を張り直してください' } }, session = randomUUID();
  const channel = openChannel(p, claudeParent(root, session));
  const out = [];
  assert.equal(await runClaudeChannelWaiter(p, { session_id: session }, text => { out.push(text); }, { wait_ms: 20, poll_ms: 10 }), 2);
  assert.deepEqual(out, ['受信を張り直してください']);
  closeClaudeSessionChannels(p, { session_id: session });
  await assert.rejects(sendToChannel(p, channel.channel_id, randomUUID(), 'x'), /CHANNEL_CLOSED/);
  assert.equal(await runClaudeChannelWaiter(p, { session_id: session }, () => assert.fail('閉じた会話'), { poll_ms: 10 }), 0);
});

test('Cursorはtool結果の印で会話へ結び、次のtool返りで差し込む。hookが取った本文は背景受信で重複しない', async t => {
  const p = profile(fresh(t));
  const channel = openChannel(p, { kind: 'cursor' });
  const marker = channelMarker(channel);
  assert.equal(channelIdFromResult({ structuredContent: marker.structured }), channel.channel_id);
  assert.equal(channelIdFromResult({ content: [{ type: 'text', text: `ok\n${marker.text}` }] }), channel.channel_id);
  const conv = 'conv-1';
  await handleCursorChannelHook(p, { hook_event_name: 'afterMCPExecution', conversation_id: conv, tool_name: 'MCP:join', result_json: JSON.stringify({ structuredContent: marker.structured }) }, () => assert.fail('束縛だけ'));
  const id = randomUUID();
  await sendToChannel(p, channel.channel_id, id, '作業中に届く');
  const out = [];
  // 別の会話には差し込まない。
  assert.equal(await handleCursorChannelHook(p, { hook_event_name: 'postToolUse', conversation_id: 'conv-2', tool_output: '{}' }, () => assert.fail('別会話')), false);
  assert.equal(await handleCursorChannelHook(p, { hook_event_name: 'postToolUse', conversation_id: conv, tool_output: '{}' }, text => { out.push(text); }), true);
  assert.deepEqual(out, ['作業中に届く']);
  assert.equal(channelDeliveryState(p, channel.channel_id, id), 'emitted');
  const receiving = receiveFromChannel(p, channel.channel_id, { poll_ms: 10 });
  await sendToChannel(p, channel.channel_id, randomUUID(), 'idle中に届く');
  assert.deepEqual((await receiving).deliveries.map(d => d.text), ['idle中に届く']);
});

test('未取得の本文だけを取り下げられる', async t => {
  const { withdrawFromChannel } = await import('../dist/index.js');
  const p = profile(fresh(t));
  const channel = openChannel(p, null);
  const a = randomUUID(), b = randomUUID();
  await sendToChannel(p, channel.channel_id, a, 'A');
  assert.equal(withdrawFromChannel(p, channel.channel_id, a), true);
  assert.equal(channelDeliveryState(p, channel.channel_id, a), 'withdrawn');
  await sendToChannel(p, channel.channel_id, b, 'B');
  await receiveFromChannel(p, channel.channel_id, { poll_ms: 10 });
  assert.equal(withdrawFromChannel(p, channel.channel_id, b), false);
  assert.equal(channelDeliveryState(p, channel.channel_id, b), 'emitted');
});

test('同じミリ秒に送った本文も送った順に受け取る', async t => {
  const p = profile(fresh(t));
  const channel = openChannel(p, null);
  const texts = Array.from({ length: 50 }, (_, i) => `本文${i}`);
  for (const text of texts) await sendToChannel(p, channel.channel_id, randomUUID(), text);
  const result = await receiveFromChannel(p, channel.channel_id, { poll_ms: 10 });
  assert.deepEqual(result.deliveries.map(d => d.text), texts);
});

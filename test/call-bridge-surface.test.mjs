import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as api from '../dist/index.js';

// 通話MCP（call-bridge、kitepon/grokbot-bridge 0.3.0〜）は、端末にグローバルで入っているこのパッケージの dist/index.js を
// 絶対pathでimportして、下の関数を直接呼ぶ。置き場のfileと符号も読む。ここが落ちる変更は、出す前にcall-bridgeの担当へ知らせる。
const CALLED = [
  'runClaudeHookMain', 'claudeParentFromRequest', 'claudeHookRoot',
  'openChannel', 'readChannel', 'sendToChannel', 'channelDeliveryState', 'channelClosed', 'withdrawFromChannel', 'closeChannel',
  'readRuntimeProcesses', 'mergeClaudeParentHooks', 'removeClaudeParentHooks', 'claudeParentHooksRegistered', 'claudeParentHookScripts',
  'setupNodeExecutable',
  // 0.3.2〜: CursorとGrokの会話へも返信を渡す。
  'isCursorMcpClient', 'cursorParentFromRequest', 'cursorHookRoot', 'cursorHooksFile',
  'mergeCursorParentHooks', 'removeCursorParentHooks', 'cursorParentHooksRegistered', 'runCursorHookMain',
  'channelReceiveProcess', 'waitProcessCommandLine', 'runChannelReceiveMain',
];

function profile(root) {
  return {
    id: 'call-bridge', display_name: 'call-bridge', setup_command: 'call-bridge-setup', codex_steer_command: 'call-bridge-setup --codex-steer enable',
    mcp_server: 'call-bridge', dispatch_tools: ['call_open', 'call_adopt'], state_root: () => root, config_root: () => join(root, 'config'),
    hooks: { codex: 'call-bridge-codex-hook.mjs', claude: 'call-bridge-claude-hook.mjs', cursor: 'call-bridge-cursor-hook.mjs' },
    codex_client_name: 'call_bridge', codex_hook_schema: 'call-bridge.codex-parent-hooks.v1', backup_suffix: '.call-bridge-backup', channels: {},
  };
}
const fresh = t => { const root = mkdtempSync(join(tmpdir(), 'steer-call-bridge-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };
const code = name => error => error instanceof api.ChannelError && error.delivery_code === name;

test('call-bridgeが直接呼ぶ関数は、パッケージの入口から関数として出ている', () => {
  assert.deepEqual(CALLED.filter(name => typeof api[name] !== 'function'), []);
});

test('call-bridgeが読む符号: 無いchannelはCHANNEL_UNKNOWN、閉じた後はCHANNEL_CLOSED、同じ配送IDはCHANNEL_DELIVERY_DUPLICATE', async t => {
  const p = profile(fresh(t));
  assert.throws(() => api.readChannel(p, randomUUID()), code('CHANNEL_UNKNOWN'));
  const channel = api.openChannel(p, null);
  const delivery = randomUUID();
  await api.sendToChannel(p, channel.channel_id, delivery, '返信');
  await assert.rejects(api.sendToChannel(p, channel.channel_id, delivery, '返信'), code('CHANNEL_DELIVERY_DUPLICATE'));
  assert.equal(api.channelClosed(p, channel.channel_id), false);
  api.closeChannel(p, channel.channel_id);
  assert.equal(api.channelClosed(p, channel.channel_id), true);
  await assert.rejects(api.sendToChannel(p, channel.channel_id, randomUUID(), '返信'), code('CHANNEL_CLOSED'));
});

test('call-bridgeが読む置き場: 取り下げた本文は claims/<配送ID>.json に state: withdrawn で残る', async t => {
  const p = profile(fresh(t));
  const channel = api.openChannel(p, null);
  const delivery = randomUUID();
  await api.sendToChannel(p, channel.channel_id, delivery, '返信');
  assert.equal(api.withdrawFromChannel(p, channel.channel_id, delivery), true);
  const claim = JSON.parse(readFileSync(join(api.channelRoot(p), channel.channel_id, 'claims', `${delivery}.json`), 'utf8'));
  assert.equal(claim.delivery_id, delivery);
  assert.equal(claim.state, 'withdrawn');
  assert.equal(api.channelDeliveryState(p, channel.channel_id, delivery), 'withdrawn');
  // 取り下げた配送IDは、同じchannelへもう一度は送れない。
  await assert.rejects(api.sendToChannel(p, channel.channel_id, delivery, '返信'), code('CHANNEL_DELIVERY_DUPLICATE'));
});

test('call-bridgeが読む置き場: Cursorの親のchannelは kind: cursor、親を特定しないchannel（Grok）は kind: background で、取られる前は queued', async t => {
  const p = profile(fresh(t));
  for (const [parent, kind] of [[{ kind: 'cursor' }, 'cursor'], [null, 'background']]) {
    const channel = api.openChannel(p, parent);
    const delivery = randomUUID();
    assert.deepEqual(await api.sendToChannel(p, channel.channel_id, delivery, '返信'), { state: 'queued', queued_submission_id: null });
    assert.equal(api.channelDeliveryState(p, channel.channel_id, delivery), 'queued');
    assert.equal(api.readChannel(p, channel.channel_id).kind, kind);
  }
});

test('call-bridgeの結び方: 道具の返りの上の段の steer_channel: {channel_id} で、afterMCPExecution がCursorの会話へ結ぶ', async t => {
  const p = profile(fresh(t));
  const channel = api.openChannel(p, { kind: 'cursor' });
  const conversation = randomUUID();
  await api.handleCursorChannelHook(p, { hook_event_name: 'afterMCPExecution', conversation_id: conversation, tool_name: 'MCP:call_open',
    result_json: JSON.stringify({ steer_channel: { channel_id: channel.channel_id } }) }, () => assert.fail('結ぶだけ'));
  await api.sendToChannel(p, channel.channel_id, randomUUID(), '作業中に届く返信');
  const out = [];
  assert.equal(await api.handleCursorChannelHook(p, { hook_event_name: 'postToolUse', conversation_id: conversation, tool_output: '{}' }, text => { out.push(text); }), true);
  assert.deepEqual(out, ['作業中に届く返信']);
});

test('call-bridgeの待ち受け: 受信の命令は、受け取ると1行のJSON（outcome・deliveries[].text・next_wait_process）を出して0で終わる', async t => {
  const root = fresh(t), p = profile(root);
  const script = join(root, 'call-bridge-channel-receive.mjs');
  writeFileSync(script, `import { runChannelReceiveMain } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist', 'index.js')).href)};
    const root = ${JSON.stringify(root)};
    await runChannelReceiveMain({ ...${JSON.stringify(p)}, state_root: () => root, config_root: () => root + '/config' });\n`);
  const channel = api.openChannel(p, null);
  const delivery = randomUUID();
  await api.sendToChannel(p, channel.channel_id, delivery, '返信\n2行目');
  const wait = api.channelReceiveProcess(script, channel.channel_id);
  assert.deepEqual(wait.args, [script, '--channel', channel.channel_id]);
  assert.equal(typeof api.waitProcessCommandLine(wait), 'string');
  assert.equal(api.waitProcessCommandLine(wait).includes('\n'), false);
  const run = spawnSync(wait.executable, wait.args, { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const result = JSON.parse(lines[0]);
  assert.equal(result.outcome, 'delivered');
  assert.deepEqual(result.deliveries.map(item => item.text), ['返信\n2行目']);
  assert.deepEqual(result.next_wait_process.args, wait.args);
  assert.equal(typeof result.next_wait_process.executable, 'string');
  assert.equal(api.channelDeliveryState(p, channel.channel_id, delivery), 'emitted');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as api from '../dist/index.js';

// 通話MCP（call-bridge、kitepon/grokbot-bridge 0.3.0〜）は、端末にグローバルで入っているこのパッケージの dist/index.js を
// 絶対pathでimportして、下の関数を直接呼ぶ。置き場のfileと符号も読む。ここが落ちる変更は、出す前にcall-bridgeの担当へ知らせる。
const CALLED = [
  'runClaudeHookMain', 'claudeParentFromRequest', 'claudeHookRoot',
  'openChannel', 'readChannel', 'sendToChannel', 'channelDeliveryState', 'channelClosed', 'withdrawFromChannel', 'closeChannel',
  'readRuntimeProcesses', 'mergeClaudeParentHooks', 'removeClaudeParentHooks', 'claudeParentHooksRegistered', 'claudeParentHookScripts',
  'setupNodeExecutable',
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

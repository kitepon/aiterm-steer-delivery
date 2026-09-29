import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planCodexParentHooks, applyCodexHookPlan, withCodexReceiver } from '../dist/index.js';

// 公式Codexで、hookの鍵（位置）と承認の関係を確かめる。Codexが無い環境では飛ばす。
const codex = process.env.STEER_TEST_CODEX_BINARY ?? (spawnSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { encoding: 'utf8' }).stdout ?? '').split(/\r?\n/)[0];
const profile = root => ({ id: 'demo', display_name: 'Demo', setup_command: 'demo-setup', codex_steer_command: 'demo-setup --steer', mcp_server: 'demo', dispatch_tools: ['x'],
  state_root: () => root, config_root: () => root, hooks: { codex: 'demo-codex-hook.js', claude: 'c.js', cursor: 'u.js' },
  codex_client_name: 'demo', codex_hook_schema: 'demo.v1', backup_suffix: '.demo-backup' });

test('自製品のhookを外しても、後ろの他製品のhookの承認（有効・無効を含む）は位置と一緒に移る', { skip: !codex && 'Codexがありません' }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'steer-trust-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const group = command => ({ matcher: '.*', hooks: [{ type: 'command', command, timeout: 5 }] });
  writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks: {
    PostToolUse: [group('echo other-a'), group('echo mine'), group('echo other-c'), group('echo other-d')],
    Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }, { hooks: [{ type: 'command', command: 'echo other-s' }] }],
  } }));
  const rpc = action => withCodexReceiver(profile(home), { thread_id: '00000000-0000-4000-8000-000000000000', codex_home: home }, action, { executable: codex });
  const list = () => rpc(request => request('hooks/list', { cwds: [home] })).then(result => result.data[0].hooks);
  // 利用者の承認: other-dだけは承認した上で無効にしてある。
  const hooks = await list();
  const edits = hooks.flatMap(hook => [
    { keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, value: hook.currentHash, mergeStrategy: 'replace' },
    { keyPath: `hooks.state.${JSON.stringify(hook.key)}.enabled`, value: hook.command !== 'echo other-d', mergeStrategy: 'replace' },
  ]);
  await rpc(request => request('config/batchWrite', { edits, filePath: join(home, 'config.toml') }));
  const plan = planCodexParentHooks(join(home, 'hooks.json'), null, 'echo mine');
  assert.deepEqual(plan.moves.map(move => [move.event, move.from, move.to]), [
    ['PostToolUse', [2, 0], [1, 0]], ['PostToolUse', [3, 0], [2, 0]], ['Stop', [1, 0], [0, 0]],
  ]);
  assert.equal(await applyCodexHookPlan(profile(home), plan, home, codex), true);
  const after = await list();
  assert.deepEqual(after.map(hook => [hook.command, hook.trustStatus, hook.enabled]), [
    ['echo other-a', 'trusted', true], ['echo other-c', 'trusted', true], ['echo other-d', 'trusted', false], ['echo other-s', 'trusted', true],
  ]);
  // 空いた位置の承認は残さない。
  const config = readFileSync(join(home, 'config.toml'), 'utf8');
  assert.doesNotMatch(config, /post_tool_use:3:0/u);
  assert.doesNotMatch(config, /stop:1:0/u);
});

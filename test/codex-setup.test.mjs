import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureCodexSteer, readCodexHookConfig } from '../dist/index.js';

const fresh = t => { const dir = mkdtempSync(join(tmpdir(), 'steer-codex-setup-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const profile = root => ({ id: 'demo', display_name: 'Demo', setup_command: 'demo-setup', codex_steer_command: 'demo-setup --steer', mcp_server: 'demo', dispatch_tools: ['x'],
  state_root: () => join(root, 'state'), config_root: () => join(root, 'config'), hooks: { codex: 'demo-codex-hook.js', claude: 'c.js', cursor: 'u.js' },
  codex_client_name: 'demo', codex_hook_schema: 'demo.codex-parent-hooks.v1', backup_suffix: '.demo-backup' });

test('Windowsの表記ゆれ（区切り・大文字小文字・引用符）も再起動待ちにする', { skip: process.platform !== 'win32' }, async t => {
  const root = fresh(t), home = join(root, 'codex'); mkdirSync(home);
  const hook = join(root, 'demo-codex-hook.js'); writeFileSync(hook, '');
  const binary = 'C:/Program Files/Codex/codex.exe';
  const rows = [
    { pid: 10, started_identity: 'a', parent_pid: 1, command: String.raw`"C:\Program Files\Codex\codex.exe" app-server` },
    { pid: 11, started_identity: 'b', parent_pid: 1, command: String.raw`c:\old\codex.exe` },
    { pid: 12, started_identity: 'c', parent_pid: 1, command: String.raw`C:\Program Files\Codex\codex-other.exe` },
  ];
  let prepared = null;
  const result = await configureCodexSteer(profile(root), 'enable', { hook, platform: 'win32', codex_home: home, node: process.execPath,
    findBinary: () => binary, processes: () => rows, legacy: () => ({ enabled: true, binary: 'C:/old/codex.exe' }),
    disableLegacy: async () => ({ status: 'disabled' }), verify: async () => {}, prepareDirectory: directory => { prepared = directory; } });
  assert.equal(result.status, 'restart_required');
  const config = readCodexHookConfig(profile(root));
  assert.deepEqual(config.stale_processes.map(row => row.pid), [10, 11]);
  assert.equal(prepared, join(root, 'config', 'codex-parent-hooks'));
  assert.equal(config.schema, 'demo.codex-parent-hooks.v1');
  const hooks = JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8')).hooks;
  assert.equal(hooks.PostToolUse[0].hooks[0].command, config.command);
});

test('LinuxでもSteerを有効にできる（Desktopが無ければCodex CLI）', async t => {
  const root = fresh(t), home = join(root, 'codex'); mkdirSync(home);
  const hook = join(root, 'demo-codex-hook.js'); writeFileSync(hook, '');
  const result = await configureCodexSteer(profile(root), 'enable', { hook, platform: 'linux', codex_home: home, node: process.execPath,
    findBinary: () => '/home/u/.local/bin/codex', processes: () => [], legacy: () => null, verify: async () => {} });
  assert.deepEqual(result, { status: 'ready' });
  assert.equal(readCodexHookConfig(profile(root)).binary, '/home/u/.local/bin/codex');
});

test('Desktopが見つからなければCodex CLIを使い、どちらも無ければDesktopの理由で断る', async () => {
  const { findSteerBinary, SetupError } = await import('../dist/index.js');
  const missing = () => { throw new SetupError('codex_desktop_not_identified', 'no desktop'); };
  assert.equal(findSteerBinary(() => '/Applications/Codex.app/codex', () => assert.fail('CLIは使わない')), '/Applications/Codex.app/codex');
  assert.equal(findSteerBinary(missing, () => '/opt/homebrew/bin/codex'), '/opt/homebrew/bin/codex');
  assert.throws(() => findSteerBinary(missing, () => { throw new SetupError('codex_binary_unavailable', 'none'); }), error => error.code === 'codex_desktop_not_identified');
  assert.throws(() => findSteerBinary(missing, () => { throw new SetupError('codex_version_unsupported', 'old'); }), error => error.code === 'codex_version_unsupported');
});

test('npm版のCodex CLI（node …/codex.js とnative本体）も再起動待ちとして照合する', async t => {
  const root = fresh(t), home = join(root, 'codex'); mkdirSync(home);
  const hook = join(root, 'demo-codex-hook.js'); writeFileSync(hook, '');
  const { symlinkSync, realpathSync } = await import('node:fs');
  const made = join(root, 'lib', 'node_modules', '@openai', 'codex'); mkdirSync(join(made, 'bin'), { recursive: true });
  writeFileSync(join(made, 'bin', 'codex.js'), '');
  mkdirSync(join(root, 'bin')); symlinkSync(join(made, 'bin', 'codex.js'), join(root, 'bin', 'codex'));
  // nodeはpackageの中を実体のpath（macOSの/var→/private/var等）で動かす。起動はsymlinkのpathのこともある。
  const pkg = realpathSync(made);
  const rows = [
    { pid: 21, started_identity: 'a', parent_pid: 1, command: `node ${join(pkg, 'bin', 'codex.js')} resume` },
    { pid: 22, started_identity: 'b', parent_pid: 21, command: `${join(pkg, 'node_modules', '@openai', 'codex-linux-x64', 'vendor', 'x', 'codex', 'codex')}` },
    { pid: 24, started_identity: 'd', parent_pid: 1, command: `node ${join(root, 'bin', 'codex')}` },
    { pid: 23, started_identity: 'c', parent_pid: 1, command: 'node /other/tool.js' },
  ];
  const result = await configureCodexSteer(profile(root), 'enable', { hook, platform: process.platform, codex_home: home, node: process.execPath,
    findBinary: () => join(root, 'bin', 'codex'), processes: () => rows, legacy: () => null, verify: async () => {} });
  assert.equal(result.status, 'restart_required');
  assert.deepEqual(readCodexHookConfig(profile(root)).stale_processes.map(row => row.pid), [21, 22, 24]);
});

test('導入前から動くCodexを、引用符付きと旧方式の実行ファイルも含めて再起動待ちにする', async t => {
  const root = fresh(t), home = join(root, 'codex'); mkdirSync(home);
  const hook = join(root, 'demo-codex-hook.js'); writeFileSync(hook, '');
  const binary = '/Applications/Codex.app/Contents/Resources/codex';
  const rows = [
    { pid: 10, started_identity: 'a', parent_pid: 1, command: `"${binary}" app-server` },
    { pid: 11, started_identity: 'b', parent_pid: 1, command: '/opt/old/codex' },
    { pid: 12, started_identity: 'c', parent_pid: 1, command: `${binary}-other` },
    { pid: 13, started_identity: 'd', parent_pid: 1, command: 'node x', executable: binary },
  ];
  let prepared = null;
  const result = await configureCodexSteer(profile(root), 'enable', { hook, platform: 'darwin', codex_home: home, node: process.execPath,
    findBinary: () => binary, processes: () => rows, legacy: () => ({ enabled: true, binary: '/opt/old/codex' }),
    disableLegacy: async () => ({ status: 'disabled' }), verify: async () => {}, prepareDirectory: directory => { prepared = directory; } });
  assert.equal(result.status, 'restart_required');
  const config = readCodexHookConfig(profile(root));
  assert.deepEqual(config.stale_processes.map(row => row.pid), [10, 11, 13]);
  assert.equal(prepared, join(root, 'config', 'codex-parent-hooks'));
  const hooks = JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8')).hooks;
  assert.equal(hooks.PostToolUse[0].hooks[0].command, config.command);
  assert.equal(hooks.Stop[0].hooks[0].command, config.command);
});

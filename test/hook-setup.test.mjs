import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeClaudeParentHooks, removeClaudeParentHooks, mergeCursorParentHooks, removeCursorParentHooks, claudeParentHookEntries, cursorParentHooksRegistered, commandNamesFile } from '../dist/index.js';

const profile = (id, tools, channels) => ({
  id, display_name: id, setup_command: `${id}-setup`, codex_steer_command: `${id}-setup --steer`, mcp_server: id, dispatch_tools: tools,
  state_root: () => '/tmp', config_root: () => '/tmp', hooks: { codex: `${id}-codex-hook.js`, claude: `${id}-claude-hook.js`, cursor: `${id}-cursor-hook.js` },
  codex_client_name: id, codex_hook_schema: `${id}.v1`, backup_suffix: `.${id}-backup`, ...(channels ? { channels: {} } : {}),
});
const aiterm = { ...profile('aiterm', ['agent_launch', 'pty_send']), hooks: { codex: 'codex-parent-hook.js', claude: 'claude-parent-hook.js', cursor: 'cursor-parent-hook.js' } };
const peer = profile('peertable', ['parent_join'], true);
const fresh = t => { const dir = mkdtempSync(join(tmpdir(), 'steer-setup-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('Claudeのmatcherは製品のMCP名とtoolから作り、channelの製品だけStopを付ける', () => {
  const a = claudeParentHookEntries(aiterm, { command: 'node', script: '/a/claude-parent-hook.js' });
  assert.equal(a.PreToolUse[0].matcher, '^mcp__aiterm__(agent_launch|pty_send)$');
  assert.equal(a.Stop, undefined);
  const p = claudeParentHookEntries(peer, { command: 'node', script: '/p/peertable-claude-hook.js' });
  assert.equal(p.PostToolUse[0].matcher, '^mcp__peertable__(parent_join)$');
  assert.deepEqual(p.Stop[0].hooks[0], { type: 'command', command: 'node', args: ['/p/peertable-claude-hook.js'], asyncRewake: true, timeout: 86400 });
});

test('二つの製品のClaude hookは同居し、解除は自分の分だけを取り除く', t => {
  const file = join(fresh(t), 'settings.json');
  writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-stop' }] }] } }));
  mergeClaudeParentHooks(aiterm, file, { command: 'node', script: '/a/claude-parent-hook.js' });
  mergeClaudeParentHooks(peer, file, { command: 'node', script: '/p/peertable-claude-hook.js' });
  assert.equal(mergeClaudeParentHooks(peer, file, { command: 'node', script: '/p/peertable-claude-hook.js' }), 'unchanged');
  let hooks = JSON.parse(readFileSync(file, 'utf8')).hooks;
  assert.equal(hooks.PreToolUse.length, 2);
  assert.equal(hooks.Stop.length, 2);
  removeClaudeParentHooks(peer, file);
  hooks = JSON.parse(readFileSync(file, 'utf8')).hooks;
  assert.deepEqual(hooks.Stop, [{ hooks: [{ type: 'command', command: 'user-stop' }] }]);
  assert.equal(hooks.PreToolUse.length, 1);
  assert.match(hooks.PreToolUse[0].hooks[0].args[0], /claude-parent-hook\.js$/u);
});

test('二つの製品のCursor hookは同居し、登録の確認と解除は製品ごとに行う', t => {
  const file = join(fresh(t), 'hooks.json');
  mergeCursorParentHooks(aiterm, file, { command: 'node', script: '/a/cursor-parent-hook.js' });
  assert.equal(cursorParentHooksRegistered(peer, JSON.parse(readFileSync(file, 'utf8'))), false);
  mergeCursorParentHooks(peer, file, { command: 'node', script: '/p/peertable-cursor-hook.js' });
  assert.equal(cursorParentHooksRegistered(peer, JSON.parse(readFileSync(file, 'utf8'))), true);
  removeCursorParentHooks(peer, file);
  const document = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(cursorParentHooksRegistered(peer, document), false);
  assert.equal(cursorParentHooksRegistered(aiterm, document), true);
});

// 2026-10-03 main-server: Aitermのsetupが、gpt-connectorのCursor hookを2か所消した。
// Aitermの`cursor-parent-hook.js`を部分一致で探していて、`gpt-connector-cursor-parent-hook.js`に当たっていた。
test('名前が後ろで重なる他製品のCursor hookを、自分のものと数えず、消さない', t => {
  const file = join(fresh(t), 'hooks.json');
  const gpt = { ...profile('gpt-connector', ['ask']), hooks: { codex: 'codex-parent-hook.js', claude: 'gpt-connector-claude-parent-hook.js', cursor: 'gpt-connector-cursor-parent-hook.js' } };
  const gptEntry = { command: "'/n/node' '/g/gpt-connector-cursor-parent-hook.js'", timeout: 15 };
  writeFileSync(file, JSON.stringify({ version: 1, hooks: { afterMCPExecution: [gptEntry], postToolUse: [{ command: 'user-hook' }, gptEntry] } }));
  assert.equal(cursorParentHooksRegistered(aiterm, JSON.parse(readFileSync(file, 'utf8'))), false);
  assert.equal(mergeCursorParentHooks(aiterm, file, { command: '/n/node', script: '/a/cursor-parent-hook.js' }), 'configured');
  let document = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(document.hooks.afterMCPExecution.length, 2);
  assert.deepEqual(document.hooks.postToolUse.slice(0, 2), [{ command: 'user-hook' }, gptEntry]);
  assert.equal(cursorParentHooksRegistered(gpt, document), true);
  assert.equal(cursorParentHooksRegistered(aiterm, document), true);
  assert.equal(mergeCursorParentHooks(aiterm, file, { command: '/n/node', script: '/a/cursor-parent-hook.js' }), 'unchanged');
  removeCursorParentHooks(aiterm, file);
  document = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(document.hooks.afterMCPExecution, [gptEntry]);
  assert.deepEqual(document.hooks.postToolUse, [{ command: 'user-hook' }, gptEntry]);
});

test('commandNamesFileは名前の境目まで見る（Windowsのpathと引用符を含む）', () => {
  assert.equal(commandNamesFile("'/n/node' '/a/dist/cursor-parent-hook.js'", 'cursor-parent-hook.js'), true);
  assert.equal(commandNamesFile("& 'C:\\n\\node.exe' 'C:\\a\\dist\\cursor-parent-hook.js'", 'cursor-parent-hook.js'), true);
  assert.equal(commandNamesFile('node cursor-parent-hook.js', 'cursor-parent-hook.js'), true);
  assert.equal(commandNamesFile("'/n/node' '/g/gpt-connector-cursor-parent-hook.js'", 'cursor-parent-hook.js'), false);
  assert.equal(commandNamesFile("'/n/node' '/a/cursor-parent-hook.js.bak'", 'cursor-parent-hook.js'), false);
});

// 2026-10-03 main-server: 他の道具が後からhookを足した後にAitermのsetupを流すと、中身は同じなのにAitermのentryが末尾へ移り、fileが書き換わった。
test('登録済みのClaude hookが同じ中身なら、後から足された他のhookとの並びを変えない', t => {
  const file = join(fresh(t), 'settings.json');
  mergeClaudeParentHooks(aiterm, file, { command: 'node', script: '/a/claude-parent-hook.js' });
  const document = JSON.parse(readFileSync(file, 'utf8'));
  document.hooks.PreToolUse.push({ matcher: 'PowerShell', hooks: [{ type: 'command', command: 'other-tool-hook', timeout: 5 }] });
  writeFileSync(file, JSON.stringify(document, null, 2));
  const before = readFileSync(file, 'utf8');
  assert.equal(mergeClaudeParentHooks(aiterm, file, { command: 'node', script: '/a/claude-parent-hook.js' }), 'unchanged');
  assert.equal(readFileSync(file, 'utf8'), before);
  // 中身が変わった時（scriptの場所が変わった）は今までどおり更新する。
  assert.equal(mergeClaudeParentHooks(aiterm, file, { command: 'node', script: '/b/claude-parent-hook.js' }), 'configured');
  const after = JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse;
  assert.equal(after.length, 2);
  assert.equal(after.filter(group => group.hooks[0].args?.[0] === '/b/claude-parent-hook.js').length, 1);
});

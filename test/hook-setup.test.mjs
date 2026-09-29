import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeClaudeParentHooks, removeClaudeParentHooks, mergeCursorParentHooks, removeCursorParentHooks, claudeParentHookEntries, cursorParentHooksRegistered } from '../dist/index.js';

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

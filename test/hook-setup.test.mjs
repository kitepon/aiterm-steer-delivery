import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual as isDeepEqual } from 'node:util';
import {
  mergeClaudeParentHooks, removeClaudeParentHooks, mergeCursorParentHooks, removeCursorParentHooks, claudeParentHookEntries, cursorParentHooksRegistered, commandNamesFile,
  claudeParentHookCommand, claudeParentHooksRegistered, claudeParentHookScripts,
} from '../dist/index.js';

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
  assert.deepEqual(claudeParentHookEntries(peer, { command: 'node', script: '/p/peertable-claude-hook.js' }, 'linux').Stop[0].hooks[0],
    { type: 'command', command: "exec 'node' '/p/peertable-claude-hook.js'", asyncRewake: true, timeout: 86400 });
});

// 2026-10-05 ティア席（Grok 1.0.46）: Grokは共有の~/.claude/settings.jsonのhookも動かすが、argsを落としてcommandだけを動かす。
// `command=node, args=[入口]`の形だと、nodeが入力のJSONをscriptとして読み、Stopのたびに`[stdin]:1`で失敗していた。
test('Claudeのhookはargsを使わず、shellを通す1行で書く', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const group of Object.values(claudeParentHookEntries(peer, { command: 'node', script: '/p/peertable-claude-hook.js' }, platform)).flat()) {
      for (const hook of group.hooks) assert.equal('args' in hook, false, `${platform}: argsを書かない`);
    }
  }
  // POSIXはexecでshをnodeへ置き換える（Claude Codeをhookの直接の親に保つ）。
  assert.deepEqual(claudeParentHookCommand({ command: '/usr/local/bin/node', script: '/a b/it\'s/x-claude-hook.js' }, 'linux'),
    { command: `exec '/usr/local/bin/node' '/a b/it'"'"'s/x-claude-hook.js'` });
  // WindowsはPowerShell。終了codeを丸めさせず、`$`を書かない（Grokが環境変数として読み、未設定としてhookを動かさない）。
  const windows = claudeParentHookCommand({ command: 'C:\\Program Files\\nodejs\\node.exe', script: "C:\\Users\\o'neil\\x-claude-hook.js" }, 'win32');
  assert.deepEqual(windows, {
    command: "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\o''neil\\x-claude-hook.js'; exit (Get-Variable LASTEXITCODE -ValueOnly)", shell: 'powershell',
  });
  assert.equal(windows.command.includes('$'), false);
  assert.equal(claudeParentHookEntries(peer, { command: 'node', script: 'C:\\p\\peertable-claude-hook.js' }, 'win32').PreToolUse[0].hooks[0].shell, 'powershell');
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
  assert.deepEqual(claudeParentHookScripts(aiterm, { hooks }), ['/a/claude-parent-hook.js', '/a/claude-parent-hook.js', '/a/claude-parent-hook.js']);
});

const legacy = script => ({ type: 'command', command: '/usr/local/bin/node', args: [script] });

test('0.1系が書いたargs形式のClaude hookを今の形へ置き換え、他製品と利用者のhookは残す', t => {
  const file = join(fresh(t), 'settings.json');
  const matcher = '^mcp__aiterm__(agent_launch|pty_send)$';
  const other = legacy('/g/gpt-connector-claude-parent-hook.js'), user = { type: 'command', command: 'user-hook' };
  writeFileSync(file, JSON.stringify({ model: 'opus', hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [user] }, { matcher, hooks: [{ ...legacy('/old/claude-parent-hook.js'), timeout: 15 }] }, { matcher: '^mcp__gpt__ask$', hooks: [other] }],
    PostToolUse: [{ matcher, hooks: [{ ...legacy('/old/claude-parent-hook.js'), asyncRewake: true, timeout: 86400 }] }],
    SessionEnd: [{ hooks: [{ ...legacy('/old/claude-parent-hook.js'), timeout: 15 }, other] }],
  } }));
  const before = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(claudeParentHooksRegistered(aiterm, before), true, '旧形式も登録済みと数える');
  assert.deepEqual(claudeParentHookScripts(aiterm, before), ['/old/claude-parent-hook.js', '/old/claude-parent-hook.js', '/old/claude-parent-hook.js']);
  assert.equal(mergeClaudeParentHooks(aiterm, file, { command: '/usr/local/bin/node', script: '/new/claude-parent-hook.js' }), 'configured');
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(after.model, 'opus');
  const entries = Object.values(after.hooks).flat().flatMap(group => group.hooks);
  assert.equal(entries.filter(hook => hook.args?.[0]?.endsWith('/claude-parent-hook.js')).length, 0, 'Aitermの旧形式は残さない');
  assert.equal(entries.filter(hook => isDeepEqual(hook, other)).length, 2, '他製品の旧形式はそのまま残す');
  assert.deepEqual(after.hooks.PreToolUse[0], { matcher: 'Bash', hooks: [user] });
  assert.equal(after.hooks.PreToolUse.length, 3);
  assert.equal(after.hooks.SessionEnd.length, 2);
  assert.equal(claudeParentHooksRegistered(aiterm, after), true);
  assert.deepEqual(claudeParentHookScripts(aiterm, after), ['/new/claude-parent-hook.js', '/new/claude-parent-hook.js', '/new/claude-parent-hook.js']);
  assert.equal(mergeClaudeParentHooks(aiterm, file, { command: '/usr/local/bin/node', script: '/new/claude-parent-hook.js' }), 'unchanged');
});

test('解除は旧形式と今の形の両方を除き、名前が後ろで重なる他製品のClaude hookは残す', t => {
  const file = join(fresh(t), 'settings.json');
  const gpt = { ...profile('gpt-connector', ['ask']), hooks: { codex: 'codex-parent-hook.js', claude: 'gpt-connector-claude-parent-hook.js', cursor: 'gpt-connector-cursor-parent-hook.js' } };
  mergeClaudeParentHooks(gpt, file, { command: 'node', script: '/g/gpt-connector-claude-parent-hook.js' });
  mergeClaudeParentHooks(aiterm, file, { command: 'node', script: '/a/claude-parent-hook.js' });
  const document = JSON.parse(readFileSync(file, 'utf8'));
  document.hooks.SessionEnd.push({ hooks: [legacy('/old/claude-parent-hook.js')] });
  writeFileSync(file, JSON.stringify(document));
  assert.deepEqual(claudeParentHookScripts(gpt, document), ['/g/gpt-connector-claude-parent-hook.js', '/g/gpt-connector-claude-parent-hook.js', '/g/gpt-connector-claude-parent-hook.js']);
  assert.equal(removeClaudeParentHooks(aiterm, file), 'removed');
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(claudeParentHooksRegistered(aiterm, after), false);
  assert.deepEqual(claudeParentHookScripts(aiterm, after), []);
  assert.equal(claudeParentHooksRegistered(gpt, after), true);
  assert.equal(removeClaudeParentHooks(aiterm, file), 'unchanged');
});

test('登録の確認は、製品が登録する全てのeventを見る', () => {
  const entries = claudeParentHookEntries(peer, { command: 'node', script: '/p/peertable-claude-hook.js' });
  assert.equal(claudeParentHooksRegistered(peer, { hooks: entries }), true);
  const { Stop: _stop, ...withoutStop } = entries;
  assert.equal(claudeParentHooksRegistered(peer, { hooks: withoutStop }), false, 'channelの製品はStopも要る');
  for (const broken of [null, [], {}, { hooks: [] }, { hooks: { PreToolUse: 'x' } }]) assert.equal(claudeParentHooksRegistered(peer, broken), false);
  // 引用符と空白のあるpathも、書いた行から読み戻せる（POSIXとWindowsの両方の書き方）。
  for (const [platform, script] of [['linux', "/a b/it's/peertable-claude-hook.js"], ['win32', "C:\\a b\\it's\\peertable-claude-hook.js"]]) {
    const hooks = claudeParentHookEntries(peer, { command: 'node', script }, platform);
    assert.deepEqual([...new Set(claudeParentHookScripts(peer, { hooks }))], [script], platform);
  }
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
  assert.equal(after.filter(group => claudeParentHookScripts(aiterm, { hooks: { PreToolUse: [group], PostToolUse: [group], SessionEnd: [group] } })[0] === '/b/claude-parent-hook.js').length, 1);
});

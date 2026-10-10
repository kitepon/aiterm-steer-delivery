import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { claudeParentHookCommand, hookOwnerProcess, readRuntimeProcesses, openChannel, sendToChannel, channelDeliveryState } from '../dist/index.js';

const isWin = process.platform === 'win32';
const fresh = t => { const dir = mkdtempSync(join(tmpdir(), 'steer-shell-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const library = JSON.stringify(pathToFileURL(join(process.cwd(), 'dist', 'index.js')).href);
/** Claude Codeがshell形式のhookを動かすのと同じ形で、書いた1行を動かす（実物で確かめた形: Linuxは`/bin/sh -c`、Windowsは`pwsh -Command`）。 */
function runThroughShell(command, input) {
  return isWin
    ? spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { input, encoding: 'utf8' })
    : spawnSync('/bin/sh', ['-c', command], { input, encoding: 'utf8' });
}
/** hook入口の代わり。runClaudeHookMainを、試験用の置き場で呼ぶ。 */
function entry(dir, name, { channels = false } = {}) {
  const file = join(dir, name);
  writeFileSync(file, `import { runClaudeHookMain } from ${library};
    const root = ${JSON.stringify(join(dir, 'state'))};
    await runClaudeHookMain({ id: 'demo', display_name: 'Demo', setup_command: 'demo-setup', codex_steer_command: 'demo-setup --steer', mcp_server: 'demo', dispatch_tools: ['ask'],
      state_root: () => root, config_root: () => root, hooks: { codex: 'demo-codex-hook.mjs', claude: 'demo-claude-hook.mjs', cursor: 'demo-cursor-hook.mjs' },
      codex_client_name: 'demo', codex_hook_schema: 'demo.v1', backup_suffix: '.demo-backup'${channels ? ', channels: {}' : ''} });\n`);
  return file;
}

// asyncRewakeは、hookの終了2とstderrの本文で親を起こす。shellを通しても、この2つがそのまま届く必要がある。
// PowerShellは`-Command`の終了codeを0か1へ丸める（foxのClaude Code 2.1.289で、2が1になるのを確認）。
test('書いた1行を本物のshellで動かすと、引数・入力・終了2・stderrがそのまま届く（空白と引用符のあるpath）', t => {
  const dir = join(fresh(t), "it's a dir");
  mkdirSync(dir);
  const script = join(dir, 'demo-claude-hook.mjs');
  writeFileSync(script, `let input = ''; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) input += chunk;
    process.stderr.write('本文:' + JSON.parse(input).text); process.exitCode = 2;\n`);
  const run = runThroughShell(claudeParentHookCommand({ command: process.execPath, script }).command, JSON.stringify({ text: '届く' }));
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.stderr, '本文:届く');
  const quiet = join(dir, 'quiet-claude-hook.mjs');
  writeFileSync(quiet, 'process.stdin.resume(); process.stdin.on("end", () => {});\n');
  assert.equal(runThroughShell(claudeParentHookCommand({ command: process.execPath, script: quiet }).command, '{}').status, 0);
});

// shell形式では、Claude Codeとhookの間にshellが挟まる（Linuxのsh -cはexecを書かないと残る。WindowsのPowerShellは必ず残る）。
// 挟まったshellを親として記録すると、shellはhookと一緒に終わるので、受信の時に「依頼元のClaude processは終了しました」になる。
test('PreToolUseは、間に挟まったshellではなく、hookを起動したprocessを親として記録する', t => {
  const dir = fresh(t);
  const script = entry(dir, 'demo-claude-hook.mjs');
  const self = readRuntimeProcesses().find(row => row.pid === process.pid);
  const event = id => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: randomUUID(), tool_use_id: id });
  const recorded = id => JSON.parse(readFileSync(join(dir, 'state', 'claude-parent-hooks', id, 'request.json'), 'utf8'));
  // 登録する1行（POSIXはexec付き、WindowsはPowerShell）。
  const run = runThroughShell(claudeParentHookCommand({ command: process.execPath, script }).command, event('toolu_form'));
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual([recorded('toolu_form').parent_pid, recorded('toolu_form').parent_started_identity], [process.pid, self.started_identity]);
  // execを書かない1行。shが間に残る環境でも、shを飛ばして同じ親を記録する。
  if (!isWin) {
    const plain = runThroughShell(`'${process.execPath}' '${script}'; exit $?`, event('toolu_plain'));
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(recorded('toolu_plain').parent_pid, process.pid);
  }
});

test('hookOwnerProcessは、shellでない最初の先祖を返す', () => {
  const row = (pid, parent_pid, command, executable) => ({ pid, parent_pid, command, executable, process_group_id: null, started_identity: `t${pid}`, argv_digest: '', cpu_seconds: 0, stopped: null });
  // Linux: claude → /bin/sh -c → node（shがexecしなかった時）
  const linux = [row(1, 0, '/sbin/init'), row(10, 1, '-bash'), row(20, 10, 'claude --settings /tmp/s.json'), row(30, 20, "/bin/sh -c '/usr/local/bin/node' '/a/claude-parent-hook.js'")];
  assert.equal(hookOwnerProcess(linux, 30).pid, 20);
  assert.equal(hookOwnerProcess(linux, 20).pid, 20, '直接起動（旧形式・exec付き）は、親がそのままClaude');
  // Windows: claude.exe → pwsh.exe -Command → node.exe（foxのClaude Code 2.1.289の実物の形）
  const windows = [
    row(100, 4, '"C:\\Users\\k\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" -p hi', 'C:\\Users\\k\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'),
    row(200, 100, '"c:\\program files\\powershell\\7\\pwsh.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& \'C:\\Program Files\\nodejs\\node.exe\' \'C:\\a\\claude-parent-hook.js\'"', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'),
  ];
  assert.equal(hookOwnerProcess(windows, 200).pid, 100);
  // Git Bashは2段になる。executableが空でも、commandの先頭の語から名前を読む。
  const gitBash = [row(100, 4, 'claude.exe', ''), row(150, 100, '"C:\\Program Files\\Git\\bin\\bash.exe" -c x', ''), row(160, 150, '"C:\\Program Files\\Git\\bin\\..\\usr\\bin\\bash.exe" -c x', '')];
  assert.equal(hookOwnerProcess(gitBash, 160).pid, 100);
  assert.equal(hookOwnerProcess(linux, 999), undefined);
});

// Grokは共有の~/.claude/settings.jsonのhookも動かす（Claude互換の`hook_event_name`と、Grok独自の`hookEventName`の両方を入力へ入れる）。
// hookが2で終わると、GrokはStopを「止めずに続ける」、PreToolUseを「拒否」と読む。
test('Grokからの起動では、何も記録せず、何も出さずに0で終わる', t => {
  const dir = fresh(t);
  const grok = (name, event, extra = {}) => JSON.stringify({ hookEventName: name, sessionId: randomUUID(), hook_event_name: event, session_id: randomUUID(), cwd: dir, ...extra });
  for (const channels of [false, true]) {
    const script = entry(dir, channels ? 'channel-claude-hook.mjs' : 'demo-claude-hook.mjs', { channels });
    const command = claudeParentHookCommand({ command: process.execPath, script }).command;
    for (const input of [grok('stop', 'Stop'), grok('session_end', 'SessionEnd'), grok('session_start', 'SessionStart'),
      grok('pre_tool_use', 'PreToolUse', { tool_use_id: 'call-1', tool_name: 'demo__ask' }), grok('post_tool_use', 'PostToolUse', { tool_use_id: 'call-1' })]) {
      const run = runThroughShell(command, input);
      assert.deepEqual([run.status, run.stdout, run.stderr], [0, '', ''], input);
    }
  }
  assert.equal(existsSync(join(dir, 'state')), false, 'Grokの会話を記録しない');
  // Claude Codeからの知らないeventは、今までどおり2で知らせる。
  const claude = runThroughShell(claudeParentHookCommand({ command: process.execPath, script: join(dir, 'demo-claude-hook.mjs') }).command,
    JSON.stringify({ hook_event_name: 'Stop', session_id: randomUUID() }));
  assert.equal(claude.status, 2);
  assert.match(claude.stderr, /CLAUDE_PARENT_HOOK_EVENT_INVALID/u);
});

// 2026-10-10 fox（Claude Code 2.1.295）: アプリ配下のClaudeが起動し直り、同じ会話が新しいprocessで再開された。
// channelは前のprocessに結ばれたままで、待機がすぐ終わり、答えが受信箱に残った。
test('SessionStartとStopのhookは、前のprocessが開いたchannelの本文を、今hookを起こしたprocessへ出す', async t => {
  const dir = fresh(t);
  const script = entry(dir, 'channel-claude-hook.mjs', { channels: true });
  const command = claudeParentHookCommand({ command: process.execPath, script }).command;
  const root = join(dir, 'state');
  const p = { id: 'demo', state_root: () => root, config_root: () => root };
  const session = randomUUID(), request = 'toolu_restart';
  // 前のprocess（もう居ない）が出した依頼の記録と、そこへ結んだchannel。
  mkdirSync(join(root, 'claude-parent-hooks', request), { recursive: true });
  writeFileSync(join(root, 'claude-parent-hooks', request, 'request.json'), JSON.stringify({ request_id: request, session_id: session, agent_id: null,
    parent_pid: process.pid, parent_started_identity: '起動し直す前のprocessの開始時刻' }));
  const channel = openChannel(p, { kind: 'claude', request_id: request, session_id: session, hook_root: join(root, 'claude-parent-hooks') });
  for (const [event, text] of [['SessionStart', '止まっていた間に届いた答え'], ['Stop', '再開した後に届いた答え']]) {
    const id = randomUUID();
    await sendToChannel(p, channel.channel_id, id, text);
    const run = runThroughShell(command, JSON.stringify({ hook_event_name: event, session_id: session, ...(event === 'SessionStart' ? { source: 'resume' } : {}) }));
    assert.deepEqual([run.status, run.stderr], [2, text], event);
    assert.equal(channelDeliveryState(p, channel.channel_id, id), 'emitted');
  }
  // 開いているchannelの無い会話（新しい会話）の始まりでは、何もせず0で終わる。
  const fresh2 = runThroughShell(command, JSON.stringify({ hook_event_name: 'SessionStart', session_id: randomUUID(), source: 'startup' }));
  assert.deepEqual([fresh2.status, fresh2.stdout, fresh2.stderr], [0, '', '']);
});

// 2026-10-05 fox（Claude Code 2.1.289、0.1.13）: 親は本文を受け取ったのに、送り主には CLAUDE_PARENT_HOOK_CLOSED が返っていた。
// 送り主は「出し終えた記録が無い」→「hookのprocessが居ない」の順に見る。process表を読む間（Windowsは約1秒）にhookが出し終えて終わると、
// 出し終えた後のhookを「途中で終わった」と数えていた。
test('process表を読む間にhookが本文を出し終えて終わっても、配送済みとして返す', async t => {
  const { submitClaudeParentAnswer, bindClaudeParentDelivery } = await import('../dist/index.js');
  const root = fresh(t), request = 'toolu_race', session = randomUUID(), id = randomUUID();
  const profile = { setup_command: 'demo-setup' };
  const self = readRuntimeProcesses().find(row => row.pid === process.pid);
  const dir = join(root, request);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ request_id: request, session_id: session, agent_id: null, parent_pid: process.pid, parent_started_identity: self.started_identity }));
  const parent = { kind: 'claude', request_id: request, session_id: session, hook_root: root };
  bindClaudeParentDelivery(profile, parent, id);
  // 受信hookは待っていた（hook.jsonあり）。表を読んでいる間に出し終えて終わる。
  writeFileSync(join(dir, 'hook.json'), JSON.stringify({ pid: 2147483000, started_identity: 'ended' }));
  let reads = 0;
  const processes = () => {
    reads += 1;
    writeFileSync(join(dir, 'sending.json'), JSON.stringify({ delivery_id: id }));
    writeFileSync(join(dir, 'emitted.json'), JSON.stringify({ delivery_id: id }));
    return [self];
  };
  assert.deepEqual(await submitClaudeParentAnswer(profile, parent, id, '届いた本文', { processes }), { queued_submission_id: null });
  assert.equal(reads, 1);
  // 出し終えていないままhookが居なくなった時は、今までどおり断る（本文を出し始めていれば結果不明）。
  const second = 'toolu_gone', other = randomUUID(), gone = join(root, second);
  mkdirSync(gone);
  writeFileSync(join(gone, 'request.json'), JSON.stringify({ request_id: second, session_id: session, agent_id: null, parent_pid: process.pid, parent_started_identity: self.started_identity }));
  const lost = { kind: 'claude', request_id: second, session_id: session, hook_root: root };
  bindClaudeParentDelivery(profile, lost, other);
  writeFileSync(join(gone, 'hook.json'), JSON.stringify({ pid: 2147483000, started_identity: 'ended' }));
  writeFileSync(join(gone, 'sending.json'), JSON.stringify({ delivery_id: other }));
  await assert.rejects(submitClaudeParentAnswer(profile, lost, other, '届かない本文', { processes: () => [self] }),
    error => error.delivery_code === 'CLAUDE_PARENT_HOOK_CLOSED' && error.outcome_unknown === true);
  // 依頼元のClaude processが居ない時も同じ順で見る。
  const third = 'toolu_parent', last = randomUUID(), closed = join(root, third);
  mkdirSync(closed);
  writeFileSync(join(closed, 'request.json'), JSON.stringify({ request_id: third, session_id: session, agent_id: null, parent_pid: 2147483000, parent_started_identity: 'ended' }));
  const orphan = { kind: 'claude', request_id: third, session_id: session, hook_root: root };
  writeFileSync(join(closed, 'delivery.json'), JSON.stringify({ delivery_id: last }));
  await assert.rejects(submitClaudeParentAnswer(profile, orphan, last, '届かない本文', { processes: () => [self] }),
    error => error.delivery_code === 'CLAUDE_PARENT_PROCESS_CLOSED');
});

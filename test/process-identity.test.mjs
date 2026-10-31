import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  readRuntimeProcesses, readProcessIdentities, readProcessLineage, processExists, processIsRunning, hookOwnerProcess,
  openChannel, sendToChannel, runClaudeChannelWaiter,
} from '../dist/index.js';

// 2026-10-12、Windowsの端末（process 1300個）で、待機のprocess 11個が5秒おきに全processの一覧（WMI）を取り、Aitermの見回りと合わせて
// PowerShellが毎秒6回起きていた。1個だけ読む口は、全部の一覧と同じ開始時刻を返さなければならない
// （記録に残した開始時刻と文字列で比べるので、1文字でも違うと「別のprocess」と読む）。

const child = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
const stopped = proc => new Promise(resolve => { proc.once('exit', resolve); proc.kill(); });

test('1個だけ読む口は、全processの一覧と同じ開始時刻を返す。居ないpidは返さない', async () => {
  const other = child();
  try {
    await new Promise(resolve => other.once('spawn', resolve));
    const table = readRuntimeProcesses();
    const expected = pid => table.find(row => row.pid === pid)?.started_identity;
    assert.ok(expected(process.pid), '自分が一覧に居る');
    const rows = readProcessIdentities([process.pid, other.pid, process.pid, 2 ** 30 + 12345]);
    assert.deepEqual(rows.map(row => row.pid).sort((a, b) => a - b), [process.pid, other.pid].sort((a, b) => a - b), '重ねたpidは1回、居ないpidは返さない');
    for (const row of rows) assert.equal(row.started_identity, expected(row.pid), `pid ${row.pid} の開始時刻が一覧と同じ`);
    assert.deepEqual(readProcessIdentities([]), []);
    assert.throws(() => readProcessIdentities([-1]), /pidが不正/);
  } finally { await stopped(other); }
});

test('pidの有無はprocessを起こさずに読む。本人かどうかは、居る時だけ開始時刻で確かめる', async () => {
  const other = child();
  await new Promise(resolve => other.once('spawn', resolve));
  const pid = other.pid;
  const identity = readProcessIdentities([pid])[0].started_identity;
  assert.equal(processExists(pid), true);
  assert.equal(processExists(process.pid), true);
  assert.equal(processIsRunning(pid, identity), true);
  assert.equal(processIsRunning(pid, '別の開始時刻'), false, 'pidが同じでも、開始時刻が違えば別のprocess');
  await stopped(other);
  assert.equal(processExists(pid), false);
  assert.equal(processIsRunning(pid, identity), false);
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.equal(processExists(bad), false);
});

test('先祖をたどる口は、全processの一覧と同じ持ち主を返す', () => {
  const table = readRuntimeProcesses();
  const lineage = readProcessLineage(process.pid);
  assert.equal(lineage[0]?.pid, process.pid, '先頭は聞いたprocess');
  assert.ok(lineage.length <= 8, '既定の深さを超えない');
  assert.equal(lineage.find(row => row.pid === process.pid)?.started_identity, table.find(row => row.pid === process.pid).started_identity);
  const parent = table.find(row => row.pid === process.ppid);
  if (parent) assert.equal(lineage.find(row => row.pid === process.ppid)?.started_identity, parent.started_identity, '親の開始時刻も同じ');
  // hookの持ち主（shellを飛ばした先のprocess）も同じになる。
  const fromTable = hookOwnerProcess(table, process.ppid), fromLineage = hookOwnerProcess(lineage, process.ppid);
  assert.equal(fromLineage?.pid, fromTable?.pid);
  assert.equal(fromLineage?.started_identity, fromTable?.started_identity);
});

function profile(root) {
  return {
    id: 'demo', display_name: 'Demo', setup_command: 'demo-setup', codex_steer_command: 'demo-setup --codex-steer enable',
    mcp_server: 'demo', dispatch_tools: ['join'], state_root: () => root, config_root: () => join(root, 'config'),
    hooks: { codex: 'demo-codex-hook.js', claude: 'demo-claude-hook.js', cursor: 'demo-cursor-hook.js' },
    codex_client_name: 'demo', codex_hook_schema: 'demo.codex-parent-hooks.v1', backup_suffix: '.demo-backup', channels: {},
  };
}

function openClaudeChannel(t) {
  const root = mkdtempSync(join(tmpdir(), 'steer-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = profile(root), session = randomUUID(), hookRoot = join(root, 'claude-parent-hooks'), request = `toolu_${randomUUID().replace(/-/g, '')}`;
  const self = readProcessIdentities([process.pid])[0];
  mkdirSync(join(hookRoot, request), { recursive: true });
  writeFileSync(join(hookRoot, request, 'request.json'), JSON.stringify({ request_id: request, session_id: session, agent_id: null, parent_pid: process.pid, parent_started_identity: self.started_identity }));
  const channel = openChannel(p, { kind: 'claude', request_id: request, session_id: session, hook_root: hookRoot });
  return { p, session, channel };
}

test('待機: pidの有無は毎回見るが、開始時刻の照合は最初と決めた間隔でだけ行う', async t => {
  const { p, session, channel } = openClaudeChannel(t);
  const owner = { pid: 4242, started_identity: '本人' };
  let exists = 0, identity = 0;
  const runtime = { exists: () => { exists += 1; return true; }, identity: () => { identity += 1; return '本人'; } };
  const out = [];
  const waiter = runClaudeChannelWaiter(p, { session_id: session }, text => { out.push(text); },
    { poll_ms: 5, owner, runtime, owner_check_ms: 20, identity_recheck_ms: 60_000 });
  await new Promise(resolve => setTimeout(resolve, 260));
  assert.ok(exists >= 5, `pidの有無は確かめの度に見る（${exists}回）`);
  assert.equal(identity, 1, '開始時刻は最初の1回だけ');
  await sendToChannel(p, channel.channel_id, randomUUID(), '届く本文');
  assert.equal(await waiter, 2);
  assert.deepEqual(out, ['届く本文']);
});

test('待機: pidが無くなったらすぐ終わる。同じpidが別のprocessに使い回された時は、照合の間隔で終わる', async t => {
  const first = openClaudeChannel(t);
  let alive = true;
  const gone = runClaudeChannelWaiter(first.p, { session_id: first.session }, () => assert.fail('出す先が居ない'),
    { poll_ms: 5, owner: { pid: 4242, started_identity: '本人' }, owner_check_ms: 20, identity_recheck_ms: 60_000,
      runtime: { exists: () => alive, identity: () => '本人' } });
  await new Promise(resolve => setTimeout(resolve, 80));
  alive = false;
  assert.equal(await gone, 0);

  const second = openClaudeChannel(t);
  let current = '本人', checks = 0;
  const reused = runClaudeChannelWaiter(second.p, { session_id: second.session }, () => assert.fail('別のprocessへ出さない'),
    { poll_ms: 5, owner: { pid: 4242, started_identity: '本人' }, owner_check_ms: 20, identity_recheck_ms: 100,
      runtime: { exists: () => true, identity: () => { checks += 1; return current; } } });
  await new Promise(resolve => setTimeout(resolve, 60));
  current = '使い回した別のprocess';
  assert.equal(await reused, 0);
  assert.ok(checks >= 2 && checks <= 4, `照合は間隔ごと（${checks}回）`);
});

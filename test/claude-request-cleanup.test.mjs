import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  bindClaudeParentDelivery, claudeParentFromRequest, closeClaudeParentSession, prepareClaudeHookRequest,
  readRuntimeProcesses, runClaudeResultHook, submitClaudeParentAnswer,
} from '../dist/index.js';
import { sweepClaudeHookRequests } from '../dist/claude-receiver.js';

// 2026-10-06: 届いた依頼の置き場（request.json・delivery.json・answer.json・hook.json・sending.json・emitted.json）が、届いた後も残っていた。
// 届いた子1つにつき1つ増え、Windowsの一時置き場では再起動でも消えない（foxに18日前の分が残っていた）。
const profile = { setup_command: 'demo-setup' };
const DAY = 24 * 60 * 60 * 1000;
const fresh = t => { const dir = mkdtempSync(join(tmpdir(), 'steer-cleanup-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const self = readRuntimeProcesses().find(row => row.pid === process.pid);
const gone = { pid: 2147483000, started_identity: 'ended' };

/** PreToolUseが置く記録を、依頼元を指定して直に置く。 */
function request(root, id, { session = randomUUID(), owner = self } = {}) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ request_id: id, session_id: session, agent_id: null, parent_pid: owner.pid, parent_started_identity: owner.started_identity }));
  return { dir, parent: { kind: 'claude', request_id: id, session_id: session, hook_root: root } };
}
/** 置き場とその中身を、今からms前に書かれた事にする。 */
function age(dir, ms) {
  const at = new Date(Date.now() - ms);
  for (const name of readdirSync(dir)) utimesSync(join(dir, name), at, at);
  utimesSync(dir, at, at);
}

test('届いた依頼の置き場は、送り手が届いた事を確かめた後に消す', async t => {
  const root = fresh(t), session = randomUUID(), id = randomUUID();
  const input = { session_id: session, tool_use_id: 'toolu_delivered' };
  prepareClaudeHookRequest({ ...input, hook_event_name: 'PreToolUse' }, root);
  const parent = claudeParentFromRequest(profile, 'claude-code', { 'claudecode/toolUseId': input.tool_use_id }, root);
  bindClaudeParentDelivery(profile, parent, id);
  let output;
  const hook = runClaudeResultHook(profile, { ...input, hook_event_name: 'PostToolUse' }, text => { output = text; }, root);
  assert.deepEqual(await submitClaudeParentAnswer(profile, parent, id, '届く本文'), { queued_submission_id: null });
  assert.equal(await hook, 2);
  assert.equal(output, '届く本文');
  assert.equal(existsSync(join(root, input.tool_use_id)), false);
  assert.deepEqual(readdirSync(root), []);
});

test('届かなかった依頼の置き場は、原因を調べる材料として残す', async t => {
  const root = fresh(t);
  // 受信hookが出し終える前に居なくなった。
  const lost = request(root, 'toolu_hook_gone'), first = randomUUID();
  bindClaudeParentDelivery(profile, lost.parent, first);
  writeFileSync(join(lost.dir, 'hook.json'), JSON.stringify(gone));
  await assert.rejects(submitClaudeParentAnswer(profile, lost.parent, first, '届かない本文', { processes: () => [self] }),
    error => error.delivery_code === 'CLAUDE_PARENT_HOOK_CLOSED');
  assert.deepEqual(readdirSync(lost.dir).sort(), ['answer.json', 'delivery.json', 'hook.json', 'request.json']);
  // 会話が終わっていた。
  const closed = request(root, 'toolu_closed'), second = randomUUID();
  bindClaudeParentDelivery(profile, closed.parent, second);
  closeClaudeParentSession({ session_id: closed.parent.session_id }, root);
  await assert.rejects(submitClaudeParentAnswer(profile, closed.parent, second, '保存する本文', { processes: () => [self] }),
    error => error.delivery_code === 'CLAUDE_PARENT_SESSION_CLOSED');
  assert.equal(JSON.parse(readFileSync(join(closed.dir, 'answer.json'), 'utf8')).text, '保存する本文');
});

test('置き場を消せなくても、届いた配送は成功のまま返す', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const root = fresh(t), id = randomUUID();
  const { dir, parent } = request(root, 'toolu_locked');
  bindClaudeParentDelivery(profile, parent, id);
  writeFileSync(join(dir, 'emitted.json'), JSON.stringify({ delivery_id: id }));
  // 置き場の親を書き込めなくすると、中身は消せても置き場そのものを消せない。
  chmodSync(root, 0o500);
  try {
    assert.deepEqual(await submitClaudeParentAnswer(profile, parent, id, '届いた本文', { processes: () => [self] }), { queued_submission_id: null });
    assert.equal(existsSync(dir), true);
  } finally { chmodSync(root, 0o700); }
});

test('会話終了の見回りは、読めない記録を飛ばして、その会話の依頼を閉じる', t => {
  const root = fresh(t), session = randomUUID();
  // 見回りは名前の順に進む。読めない記録を、閉じる依頼より前に置く。
  mkdirSync(join(root, 'toolu_a_old_shape'));
  writeFileSync(join(root, 'toolu_a_old_shape', 'request.json'), JSON.stringify({ request_id: 'toolu_a_old_shape', session_id: session, parent_pid: process.pid }));
  mkdirSync(join(root, 'toolu_b_broken'));
  writeFileSync(join(root, 'toolu_b_broken', 'request.json'), '{"request_id":');
  mkdirSync(join(root, 'toolu_c_empty'));
  writeFileSync(join(root, 'toolu_d_file'), '');
  const mine = request(root, 'toolu_e_mine', { session });
  const other = request(root, 'toolu_f_other');
  closeClaudeParentSession({ session_id: session }, root);
  assert.equal(existsSync(join(mine.dir, 'closed.json')), true);
  assert.equal(existsSync(join(other.dir, 'closed.json')), false);
  assert.equal(existsSync(join(root, 'toolu_a_old_shape', 'closed.json')), false);
});

test('見回りは、1日たって待っている配送の無い置き場だけを消す', t => {
  const root = fresh(t), rows = [self];
  const bind = (entry, id = randomUUID()) => { writeFileSync(join(entry.dir, 'delivery.json'), JSON.stringify({ delivery_id: id })); return entry; };
  const old = 2 * DAY, recent = DAY / 2;

  // 配送を結んでいない（誤りで返った呼び出し、打ち切られた呼び出し）。依頼元が居ても、1日たてば消す。
  const errored = request(root, 'toolu_errored'); age(errored.dir, old);
  const running = request(root, 'toolu_running'); age(running.dir, recent);
  // 配送を結んであり、依頼元が居る。子が長く動いている配送なので、何日たっても残す。
  const pending = bind(request(root, 'toolu_pending')); age(pending.dir, 30 * DAY);
  // 配送を結んだまま、依頼元が居なくなった。1日は残し、その後に消す。
  const orphan = bind(request(root, 'toolu_orphan', { owner: gone })); age(orphan.dir, old);
  const evidence = bind(request(root, 'toolu_evidence', { owner: gone }));
  writeFileSync(join(evidence.dir, 'answer.json'), '{}'); age(evidence.dir, recent);
  // 同じpidが別のprocessに使い回されている。依頼元は居ない。
  const reused = bind(request(root, 'toolu_reused', { owner: { pid: process.pid, started_identity: '別の開始時刻' } })); age(reused.dir, old);
  // 出し終えたのに、送り手が消せなかった。
  const emitted = bind(request(root, 'toolu_emitted')); writeFileSync(join(emitted.dir, 'emitted.json'), '{}'); age(emitted.dir, old);
  // 依頼元を読めない。
  const broken = bind(request(root, 'toolu_broken')); writeFileSync(join(broken.dir, 'request.json'), '{'); age(broken.dir, old);
  // 置き場は古いが、中に新しい書き込みがある。
  const touched = bind(request(root, 'toolu_touched', { owner: gone })); age(touched.dir, old);
  writeFileSync(join(touched.dir, 'answer.json'), '{}'); utimesSync(touched.dir, new Date(Date.now() - old), new Date(Date.now() - old));
  // 消している途中で止まった置き場。
  mkdirSync(join(root, 'toolu_half')); age(join(root, 'toolu_half'), old);
  // この製品の依頼の置き場に見えない物。
  mkdirSync(join(root, 'someone-else')); writeFileSync(join(root, 'someone-else', 'notes.txt'), ''); age(join(root, 'someone-else'), old);
  writeFileSync(join(root, 'stray-file'), '');

  assert.equal(sweepClaudeHookRequests(root, rows), 6);
  assert.deepEqual(readdirSync(root).sort(), ['someone-else', 'stray-file', 'toolu_evidence', 'toolu_pending', 'toolu_running', 'toolu_touched']);
  // 残した置き場の中身には触れない。
  assert.deepEqual(readdirSync(pending.dir).sort(), ['delivery.json', 'request.json']);
  assert.deepEqual(readdirSync(evidence.dir).sort(), ['answer.json', 'delivery.json', 'request.json']);
  // 置き場そのものが無い時も失敗しない。
  assert.equal(sweepClaudeHookRequests(join(root, 'missing'), rows), 0);
});

test('PreToolUseは、依頼を記録した後に古い残りを見回る', t => {
  const root = fresh(t);
  const stale = request(root, 'toolu_stale', { owner: gone }); age(stale.dir, 2 * DAY);
  const input = { session_id: randomUUID(), tool_use_id: 'toolu_new', hook_event_name: 'PreToolUse' };
  prepareClaudeHookRequest(input, root);
  assert.deepEqual(readdirSync(root), ['toolu_new']);
  assert.equal(JSON.parse(readFileSync(join(root, 'toolu_new', 'request.json'), 'utf8')).session_id, input.session_id);
});

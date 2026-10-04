import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { prepareCursorDelivery, submitCursorParentAnswer, runCursorReceive } from '../dist/index.js';

// 受信processは親の背景processとして起き、親が終わった後も残る。
// 残ったprocessが回答を引き取ると、誰も読まないのに送り主は配送済みにする（実物のCursorで席を再起動して確認）。
const setup = t => {
  const root = mkdtempSync(join(tmpdir(), 'steer-cursor-reader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = randomUUID();
  const parent = { kind: 'cursor', hook_root: root };
  prepareCursorDelivery(parent, id);
  return { root, id, parent, claimFile: join(root, 'deliveries', id, 'claim.json') };
};
const output = ({ gone = new Promise(() => {}), probe = async () => true } = {}) => {
  const emitted = [];
  return { emitted, gone, probe, emit: async value => { emitted.push(value); }, close() {} };
};
const unclaimed = error => /^CURSOR_PARENT_DELIVERY_UNCLAIMED/.test(error.message);

test('読み手が居れば、回答を引き取って出す', async t => {
  const { root, id, parent, claimFile } = setup(t);
  const out = output();
  const receiving = runCursorReceive(root, ['--delivery', id], out);
  await submitCursorParentAnswer(parent, id, '届く', 10_000);
  assert.equal(await receiving, 0);
  assert.deepEqual(out.emitted, [{ delivery_id: id, outcome: 'delivered', text: '届く' }]);
  assert.ok(existsSync(claimFile));
});

test('待っている間に読み手が居なくなったら、回答を引き取らずに終わる', async t => {
  const { root, id, parent, claimFile } = setup(t);
  let leave;
  const out = output({ gone: new Promise(resolve => { leave = resolve; }) });
  const receiving = runCursorReceive(root, ['--delivery', id], out);
  leave();
  assert.equal(await receiving, 5);
  await assert.rejects(submitCursorParentAnswer(parent, id, '誰も読まない', 300), unclaimed);
  assert.deepEqual(out.emitted, []);
  assert.ok(!existsSync(claimFile), '回答は引き取られていない');
});

test('回答が来た時に読み手へ書けなければ、引き取らない', async t => {
  const { root, id, parent, claimFile } = setup(t);
  const out = output({ probe: async () => false });
  const receiving = runCursorReceive(root, ['--delivery', id], out);
  await assert.rejects(submitCursorParentAnswer(parent, id, '誰も読まない', 300), unclaimed);
  assert.equal(await receiving, 5);
  assert.deepEqual(out.emitted, []);
  assert.ok(!existsSync(claimFile), '回答は引き取られていない');
});

// 実物のprocessで確かめる。親はstdoutをpipeで受け、切り離して起こす（Cursorの背景shellと同じ形）。
const receiver = (root, id) => {
  const script = `import { runCursorReceive } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist', 'index.js')).href)};
    process.exitCode = await runCursorReceive(process.argv[1], ['--delivery', process.argv[2]]);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, id], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  return { child, exited, stdout: () => stdout };
};
const started = async child => {
  for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
};

test('実物の受信process: 読み手が居れば回答を1行で出す', async t => {
  const { root, id, parent, claimFile } = setup(t);
  const run = receiver(root, id);
  t.after(() => { if (run.child.exitCode === null) run.child.kill(); });
  await submitCursorParentAnswer(parent, id, '届く', 20_000);
  assert.equal(await run.exited, 0);
  assert.deepEqual(JSON.parse(run.stdout().trim().split('\n').at(-1)), { delivery_id: id, outcome: 'delivered', text: '届く' });
  assert.ok(existsSync(claimFile));
});

test('実物の受信process: 親が出力を読むのをやめた後は、回答を引き取らずに終わる', async t => {
  const { root, id, parent, claimFile } = setup(t);
  const run = receiver(root, id);
  t.after(() => { if (run.child.exitCode === null) run.child.kill(); });
  // 受信processが待ちに入ってから、親の読み口を閉じる（親のprocessが終わった時に当たる）。
  await new Promise(resolve => setTimeout(resolve, 1500));
  run.child.stdout.destroy();
  await assert.rejects(submitCursorParentAnswer(parent, id, '誰も読まない', 3000), unclaimed);
  assert.equal(await run.exited, 5);
  assert.ok(!existsSync(claimFile), '回答は引き取られていない');
});

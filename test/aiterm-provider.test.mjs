import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import {
  findAitermDeliveryProvider, verifyCodexParentViaAiterm, submitCodexParentAnswerViaAiterm, codexDeliveryStateViaAiterm, codexDeliveryDetailViaAiterm,
  CodexDeliveryError,
} from '../dist/index.js';

// 2026-10-07: ほかの製品（決裁箱）が、Codexの親への回答を自分のhookでなくAitermの親配送へ頼む入口。
// Aitermの命令（aiterm-parent-delivery）の代わりに、受けた引数とstdinを記録して決まった返りを出す偽の命令で確かめる。
const fresh = t => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'steer-provider-'))); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const parent = { thread_id: '11111111-2222-4333-8444-555555555555', codex_home: join(tmpdir(), 'codex-home') };
const DELIVERY = '22222222-3333-4444-8555-666666666666';
const SCHEMA = 'aiterm.parent-delivery.v1';

/** 偽の命令。modeで返りを変える。受けた引数とstdinは <dir>/seen.json へ残す。 */
function fakeCli(dir, mode, name = 'parent-delivery-cli.js') {
  const file = join(dir, name);
  writeFileSync(file, `
    import fs from 'node:fs';
    let input = ''; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) input += chunk;
    fs.writeFileSync(${JSON.stringify(join(dir, 'seen.json'))}, JSON.stringify({ args: process.argv.slice(2), input }));
    const out = value => process.stdout.write(JSON.stringify(value) + '\\n');
    const command = process.argv[3];
    switch (${JSON.stringify(mode)}) {
      case 'ok':
        if (command === 'verify') out({ ok: true, schema: ${JSON.stringify(SCHEMA)}, verified: true, thread: { thread_id: process.argv[5], cwd: '/work', source: 'cli' }, steer: 'enabled' });
        else if (command === 'submit') out({ ok: true, schema: ${JSON.stringify(SCHEMA)}, queued_submission_id: 'queued-1' });
        else out({ ok: true, schema: ${JSON.stringify(SCHEMA)}, state: null, hook: 'emitted', turn_id: 'turn-1', queued: false });
        break;
      case 'refuse': out({ ok: false, schema: ${JSON.stringify(SCHEMA)}, code: 'CODEX_STEER_RESTART_REQUIRED', message: 'CODEX_STEER_RESTART_REQUIRED: 親のCodexはhookの導入前から動いています', outcome_unknown: false }); process.exitCode = 1; break;
      case 'unknown': out({ ok: false, schema: ${JSON.stringify(SCHEMA)}, code: 'CODEX_RECEIVER_TIMEOUT', message: 'CODEX_RECEIVER_TIMEOUT: thread/queue/addの応答を確認できません', outcome_unknown: true }); process.exitCode = 1; break;
      case 'garbage': process.stdout.write('not json\\n'); break;
      case 'silent': break;
      case 'schema': out({ ok: true, schema: 'something.else.v1' }); break;
      case 'hang': await new Promise(resolve => setTimeout(resolve, 5000)); break;
    }
  `);
  return file;
}
const seen = dir => JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'));
const emptyEnv = (dir) => ({ HOME: join(dir, 'no-home'), PATH: '' });

test('命令の場所は、明示・aiterm-setupの記録・PATHの順に探し、明示が使えない時は別の場所へ移らない', { skip: process.platform === 'win32' }, t => {
  const dir = fresh(t);
  const home = join(dir, 'home');
  const recorded = fakeCli(dir, 'ok', 'recorded.js');
  const onPath = fakeCli(dir, 'ok', 'on-path.js');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  symlinkSync(onPath, join(bin, 'aiterm-parent-delivery'));
  const env = { HOME: home, PATH: [join(dir, 'empty'), bin].join(delimiter) };
  // 記録が無ければPATH。npmのlinkの先の本体を指す。
  assert.deepEqual(findAitermDeliveryProvider({ env }), { node: process.execPath, cli: onPath, version: null, source: 'path' });
  mkdirSync(join(home, '.config', 'aiterm-mcp'), { recursive: true });
  const record = join(home, '.config', 'aiterm-mcp', 'delivery-provider.json');
  writeFileSync(record, JSON.stringify({ schema: 'aiterm.delivery-provider.v1', version: '0.56.0', node: process.execPath, cli: recorded }));
  assert.deepEqual(findAitermDeliveryProvider({ env }), { node: process.execPath, cli: recorded, version: '0.56.0', source: 'record' });
  // 記録が指す命令が無くなっていたら（導入し直しの途中など）、PATHを探す。
  writeFileSync(record, JSON.stringify({ schema: 'aiterm.delivery-provider.v1', version: '0.56.0', node: process.execPath, cli: join(dir, 'gone.js') }));
  assert.equal(findAitermDeliveryProvider({ env }).source, 'path');
  // 形の合わない記録は読まない。
  writeFileSync(record, JSON.stringify({ schema: 'other', node: process.execPath, cli: recorded }));
  assert.equal(findAitermDeliveryProvider({ env }).source, 'path');
  const explicit = fakeCli(dir, 'ok', 'explicit.js');
  assert.deepEqual(findAitermDeliveryProvider({ env, cli: explicit }), { node: process.execPath, cli: explicit, version: null, source: 'explicit' });
  assert.equal(findAitermDeliveryProvider({ env: { ...env, AITERM_PARENT_DELIVERY_CLI: explicit } }).source, 'explicit');
  assert.equal(findAitermDeliveryProvider({ env, cli: join(dir, 'missing.js') }), null, '明示した場所が無い時、PATHへ移らない');
  assert.equal(findAitermDeliveryProvider({ env, cli: 'relative.js' }), null);
  assert.equal(findAitermDeliveryProvider({ env: emptyEnv(dir) }), null);
});

test('確かめ・渡し・状態は、Aitermの命令の返りをそのまま写す。本文はstdinで渡し、引数へ載せない', async t => {
  const dir = fresh(t);
  const options = { cli: fakeCli(dir, 'ok'), env: emptyEnv(dir) };
  assert.deepEqual(await verifyCodexParentViaAiterm(parent, options), { thread: { thread_id: parent.thread_id, cwd: '/work', source: 'cli' }, steer: 'enabled' });
  assert.deepEqual(seen(dir), { args: ['codex', 'verify', '--thread', parent.thread_id, '--codex-home', parent.codex_home], input: '' });
  const text = `1行目\n"引用" と 'single' と $HOME と \`backtick\`\n${'長い本文。'.repeat(20000)}`;
  assert.deepEqual(await submitCodexParentAnswerViaAiterm(parent, DELIVERY, text, options), { queued_submission_id: 'queued-1' });
  assert.deepEqual(seen(dir), { args: ['codex', 'submit', '--thread', parent.thread_id, '--codex-home', parent.codex_home, '--delivery', DELIVERY, '--text-file', '-'], input: text });
  assert.deepEqual(await codexDeliveryDetailViaAiterm(parent, DELIVERY, options), { state: null, hook: 'emitted', turn_id: 'turn-1', queued: false });
  assert.equal(await codexDeliveryStateViaAiterm(parent, DELIVERY, options), null);
  assert.deepEqual(seen(dir).args, ['codex', 'state', '--thread', parent.thread_id, '--codex-home', parent.codex_home, '--delivery', DELIVERY]);
});

test('配送idがUUIDでなければ、命令を起こす前に断る', async t => {
  const dir = fresh(t);
  const options = { cli: fakeCli(dir, 'ok'), env: emptyEnv(dir) };
  await assert.rejects(submitCodexParentAnswerViaAiterm(parent, 'channel-1', 'text', options));
  await assert.rejects(codexDeliveryStateViaAiterm(parent, 'channel-1', options));
  assert.throws(() => seen(dir), { code: 'ENOENT' }, '命令は起きていない');
});

test('Aitermが断った理由と「受け付けたか分からない」を、今までの例外の形で返す', async t => {
  const dir = fresh(t);
  const refused = { cli: fakeCli(dir, 'refuse', 'refuse.js'), env: emptyEnv(dir) };
  for (const call of [() => verifyCodexParentViaAiterm(parent, refused), () => submitCodexParentAnswerViaAiterm(parent, DELIVERY, 'text', refused)]) {
    await assert.rejects(call, error => {
      assert(error instanceof CodexDeliveryError);
      assert.equal(error.delivery_code, 'CODEX_STEER_RESTART_REQUIRED');
      assert.equal(error.outcome_unknown, false);
      assert.equal(error.code, 2);
      assert.equal(error.message, 'CODEX_STEER_RESTART_REQUIRED: 親のCodexはhookの導入前から動いています', '理由の符号を二重に付けない');
      return true;
    });
  }
  const unknown = { cli: fakeCli(dir, 'unknown', 'unknown.js'), env: emptyEnv(dir) };
  await assert.rejects(submitCodexParentAnswerViaAiterm(parent, DELIVERY, 'text', unknown), error => {
    assert.deepEqual([error.delivery_code, error.outcome_unknown], ['CODEX_RECEIVER_TIMEOUT', true]);
    return true;
  });
});

test('Aitermの命令が無い・古い・返りを読めない時は、別の道へ逃がさずに断る', async t => {
  const dir = fresh(t);
  const env = emptyEnv(dir);
  const expect = (unknown, pattern) => error => {
    assert(error instanceof CodexDeliveryError);
    assert.deepEqual([error.delivery_code, error.outcome_unknown], ['AITERM_PROVIDER_UNAVAILABLE', unknown]);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
  // 見つからない時は起こしていないので、送っていないと言い切れる。
  await assert.rejects(submitCodexParentAnswerViaAiterm(parent, DELIVERY, 'text', { env }), expect(false, /aiterm-parent-delivery.*見つかりません.*本文は送っていません/));
  await assert.rejects(verifyCodexParentViaAiterm(parent, { env, cli: join(dir, 'missing.js') }), expect(false));
  for (const mode of ['garbage', 'silent', 'schema']) {
    const options = { cli: fakeCli(dir, mode, `${mode}.js`), env };
    // 本文を渡した後に返りを読めなかった時だけ、受け付けたか分からないと数える。
    await assert.rejects(submitCodexParentAnswerViaAiterm(parent, DELIVERY, 'text', options), expect(true), mode);
    await assert.rejects(verifyCodexParentViaAiterm(parent, options), expect(false), mode);
    await assert.rejects(codexDeliveryStateViaAiterm(parent, DELIVERY, options), expect(false), mode);
  }
  const hang = { cli: fakeCli(dir, 'hang', 'hang.js'), env, timeout_ms: 300 };
  await assert.rejects(submitCodexParentAnswerViaAiterm(parent, DELIVERY, 'text', hang), expect(true, /時間内に返りがありません/));
  await assert.rejects(verifyCodexParentViaAiterm(parent, hang), expect(false));
  // nodeを起こせない時は、何も渡していない。
  await assert.rejects(submitCodexParentAnswerViaAiterm(parent, DELIVERY, 'text', { cli: fakeCli(dir, 'ok', 'ok.js'), node: join(dir, 'no-node'), env }), expect(false, /起動できません/));
});

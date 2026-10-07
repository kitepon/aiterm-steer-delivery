import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, delimiter } from 'node:path';
import { withCodexReceiver, codexSpawnEnv } from '../dist/index.js';

// 偽のApp Server。受け取った要求へ、自分の環境の値を返す。
const server = `import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  process.stdout.write(JSON.stringify({ id: message.id, result: message.method === 'path' ? { path: process.env.PATH ?? process.env.Path ?? null }
    : { marker: process.env.STEER_TEST_MARKER ?? null, codex_home: process.env.CODEX_HOME ?? null } }) + '\\n');
});`;
const profile = { codex_client_name: 'demo' };

test('withCodexReceiverは、渡した環境でApp Serverを起こし、CODEX_HOMEは宛先の物で上書きする', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'steer-receiver-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'app-server.mjs');
  writeFileSync(script, server);
  const parent = { thread_id: '00000000-0000-4000-8000-000000000000', codex_home: join(dir, 'home') };
  const ask = runtime => withCodexReceiver(profile, parent, request => request('probe', {}), { executable: process.execPath, args: [script], timeout_ms: 10000, ...runtime });
  process.env.STEER_TEST_MARKER = 'このprocessの環境';
  t.after(() => { delete process.env.STEER_TEST_MARKER; });
  assert.deepEqual(await ask({}), { marker: 'このprocessの環境', codex_home: parent.codex_home });
  assert.deepEqual(await ask({ env: { ...process.env, STEER_TEST_MARKER: '渡した環境', CODEX_HOME: '/elsewhere' } }), { marker: '渡した環境', codex_home: parent.codex_home });
});

test('Codexを起こす環境のPATHへ、このprocessのnodeの場所が無い時だけ足す', () => {
  // npm版のCodexは、nodeで動く起動役。起こす側のPATHにnodeの場所が無いと起きない（素のsshの環境、製品の常駐process）。
  assert.deepEqual(codexSpawnEnv({ PATH: '/usr/bin:/bin', A: '1' }, '/opt/node/bin/node', 'linux'), { PATH: '/opt/node/bin:/usr/bin:/bin', A: '1' });
  const listed = { PATH: '/usr/bin:/opt/node/bin:/bin' };
  assert.equal(codexSpawnEnv(listed, '/opt/node/bin/node', 'linux'), listed, '既にあれば、同じ物をそのまま返す');
  assert.deepEqual(codexSpawnEnv({}, '/opt/node/bin/node', 'linux'), { PATH: '/opt/node/bin' });
  assert.deepEqual(codexSpawnEnv({ PATH: '' }, '/opt/node/bin/node', 'darwin'), { PATH: '/opt/node/bin' });
  // Windowsは変数名も場所も大文字小文字を区別しない。
  assert.deepEqual(codexSpawnEnv({ Path: 'C:\\Windows\\System32' }, 'C:\\Program Files\\nodejs\\node.exe', 'win32'), { Path: 'C:\\Program Files\\nodejs;C:\\Windows\\System32' });
  const windowsListed = { Path: 'c:\\program files\\NODEJS;C:\\Windows' };
  assert.equal(codexSpawnEnv(windowsListed, 'C:\\Program Files\\nodejs\\node.exe', 'win32'), windowsListed);
});

test('withCodexReceiverは、PATHにnodeの場所が無い環境を渡されても、nodeの場所を足してApp Serverを起こす', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'steer-receiver-path-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'app-server.mjs');
  writeFileSync(script, server);
  const parent = { thread_id: '00000000-0000-4000-8000-000000000000', codex_home: join(dir, 'home') };
  const thin = join(dir, 'thin-bin');
  const key = Object.keys(process.env).find(name => name.toLowerCase() === 'path') ?? 'PATH';
  const seen = await withCodexReceiver(profile, parent, request => request('path', {}),
    { executable: process.execPath, args: [script], timeout_ms: 10000, env: { ...process.env, [key]: thin } });
  assert.equal(seen.path, `${dirname(process.execPath)}${delimiter}${thin}`);
});

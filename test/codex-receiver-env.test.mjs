import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withCodexReceiver } from '../dist/index.js';

// 偽のApp Server。受け取った要求へ、自分の環境の値を返す。
const server = `import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  process.stdout.write(JSON.stringify({ id: message.id, result: { marker: process.env.STEER_TEST_MARKER ?? null, codex_home: process.env.CODEX_HOME ?? null } }) + '\\n');
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

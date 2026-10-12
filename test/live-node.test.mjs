import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { liveNodeExecutable, channelReceiveProcess, cursorReceiveProcess, codexSpawnEnv } from '../dist/index.js';

// 2026-10-12、MacでHomebrewがNodeを26.10.0_1から26.11.1へ上げ、前の版の場所が消えた。上がる前から動いていたprocessは、
// 自分が起きた版つきの場所（process.execPath）でNodeを起こそうとして、黙って失敗していた（Aitermのprocessだけで19個）。

test('起こす先のNode: Homebrewは更新でも残る場所、実体が消えていればPATHのnode', () => {
  const only = (...files) => file => files.includes(file);
  const cellar = '/opt/homebrew/Cellar/node/26.10.0_1/bin/node';
  assert.equal(liveNodeExecutable(cellar, only('/opt/homebrew/opt/node/bin/node')), '/opt/homebrew/opt/node/bin/node', '実体が消えた後も、更新で残る場所を返す');
  assert.equal(liveNodeExecutable(cellar, only(cellar, '/opt/homebrew/opt/node/bin/node')), '/opt/homebrew/opt/node/bin/node', '実体がある間も同じ場所（渡した先が、更新の後に使う事がある）');
  assert.equal(liveNodeExecutable('/usr/local/Cellar/node@24/24.2.0/bin/node', only('/usr/local/opt/node@24/bin/node')), '/usr/local/opt/node@24/bin/node');
  assert.equal(liveNodeExecutable(cellar, only(cellar)), cellar, '残る場所が無い時は、今の実体');
  assert.equal(liveNodeExecutable(cellar, only()), 'node');
  assert.equal(liveNodeExecutable('/home/u/.local/lib/node-v24/bin/node', only('/home/u/.local/lib/node-v24/bin/node')), '/home/u/.local/lib/node-v24/bin/node');
  assert.equal(liveNodeExecutable('/home/u/.nvm/versions/node/v24.1.0/bin/node', only()), 'node', '版ごとの場所へ入れる道具で前の版を消した時');
  assert.equal(liveNodeExecutable('C:\\Program Files\\nodejs\\node.exe', only('C:\\Program Files\\nodejs\\node.exe')), 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(liveNodeExecutable(), liveNodeExecutable(process.execPath));
});

test('呼び手へ渡す待ち受けの起動先と、Codexへ渡すPATHは、同じ場所を使う', () => {
  const node = liveNodeExecutable();
  assert.equal(channelReceiveProcess('/x/receive.mjs', '11111111-2222-4333-8444-555555555555').executable, node);
  assert.equal(cursorReceiveProcess('/x/receive.mjs', '11111111-2222-4333-8444-555555555555').executable, node);
  const key = process.platform === 'win32' ? 'Path' : 'PATH';
  assert.equal(codexSpawnEnv({ [key]: 'thin' })[key].split(process.platform === 'win32' ? ';' : ':')[0], dirname(node));
});

// 本物のNodeの写しでHomebrewの並びを作り、動いているprocessの足元で版を上げる。
test('動いているprocessの足元でNodeが上がって前の版が消えても、Nodeを起こせる', { skip: process.platform === 'win32' && '動いている実行fileを消せない' }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'steer-live-node-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keg = version => join(root, 'Cellar', 'node', version, 'bin', 'node');
  // HomebrewのNodeは、隣のlib（libnode）を読んで起きる。写しの隣にも置く。
  const lib = join(dirname(dirname(process.execPath)), 'lib');
  const install = version => {
    mkdirSync(dirname(keg(version)), { recursive: true });
    try { linkSync(process.execPath, keg(version)); } catch { copyFileSync(process.execPath, keg(version)); }
    if (existsSync(lib)) symlinkSync(lib, join(root, 'Cellar', 'node', version, 'lib'));
    rmSync(join(root, 'opt', 'node'), { force: true });
    mkdirSync(join(root, 'opt'), { recursive: true });
    symlinkSync(join(root, 'Cellar', 'node', version), join(root, 'opt', 'node'));
  };
  install('1.0.0');
  const script = join(root, 'long-running.mjs');
  writeFileSync(script, `import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { liveNodeExecutable } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'dist', 'index.js')).href)};
process.stdout.write('started\\n');
process.stdin.once('data', () => {
  const run = executable => { const out = spawnSync(executable, ['-e', 'process.stdout.write("alive")'], { encoding: 'utf8' }); return out.error?.code ?? out.stdout; };
  process.stdout.write(JSON.stringify({ own: process.execPath, own_exists: existsSync(process.execPath), old: run(process.execPath), live: liveNodeExecutable(), now: run(liveNodeExecutable()) }) + '\\n');
  process.exit(0);
});
`);
  // PATHにはnodeを置かない（PATHに頼らずに起こせる事を見る）。
  const child = spawn(join(root, 'opt', 'node', 'bin', 'node'), [script], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, PATH: join(root, 'empty') } });
  t.after(() => child.kill());
  const lines = [];
  let wake = () => {};
  child.stdout.setEncoding('utf8').on('data', chunk => { lines.push(...chunk.split('\n').filter(Boolean)); wake(); });
  const line = async index => { while (lines.length <= index) await new Promise(resolve => { wake = resolve; }); return lines[index]; };
  assert.equal(await line(0), 'started');
  install('2.0.0');
  rmSync(join(root, 'Cellar', 'node', '1.0.0'), { recursive: true });
  child.stdin.write('go\n');
  assert.deepEqual(JSON.parse(await line(1)), {
    own: keg('1.0.0'), own_exists: false, old: 'ENOENT',
    live: join(root, 'opt', 'node', 'bin', 'node'), now: 'alive',
  });
});

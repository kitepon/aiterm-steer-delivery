import test from 'node:test';
import assert from 'node:assert/strict';
import { channelReceiveProcess, cursorReceiveProcess, waitProcessCommandLine } from '../dist/index.js';

test('背景の受信を起動する情報を、親のshellへ書ける1行にする', () => {
  const wait = { executable: '/opt/node/bin/node', args: ['/a b/cursor-parent-receive.js', '--delivery', "x'y"] };
  assert.equal(waitProcessCommandLine(wait, 'linux'), `'/opt/node/bin/node' '/a b/cursor-parent-receive.js' '--delivery' 'x'\\''y'`);
  assert.equal(waitProcessCommandLine({ executable: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\a\\r.js', '--delivery', "x'y"] }, 'win32'),
    `& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\a\\r.js' '--delivery' 'x''y'`);
});

test('単発配送とchannelの起動情報をそのまま渡せる', () => {
  const id = '6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
  assert.equal(waitProcessCommandLine(cursorReceiveProcess('/p/receive.js', id, '/n/node'), 'darwin'), `'/n/node' '/p/receive.js' '--delivery' '${id}'`);
  assert.equal(waitProcessCommandLine(channelReceiveProcess('/p/channel.js', id, '/n/node'), 'linux'), `'/n/node' '/p/channel.js' '--channel' '${id}'`);
});

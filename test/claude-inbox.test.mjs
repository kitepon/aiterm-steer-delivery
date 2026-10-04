import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sendClaudeInbox } from '../dist/index.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function inbox(t, receive = () => {}) {
  const root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'si-'));
  const socket_path = process.platform === 'win32' ? `\\\\.\\pipe\\steer-test-${randomUUID()}` : join(root, 'inbox.sock');
  const connections = new Set();
  const frames = [];
  const server = createServer({ allowHalfOpen: true }, socket => {
    connections.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => connections.delete(socket));
    socket.setEncoding('utf8');
    let buffered = '';
    socket.on('data', chunk => {
      buffered += chunk;
      let at;
      while ((at = buffered.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffered.slice(0, at));
        buffered = buffered.slice(at + 1);
        frames.push(frame);
        receive(frame, socket);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket_path, resolve); });
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  return { target: { socket_path, token: 'test-only-token' }, frames };
}

test('MCPやprofile無しでauthとUTF-8のuserフレームを1通だけ送り、受領確認でacceptedを返す', async t => {
  const received = deferred();
  let observing = false;
  const peer = await inbox(t, frame => {
    if (frame.type === 'user') { assert.equal(observing, true); received.resolve(true); }
  });
  const text = '作業を続けて\n"引用"と\\と🗲';
  const result = await sendClaudeInbox(peer.target, text, { confirm_acceptance: () => { observing = true; return received.promise; } });
  assert.deepEqual(result, { status: 'accepted', outcome_unknown: false, reason: 'receiver_confirmed' });
  assert.deepEqual(peer.frames, [
    { type: 'auth', token: 'test-only-token' },
    { type: 'user', message: { role: 'user', content: text } },
  ]);
});

test('書き込み完了と任意のsocket返信を、会話の受付済みにはしない', async t => {
  const received = deferred();
  const peer = await inbox(t, (frame, socket) => {
    if (frame.type === 'user') { received.resolve(); socket.end('{"ok":true}\n'); }
  });
  const result = await sendClaudeInbox(peer.target, '1通だけ');
  assert.deepEqual(result, { status: 'unknown', outcome_unknown: true, reason: 'unconfirmed' });
  await received.promise;
  assert.equal(peer.frames.filter(frame => frame.type === 'user').length, 1);
});

test('接続できなければ未送信。path・token・本文を結果に含めない', async () => {
  const target = { socket_path: process.platform === 'win32' ? `\\\\.\\pipe\\gone-${randomUUID()}` : `/tmp/gone-${randomUUID()}.sock`, token: 'private-token' };
  const result = await sendClaudeInbox(target, 'private-text');
  assert.deepEqual(result, { status: 'not_sent', outcome_unknown: false, reason: 'connect_failed' });
  assert.doesNotMatch(JSON.stringify(result), /private|gone-/);
});

test('送信後に受領観測が失敗しても未送信とせず、再送しない', async t => {
  const received = deferred();
  const peer = await inbox(t, frame => {
    if (frame.type === 'user') received.reject(new Error('private-token private-text'));
  });
  const result = await sendClaudeInbox(peer.target, '1通だけ', { confirm_acceptance: () => received.promise });
  assert.deepEqual(result, { status: 'unknown', outcome_unknown: true, reason: 'confirmation_failed' });
  assert.equal(peer.frames.filter(frame => frame.type === 'user').length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('受領観測を始められない時は送信前に断る', async t => {
  const peer = await inbox(t);
  const result = await sendClaudeInbox(peer.target, '送らない', { confirm_acceptance: () => { throw new Error('observer failed'); } });
  assert.deepEqual(result, { status: 'not_sent', outcome_unknown: false, reason: 'confirmation_failed' });
  assert.deepEqual(peer.frames, []);
});

test('書き込み前に解決する古い受領票でacceptedにせず、送らない', async t => {
  const peer = await inbox(t);
  const result = await sendClaudeInbox(peer.target, '送らない', { confirm_acceptance: async () => true });
  assert.deepEqual(result, { status: 'not_sent', outcome_unknown: false, reason: 'confirmation_failed' });
  assert.deepEqual(peer.frames, []);
});

test('送信後の期限切れはunknownで、観測を取り消し、自動再送しない', async t => {
  const received = deferred();
  const peer = await inbox(t, frame => { if (frame.type === 'user') received.resolve(); });
  let signal;
  const result = await sendClaudeInbox(peer.target, '1通だけ', { timeout_ms: 1000, confirm_acceptance: value => {
    signal = value;
    return new Promise(resolve => value.addEventListener('abort', () => resolve(false), { once: true }));
  } });
  assert.deepEqual(result, { status: 'unknown', outcome_unknown: true, reason: 'timeout' });
  await received.promise;
  assert.equal(signal.aborted, true);
  assert.equal(peer.frames.filter(frame => frame.type === 'user').length, 1);
});

test('書き込み後にsocketが閉じても、別経路の受領確認を待てる', async t => {
  const received = deferred();
  const peer = await inbox(t, (frame, socket) => {
    if (frame.type === 'user') { socket.end(); setTimeout(() => received.resolve(true), 100); }
  });
  const result = await sendClaudeInbox(peer.target, '受領確認', { confirm_acceptance: () => received.promise });
  assert.equal(result.status, 'accepted');
});

test('Windowsでtokenが無い時は接続前に断る', { skip: process.platform !== 'win32' }, async t => {
  const peer = await inbox(t);
  const result = await sendClaudeInbox({ socket_path: peer.target.socket_path }, '送らない');
  assert.deepEqual(result, { status: 'not_sent', outcome_unknown: false, reason: 'token_required' });
  assert.deepEqual(peer.frames, []);
});

test('POSIXではtoken無しのraw userも送れる', { skip: process.platform === 'win32' }, async t => {
  const received = deferred();
  const peer = await inbox(t, () => received.resolve(true));
  const result = await sendClaudeInbox({ socket_path: peer.target.socket_path }, '受領確認', { confirm_acceptance: () => received.promise });
  assert.equal(result.status, 'accepted');
  assert.equal(peer.frames.length, 1);
  assert.equal(peer.frames[0].type, 'user');
});

test('不正な引数と大きすぎる本文は未送信で拒否する', async t => {
  const peer = await inbox(t);
  for (const [text, options] of [['', {}], ['x', { timeout_ms: NaN }], ['x', { timeout_ms: 0 }], ['x'.repeat(1_000_000), {}]]) {
    assert.deepEqual(await sendClaudeInbox(peer.target, text, options), { status: 'not_sent', outcome_unknown: false, reason: 'invalid_request' });
  }
  assert.deepEqual(peer.frames, []);
  assert.equal((await sendClaudeInbox(peer.target, 'x', null)).reason, 'invalid_request');
  assert.equal((await sendClaudeInbox({ ...peer.target, token: 'x'.repeat(1_000_000) }, 'x')).reason, 'invalid_request');
});

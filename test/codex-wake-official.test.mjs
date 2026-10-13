import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { submitCodexParentAnswer, wakeCodexParentIfAsleep } from '../dist/index.js';
import { codex, sleep, stage } from './official-codex.mjs';

// 公式Codexと手元の偽のmodelで、寝ている会話を起こす所を通す。Codexが無い環境では飛ばす。実物のログインも共有の置き場も使わない。
// アプリの代わりに、リンクを開く関数が「会話を載せる別のprocess」を起こす（アプリが会話を開いた時と同じ thread/resume）。
const skip = !codex && 'Codexがありません';
const DELIVERY = () => crypto.randomUUID();

test('公式Codex: どこにも載っていない会話は、開かせると入れた文が番になる', { skip, timeout: 120_000 }, async t => {
  const s = await stage(t);
  const owner = await s.client();
  const { thread } = await owner.request('thread/start', { cwd: s.root });
  const first = await owner.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: '最初の文', text_elements: [] }] });
  assert.equal(await owner.completed(first.turn.id), 'completed');
  await owner.close();
  const parent = { thread_id: thread.id, codex_home: s.home };
  const delivery = DELIVERY();
  await submitCodexParentAnswer(s.profile, parent, delivery, 'WAKE_OFFICIAL_TEXT', s.runtime);
  // 載せているprocessが無いので、待っても番にならない。
  await sleep(12_000);
  assert.equal(s.queued('WAKE_OFFICIAL_TEXT'), 0, '開く前は動かない');
  const opened = [];
  const result = await wakeCodexParentIfAsleep(s.profile, parent, delivery, { delay_ms: 0, confirm_ms: 30_000, runtime: s.runtime, directory: join(s.root, 'wake'),
    open: url => { opened.push(url); void s.client().then(app => app.request('thread/resume', { threadId: thread.id })); return { ok: true }; } });
  assert.deepEqual(opened, [`codex://threads/${thread.id}`]);
  assert.equal(result.turn, 'completed');
  assert.equal(result.outcome, 'woken');
  for (let i = 0; i < 100 && s.queued('WAKE_OFFICIAL_TEXT') === 0; i++) await sleep(100);
  assert.equal(s.queued('WAKE_OFFICIAL_TEXT'), 1, '入れた文がmodelへ一度だけ届く');
});

test('公式Codex: 載っている会話は、Codexが自分で番にするので開かない', { skip, timeout: 120_000 }, async t => {
  const s = await stage(t);
  const owner = await s.client();
  const { thread } = await owner.request('thread/start', { cwd: s.root });
  const first = await owner.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: '最初の文', text_elements: [] }] });
  assert.equal(await owner.completed(first.turn.id), 'completed');
  const parent = { thread_id: thread.id, codex_home: s.home };
  const delivery = DELIVERY();
  await submitCodexParentAnswer(s.profile, parent, delivery, 'WAKE_OFFICIAL_TEXT', s.runtime);
  const opened = [];
  const result = await wakeCodexParentIfAsleep(s.profile, parent, delivery, { delay_ms: 15_000, runtime: s.runtime, directory: join(s.root, 'wake'),
    open: url => { opened.push(url); return { ok: true }; } });
  assert.equal(result.outcome, 'delivered');
  assert.deepEqual(opened, []);
  assert.equal(s.queued('WAKE_OFFICIAL_TEXT'), 1);
});

test('公式Codex: 番を途中で止めた会話は、載せているprocessが居なくなっても起こさない', { skip, timeout: 120_000 }, async t => {
  const s = await stage(t, { hold: true });
  const owner = await s.client();
  const { thread } = await owner.request('thread/start', { cwd: s.root });
  const first = await owner.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: '最初の文', text_elements: [] }] });
  while (!s.calls.length) await sleep(100);
  await owner.request('turn/interrupt', { threadId: thread.id, turnId: first.turn.id });
  assert.equal(await owner.completed(first.turn.id), 'interrupted');
  s.release();
  await owner.close();
  const parent = { thread_id: thread.id, codex_home: s.home };
  const delivery = DELIVERY();
  await submitCodexParentAnswer(s.profile, parent, delivery, 'WAKE_OFFICIAL_TEXT', s.runtime);
  const opened = [];
  const result = await wakeCodexParentIfAsleep(s.profile, parent, delivery, { delay_ms: 0, runtime: s.runtime, directory: join(s.root, 'wake'),
    open: url => { opened.push(url); return { ok: true }; } });
  assert.equal(result.outcome, 'interrupted');
  assert.equal(result.turn, 'interrupted');
  assert.deepEqual(opened, []);
  assert.equal(s.queued('WAKE_OFFICIAL_TEXT'), 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexInputDirectory, submitCodexParentAnswer } from '../dist/index.js';
import { codex, stage } from './official-codex.mjs';

// 公式Codexと手元の偽のmodelで、片付け済み（archived）の会話へ入れて断られた配送を通す。Codexが無い環境では飛ばす。
const skip = !codex && 'Codexがありません';

test('公式Codex: 片付け済みの会話へ入れて断られた配送は所有記録を残さず、会話を戻すと同じ配送IDで入る', { skip, timeout: 120_000 }, async t => {
  const s = await stage(t);
  const owner = await s.client();
  const { thread } = await owner.request('thread/start', { cwd: s.root });
  const first = await owner.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: '最初の文', text_elements: [] }] });
  assert.equal(await owner.completed(first.turn.id), 'completed');
  await owner.request('thread/archive', { threadId: thread.id });
  await owner.close();

  // hookが有効な製品（所有記録を書く道）。
  const hooks = join(s.root, 'hooks');
  mkdirSync(hooks);
  const profile = { ...s.profile, codex_hook_schema: 'demo.codex-parent-hooks.v1' };
  writeFileSync(join(hooks, 'config.json'), JSON.stringify({ schema: profile.codex_hook_schema, enabled: true, codex_home: s.home,
    binary: codex, command: 'demo-hook', node: process.execPath, hook: join(hooks, 'hook.mjs'), stale_processes: [] }));
  const runtime = { ...s.runtime, hook_directory: hooks };
  const parent = { thread_id: thread.id, codex_home: s.home };
  const delivery = crypto.randomUUID();
  const record = kind => join(codexInputDirectory(hooks, s.home, thread.id), kind, `${delivery}.json`);

  await assert.rejects(submitCodexParentAnswer(profile, parent, delivery, 'REJECTED_OFFICIAL_TEXT', runtime), error => {
    assert.deepEqual([error.delivery_code, error.outcome_unknown], ['CODEX_RECEIVER_REJECTED', false], String(error));
    assert.match(error.message, /archived/);
    return true;
  });
  assert.equal(existsSync(record('pending')), false, '断られた配送の所有記録を残さない');
  assert.equal(existsSync(record('settled')), false);

  const restorer = await s.client();
  await restorer.request('thread/unarchive', { threadId: thread.id });
  await restorer.close();
  const accepted = await submitCodexParentAnswer(profile, parent, delivery, 'REJECTED_OFFICIAL_TEXT', runtime);
  assert.equal(typeof accepted.queued_submission_id, 'string');
  assert.equal(existsSync(record('pending')), true);
  const reader = await s.client();
  const queue = await reader.request('thread/queue/list', { threadId: thread.id, limit: 100 });
  assert.deepEqual(queue.data.map(entry => entry.clientUserMessageId), [delivery], '同じ配送IDの本文が、キューに1通だけ在る');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { handleCursorHook, prepareCursorDelivery, submitCursorParentAnswer, withoutBom } from '../dist/index.js';

const profile = {
  id: 'demo', display_name: 'Demo', setup_command: 'demo-setup', codex_steer_command: 'demo-setup --codex-steer enable',
  mcp_server: 'demo', dispatch_tools: ['ask'], state_root: () => tmpdir(), config_root: () => tmpdir(),
  hooks: { codex: 'demo-codex-hook.js', claude: 'demo-claude-hook.js', cursor: 'demo-cursor-hook.js' },
  codex_client_name: 'demo', codex_hook_schema: 'demo.codex-parent-hooks.v1', backup_suffix: '.demo-backup',
};
const BOM = '﻿';

test('先頭のBOMだけを落とす', () => {
  assert.equal(withoutBom(`${BOM}{"a":1}`), '{"a":1}');
  assert.equal(withoutBom('{"a":1}'), '{"a":1}');
  assert.equal(withoutBom(`{"a":"${BOM}"}`), `{"a":"${BOM}"}`);
});

// WindowsのCursorはhookのstdinのJSONの先頭にBOMを付ける（foxのcursor-agent 2026.09.28で確認）。
test('CursorのhookはBOM付きの入力でも結び付けと差し込みを行う', async t => {
  const hookRoot = mkdtempSync(join(tmpdir(), 'steer-cursor-bom-'));
  t.after(() => rmSync(hookRoot, { recursive: true, force: true }));
  const parent = { kind: 'cursor', hook_root: hookRoot };
  const id = randomUUID();
  prepareCursorDelivery(parent, id);
  const bindEvent = { hook_event_name: 'afterMCPExecution', conversation_id: 'conv-bom', tool_name: 'MCP:ask', result_json: JSON.stringify({ parent_delivery: { delivery_id: id } }) };
  assert.deepEqual(await handleCursorHook(profile, BOM + JSON.stringify(bindEvent), hookRoot), {});
  assert.ok(existsSync(join(hookRoot, 'deliveries', id, 'bind.json')), 'BOM付きでも会話へ結び付ける');
  const submitted = submitCursorParentAnswer(parent, id, '作業中に届く', 10_000);

  // hookの入口（runCursorHookMain）も、BOM付きのstdinを読む。
  const script = `import { runCursorHookMain } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist', 'index.js')).href)};
    const profile = ${JSON.stringify({ ...profile, state_root: undefined, config_root: undefined })};
    await runCursorHookMain({ ...profile, state_root: () => '', config_root: () => '' }, process.argv[1]);`;
  const postEvent = { hook_event_name: 'postToolUse', conversation_id: 'conv-bom', tool_name: 'Shell', tool_output: '{}' };
  let output = {};
  for (let attempt = 0; attempt < 50 && !output.additional_context; attempt++) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, hookRoot], { input: BOM + JSON.stringify(postEvent), encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    output = JSON.parse(run.stdout);
    if (!output.additional_context) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(output.additional_context, '作業中に届く');
  await submitted;
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { prepareCursorDelivery, submitCursorParentAnswer, runCursorReceive } from '../dist/index.js';

const profile = {
  id: 'demo', display_name: 'Demo', setup_command: 'demo-setup', codex_steer_command: 'demo-setup --codex-steer enable',
  mcp_server: 'demo', dispatch_tools: ['ask'], hooks: { codex: 'demo-codex-hook.js', claude: 'demo-claude-hook.js', cursor: 'demo-cursor-hook.js' },
  codex_client_name: 'demo', codex_hook_schema: 'demo.codex-parent-hooks.v1', backup_suffix: '.demo-backup',
};
const hookMain = (roots, event) => {
  const script = `import { runCursorHookMain } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist', 'index.js')).href)};
    await runCursorHookMain({ ...${JSON.stringify(profile)}, state_root: () => '', config_root: () => '' }, JSON.parse(process.argv[1]));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(roots)], { input: JSON.stringify(event), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
};

// Cursor CLIはMCPを削った環境で起動し、hookと受信processは画面側の環境で起動する。環境で置き場を決める製品は置き場が割れる。
test('Cursorのhookと受信は、渡した置き場のうち配送記録のある方を使う', async t => {
  const base = mkdtempSync(join(tmpdir(), 'steer-cursor-roots-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const hookSide = join(base, 'hook-side'), mcpSide = join(base, 'mcp-side');
  mkdirSync(hookSide);
  const roots = [hookSide, mcpSide];

  const busy = randomUUID();
  prepareCursorDelivery({ kind: 'cursor', hook_root: mcpSide }, busy);
  assert.deepEqual(hookMain(roots, { hook_event_name: 'afterMCPExecution', conversation_id: 'conv-roots', tool_name: 'MCP:ask', result_json: JSON.stringify({ parent_delivery: { delivery_id: busy } }) }), {});
  assert.ok(existsSync(join(mcpSide, 'deliveries', busy, 'bind.json')), 'MCPの置き場で結び付ける');
  assert.ok(!existsSync(join(hookSide, 'deliveries')), '配送記録の無い置き場には何も作らない');
  const submitted = submitCursorParentAnswer({ kind: 'cursor', hook_root: mcpSide }, busy, '作業中に届く', 10_000);
  let output = {};
  for (let attempt = 0; attempt < 50 && !output.additional_context; attempt++) {
    output = hookMain(roots, { hook_event_name: 'postToolUse', conversation_id: 'conv-roots', tool_name: 'Shell', tool_output: '{}' });
    if (!output.additional_context) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(output.additional_context, '作業中に届く');
  await submitted;

  const idle = randomUUID();
  prepareCursorDelivery({ kind: 'cursor', hook_root: mcpSide }, idle);
  const emitted = [];
  const receiving = runCursorReceive(roots, ['--delivery', idle], value => emitted.push(value));
  await submitCursorParentAnswer({ kind: 'cursor', hook_root: mcpSide }, idle, 'idle中に届く', 10_000);
  assert.equal(await receiving, 0);
  assert.deepEqual(emitted, [{ delivery_id: idle, outcome: 'delivered', text: 'idle中に届く' }]);
});

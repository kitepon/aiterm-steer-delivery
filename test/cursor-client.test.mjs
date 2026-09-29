import test from 'node:test';
import assert from 'node:assert/strict';
import { isCursorMcpClient } from '../dist/index.js';

test('Cursor DesktopとCursor CLIの名乗りをCursor親として見分ける', () => {
  assert.equal(isCursorMcpClient('cursor-vscode'), true);
  assert.equal(isCursorMcpClient('cursor-vscode (via mcp-remote 0.1.29)'), true);
  assert.equal(isCursorMcpClient('Cursor'), true);
  assert.equal(isCursorMcpClient('cursor'), false);
  assert.equal(isCursorMcpClient('Cursor Tab'), false);
  assert.equal(isCursorMcpClient('codex-mcp-client'), false);
  assert.equal(isCursorMcpClient('claude-code'), false);
  assert.equal(isCursorMcpClient(undefined), false);
});

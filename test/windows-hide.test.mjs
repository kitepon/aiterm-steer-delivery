import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Windowsで、consoleを持たないprocess（切り離した見張り、hookから切り離した処理、予定の仕事から起きた受け取り係）が
// consoleの子を窓を隠さずに起こすと、端末の窓が一瞬出る（2026-10-10、利用者のWindows機で別製品が約2秒おきに出した）。
// このパッケージが子を起こす所は、全部 windowsHide を付ける。POSIXにしか無い命令（絶対pathで書いた物）は数えない。
test('子のprocessを起こす所は、全部 windowsHide を付けている', () => {
  const missing = [];
  let calls = 0;
  for (const name of readdirSync('src').filter(file => file.endsWith('.ts'))) {
    const source = readFileSync(join('src', name), 'utf8');
    if (!source.includes('node:child_process')) continue;
    for (const match of source.matchAll(/(?<![.\w])(spawnSync|execFileSync|execSync|spawn|execFile)\(/g)) {
      let index = match.index + match[0].length, depth = 1;
      while (index < source.length && depth > 0) { const char = source[index++]; if (char === '(') depth++; else if (char === ')') depth--; }
      const call = source.slice(match.index, index);
      if (/^\w+\("\/(?:bin|usr)\//.test(call)) continue;
      calls++;
      if (!call.includes('windowsHide')) missing.push(`${name}:${source.slice(0, match.index).split('\n').length} ${call.replace(/\s+/g, ' ').slice(0, 100)}`);
    }
  }
  assert.ok(calls >= 8, `子を起こす所を読めていない（${calls}）`);
  assert.deepEqual(missing, []);
});

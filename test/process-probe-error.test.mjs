import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const platform of ['linux', 'darwin', 'win32']) test(`process failures preserve safe details (${platform})`, () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    process.kill = () => true;
    fs.realpathSync.native = value => value;
    let result, reads = 0;
    cp.spawnSync = (bin, args) => {
      if (bin === 'where.exe') return { status: 0, stdout: 'C:/Program Files/PowerShell/7/pwsh.exe' };
      if (args.includes('-Command')) return { status: 0, stdout: JSON.stringify({ edition: 'Core', major: 7 }) };
      assert(bin === '/bin/ps' || args.includes('-EncodedCommand'));
      reads++;
      return typeof result === 'function' ? result(args) : result;
    };
    syncBuiltinESMExports();
    const m = await import('./dist/process.js');
    const failures = ['ETIMEDOUT','ENOBUFS','EAGAIN','ENOENT','EACCES','ENOMEM','EMFILE','ENFILE','E2BIG','EPERM','PRIVATE',null];
    for (const code of failures) for (const [probe, call] of [
      ['table', () => m.readRuntimeProcesses()],
      ['identity', () => m.readProcessIdentities([123])],
      ['table', () => m.readProcessLineage(123)],
    ]) {
      result = { error: code ? Object.assign(Error('PRIVATE argv'), { code }) : undefined,
        status: code ? null : 2, signal: code ? 'SIGTERM' : null, stdout: '秘密', stderr: 'PRIVATE' };
      assert.throws(call, error => {
        assert.equal(error.code, 2);
        assert(!error.message.includes('PRIVATE') && !error.message.includes('秘密'));
        assert.equal(error.cause, undefined);
        assert(error.message.includes('{'), 'native process failure details were discarded');
        assert.deepEqual(JSON.parse(error.message.slice(error.message.indexOf('{'))), {
          component: 'aiterm-steer-delivery', probe, code: code === 'PRIVATE' ? 'UNKNOWN' : code,
          status: result.status, signal: result.signal, stdout_bytes: 6, stderr_bytes: 7,
        });
        return true;
      });
    }
    result = { error: Object.assign(Error('PRIVATE'), { code: 'ETIMEDOUT' }), status: null,
      signal: 'SIGKILL', stdout: null, stderr: null };
    assert.throws(() => m.readRuntimeProcesses(), error => {
      const fields = JSON.parse(error.message.slice(error.message.indexOf('{')));
      assert.equal(fields.stdout_bytes, 0); assert.equal(fields.stderr_bytes, 0);
      assert.equal(fields.signal, 'SIGKILL'); return true;
    });
    if (process.platform !== 'win32') {
      result = { status: 1, signal: null, stdout: '', stderr: '' };
      assert.deepEqual(m.readProcessIdentities([123]), []);
      const row = '123 0 123 S Tue Nov 3 09:00:00 2026 00:00:00 node';
      result = { status: 0, stdout: '123 Tue Nov 3 09:00:00 2026', stderr: '' };
      assert.equal(m.readProcessIdentities([123])[0].pid, 123);
      result = args => args[0] === '-axww' ? { status: 0, stdout: row } : { status: 2, stdout: '', stderr: 'PRIVATE' };
      assert.equal(m.readProcessLineage(123)[0].pid, 123, 'first lineage failure still falls back');
      let n = 0;
      result = () => ++n === 1 ? { status: 0, stdout: row.replace('123 0', '123 456') } : { status: 2, stdout: '', stderr: '' };
      assert.equal(m.readProcessLineage(123).length, 1, 'partial lineage remains partial');
    } else {
      result = { status: 0, stdout: '[{"pid":123,"started_identity":"2026-11-03T09:00:00Z"}]' };
      assert.equal(m.readProcessIdentities([123])[0].pid, 123);
      result = { status: 0, stdout: 'not JSON PRIVATE' };
      assert.throws(() => m.readProcessIdentities([123]), /Windowsのprocessの開始時刻を取得できません$/);
    }
    const before = reads;
    assert.deepEqual(m.readProcessIdentities([]), []);
    assert.equal(reads, before);
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
});

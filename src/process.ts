// OSのprocess表。PIDの再利用を見分けるため、開始時刻（started_identity）と組にして扱う。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolveWindowsPowerShell7 } from "./windows.js";

const isWin = process.platform === "win32";
class ProcessTableError extends Error {
  readonly code = 2;
}

export interface NativeProcessIdentity {
  pid: number;
  process_group_id: number | null;
  started_identity: string;
  argv_digest: string;
}

export interface RuntimeProcess extends NativeProcessIdentity {
  executable?: string;
  parent_pid: number;
  cpu_seconds: number;
  command: string;
  stopped: boolean | null;
}

export function processIdentity(process: RuntimeProcess): NativeProcessIdentity {
  return {
    pid: process.pid, process_group_id: process.process_group_id,
    started_identity: process.started_identity, argv_digest: process.argv_digest,
  };
}

export function parseCpuTime(value: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) throw new ProcessTableError("process CPU時間の形式を認識できません");
  return Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600
    + Number(match[3]) * 60 + Number(match[4]);
}

export function parsePosixProcessTable(text: string): RuntimeProcess[] {
  return text.split("\n").filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) throw new ProcessTableError("process一覧の形式を認識できません");
    const command = match[7].trim();
    return {
      pid: Number(match[1]), parent_pid: Number(match[2]), process_group_id: Number(match[3]),
      stopped: match[4].includes("T"),
      started_identity: match[5].trim(), cpu_seconds: parseCpuTime(match[6]), command,
      argv_digest: createHash("sha256").update(command).digest("hex"),
    };
  });
}

/** hookのcommandを動かすshell。Claude Codeは`sh -c`（POSIX）、PowerShellかGit Bash（Windows）を使う。 */
const HOOK_SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash", "busybox", "pwsh", "powershell", "cmd"]);

function executableName(row: RuntimeProcess): string {
  const source = row.executable || (row.command.startsWith('"') ? row.command.slice(1).split('"')[0] : row.command.split(/\s+/u)[0]);
  return (source.split(/[\\/]/u).pop() ?? "").replace(/^-/u, "").replace(/\.exe$/iu, "").toLowerCase();
}

/**
 * hookを起動したharnessのprocess。shellを通す形のhookでは、harnessとhookの間にshellが挟まる。
 * 挟まったshellはhookと一緒に終わるので、`pid`から先祖をたどり、shellでない最初のprocessを返す。
 */
export function hookOwnerProcess(rows: readonly RuntimeProcess[], pid: number): RuntimeProcess | undefined {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  let current = byPid.get(pid);
  for (let depth = 0; current && depth < 4 && HOOK_SHELLS.has(executableName(current)); depth += 1) current = byPid.get(current.parent_pid);
  return current;
}

/** そのpidのprocessが今あるか。OSへ直接聞き、processを起こさない。権限が無くて触れないprocessも「ある」と読む。 */
export function processExists(pid: number): boolean {
  // 0以下はprocess groupを指す。
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function windowsJson(script: string, failure: string): unknown {
  const source = ["$ErrorActionPreference='Stop'", "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)", script].join("\n");
  const result = spawnSync(resolveWindowsPowerShell7(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], {
    encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new ProcessTableError(failure);
  try { return JSON.parse(result.stdout); } catch { throw new ProcessTableError(failure); }
}

function assertPids(pids: readonly number[]): number[] {
  const wanted = [...new Set(pids)];
  if (wanted.some(pid => !Number.isSafeInteger(pid) || pid < 0)) throw new ProcessTableError("process照会のpidが不正です");
  return wanted;
}

// Windowsで1個のprocessを読む時は、WMI（Win32_Process）を使わない。WMIは絞っても1回に0.1〜0.3秒かかり、WMIの側のprocess
// （wmiprvse）のCPUを使う（process 1300個のWindowsで測った 2026-10-12）。.NETのprocessの読み（OpenProcessとGetProcessTimes）は
// 1個1.5ミリ秒で、WMIを起こさない。起動時刻は同じ値になる（WMIはマイクロ秒で切り捨てた値を返し、どちらも1ミリ秒で切り捨てて使う。
// 888個のprocessで食い違いは0だった）。権限が無くて読めないprocessだけ、WMIへ聞き直す。
const WINDOWS_STARTED = [
  "function Started($p) {",
  "  try { return $p.StartTime.ToUniversalTime().ToString('o') }",
  "  catch [InvalidOperationException] { return '' }",
  "  catch { $w = Get-CimInstance Win32_Process -Filter \"ProcessId=$($p.Id)\" -Property CreationDate; if ($null -eq $w) { return '' }",
  "    if ($null -eq $w.CreationDate) { return $null }; return $w.CreationDate.ToUniversalTime().ToString('o') }",
  "}",
].join("\n");

/**
 * 指定したpidだけの開始時刻。readRuntimeProcessesと同じ値を返し、process表に無いpidは返さない。全processの一覧を取らない。
 * 開始時刻を読めないprocess（別の権限のserviceなど）は、pidがprocess表にある印として `started_identity: null` で返す。
 */
export function readProcessIdentities(pids: readonly number[]): { pid: number; started_identity: string | null }[] {
  const wanted = assertPids(pids);
  if (wanted.length === 0) return [];
  if (!isWin) {
    const result = spawnSync("/bin/ps", ["-o", "pid=,lstart=", "-p", wanted.join(",")], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 10000,
    });
    // 該当するprocessが一つも無い時、psは何も出さずstatus 1で終わる。
    if (result.error || (result.status !== 0 && !(result.status === 1 && !result.stdout.trim()))) {
      throw new ProcessTableError("OSのprocess一覧を取得できません");
    }
    return result.stdout.split("\n").filter(line => line.trim()).map(line => {
      const match = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s*$/.exec(line);
      if (!match) throw new ProcessTableError("process一覧の形式を認識できません");
      return { pid: Number(match[1]), started_identity: match[2].trim() };
    });
  }
  const rows = windowsJson([
    WINDOWS_STARTED,
    "$rows=@()",
    `foreach ($id in @(${wanted.join(",")})) {`,
    "  try { $p=[Diagnostics.Process]::GetProcessById($id) } catch [ArgumentException] { continue }",
    "  $started=Started $p",
    "  if ($started -eq '') { continue }",
    "  $rows += [ordered]@{ pid=[int]$id; started_identity=$started }",
    "}",
    "ConvertTo-Json -Compress -InputObject $rows",
  ].join("\n"), "Windowsのprocessの開始時刻を取得できません");
  if (!Array.isArray(rows)) throw new ProcessTableError("Windows processの読みが配列ではありません");
  return rows.map(row => {
    if (!row || !Number.isSafeInteger(row.pid)) throw new ProcessTableError("Windows processの読みのfieldが不正です");
    if (row.started_identity === null) return { pid: row.pid, started_identity: null };
    if (typeof row.started_identity !== "string" || !Number.isFinite(Date.parse(row.started_identity)))
      throw new ProcessTableError("Windows processの読みのfieldが不正です");
    return { pid: row.pid, started_identity: new Date(row.started_identity).toISOString() };
  });
}

/** そのpidのprocessが、記録にある本人（pidと開始時刻の組）のまま居るか。居ないと分かっている時はprocessを起こさない。 */
export function processIsRunning(pid: number, startedIdentity: string): boolean {
  return processExists(pid) && readProcessIdentities([pid])[0]?.started_identity === startedIdentity;
}

/**
 * `pid` と、その先祖のprocess（近い順）。hookOwnerProcessへ渡す行を、全processの一覧を取らずに作る。
 * Windowsは.NETのprocessの読みで親をたどる（`command` は実行fileのpathで、引数は入らない）。読めない時と、ほかのOSは、
 * 今までどおり全processの一覧を返す。
 */
export function readProcessLineage(pid: number, depth = 8): RuntimeProcess[] {
  if (!isWin) return readRuntimeProcesses();
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(depth) || depth <= 0) throw new ProcessTableError("process照会のpidが不正です");
  let rows: unknown;
  try {
    rows = windowsJson([
      "$rows=@(); $child=$null",
      `$id=${pid}`,
      `for ($i=0; $i -lt ${depth} -and $id -gt 0; $i++) {`,
      "  try { $p=Get-Process -Id $id; $started=$p.StartTime.ToUniversalTime() } catch { break }",
      // Windowsの親PIDは親の終了後も残り、別のprocessへ使い回される。子より後に始まったprocessは親でない。
      "  if ($null -ne $child -and $started -gt $child) { break }",
      "  $parent=0; try { if ($null -ne $p.Parent) { $parent=[int]$p.Parent.Id } } catch { }",
      "  $exe=''; try { $exe=[string]$p.Path } catch { }",
      "  if (-not $exe) { $exe=[string]$p.ProcessName }",
      "  $cpu=0.0; try { $cpu=[double]$p.TotalProcessorTime.TotalSeconds } catch { }",
      "  $rows += [ordered]@{ pid=[int]$p.Id; parent_pid=$parent; executable=$exe; started_identity=$started.ToString('o'); cpu_seconds=$cpu }",
      "  $child=$started; $id=$parent",
      "}",
      "ConvertTo-Json -Compress -InputObject $rows",
    ].join("\n"), "Windowsのprocessの先祖を取得できません");
  } catch { return readRuntimeProcesses(); }
  if (!Array.isArray(rows) || rows[0]?.pid !== pid) return readRuntimeProcesses();
  return rows.map(row => {
    if (!row || !Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.parent_pid) || typeof row.executable !== "string"
      || !Number.isFinite(row.cpu_seconds) || typeof row.started_identity !== "string" || !Number.isFinite(Date.parse(row.started_identity)))
      throw new ProcessTableError("Windows processの読みのfieldが不正です");
    return {
      pid: row.pid, parent_pid: row.parent_pid, process_group_id: null, stopped: null, executable: row.executable,
      started_identity: new Date(row.started_identity).toISOString(), command: row.executable, cpu_seconds: row.cpu_seconds,
      argv_digest: createHash("sha256").update(row.executable).digest("hex"),
    };
  });
}

export function readRuntimeProcesses(): RuntimeProcess[] {
  if (!isWin) {
    const result = spawnSync("/bin/ps", ["-axww", "-o", "pid=,ppid=,pgid=,stat=,lstart=,time=,command="], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 10000, maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new ProcessTableError("OSのprocess一覧を取得できません");
    return parsePosixProcessTable(result.stdout);
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
    "@(Get-CimInstance Win32_Process | Where-Object { $null -ne $_.CreationDate -and $null -ne $_.CommandLine } | ForEach-Object {",
    "[ordered]@{ pid=[int]$_.ProcessId; parent_pid=[int]$_.ParentProcessId; executable=[string]$_.ExecutablePath; started_identity=$_.CreationDate.ToUniversalTime().ToString('o'); command=$_.CommandLine; cpu_seconds=([double]$_.KernelModeTime+[double]$_.UserModeTime)/10000000 }",
    "}) | ConvertTo-Json -Compress",
  ].join("\n");
  const result = spawnSync(resolveWindowsPowerShell7(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new ProcessTableError("Windowsのnative process一覧を取得できません");
  let rows: unknown;
  try { rows = JSON.parse(result.stdout); } catch { throw new ProcessTableError("Windows process一覧のJSONを読めません"); }
  if (!Array.isArray(rows)) throw new ProcessTableError("Windows process一覧が配列ではありません");
  return rows.map(row => {
    if (!row || !Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.parent_pid)
      || typeof row.command !== "string" || !Number.isFinite(row.cpu_seconds)
      || typeof row.started_identity !== "string" || !Number.isFinite(Date.parse(row.started_identity)))
      throw new ProcessTableError("Windows process一覧のfieldが不正です");
    const command = row.command.trim();
    return {
      pid: row.pid, parent_pid: row.parent_pid, process_group_id: null, stopped: null,
      executable: row.executable,
      started_identity: new Date(row.started_identity).toISOString(),
      command, cpu_seconds: row.cpu_seconds, argv_digest: createHash("sha256").update(command).digest("hex"),
    };
  });
}

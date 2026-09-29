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

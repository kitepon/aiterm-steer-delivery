// WindowsのPowerShell 7と引数の引用。5.1／cmdへは切り替えず、見つからなければ理由付きで止める。
import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import * as path from "node:path";

export const WINDOWS_POWERSHELL_7_COMMAND = "pwsh.exe";
export const WINDOWS_POWERSHELL_7_INSTALL = "winget install --id Microsoft.PowerShell --source winget";

export type WindowsPowerShellProbe = (command: string, args: readonly string[]) => {
  status: number | null;
  stdout?: string | null;
  error?: NodeJS.ErrnoException;
};

class PowerShellError extends Error {
  readonly code = 2;
}

const defaultProbe: WindowsPowerShellProbe = (command, args) => spawnSync(command, [...args], {
  encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true,
});
let resolvedDefault: string | null = null;

export function resolveWindowsPowerShell7(probe: WindowsPowerShellProbe = defaultProbe): string {
  if (probe === defaultProbe && resolvedDefault !== null) return resolvedDefault;
  const located = probe("where.exe", [WINDOWS_POWERSHELL_7_COMMAND]);
  const resolved = located.stdout?.split(/\r?\n/u)
    .find(candidate => path.win32.isAbsolute(candidate)
      && path.win32.basename(candidate).toLowerCase() === WINDOWS_POWERSHELL_7_COMMAND)
    ?? path.win32.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", WINDOWS_POWERSHELL_7_COMMAND);
  const fail = (): never => { throw new PowerShellError(
    `PowerShell 7が必要です。Microsoft公式経路で導入してください: ${WINDOWS_POWERSHELL_7_INSTALL}`,
  ); };
  const executable = resolved as string;
  const version = probe(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    '[ordered]@{ edition = $PSVersionTable.PSEdition; major = $PSVersionTable.PSVersion.Major } | ConvertTo-Json -Compress']);
  let identity: { edition?: unknown; major?: unknown } | null = null;
  try { identity = JSON.parse(version.stdout?.trim() ?? ""); } catch { /* typed failure below */ }
  if (version.status !== 0 || identity?.edition !== "Core"
    || !Number.isInteger(identity.major) || Number(identity.major) < 7) fail();
  // where.exeは呼出元のPATHの表記を返す。工場とSSHで同じファイルのcaseが
  // 違うと、Codex hookの文字列と承認hashまで変わり、不要な再起動待ちになる。
  let canonical: string;
  try { canonical = realpathSync.native(executable); } catch { return fail(); }
  if (probe === defaultProbe) resolvedDefault = canonical;
  return canonical;
}

export const quotePowerShell = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** PowerShell 7でscriptを実行し、stdoutを返す。失敗の詳細はonFailureが製品のエラーへ変える。 */
export function windowsPowerShellSync(script: string, onFailure: () => Error, timeout = 15_000): string {
  const source = "$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n" + script;
  try {
    return execFileSync(resolveWindowsPowerShell7(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(source, "utf16le").toString("base64")], {
      encoding: "utf8", windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw onFailure();
  }
}

function quoteWindowsProcessArgument(value: string): string {
  if (value !== "" && !/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
    } else if (char === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      quoted += "\\".repeat(backslashes) + char;
      backslashes = 0;
    }
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

/** Start-Process -ArgumentListへそのまま渡せる、CommandLineToArgvWの規則で引用した引数列。 */
export function windowsStartProcessArgumentList(args: string[]): string {
  return args.map(quoteWindowsProcessArgument).join(" ");
}

// Codexの実行ファイルとCODEX_HOMEの解決。Desktopが同梱するCLIは更新のたびに場所が変わることがあるので、
// setupで保存した場所が消えていたら、使う時点で同じ順（公式Desktop、無ければCodex CLI）で探し直す。探せなければ理由付きで止める。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodexDeliveryError, SetupError } from "./errors.js";
import { writeHookJson } from "./files.js";
import { codexHookDirectory, type ProductProfile } from "./profile.js";
import { windowsPowerShellSync } from "./windows.js";
import type { CodexHookConfig } from "./codex-hook-state.js";

const isWin = process.platform === "win32";
// 実行ファイルの指定誤り。配送の受付前なので、配送のエラーではなく設定のエラーとして返す。
class ExecutableError extends Error {
  readonly code = 2;
}

export function realCodexHome(): string {
  return process.env.CODEX_HOME || path.join(process.env.HOME ?? os.homedir(), ".codex");
}

function isUsableExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (isWin) return /\.(?:exe|cmd|bat|com)$/i.test(candidate);
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isUsableAgentExecutableFile(candidate: string): boolean {
  if (!isWin) return isUsableExecutableFile(candidate);
  if (/^[A-Za-z]:[\\/]/.test(candidate) && /\.(?:exe|com|cmd|bat)$/i.test(candidate)) return isUsableExecutableFile(candidate);
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveWindowsCodexShim(candidate: string): string {
  if (!isWin || !/\.(?:cmd|bat)$/i.test(candidate)) return candidate;
  const packageRoot = path.join(path.dirname(candidate), "node_modules", "@openai", "codex", "node_modules", "@openai");
  try {
    for (const platformPackage of fs.readdirSync(packageRoot).filter((name) => name.startsWith("codex-win32-"))) {
      const vendorRoot = path.join(packageRoot, platformPackage, "vendor");
      for (const target of fs.readdirSync(vendorRoot)) {
        const executable = path.join(vendorRoot, target, "bin", "codex.exe");
        if (isUsableExecutableFile(executable)) return executable;
      }
    }
  } catch {
    /* 下の明示エラーへ */
  }
  throw new ExecutableError(
    `CODEX_BIN のnpm shimからWindows native codex.exeを解決できません: ${candidate}。` +
      "@openai/codexを再インストールするか、CODEX_BINへcodex.exeを指定してください");
}

/** 通常のCodex CLI。CODEX_BIN、~/.local/bin/codex、PATHの順に探す。 */
export function resolveCodexExecutable(): string | null {
  const home = process.env.HOME ?? os.homedir();
  const fromEnv = process.env.CODEX_BIN;
  if (fromEnv) {
    if (isUsableAgentExecutableFile(fromEnv)) return resolveWindowsCodexShim(fromEnv);
    throw new ExecutableError(`CODEX_BIN に指定された codex が存在しません: ${fromEnv}`);
  }
  const fallback = path.join(home, ".local", "bin", "codex");
  if (isUsableAgentExecutableFile(fallback)) return resolveWindowsCodexShim(fallback);
  const w = spawnSync(isWin ? "where" : "which", ["codex"], { encoding: "utf8", timeout: 5000 });
  if (w.status === 0 && (w.stdout ?? "").trim()) {
    const found = w.stdout.trim().split(/\r?\n/).filter(Boolean);
    const ordered = isWin
      ? [...found.filter((p) => /\.(?:exe|com|cmd|bat)$/i.test(p)), ...found.filter((p) => !/\.(?:exe|com|cmd|bat)$/i.test(p))]
      : found;
    for (const resolved of ordered) {
      if (isUsableAgentExecutableFile(resolved)) return resolveWindowsCodexShim(resolved);
    }
  }
  return null;
}

function command(executable: string, args: string[]): string {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 15_000 });
  if (result.error || result.status !== 0) throw new SetupError("codex_steer_setup_failed", `${path.basename(executable)}を実行できません`);
  return result.stdout.trim();
}

/**
 * Desktopが同梱するCodex CLI。2026-09のChatGPT.appは`Contents/Resources/codex`から
 * `Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`へ移した（macbook実測）。
 */
export function desktopBundledCodex(app: string): string | null {
  const layouts = [
    path.join(app, "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex"),
    path.join(app, "Contents", "Resources", "codex"),
  ];
  return layouts.find(file => fs.existsSync(file)) ?? null;
}

/** macOSの公式Codex Desktopが同梱するCLI。署名と版を確かめる。 */
export function findDesktopBinary(): string {
  const search = spawnSync("/usr/bin/mdfind", ["kMDItemCFBundleIdentifier == 'com.openai.codex'"], { encoding: "utf8", timeout: 10_000 });
  const candidates = [...new Set(["/Applications/Codex.app", "/Applications/ChatGPT.app", ...(search.status === 0 ? search.stdout.trim().split("\n") : [])])];
  const found = candidates.flatMap(app => {
    const binary = app ? desktopBundledCodex(app) : null;
    if (!binary) return [];
    const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print:CFBundleIdentifier", path.join(app, "Contents", "Info.plist")], { encoding: "utf8", timeout: 5_000 });
    return result.status === 0 && result.stdout.trim() === "com.openai.codex" ? [binary] : [];
  });
  if (found.length !== 1) throw new SetupError("codex_desktop_not_identified", "Codex Desktopのインストール先を一つに特定できません");
  const binary = found[0];
  command("/usr/bin/codesign", ["--verify", "--strict", binary]);
  const version = command(binary, ["--version"]);
  const match = /codex-cli (\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match || (Number(match[1]) === 0 && Number(match[2]) < 154)) {
    throw new SetupError("codex_version_unsupported", "SteerにはCodex CLI 0.154以上を同梱したCodex Desktopが必要です");
  }
  return binary;
}

export function findWindowsCodexCache(resources: string, cache: string): string {
  // Desktopが展開した4実行fileを配布元と照合する。展開・更新はDesktop自身が所有する。
  const names = ["codex.exe", "codex-code-mode-host.exe", "codex-windows-sandbox-setup.exe", "codex-command-runner.exe"];
  const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const expected = names.map(name => digest(path.join(resources, name)));
  const found = (fs.existsSync(cache) ? fs.readdirSync(cache, { withFileTypes: true }) : [])
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^[0-9a-f]{16}$/.test(entry.name))
    .filter(entry => names.every((name, index) => {
      const file = path.join(cache, entry.name, name);
      return fs.existsSync(file) && digest(file) === expected[index];
    }));
  if (found.length !== 1) throw new SetupError("codex_desktop_runtime_unavailable", "現在のCodex Desktopが展開した実行fileを特定できません。公式Desktopを起動してからsetupを再実行してください。");
  return path.join(cache, found[0]!.name, "codex.exe");
}

/** Windowsの公式Codex Desktop（MSIX）が展開したCLI。 */
export function findWindowsCodexBinary(): string {
  const resources = windowsPowerShellSync(`
$packages = @(Get-AppxPackage -Name OpenAI.Codex)
if ($packages.Count -ne 1) { throw '公式Codex Desktopを一つに特定できません' }
Join-Path $packages[0].InstallLocation 'app/resources'`,
  () => new CodexDeliveryError("CODEX_WINDOWS_OPERATION_FAILED", "WindowsのSteer設定・接続情報を確認できません"));
  const value = findWindowsCodexCache(resources, path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "OpenAI", "Codex", "bin"));
  const result = spawnSync(value, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.error || result.status !== 0) throw new SetupError("codex_binary_unavailable", "公式Codex Desktopの実行fileを起動できません。");
  const match = /codex-cli (\d+)\.(\d+)\.(\d+)/.exec(result.stdout ?? "");
  if (result.status !== 0 || !match || (Number(match[1]) === 0 && Number(match[2]) < 154)) throw new SetupError("codex_version_unsupported", "公式Codex Desktopの対応CLIを確認できません。");
  return value;
}

/** CLIが対応する最低版（公式キューとhookの取込み）。 */
function assertSteerVersion(executable: string, subject: string): void {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  if (result.error || result.status !== 0) throw new SetupError("codex_binary_unavailable", `${subject}を起動できません`);
  const match = /codex-cli (\d+)\.(\d+)\.(\d+)/.exec(result.stdout ?? "");
  if (!match || (Number(match[1]) === 0 && Number(match[2]) < 154)) {
    throw new SetupError("codex_version_unsupported", `Steerには公式キューとhookに対応するCodex CLI 0.154以上が必要です（${subject}）`);
  }
}

/** Linuxの公式Codex Desktop（deb・rpm）が同梱するCLI。 */
export function findLinuxDesktopBinary(candidates = ["/usr/lib/chatgpt/resources/codex", "/opt/ChatGPT/resources/codex"]): string {
  const found = candidates.filter(file => fs.existsSync(file));
  if (found.length !== 1) throw new SetupError("codex_desktop_not_identified", "Codex Desktopのインストール先を一つに特定できません");
  assertSteerVersion(found[0], "Codex Desktopの同梱CLI");
  return found[0];
}

/** Desktopの無い端末で使う、通常のCodex CLI。 */
export function findCliBinary(resolve: () => string | null = resolveCodexExecutable): string {
  const binary = resolve();
  if (!binary) throw new SetupError("codex_binary_unavailable", "Codex DesktopもCodex CLIも見つかりません");
  assertSteerVersion(binary, "Codex CLI");
  return binary;
}

export type DesktopBinaryFinder = () => string;

export function platformDesktopFinder(platform = process.platform): DesktopBinaryFinder {
  return platform === "win32" ? findWindowsCodexBinary : platform === "darwin" ? findDesktopBinary : findLinuxDesktopBinary;
}

/**
 * Steerのhookが公式キューを操作するのに使うCodex。公式Desktopの同梱CLIを先に探し、Desktopが無ければ
 * 通常のCodex CLIを使う（どちらも同じ公式キューとhookを持つ）。
 */
export function findSteerBinary(desktop: DesktopBinaryFinder = platformDesktopFinder(), cli: () => string = () => findCliBinary()): string {
  try { return desktop(); }
  catch (desktopError) {
    try { return cli(); }
    catch (cliError) {
      if (cliError instanceof SetupError && cliError.code === "codex_binary_unavailable" && desktopError instanceof SetupError) throw desktopError;
      throw cliError;
    }
  }
}

export async function currentCodexDesktopBinary(
  profile: ProductProfile,
  config: CodexHookConfig,
  options: { directory?: string; find?: DesktopBinaryFinder; exists?: (file: string) => boolean } = {},
): Promise<string> {
  const exists = options.exists ?? fs.existsSync;
  if (exists(config.binary)) return config.binary;
  let binary: string;
  try {
    binary = (options.find ?? (() => findSteerBinary()))();
  } catch (error) {
    throw new CodexDeliveryError("CODEX_DESKTOP_BINARY_MOVED",
      `Codex Desktopの更新で ${config.binary} が無くなり、新しい場所も特定できません（${error instanceof Error ? error.message : String(error)}）。` +
      `Codex Desktopを起動してから ${profile.codex_steer_command} を実行してください`);
  }
  writeHookJson(path.join(options.directory ?? codexHookDirectory(profile), "config.json"), { ...config, binary });
  return binary;
}

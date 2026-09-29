// Steerの正規導入。公式hookを登録・承認してから、製品の旧方式（あれば）を解除する。
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { currentCodexDesktopBinary, platformDesktopFinder, realCodexHome } from "./codex-binary.js";
import { withCodexReceiver } from "./codex-receiver.js";
import { SetupError } from "./errors.js";
import { setupNodeExecutable } from "./setup-node.js";
import { readRuntimeProcesses, type RuntimeProcess } from "./process.js";
import { resolveWindowsPowerShell7, quotePowerShell } from "./windows.js";
import { codexHookDirectory, type ProductProfile } from "./profile.js";
import { assertCodexHooksReady, ownedCodexHooks, readCodexHookConfig, writeHookJson, type CodexHookConfig } from "./codex-hook-state.js";

export type CodexSteerAction = "enable" | "disable" | "status";
export type CodexSteerResult = {
  status: "ready" | "disabled" | "restart_required" | "unsupported" | "failed";
  reason_code?: string;
};

export function codexHookCommand(node: string, hook: string, directory: string, platform = process.platform,
  powershell: () => string = () => resolveWindowsPowerShell7()): string {
  if (platform === "win32") {
    const script = `& ${[node, hook, directory].map(quotePowerShell).join(" ")}; exit $LASTEXITCODE`;
    // Codexは利用中のPowerShellでhookを評価する。引用した実行パスには呼出し演算子が必要。
    return `& ${quotePowerShell(powershell())} -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  }
  return [node, hook, directory].map(value => "'" + value.replace(/'/g, "'\"'\"'") + "'").join(" ");
}

export function mergeCodexParentHooks(profile: ProductProfile, file: string, command: string | null, previousCommand?: string): boolean {
  if (!fs.existsSync(file)) {
    try { if (fs.lstatSync(file).isSymbolicLink()) throw new SetupError("codex_hook_config_invalid", "hook設定symlinkの参照先がありません"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  let current: any = {};
  if (fs.existsSync(target)) {
    try { current = JSON.parse(fs.readFileSync(target, "utf8")); }
    catch { throw new SetupError("codex_hook_config_invalid", "Codexのhook設定JSONを読めません"); }
  }
  const object = (value: any) => value && typeof value === "object" && !Array.isArray(value);
  if (!object(current) || (current.hooks !== undefined && !object(current.hooks))) throw new SetupError("codex_hook_config_invalid", "Codexのhooks設定を読めません");
  const hooks = { ...current.hooks };
  for (const event of ["PostToolUse", "Stop"]) {
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups) || groups.some(group => !object(group) || !Array.isArray(group.hooks))) throw new SetupError("codex_hook_config_invalid", `${event}のhook設定を読めません`);
    // 既存の位置で置換する。末尾へ移すと同じ設定の再導入でも変更扱いになり、
    // 稼働中のCodexへ不要な再起動を要求してしまう。
    hooks[event] = [];
    let insertionIndex: number | null = null;
    for (const group of groups) {
      const remaining = group.hooks.filter((hook: any) =>
        !(hook?.type === "command" && ((command !== null && hook.command === command) || (previousCommand && hook.command === previousCommand))));
      if (remaining.length !== group.hooks.length && insertionIndex === null) insertionIndex = hooks[event].length;
      if (remaining.length) hooks[event].push({ ...group, hooks: remaining });
    }
    if (command !== null) hooks[event].splice(insertionIndex ?? hooks[event].length, 0, { ...(event === "PostToolUse" ? { matcher: ".*" } : {}),
      hooks: [{ type: "command", command, timeout: 20, ...(event === "PostToolUse" ? { additionalContextLimit: 0 } : {}) }] });
    if (!hooks[event].length) delete hooks[event];
  }
  const next = { ...current, hooks };
  if (isDeepStrictEqual(current, next)) return false;
  if (fs.existsSync(target)) fs.copyFileSync(target, `${target}${profile.backup_suffix}`);
  writeHookJson(target, next);
  if (!isDeepStrictEqual(JSON.parse(fs.readFileSync(target, "utf8")), next)) throw new SetupError("codex_hook_readback_failed", "Codex hookの読戻しが一致しません");
  return true;
}

export type CodexSteerRuntime = {
  platform: string; directory: string; codex_home: string; node: string; hook: string;
  findBinary: () => string; processes: () => RuntimeProcess[];
  /** 製品が以前使っていた別方式の選択。新規の製品は持たない。binaryは旧方式が起動していたCodex。 */
  legacy: () => { enabled: boolean; binary?: string } | null; disableLegacy: () => Promise<CodexSteerResult>;
  verify: (config: CodexHookConfig, approve: boolean) => Promise<void>;
  /** 設定を保存する前にhook directoryを整える（WindowsのACL等）。 */
  prepareDirectory: (directory: string) => void;
  /** Windowsでhookを起動するPowerShell 7の絶対path。 */
  powershell: () => string;
};

export async function verifyCodexHookRegistration(profile: ProductProfile, config: CodexHookConfig, approve: boolean, directory = codexHookDirectory(profile)): Promise<void> {
  fs.accessSync(config.node, fs.constants.X_OK); fs.accessSync(config.hook, fs.constants.R_OK);
  const file = path.join(config.codex_home, "hooks.json");
  await withCodexReceiver(profile, { thread_id: "00000000-0000-4000-8000-000000000000", codex_home: config.codex_home }, async request => {
    const list = () => request("hooks/list", { cwds: [config.codex_home] });
    const hooks = ownedCodexHooks(profile, await list(), config.command, file);
    if (approve) {
      const edits = hooks.filter(hook => !hook.enabled || hook.trustStatus !== "trusted").flatMap(hook => {
        if (typeof hook.key !== "string" || typeof hook.currentHash !== "string") throw new SetupError("codex_hook_schema_unknown", "公式hookの承認情報を認識できません");
        const key = `hooks.state.${JSON.stringify(hook.key)}`;
        return [
          { keyPath: `${key}.trusted_hash`, value: hook.currentHash, mergeStrategy: "replace" },
          { keyPath: `${key}.enabled`, value: true, mergeStrategy: "replace" },
        ];
      });
      if (edits.length) await request("config/batchWrite", { edits, filePath: path.join(config.codex_home, "config.toml") });
    }
    assertCodexHooksReady(profile, await list(), config.command, file);
  }, { executable: await currentCodexDesktopBinary(profile, config, { directory }) });
}

/** hookは製品が同梱するCodex hook入口（パッケージのrunCodexResultHookを呼ぶ小さなファイル）の絶対path。 */
export async function configureCodexSteer(profile: ProductProfile, action: CodexSteerAction = "status",
  overrides: Partial<CodexSteerRuntime> & { hook: string }): Promise<CodexSteerResult> {
  const directory = overrides.directory ?? codexHookDirectory(profile);
  const runtime: CodexSteerRuntime = { platform: process.platform, directory, codex_home: realCodexHome(),
    node: process.execPath, findBinary: platformDesktopFinder(),
    processes: readRuntimeProcesses, legacy: () => null,
    disableLegacy: async () => ({ status: "disabled" }), verify: (config, approve) => verifyCodexHookRegistration(profile, config, approve, directory),
    prepareDirectory: () => undefined, powershell: () => resolveWindowsPowerShell7(), ...overrides };
  const previous = readCodexHookConfig(profile, runtime.directory);
  const legacy = runtime.legacy();
  const file = path.join(action === "disable" && previous ? previous.codex_home : runtime.codex_home, "hooks.json");
  const save = (config: CodexHookConfig) => {
    runtime.prepareDirectory(runtime.directory);
    writeHookJson(path.join(runtime.directory, "config.json"), config);
  };
  const needsRestart = (config: CodexHookConfig) => runtime.processes().some(process => config.stale_processes.some(stale => stale.pid === process.pid && stale.started_identity === process.started_identity));
  if (action === "status") {
    if (!previous?.enabled) return legacy?.enabled ? { status: "failed", reason_code: "codex_steer_migration_required" } : { status: "disabled" };
    await runtime.verify(previous, false);
    return legacy?.enabled || needsRestart(previous) ? { status: "restart_required", reason_code: "codex_restart_required" } : { status: "ready" };
  }
  if (action === "disable") {
    if (previous?.enabled) { mergeCodexParentHooks(profile, file, null, previous.command); save({ ...previous, enabled: false }); }
    if (legacy?.enabled) return runtime.disableLegacy();
    return previous?.enabled ? { status: "restart_required", reason_code: "codex_restart_required" } : { status: "disabled" };
  }
  if (!["darwin", "win32"].includes(runtime.platform)) return { status: "unsupported", reason_code: "codex_steer_platform_unsupported" };
  if (previous?.enabled && fs.realpathSync(previous.codex_home) !== fs.realpathSync(runtime.codex_home)) throw new SetupError("codex_steer_configuration_conflict", "別のCODEX_HOMEでSteerが有効です。先に既存の選択を解除してください");
  const node = setupNodeExecutable(runtime.node);
  fs.accessSync(node, fs.constants.X_OK); fs.accessSync(runtime.hook, fs.constants.R_OK);
  const binary = runtime.findBinary();
  const command = codexHookCommand(node, runtime.hook, runtime.directory, runtime.platform as NodeJS.Platform, runtime.powershell);
  const changed = mergeCodexParentHooks(profile, file, command, previous?.command);
  // hook導入前から動いているCodexを再起動待ちとして記録する。今のDesktop、前回の登録、旧方式が起動したCodexを、
  // 引用符付きのコマンド行も含めて照合する（Windowsは区切りと大文字小文字を揃える）。
  const normalize = (value: string) => runtime.platform === "win32" ? value.replaceAll("/", "\\").toLowerCase() : value;
  const binaries = [binary, legacy?.binary, previous?.binary].filter((value): value is string => !!value).map(normalize);
  const stale = !previous?.enabled || changed || legacy?.enabled
    ? runtime.processes().filter(row => binaries.some(candidate => {
      const command = normalize(row.command);
      return (row.executable !== undefined && normalize(row.executable) === candidate) || command === candidate || command === `"${candidate}"`
        || command.startsWith(candidate + " ") || command.startsWith(`"${candidate}" `);
    })).map(({ pid, started_identity }) => ({ pid, started_identity }))
    : previous.stale_processes;
  const config: CodexHookConfig = { schema: profile.codex_hook_schema, enabled: true,
    codex_home: runtime.codex_home, binary, command, node, hook: runtime.hook, stale_processes: stale };
  await runtime.verify(config, true);
  // 解除が中断しても、次のenableで移行を続行できるよう所有情報を先に保存する。
  save(config);
  if (legacy?.enabled) await runtime.disableLegacy();
  return needsRestart(config) ? { status: "restart_required", reason_code: "codex_restart_required" } : { status: "ready" };
}

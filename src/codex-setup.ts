// Steerの正規導入。公式hookを登録・承認してから、製品の旧方式（あれば）を解除する。
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { currentCodexDesktopBinary, findSteerBinary, realCodexHome } from "./codex-binary.js";
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

/** hooks.jsonの書き換えで位置が動く他のhook。Codexは承認を「ファイル:イベント:まとまり:番号」の鍵で持つ。 */
export type CodexHookMove = { event: string; from: [number, number]; to: [number, number] | null };
export type CodexHookPlan = { target: string; current: any; next: any; changed: boolean; moves: CodexHookMove[] };

/** 自製品のhookを置換・解除した後のhooks.jsonと、他のhookの位置の動きを計算する（書き込まない）。 */
export function planCodexParentHooks(file: string, command: string | null, previousCommand?: string): CodexHookPlan {
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
  const moves: CodexHookMove[] = [];
  for (const event of ["PostToolUse", "Stop"]) {
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups) || groups.some(group => !object(group) || !Array.isArray(group.hooks))) throw new SetupError("codex_hook_config_invalid", `${event}のhook設定を読めません`);
    const owned = (hook: any) => hook?.type === "command" && ((command !== null && hook.command === command) || (!!previousCommand && hook.command === previousCommand));
    const before = new Map<unknown, [number, number]>();
    groups.forEach((group: any, g: number) => group.hooks.forEach((hook: any, h: number) => { if (!owned(hook)) before.set(hook, [g, h]); }));
    // 既存の位置で置換する。末尾へ移すと同じ設定の再導入でも変更扱いになり、
    // 稼働中のCodexへ不要な再起動を要求してしまう。
    hooks[event] = [];
    let insertionIndex: number | null = null;
    for (const group of groups) {
      const remaining = group.hooks.filter((hook: any) => !owned(hook));
      if (remaining.length !== group.hooks.length && insertionIndex === null) insertionIndex = hooks[event].length;
      if (remaining.length) hooks[event].push({ ...group, hooks: remaining });
    }
    if (command !== null) hooks[event].splice(insertionIndex ?? hooks[event].length, 0, { ...(event === "PostToolUse" ? { matcher: ".*" } : {}),
      hooks: [{ type: "command", command, timeout: 20, ...(event === "PostToolUse" ? { additionalContextLimit: 0 } : {}) }] });
    // 他製品・利用者のhookの位置の動きを記録する（承認を新しい位置へ写すため）。
    const after = new Map<unknown, [number, number]>();
    hooks[event].forEach((group: any, g: number) => group.hooks.forEach((hook: any, h: number) => after.set(hook, [g, h])));
    for (const [hook, from] of before) {
      const to = after.get(hook) ?? null;
      if (!to || to[0] !== from[0] || to[1] !== from[1]) moves.push({ event, from, to });
    }
    if (!hooks[event].length) delete hooks[event];
  }
  const next = { ...current, hooks };
  return { target, current, next, changed: !isDeepStrictEqual(current, next), moves };
}

export function writeCodexHookPlan(profile: ProductProfile, plan: CodexHookPlan): boolean {
  if (!plan.changed) return false;
  if (fs.existsSync(plan.target)) fs.copyFileSync(plan.target, `${plan.target}${profile.backup_suffix}`);
  writeHookJson(plan.target, plan.next);
  if (!isDeepStrictEqual(JSON.parse(fs.readFileSync(plan.target, "utf8")), plan.next)) throw new SetupError("codex_hook_readback_failed", "Codex hookの読戻しが一致しません");
  return true;
}

export function mergeCodexParentHooks(profile: ProductProfile, file: string, command: string | null, previousCommand?: string): boolean {
  return writeCodexHookPlan(profile, planCodexParentHooks(file, command, previousCommand));
}

const snake = (event: string) => event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/**
 * 自製品のhookを書き換えて他のhookの位置が動く時、その承認（trusted_hash・enabled）を新しい位置へ写してから書き換え、
 * 空いた位置の承認を消す。承認を新たに与えたり外したりはしない。位置が動かなければ公式APIを呼ばない。
 */
export async function applyCodexHookPlan(profile: ProductProfile, plan: CodexHookPlan, codexHome: string, executable: string | undefined): Promise<boolean> {
  if (!plan.changed) return false;
  if (!plan.moves.length) return writeCodexHookPlan(profile, plan);
  return withCodexReceiver(profile, { thread_id: "00000000-0000-4000-8000-000000000000", codex_home: codexHome }, async request => {
    const listed = await request("hooks/list", { cwds: [codexHome] });
    const source = fs.realpathSync(plan.target);
    const sample = (listed?.data?.[0]?.hooks ?? []).find((hook: any) => hook.sourcePath === source && typeof hook.key === "string");
    if (!sample) throw new SetupError("codex_hook_schema_unknown", "公式APIでhookの鍵を確認できません");
    const prefix = String(sample.key).split(":").slice(0, -3).join(":");
    const key = (event: string, [g, h]: [number, number]) => `${prefix}:${snake(event)}:${g}:${h}`;
    const state = (await request("config/read", { includeLayers: false }))?.config?.hooks?.state ?? {};
    const configFile = path.join(codexHome, "config.toml");
    const field = (target: string, name: string, value: unknown) => ({ keyPath: `hooks.state.${JSON.stringify(target)}.${name}`, value, mergeStrategy: "replace" });
    const copy = plan.moves.filter(move => move.to).flatMap(move => {
      const saved = state[key(move.event, move.from)];
      const target = key(move.event, move.to!);
      return saved && typeof saved === "object"
        ? [field(target, "trusted_hash", saved.trusted_hash ?? null), field(target, "enabled", saved.enabled ?? null)]
        : [{ keyPath: `hooks.state.${JSON.stringify(target)}`, value: null, mergeStrategy: "replace" }];
    });
    if (copy.length) await request("config/batchWrite", { edits: copy, filePath: configFile });
    writeCodexHookPlan(profile, plan);
    // 書き換え後に使われなくなった位置の承認を消す（他のhookへ写した値は残る）。
    const used = new Set<string>();
    for (const event of ["PostToolUse", "Stop"]) (plan.next.hooks?.[event] ?? []).forEach((group: any, g: number) => group.hooks.forEach((_: unknown, h: number) => used.add(key(event, [g, h]))));
    const vacated = plan.moves.map(move => key(move.event, move.from)).filter(old => !used.has(old) && state[old] !== undefined);
    if (vacated.length) await request("config/batchWrite", { edits: vacated.map(old => ({ keyPath: `hooks.state.${JSON.stringify(old)}`, value: null, mergeStrategy: "replace" })), filePath: configFile });
    return true;
  }, executable ? { executable } : {});
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
    node: process.execPath, findBinary: () => findSteerBinary(),
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
    if (previous?.enabled) {
      await applyCodexHookPlan(profile, planCodexParentHooks(file, null, previous.command), previous.codex_home, await currentCodexDesktopBinary(profile, previous, { directory: runtime.directory }).catch(() => undefined));
      save({ ...previous, enabled: false });
    }
    if (legacy?.enabled) return runtime.disableLegacy();
    return previous?.enabled ? { status: "restart_required", reason_code: "codex_restart_required" } : { status: "disabled" };
  }
  if (previous?.enabled && fs.realpathSync(previous.codex_home) !== fs.realpathSync(runtime.codex_home)) throw new SetupError("codex_steer_configuration_conflict", "別のCODEX_HOMEでSteerが有効です。先に既存の選択を解除してください");
  const node = setupNodeExecutable(runtime.node);
  fs.accessSync(node, fs.constants.X_OK); fs.accessSync(runtime.hook, fs.constants.R_OK);
  const binary = runtime.findBinary();
  const command = codexHookCommand(node, runtime.hook, runtime.directory, runtime.platform as NodeJS.Platform, runtime.powershell);
  const changed = await applyCodexHookPlan(profile, planCodexParentHooks(file, command, previous?.command), runtime.codex_home, binary);
  // hook導入前から動いているCodexを再起動待ちとして記録する。今のDesktop、前回の登録、旧方式が起動したCodexを、
  // 引用符付きのコマンド行も含めて照合する（Windowsは区切りと大文字小文字を揃える）。
  const normalize = (value: string) => runtime.platform === "win32" ? value.replaceAll("/", "\\").toLowerCase() : value;
  // npm版のCodex CLIは `node …/@openai/codex/bin/codex.js` と、その中のnative本体として動く。実体のpackageも照合する。
  const packageRoot = (file: string) => {
    let real = file;
    try { real = fs.realpathSync(file); } catch { /* 無ければそのまま */ }
    return /[\\/]bin[\\/]codex\.js$/u.test(real) ? path.dirname(path.dirname(real)) : null;
  };
  const roots = [binary, legacy?.binary, previous?.binary].filter((value): value is string => !!value).flatMap(file => packageRoot(file) ?? []).map(normalize);
  const binaries = [binary, legacy?.binary, previous?.binary].filter((value): value is string => !!value).map(normalize);
  const stale = !previous?.enabled || changed || legacy?.enabled
    ? runtime.processes().filter(row => binaries.some(candidate => {
      const command = normalize(row.command);
      // 実行ファイルそのもの、またはnode等に渡された引数として（`node <path>`）現れるもの。
      return (row.executable !== undefined && normalize(row.executable) === candidate) || command === candidate || command === `"${candidate}"`
        || command.startsWith(candidate + " ") || command.startsWith(`"${candidate}" `)
        || command.endsWith(" " + candidate) || command.includes(` ${candidate} `) || command.includes(` "${candidate}"`);
    }) || roots.some(root => normalize(row.command).includes(root + (runtime.platform === "win32" ? "\\" : "/"))))
      .map(({ pid, started_identity }) => ({ pid, started_identity }))
    : previous.stale_processes;
  const config: CodexHookConfig = { schema: profile.codex_hook_schema, enabled: true,
    codex_home: runtime.codex_home, binary, command, node, hook: runtime.hook, stale_processes: stale };
  await runtime.verify(config, true);
  // 解除が中断しても、次のenableで移行を続行できるよう所有情報を先に保存する。
  save(config);
  if (legacy?.enabled) await runtime.disableLegacy();
  return needsRestart(config) ? { status: "restart_required", reason_code: "codex_restart_required" } : { status: "ready" };
}

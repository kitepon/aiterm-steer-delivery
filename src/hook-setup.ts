// Claude Code・Cursorの設定ファイルへ、製品の配送hookを登録・解除する。他製品やユーザーのhookと順序は保つ。
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { SetupError } from "./errors.js";
import type { ProductProfile } from "./profile.js";

/** hookを起動するNodeと、製品が同梱するhook入口の絶対path。 */
export type HookRuntime = { command: string; script: string };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** 引数の末尾が製品のhook入口と同じファイル名か。path区切りまで見るので、名前の一部だけ重なる他製品を拾わない。 */
function endsWithFile(value: string, file: string): boolean {
  return value === file || value.endsWith(`/${file}`) || value.endsWith(`\\${file}`);
}

export function claudeParentHookEntries(profile: ProductProfile, hook: HookRuntime): Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]> {
  const command = { type: "command", command: hook.command, args: [hook.script] };
  const matcher = `^mcp__${profile.mcp_server}__(${profile.dispatch_tools.join("|")})$`;
  return {
    PreToolUse: [{ matcher, hooks: [{ ...command, timeout: 15 }] }],
    PostToolUse: [{ matcher, hooks: [{ ...command, asyncRewake: true, timeout: 86400 }] }],
    // 長く続く受信（channel）では、turnが終わるたびに待機を張り直す。
    ...(profile.channels ? { Stop: [{ hooks: [{ ...command, asyncRewake: true, timeout: 86400 }] }] } : {}),
    SessionEnd: [{ hooks: [{ ...command, timeout: 15 }] }],
  };
}

export function mergeClaudeParentHooks(profile: ProductProfile, file: string, hook: HookRuntime): "configured" | "unchanged" {
  const target = existsSync(file) ? realpathSync(file) : file;
  let current: Record<string, unknown> = {};
  if (existsSync(target)) {
    try { current = JSON.parse(readFileSync(target, "utf8")); }
    catch { throw new SetupError("config_invalid", "Claudeのhook設定JSONを読めません"); }
  }
  if (!record(current) || (current.hooks !== undefined && !record(current.hooks))) {
    throw new SetupError("config_invalid", "Claudeのhooks設定はobjectである必要があります");
  }
  if (current.disableAllHooks === true) throw new SetupError("claude_parent_hooks_disabled", "Claudeのhookが無効です。disableAllHooksをfalseに変更してからsetupしてください");
  const hooks = { ...current.hooks as Record<string, unknown> | undefined };
  for (const [event, additions] of Object.entries(claudeParentHookEntries(profile, hook))) {
    const previous = hooks[event] ?? [];
    if (!Array.isArray(previous) || previous.some(group => !record(group) || !Array.isArray(group.hooks))) {
      throw new SetupError("config_invalid", `Claudeの${event} hook形式を読めません`);
    }
    // 他製品のhookとmatcherはそのまま保ち、当製品の専用entryだけを更新する。
    const retained = previous.map(group => ({ ...group, hooks: (group.hooks as unknown[]).filter(entry => !isClaudeParentHook(profile, entry))
    })).filter(group => group.hooks.length > 0);
    hooks[event] = [...retained, ...additions];
  }
  const next = { ...current, hooks };
  if (isDeepStrictEqual(current, next)) return "unchanged";
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${profile.id}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (existsSync(target)) copyFileSync(target, `${target}${profile.backup_suffix}`);
    renameSync(temporary, target);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  if (!isDeepStrictEqual(JSON.parse(readFileSync(target, "utf8")), next)) {
    throw new SetupError("config_readback_failed", "Claudeのhook登録の読戻しが一致しません");
  }
  return "configured";
}

function isClaudeParentHook(profile: ProductProfile, hook: unknown): boolean {
  return record(hook) && hook.type === "command" && Array.isArray(hook.args)
    && typeof hook.args[0] === "string" && endsWithFile(hook.args[0], profile.hooks.claude);
}

/** hookを持たない旧版へ戻す前に、当製品の登録だけを除く。 */
export function removeClaudeParentHooks(profile: ProductProfile, file: string): "removed" | "unchanged" {
  if (!existsSync(file)) return "unchanged";
  const target = realpathSync(file);
  const current = JSON.parse(readFileSync(target, "utf8"));
  if (!record(current) || (current.hooks !== undefined && !record(current.hooks))) {
    throw new SetupError("config_invalid", "Claudeのhook設定を読めません");
  }
  if (current.hooks === undefined) return "unchanged";
  const hooks = { ...current.hooks as Record<string, unknown> | undefined };
  for (const event of ["PreToolUse", "PostToolUse", "Stop", "SessionEnd"]) {
    if (hooks[event] === undefined) continue;
    if (!Array.isArray(hooks[event])) throw new SetupError("config_invalid", "Claudeのhook設定を読めません");
    hooks[event] = (hooks[event] as unknown[]).map(group => {
      if (!record(group) || !Array.isArray(group.hooks)) throw new SetupError("config_invalid", "Claudeのhook設定を読めません");
      return { ...group, hooks: group.hooks.filter(entry => !isClaudeParentHook(profile, entry)) };
    }).filter(group => group.hooks.length > 0);
  }
  const next = { ...current, hooks };
  if (isDeepStrictEqual(current, next)) return "unchanged";
  const temporary = `${target}.${profile.id}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    copyFileSync(target, `${target}${profile.backup_suffix}`);
    renameSync(temporary, target);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  if (!isDeepStrictEqual(JSON.parse(readFileSync(target, "utf8")), next)) throw new SetupError("config_readback_failed", "Claude hook解除の読戻しが一致しません");
  return "removed";
}

function shellQuote(value: string): string {
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function cursorParentHookCommand(hook: HookRuntime): string {
  const command = `${shellQuote(hook.command)} ${shellQuote(hook.script)}`;
  return process.platform === "win32" ? `& ${command}` : command;
}

function ownsCursorParentHook(profile: ProductProfile, hook: unknown): boolean {
  return record(hook) && typeof hook.command === "string" && hook.command.includes(profile.hooks.cursor);
}

export function mergeCursorParentHooks(profile: ProductProfile, file: string, hook: HookRuntime): "configured" | "unchanged" {
  const target = existsSync(file) ? realpathSync(file) : file;
  let current: Record<string, unknown> = { version: 1, hooks: {} };
  if (existsSync(target)) {
    try { current = JSON.parse(readFileSync(target, "utf8")); }
    catch { throw new SetupError("config_invalid", "Cursorのhook設定JSONを読めません"); }
  } else {
    try {
      if (lstatSync(file).isSymbolicLink()) throw new SetupError("config_invalid", "Cursorのhooks設定symlinkの参照先がありません");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (!record(current) || (current.hooks !== undefined && !record(current.hooks))) {
    throw new SetupError("config_invalid", "Cursorのhooks設定はobjectである必要があります");
  }
  const hooks = { ...(current.hooks as Record<string, unknown> | undefined) };
  const entry = { command: cursorParentHookCommand(hook), timeout: 15 };
  for (const event of ["afterMCPExecution", "postToolUse"]) {
    const previous = hooks[event] ?? [];
    if (!Array.isArray(previous)) throw new SetupError("config_invalid", `Cursorの${event} hook形式を読めません`);
    const retained = previous.filter(hook => !ownsCursorParentHook(profile, hook));
    const owned = previous.filter(hook => ownsCursorParentHook(profile, hook));
    if (owned.length === 1 && isDeepStrictEqual(owned[0], entry) && retained.length + 1 === previous.length) continue;
    const index = previous.findIndex(hook => ownsCursorParentHook(profile, hook));
    hooks[event] = index < 0 ? [...retained, entry] : previous.map((hook, i) => i === index ? entry : hook).filter((hook, i) => i === index || !ownsCursorParentHook(profile, hook));
  }
  const next = { ...current, version: current.version ?? 1, hooks };
  if (isDeepStrictEqual(current, next)) return "unchanged";
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${profile.id}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (existsSync(target)) copyFileSync(target, `${target}${profile.backup_suffix}`);
    renameSync(temporary, target);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  if (!isDeepStrictEqual(JSON.parse(readFileSync(target, "utf8")), next)) {
    throw new SetupError("config_readback_failed", "Cursorのhook登録の読戻しが一致しません");
  }
  return "configured";
}

export function removeCursorParentHooks(profile: ProductProfile, file: string): "removed" | "unchanged" {
  if (!existsSync(file)) return "unchanged";
  const target = realpathSync(file);
  const current = JSON.parse(readFileSync(target, "utf8"));
  if (!record(current) || (current.hooks !== undefined && !record(current.hooks))) {
    throw new SetupError("config_invalid", "Cursorのhook設定を読めません");
  }
  if (current.hooks === undefined) return "unchanged";
  const hooks = { ...(current.hooks as Record<string, unknown>) };
  for (const event of ["afterMCPExecution", "postToolUse"]) {
    if (hooks[event] === undefined) continue;
    if (!Array.isArray(hooks[event])) throw new SetupError("config_invalid", "Cursorのhook設定を読めません");
    const retained = (hooks[event] as unknown[]).filter(hook => !ownsCursorParentHook(profile, hook));
    if (retained.length) hooks[event] = retained;
    else delete hooks[event];
  }
  const next = { ...current, hooks };
  if (isDeepStrictEqual(current, next)) return "unchanged";
  const temporary = `${target}.${profile.id}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    copyFileSync(target, `${target}${profile.backup_suffix}`);
    renameSync(temporary, target);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  if (!isDeepStrictEqual(JSON.parse(readFileSync(target, "utf8")), next)) {
    throw new SetupError("config_readback_failed", "Cursor hook解除の読戻しが一致しません");
  }
  return "removed";
}


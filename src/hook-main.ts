// 製品のhook入口から呼ぶ本体。入口ファイルは「import して呼ぶだけ」にし、hook commandのpathは製品が持つ。
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { claudeHookRoot, cursorHookRoot, type ProductProfile } from "./profile.js";
import { runCodexResultHook } from "./codex-hooks.js";
import { prepareClaudeHookRequest, runClaudeResultHook, closeClaudeParentSession } from "./claude-receiver.js";
import { handleCursorHook } from "./cursor-receiver.js";
import { runCursorReceive } from "./cursor-receive.js";

async function readStdin(): Promise<string> {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

/** Codexの同期hook（PostToolUse／Stop）。stdoutはCodexの公式hook出力だけに使う。失敗をStop継続のexit 2に変換しない。 */
export async function runCodexHookMain(profile: ProductProfile, directory: string | undefined = process.argv[2]): Promise<void> {
  try {
    const input = await readStdin();
    await runCodexResultHook(profile, JSON.parse(input), value => new Promise<void>((resolve, reject) => {
      process.stdout.write(JSON.stringify(value) + "\n", error => error ? reject(error) : resolve());
    }), { directory });
  } catch (error) {
    process.stderr.write(`CODEX_PARENT_HOOK_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

/** Claude Codeが直接起動する公式hook（PreToolUse／PostToolUse／SessionEnd）。本文はstderrへ返す。 */
export async function runClaudeHookMain(profile: ProductProfile, root: string = claudeHookRoot(profile)): Promise<void> {
  try {
    const event = JSON.parse(await readStdin());
    switch (event.hook_event_name) {
      case "PreToolUse": prepareClaudeHookRequest(event, root); break;
      case "PostToolUse":
        process.exitCode = await runClaudeResultHook(profile, event, text => new Promise<void>((resolve, reject) => {
          process.stderr.write(text, error => error ? reject(error) : resolve());
        }), root);
        break;
      case "SessionEnd": closeClaudeParentSession(event, root); break;
      default: throw new Error("CLAUDE_PARENT_HOOK_EVENT_INVALID: 未対応のhookです");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "CLAUDE_PARENT_HOOK_FAILED"}\n`);
    process.exitCode = 2;
  }
}

/** Cursorが起動する公式hook。差し込み文をstdoutのJSONへ返す。 */
export async function runCursorHookMain(profile: ProductProfile, root: string = cursorHookRoot(profile)): Promise<void> {
  try {
    const input = await readStdin();
    const result = await handleCursorHook(profile, input.length > 0 ? input : "{}", root);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "CURSOR_PARENT_HOOK_FAILED"}\n`);
    process.exitCode = 2;
  }
}

/** Cursor親の背景受信。 */
export async function runCursorReceiveMain(profile: ProductProfile, argv: string[] = process.argv.slice(2), root: string = cursorHookRoot(profile)): Promise<void> {
  const emit = (value: unknown) => { process.stdout.write(JSON.stringify(value) + "\n"); };
  try {
    process.exitCode = await runCursorReceive(root, argv, emit);
  } catch (error) {
    emit({ ok: false, code: "CURSOR_PARENT_RECEIVE_FAILED", message: error instanceof Error ? error.message : "cursor-parent-receive: operation failed" });
    process.exitCode = 1;
  }
}

/** 入口ファイルが直接起動されたか（importされただけでは動かない）。Windowsは大文字小文字を区別しない。 */
export function isDirectExecution(moduleUrl: string, entry: string | undefined = process.argv[1]): boolean {
  if (!entry) return false;
  try {
    const a = fs.realpathSync(entry);
    const b = fs.realpathSync(fileURLToPath(moduleUrl));
    if (a === b) return true;
    return process.platform === "win32" && a.toLowerCase() === b.toLowerCase();
  } catch {
    return false;
  }
}

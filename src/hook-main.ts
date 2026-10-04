// 製品のhook入口から呼ぶ本体。入口ファイルは「import して呼ぶだけ」にし、hook commandのpathは製品が持つ。
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { claudeHookRoot, cursorHookRoot, type ProductProfile } from "./profile.js";
import { runCodexResultHook } from "./codex-hooks.js";
import { prepareClaudeHookRequest, runClaudeResultHook, closeClaudeParentSession } from "./claude-receiver.js";
import { handleCursorHook } from "./cursor-receiver.js";
import { withoutBom } from "./files.js";
import { runCursorReceive } from "./cursor-receive.js";
import { channelReceiveProcess, closeClaudeSessionChannels, handleCursorChannelHook, receiveFromChannel, runClaudeChannelWaiter } from "./channel.js";

async function readStdin(): Promise<string> {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return withoutBom(input);
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
    const write = (text: string) => new Promise<void>((resolve, reject) => {
      process.stderr.write(text, error => error ? reject(error) : resolve());
    });
    switch (event.hook_event_name) {
      case "PreToolUse": prepareClaudeHookRequest(event, root); break;
      case "PostToolUse":
        process.exitCode = await runClaudeResultHook(profile, event, write, root);
        // 単発の依頼が無いtoolの返りでは、channelの待機を張る（長く続く受信を使う製品だけ）。
        if (process.exitCode === 0 && profile.channels) process.exitCode = await runClaudeChannelWaiter(profile, event, write);
        break;
      case "Stop":
        if (!profile.channels) throw new Error("CLAUDE_PARENT_HOOK_EVENT_INVALID: 未対応のhookです");
        process.exitCode = await runClaudeChannelWaiter(profile, event, write);
        break;
      case "SessionEnd":
        closeClaudeParentSession(event, root);
        if (profile.channels) closeClaudeSessionChannels(profile, event);
        break;
      default: throw new Error("CLAUDE_PARENT_HOOK_EVENT_INVALID: 未対応のhookです");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "CLAUDE_PARENT_HOOK_FAILED"}\n`);
    process.exitCode = 2;
  }
}

/**
 * Cursorが起動する公式hook。差し込み文をstdoutのJSONへ返す。
 * rootを複数渡すと、各置き場で結び付けと差し込みを行う。Cursor CLIはMCPを削った環境で起動し、hookは画面側の環境で起動するため、
 * 環境から置き場を決める製品はMCPとhookで置き場が割れる。配送記録の無い置き場では何もしない。
 */
export async function runCursorHookMain(profile: ProductProfile, root: string | readonly string[] = cursorHookRoot(profile)): Promise<void> {
  try {
    const input = await readStdin();
    const result: Record<string, unknown> = {};
    for (const each of typeof root === "string" ? [root] : [...new Set(root)]) {
      const found = await handleCursorHook(profile, input.length > 0 ? input : "{}", each);
      if (typeof found.additional_context === "string") {
        result.additional_context = typeof result.additional_context === "string" ? `${result.additional_context}\n\n${found.additional_context}` : found.additional_context;
      }
    }
    if (profile.channels) {
      let event: unknown = null;
      try { event = JSON.parse(input); } catch { /* 単発配送と同じく、読めない入力には何も返さない */ }
      if (event !== null && typeof event === "object") {
        await handleCursorChannelHook(profile, event as Record<string, unknown>, text => {
          result.additional_context = typeof result.additional_context === "string" ? `${result.additional_context}\n\n${text}` : text;
        });
      }
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "CURSOR_PARENT_HOOK_FAILED"}\n`);
    process.exitCode = 2;
  }
}

/** Cursor親の背景受信。 */
export async function runCursorReceiveMain(profile: ProductProfile, argv: string[] = process.argv.slice(2), root: string | readonly string[] = cursorHookRoot(profile)): Promise<void> {
  try {
    process.exitCode = await runCursorReceive(root, argv);
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: "CURSOR_PARENT_RECEIVE_FAILED", message: error instanceof Error ? error.message : "cursor-parent-receive: operation failed" }) + "\n");
    process.exitCode = 1;
  }
}

/**
 * channelの背景受信（Cursorのidle時、Grok等）。受け取った本文を1行のJSONで出して終わる（0=受取、3=期限切れ、4=閉鎖、1=誤り）。
 * 受取と期限切れの結果には、同じ受信を張り直すための next_wait_process を付ける。
 */
export async function runChannelReceiveMain(profile: ProductProfile, argv: string[] = process.argv.slice(2), script: string | undefined = process.argv[1]): Promise<void> {
  const emit = (value: unknown) => new Promise<void>((resolve, reject) => {
    process.stdout.write(JSON.stringify(value) + "\n", error => error ? reject(error) : resolve());
  });
  try {
    if (argv.length !== 2 || argv[0] !== "--channel" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(argv[1])) {
      await emit({ ok: false, code: "CHANNEL_RECEIVE_USAGE", message: "usage: <receive> --channel <uuid>" });
      process.exitCode = 1;
      return;
    }
    const next = script ? channelReceiveProcess(script, argv[1]) : null;
    const result = await receiveFromChannel(profile, argv[1], {
      emit: value => emit(value.outcome === "closed" ? value : { ...value, next_wait_process: next }),
    });
    process.exitCode = result.outcome === "delivered" ? 0 : result.outcome === "timeout" ? 3 : 4;
  } catch (error) {
    await emit({ ok: false, code: "CHANNEL_RECEIVE_FAILED", message: error instanceof Error ? error.message : "channel receive failed" });
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

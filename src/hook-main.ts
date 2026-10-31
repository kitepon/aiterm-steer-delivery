// 製品のhook入口から呼ぶ本体。入口ファイルは「import して呼ぶだけ」にし、hook commandのpathは製品が持つ。
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeHookRoot, cursorHookRoot, type ProductProfile } from "./profile.js";
import { runCodexResultHook } from "./codex-hooks.js";
import { prepareClaudeHookRequest, runClaudeResultHook, closeClaudeParentSession } from "./claude-receiver.js";
import { handleCursorHook } from "./cursor-receiver.js";
import { withoutBom } from "./files.js";
import { runCursorReceive } from "./cursor-receive.js";
import { channelReceiveProcess, closeClaudeSessionChannels, handleCursorChannelHook, receiveFromChannel, runClaudeChannelWaiter } from "./channel.js";
import { DeliveryAdmissionError } from "./delivery-effect.js";

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

/**
 * Claude Codeが起動する公式hook（PreToolUse／PostToolUse／Stop／SessionEnd）。本文はstderrへ返す。
 * Grokは共有の`~/.claude/settings.json`のhookも動かす。Grokの親への配送はhookを使わないので、Grokからの起動では何もせず0で終わる。
 * 失敗の2を返すと、GrokはStopを「止めずに続ける」、PreToolUseを「拒否」と読む。見分けは、Grokだけが入力へ入れる`hookEventName`。
 */
export async function runClaudeHookMain(profile: ProductProfile, root: string = claudeHookRoot(profile)): Promise<void> {
  const started = Date.now();
  let event: unknown = null, failure: unknown, foreign = false;
  try {
    event = JSON.parse(await readStdin());
    // Grokの起動では何も記録しない（共有のsettingsのhookが動いただけ）。
    if (event !== null && typeof event === "object" && typeof (event as { hookEventName?: unknown }).hookEventName === "string") { foreign = true; return; }
    if (profile.delivery_admission && profile.channels)
      throw new DeliveryAdmissionError("DELIVERY_ADMISSION_UNSUPPORTED", "channel入力の実行受付が未接続です");
    const write = (text: string) => new Promise<void>((resolve, reject) => {
      process.stderr.write(text, error => error ? reject(error) : resolve());
    });
    switch ((event as { hook_event_name?: unknown } | null)?.hook_event_name) {
      case "PreToolUse": prepareClaudeHookRequest(event, root); break;
      case "PostToolUse":
        if (profile.delivery_admission) {
          let signaled = false;
          const code = await runClaudeResultHook(profile, event, write, root, { resume: value => { process.exitCode = value; signaled = true; } });
          if (!signaled) process.exitCode = code;
        } else process.exitCode = await runClaudeResultHook(profile, event, write, root);
        // 単発の依頼が無いtoolの返りでは、channelの待機を張る（長く続く受信を使う製品だけ）。
        if (process.exitCode === 0 && profile.channels) process.exitCode = await runClaudeChannelWaiter(profile, event, write);
        break;
      case "Stop":
        if (!profile.channels) throw new Error("CLAUDE_PARENT_HOOK_EVENT_INVALID: 未対応のhookです");
        process.exitCode = await runClaudeChannelWaiter(profile, event, write);
        break;
      case "SessionStart":
        // 会話が起動し直して再開された時は、番が1つも回らないうちから、前のprocessが開いたchannelの待機を張る。
        // 開いているchannelが無い会話（新しい会話、/clearの後）では、何もせず0で終わる。
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
    failure = error;
    process.stderr.write(`${error instanceof Error ? error.message : "CLAUDE_PARENT_HOOK_FAILED"}\n`);
    // PostToolUse exit 2 is a resume signal, not a safe admission refusal.
    process.exitCode = profile.delivery_admission ? 1 : 2;
  } finally {
    if (!foreign) recordClaudeHookEvent(root, event, started, failure);
  }
}

/**
 * hookの実行記録を`<hook root>/hook-events.log`へ1行JSONで足す。event名・会話ID・tool_use_id・所要・終了code・失敗の符号だけで、
 * 本文・引数・stderrの文は書かない。PreToolUseの記録が欠けた時に、hookが走ったか・timeoutに近かったかを後から確かめる為。
 * 記録の失敗でhookの結果を変えない。
 */
function recordClaudeHookEvent(root: string, event: unknown, started: number, failure: unknown): void {
  try {
    const input = event !== null && typeof event === "object" ? event as Record<string, unknown> : {};
    const safe = (value: unknown, pattern: RegExp) => typeof value === "string" && pattern.test(value) ? value : null;
    const message = failure instanceof Error ? failure.message : failure === undefined ? "" : "CLAUDE_PARENT_HOOK_FAILED";
    const code = (failure as { delivery_code?: unknown } | undefined)?.delivery_code;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, "hook-events.log");
    // shortcut: 1MBを超えたら前の世代を1つだけ残して入れ替える, 長い保全が要る時に世代管理へ上げる
    try { if (fs.statSync(file).size > 1_000_000) fs.renameSync(file, `${file}.1`); } catch { /* まだ無い */ }
    fs.appendFileSync(file, JSON.stringify({
      at: new Date(started).toISOString(), event: safe(input.hook_event_name, /^[A-Za-z]{1,32}$/u),
      session_id: safe(input.session_id, /^[0-9a-fA-F-]{36}$/u), tool_use_id: safe(input.tool_use_id, /^[A-Za-z0-9_-]{1,160}$/u),
      ms: Date.now() - started, exit: process.exitCode ?? 0,
      code: typeof code === "string" ? code : (failure === undefined ? null : (/^[A-Z][A-Z0-9_]*/u.exec(message)?.[0] ?? "FAILED")),
    }) + "\n", { mode: 0o600 });
  } catch { /* 記録の失敗でhookを止めない */ }
}

/**
 * Cursorが起動する公式hook。差し込み文をstdoutのJSONへ返す。
 * rootを複数渡すと、各置き場で結び付けと差し込みを行う。Cursor CLIはMCPを削った環境で起動し、hookは画面側の環境で起動するため、
 * 環境から置き場を決める製品はMCPとhookで置き場が割れる。配送記録の無い置き場では何もしない。
 */
export async function runCursorHookMain(profile: ProductProfile, root: string | readonly string[] = cursorHookRoot(profile)): Promise<void> {
  try {
    const input = await readStdin();
    if (profile.delivery_admission) {
      const roots = typeof root === "string" ? [root] : [...new Set(root)];
      if (roots.length !== 1 || profile.channels)
        throw new DeliveryAdmissionError("DELIVERY_ADMISSION_UNSUPPORTED", "複数scope/channelのCursor出力受付が未接続です");
      let emitted = false;
      const result = await handleCursorHook(profile, input.length ? input : "{}", roots[0], async value => {
        await new Promise<void>((resolve, reject) => process.stdout.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve()));
        emitted = true;
      });
      if (!emitted) process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    const result: Record<string, unknown> = {};
    for (const each of typeof root === "string" ? [root] : [...new Set(root)]) {
      const found = await handleCursorHook(profile, input.length > 0 ? input : "{}", each);
      if (typeof found.additional_context === "string") {
        result.additional_context = typeof result.additional_context === "string" ? `${result.additional_context}\n\n${found.additional_context}` : found.additional_context;
      }
    }
    if (profile.channels) {
      if (profile.delivery_admission) throw new DeliveryAdmissionError("DELIVERY_ADMISSION_UNSUPPORTED", "channel入力の実行受付が未接続です");
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
    process.exitCode = await runCursorReceive(root, argv, undefined, undefined, profile);
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

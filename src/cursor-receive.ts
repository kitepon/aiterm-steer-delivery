// Cursor親がidleのとき、背景で起動して回答本文の到着を待つ受け口。
// 起動するファイルは製品が同梱する入口で、そこからrunCursorReceiveを呼ぶ。
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { receiveCursorAnswer, type CursorReceiveReader } from "./cursor-receiver.js";
import { windowsStartProcessArgumentList } from "./windows.js";

export interface WaitProcess {
  executable: string;
  args: string[];
  windows_start_process_argument_list: string | null;
}

/** 親の背景process APIへそのまま渡す起動情報。scriptは製品のCursor受信入口の絶対path。 */
export function cursorReceiveProcess(script: string, deliveryId: string, executable = process.execPath): WaitProcess {
  const args = [script, "--delivery", deliveryId];
  return {
    executable,
    args,
    windows_start_process_argument_list: process.platform === "win32" ? windowsStartProcessArgumentList(args) : null,
  };
}

/**
 * 背景processの起動情報を、親のshellへ書ける1行にする（Windowsの既定shellはPowerShell）。
 * Cursor CLIのmodelはtool結果のstructuredContentを読まないので、起動情報は本文にこの行で書く。
 */
export function waitProcessCommandLine(wait: { executable: string; args: readonly string[] }, platform: NodeJS.Platform = process.platform): string {
  const values = [wait.executable, ...wait.args];
  if (platform === "win32") return `& ${values.map(value => `'${value.replace(/'/g, "''")}'`).join(" ")}`;
  return values.map(value => `'${value.replace(/'/g, "'\\''")}'`).join(" ");
}

/** 受信processの出力先。結果を書く口と、読み手（このprocessを背景で起こした親）が居るかを確かめる口。 */
export interface ReceiveOutput extends CursorReceiveReader {
  emit(value: unknown): Promise<void>;
  close(): void;
}

/**
 * このprocessのstdoutを出力先にする。
 * 親が終わると、親が持っていたstdoutの読み口が閉じる。POSIXのNodeは子のstdoutをsocketでつなぐので、閉じた時点で分かる。
 * それ以外（Windowsのpipeなど）は、書いてみて失敗するかで確かめる。
 */
export function stdoutOutput(): ReceiveOutput {
  let socket: net.Socket | null = null;
  try {
    // process.stdoutは読み口を開かないので、相手が閉じても気づけない。同じfdを読み書きのsocketとして開く。
    if (process.platform !== "win32" && fs.fstatSync(1).isSocket()) socket = new net.Socket({ fd: 1, readable: true, writable: true, allowHalfOpen: true });
  } catch { socket = null; }
  const stream: NodeJS.WritableStream = socket ?? process.stdout;
  let failed = false;
  stream.on("error", () => { failed = true; });
  const write = (text: string) => new Promise<boolean>(resolve => {
    if (failed) { resolve(false); return; }
    try { stream.write(text, error => resolve(!error && !failed)); }
    catch { resolve(false); }
  });
  const gone = new Promise<void>(resolve => {
    if (!socket) return;
    socket.on("error", () => resolve());
    socket.on("close", () => resolve());
    // 相手が書く側だけを閉じた時もendが来る。書けるなら読み手は居る。
    socket.on("end", () => { void write("\n").then(alive => { if (!alive) resolve(); }); });
    socket.resume();
    socket.unref();
  });
  return {
    gone,
    probe: () => write("\n"),
    emit: async value => { await write(JSON.stringify(value) + "\n"); },
    close: () => { socket?.destroy(); },
  };
}

/** 受信入口の本体。結果を1行のJSONでstdoutへ出し、exit codeを返す（0=受取、3=期限切れ、5=読み手なし、1=誤り）。
 * hookRootを複数渡すと、配送記録のある置き場で待つ（runCursorHookMainと同じ理由）。どこにも無ければ先頭の置き場で誤りを返す。
 * outputに関数を渡すと、読み手を確かめずにその関数へ結果を渡す。 */
export async function runCursorReceive(
  hookRoot: string | readonly string[],
  argv: string[],
  output: ((value: unknown) => void) | ReceiveOutput = stdoutOutput(),
  usage = "usage: cursor-parent-receive --delivery <uuid>",
): Promise<number> {
  const reader = typeof output === "function" ? undefined : output;
  const emit = async (value: unknown) => { if (typeof output === "function") output(value); else await output.emit(value); };
  try {
    if (argv.length !== 2 || argv[0] !== "--delivery" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(argv[1])) {
      await emit({ ok: false, code: "CURSOR_PARENT_RECEIVE_USAGE", message: usage });
      return 1;
    }
    const roots = typeof hookRoot === "string" ? [hookRoot] : [...hookRoot];
    const root = roots.find(each => fs.existsSync(path.join(each, "deliveries", argv[1]))) ?? roots[0];
    if (root === undefined) throw new Error("受信の置き場がありません");
    const result = await receiveCursorAnswer(root, argv[1], undefined, reader);
    // 読み手が居ない。回答は引き取らず、置き場に残したまま終わる。
    if (result.outcome === "reader_gone") return 5;
    if (result.outcome === "timeout") {
      await emit({ delivery_id: argv[1], outcome: "timeout" });
      return 3;
    }
    if (result.outcome === "delivered_by_hook") {
      await emit({ delivery_id: argv[1], outcome: "delivered_by_hook" });
      return 0;
    }
    await emit({ delivery_id: argv[1], outcome: "delivered", text: result.text });
    return 0;
  } finally {
    reader?.close();
  }
}

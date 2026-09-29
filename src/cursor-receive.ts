// Cursor親がidleのとき、背景で起動して回答本文の到着を待つ受け口。
// 起動するファイルは製品が同梱する入口で、そこからrunCursorReceiveを呼ぶ。
import * as fs from "node:fs";
import * as path from "node:path";
import { receiveCursorAnswer } from "./cursor-receiver.js";
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

/** 受信入口の本体。結果を1行のJSONでstdoutへ出し、exit codeを返す（0=受取、3=期限切れ、1=誤り）。
 * hookRootを複数渡すと、配送記録のある置き場で待つ（runCursorHookMainと同じ理由）。どこにも無ければ先頭の置き場で誤りを返す。 */
export async function runCursorReceive(
  hookRoot: string | readonly string[],
  argv: string[],
  emit: (value: unknown) => void = value => { process.stdout.write(JSON.stringify(value) + "\n"); },
  usage = "usage: cursor-parent-receive --delivery <uuid>",
): Promise<number> {
  if (argv.length !== 2 || argv[0] !== "--delivery" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(argv[1])) {
    emit({ ok: false, code: "CURSOR_PARENT_RECEIVE_USAGE", message: usage });
    return 1;
  }
  const roots = typeof hookRoot === "string" ? [hookRoot] : [...hookRoot];
  const root = roots.find(each => fs.existsSync(path.join(each, "deliveries", argv[1]))) ?? roots[0];
  if (root === undefined) throw new Error("受信の置き場がありません");
  const result = await receiveCursorAnswer(root, argv[1]);
  if (result.outcome === "timeout") {
    emit({ delivery_id: argv[1], outcome: "timeout" });
    return 3;
  }
  if (result.outcome === "delivered_by_hook") {
    emit({ delivery_id: argv[1], outcome: "delivered_by_hook" });
    return 0;
  }
  emit({ delivery_id: argv[1], outcome: "delivered", text: result.text });
  return 0;
}

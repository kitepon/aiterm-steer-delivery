// ClaudeがSessionStartへ渡すinboxへ1通送る。MCPの要求記録やasyncRewake hookは不要。
// raw user行には受付票が無い。書き込みを受付済みとはせず、呼出元の受領観測でのみacceptedにする。
import * as net from "node:net";
import * as path from "node:path";

export interface ClaudeInboxTarget {
  /** CLAUDE_CODE_MESSAGING_SOCKETの値。PIDから推測せず、宛先のSessionStartで取得する。 */
  socket_path: string;
  /** 宛先のCLAUDE_CODE_MESSAGING_TOKEN。Windowsでは必須。receiptやエラーには含めない。 */
  token?: string;
}

export interface ClaudeInboxSendOptions {
  /** 接続・書き込み・受領確認を合わせた期限。既定30秒。 */
  timeout_ms?: number;
  /**
   * 接続前に開始する受領観測。対象sessionと今回の文のUserPromptSubmit等を照合してtrueを返す。
   * falseは「まだ観測できていない」であり、未送信の証明ではない。終了時はsignalで取り消される。
   * ライブラリは観測開始が解決するのを待たずに接続する。受信票の事前登録が必要なら、呼出元で登録を済ませておく。
   */
  confirm_acceptance?: (signal: AbortSignal) => Promise<boolean>;
}

export type ClaudeInboxSendResult =
  | { status: "accepted"; outcome_unknown: false; reason: "receiver_confirmed" }
  | { status: "not_sent"; outcome_unknown: false; reason: "invalid_request" | "token_required" | "connect_failed" | "confirmation_failed" | "timeout" }
  | { status: "unknown"; outcome_unknown: true; reason: "unconfirmed" | "confirmation_failed" | "write_failed" | "timeout" };

/** 明示した会話のinboxへ1通だけ送る。自動再送、他の宛先へのfallback、設定変更は行わない。 */
export async function sendClaudeInbox(target: ClaudeInboxTarget, text: string, options: ClaudeInboxSendOptions = {}): Promise<ClaudeInboxSendResult> {
  if (!options || typeof options !== "object") return { status: "not_sent", outcome_unknown: false, reason: "invalid_request" };
  const timeout = options.timeout_ms ?? 30_000;
  if (!target || typeof target.socket_path !== "string" || !target.socket_path || target.socket_path.includes("\0")
    || typeof text !== "string" || !text || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000
    || (target.token !== undefined && (typeof target.token !== "string" || !target.token))
    || (options.confirm_acceptance !== undefined && typeof options.confirm_acceptance !== "function")
    || (process.platform !== "win32" && !path.isAbsolute(target.socket_path))) {
    return { status: "not_sent", outcome_unknown: false, reason: "invalid_request" };
  }
  if (process.platform === "win32" && !target.token) {
    return { status: "not_sent", outcome_unknown: false, reason: "token_required" };
  }
  const message = JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
  // Claudeの同一端末配送の上限より小さいフレームだけ送る。送信前に拒否する。
  if (Buffer.byteLength(message) > 1_000_000) {
    return { status: "not_sent", outcome_unknown: false, reason: "invalid_request" };
  }
  const auth = target.token === undefined ? "" : JSON.stringify({ type: "auth", token: target.token }) + "\n";
  if (Buffer.byteLength(auth + message) > 1_000_000) return { status: "not_sent", outcome_unknown: false, reason: "invalid_request" };
  const controller = new AbortController();
  return await new Promise<ClaudeInboxSendResult>(resolve => {
    let settled = false;
    let attempted = false;
    let written = false;
    let confirmed: boolean | undefined;
    let confirmationFailed = false;
    let socket: net.Socket | undefined;
    const finish = (result: ClaudeInboxSendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.abort();
      socket?.destroy();
      resolve(result);
    };
    const unknown = (reason: "unconfirmed" | "confirmation_failed" | "write_failed" | "timeout") =>
      finish({ status: "unknown", outcome_unknown: true, reason });
    const afterWrite = () => {
      if (!written) return;
      if (confirmed === true) finish({ status: "accepted", outcome_unknown: false, reason: "receiver_confirmed" });
      else if (confirmationFailed) unknown("confirmation_failed");
      else if (!options.confirm_acceptance || confirmed === false) unknown("unconfirmed");
    };
    const timer = setTimeout(() => {
      if (attempted) unknown("timeout");
      else finish({ status: "not_sent", outcome_unknown: false, reason: "timeout" });
    }, timeout);
    if (options.confirm_acceptance) {
      // 観測側がthrow/rejectしても、書き込み後を未送信へ戻さない。
      let observing: Promise<boolean>;
      try { observing = options.confirm_acceptance(controller.signal); }
      catch {
        finish({ status: "not_sent", outcome_unknown: false, reason: "confirmation_failed" });
        return;
      }
      Promise.resolve(observing).then(value => {
        if (value === true && !attempted) {
          // 今回の書き込み前に届いた「受付済み」は、今回の送信を証明できない。
          finish({ status: "not_sent", outcome_unknown: false, reason: "confirmation_failed" });
          return;
        }
        confirmed = value === true;
        afterWrite();
      }, () => {
        if (!attempted) {
          finish({ status: "not_sent", outcome_unknown: false, reason: "confirmation_failed" });
          return;
        }
        confirmationFailed = true;
        afterWrite();
      });
    }
    try {
      socket = net.createConnection({ path: target.socket_path });
      socket.once("error", () => {
        if (attempted) unknown("write_failed");
        else finish({ status: "not_sent", outcome_unknown: false, reason: "connect_failed" });
      });
      socket.once("connect", () => {
        if (settled) return;
        attempted = true;
        socket!.end(auth + message, (error?: Error | null) => {
          if (error) unknown("write_failed");
          else { written = true; afterWrite(); }
        });
      });
      socket.on("data", () => {}); // raw投稿には受付票の仕様が無い。任意の返信を成功と解釈しない。
      socket.once("close", () => {
        if (settled) return;
        if (!attempted) finish({ status: "not_sent", outcome_unknown: false, reason: "connect_failed" });
        else if (!written) unknown("write_failed");
        // 書き込み後の切断でも、別経路の受領確認を期限まで待つ。
      });
    } catch {
      if (attempted) unknown("write_failed");
      else finish({ status: "not_sent", outcome_unknown: false, reason: "connect_failed" });
    }
  });
}

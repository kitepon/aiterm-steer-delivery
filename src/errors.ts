// 配送のエラー。delivery_codeが理由、outcome_unknownは「送ったかどうか確定できない」を表す。
// codeはAitermのAitermErrorと同じexit code（2）で、製品の既存のエラー表示へそのまま渡せる。

export class SteerDeliveryError extends Error {
  readonly code: number = 2;
  constructor(readonly delivery_code: string, message: string, readonly outcome_unknown = false) {
    super(`${delivery_code}: ${message}`);
  }
}

export class CodexDeliveryError extends SteerDeliveryError {}
export class ClaudeDeliveryError extends SteerDeliveryError {}
export class CursorDeliveryError extends SteerDeliveryError {}

/** setupの失敗。codeは製品のsetup結果のreason_codeになる。 */
export class SetupError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

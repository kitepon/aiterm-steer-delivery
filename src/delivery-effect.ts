// Product callback at the actual native input boundary. No state, IDs, graph,
// payload queue or retries belong to this package's admission adapter.
import { z } from "zod";
import type { ProductProfile } from "./profile.js";
import { SteerDeliveryError } from "./errors.js";

export interface DeliveryEffect {
  delivery_ids: readonly string[];
  stage: "queue" | "dequeue" | "emit" | "wake";
  vendor: "codex" | "claude" | "cursor";
  endpoint: unknown;
  native_context?: unknown;
}
export class DeliveryAdmissionError extends SteerDeliveryError {}
export const DELIVERY_ADMISSION_CONTRACT = Object.freeze({
  schema: "steer.delivery-admission.v1", native_context: true, cursor_profile_parameter: true,
  multi_delivery_emit: true, serialized_required: true,
});
export async function withDeliveryEffect<T>(profile: ProductProfile, input: DeliveryEffect,
  action: () => T | Promise<T>): Promise<T> {
  const admission = profile.delivery_admission;
  if (!admission) return action();
  if (admission.required !== true || !admission.run)
    throw new DeliveryAdmissionError("DELIVERY_ADMISSION_UNAVAILABLE", "入力の実行受付を確認できません");
  const effect = { ...input, delivery_ids: z.array(z.uuid()).min(1).parse(input.delivery_ids), endpoint: structuredClone(input.endpoint),
    ...(input.native_context === undefined ? {} : { native_context: structuredClone(input.native_context) }) };
  if (new Set(effect.delivery_ids).size !== effect.delivery_ids.length)
    throw new DeliveryAdmissionError("DELIVERY_ADMISSION_INVALID", "配送参照が重複しています");
  let used = false, active = true, settled = false, failure: unknown, pending: Promise<T> | undefined;
  const guarded = (): Promise<T> => {
    if (!active || used) {
      const error = new DeliveryAdmissionError("DELIVERY_ADMISSION_CONFLICT", "入力callbackを再利用できません", used);
      failure = error; return Promise.reject(error);
    }
    used = true;
    pending = (async () => {
      try { return await action(); }
      catch (error) { failure = error; throw error; }
      finally { settled = true; }
    })();
    // A broken runner must not leave a detached native rejection unobserved.
    void pending.catch(() => {});
    return pending;
  };
  try {
    await admission.run(effect, guarded);
    if (failure) throw failure;
    if (!used) throw new DeliveryAdmissionError("DELIVERY_ADMISSION_REFUSED", "入力は発行されていません");
    if (!settled) throw new DeliveryAdmissionError("DELIVERY_NATIVE_UNCONFIRMED", "実作用の応答より前に受付が終了しました", true);
    return await pending!; // preserve the actual native receipt, not a substitute
  } catch (error) {
    if (error instanceof SteerDeliveryError) throw error;
    const possible = used || (error as { effect?: unknown } | null)?.effect === "possible";
    throw new DeliveryAdmissionError(possible ? "DELIVERY_NATIVE_UNCONFIRMED" : "DELIVERY_ADMISSION_REFUSED",
      possible ? "入力結果を確認できません" : "入力の実行受付が拒否されました", possible);
  } finally { active = false; }
}

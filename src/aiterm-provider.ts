// Aitermの親配送へ頼む。製品は自分のhookを登録せず、確定した回答と親の指定をAitermへ渡す。
// 渡す相手は、Aitermが持つ命令 aiterm-parent-delivery（Aiterm 0.56.0以上）。Aitermが登録したhookと公式キューで届ける。
// Aitermの置き場のfileは、この入口からは書かない。読むのは、命令の場所の記録（aiterm-setupが残す delivery-provider.json）だけ。
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { CodexDeliveryError } from "./errors.js";
import type { CodexParent, CodexParentThread } from "./codex-receiver.js";

export const AITERM_PARENT_DELIVERY_SCHEMA = "aiterm.parent-delivery.v1";
export const AITERM_DELIVERY_PROVIDER_SCHEMA = "aiterm.delivery-provider.v1";

export type AitermDeliveryProvider = {
  /** 命令を動かすnodeの絶対path。 */
  node: string;
  /** aiterm-parent-deliveryの本体（.js）の絶対path。 */
  cli: string;
  /** 記録にあるAitermの版。記録以外から見つけた時はnull。 */
  version: string | null;
  /** 見つけた道。explicit＝引数か環境変数、record＝aiterm-setupの記録、path＝PATH。 */
  source: "explicit" | "record" | "path";
};

export type AitermProviderOptions = {
  /** aiterm-parent-deliveryの本体の絶対path。省略時は環境変数 AITERM_PARENT_DELIVERY_CLI、記録、PATHの順に探す。 */
  cli?: string;
  /** 命令を動かすnode。省略時は記録のnode、無ければこのprocessのnode。 */
  node?: string;
  /** 探す時と命令を起こす時の環境。省略時はこのprocessの環境。 */
  env?: NodeJS.ProcessEnv;
  /** 記録を探すhome。省略時は環境のHOME。 */
  home?: string;
  /** 命令1回の上限。省略時は90秒。 */
  timeout_ms?: number;
};

const recordSchema = z.object({
  schema: z.literal(AITERM_DELIVERY_PROVIDER_SCHEMA), version: z.string().min(1),
  node: z.string().refine(value => path.isAbsolute(value)), cli: z.string().refine(value => path.isAbsolute(value)),
}).strict();

const isFile = (file: string): boolean => { try { return fs.statSync(file).isFile(); } catch { return false; } };

/** Aitermの命令を探す。見つからなければnull。何も起こさず、何も書かない。 */
export function findAitermDeliveryProvider(options: AitermProviderOptions = {}): AitermDeliveryProvider | null {
  const env = options.env ?? process.env;
  const explicit = options.cli ?? env.AITERM_PARENT_DELIVERY_CLI;
  if (explicit) {
    // 明示した場所が使えない時に、別の場所へ黙って移らない。
    return path.isAbsolute(explicit) && isFile(explicit) ? { node: options.node ?? process.execPath, cli: explicit, version: null, source: "explicit" } : null;
  }
  const home = options.home ?? env.HOME ?? os.homedir();
  try {
    const record = recordSchema.parse(JSON.parse(fs.readFileSync(path.join(home, ".config", "aiterm-mcp", "delivery-provider.json"), "utf8")));
    const node = options.node ?? record.node;
    if (isFile(record.cli) && isFile(node)) return { node, cli: record.cli, version: record.version, source: "record" };
  } catch { /* 記録が無い・読めない・古い時は、PATHを探す */ }
  for (const directory of (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) {
    if (process.platform === "win32") {
      // npmのshim（.cmd）と同じ場所のnode_modulesに本体がある。
      const cli = path.join(directory, "node_modules", "aiterm-mcp", "dist", "parent-delivery-cli.js");
      if (isFile(path.join(directory, "aiterm-parent-delivery.cmd")) && isFile(cli)) return { node: options.node ?? process.execPath, cli, version: null, source: "path" };
      continue;
    }
    const shim = path.join(directory, "aiterm-parent-delivery");
    if (!isFile(shim)) continue;
    try { return { node: options.node ?? process.execPath, cli: fs.realpathSync(shim), version: null, source: "path" }; } catch { /* 壊れたlinkは飛ばす */ }
  }
  return null;
}

const unavailable = (message: string, outcomeUnknown = false) => new CodexDeliveryError("AITERM_PROVIDER_UNAVAILABLE", message, outcomeUnknown);

/** 命令を1回起こし、stdoutの最後の1行のJSONを返す。sendsは、本文を渡す呼び出しか（返りを読めなかった時、受け付けたか分からないと数える）。 */
async function callAiterm(args: string[], input: string | null, options: AitermProviderOptions, sends: boolean): Promise<any> {
  const provider = findAitermDeliveryProvider(options);
  if (!provider) {
    throw unavailable("Aitermの配送の入口（aiterm-parent-delivery）が見つかりません。Aiterm 0.56.0以上を導入し、aiterm-setupを実行してください。本文は送っていません");
  }
  const result = await new Promise<{ stdout: string; started: boolean; failure: string | null }>(resolve => {
    let stdout = "";
    let started = false;
    let settled = false;
    const finish = (failure: string | null) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ stdout, started, failure }); };
    const child = spawn(provider.node, [provider.cli, ...args], { stdio: ["pipe", "pipe", "ignore"], env: options.env ?? process.env, windowsHide: true });
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish("時間内に返りがありません"); }, options.timeout_ms ?? 90_000);
    child.once("spawn", () => { started = true; });
    child.once("error", (error: NodeJS.ErrnoException) => finish(`起動できません（${error.code ?? "unknown"}）`));
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stdin.on("error", () => { /* 相手が先に終わった時は、closeで扱う */ });
    child.once("close", () => finish(null));
    child.stdin.end(input ?? "");
  });
  if (result.failure) throw unavailable(`Aitermの配送の入口を呼べません: ${result.failure}`, sends && result.started);
  let value: any;
  try { value = JSON.parse(result.stdout.split("\n").filter(Boolean).at(-1) ?? ""); }
  catch { throw unavailable("Aitermの配送の入口が、読めない返りを出しました", sends); }
  if (value?.schema !== AITERM_PARENT_DELIVERY_SCHEMA || typeof value.ok !== "boolean") {
    throw unavailable("Aitermの配送の入口の返りの形が合いません。Aitermを更新してください", sends);
  }
  if (!value.ok) {
    const code = typeof value.code === "string" ? value.code : "AITERM_PROVIDER_FAILED";
    const message = typeof value.message === "string" ? value.message : "Aitermが配送を断りました";
    // Aitermの文面は「理由の符号: 文」の形で来る。符号を二重に付けない。
    throw new CodexDeliveryError(code, message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message, value.outcome_unknown === true);
  }
  return value;
}

const target = (parent: CodexParent): string[] => ["--thread", parent.thread_id, "--codex-home", parent.codex_home];

/**
 * 親を確かめる。steerは設定の話で、enabled＝Aitermのhookが登録・承認済みで親がhookの導入後に起きている（動いている番へ同じ番で渡せる）、
 * disabled＝公式キューだけ（番が終わってから届く）。届いた事は言わない。
 */
export async function verifyCodexParentViaAiterm(parent: CodexParent, options: AitermProviderOptions = {}):
  Promise<{ thread: CodexParentThread; steer: "enabled" | "disabled" }> {
  const value = await callAiterm(["codex", "verify", ...target(parent)], null, options, false);
  if (value.verified !== true || typeof value.thread?.thread_id !== "string" || !["enabled", "disabled"].includes(value.steer)) {
    throw unavailable("Aitermの配送の入口の返りの形が合いません。Aitermを更新してください");
  }
  return { thread: value.thread, steer: value.steer };
}

/** 確定した本文を、Aitermの親配送へ一度だけ頼む。deliveryIdは本文ごとに新しいUUID。受け付けたか分からない失敗はoutcome_unknownで区別する。 */
export async function submitCodexParentAnswerViaAiterm(parent: CodexParent, deliveryId: string, text: string, options: AitermProviderOptions = {}):
  Promise<{ queued_submission_id: string | null }> {
  z.uuid().parse(deliveryId);
  const value = await callAiterm(["codex", "submit", ...target(parent), "--delivery", deliveryId, "--text-file", "-"], text, options, true);
  if (!(value.queued_submission_id === null || typeof value.queued_submission_id === "string")) {
    throw unavailable("Aitermの配送の入口の返りの形が合いません。Aitermを更新してください", true);
  }
  return { queued_submission_id: value.queued_submission_id };
}

export type AitermDeliveryDetail = {
  /** 送る途中の状態。sending＝hookが取り出している最中、unknown＝取り出しの結果が分からない、null＝どちらでもない。 */
  state: "sending" | "unknown" | null;
  /** Aitermのhookの記録。pending＝受け付けて未投入、emitted＝turn_idの番へ入れた、not_in_queue＝公式キューが先に会話へ渡した、null＝記録なし。 */
  hook: "pending" | "sending" | "emitted" | "not_in_queue" | "unknown" | null;
  /** hookが本文を入れた番（hookがemittedの時だけ）。 */
  turn_id: string | null;
  /** 今も公式キューに残っているか。確かめられなかった時はnull。 */
  queued: boolean | null;
  queue_error?: string;
};

/** 届き方の事実を読む。受け付けた事と、実際に番へ入った事を分けて返す。 */
export async function codexDeliveryDetailViaAiterm(parent: CodexParent, deliveryId: string, options: AitermProviderOptions = {}): Promise<AitermDeliveryDetail> {
  z.uuid().parse(deliveryId);
  const value = await callAiterm(["codex", "state", ...target(parent), "--delivery", deliveryId], null, options, false);
  return { state: value.state ?? null, hook: value.hook ?? null, turn_id: value.turn_id ?? null, queued: value.queued ?? null,
    ...(typeof value.queue_error === "string" ? { queue_error: value.queue_error } : {}) };
}

/** 送る途中の状態だけを返す（`codexHookDeliveryState`と同じ値）。 */
export async function codexDeliveryStateViaAiterm(parent: CodexParent, deliveryId: string, options: AitermProviderOptions = {}): Promise<"sending" | "unknown" | null> {
  return (await codexDeliveryDetailViaAiterm(parent, deliveryId, options)).state;
}

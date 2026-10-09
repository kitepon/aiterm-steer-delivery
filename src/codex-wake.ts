// 寝ているCodexの会話を起こす。
// 公式キューを番にするのは、その会話を載せている（loaded）Codexのprocessだけ。Codexのアプリは、見ている接続が居なくなった会話を
// 60秒で下ろす（thread_unload_delay_secs）。下ろされた会話のキューは、人がその会話を開くまで誰も見ない。
// 入れた少し後にキューを見直し、番が普通に終わって寝ている会話なら、OSの口で`codex://threads/<id>`を開かせて、アプリに載せさせる。
// 走っている会話（hookが入れる）、途中で止められた会話（人が止めた・ほかの製品が乗り換えた）、アプリの会話でない物（CLIの席）は起こさない。
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { codexHookDirectory, type ProductProfile } from "./profile.js";
import { withCodexReceiver, type CodexParent, type CodexReceiverRuntime } from "./codex-receiver.js";
import { writeHookJson } from "./files.js";
import { windowsPowerShellSync } from "./windows.js";

/** 会話の記録（rollout）の末尾から読んだ、最後の番の状態。 */
export type CodexTurnTail = "running" | "completed" | "interrupted" | "none" | "unknown";

const TAIL_FIRST_BYTES = 256 * 1024;
const TAIL_MAX_BYTES = 16 * 1024 * 1024;

/**
 * 記録の末尾から、最後の番の境を読む。task_started＝走っている、task_complete＝普通に終わった、turn_aborted＝途中で止められた。
 * 番が1つも無ければ none。末尾16MiBに境が無い・読めない時は unknown（起こさない側へ倒す）。
 */
export function readCodexTurnTail(file: string): CodexTurnTail {
  let fd: number;
  try { fd = fs.openSync(file, "r"); } catch { return "unknown"; }
  try {
    const size = fs.fstatSync(fd).size;
    for (let bytes = TAIL_FIRST_BYTES; ; bytes *= 4) {
      const length = Math.min(size, bytes);
      const start = size - length;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      const lines = buffer.toString("utf8").split("\n");
      // 途中から読んだ時、先頭は行の切れ端。
      if (start > 0) lines.shift();
      for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index];
        if (!line.includes("task_started") && !line.includes("task_complete") && !line.includes("turn_aborted")) continue;
        let row: any;
        try { row = JSON.parse(line); } catch { continue; }
        if (row?.type !== "event_msg") continue;
        if (row.payload?.type === "task_started") return "running";
        if (row.payload?.type === "task_complete") return "completed";
        if (row.payload?.type === "turn_aborted") return "interrupted";
      }
      if (start === 0) return "none";
      if (length >= TAIL_MAX_BYTES) return "unknown";
    }
  } catch { return "unknown"; }
  finally { fs.closeSync(fd); }
}

export function codexThreadUrl(threadId: string): string {
  return `codex://threads/${encodeURIComponent(z.uuid().parse(threadId))}`;
}

export interface CodexThreadOpener { (url: string): { ok: boolean; detail?: string } }

/**
 * Windowsで、このprocessが人の画面のあるsessionで動いているか。サービスやsshのsession（番号0）から開いたリンクは、人の画面のアプリへ届かない。
 * sessionの番号を読めない時（PowerShell 7が無い）は、画面のあるsessionにだけ入る環境変数`SESSIONNAME`で見る。
 */
export function windowsInteractiveSession(env: NodeJS.ProcessEnv = process.env,
  sessionId: () => string = () => windowsPowerShellSync("(Get-Process -Id $PID).SessionId", () => new Error("session id unavailable"), 10_000)): boolean {
  try {
    const id = Number(sessionId());
    if (Number.isInteger(id)) return id > 0;
  } catch { /* 下の環境変数で見る */ }
  return Boolean(env.SESSIONNAME);
}

/**
 * OSの口で、Codexのアプリにリンクを開かせる関数を返す。口の無い環境ではnull。
 * macOSは`/usr/bin/open -g`（アプリを前面へ出さない）、Windowsは`cmd /c start`（人の画面のあるsessionの時だけ）。
 * Linuxのアプリは、まだ起こせない（`xdg-open`で開かせても会話が載らなかった。実物で確かめた後に足す）。
 * 命令は場所を決めて呼ぶ。CodexがMCP serverへ渡す環境は細く、PATHに頼ると見つからない事がある。
 */
export function codexThreadOpener(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env,
  interactive: () => boolean = () => windowsInteractiveSession(env)): CodexThreadOpener | null {
  const run = (command: string, args: string[]) => (): { ok: boolean; detail?: string } => {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 15_000, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env });
    if (result.error) return { ok: false, detail: (result.error as NodeJS.ErrnoException).code ?? result.error.message };
    return result.status === 0 ? { ok: true } : { ok: false, detail: `exit=${result.status} ${String(result.stderr ?? "").trim().slice(0, 200)}`.trim() };
  };
  if (platform === "darwin") return url => run("/usr/bin/open", ["-g", url])();
  if (platform === "win32") {
    if (!interactive()) return null;
    const key = (name: string) => Object.keys(env).find(candidate => candidate.toLowerCase() === name);
    const comspec = env[key("comspec") ?? "ComSpec"] ?? path.win32.join(env[key("systemroot") ?? "SystemRoot"] ?? "C:\\Windows", "System32", "cmd.exe");
    return url => run(comspec, ["/d", "/c", "start", "", url])();
  }
  return null;
}

export type CodexWakeOutcome =
  /** 見直した時にはキューに無かった。会話が載っていて受け取ったか、hookが番の途中へ入れた。 */
  | "delivered"
  /** 番の途中。hookか、番の終わりの公式キューが渡す。 */
  | "running"
  /** 最後の番が途中で止められている。人が次の文を送るまでCodexはキューを動かさない。起こさない。 */
  | "interrupted"
  /** アプリの会話でない（CLIの席など）。リンクで開く相手が無い。 */
  | "not_app_thread"
  /** 会話の記録から番の状態を読めなかった。起こさない。 */
  | "unknown_state"
  /** この環境に、リンクを開く口が無い。 */
  | "no_opener"
  /** リンクを開く命令が失敗した。 */
  | "open_failed"
  /** リンクを開き、キューが動いた（この文が出た、または前に並んでいた文が出た）。 */
  | "woken"
  /** リンクを開いたが、待った間にキューが動かなかった。 */
  | "opened_still_queued";

export interface CodexWakeResult {
  delivery_id: string;
  thread_id: string;
  outcome: CodexWakeOutcome;
  /** 番の状態を読んだ時の値。読む前に決まった時はnull。 */
  turn: CodexTurnTail | null;
  checked_at: string;
  opened_at: string | null;
  detail?: string;
}

export interface CodexWakeOptions {
  /** 入れてから見直すまで。載っている会話は、Codexが10秒以内に番にする。 */
  delay_ms?: number;
  /** リンクを開いた後、キューが動くのを待つ長さ。 */
  confirm_ms?: number;
  /** 同じ会話を、ほかの配送が開いたばかりの時に、重ねて開かない長さ。 */
  reopen_guard_ms?: number;
  runtime?: CodexReceiverRuntime;
  /** nullは「口が無い」。省略すると、この環境の口を使う。 */
  open?: CodexThreadOpener | null;
  sleep?: (ms: number) => Promise<void>;
  /** 結果を残す場所。省略すると製品のhook directoryの`wake`。 */
  directory?: string;
}

export function codexWakeDirectory(profile: ProductProfile): string {
  return path.join(codexHookDirectory(profile), "wake");
}

const RECORD_KEEP_MS = 3 * 24 * 60 * 60 * 1000;

function pruneWakeRecords(directory: string, now: number): void {
  for (const folder of [directory, path.join(directory, "threads")]) {
    let names: string[];
    try { names = fs.readdirSync(folder); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(folder, name);
      try { if (now - fs.statSync(file).mtimeMs > RECORD_KEEP_MS) fs.rmSync(file, { force: true }); } catch { /* ほかの見張りが先に消した */ }
    }
  }
}

/** 配送の後に残した結果を読む。無ければnull。 */
export function readCodexWakeResult(profile: ProductProfile, deliveryId: string, directory = codexWakeDirectory(profile)): CodexWakeResult | null {
  try { return JSON.parse(fs.readFileSync(path.join(directory, `${z.uuid().parse(deliveryId)}.json`), "utf8")) as CodexWakeResult; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/**
 * 入れた文がまだキューにあり、会話が寝ている時に、アプリにその会話を開かせる。結果を返し、`directory`へ残す。
 * 起こすのは、アプリの会話（sourceがvscode）で、最後の番が普通に終わっている（または番が1つも無い）時だけ。
 */
export async function wakeCodexParentIfAsleep(profile: ProductProfile, parent: CodexParent, deliveryId: string, options: CodexWakeOptions = {}): Promise<CodexWakeResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const directory = options.directory ?? codexWakeDirectory(profile);
  const result: CodexWakeResult = { delivery_id: z.uuid().parse(deliveryId), thread_id: z.uuid().parse(parent.thread_id),
    outcome: "delivered", turn: null, checked_at: "", opened_at: null };
  await sleep(options.delay_ms ?? 15_000);
  await withCodexReceiver(profile, parent, async request => {
    const queue = async (): Promise<{ ids: string[]; mine: boolean }> => {
      const ids: string[] = [];
      let mine = false;
      let cursor: string | null = null;
      do {
        const page = await request("thread/queue/list", { threadId: parent.thread_id, cursor, limit: 100 });
        for (const entry of Array.isArray(page?.data) ? page.data : []) {
          ids.push(String(entry?.id));
          if (entry?.clientUserMessageId === deliveryId) mine = true;
        }
        cursor = typeof page?.nextCursor === "string" ? page.nextCursor : null;
      } while (cursor);
      return { ids, mine };
    };
    const before = await queue();
    result.checked_at = new Date().toISOString();
    if (!before.mine) { result.outcome = "delivered"; return; }
    const thread = (await request("thread/read", { threadId: parent.thread_id, includeTurns: false }))?.thread;
    if (thread?.source !== "vscode") { result.outcome = "not_app_thread"; return; }
    result.turn = typeof thread.path === "string" && thread.path ? readCodexTurnTail(thread.path) : "unknown";
    if (result.turn === "running") { result.outcome = "running"; return; }
    if (result.turn === "interrupted") { result.outcome = "interrupted"; return; }
    if (result.turn === "unknown") { result.outcome = "unknown_state"; return; }
    const open = options.open === undefined ? codexThreadOpener() : options.open;
    if (!open) { result.outcome = "no_opener"; return; }
    // 同じ会話へ何通か続けて届いた時、1通ごとにアプリの画面を切り替えない。
    const stamp = path.join(directory, "threads", `${parent.thread_id}.json`);
    let recent = false;
    try { recent = Date.now() - fs.statSync(stamp).mtimeMs < (options.reopen_guard_ms ?? 30_000); } catch { /* まだ誰も開いていない */ }
    if (!recent) {
      writeHookJson(stamp, { thread_id: parent.thread_id, delivery_id: deliveryId });
      const opened = open(codexThreadUrl(parent.thread_id));
      if (!opened.ok) { result.outcome = "open_failed"; if (opened.detail) result.detail = opened.detail; return; }
    }
    result.opened_at = new Date().toISOString();
    // キューは先頭から番になる。前に並んでいた文が出た時も、会話は起きている。
    const deadline = Date.now() + (options.confirm_ms ?? 30_000);
    for (;;) {
      await sleep(2_000);
      const after = await queue();
      if (!after.mine || after.ids[0] !== before.ids[0] || after.ids.length < before.ids.length) { result.outcome = "woken"; return; }
      if (Date.now() >= deadline) { result.outcome = "opened_still_queued"; return; }
    }
  }, options.runtime);
  try { writeHookJson(path.join(directory, `${result.delivery_id}.json`), result); pruneWakeRecords(directory, Date.now()); }
  catch { /* 結果を残せなくても、起こした事は変わらない */ }
  return result;
}

/** 見張りを別のprocessで起こすかどうか。リンクを開く口の無いOS（Linuxなど）では、何も起こさない。 */
export function codexWakeWatchEnabled(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AITERM_STEER_CODEX_WAKE === "0") return false;
  return platform === "darwin" || platform === "win32";
}

export const CODEX_WAKE_PAYLOAD_ENV = "AITERM_STEER_CODEX_WAKE_PAYLOAD";

/** 見張りのprocessへ渡す、関数を含まない製品の識別情報。 */
export function serializeWakeProfile(profile: ProductProfile): Record<string, unknown> {
  const { state_root, config_root, channels: _channels, ...rest } = profile;
  return { ...rest, dispatch_tools: [...profile.dispatch_tools], state_root: state_root(), config_root: config_root() };
}

/**
 * 配送を呼んだprocessとは別に、見張りを1つ起こす。呼んだprocessがすぐ終わっても（製品のCLI）、見直しと起こしは最後まで走る。
 * 起こせなかった時も投げない。文はもうキューに入っていて、今までどおり会話が開かれた時に届く。
 */
export function startCodexWakeWatch(profile: ProductProfile, parent: CodexParent, deliveryId: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; entry?: string; delay_ms?: number } = {}): boolean {
  const env = options.env ?? process.env;
  if (!codexWakeWatchEnabled(options.platform, env)) return false;
  try {
    const entry = options.entry ?? fileURLToPath(new URL("./codex-wake-main.js", import.meta.url));
    if (!fs.existsSync(entry)) return false;
    const payload = JSON.stringify({ profile: serializeWakeProfile(profile), parent, delivery_id: deliveryId,
      ...(options.delay_ms === undefined ? {} : { delay_ms: options.delay_ms }) });
    const child = spawn(process.execPath, [entry], { detached: true, stdio: "ignore", windowsHide: true, env: { ...env, [CODEX_WAKE_PAYLOAD_ENV]: payload } });
    child.on("error", () => { /* 起こせなかった。文はキューにある */ });
    child.unref();
    return true;
  } catch { return false; }
}

const payloadSchema = z.object({
  profile: z.object({ state_root: z.string(), config_root: z.string() }).passthrough(),
  parent: z.object({ thread_id: z.uuid(), codex_home: z.string() }).strict(),
  delivery_id: z.uuid(),
  delay_ms: z.number().int().min(0).optional(),
}).strict();

/** 見張りのprocessの本体。結果は製品のhook directoryの`wake`に残す。 */
export async function runCodexWakeMain(raw: string | undefined = process.env[CODEX_WAKE_PAYLOAD_ENV]): Promise<void> {
  try {
    const payload = payloadSchema.parse(JSON.parse(raw ?? ""));
    const { state_root, config_root, ...rest } = payload.profile;
    const profile = { ...rest, state_root: () => state_root, config_root: () => config_root } as unknown as ProductProfile;
    await wakeCodexParentIfAsleep(profile, payload.parent, payload.delivery_id, payload.delay_ms === undefined ? {} : { delay_ms: payload.delay_ms });
  } catch (error) {
    process.stderr.write(`CODEX_WAKE_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

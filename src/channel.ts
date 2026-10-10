// 同じ会話へ何通も送るための受け口（channel）。受信方式はAitermの単発配送と同じ公式の仕組みを使う。
// - Codex: 公式キューはthread単位なので、送るたびに単発配送と同じ submitCodexParentAnswer を呼ぶ。
// - Claude Code: PostToolUse・Stopのasync hook（asyncRewake）が会話ごとに1つだけ待ち、本文をstderrへ出してexit 2で起こす。
//   turnが終わるたびにStopが待機を張り直すので、2通目以降も届く。
// - Cursor: tool結果のchannel IDを公式hookが会話へ結び、次のtool返りにadditional_contextで差し込む。
//   idle中は親が背景で起動した受信processが次の1通を受け取って終わる（親は同じ受信processを張り直す）。
// - その他（Grok等）: 背景の受信processだけで受け取る。
// 本文は受け口がclaimしてから出す。claim後に出力が確定しなければunknownとし、自動では再送しない。
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { writeJson0600 } from "./files.js";
import { hookOwnerProcess, readRuntimeProcesses } from "./process.js";
import { channelRoot, type ProductProfile } from "./profile.js";
import { SteerDeliveryError } from "./errors.js";
import { submitCodexParentAnswer, type CodexParent, type CodexReceiverRuntime } from "./codex-receiver.js";
import type { ClaudeParent } from "./claude-receiver.js";
import { windowsStartProcessArgumentList } from "./windows.js";
import type { WaitProcess } from "./cursor-receive.js";

export type ChannelKind = "codex" | "claude" | "cursor" | "background";
const uuid = z.uuid();

const channelSchema = z.object({
  schema: z.literal("aiterm-steer.channel.v1"),
  channel_id: z.uuid(),
  kind: z.enum(["codex", "claude", "cursor", "background"]),
  created_at: z.string(),
  codex: z.object({ thread_id: z.uuid(), codex_home: z.string() }).strict().optional(),
  claude: z.object({ session_id: z.uuid(), parent_pid: z.number().int().positive(), parent_started_identity: z.string() }).strict().optional(),
}).strict();
export type Channel = z.infer<typeof channelSchema>;

export class ChannelError extends SteerDeliveryError {}

let sendSequence = 0;
const itemSchema = z.object({ delivery_id: z.uuid(), text: z.string(), at: z.string() }).strict();
type Item = z.infer<typeof itemSchema>;
export type ChannelDeliveryState = "queued" | "sending" | "emitted" | "unknown" | "withdrawn";

function channelDir(profile: ProductProfile, channelId: string): string {
  return path.join(channelRoot(profile), uuid.parse(channelId));
}
function processIdentity(pid: number): string | undefined {
  return readRuntimeProcesses().find(entry => entry.pid === pid)?.started_identity;
}

function mkdirs(...dirs: string[]): void { for (const dir of dirs) fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }

/**
 * 親の会話にchannelを開く。parentは単発配送と同じ方法で特定したもの（codexParentFromRequest、claudeParentFromRequest、
 * cursorParentFromRequest）。Grok等の特定できない親は null を渡し、背景受信だけのchannelにする。
 */
export function openChannel(profile: ProductProfile, parent: CodexParent | ClaudeParent | { kind: "cursor" } | null): Channel {
  const channel_id = randomUUID();
  const dir = channelDir(profile, channel_id);
  const created_at = new Date().toISOString();
  let channel: Channel;
  if (parent === null) channel = { schema: "aiterm-steer.channel.v1", channel_id, kind: "background", created_at };
  else if ("thread_id" in parent) channel = { schema: "aiterm-steer.channel.v1", channel_id, kind: "codex", created_at, codex: { thread_id: parent.thread_id, codex_home: parent.codex_home } };
  else if (parent.kind === "cursor") channel = { schema: "aiterm-steer.channel.v1", channel_id, kind: "cursor", created_at };
  else {
    // PreToolUse hookが記録した実際の会話と親processに結ぶ。起動時envのsession IDは使わない。
    const request = z.object({ session_id: z.uuid(), parent_pid: z.number().int().positive(), parent_started_identity: z.string() }).loose()
      .parse(JSON.parse(fs.readFileSync(path.join(parent.hook_root, parent.request_id, "request.json"), "utf8")));
    if (request.session_id !== parent.session_id) throw new ChannelError("CHANNEL_PARENT_SESSION_MISMATCH", "要求とhookの会話が一致しません");
    channel = { schema: "aiterm-steer.channel.v1", channel_id, kind: "claude", created_at,
      claude: { session_id: request.session_id, parent_pid: request.parent_pid, parent_started_identity: request.parent_started_identity } };
  }
  mkdirs(path.join(dir, "inbox"), path.join(dir, "claims"), path.join(dir, "emitted"));
  writeJson0600(path.join(dir, "channel.json"), channel);
  if (channel.claude) {
    const index = path.join(channelRoot(profile), "claude-sessions", channel.claude.session_id);
    mkdirs(index);
    fs.writeFileSync(path.join(index, channel_id), "", { mode: 0o600 });
  }
  return channel;
}

export function readChannel(profile: ProductProfile, channelId: string): Channel {
  const file = path.join(channelDir(profile, channelId), "channel.json");
  try { return channelSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ChannelError("CHANNEL_UNKNOWN", "channelの記録がありません");
    throw new ChannelError("CHANNEL_STATE_INVALID", "channelの記録を読めません");
  }
}

export function channelClosed(profile: ProductProfile, channelId: string): boolean {
  return fs.existsSync(path.join(channelDir(profile, channelId), "closed.json"));
}

/** channelを閉じる。未取得の本文は残し、待機中の受け口は次の確認で終わる。 */
export function closeChannel(profile: ProductProfile, channelId: string, reason = "closed"): void {
  const dir = channelDir(profile, channelId);
  if (!fs.existsSync(dir)) return;
  writeJson0600(path.join(dir, "closed.json"), { reason, at: new Date().toISOString() });
}

/**
 * 確定した本文を送る。Codexは公式キューへ入れて受付IDを返す（state=submitted）。
 * それ以外はchannelの受信箱へ保存し（state=queued）、受け口が出力した時点でemittedになる。deliveryIdは送る本文ごとに新しいUUID。
 */
export async function sendToChannel(profile: ProductProfile, channelId: string, deliveryId: string, text: string,
  runtime?: CodexReceiverRuntime): Promise<{ state: "submitted" | "queued"; queued_submission_id: string | null }> {
  uuid.parse(deliveryId);
  const channel = readChannel(profile, channelId);
  if (channelClosed(profile, channelId)) throw new ChannelError("CHANNEL_CLOSED", "channelは閉じています。本文は送っていません");
  if (channel.kind === "codex") {
    const result = await submitCodexParentAnswer(profile, channel.codex!, deliveryId, text, runtime);
    return { state: "submitted", queued_submission_id: result.queued_submission_id };
  }
  const dir = channelDir(profile, channelId);
  for (const sub of ["claims", "emitted"]) {
    if (fs.existsSync(path.join(dir, sub, `${deliveryId}.json`))) throw new ChannelError("CHANNEL_DELIVERY_DUPLICATE", "同じ配送IDの本文はすでに受け取られています");
  }
  // 受け口は名前の順に取り出す。同じミリ秒に送った本文も送った順に並ぶよう、processの通し番号を挟む。
  const name = `${Date.now().toString().padStart(15, "0")}-${(sendSequence++).toString().padStart(9, "0")}-${deliveryId}.json`;
  const item: Item = { delivery_id: deliveryId, text, at: new Date().toISOString() };
  // 受け口に途中のファイルを見せない。一時名で書いてから受信箱へ移す。
  const temporary = path.join(dir, `.${deliveryId}.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(item) + "\n", { flag: "wx", mode: 0o600 });
  try { fs.linkSync(temporary, path.join(dir, "inbox", name)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ChannelError("CHANNEL_DELIVERY_DUPLICATE", "同じ配送IDの本文がすでに受信箱にあります");
    throw error;
  } finally { fs.rmSync(temporary, { force: true }); }
  return { state: "queued", queued_submission_id: null };
}

/** 送った本文の現在の状態。Codexは公式キューの受付までを表す（submitted）。 */
export function channelDeliveryState(profile: ProductProfile, channelId: string, deliveryId: string): ChannelDeliveryState | null {
  uuid.parse(deliveryId);
  const channel = readChannel(profile, channelId);
  if (channel.kind === "codex") return null;
  const dir = channelDir(profile, channelId);
  if (fs.existsSync(path.join(dir, "emitted", `${deliveryId}.json`))) return "emitted";
  const claim = path.join(dir, "claims", `${deliveryId}.json`);
  if (fs.existsSync(claim)) {
    let value: any;
    try { value = JSON.parse(fs.readFileSync(claim, "utf8")); } catch { return "sending"; }
    if (value.state === "unknown") return "unknown";
    if (value.state === "withdrawn") return "withdrawn";
    if (typeof value.pid === "number" && typeof value.started_identity === "string" && processIdentity(value.pid) !== value.started_identity) return "unknown";
    return "sending";
  }
  return fs.readdirSync(path.join(dir, "inbox")).some(name => name.endsWith(`-${deliveryId}.json`)) ? "queued" : null;
}

/**
 * まだどの受け口も取っていない本文を受信箱から取り下げる。取り下げられたらtrue（親へは出ていない）。
 * 受け口が先に取っていたらfalse。channelを張り直す時に、未取得の本文を新しいchannelへ送り直すために使う。
 */
export function withdrawFromChannel(profile: ProductProfile, channelId: string, deliveryId: string): boolean {
  uuid.parse(deliveryId);
  const dir = channelDir(profile, channelId);
  const inbox = path.join(dir, "inbox");
  const name = fs.existsSync(inbox) ? fs.readdirSync(inbox).find(entry => entry.endsWith(`-${deliveryId}.json`)) : undefined;
  if (!name) return false;
  const claim = path.join(dir, "claims", `${deliveryId}.json`);
  // 受け口のclaimと同じhard linkで取り合う。どちらか一方だけが成功する。
  try { fs.linkSync(path.join(inbox, name), claim); fs.unlinkSync(path.join(inbox, name)); }
  catch (error) { if (["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
  writeJson0600(claim, { delivery_id: deliveryId, state: "withdrawn", at: new Date().toISOString() });
  return true;
}

type Claimed = { channel_id: string; item: Item; claim: string; dir: string };

/** 受信箱の本文を到着順にclaimする。hard linkの作成で、同じ本文を二つの受け口が取らないようにする。 */
function claimPending(profile: ProductProfile, channelId: string, by: string, limit = Infinity): Claimed[] {
  const dir = channelDir(profile, channelId);
  const inbox = path.join(dir, "inbox");
  if (!fs.existsSync(inbox)) return [];
  let identity: string | undefined;
  const claimed: Claimed[] = [];
  for (const name of fs.readdirSync(inbox).filter(entry => entry.endsWith(".json")).sort()) {
    if (claimed.length >= limit) break;
    const source = path.join(inbox, name);
    let item: Item;
    try { item = itemSchema.parse(JSON.parse(fs.readFileSync(source, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const claim = path.join(dir, "claims", `${item.delivery_id}.json`);
    try { fs.linkSync(source, claim); fs.unlinkSync(source); }
    catch (error) { if (["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) continue; throw error; }
    identity ??= processIdentity(process.pid) ?? "unknown";
    writeJson0600(claim, { ...item, state: "sending", by, pid: process.pid, started_identity: identity });
    claimed.push({ channel_id: channelId, item, claim, dir });
  }
  return claimed;
}

function settle(entries: Claimed[], by: string, state: "emitted" | "unknown"): void {
  for (const entry of entries) {
    if (state === "emitted") {
      writeJson0600(path.join(entry.dir, "emitted", `${entry.item.delivery_id}.json`), { delivery_id: entry.item.delivery_id, by, at: new Date().toISOString() });
      fs.rmSync(entry.claim, { force: true });
    } else {
      writeJson0600(entry.claim, { ...entry.item, state: "unknown", by });
    }
  }
}

/** claimした本文を出力し、出力が確定したものだけをemittedにする。出力の途中で失敗したらunknownにする。 */
async function emitClaimed(entries: Claimed[], by: string, emit: (texts: string[]) => Promise<void> | void): Promise<void> {
  try { await emit(entries.map(entry => entry.item.text)); }
  catch (error) { settle(entries, by, "unknown"); throw error; }
  settle(entries, by, "emitted");
}

// ---- Claude Code ----

function sessionIndex(profile: ProductProfile, sessionId: string): string {
  return path.join(channelRoot(profile), "claude-sessions", uuid.parse(sessionId));
}

function openClaudeChannels(profile: ProductProfile, sessionId: string): Channel[] {
  const index = sessionIndex(profile, sessionId);
  if (!fs.existsSync(index)) return [];
  return fs.readdirSync(index).filter(name => uuid.safeParse(name).success).flatMap(name => {
    try {
      const channel = readChannel(profile, name);
      return channel.claude?.session_id === sessionId && !channelClosed(profile, name) ? [channel] : [];
    } catch (error) {
      if (error instanceof ChannelError && error.delivery_code === "CHANNEL_UNKNOWN") return [];
      throw error;
    }
  });
}

/** 会話ごとに待機processを1つにする。生きている待機があればfalse。終了した待機の記録は引き継ぐ。 */
function acquireWaiter(index: string): string | null {
  const file = path.join(index, "waiter.json");
  const identity = processIdentity(process.pid);
  if (!identity) throw new ChannelError("CHANNEL_WAITER_UNAVAILABLE", "受信hookのprocessを確認できません");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started_identity: identity }) + "\n", { flag: "wx", mode: 0o600 });
      return identity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let owner: { pid?: unknown; started_identity?: unknown } = {};
    try { owner = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* 書き込み途中。次の試行で読む */ }
    if (typeof owner.pid === "number" && typeof owner.started_identity === "string" && processIdentity(owner.pid) === owner.started_identity) return null;
    // 終了した待機の記録。renameで一つのprocessだけが片付ける。
    try { fs.renameSync(file, path.join(index, `waiter.${randomUUID()}.stale`)); } catch { /* 他のprocessが先に片付けた */ }
    for (const name of fs.readdirSync(index).filter(entry => entry.endsWith(".stale"))) fs.rmSync(path.join(index, name), { force: true });
  }
  return null;
}

function releaseWaiter(index: string, identity: string): void {
  const file = path.join(index, "waiter.json");
  try {
    const owner = JSON.parse(fs.readFileSync(file, "utf8"));
    if (owner.pid === process.pid && owner.started_identity === identity) fs.rmSync(file, { force: true });
  } catch { /* 既に無い */ }
}

/** このhookを起こしたClaude Codeのprocess。shellを通す形のhookでは、直接の親のshellの先をたどる。分からなければnull。 */
function currentHookOwner(): { pid: number; started_identity: string } | null {
  const owner = hookOwnerProcess(readRuntimeProcesses(), process.ppid);
  return owner ? { pid: owner.pid, started_identity: owner.started_identity } : null;
}

/**
 * Claude Codeのhook（PostToolUse・Stop、asyncRewake）から呼ぶ。その会話のchannelに届いた本文を待ち、
 * 出力したら2（親を起こす）、待つものが無い・他の待機が生きている・会話が終わったなら0を返す。
 *
 * 待機は、このhookを起こしたClaude Codeのprocessが生きている間だけ続ける。本文はそのprocessへ出すので、居なくなった後に取ると失う。
 * channelを開いた時のprocess（`channel.claude.parent_pid`）が居なくなっていても、同じ会話（session_id）のhookを走らせている今のprocessへ出す。
 * Claude Codeが起動し直して同じ会話を再開した後も、前のprocessが開いたchannelの本文が届く。
 * hookを起こしたprocessを確かめられない時だけ、channelを開いた時のprocessの生き死にで決める。
 */
export async function runClaudeChannelWaiter(profile: ProductProfile, input: unknown, emit: (text: string) => Promise<void> | void,
  options: { wait_ms?: number; poll_ms?: number; owner?: { pid: number; started_identity: string } | null } = {}): Promise<0 | 2> {
  const event = z.object({ session_id: z.uuid() }).loose().parse(input);
  if (!openClaudeChannels(profile, event.session_id).length) return 0;
  const owner = options.owner === undefined ? currentHookOwner() : options.owner;
  const index = sessionIndex(profile, event.session_id);
  const identity = acquireWaiter(index);
  if (!identity) return 0;
  const deadline = Date.now() + (options.wait_ms ?? 86_340_000);
  let lastParentCheck = 0;
  try {
    for (;;) {
      const channels = openClaudeChannels(profile, event.session_id);
      if (!channels.length) return 0;
      if (Date.now() - lastParentCheck >= 5_000) {
        lastParentCheck = Date.now();
        // 本文を出す先（このhookを起こしたClaude process）が終わっていたら、本文を取らずに待機を終える。
        const alive = owner ? processIdentity(owner.pid) === owner.started_identity
          : channels.some(channel => processIdentity(channel.claude!.parent_pid) === channel.claude!.parent_started_identity);
        if (!alive) return 0;
      }
      // 同じ会話に開いているchannelが幾つかある時（起動し直す前のchannelと後のchannel）も、届いた順に出す。
      const claimed = channels.flatMap(channel => claimPending(profile, channel.channel_id, "claude_hook"))
        .sort((left, right) => left.item.at < right.item.at ? -1 : left.item.at > right.item.at ? 1 : 0);
      if (claimed.length) {
        await emitClaimed(claimed, "claude_hook", texts => emit(texts.join("\n\n")));
        return 2;
      }
      if (Date.now() >= deadline) {
        const notice = profile.channels?.claude_expiry_notice;
        if (!notice) return 0;
        await emit(notice);
        return 2;
      }
      await delay(options.poll_ms ?? 250);
    }
  } finally {
    releaseWaiter(index, identity);
  }
}

/** Claude CodeのSessionEndで、その会話のchannelを閉じる。未取得の本文は残る。 */
export function closeClaudeSessionChannels(profile: ProductProfile, input: unknown): void {
  const { session_id } = z.object({ session_id: z.uuid() }).loose().parse(input);
  for (const channel of openClaudeChannels(profile, session_id)) closeChannel(profile, channel.channel_id, "session_end");
}

// ---- Cursor ----

const CHANNEL_LINE = /^steer_channel=([0-9a-f-]{36})$/i;

/** tool結果（structuredContentのsteer_channel.channel_id、または本文の`steer_channel=<uuid>`行）からchannel IDを読む。 */
export function channelIdFromResult(value: unknown, depth = 0): string | null {
  if (depth > 3 || value === null || value === undefined) return null;
  let parsed: unknown = value;
  if (typeof value === "string") { try { parsed = JSON.parse(value); } catch { parsed = null; } }
  if (parsed !== null && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const structured = record.structuredContent;
    const carrier = structured !== null && typeof structured === "object" ? structured as Record<string, unknown> : record;
    const marker = carrier.steer_channel;
    if (marker !== null && typeof marker === "object") {
      const id = (marker as { channel_id?: unknown }).channel_id;
      if (typeof id === "string" && uuid.safeParse(id).success) return id;
    }
    if (depth === 0 && Array.isArray(record.content)) {
      for (const entry of record.content) {
        const text = entry !== null && typeof entry === "object" ? (entry as { text?: unknown }).text : undefined;
        if (typeof text === "string") {
          const id = channelIdFromResult(text, depth + 1);
          if (id) return id;
        }
      }
    }
  }
  if (typeof value === "string") {
    for (const line of value.split("\n")) {
      const match = CHANNEL_LINE.exec(line.trim());
      if (match && uuid.safeParse(match[1]).success) return match[1];
    }
  }
  return null;
}

/** tool結果へ載せる印。CursorのhookはこれでchannelをCursorの実際の会話へ結ぶ。 */
export function channelMarker(channel: Channel): { structured: { steer_channel: { channel_id: string } }; text: string } {
  return { structured: { steer_channel: { channel_id: channel.channel_id } }, text: `steer_channel=${channel.channel_id}` };
}

function conversationId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return null;
  if (value.includes("/") || value.includes("\\") || value.includes("..")) return null;
  return value;
}

/**
 * Cursorの公式hook（afterMCPExecution・postToolUse・postToolUseFailure）から呼ぶ。
 * dispatch toolの結果にあるchannelをその会話へ結び、tool返りのhookでは結ばれたchannelの本文を差し込み用に返す。
 */
export async function handleCursorChannelHook(profile: ProductProfile, event: Record<string, unknown>,
  emit: (text: string) => Promise<void> | void): Promise<boolean> {
  const name = event.hook_event_name;
  if (name !== "afterMCPExecution" && name !== "postToolUse" && name !== "postToolUseFailure") return false;
  const conv = conversationId(event.conversation_id);
  if (!conv) return false;
  const payload = name === "afterMCPExecution" ? event.result_json : event.tool_output;
  const bound = channelIdFromResult(payload);
  const conversations = path.join(channelRoot(profile), "cursor-conversations");
  if (bound && fs.existsSync(channelDir(profile, bound))) {
    const channel = readChannel(profile, bound);
    if (channel.kind === "cursor") {
      const bindFile = path.join(channelDir(profile, bound), "bind.json");
      if (!fs.existsSync(bindFile)) writeJson0600(bindFile, { conversation_id: conv, at: new Date().toISOString() });
      const bindConv = JSON.parse(fs.readFileSync(bindFile, "utf8")).conversation_id;
      if (bindConv === conv) {
        mkdirs(path.join(conversations, conv));
        fs.writeFileSync(path.join(conversations, conv, bound), "", { mode: 0o600 });
      }
    }
  }
  if (name === "afterMCPExecution") return false;
  const index = path.join(conversations, conv);
  if (!fs.existsSync(index)) return false;
  const claimed = fs.readdirSync(index).filter(id => uuid.safeParse(id).success && !channelClosed(profile, id))
    .flatMap(id => claimPending(profile, id, "cursor_hook"));
  if (!claimed.length) return false;
  await emitClaimed(claimed, "cursor_hook", texts => emit(texts.join("\n\n")));
  return true;
}

// ---- 背景受信（Cursorのidle時、Grok等） ----

/** 親の背景process APIへそのまま渡す起動情報。scriptは製品のchannel受信入口の絶対path。 */
export function channelReceiveProcess(script: string, channelId: string, executable = process.execPath): WaitProcess {
  const args = [script, "--channel", uuid.parse(channelId)];
  return { executable, args, windows_start_process_argument_list: process.platform === "win32" ? windowsStartProcessArgumentList(args) : null };
}

export type ChannelReceiveResult =
  | { outcome: "delivered"; channel_id: string; deliveries: { delivery_id: string; text: string }[] }
  | { outcome: "timeout" | "closed"; channel_id: string };

/**
 * 次に届いた本文を受け取って終わる。受け取った本文はこの時点でemittedになる（出力は呼び出し側が行う）。
 * hookが先に差し込んだ本文は飛ばして、その次を待つ。
 */
export async function receiveFromChannel(profile: ProductProfile, channelId: string,
  options: { wait_ms?: number; poll_ms?: number; emit?: (result: ChannelReceiveResult) => Promise<void> | void } = {}): Promise<ChannelReceiveResult> {
  readChannel(profile, channelId);
  const deadline = Date.now() + (options.wait_ms ?? 86_400_000);
  const emit = options.emit ?? (() => undefined);
  for (;;) {
    if (channelClosed(profile, channelId)) {
      const result: ChannelReceiveResult = { outcome: "closed", channel_id: channelId };
      await emit(result);
      return result;
    }
    const claimed = claimPending(profile, channelId, "receiver");
    if (claimed.length) {
      const result: ChannelReceiveResult = { outcome: "delivered", channel_id: channelId,
        deliveries: claimed.map(entry => ({ delivery_id: entry.item.delivery_id, text: entry.item.text })) };
      await emitClaimed(claimed, "receiver", () => emit(result));
      return result;
    }
    if (Date.now() >= deadline) {
      const result: ChannelReceiveResult = { outcome: "timeout", channel_id: channelId };
      await emit(result);
      return result;
    }
    await delay(options.poll_ms ?? 250);
  }
}

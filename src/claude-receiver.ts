// Claude Codeの公式hookを受信口にする。待機processはharnessが所有し、親のturnを止めない。
// PreToolUseが実際の会話（session_id）と親process（hookを起動したClaude Code）を記録し、MCP要求のtoolUseIdと結ぶ。
// PostToolUseのasyncRewake hookが本文の到着を待ち、stderrへ出してexit 2で親を起こす（作業中ならそのturnへ入る）。
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { waitForFileState, writeJson0600 } from "./files.js";
import { hookOwnerProcess, readRuntimeProcesses, type RuntimeProcess } from "./process.js";
import { ClaudeDeliveryError } from "./errors.js";
import type { ProductProfile } from "./profile.js";

const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const invocationSchema = z.object({
  request_id: requestId, session_id: z.uuid(), agent_id: z.string().nullable(),
  parent_pid: z.number().int().positive(), parent_started_identity: z.string(),
}).strict();
type Invocation = z.infer<typeof invocationSchema>;

export const claudeParentSchema = z.object({
  kind: z.literal("claude"), request_id: requestId, session_id: z.uuid(), hook_root: z.string(),
}).strict();
export type ClaudeParent = z.infer<typeof claudeParentSchema>;

function processIdentity(pid: number): string | undefined { return readRuntimeProcesses().find(entry => entry.pid === pid)?.started_identity; }
function directory(parent: ClaudeParent): string { return path.join(parent.hook_root, parent.request_id); }
function readInvocation(profile: ProductProfile, parent: ClaudeParent): Invocation {
  let value: Invocation;
  try { value = invocationSchema.parse(JSON.parse(fs.readFileSync(path.join(directory(parent), "request.json"), "utf8"))); }
  catch { throw new ClaudeDeliveryError("CLAUDE_PARENT_HOOK_UNAVAILABLE", `親のhook記録がありません。${profile.setup_command}を実行し、Claude Codeのhookを有効にしてください`); }
  if (value.request_id !== parent.request_id || value.session_id !== parent.session_id) {
    throw new ClaudeDeliveryError("CLAUDE_PARENT_SESSION_MISMATCH", "要求とhookの会話が一致しません");
  }
  return value;
}

function assertOpen(parent: ClaudeParent): void {
  if (fs.existsSync(path.join(directory(parent), "closed.json"))) {
    throw new ClaudeDeliveryError("CLAUDE_PARENT_SESSION_CLOSED", "依頼元の会話は終了しました。回答を別の会話へ送っていません");
  }
}

export function prepareClaudeHookRequest(input: unknown, root: string): void {
  const event = z.object({ session_id: z.uuid(), tool_use_id: requestId, agent_id: z.string().optional() }).parse(input);
  // shellを通す形のhookでは、直接の親はshellになる。shellはこのhookと一緒に終わるので、その先のClaude processを記録する。
  const rows = readRuntimeProcesses();
  const owner = hookOwnerProcess(rows, process.ppid);
  if (!owner) throw new ClaudeDeliveryError("CLAUDE_PARENT_PROCESS_UNAVAILABLE", "hookを起動した親processを確認できません");
  const dir = path.join(root, event.tool_use_id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeJson0600(path.join(dir, "request.json"), {
    request_id: event.tool_use_id, session_id: event.session_id, agent_id: event.agent_id ?? null,
    parent_pid: owner.pid, parent_started_identity: owner.started_identity,
  } satisfies Invocation);
  // 記録を置いた後に見回る。process表は上で読んだものを使う。見回りの失敗で依頼を止めない。
  try { sweepClaudeHookRequests(root, rows); } catch { /* 次の依頼でまた見回る */ }
}

// 届いた依頼の置き場は送り手が消す。見回りが消すのは、届かないまま残った分。
const STALE_REQUEST_MS = 24 * 60 * 60 * 1000;
const REQUEST_FILES = new Set(["request.json", "delivery.json", "answer.json", "hook.json", "sending.json", "emitted.json", "failed.json", "closed.json"]);

/**
 * 届かないまま残った依頼の置き場を消し、消した数を返す。誤りで返った呼び出しや打ち切られた呼び出しはPostToolUseが走らず、
 * 置き場が残る。Windowsの一時置き場は再起動でも消えない。
 * 消すのは、最後に書かれてから1日たち、待っている配送が無い置き場だけ。依頼元のClaude processが居て、配送を結んであり、
 * まだ出し終えていない置き場は、何日たっても残す（子が長く動いている配送）。1日は、届かなかった時に原因を調べる間。
 */
export function sweepClaudeHookRequests(root: string, rows: readonly RuntimeProcess[], now: number = Date.now()): number {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      if (now - fs.statSync(dir).mtimeMs < STALE_REQUEST_MS) continue;
      const names = fs.readdirSync(dir);
      // この製品の依頼の置き場に見えない物には触れない。
      if (!names.every(name => REQUEST_FILES.has(name) || name.endsWith(".tmp"))) continue;
      if (names.some(name => now - fs.statSync(path.join(dir, name)).mtimeMs < STALE_REQUEST_MS)) continue;
      if (names.includes("delivery.json") && !names.includes("emitted.json")) {
        // 依頼元を読めない置き場には、もう誰も届けられない。
        let invocation: Invocation | undefined;
        try { invocation = invocationSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, "request.json"), "utf8"))); } catch { /* 消す */ }
        if (invocation && rows.find(row => row.pid === invocation.parent_pid)?.started_identity === invocation.parent_started_identity) continue;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch { /* 読めない・消せない置き場は次の見回りへ回す */ }
  }
  return removed;
}

/** 起動時envのsession IDは/clearで古くなるため、実際のPreToolUseとの相関だけを使う。 */
export function claudeParentFromRequest(profile: ProductProfile, clientName: string | undefined, metadata: unknown, root: string): ClaudeParent | null {
  if (clientName !== "claude-code") return null;
  const parsed = requestId.safeParse((metadata as Record<string, unknown> | undefined)?.["claudecode/toolUseId"]);
  if (!parsed.success) throw new ClaudeDeliveryError("CLAUDE_PARENT_ID_UNAVAILABLE", "MCP要求にtoolUseIdがありません。対応するClaude Codeへ更新してください");
  let invocation: Invocation;
  try { invocation = invocationSchema.parse(JSON.parse(fs.readFileSync(path.join(root, parsed.data, "request.json"), "utf8"))); }
  catch { throw new ClaudeDeliveryError("CLAUDE_PARENT_HOOK_UNAVAILABLE", `親のPreToolUse hookを確認できません。${profile.setup_command}を実行し、hookを有効にしてください`); }
  const parent: ClaudeParent = { kind: "claude", request_id: parsed.data, session_id: invocation.session_id, hook_root: root };
  verifyClaudeParent(profile, parent);
  return parent;
}

export function verifyClaudeParent(profile: ProductProfile, parent: ClaudeParent): void {
  const invocation = readInvocation(profile, parent);
  if (invocation.agent_id) throw new ClaudeDeliveryError("CLAUDE_PARENT_SUBAGENT_UNSUPPORTED", "agent_id付きのClaude会話（--agent起動またはnative subagent）への自動配送には対応していません");
  assertOpen(parent);
}

export function bindClaudeParentDelivery(profile: ProductProfile, parent: ClaudeParent, deliveryId: string): void {
  verifyClaudeParent(profile, parent);
  writeJson0600(path.join(directory(parent), "delivery.json"), { delivery_id: z.uuid().parse(deliveryId) });
}

/** SessionEndはその時点の依頼だけを終了する。同じ会話をresumeした新規依頼は別requestになる。 */
export function closeClaudeParentSession(input: unknown, root: string): void {
  const { session_id } = z.object({ session_id: z.uuid() }).parse(input);
  if (!fs.existsSync(root)) return;
  let failure: unknown;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // 読めない記録（形の違う古い残り、送り手や見回りが消している途中の置き場）は飛ばす。1つで止まると、この会話の残りの依頼を閉じられない。
    let invocation: Invocation;
    try { invocation = invocationSchema.parse(JSON.parse(fs.readFileSync(path.join(root, entry.name, "request.json"), "utf8"))); }
    catch { continue; }
    if (invocation.session_id !== session_id) continue;
    try { writeJson0600(path.join(root, entry.name, "closed.json"), { session_id }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure ??= error; }
  }
  if (failure) throw failure;
}

function assertParentAlive(invocation: Invocation): void {
  if (processIdentity(invocation.parent_pid) !== invocation.parent_started_identity) {
    throw new ClaudeDeliveryError("CLAUDE_PARENT_PROCESS_CLOSED", "依頼元のClaude processは終了しました。回答は保存したままです");
  }
}

export async function submitClaudeParentAnswer(
  profile: ProductProfile, parent: ClaudeParent, deliveryId: string, text: string,
  runtime: { processes: () => RuntimeProcess[] } = { processes: readRuntimeProcesses },
): Promise<{ queued_submission_id: null }> {
  const invocation = readInvocation(profile, parent);
  const dir = directory(parent);
  // 会話終了でも確定本文を失わない。終了判定より先に保存する。
  writeJson0600(path.join(dir, "answer.json"), { delivery_id: deliveryId, text });
  const emitted = () => {
    const file = path.join(dir, "emitted.json");
    if (!fs.existsSync(file)) return false;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value.delivery_id !== deliveryId) throw new ClaudeDeliveryError("CLAUDE_PARENT_DELIVERY_MISMATCH", "hookの配送IDが一致しません", true);
    return true;
  };
  await waitForFileState(dir, () => {
    if (emitted()) return true;
    assertOpen(parent);
    const failed = path.join(dir, "failed.json");
    if (fs.existsSync(failed)) {
      const value = JSON.parse(fs.readFileSync(failed, "utf8"));
      throw new ClaudeDeliveryError("CLAUDE_PARENT_HOOK_FAILED", "親へのhook出力が失敗しました。回答は保存したままです", value.outcome_unknown === true);
    }
    const rows = runtime.processes();
    const alive = (pid: number, identity: string) => rows.find(entry => entry.pid === pid)?.started_identity === identity;
    let gone: ClaudeDeliveryError | undefined;
    const hookFile = path.join(dir, "hook.json");
    if (fs.existsSync(hookFile)) {
      const hook = z.object({ pid: z.number().int().positive(), started_identity: z.string() }).parse(JSON.parse(fs.readFileSync(hookFile, "utf8")));
      if (!alive(hook.pid, hook.started_identity)) {
        gone = new ClaudeDeliveryError("CLAUDE_PARENT_HOOK_CLOSED", "親の受信hookが終了しました。自動再送はしていません", fs.existsSync(path.join(dir, "sending.json")));
      }
    }
    if (!gone && !alive(invocation.parent_pid, invocation.parent_started_identity)) {
      gone = new ClaudeDeliveryError("CLAUDE_PARENT_PROCESS_CLOSED", "依頼元のClaude processは終了しました。回答は保存したままです");
    }
    if (!gone) return undefined;
    // process表を読む間（Windowsは約1秒）に、hookが本文を出し終えて終わる事がある。「居ない」と読んだ後に、出し終えた記録を見直す。
    if (emitted()) return true;
    throw gone;
  });
  // 届いた依頼の置き場を読む物は、もう無い。届かなかった時は消さず、原因を調べる材料として残す。
  // 片付けの失敗を配送の失敗にしない（消せなかった置き場は、後の見回りが消す）。
  try { await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* 見回りへ回す */ }
  return { queued_submission_id: null };
}

export async function runClaudeResultHook(profile: ProductProfile, input: unknown, emit: (text: string) => void | Promise<void>, root: string): Promise<0 | 2> {
  const event = z.object({ session_id: z.uuid(), tool_use_id: requestId }).parse(input);
  const parent: ClaudeParent = { kind: "claude", request_id: event.tool_use_id, session_id: event.session_id, hook_root: root };
  const invocation = readInvocation(profile, parent);
  const dir = directory(parent);
  const binding = path.join(dir, "delivery.json");
  if (!fs.existsSync(binding)) {
    fs.rmSync(dir, { recursive: true });
    return 0;
  }
  const deliveryId = z.uuid().parse(JSON.parse(fs.readFileSync(binding, "utf8")).delivery_id);
  const identity = processIdentity(process.pid);
  if (!identity) throw new ClaudeDeliveryError("CLAUDE_PARENT_HOOK_UNAVAILABLE", "受信hookのprocessを確認できません");
  writeJson0600(path.join(dir, "hook.json"), { pid: process.pid, started_identity: identity });
  try {
  const answer = await waitForFileState(dir, () => {
    if (fs.existsSync(path.join(dir, "closed.json"))) return null;
    assertParentAlive(invocation);
    const file = path.join(dir, "answer.json");
    if (!fs.existsSync(file)) return undefined;
    const value = z.object({ delivery_id: z.uuid(), text: z.string() }).strict().parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (value.delivery_id !== deliveryId) throw new ClaudeDeliveryError("CLAUDE_PARENT_DELIVERY_MISMATCH", "保存された回答の配送IDが一致しません");
    return value;
  });
  if (!answer) return 0;
  assertOpen(parent);
  writeJson0600(path.join(dir, "sending.json"), { delivery_id: deliveryId });
  await emit(answer.text);
  writeJson0600(path.join(dir, "emitted.json"), { delivery_id: deliveryId });
  // Claudeが定めるasyncRewakeの再開信号。子の成功/失敗は本文のoutcomeで区別する。
  return 2;
  } catch (error) {
    writeJson0600(path.join(dir, "failed.json"), { outcome_unknown: fs.existsSync(path.join(dir, "sending.json")) });
    throw error;
  }
}

// Codex親への配送。公式App Serverのキュー（thread/queue/add）へ一度だけ入れる。
// 親が作業中なら製品の同期hook（PostToolUse／Stop）が同じturnへ取り込み、idleなら公式キューが通常の入力として届ける。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import * as path from "node:path";
import { CodexDeliveryError } from "./errors.js";
import { codexHookDirectory, type ProductProfile } from "./profile.js";
import { currentCodexDesktopBinary, realCodexHome, resolveCodexExecutable } from "./codex-binary.js";
import { finishCodexHookSubmission, assertCodexHookParentCurrent, assertCodexHooksReady, readCodexHookConfig, registerCodexHookInput } from "./codex-hook-state.js";

export interface CodexParent {
  thread_id: string;
  codex_home: string;
}

/** modelの引数ではなく、CodexがMCP要求へ付けるmetadataだけを宛先にする。 */
export function codexParentFromRequest(clientName: string | undefined, metadata: unknown): CodexParent | null {
  if (clientName !== "codex-mcp-client") return null;
  const threadId = (metadata as { threadId?: unknown } | undefined)?.threadId;
  if (typeof threadId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) {
    throw new CodexDeliveryError("CODEX_PARENT_ID_UNAVAILABLE", "MCP要求に親のthreadIdがありません。対応するCodexへ更新してください");
  }
  return { thread_id: threadId, codex_home: path.resolve(realCodexHome()) };
}

// testは実process境界をfixtureへ差し替える。MCPの公開パラメータには出さない。
export interface CodexReceiverRuntime {
  executable?: string;
  args?: string[];
  timeout_ms?: number;
  hook_directory?: string;
}

type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
};

export async function withCodexReceiver<T>(
  profile: ProductProfile,
  parent: CodexParent,
  action: (request: (method: string, params: unknown) => Promise<any>) => Promise<T>,
  runtime: CodexReceiverRuntime = {},
): Promise<T> {
  const config = runtime.executable ? null : readCodexHookConfig(profile);
  const executable = runtime.executable ?? (config?.enabled ? await currentCodexDesktopBinary(profile, config) : null) ?? resolveCodexExecutable();
  if (!executable) throw new CodexDeliveryError("CODEX_RECEIVER_UNAVAILABLE", "Codexの実行ファイルを確認できません");
  const child = spawn(executable, runtime.args ?? ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, CODEX_HOME: parent.codex_home },
    windowsHide: true,
  });
  const pending = new Map<number, Pending>();
  let sequence = 0;
  let stopped = false;
  let transportError: string | null = null;
  const failTransport = (message: string) => {
    transportError = message;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new CodexDeliveryError("CODEX_RECEIVER_TRANSPORT_FAILED", message, item.method === "thread/queue/add"));
    }
    pending.clear();
  };
  child.on("error", (error: NodeJS.ErrnoException) => failTransport(`Codexを起動できません（${error.code ?? "unknown"}）`));
  child.stdin.on("error", (error: NodeJS.ErrnoException) => failTransport(`Codexへの書込みに失敗しました（${error.code ?? "unknown"}）`));
  const exited = new Promise<void>((resolve) => child.once("close", (code, signal) => {
    if (!stopped) failTransport(`Codexの接続が終了しました（exit=${code}, signal=${signal}）`);
    resolve();
  }));
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    let value: any;
    try { value = JSON.parse(line); } catch {
      failTransport("Codexが不正なJSON応答を返しました");
      return;
    }
    const item = pending.get(value?.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(value.id);
    if (value.error) {
      item.reject(new CodexDeliveryError("CODEX_RECEIVER_REJECTED", typeof value.error.message === "string" ? value.error.message : "公式受信口が要求を拒否しました"));
    } else if ("result" in value) item.resolve(value.result);
    else item.reject(new CodexDeliveryError("CODEX_RECEIVER_INVALID_RESPONSE", "公式受信口の応答にresultがありません", item.method === "thread/queue/add"));
  });
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    if (transportError) {
      reject(new CodexDeliveryError("CODEX_RECEIVER_TRANSPORT_FAILED", transportError));
      return;
    }
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new CodexDeliveryError("CODEX_RECEIVER_TIMEOUT", `${method}の応答を確認できません`, method === "thread/queue/add"));
    }, runtime.timeout_ms ?? 15_000);
    pending.set(id, { resolve, reject, timer, method });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  try {
    await request("initialize", { clientInfo: { name: profile.codex_client_name, version: "1" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    return await action(request);
  } finally {
    stopped = true;
    for (const item of pending.values()) clearTimeout(item.timer);
    pending.clear();
    child.stdin.end();
    // stdio終了を公式processへ伝える。終了しない外部processだけを明示的に停止する。
    const terminate = setTimeout(() => child.kill("SIGKILL"), 2_000);
    await exited;
    clearTimeout(terminate);
    reader.close();
  }
}

export interface CodexParentThread { thread_id: string; cwd: string | null; source: unknown }

/** 送る前に、同じstoreの宛先と公式キューの対応を確認する。本文は保存・表示しない。確認したthreadのcwdとsourceを返す。 */
export async function verifyCodexParent(profile: ProductProfile, parent: CodexParent, runtime?: CodexReceiverRuntime): Promise<CodexParentThread> {
  return await withCodexReceiver(profile, parent, async (request) => {
    const response = await request("thread/read", { threadId: parent.thread_id, includeTurns: false });
    if (response?.thread?.id !== parent.thread_id) {
      throw new CodexDeliveryError("CODEX_PARENT_UNAVAILABLE", "同じCodex環境で親threadを確認できません");
    }
    const subagent = response.thread.source?.subAgent;
    if (subagent && typeof subagent === "object" && "thread_spawn" in subagent) {
      throw new CodexDeliveryError("CODEX_PARENT_UNSUPPORTED", "Codexのnative sub-agentは外部processからのキュー入力を受け付けません");
    }
    await request("thread/queue/list", { threadId: parent.thread_id, limit: 1 });
    const config = runtime ? (runtime.hook_directory ? readCodexHookConfig(profile, runtime.hook_directory) : null) : readCodexHookConfig(profile);
    if (config?.enabled) {
      assertCodexHookParentCurrent(profile, config);
      assertCodexHooksReady(profile, await request("hooks/list", { cwds: [response.thread.cwd] }), config.command, path.join(parent.codex_home, "hooks.json"));
    }
    return { thread_id: parent.thread_id, cwd: typeof response.thread.cwd === "string" ? response.thread.cwd : null, source: response.thread.source ?? null };
  }, runtime);
}

/** 確定した本文を公式キューへ一度だけ入れる。受付IDを返す。受付の成否が不明な失敗はoutcome_unknownで区別する。 */
export async function submitCodexParentAnswer(
  profile: ProductProfile,
  parent: CodexParent,
  deliveryId: string,
  text: string,
  runtime?: CodexReceiverRuntime,
): Promise<{ queued_submission_id: string | null }> {
  const root = runtime ? runtime.hook_directory : codexHookDirectory(profile);
  const hook = root && readCodexHookConfig(profile, root)?.enabled;
  if (hook) registerCodexHookInput(parent.codex_home, parent.thread_id, deliveryId, text, root);
  try { return await withCodexReceiver(profile, parent, async (request) => {
    const result = await request("thread/queue/add", {
      threadId: parent.thread_id,
      input: [{ type: "text", text, text_elements: [] }],
      clientUserMessageId: deliveryId,
    });
    if (typeof result?.queuedSubmission?.id !== "string") {
      throw new CodexDeliveryError("CODEX_RECEIVER_INVALID_RESPONSE", "キューの受付IDを確認できません", true);
    }
    return { queued_submission_id: result.queuedSubmission.id };
  }, runtime); }
  finally { if (hook) finishCodexHookSubmission(parent.codex_home, parent.thread_id, deliveryId, root); }
}

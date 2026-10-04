// 配送記録の読み書き。途中までのJSONを残さないよう、一時ファイルからrenameで置き換える。
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

/** WindowsのCursorはhookのstdinのJSONの先頭にBOM（U+FEFF）を付ける。JSONとして読む前に落とす。 */
export function withoutBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function writeJson0600(p: string, v: unknown): void {
  // truncate-in-place はクラッシュ/ENOSPC の窓で空・途中 JSON を残すので、temp→rename の原子的置換にする
  const tmp = `${p}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* noop */
  }
  try {
    fs.renameSync(tmp, p);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* noop */
    }
    throw e;
  }
}

export function writeHookJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

/** directory内の状態変化を待つ。inspectが値を返した時点でresolveする。timeoutMsを省くと期限なし。
 * signalがabortされると WAIT_FOR_FILE_ABORTED でrejectする。 */
export function waitForFileState<T>(dir: string, inspect: () => T | undefined, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    const watcher = fs.watch(dir, () => check());
    const finish = (error: unknown, value?: T) => {
      if (finished) return;
      finished = true;
      watcher.close();
      if (timer) clearInterval(timer);
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value as T);
    };
    const abort = () => finish(new Error("WAIT_FOR_FILE_ABORTED"));
    const check = () => {
      if (finished) return;
      try {
        const value = inspect();
        if (value !== undefined) finish(null, value);
      } catch (error) { finish(error); }
    };
    watcher.on("error", error => finish(error));
    timer = setInterval(check, 5000);
    if (timeoutMs !== undefined) timeout = setTimeout(() => finish(new Error("WAIT_FOR_FILE_TIMEOUT")), timeoutMs);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    check();
  });
}

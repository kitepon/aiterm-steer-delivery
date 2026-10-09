#!/usr/bin/env node
// Node以外の製品（Python等）がsteer配送を使うための入口。結果はstdoutへ1行のJSONで返す。
// 製品の識別情報はJSONファイル（--profile）で渡す。state_root・config_rootは絶対pathの文字列にする。
//
//   aiterm-steer-delivery --profile <file> codex parent --client <name> --meta <json>
//   aiterm-steer-delivery --profile <file> codex verify --thread <uuid> [--codex-home <dir>]   → thread{thread_id,cwd,source}
//   aiterm-steer-delivery --profile <file> codex submit --thread <uuid> --delivery <uuid> --text-file <file|-> [--codex-home <dir>]
//   aiterm-steer-delivery --profile <file> codex state  --thread <uuid> --delivery <uuid> [--codex-home <dir>]   → state と、見張りが終わっていれば wake（寝ている会話を起こした結果）
//   aiterm-steer-delivery --profile <file> codex wake   --thread <uuid> --delivery <uuid> [--delay-ms <n>] [--codex-home <dir>]   → wake（今すぐ見直して、寝ていれば起こす）
//   aiterm-steer-delivery --profile <file> codex setup <enable|disable|status>
//
// codex setupは、Codexのhookから起動する入口（codex-hook.js）と製品の識別情報をhook directoryへ置いて登録する。
// 失敗は {ok:false, code, message, outcome_unknown} を返し、exit 1。
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ProductProfile } from "./profile.js";
import { codexHookDirectory } from "./profile.js";
import { realCodexHome } from "./codex-binary.js";
import { codexParentFromRequest, submitCodexParentAnswer, verifyCodexParent, type CodexParent } from "./codex-receiver.js";
import { codexHookDeliveryState } from "./codex-hook-state.js";
import { readCodexWakeResult, wakeCodexParentIfAsleep } from "./codex-wake.js";
import { configureCodexSteer } from "./codex-setup.js";
import { isDirectExecution } from "./hook-main.js";

const profileFileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/), display_name: z.string().min(1), setup_command: z.string().min(1),
  codex_steer_command: z.string().min(1), mcp_server: z.string().min(1), dispatch_tools: z.array(z.string().min(1)),
  state_root: z.string().refine(value => path.isAbsolute(value)), config_root: z.string().refine(value => path.isAbsolute(value)),
  hooks: z.object({ codex: z.string().min(1), claude: z.string().min(1), cursor: z.string().min(1) }).strict(),
  codex_client_name: z.string().min(1), codex_hook_schema: z.string().min(1), backup_suffix: z.string().min(1),
}).strict();

export function loadProfile(file: string): ProductProfile {
  const value = profileFileSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  return { ...value, state_root: () => value.state_root, config_root: () => value.config_root };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function required(args: string[], name: string): string {
  const value = option(args, name);
  if (value === undefined) throw Object.assign(new Error(`${name} がありません`), { delivery_code: "CLI_USAGE" });
  return value;
}
function parent(args: string[]): CodexParent {
  return { thread_id: z.uuid().parse(required(args, "--thread")), codex_home: path.resolve(option(args, "--codex-home") ?? realCodexHome()) };
}
async function readText(source: string): Promise<string> {
  if (source !== "-") return fs.readFileSync(source, "utf8");
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

export async function runCli(argv: string[]): Promise<unknown> {
  const profilePath = required(argv, "--profile");
  const profile = loadProfile(profilePath);
  const rest = argv.filter((_, index) => index !== argv.indexOf("--profile") && index !== argv.indexOf("--profile") + 1);
  const [kind, command, ...args] = rest;
  if (kind !== "codex") throw Object.assign(new Error("対応するのは codex だけです"), { delivery_code: "CLI_USAGE" });
  switch (command) {
    case "parent": return { parent: codexParentFromRequest(required(args, "--client"), JSON.parse(option(args, "--meta") ?? "null")) };
    case "verify": return { verified: true, thread: await verifyCodexParent(profile, parent(args)) };
    case "submit": {
      const target = parent(args);
      const text = await readText(required(args, "--text-file"));
      return await submitCodexParentAnswer(profile, target, z.uuid().parse(required(args, "--delivery")), text);
    }
    case "state": {
      const target = parent(args);
      const delivery = z.uuid().parse(required(args, "--delivery"));
      const wake = readCodexWakeResult(profile, delivery);
      return { state: codexHookDeliveryState(target.codex_home, target.thread_id, delivery, codexHookDirectory(profile)), ...(wake ? { wake } : {}) };
    }
    case "wake": {
      const delay = option(args, "--delay-ms");
      return { wake: await wakeCodexParentIfAsleep(profile, parent(args), z.uuid().parse(required(args, "--delivery")),
        { delay_ms: delay === undefined ? 0 : z.coerce.number().int().min(0).parse(delay) }) };
    }
    case "setup": {
      const action = z.enum(["enable", "disable", "status"]).parse(args[0] ?? "status");
      // Codexのhookが起動する入口は、hook directoryにある識別情報を読む。
      const directory = codexHookDirectory(profile);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.copyFileSync(profilePath, path.join(directory, "profile.json"));
      return await configureCodexSteer(profile, action, { hook: fileURLToPath(new URL("./codex-hook.js", import.meta.url)) });
    }
    default: throw Object.assign(new Error(`未対応のcommandです: ${command}`), { delivery_code: "CLI_USAGE" });
  }
}

if (isDirectExecution(import.meta.url)) {
  try {
    process.stdout.write(JSON.stringify({ ok: true, ...(await runCli(process.argv.slice(2)) as object) }) + "\n");
  } catch (error) {
    const value = error as { delivery_code?: string; code?: unknown; outcome_unknown?: boolean; message?: string };
    process.stdout.write(JSON.stringify({ ok: false, code: value.delivery_code ?? (typeof value.code === "string" ? value.code : "CLI_FAILED"),
      message: value.message ?? String(error), outcome_unknown: value.outcome_unknown === true }) + "\n");
    process.exitCode = 1;
  }
}

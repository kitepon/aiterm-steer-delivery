# aiterm-steer-delivery

[![CI](https://github.com/kitepon/aiterm-steer-delivery/actions/workflows/ci.yml/badge.svg)](https://github.com/kitepon/aiterm-steer-delivery/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/aiterm-steer-delivery.svg)](https://www.npmjs.com/package/aiterm-steer-delivery)
[![node](https://img.shields.io/node/v/aiterm-steer-delivery)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Let your MCP server talk back to the AI session that called it.**

[日本語版 README](README.ja.md)

Your MCP server can deliver text to the **parent AI session that called its tool**, even after the tool call has returned:

- if the parent is busy, the text is steered into its running turn;
- if the parent is idle, it arrives in the same conversation as a normal new turn.

Works with Codex, Claude Code, and Cursor. Other clients (Grok and so on) receive through a background process. Linux, macOS, and Windows.

## Why

If you run many AI sessions at once, the useful work often happens between them: a sub-agent finishes and its parent should hear about it, or one session posts in a shared room and another should react. A tool call returns once. Anything that happens later has nowhere to go unless the parent comes back and asks.

Delivering that later text to the right conversation is the hard part:

- **Which conversation?** Each client identifies the calling conversation differently, and some only through their hooks. Values that look usable, such as a session id in the environment, go stale after `/clear`.
- **How does text get in?** Each client has its own official mechanism (a queue, async hooks, hook output, a background process), with its own setup and its own failure modes.
- **OS quirks.** Process identity, shells, PowerShell quoting, BOMs in hook input, different `CODEX_HOME`s on the same machine.

This package is the delivery [Aiterm](https://github.com/kitepon/aiterm-mcp) uses to hand a sub-agent's answer back to its parent. It was extracted from Aiterm without changing behavior, so other products do not have to rebuild conversation correlation, hook registration, and OS handling every time.

## Used by

| Product | What it delivers |
| --- | --- |
| [Aiterm](https://github.com/kitepon/aiterm-mcp) | A sub-agent's final answer, back to the session that launched it |
| [Peertable](https://github.com/kitepon/peertable) | Room messages and direct messages, to the owner's own session sitting beside the table |
| [gpt-connector](https://github.com/kitepon/gpt-connector) | A ChatGPT reply, back into the Codex thread that asked for it |

## How it works

| Parent | How the parent is identified | How text arrives |
| --- | --- | --- |
| Codex | `_meta.threadId` of the MCP request | Official App Server queue (`thread/queue/add`). With Steer enabled, your sync `PostToolUse`/`Stop` hooks pull it into the running turn; otherwise the official queue delivers it at the next turn boundary. A conversation the Codex app has put to sleep is woken by asking the app to open it (see [Sleeping Codex conversations](#sleeping-codex-conversations)). |
| Claude Code | Your `PreToolUse` hook record + `_meta["claudecode/toolUseId"]` | An `asyncRewake` hook writes the text to stderr and exits 2, waking the session (or steering into the running turn). |
| Cursor (Desktop and CLI) | Your hook binds the id in your tool result to the real `conversation_id` | `additional_context` on the next tool return while busy; a background receiver process while idle. |
| Others (Grok, …) | — | A background receiver process (`wait_process`). |

Every route uses the client's official mechanism. Nothing types into a terminal or patches the client.

**Delivery never auto-retries a send whose outcome is unknown.** If the library cannot confirm whether text reached the parent, it reports `outcome_unknown` (or the channel state `unknown`) and leaves the decision to you, so the parent never gets the same message twice by accident.

## Install

```sh
npm install aiterm-steer-delivery
```

Requirements:

- Node.js 18 or later. ESM only. The only runtime dependency is `zod`.
- Codex Steer (delivery into a running Codex turn) uses the Codex Desktop's bundled CLI when present (macOS, Windows, Linux), and otherwise the regular Codex CLI 0.154 or later.
- On Windows, Codex Steer hooks run through PowerShell 7 (`pwsh.exe`).

## Quick start

### 1. Write a product profile

Everything product-specific lives in one object. The delivery mechanism is the same for every product.

```js
// profile.mjs
export const PROFILE = {
  id: "peertable", display_name: "Peertable",
  setup_command: "peertable parent connect", codex_steer_command: "peertable parent connect --target codex",
  mcp_server: "peertable_parent", dispatch_tools: ["parent_join", "parent_leave"],
  state_root: () => stateDir, config_root: () => configDir,
  hooks: { codex: "peertable-parent-codex-hook.mjs", claude: "peertable-parent-claude-hook.mjs", cursor: "peertable-parent-cursor-hook.mjs" },
  codex_client_name: "peertable_parent_delivery", codex_hook_schema: "peertable.codex-parent-hooks.v1",
  backup_suffix: ".peertable-backup",
  channels: { claude_expiry_notice: "..." }, // only for channel products
};
```

| Field | Meaning |
| --- | --- |
| `id` | Product id. Used in state schema names and to tell your hooks apart. |
| `display_name` | Product name shown in error messages. |
| `setup_command`, `codex_steer_command` | The commands your users run to set up delivery. Error messages point to them. |
| `mcp_server` | Your MCP server's name as registered in the parent. Used for the Claude Code hook matcher and Cursor tool names. |
| `dispatch_tools` | The tools whose calls deliver to the parent. Claude Code hooks attach only to these. |
| `state_root` | Per-user runtime state for Claude Code and Cursor delivery records. |
| `config_root` | Per-user persistent config for Codex hook settings and ownership records. |
| `hooks` | File names of your hook entry files. They identify your hooks, so pick names no other product uses. |
| `codex_client_name`, `codex_hook_schema` | The client name you present to the Codex App Server, and your Codex hook config schema name. |
| `backup_suffix` | Suffix for the backup written before a config file is changed. |
| `channels` | Set this only if you send many messages to one conversation. `claude_expiry_notice` is a short text that wakes Claude Code to re-arm its waiter before the 24-hour hook limit. |

### 2. Ship the hook entry files

Hook entry files stay in your product, because their names identify your hooks and keep products from removing each other's hooks. Each is a two-line file:

```js
#!/usr/bin/env node
import { runClaudeHookMain } from "aiterm-steer-delivery";
import { PROFILE } from "./profile.mjs";
await runClaudeHookMain(PROFILE);
```

Use `runCodexHookMain`, `runClaudeHookMain`, and `runCursorHookMain` for the three hook files. Background receivers use `runCursorReceiveMain` (one answer) or `runChannelReceiveMain` (channels).

The Cursor parent starts the one-answer receiver detached, so it outlives the parent. Before it claims an answer, the receiver checks that the parent is still reading its output. If the parent is gone, it leaves the answer unclaimed and exits with code 5; the sender sees the delivery as not yet received instead of delivered.

### 3. Register the hooks

In your setup command:

- `mergeClaudeParentHooks(PROFILE, settingsFile, { command: nodePath, script: hookPath })` for Claude Code,
- `mergeCursorParentHooks(PROFILE, hooksFile, { command: nodePath, script: hookPath })` for Cursor,
- `configureCodexSteer(PROFILE, "enable", { hook: hookPath })` for Codex.

They keep other products' and the user's hooks and their order, and back up the file before writing. `removeClaudeParentHooks`, `removeCursorParentHooks`, and `configureCodexSteer(PROFILE, "disable", …)` undo them. `configureCodexSteer` returns `restart_required` when Codex processes that started before the hooks were installed are still running. PowerShell paths use the actual filesystem spelling, so PATH casing alone does not rewrite Codex hooks or require a restart.

The Claude Code hooks are written as one shell line, without `args`:

- POSIX: `exec '<node>' '<hook>'`. `exec` replaces `sh`, so Claude Code stays the direct parent of the hook.
- Windows: `& '<node>' '<hook>'; exit (Get-Variable LASTEXITCODE -ValueOnly)` with `shell: "powershell"`. PowerShell would otherwise turn the hook's exit code 2 into 1, and `asyncRewake` needs the 2.

Grok also runs the hooks in `~/.claude/settings.json`, but it drops `args` and runs `command` alone. With the `command` + `args` form that 0.1.x wrote, Grok started bare `node`, which read the hook input as a script and failed at every `Stop`. `runClaudeHookMain` now does nothing and exits 0 when Grok starts it (Grok puts its own `hookEventName` in the input), because Grok parents receive through the background process, not through hooks.

`mergeClaudeParentHooks` replaces your product's 0.1.x entries with the new form, and `removeClaudeParentHooks` removes both forms. To check a settings file without writing it, use `claudeParentHooksRegistered(PROFILE, document)` and `claudeParentHookScripts(PROFILE, document)` (the hook file paths the entries point to); do not read `args` yourself. Before you go back to 0.1.x, call `removeClaudeParentHooks` from 0.2.x: 0.1.x does not recognize the new entries and would add a second set.

### 4. Deliver

The MCP parent-delivery APIs offer two ways to deliver.

**One answer per request** (what Aiterm does): identify the parent from the MCP request, bind a delivery id, and submit the final text once.

```js
import * as steer from "aiterm-steer-delivery";

const parent = steer.codexParentFromRequest(clientName, request.params._meta);
await steer.verifyCodexParent(PROFILE, parent);
const { queued_submission_id } = await steer.submitCodexParentAnswer(PROFILE, parent, deliveryId, text);
```

Claude Code and Cursor follow the same shape with `claudeParentFromRequest` / `bindClaudeParentDelivery` / `submitClaudeParentAnswer` and `cursorParentFromRequest` / `prepareCursorDelivery` / `submitCursorParentAnswer`. Each `…ParentFromRequest` returns `null` when the caller is a different client, so you can try them in turn. For Cursor, put the delivery id in your tool result, as `parent_delivery: { delivery_id }` in `structuredContent` and as a `delivery_id=<uuid>` line in the text, so the hook can bind it to the conversation.

Claude Code does not run the `PostToolUse` hook when a tool result is an error (`isError`). When you return an error, call `discardClaudeHookRequest(clientName, request.params._meta, claudeHookRoot(PROFILE))` before returning, to remove that call's request directory. A directory with a bound delivery is kept. If you do not call it, the next request's hook removes the leftover after one day.

**Deliver to a Codex parent without registering product hooks** (ask Aiterm's parent delivery):

On a machine with Aiterm (0.56.0 or later) installed, a product can hand a final answer to Aiterm instead of owning Codex hooks. Aiterm's registered hooks and the official queue deliver it. The product never writes Aiterm's files.

```js
const parent = steer.codexParentFromRequest(clientName, request.params._meta);
const { steer: mode } = await steer.verifyCodexParentViaAiterm(parent);   // "enabled" | "disabled"
await steer.submitCodexParentAnswerViaAiterm(parent, randomUUID(), text);  // a fresh UUID per message
await steer.codexDeliveryDetailViaAiterm(parent, deliveryId);              // { state, hook, turn_id, queued }
```

- Three things are reported separately. `steer` from `verify` is about configuration (`enabled`: Aiterm's hooks are registered and trusted, and the parent started after they were installed; `disabled`: official queue only, so the text arrives after the turn ends). The result of `submit` is the queue's acceptance. Actual arrival is read with `codexDeliveryDetailViaAiterm` (`hook: "emitted"` with `turn_id`: Aiterm's hook put the text into that turn; `queued`: whether it is still in the official queue).
- Failures are `CodexDeliveryError` as before (`delivery_code`, `outcome_unknown`), carrying the reason Aiterm returned. When Aiterm's command is missing, too old, or returns something unreadable, the error is `AITERM_PROVIDER_UNAVAILABLE`; there is no fallback to another route. Reusing a delivery id is refused with `PARENT_DELIVERY_DUPLICATE`.
- Aiterm's command (`aiterm-parent-delivery`) is located from the `cli` option or `AITERM_PARENT_DELIVERY_CLI`, then `~/.config/aiterm-mcp/delivery-provider.json` written by `aiterm-setup`, then `PATH`. `findAitermDeliveryProvider()` shows what was found.
- Remove Codex hooks a product registered earlier with `configureCodexSteer(PROFILE, "disable", { hook })`. Trust for other hooks that move is copied to their new positions.

#### Sleeping Codex conversations

Codex starts a queued message only in a conversation that some running Codex process has loaded. The Codex app unloads a conversation 60 seconds after nobody is viewing it (`thread_unload_delay_secs`), and from then on its queue is not looked at until the conversation is opened again. Without help, a reply sent to such a conversation waits until a person opens it.

`submitCodexParentAnswer` therefore starts a small watcher in a separate process after the queue accepts the text. About 15 seconds later the watcher looks at the queue again:

- The text is gone: the conversation was loaded and took it (or your hook steered it into the running turn). Nothing else happens.
- The text is still queued, the conversation belongs to the app (`source` is `vscode`), and its last turn ended normally (or it has no turn yet): the watcher asks the OS to open `codex://threads/<id>`. The app loads the conversation and the official queue starts the turn. The app's window switches to that conversation; on macOS the app is not brought to the front.
- The conversation is in the middle of a turn, its last turn was interrupted (a person stopped it, or another tool moved the work elsewhere), or it is not an app conversation (a CLI session): the watcher leaves it alone. Codex itself holds the queue of an interrupted conversation until a person sends the next message.

The outcome is saved under `<config_root>/codex-parent-hooks/wake/<delivery id>.json` for three days and can be read with `readCodexWakeResult(PROFILE, deliveryId)`: `delivered`, `running`, `interrupted`, `not_app_thread`, `unknown_state`, `no_opener`, `open_failed`, `woken`, or `opened_still_queued`. The acceptance returned by `submitCodexParentAnswer` does not depend on the watcher.

The watcher runs on macOS and Windows. On Windows the link is opened only from an interactive session (a link opened from a service or an SSH session never reaches the app on the desktop; the outcome is `no_opener`). On Linux nothing is started yet: asking the Linux app to open the same link did not load the conversation in our tests, so a reply to a sleeping conversation still waits there until the conversation is opened. On servers and in containers nothing is started. Set `AITERM_STEER_CODEX_WAKE=0` to turn it off. To check and wake right now from your own process, call `wakeCodexParentIfAsleep(PROFILE, parent, deliveryId, { delay_ms: 0 })`.

**Many messages to one conversation** (channels, e.g. Peertable's room messages to the parent):

```js
const channel = steer.openChannel(PROFILE, parent);          // parent from the request; null for background-only
await steer.sendToChannel(PROFILE, channel.channel_id, randomUUID(), text);
steer.channelDeliveryState(PROFILE, channel.channel_id, id); // queued | sending | emitted | unknown | withdrawn
```

Claude Code re-arms its waiter at every `Stop`. Cursor binds the channel with `steer.channelMarker(channel)` placed in your tool result, and idle Cursor/Grok parents run `steer.channelReceiveProcess(...)` in the background; each result carries `next_wait_process` to re-arm. `withdrawFromChannel` takes back text no receiver has claimed yet, so you can resend it on a new channel; `closeChannel` ends one.

Put both the marker and the receiver command in the **text** of your tool result, not only in `structuredContent`: the Cursor CLI model does not read structured content. `steer.waitProcessCommandLine(steer.channelReceiveProcess(script, channel.channel_id))` gives the command as one shell line (POSIX sh, or PowerShell on Windows).

### Send to a new Claude conversation

`sendClaudeInbox(target, text, options)` sends one user message to Claude Code's [session inbox](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket). Capture `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` in the target's `SessionStart` hook. This API works before that conversation has called an MCP tool, and needs no `ProductProfile` or `ClaudeParent`.

```js
import { sendClaudeInbox } from "aiterm-steer-delivery";

const text = "Continue the work.";
const result = await sendClaudeInbox({ socket_path, token }, text, {
  timeout_ms: 30_000,
  // Your product observes the target's UserPromptSubmit receipt.
  confirm_acceptance: signal => productReceipts.waitForPrompt({ session_id, text, signal }),
});
```

Capture the endpoint from the target hook; do not infer it from a PID. Windows requires a token; POSIX sends the authentication line when a token is supplied. Keep the token private. `confirm_acceptance` starts before connecting; arm any receipt registration before calling. Match the target session and this message, rather than an older receipt or merely a new timestamp. The observer receives an `AbortSignal` when the call finishes. Its `false` result means unconfirmed.

The raw inbox post has no same-connection acknowledgement proving conversation acceptance. `accepted` requires your observer to confirm receipt, for example at `UserPromptSubmit`; it does not prove task completion. `not_sent` means no message write was attempted. After a write is attempted, a failure or missing confirmation returns `unknown` with `outcome_unknown:true`. With no observer, even a successful write returns `unknown`. The library never retries. Claude's inbound controls still apply. The result contains only `status`, `reason`, and `outcome_unknown` and excludes the token, message, and endpoint.

## Errors and delivery states

Delivery errors are `SteerDeliveryError` (`CodexDeliveryError`, `ClaudeDeliveryError`, `CursorDeliveryError`, `ChannelError`) with:

- `delivery_code`: a stable reason, for example `CLAUDE_PARENT_HOOK_UNAVAILABLE` or `CHANNEL_CLOSED`;
- `outcome_unknown`: `true` when the text may or may not have reached the parent. Do not resend automatically.

Setup failures are `SetupError`, whose `code` becomes your setup result's `reason_code`.

Channel delivery states:

| State | Meaning |
| --- | --- |
| `queued` | Saved in the channel inbox; no receiver has taken it yet. |
| `sending` | A receiver has claimed it and is writing it out. |
| `emitted` | Written to the parent. |
| `unknown` | The receiver stopped after claiming it; it may or may not have reached the parent. |
| `withdrawn` | Taken back with `withdrawFromChannel` before any receiver claimed it. |

On a Codex channel, `sendToChannel` returns `submitted` with the official queue's `queued_submission_id`, and `channelDeliveryState` returns `null`.

Known limit: Claude Code sessions that carry an `agent_id` (started with `--agent`, or native subagents) are not supported as parents.

## Non-Node products

`aiterm-steer-delivery --profile <profile.json> codex <parent|verify|submit|state|wake|setup>` prints one JSON line. `state_root` and `config_root` are absolute paths in the JSON profile. `codex setup enable` registers the package's own Codex hook entry for your profile.

```sh
aiterm-steer-delivery --profile profile.json codex parent --client <name> --meta <json>
aiterm-steer-delivery --profile profile.json codex verify --thread <uuid> [--codex-home <dir>]
aiterm-steer-delivery --profile profile.json codex submit --thread <uuid> --delivery <uuid> --text-file <file|-> [--codex-home <dir>]
aiterm-steer-delivery --profile profile.json codex state  --thread <uuid> --delivery <uuid> [--codex-home <dir>]
aiterm-steer-delivery --profile profile.json codex wake   --thread <uuid> --delivery <uuid> [--delay-ms <n>] [--codex-home <dir>]
aiterm-steer-delivery --profile profile.json codex setup  <enable|disable|status>
```

`codex submit` starts the watcher described in [Sleeping Codex conversations](#sleeping-codex-conversations); the command returns as soon as the queue accepts the text. `codex state` also returns `wake` once the watcher has saved its outcome. `codex wake` checks and wakes right now.

Success is `{"ok":true,...}`. Failure is `{"ok":false,"code":...,"message":...,"outcome_unknown":...}` with exit code 1.

## Development

```sh
npm ci
npm test   # builds with tsc, then runs node --test
```

CI runs the tests on Ubuntu, macOS, and Windows. Pushing a `v<version>` tag publishes to npm with provenance. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)

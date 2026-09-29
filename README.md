# aiterm-steer-delivery

Aiterm's steer delivery as a library. Your MCP server can deliver text to the **parent AI session that called it**:

- if the parent is busy, the text is steered into its running turn;
- if the parent is idle, it arrives in the same conversation as a normal new turn.

This is the delivery [Aiterm](https://github.com/kitepon/aiterm-mcp) uses to hand a sub-agent's answer back to its parent. It was extracted from Aiterm without changing behavior, so products no longer have to rebuild conversation correlation, hook registration, and OS quirks each time.

| Parent | How the parent is identified | How text arrives |
| --- | --- | --- |
| Codex | `_meta.threadId` of the MCP request | Official App Server queue (`thread/queue/add`). On macOS/Windows your sync `PostToolUse`/`Stop` hooks pull it into the running turn; otherwise the official queue delivers it at the next turn boundary. |
| Claude Code | Your `PreToolUse` hook record + `_meta["claudecode/toolUseId"]` | An `asyncRewake` hook writes the text to stderr and exits 2, waking the session (or steering into the running turn). |
| Cursor | Your hook binds the id in your tool result to the real `conversation_id` | `additional_context` on the next tool return while busy; a background receiver process while idle. |
| Others (Grok, …) | — | A background receiver process (`wait_process`). |

Delivery never auto-retries a send whose outcome is unknown (`outcome_unknown` / `unknown`).

## Two ways to deliver

**One answer per request** (what Aiterm does): identify the parent from the MCP request, bind a delivery id, and submit the final text once.

```js
import * as steer from "aiterm-steer-delivery";

const parent = steer.codexParentFromRequest(clientName, request.params._meta);
await steer.verifyCodexParent(PROFILE, parent);
const { queued_submission_id } = await steer.submitCodexParentAnswer(PROFILE, parent, deliveryId, text);
```

**Many messages to one conversation** (channels, e.g. Peertable's room messages to the parent):

```js
const channel = steer.openChannel(PROFILE, parent);          // parent from the request; null for background-only
await steer.sendToChannel(PROFILE, channel.channel_id, randomUUID(), text);
steer.channelDeliveryState(PROFILE, channel.channel_id, id); // queued | sending | emitted | unknown | withdrawn
```

Claude Code re-arms its waiter at every `Stop`. Cursor binds the channel with `steer.channelMarker(channel)` placed in your tool result, and idle Cursor/Grok parents run `steer.channelReceiveProcess(...)` in the background; each result carries `next_wait_process` to re-arm.

## Product profile

Everything product-specific lives in one object. The delivery mechanism is the same for every product.

```js
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

Hook entry files stay in your product (their names identify your hooks, so products never remove each other's hooks). Each is a two-line file:

```js
#!/usr/bin/env node
import { runClaudeHookMain } from "aiterm-steer-delivery";
import { PROFILE } from "./profile.mjs";
await runClaudeHookMain(PROFILE);
```

Register them with `mergeClaudeParentHooks`, `mergeCursorParentHooks`, and `configureCodexSteer` (Codex Steer hooks are macOS/Windows, same as Aiterm).

## Non-Node products

`aiterm-steer-delivery --profile <profile.json> codex <parent|verify|submit|state|setup>` prints one JSON line. `state_root` and `config_root` are absolute paths in the JSON profile. `codex setup enable` registers the package's own Codex hook entry for your profile.

## License

MIT

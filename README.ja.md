# aiterm-steer-delivery

[![CI](https://github.com/kitepon/aiterm-steer-delivery/actions/workflows/ci.yml/badge.svg)](https://github.com/kitepon/aiterm-steer-delivery/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/aiterm-steer-delivery.svg)](https://www.npmjs.com/package/aiterm-steer-delivery)
[![node](https://img.shields.io/node/v/aiterm-steer-delivery)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**MCPサーバーから、そのツールを呼んだAIセッションへ話しかけられるようにするライブラリです。**

[English README](README.md)（英語版が正本です）

MCPサーバーは、ツールの呼び出しが返った後でも、**ツールを呼んだ親のAIセッション**へ文章を届けられます。

- 親が作業中なら、実行中のターンへ差し込みます。
- 親が手すきなら、同じ会話に新しいターンとして届きます。

対応する親は Codex、Claude Code、Cursor です。それ以外（Grok など）は、背景で動く受信プロセスで受け取ります。Linux、macOS、Windows で動きます。

## なぜ必要か

AIのセッションをいくつも同時に動かしていると、大事なことはセッションの間で起きます。サブエージェントが作業を終えたら親に知らせたいですし、あるセッションが共有の部屋に書いたら別のセッションに反応してほしいこともあります。ところがツールの呼び出しは一度返ったら終わりです。後から起きたことは、親がもう一度聞きに来ない限り届け先がありません。

後から出た文章を正しい会話へ届けるには、次の壁があります。

- **どの会話か。** 呼び出し元の会話の見分け方はクライアントごとに違い、hook からしか分からないものもあります。環境変数のセッションIDのように使えそうな値も、`/clear` で古くなります。
- **どう入れるか。** 公式の受け口はクライアントごとに別物です（キュー、非同期 hook、hook の出力、背景プロセス）。導入手順も失敗の仕方もそれぞれ違います。
- **OSごとの違い。** プロセスの見分け方、シェル、PowerShell の引用符、hook 入力の先頭に付く BOM、同じ端末に複数ある `CODEX_HOME` などです。

このパッケージは、[Aiterm](https://github.com/kitepon/aiterm-mcp) がサブエージェントの答えを親へ返すのに使っている配送の仕組みです。挙動を変えずに Aiterm から切り出したので、他の製品は会話の見分け、hook の登録、OSごとの対応を作るたびに書き直さずに済みます。

## 使っている製品

| 製品 | 届けているもの |
| --- | --- |
| [Aiterm](https://github.com/kitepon/aiterm-mcp) | サブエージェントの最終回答を、それを起動したセッションへ |
| [Peertable](https://github.com/kitepon/peertable) | ルームの発言と個別メッセージを、円卓の脇に座るオーナー自身のセッションへ |
| [gpt-connector](https://github.com/kitepon/gpt-connector) | ChatGPT の返答を、それを頼んだ Codex のスレッドへ |

## 仕組み

| 親 | 親の見分け方 | 文章の届き方 |
| --- | --- | --- |
| Codex | MCP 要求の `_meta.threadId` | 公式 App Server のキュー（`thread/queue/add`）。Steer を有効にすると、製品の同期 hook（`PostToolUse`／`Stop`）が実行中のターンへ取り込みます。無効なら公式キューが次のターンの切れ目で届けます。 |
| Claude Code | 製品の `PreToolUse` hook の記録と `_meta["claudecode/toolUseId"]` | `asyncRewake` hook が本文を stderr へ書いて exit 2 で終わり、セッションを起こします（作業中ならそのターンへ入ります）。 |
| Cursor（Desktop と CLI） | ツール結果に入れた ID を、製品の hook が実際の `conversation_id` に結び付けます | 作業中は次のツール返りの `additional_context`、手すきの時は背景の受信プロセス。 |
| その他（Grok など） | — | 背景の受信プロセス（`wait_process`）。 |

どの経路もクライアントの公式の仕組みを使います。端末へ文字を打ち込んだり、クライアントを改造したりはしません。

**届いたかどうか分からない送信は、自動で再送しません。** 親に届いたか確かめられない時は `outcome_unknown`（channel の状態では `unknown`）を返し、判断を呼び出し側に任せます。同じ文章が親に二度届く事故を避けるためです。

## 導入

```sh
npm install aiterm-steer-delivery
```

必要なもの:

- Node.js 18 以上。ESM のみです。実行時の依存は `zod` だけです。
- Codex の Steer（作業中のターンへの差し込み）は、Codex Desktop の同梱 CLI があればそれを使います（macOS・Windows・Linux）。無ければ通常の Codex CLI 0.154 以上を使います。
- Windows の Codex Steer の hook は PowerShell 7（`pwsh.exe`）で動きます。

## 使い方

### 1. 製品プロファイルを書く

製品ごとの違いは、1つのオブジェクトにまとめます。配送の仕組みはどの製品でも同じです。

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
  channels: { claude_expiry_notice: "..." }, // channel を使う製品だけ
};
```

| 項目 | 意味 |
| --- | --- |
| `id` | 製品ID。状態のスキーマ名や、自製品の hook の見分けに使います。 |
| `display_name` | エラー文に出す製品名。 |
| `setup_command`、`codex_steer_command` | 利用者が配送を設定する時に実行するコマンド。エラー文で案内します。 |
| `mcp_server` | 親に登録された MCP サーバー名。Claude Code の hook の matcher と、Cursor のツール名に使います。 |
| `dispatch_tools` | 親への配送を伴うツール。Claude Code の hook はこれらにだけ付きます。 |
| `state_root` | Claude Code と Cursor の配送記録を置く、利用者ごとの実行時の置き場。 |
| `config_root` | Codex の hook 設定と所有記録を置く、利用者ごとの永続設定の置き場。 |
| `hooks` | 製品の hook 入口ファイルの名前。自製品の hook の見分けに使うので、他の製品と重ならない名前にします。 |
| `codex_client_name`、`codex_hook_schema` | Codex App Server へ名乗るクライアント名と、Codex の hook 設定のスキーマ名。 |
| `backup_suffix` | 設定ファイルを書き換える前に残す控えの接尾辞。 |
| `channels` | 同じ会話へ何通も送る製品だけ設定します。`claude_expiry_notice` は、hook の期限（24時間）が近づいた時に Claude Code を起こして待機を張り直すための短い文です。 |

### 2. hook 入口ファイルを同梱する

hook 入口ファイルは製品の中に置きます。ファイル名で自製品の hook を見分けるので、製品同士が互いの hook を消すことはありません。中身は2行です。

```js
#!/usr/bin/env node
import { runClaudeHookMain } from "aiterm-steer-delivery";
import { PROFILE } from "./profile.mjs";
await runClaudeHookMain(PROFILE);
```

3つの hook ファイルには `runCodexHookMain`、`runClaudeHookMain`、`runCursorHookMain` を使います。背景の受信には `runCursorReceiveMain`（1回の回答）か `runChannelReceiveMain`（channel）を使います。

Cursor の親は、1回の回答の受信 process を切り離して起こすので、親が終わった後も受信 process は残ります。受信 process は回答を引き取る前に、親がまだ出力を読んでいるかを確かめます。親が居なければ引き取らずに exit code 5 で終わり、送り主からは「配送済み」ではなく「まだ受け取られていない」と見えます。

### 3. hook を登録する

製品の setup コマンドで次を呼びます。

- Claude Code: `mergeClaudeParentHooks(PROFILE, settingsFile, { command: nodePath, script: hookPath })`
- Cursor: `mergeCursorParentHooks(PROFILE, hooksFile, { command: nodePath, script: hookPath })`
- Codex: `configureCodexSteer(PROFILE, "enable", { hook: hookPath })`

他の製品や利用者の hook とその順序は保ち、書き換える前にファイルの控えを残します。解除は `removeClaudeParentHooks`、`removeCursorParentHooks`、`configureCodexSteer(PROFILE, "disable", …)` です。hook を入れる前から動いている Codex が残っていると、`configureCodexSteer` は `restart_required` を返します。 PowerShell の path は実体の表記に揃えるため、PATH の大文字小文字だけでは Codex hook を書き換えず、再起動を求めません。

Claude Code の hook は、`args` を使わず、shell を通す1行で書きます。

- POSIX: `exec '<node>' '<hook>'`。`exec` で `sh` を node に置き換え、Claude Code を hook の直接の親に保ちます。
- Windows: `& '<node>' '<hook>'; exit (Get-Variable LASTEXITCODE -ValueOnly)` と `shell: "powershell"`。こう書かないと、PowerShell が hook の終了 code 2 を 1 に変えます。`asyncRewake` は 2 で親を起こします。

Grok も `~/.claude/settings.json` の hook を動かしますが、`args` を落として `command` だけを動かします。0.1 系が書いていた `command` + `args` の形では、Grok は node だけを起こし、node が hook の入力を script として読んで、`Stop` のたびに失敗していました。`runClaudeHookMain` は、Grok から起こされた時は何もせずに 0 で終わります（Grok だけが入力に入れる `hookEventName` で見分けます）。Grok の親は hook ではなく、背景の受信プロセスで受け取るためです。

`mergeClaudeParentHooks` は、製品の 0.1 系の登録を新しい形へ置き換えます。`removeClaudeParentHooks` は両方の形を取り除きます。設定ファイルを書き換えずに登録を確かめる時は、`claudeParentHooksRegistered(PROFILE, document)` と `claudeParentHookScripts(PROFILE, document)`（登録が指している hook ファイルの path）を使い、`args` を自分で読まないでください。0.1 系へ戻す時は、先に 0.2 系の `removeClaudeParentHooks` を呼んでください。0.1 系は新しい形の登録を自分の物と数えず、もう1組を足します。

### 4. 届ける

MCPを呼んだ親への届け方は2つあります。

**1回の依頼に1つの答え**（Aiterm の使い方）: MCP 要求から親を見分け、配送IDを結び付け、確定した本文を一度だけ送ります。

```js
import * as steer from "aiterm-steer-delivery";

const parent = steer.codexParentFromRequest(clientName, request.params._meta);
await steer.verifyCodexParent(PROFILE, parent);
const { queued_submission_id } = await steer.submitCodexParentAnswer(PROFILE, parent, deliveryId, text);
```

Claude Code は `claudeParentFromRequest`／`bindClaudeParentDelivery`／`submitClaudeParentAnswer`、Cursor は `cursorParentFromRequest`／`prepareCursorDelivery`／`submitCursorParentAnswer` で同じ流れになります。各 `…ParentFromRequest` は呼び出し元が別のクライアントなら `null` を返すので、順に試せます。Cursor では、hook が会話に結び付けられるよう、ツール結果に配送IDを入れます。`structuredContent` には `parent_delivery: { delivery_id }`、本文には `delivery_id=<uuid>` の行を書きます。

Claude Code は、ツールの返りが誤り（`isError`）の時に `PostToolUse` の hook を走らせません。誤りで返す時は、返す前に `discardClaudeHookRequest(clientName, request.params._meta, claudeHookRoot(PROFILE))` を呼び、その呼び出しの置き場を消します。配送を結んだ置き場は消しません。呼ばなくても、残った置き場は1日後に次の依頼の hook が消します。

**同じ会話へ何通も送る**（channel。例: Peertable がルームの発言を親へ届ける）:

```js
const channel = steer.openChannel(PROFILE, parent);          // parent は要求から得たもの。背景受信だけなら null
await steer.sendToChannel(PROFILE, channel.channel_id, randomUUID(), text);
steer.channelDeliveryState(PROFILE, channel.channel_id, id); // queued | sending | emitted | unknown | withdrawn
```

Claude Code は `Stop` のたびに待機を張り直します。Cursor はツール結果に入れた `steer.channelMarker(channel)` で channel を会話に結び付けます。手すきの Cursor／Grok の親は `steer.channelReceiveProcess(...)` を背景で動かし、結果に付く `next_wait_process` で受信を張り直します。`withdrawFromChannel` はまだどの受け口も取っていない本文を取り下げるので、新しい channel で送り直せます。`closeChannel` で channel を閉じます。

marker と受信コマンドは、`structuredContent` だけでなくツール結果の**本文**にも書いてください。Cursor CLI のモデルは structured content を読みません。`steer.waitProcessCommandLine(steer.channelReceiveProcess(script, channel.channel_id))` で、受信コマンドをシェルの1行にできます（POSIX sh、Windows では PowerShell）。

### 新しいClaude会話へ送る

`sendClaudeInbox(target, text, options)` はClaude Codeの[会話のinbox](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket)へuserメッセージを1通送ります。宛先の`SessionStart` hookで`CLAUDE_CODE_MESSAGING_SOCKET`と`CLAUDE_CODE_MESSAGING_TOKEN`を取得します。その会話がMCPを呼ぶ前にも使え、`ProductProfile`や`ClaudeParent`は要りません。

```js
import { sendClaudeInbox } from "aiterm-steer-delivery";

const text = "作業を続けて";
const result = await sendClaudeInbox({ socket_path, token }, text, {
  timeout_ms: 30_000,
  // UserPromptSubmitの受領記録を観測する処理は、利用製品が用意します。
  confirm_acceptance: signal => productReceipts.waitForPrompt({ session_id, text, signal }),
});
```

宛先はhookから得て、PIDから推測しません。Windowsではtokenが必須で、POSIXでも渡したtokenは先頭のauth行で送ります。tokenは非公開で扱います。`confirm_acceptance`は接続前に開始します。受領票の事前登録が必要なら呼出前に済ませ、対象sessionと今回の文を照合します。古い記録や時刻の変化だけでは確認しません。終了時は`AbortSignal`で観測を取り消します。`false`は未確認を意味します。

raw投稿には同じ接続上の受付票がありません。`accepted`はUserPromptSubmitなどの受領観測が一致した時だけ返し、作業の完了までは示しません。`not_sent`はメッセージの書き込みを試みていない場合です。書き込みを試みた後の失敗や確認不能は`unknown`と`outcome_unknown:true`を返します。観測処理を渡さなければ、書き込みが成功しても`unknown`です。自動再送はしません。Claudeの受信制御はそのまま適用されます。結果は`status`・`reason`・`outcome_unknown`だけで、token・本文・宛先を含めません。

## エラーと配送の状態

配送のエラーは `SteerDeliveryError`（`CodexDeliveryError`、`ClaudeDeliveryError`、`CursorDeliveryError`、`ChannelError`）で、次を持ちます。

- `delivery_code`: 理由を表す決まった文字列。例: `CLAUDE_PARENT_HOOK_UNAVAILABLE`、`CHANNEL_CLOSED`
- `outcome_unknown`: 親に届いたかどうか分からない時に `true`。自動で再送しないでください。

setup の失敗は `SetupError` で、その `code` が製品の setup 結果の `reason_code` になります。

channel の配送状態:

| 状態 | 意味 |
| --- | --- |
| `queued` | channel の受信箱に保存済みで、まだどの受け口も取っていません。 |
| `sending` | 受け口が取り、出力しているところです。 |
| `emitted` | 親へ出力しました。 |
| `unknown` | 受け口が取った後に止まりました。親に届いたかどうか分かりません。 |
| `withdrawn` | 受け口が取る前に `withdrawFromChannel` で取り下げました。 |

Codex の channel では、`sendToChannel` が公式キューの `queued_submission_id` とともに `submitted` を返し、`channelDeliveryState` は `null` を返します。

既知の制限: `agent_id` を持つ Claude Code の会話（`--agent` で起動したもの、ネイティブのサブエージェント）は、親として対応していません。

## Node 以外の製品

`aiterm-steer-delivery --profile <profile.json> codex <parent|verify|submit|state|setup>` は、結果を1行の JSON で出します。JSON のプロファイルでは `state_root` と `config_root` を絶対パスで書きます。`codex setup enable` は、パッケージ同梱の Codex hook 入口をそのプロファイル用に登録します。

```sh
aiterm-steer-delivery --profile profile.json codex parent --client <name> --meta <json>
aiterm-steer-delivery --profile profile.json codex verify --thread <uuid> [--codex-home <dir>]
aiterm-steer-delivery --profile profile.json codex submit --thread <uuid> --delivery <uuid> --text-file <file|-> [--codex-home <dir>]
aiterm-steer-delivery --profile profile.json codex state  --thread <uuid> --delivery <uuid> [--codex-home <dir>]
aiterm-steer-delivery --profile profile.json codex setup  <enable|disable|status>
```

成功は `{"ok":true,...}`、失敗は `{"ok":false,"code":...,"message":...,"outcome_unknown":...}` で、exit code は 1 です。

## 開発

```sh
npm ci
npm test   # tsc でビルドしてから node --test を実行します
```

CI は Ubuntu、macOS、Windows で試験します。`v<version>` のタグを push すると、provenance 付きで npm に公開されます。変更の記録は [CHANGELOG.md](CHANGELOG.md) にあります。

## ライセンス

[MIT](LICENSE)

# Changelog

## 0.4.2

Claude Codeが起動し直して同じ会話を再開した後、channelの本文が届かなかったのを直します。今までのAPIの返りは変わりません。

- **起きていた事。** channelは、開いた時のClaude Codeのprocess（pidと開始時刻）に結んである。待機（`runClaudeChannelWaiter`）は、その会話の開いているchannelのうち、結んだprocessが生きている物が1つも無いと、すぐ0で終わっていた。アプリが配下のClaude Codeを起こし直すと、同じ会話（同じ`session_id`）が新しいprocessで再開される。会話のchannelは全部、居ないprocessに結ばれたままなので、PostToolUseとStopの待機が毎回すぐ終わり、本文は受信箱に残った（製品が新しいchannelを開くまで届かない）。Windowsの実物（Claude Code 2.1.295）で起き、Linuxの実物（2.1.293）で再現した。
- **待機は、そのhookを起こしたClaude Codeのprocessが生きている間、続ける。** 本文を出す先はそのprocessなので、生き死にもそのprocessで見る。同じ会話（`session_id`）のhookを今走らせているprocessへ、前のprocessが開いたchannelの本文も出す。別の会話のchannelからは取らない（今までどおり、会話ごとの索引で分ける）。hookを起こしたprocessが居なくなったら、本文を取らずに終わる。hookを起こしたprocessを確かめられない時だけ、今までどおりchannelを開いた時のprocessの生き死にで決める。
- **会話の始まり（`SessionStart`）でも待機を張る。** channelを使う製品（`profile.channels`がある）の登録に、`SessionStart`のhook（`asyncRewake`）を足す。再開した会話が番を1つも回さないうちから、止まっていた間に届いた本文で起きる（実物で、再開した席が入力待ちになって3〜5秒後）。開いているchannelの無い会話（新しい会話、`/clear`の後）では、何もせず0で終わる。
  - 0.4.1までの登録には`SessionStart`が無い。そのままでも配送は成り立ち（`claudeParentHooksRegistered`は`SessionStart`を求めない）、再開した会話は最初の番の終わりから受け取る。製品のsetup（`mergeClaudeParentHooks`）をかけ直すと`SessionStart`だけが足される。`removeClaudeParentHooks`は一緒に外す。
  - channelを使わない製品（Aitermなど）の登録と動きは変わらない。
- `runClaudeChannelWaiter`の`options`に`owner`（試験が、hookを起こしたprocessを差し替える口）を足す。
- 0.4.1の記述の言い足し: Linuxのアプリで寝ている会話が起きなかった端末は、アプリのログインの期限が切れていた（アプリの記録に`token_expired`）。リンクを開く口が効かないのか、ログインのせいかは、まだ分けられていない。Linuxで見張りを起こさない事は変わらない。

## 0.4.1

0.4.0の「寝ている会話を起こす見張り」の、3つの直しです。

- **Linuxでは見張りを起こさない。** 0.4.0は、画面のあるLinuxで`xdg-open`を使うと書いていた。実物（Linuxのアプリ、Codex 0.162.0-alpha.2）で、同じリンクを開かせても会話が載らず、キューは動かなかった。動く形を確かめるまで、Linuxでは何も開かない（今までどおり、会話が開かれた時に届く）。CodexがMCP serverへ渡す環境には`DISPLAY`も`WAYLAND_DISPLAY`も無いので、0.4.0でも製品の本番の道では起きていなかった。
- **リンクを開く命令を、場所を決めて呼ぶ。** macOSは`/usr/bin/open`、Windowsは`ComSpec`（無ければ`%SystemRoot%\\System32\\cmd.exe`）。CodexがMCP serverへ渡す環境は細く、`PATH`に頼ると見つからない事がある。
- 文書の、Linuxで動くという記述を直す。

## 0.4.0

Codexの寝ている会話へ入れた文が、人がその会話を開くまで動かなかったのを直します。今までのAPIの返りは変わりません。

- **起きていた事。** Codexが公式キューの文を番にするのは、その会話を載せている（loaded）Codexのprocessだけ。Codexのアプリは、見ている接続が居なくなって動きの無い会話を60秒で下ろす（`thread_unload_delay_secs`。Codex 0.153.0までは30分）。下ろされた会話のキューは、人がその会話を開くまで誰も見ない。番の途中へ入れる道（hook）と、載っている会話の止まっている所へ届く道は、今までどおり通っていた。
- **`submitCodexParentAnswer`が、入れた後に「寝ていたら起こす見張り」を別のprocessで起こす。** 約15秒後にキューを見直す。
  - 文がもう無い（会話が載っていて受け取った、hookが番の途中へ入れた）: 何もしない。
  - 文が残っていて、アプリの会話（`source`が`vscode`）で、最後の番が普通に終わっている（または番が1つも無い）: OSの口で`codex://threads/<会話>`を開かせる。アプリが会話を載せ、公式キューが番を始める。アプリの画面はその会話へ切り替わる（macOSは`open -g`で、アプリを前面へは出さない。Windowsは`cmd /c start`。Linuxは0.4.1で外した）。Windowsでは、人の画面のあるsessionの時だけ開く（サービスやsshのsessionから開いたリンクは、人の画面のアプリへ届かない）。
  - 番の途中、最後の番が途中で止められている（人が止めた、ほかの製品が作業を別の会話へ移した）、アプリの会話でない（CLIの席）、会話の記録を読めない: 起こさない。途中で止められた会話は、人が次の文を送るまでCodexがキューを動かさない。
  - 同じ会話へ続けて届いた時は、30秒の間は開き直さない。
- **結果を残す。** `<config_root>/codex-parent-hooks/wake/<配送ID>.json`に3日間。`readCodexWakeResult(profile, deliveryId)`で読める（`delivered`・`running`・`interrupted`・`not_app_thread`・`unknown_state`・`no_opener`・`open_failed`・`woken`・`opened_still_queued`）。受付の返り（`queued_submission_id`）は、見張りの成否で変わらない。
- **見張りを起こすのは、リンクを開く口のある環境だけ。** macOSとWindows（Linuxは0.4.1で外した）。サーバーやコンテナでは何も起こさない。止める時は環境変数`AITERM_STEER_CODEX_WAKE=0`。
- **公開した物。** `wakeCodexParentIfAsleep(profile, parent, deliveryId, options?)`（今すぐ見直して起こす）、`startCodexWakeWatch`、`readCodexWakeResult`、`readCodexTurnTail`、`codexThreadUrl`、`codexThreadOpener`、`codexWakeWatchEnabled`、`codexWakeDirectory`。`CodexReceiverRuntime`に`wake`（`runtime`を渡す呼び出しでは、`true`の時だけ見張りを起こす）。
- **CLI。** `codex submit`は今までどおりすぐ返り、見張りを残す。`codex state`の返りは、見張りが結果を残した後だけ`wake`が付く（それまでは今までと同じ形）。`codex wake --thread --delivery [--delay-ms]`を足す。
- **Aitermへ頼む入口。** `codexDeliveryDetailViaAiterm`の返りは、Aiterm（0.58.0以上）が見張りの結果を返した時だけ`wake`が付く。

## 0.3.1

Codexの設定と起動の、2つの弱さを直します。APIと記録の形は変わりません。

- **登録の間に終わったCodexを、再起動待ちの記録（`stale_processes`）へ残さない。** `configureCodexSteer(profile, "enable", …)`は、登録より前から動いているCodexを再起動待ちとして記録する。ほかの導入が設定のために一時的に起こしたCodex（公式App Serverを起こして止める形）が、止まり切る前のprocessの一覧に載り、記録へ残っていた。承認の確かめの後にもう一度一覧を取り、居なくなった物を外してから保存する。返す状態（`ready`／`restart_required`）も、その同じ一覧で決める。
  - 居ないprocessは、今までも照合で当たらない（pidと開始時刻の組で見る）。記録に残るだけで、配送は止まっていなかった。
- **Codexを起こす時、PATHにこのprocessのnodeの場所が無ければ足す。** npm版のCodexは、nodeで動く起動役（1行目が`#!/usr/bin/env node`）で、起こす側のPATHにnodeの場所が無いと起きない（exit 127）。素のsshの環境、製品の常駐process、アプリ配下のprocessから`withCodexReceiver`を呼ぶと、`CODEX_RECEIVER_TRANSPORT_FAILED`で断っていた。本文は送られていなかった。
  - `withCodexReceiver`と、Codexの版を確かめる所が、起こす環境のPATHの頭へnodeの場所を足す。既にあれば、並びも中身も変えない。渡した`env`そのものは書き換えない。
  - 同じ形の環境を自分で作る製品のために、`codexSpawnEnv(env?)`を公開する。
  - Desktop同梱のCodex（macOS・Windows）は、元から当たらない。

## 0.3.0

Codexの親へ、製品のhookを登録せずに届ける入口を足します。今までのAPIと記録の形は変わりません。

- **Aitermの親配送へ頼む入口を公開する。** `verifyCodexParentViaAiterm(parent)`・`submitCodexParentAnswerViaAiterm(parent, deliveryId, text)`・`codexDeliveryStateViaAiterm(parent, deliveryId)`・`codexDeliveryDetailViaAiterm(parent, deliveryId)`・`findAitermDeliveryProvider()`。Aiterm（0.56.0以上）が持つ命令`aiterm-parent-delivery`を探して呼ぶ。届けるのはAitermが登録したhookと公式キューで、製品はCodex用のhookを持たず、Aitermの置き場のfileも書かない。
  - 設定・受付・実際に届いた事を分けて返す。`verify`の`steer`は設定（`enabled`＝hookが登録・承認済みで親がhookの導入後に起きている、`disabled`＝公式キューだけ）。`submit`は公式キューの受付。届き方は`codexDeliveryDetailViaAiterm`（`hook: "emitted"`と`turn_id`＝hookがその番へ本文を入れた、`queued`＝今も公式キューにあるか）。
  - 失敗は今までどおり`CodexDeliveryError`（`delivery_code`・`outcome_unknown`）。Aitermの命令が見つからない・古い・返りを読めない時は`AITERM_PROVIDER_UNAVAILABLE`で断り、ほかの届け方へ切り替えない。本文を渡した後に返りを読めなかった時だけ`outcome_unknown`が真になる。
  - 命令は、引数`cli`・環境変数`AITERM_PARENT_DELIVERY_CLI`、`aiterm-setup`が残す`~/.config/aiterm-mcp/delivery-provider.json`、`PATH`の順に探す。明示した場所が使えない時は、別の場所へ移らない。
- 製品が前に登録したCodexのhookを外す入口は、今までの`configureCodexSteer(profile, "disable", { hook })`。変えていない。

## 0.2.3

- **`discardClaudeHookRequest`を公開する。** 製品が、toolの返りを誤り（`isError`）にする時に、返す前に呼ぶ。その呼び出しの置き場（`<state_root>/claude-parent-hooks/<tool_use_id>/`）を消し、消したかを返す。Claude Codeは誤りの返りで`PostToolUse`を走らせないので、配送の無い呼び出しの片付けが走らず、`request.json`だけの置き場が1日後の見回りまで残っていた（連携元の本番で、引数の検査で断った呼び出しの置き場が残っているのを見た。Claude Code 2.1.291）。
  - 配送を結んだ置き場（`delivery.json`がある）は消さない。送り手が待っているか、届かなかった時に原因を調べる材料になる。今までどおり見回りが後で消す。
  - Claude Codeでない呼び出し元、`toolUseId`の無い要求、置き場の無い番号、この製品の依頼の記録でないfileが入ったdirectoryでは、何もせず`false`を返す。
  - 投げない。消せなかった置き場は、今までどおり見回りが消す。
- 呼ばない製品の動きは変わらない。Claude側で断られた呼び出し（引数がtoolの定義に合わない）と打ち切られた呼び出しは、製品へ返りが渡らないので、今までどおり1日後の見回りが消す。

## 0.2.2

Claude Codeの親への単発配送で、依頼ごとの置き場（`<state_root>/claude-parent-hooks/<tool_use_id>/`）が届いた後も残っていたのを片付けます。APIと記録の形は変わりません。

- **届いた依頼の置き場を、送り手が消す。** `submitClaudeParentAnswer`は、受信hookが本文を出し終えた記録（`emitted.json`）を確かめた後に、置き場ごと消す。今までは届いた子1つにつき置き場が1つ残り、Windowsの一時置き場では再起動でも消えなかった（18日前の分が残っていた）。消せなかった時も配送は成功のまま返す。届かなかった時（誤りで返す時）は消さず、原因を調べる材料として残す。
- **届かないまま残った置き場を、PreToolUseのhookが見回って消す。** 誤りで返った呼び出しや打ち切られた呼び出しはPostToolUseが走らず、`request.json`だけの置き場が残っていた。消すのは、最後に書かれてから1日たち、待っている配送が無い置き場（配送を結んでいない、依頼元のClaude processが居ない、出し終えている、依頼元を読めない）。依頼元が居て配送を結んであり、まだ出し終えていない置き場は、何日たっても残す。この製品の依頼の記録でないfileが入ったdirectoryには触れない。process表は、hookが親を記録するために読んだものを使い、読む回数は増えない。
- **会話終了の見回り（`closeClaudeParentSession`）が、読めない`request.json`で止まらない。** 今までは1つでも読めないと例外で終わり、その会話の残りの依頼を閉じなかった。読めない記録と、消えている途中の置き場は飛ばす。
- 依頼元のClaude processが居なくなってから1日より後に子が終わった配送は、置き場が消えているので、`CLAUDE_PARENT_PROCESS_CLOSED`ではなく`CLAUDE_PARENT_HOOK_UNAVAILABLE`で返る（どちらも届けていない。OSの再起動で一時置き場が消えた後と同じ）。

## 0.2.1

- `withCodexReceiver`の`runtime`に`env`を足す。Codex App Serverを起こす環境を渡せる（省略すると、今までどおりこのprocessの環境）。`CODEX_HOME`は常に`parent.codex_home`で上書きする。Aitermが、認証sessionへ引き継いだ環境のままCodexのログインの状態を公式App Serverへ聞くために使う。

## 0.2.0

Claude Codeのhookの登録の形が変わります。利用製品は、依存を`^0.2.0`へ上げてsetupを流し直してください。

- **Claude Codeのhookを、`args`を使わずshellを通す1行で書く。** Grokは共有の`~/.claude/settings.json`のhookも動かすが、`args`を落として`command`だけを動かす。0.1系の`command=node, args=[入口]`の形では、Grokがnodeだけを起こし、nodeがhookの入力のJSONをscriptとして読んで、Stopと会話の終わりのたびに`[stdin]:1`で失敗していた（ティア席のGrok 1.0.46で報告。Linuxとfoxで再現）。
  - POSIX: `exec '<node>' '<入口>'`。Claude Codeは`/bin/sh -c`で動かし、`exec`を書かないとshがhookの親として残る（Linuxの2.1.289で確認）。
  - Windows: `& '<node>' '<入口>'; exit (Get-Variable LASTEXITCODE -ValueOnly)`と`shell: "powershell"`。GrokはWindowsでhookをPowerShellで動かし、`shell`は読まない。PowerShellは終了codeを0か1へ丸めるので、asyncRewakeの2をそのまま返す。`$LASTEXITCODE`とは書かない（Grokが`$名前`を環境変数として読み、未設定としてhookを動かさずに失敗と記録する）。
  - `claudeParentHookCommand`を公開する。`claudeParentHookEntries`は3つ目の引数でplatformを受け取る。
- **PreToolUseのhookは、間に挟まったshellではなく、hookを起動したClaude Codeを親として記録する。** 今までは`process.ppid`をそのまま記録していた。shellを通す形では、WindowsのPowerShell（とexecを書かないsh）がhookと一緒に終わるので、受信の時に「依頼元のClaude processは終了しました」になる。`hookOwnerProcess`を公開する。
- **Grokから起こされたhook（`runClaudeHookMain`）は、何もせず0で終わる。** 形を直した後は、GrokのStopでhookが本当に走る。失敗の2を返すと、GrokはStopを「止めずに続ける」、PreToolUseを「拒否」と読む。見分けは、Grokだけが入力へ入れる`hookEventName`。
- **再登録と解除は、0.1系の形と新しい形の両方を自製品のhookと数える。** `mergeClaudeParentHooks`は0.1系の登録を新しい形へ置き換え、`removeClaudeParentHooks`は両方を除く。他製品と利用者のhookは、どちらの形でも残す。
- **`claudeParentHooksRegistered`と`claudeParentHookScripts`を公開する。** 設定を読むだけで、登録の有無と、登録が指す入口のpathを返す。製品が`args`を自分で読んで登録を確かめていると、新しい形を「未登録」と読む。
- **`submitClaudeParentAnswer`が、届いた配送を`CLAUDE_PARENT_HOOK_CLOSED`と数えない。** 送り主は「出し終えた記録が無い」→「hookのprocessが居ない」の順に見ていた。process表を読む間（Windowsは約1秒）にhookが本文を出し終えて終わると、親には届いているのに、送り主には失敗（結果不明）で返っていた（foxのClaude Code 2.1.289、0.1.13で再現）。「居ない」と読んだ後に、出し終えた記録を見直す。process表は1回の確かめにつき1回だけ読む。
- 0.1系へ戻す時の注意: 0.1系は新しい形の登録を自製品のhookと数えない。0.2.0で登録した後に0.1系のsetupを流すと、0.1系の形が足されて2組になる。戻す前に0.2.0の`removeClaudeParentHooks`を呼ぶ。
- Windowsでは、待っているhook1つにつきPowerShellのprocessが1つ残る（Claude Codeが起こす`pwsh -Command`）。直接起動の形ではnodeだけだった。
- 確かめた実物: Claude Code 2.1.289で、ライブラリが書いた登録のまま、作業中の親へ本文が差し込まれる事（Linux・macOS・Windows）。Grok 1.0.46で、Stopと会話の終わりのhookが失敗の記録を残さない事（Linux）。WindowsのGrokは、同じ書き方の1行が動く事までを見た。

## 0.1.13

- `sendClaudeInbox`を公開する。ClaudeのSessionStartが渡すinbox socketとtokenへuserメッセージを1通送る。MCPを呼んでいない新規会話にも使え、既存のClaudeParent・channel・asyncRewake配送は変えない。Windowsはauthを必須とし、POSIXでもtokenを渡せる。
- raw投稿の書き込みを受付済みとはしない。利用製品がUserPromptSubmit等を照合する`confirm_acceptance`を渡し、確認できた時だけ`accepted`にする。書き込み前の失敗は`not_sent`、書き込み後の確認不能は`unknown`と`outcome_unknown:true`。token・本文・宛先を結果へ含めず、自動再送しない。

## 0.1.12

- Cursor親の背景受信（`runCursorReceive`）が、読み手の居ない時に回答を引き取らない。Cursorは受信processを切り離して起こすので、親が終わった後も受信processは残る。残ったprocessが回答を引き取り、送り主は誰も読んでいない回答を配送済みにしていた（実物のCursor CLI 2026.10.01で、席を再起動して20回中20回）。受信processは最長24時間残っていた。
  - 出力先を `stdoutOutput()` で扱う。stdoutがsocket（POSIXのNodeが子へ渡す形）なら読み口も開き、親が終わった時点で受信を終える。引き取る前には1行書いて、書けるかを確かめる（Windowsのpipeなど、終了を知る方法が無い出力先のため）。
  - 読み手が居ない時は引き取らずにexit code 5で終わる。回答は置き場に残り、`submitCursorParentAnswer` は期限まで待って `CURSOR_PARENT_DELIVERY_UNCLAIMED` になる。
  - `receiveCursorAnswer` の4番目の引数に読み手（`CursorReceiveReader`）を渡した時だけ、結果に `reader_gone` が加わる。`runCursorReceive` の3番目の引数へ関数を渡す従来の呼び方は、読み手を確かめない。
- `waitForFileState` が `AbortSignal` を受け取る。

## 0.1.11

- WindowsのPowerShell 7を実体のpathへ解決する。同じ実行ファイルがPATHの大文字小文字だけ違う形で見つかっても、Codex hookのcommandと承認hashを変えず、不要な再起動待ちを作らない（foxの定期更新とSSHからのsetupで再現）。既に記録されている再起動待ちは保持する。

## 0.1.10

- Cursorのhookの持ち主を、名前の部分一致ではなくfile名の境目まで見て決める。Aitermの`cursor-parent-hook.js`が`gpt-connector-cursor-parent-hook.js`にも当たり、Aitermのsetupと解除がgpt-connectorのCursor hookを消していた（2026-10-03、main-server）。登録の確認（`cursorParentHooksRegistered`）も同じ見分けにした。`commandNamesFile`を公開する。
- Claudeのhookが同じ中身で登録済みなら、並びを変えない。後から他の道具がhookを足した後にsetupを流すと、自製品のentryが末尾へ移ってfileが書き換わっていた。

## 0.1.9

- `waitProcessCommandLine`を公開する（Aitermから移した）。`cursorReceiveProcess`・`channelReceiveProcess`の起動情報を、親のshellへ書ける1行にする（POSIXはsh、Windowsは既定のPowerShell）。Cursor CLIのmodelはtool結果のstructuredContentを読まないので、Cursor・Grokの親には背景で受信を起動するコマンドをtool結果の本文に書く必要がある（ラプラス氏の依頼、決裁箱のコネクタで使う）。
## 0.1.8

- `runCursorHookMain`・`runCursorReceiveMain`・`runCursorReceive`が置き場を複数受け取れる。Cursor CLIはMCPを削った環境（XDG_RUNTIME_DIR・TMPDIR等が無い）で起動し、hookと背景processは画面側の環境で起動する。環境から置き場を決める製品（Aiterm）はMCPとhookで置き場が割れ、hookが配送記録を見つけられずに何もしていなかった（rabbit・macbookで確認）。hookは渡した置き場それぞれで結び付けと差し込みを行い、受信は配送記録のある置き場で待つ。配送記録の無い置き場には何も作らない。
## 0.1.7

- WindowsのCursor（cursor-agent 2026.09.28）はhookのstdinのJSONの先頭にBOM（U+FEFF）を付ける。`handleCursorHook`がそのまま読んで失敗し、会話への結び付けも作業中の差し込みも起きず、配送は`sending`のまま止まっていた（紅蓮氏の報告、foxで確認）。hook入口の読み取り（Codex・Claude Code・Cursor共通）と`handleCursorHook`で先頭のBOMを落とす。`withoutBom`も公開する。
## 0.1.6

- Cursor CLI（cursor-agent）の親もCursor親として見分ける。CLIはMCPのinitializeで`clientInfo.name`を`"Cursor"`と名乗り、`"cursor-vscode"`（Desktop）しか見ていなかったため、CLIから呼ぶとhookと背景受信の配送に乗らなかった（紅蓮氏の報告、macbookのcursor-agent 2026.09.28で確認）。
## 0.1.5

- Steerの導入で「再起動が要るCodex」を数える時、別のCODEX_HOMEで動くCodex（同じ端末の他の利用者やBot）まで数えていた（紅蓮氏の報告）。Linuxではprocessの環境からCODEX_HOME（無ければHOME/.codex）を読み、hookを入れた場所のものだけを数える。macOS・Windowsは他processの環境を読めないので、今までどおり数える。

## 0.1.4

- CodexのSteerのhookを外した後、自製品のhookが居た位置の承認記録（`hooks.state`の`trusted_hash`・`enabled`）が`config.toml`に残っていた（ラプンツェル氏の報告）。他のhookが入らずに空いた位置の記録を消す。別のfileや他の位置の記録は触らない。記録の後片付けが公式APIの都合でできなくても、hookの解除そのものは止めない。

## 0.1.3

- Codex CLIをsymlink経由で起動した形（`node <symlinkのpath>`）も、再起動待ちとして照合する。
- macOS・Windowsで失敗していた試験を直した（試験のコマンド行の書き方と、macOSの一時ディレクトリの実体path）。0.1.1・0.1.2のmainのCIはこの試験でmacOS・Windowsが失敗していた。

## 0.1.2

- CodexのSteer（作業中のturnへの差し込み）を、Codex Desktopの無い端末とLinuxにも広げた（指揮官氏の判断 2026-09-29）。公式Desktopの同梱CLI（macOS・Windows・Linux）を先に探し、無ければ通常のCodex CLI（0.154以上）を使う。以前はmacOS・WindowsのDesktopだけで、Linuxは`unsupported`だった。
- 使っていたCodexが更新で消えた時の探し直しも、同じ順（Desktop、無ければCLI）で行う。
- npm版のCodex CLI（`node …/codex.js`とその中のnative本体）も、導入前から動いている「再起動が要るCodex」として照合する。

## 0.1.1

- Codex hookの解除（disable）で、自製品のhookのまとまりを抜くと後ろの他製品・利用者のhookの位置がずれ、Codexが位置の鍵で持つ承認と合わなくなって「modified」になり動かなくなっていた（紅蓮氏の報告、macbookでgrokbot-bridgeとpeertableのhookが止まった）。位置が動くhookの承認（trusted_hash・enabled）を、hooks.jsonを書き換える前に新しい位置へ写し、書き換え後に空いた位置の承認を消す。承認を新たに与えたり外したりはしない。公式Codexで確かめる試験を加えた。
- `verifyCodexParent`（CLIの`codex verify`）が、確認したthreadの`cwd`と`source`を返す。execの親かどうかの見分けに使える（call-bridgeの依頼）。

## 0.1.0

- Aiterm（aiterm-mcp 0.42.2）の親配送を、挙動を変えずにライブラリとして切り出した。Codexの公式キュー＋同期hook、Claude CodeのasyncRewake hook、Cursorのhook＋背景受信。
- 製品ごとの違い（名前、保存場所、hook入口、案内文）を`ProductProfile`にまとめた。
- 同じ会話へ何通も送るchannelを追加した。Claude CodeはStop hookで待機を張り直す。Cursor・Grok等は背景の受信processで受け取り、`next_wait_process`で張り直す。
- Node以外の製品向けにCLI（`aiterm-steer-delivery`、Codex）を追加した。

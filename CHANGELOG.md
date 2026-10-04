# Changelog

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

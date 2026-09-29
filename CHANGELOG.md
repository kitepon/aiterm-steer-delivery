# Changelog

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

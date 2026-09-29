# Changelog

## Unreleased

- Codex hookの解除（disable）で、自製品のhookのまとまりを抜くと後ろの他製品・利用者のhookの位置がずれ、Codexが位置の鍵で持つ承認と合わなくなって「modified」になり動かなくなっていた（紅蓮氏の報告、macbookでgrokbot-bridgeとpeertableのhookが止まった）。位置が動くhookの承認（trusted_hash・enabled）を、hooks.jsonを書き換える前に新しい位置へ写し、書き換え後に空いた位置の承認を消す。承認を新たに与えたり外したりはしない。公式Codexで確かめる試験を加えた。
- `verifyCodexParent`（CLIの`codex verify`）が、確認したthreadの`cwd`と`source`を返す。execの親かどうかの見分けに使える（call-bridgeの依頼）。

## 0.1.0

- Aiterm（aiterm-mcp 0.42.2）の親配送を、挙動を変えずにライブラリとして切り出した。Codexの公式キュー＋同期hook、Claude CodeのasyncRewake hook、Cursorのhook＋背景受信。
- 製品ごとの違い（名前、保存場所、hook入口、案内文）を`ProductProfile`にまとめた。
- 同じ会話へ何通も送るchannelを追加した。Claude CodeはStop hookで待機を張り直す。Cursor・Grok等は背景の受信processで受け取り、`next_wait_process`で張り直す。
- Node以外の製品向けにCLI（`aiterm-steer-delivery`、Codex）を追加した。

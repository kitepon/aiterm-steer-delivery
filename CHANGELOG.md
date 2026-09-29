# Changelog

## 0.1.0

- Aiterm（aiterm-mcp 0.42.2）の親配送を、挙動を変えずにライブラリとして切り出した。Codexの公式キュー＋同期hook、Claude CodeのasyncRewake hook、Cursorのhook＋背景受信。
- 製品ごとの違い（名前、保存場所、hook入口、案内文）を`ProductProfile`にまとめた。
- 同じ会話へ何通も送るchannelを追加した。Claude CodeはStop hookで待機を張り直す。Cursor・Grok等は背景の受信processで受け取り、`next_wait_process`で張り直す。
- Node以外の製品向けにCLI（`aiterm-steer-delivery`、Codex）を追加した。

// 製品ごとに一度だけ作る識別情報。配送の仕組みは全製品で同じで、ここに置くのは名前と置き場だけ。
import * as path from "node:path";

export interface ProductProfile {
  /** 製品ID。stateのschema名やhookの見分けに使う（例: "aiterm"）。 */
  id: string;
  /** 利用者へのエラー文に出す製品名（例: "Aiterm"）。 */
  display_name: string;
  /** 利用者に実行を案内するsetupの入口（例: "aiterm-setup"）。 */
  setup_command: string;
  /** CodexのSteerを有効にするsetupの入口（例: "aiterm-setup --codex-steer enable"）。 */
  codex_steer_command: string;
  /** 親に登録されたMCP server名（例: "aiterm"）。Claudeのmatcherと、Cursorのtool名の正規化に使う。 */
  mcp_server: string;
  /** 親への配送を伴うMCP tool。Claudeのhookはこのtoolだけに付き、Cursorはこのtoolの結果から配送IDを読む。 */
  dispatch_tools: readonly string[];
  /** Claude・Cursorの受信記録を置く、per-userの実行時state。 */
  state_root: () => string;
  /** Codexのhook設定と所有記録を置く、per-userの永続設定。 */
  config_root: () => string;
  /** 製品が同梱するhook入口のファイル名。所有するhookの見分けに使い、製品同士で重ならない名前にする。 */
  hooks: { codex: string; claude: string; cursor: string };
  /** Codex App Serverへ名乗るclient名。 */
  codex_client_name: string;
  /** Codex hook設定のschema名。 */
  codex_hook_schema: string;
  /** 設定ファイルを書き換える前に残す控えの接尾辞（例: ".aiterm-backup"）。 */
  backup_suffix: string;
}

export function codexHookDirectory(profile: ProductProfile): string {
  return path.join(profile.config_root(), "codex-parent-hooks");
}

export function claudeHookRoot(profile: ProductProfile): string {
  return path.join(profile.state_root(), "claude-parent-hooks");
}

export function cursorHookRoot(profile: ProductProfile): string {
  return path.join(profile.state_root(), "cursor-parent-hooks");
}

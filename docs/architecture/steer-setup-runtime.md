> 候補の機能説明。基準初読の記述に、A1–S1の所有者変更を反映した。全fixture/実OSの網羅確認を意味しない。

# Steerのsetup・実行基盤・provider

基準6734ee86の全25実装fileを全文初読。図は [setup/runtime/provider](steer-setup-runtime.svg) / [PNG](steer-setup-runtime.png)。これは実行した設定変更ではない。3OS設定/公式CLI/実配送試験は行っていない。

| 責任 | 実コード | データと作用・失敗先 |
| --- | --- | --- |
| 製品識別とroot | profile.ts | ProductProfileがstate/config root、hook名・schema・backup suffix・dispatch toolを渡す。Steerは呼出元DBを所有しない |
| CLI | cli.ts/codex-hook.ts/codex-wake-main.ts | profile JSONを読んでruntime functionへ渡す。通常CLIはCodex verify/state/submit/setupのみ。hook/wakeは専用入口 |
| file書込/待機 | files.ts | wx temp→rename、0600/0700。writeJson0600/writeHookJsonは既存cleanup差を保持。waitForFileStateはfs.watch＋5秒補助inspect、timeout/abort/errorでwatch/timer/listener解放 |
| process本人性 | process.ts | PID存在、出生identity、argv digest、親lineageを返す。POSIX ps/Windows .NET優先・必要時WMI。lineageの失敗fallbackは既存全process表。観測失敗を死亡と同一視しない |
| Node/PS起動先 | setup-node.ts/windows.ts | Homebrewは同formula opt、live時に消えたnodeはPATHへ。PowerShell7 Coreとcanonical pathを検証し既定probeをcache。5.1へのfallbackなし。引数引用を各起動方式で維持 |
| Codex binary/home | codex-binary.ts | 明示CODEX_BIN→local→PATH、Windows npm shimはnative本体、Desktop各OSとCLIは対応版検証。Windows cache4file SHA、Mac署名。保存binary消失時は同探索を再実行しproduct configだけ更新。探索は本資料作成で実行していない |
| Codex設定計画 | codex-setup.ts planCodexParentHooks | 元JSON/他hook/matcher/順序、自製品位置、他hook移動と空く承認keyを計算。書込前に形式/壊れたsymlinkを拒否。changed=falseは作用しない |
| Codex設定適用 | applyCodexHookPlan/configureCodexSteer | 他hookの既存trust/enabledを新位置へコピー→backup/temp write/readback→空いたkey掃除。自製品を公式hooks/listとconfig APIで承認・readbackしてからproduct configを保存し旧方式解除。途中失敗は一括rollbackせず現在の例外/部分作用を保持 |
| Codex稼働世代 | configureCodexSteer/assertCodexHookParentCurrent | 導入前のPID/開始時刻をstaleとして保持。同じhome以外は除外できる時だけ除く。status=restart_requiredは返却だけで、実restartを行わない。enable再実行で同一hookを末尾へ動かさない |
| Claude/Cursor登録 | hook-setup.ts | 自製品の入口を名前境界付きで判定し、他製品と順序を保持。旧args形式/新shell形式、POSIX/PowerShell引用、Claudeの任意SessionStartを保持。backup→temp rename→deep readback。壊れたJSONを上書きしない |
| Aiterm provider | aiterm-provider.ts | 明示cli→setupのdelivery-provider.json→PATH。明示不正先からfallbackしない。CLIを一回spawnしstdin本文、stdout最後の1行schema/okを解釈。timeoutは自分のCLI childだけをkill。開始後のsend不明はoutcome_unknown。Aitermのstate fileを直接書かない |

configureCodexSteerのstatusもreadback APIや消失binary再探索を呼び得るため、純粋file読取だけと説明しない。disableは自製品hook解除/承認key掃除と設定enabled=falseを保存し、必要なら旧方式解除、結果をrestart_requiredとして返す。restart自体はconsumer/利用者の別工程である。

通常providerの `verify` はthread/cwd/sourceとsteer enabled/disabled、`submit` はqueue受付ID、`state` はstate/hook/turn/queuedと任意wakeを返す。入口欠測、transport、JSON/schema不一致、typed refusalの区別を維持する。Aitermへ依頼する方式と製品独自profile/hook方式は既存の別窓口であり、状態の保存先を一つへ移す設計にはしていない。

テスト/公開物のinventoryは後続作成済み。各fixture本文の独立精査、consumerで使うprofileの具体値、各OSのsetup実行は未確認。CLI/exportの引数や返却を変更する案は現在採用していない。

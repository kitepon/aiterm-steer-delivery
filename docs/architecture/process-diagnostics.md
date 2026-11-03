# process読取の公開契約と診断修理

[担当図](steer-setup-runtime.svg) → [実装](../../src/process.ts) → [全source索引](source-index.md)。現行6734ではnative失敗理由を捨てる。提案修理はProcessTableErrorのcode=2と既prefixに安全JSON suffixを追加するだけで、公開関数signature/export map/state/configは変えない。

| 入口 | OSへの照会 | 成功/不在/失敗 |
| --- | --- | --- |
| readRuntimeProcesses | POSIX ps全表 / Windows PS7 CIM | tableをparse。native拒否はtable失敗、parse不良は既parse例外 |
| readProcessIdentities | 存在照合後POSIX ps指定PID / PS7 .NET・必要時WMI | PID/出生、空集合/消失は空配列、読取不能はidentity失敗。既status1+空stdoutの意味を保持 |
| readProcessLineage | POSIX祖先を最大depth / PS7 .NET | 先祖行。POSIX先頭失敗/Windows読取失敗は全表fallback、途中POSIX失敗は既部分lineage。fallback table失敗だけならprobe=tableを返す |

内部caller: channel.tsのowner/waiter/claim、claude-receiver.tsのhook親/配送本人性、codex-hook-state.tsの親lineage/claim、codex-hooks.tsの自身identity、codex-setup.tsの稼働process一覧。公開index.tsは3読取と関連helperをexportし、外部Aiterm/Bridge等も利用する。CLIはmessageをJSON返却、hookはstderr、Aitermはtool textへ射影する。数値code=2とconsumer側のCLI_FAILED等は別契約である。

提案suffixはcomponent=aiterm-steer-delivery、probe=table/identity/lineage、allowlistされたerror.code（未知はUNKNOWN、error無しnull）、native status/signal、stdout_bytes/stderr_bytes。native message/cause、自由stderr/stdout、command/argv/pathを例外へ保存しない。観測不能は成功/死亡に丸めない。10秒/15秒のtimeout、maxBuffer、既fallback/parse/成功条件を変えない。

対象版の全caller/test/fixture/config/exportはsource-indexと既test群へ接続。新直接fixtureで既失敗に安全detailが残ること、未知code/null出力/UTF8 byte数/秘密sentinel/不在/lineage fallbackを確認する。必要な既channel/Claude/Codex契約を回帰確認する。実Macで起きた旧失敗のerrnoやloaded版はunknown、診断修理は復旧証明にならない。変更前後の直接結果とpack/3OSは担当成果へ固定し、未実施を明示する。

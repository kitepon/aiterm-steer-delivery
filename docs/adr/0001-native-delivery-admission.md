# Native delivery admission（隔離開発）

2026-10-21、feat/cascade-admission。公開版0.4.7へ反映していない。
製品の実行世代/停止fenceは製品が所有し、このlibraryに別graph/ID/配送queue/再送を作らない。

`ProductProfile.delivery_admission={required:true,run(effect,action)}`は、実native作用直前に製品の受付を呼ぶ。
既存delivery_ids、queue/dequeue/emit/wake、vendor、実endpointと最小native_contextだけを渡す。
callbackはactionを一度だけ呼んで応答まで待つ。libraryは本来のnative receiptを維持し、
未発行/重複/逃げたcallback/runnerがnative応答前に返った場合を成功にしない。
`DELIVERY_ADMISSION_CONTRACT`はこの内部callback契約の版/対応を宣言する。暗号認証ではない。

作用口:

- Codex: App Server initialize等の事前照会の後、queue/add直前、同期hookのqueue/delete直前、
  同じhookの実stdout出力（複数existing deliveryを一度で出す場合を含む）、リンクopener直前。
  wakeのキュー確認待ちはnative作用受付の外で行う。
- Claude: answer.jsonの公開、実stderr出力、asyncRewakeのexit-2設定を別段階で受付する。
  required時のhookはresume作用口も必須。拒否/例外をexit 2へ変えず1で返す。
  runtime.identity/parentAliveはfixture注入用で、既定のnative照会を変更しない。
- Cursor: optional profile付きのanswer.json公開、背景受信の実stdout、単一rootのhook実stdout。
  guarded hookはnativeEmitを必須とし、モデル向け返りだけを作って先にleaseを解放しない。
  native conversation_idを製品へ渡す。拒否時はfailed記録を残し、次のreceiverでdelivered_by_hookと偽らない。

callback自体は別processへシリアライズできない。wake profileにはrequired=trueを残し、runを除く。
子processにresolverが無ければopener直前で拒否する。製品は同じstate/socket scopeのresolverを
各hook/receiverへ構築する必要がある。旧profileの省略は既存動作を維持するが、
protected scopeをその旧profileへ戻す配布/混在を製品のcoverage確認無しで許可してはならない。

未対応は隠さない。guarded Cursorの複数root/channel一括出力と長期channelはUNSUPPORTED。
公開alias/consumerで新しいprofile引数を落とさない接続、実native endpoint/世代/turnの証拠、
各processのscope/participant確認、最終process終了/再開の実CLI受入は製品側で未完了。
本段階のfake試験を4CLI実受入や配布/本番反映の完了としない。

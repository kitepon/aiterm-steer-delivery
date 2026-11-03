# channelの保存と出力（正式0.5.1）

[図](channel.svg) / [source](../../src/channel.ts)。全責務はchannel.tsが持つ。channel-state.tsやenqueueChannelはこの版には存在しない。

schema/ChannelError/channelDir、openChannel/readChannel/closeChannel/channelClosed、sendToChannelのinbox保存と到着順dedup、channelDeliveryState/withdrawFromChannel、claimPending/settle、emitClaimed、Claude waiterとCursor hook/background receiverが同fileにある。Codexの送信は公式queueへ委譲する。

本人性はprocess.tsへ依頼する。読取失敗を死亡と判定しない。非Codexのclaimは排他hard link、sendingから出力後emitted、出力例外はunknownを保存してthrowする。settle失敗時に再出力しない。closed印は新送信拒否とwaiter終了を示し、未取得本文は残る。emittedはvendorの開始/業務完了の証明ではない。BridgeはSDK/CLI/既保存形式を利用し、自身のDB/予約/receiptを所有する。

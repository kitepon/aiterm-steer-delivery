#!/usr/bin/env node
// 寝ている会話を起こす見張りの入口。配送を呼んだprocessが、渡す中身を環境変数に入れて起こす。
import { runCodexWakeMain } from "./codex-wake.js";

await runCodexWakeMain();

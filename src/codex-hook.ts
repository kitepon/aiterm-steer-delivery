#!/usr/bin/env node
// CLIで配送を使う製品（Python等）のCodex同期hook入口。hook directory（引数）にある製品の識別情報で動く。
import * as path from "node:path";
import { loadProfile } from "./cli.js";
import { runCodexHookMain } from "./hook-main.js";

const directory = process.argv[2];
if (!directory) {
  process.stderr.write("CODEX_PARENT_HOOK_FAILED: hook directoryがありません\n");
  process.exitCode = 1;
} else {
  await runCodexHookMain(loadProfile(path.join(directory, "profile.json")), directory);
}

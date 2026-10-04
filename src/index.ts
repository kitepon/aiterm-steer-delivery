// aiterm-steer-delivery: Aitermの親配送（steer配送）を製品から使うためのライブラリ。
// 親AIが作業中ならそのturnへ差し込み、idleなら同じ会話へ普通に届ける。受信方式は親ごとに公式の仕組みを使う。
export * from "./profile.js";
export * from "./errors.js";
export { writeJson0600, writeHookJson, waitForFileState, withoutBom } from "./files.js";
export { readRuntimeProcesses, parsePosixProcessTable, type RuntimeProcess, type NativeProcessIdentity } from "./process.js";
export { resolveWindowsPowerShell7, quotePowerShell, windowsPowerShellSync, windowsStartProcessArgumentList } from "./windows.js";
export { setupNodeExecutable } from "./setup-node.js";

export {
  realCodexHome, resolveCodexExecutable, desktopBundledCodex, findDesktopBinary, findWindowsCodexCache,
  findWindowsCodexBinary, findLinuxDesktopBinary, findCliBinary, findSteerBinary, platformDesktopFinder, currentCodexDesktopBinary, type DesktopBinaryFinder,
} from "./codex-binary.js";
export {
  codexHookConfigSchema, readCodexHookConfig, codexInputDirectory, hookInputSchema, answerDigest,
  registerCodexHookInput, finishCodexHookSubmission, codexHookDeliveryState, ownedCodexHooks,
  assertCodexHooksReady, assertCodexHookParentCurrent, type CodexHookConfig,
} from "./codex-hook-state.js";
export {
  codexParentFromRequest, withCodexReceiver, verifyCodexParent, submitCodexParentAnswer,
  type CodexParent, type CodexParentThread, type CodexReceiverRuntime,
} from "./codex-receiver.js";
export { runCodexResultHook } from "./codex-hooks.js";
export {
  codexHookCommand, processCodexHome, mergeCodexParentHooks, planCodexParentHooks, writeCodexHookPlan, applyCodexHookPlan, verifyCodexHookRegistration, configureCodexSteer,
  type CodexHookMove, type CodexHookPlan,
  type CodexSteerAction, type CodexSteerResult, type CodexSteerRuntime,
} from "./codex-setup.js";

export {
  claudeParentSchema, prepareClaudeHookRequest, claudeParentFromRequest, verifyClaudeParent, bindClaudeParentDelivery,
  closeClaudeParentSession, submitClaudeParentAnswer, runClaudeResultHook, type ClaudeParent,
} from "./claude-receiver.js";
export {
  sendClaudeInbox, type ClaudeInboxTarget, type ClaudeInboxSendOptions, type ClaudeInboxSendResult,
} from "./claude-inbox.js";
export {
  cursorParentSchema, isCursorMcpClient, cursorHooksFile, cursorParentHooksRegistered, verifyCursorParent,
  cursorParentFromRequest, prepareCursorDelivery, submitCursorParentAnswer, handleCursorHook, receiveCursorAnswer,
  type CursorParent, type CursorReceiveResult, type CursorReceiveReader,
} from "./cursor-receiver.js";
export { cursorReceiveProcess, runCursorReceive, stdoutOutput, waitProcessCommandLine, type WaitProcess, type ReceiveOutput } from "./cursor-receive.js";
export {
  claudeParentHookEntries, mergeClaudeParentHooks, removeClaudeParentHooks,
  cursorParentHookCommand, mergeCursorParentHooks, removeCursorParentHooks, commandNamesFile, type HookRuntime,
} from "./hook-setup.js";
export { runCodexHookMain, runClaudeHookMain, runCursorHookMain, runCursorReceiveMain, isDirectExecution } from "./hook-main.js";
export { runChannelReceiveMain } from "./hook-main.js";
export {
  openChannel, readChannel, channelClosed, closeChannel, sendToChannel, channelDeliveryState, withdrawFromChannel, runClaudeChannelWaiter,
  closeClaudeSessionChannels, channelIdFromResult, channelMarker, handleCursorChannelHook, channelReceiveProcess, receiveFromChannel,
  ChannelError, type Channel, type ChannelKind, type ChannelDeliveryState, type ChannelReceiveResult,
} from "./channel.js";

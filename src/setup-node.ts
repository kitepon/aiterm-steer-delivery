import { accessSync, constants, existsSync } from "node:fs";
import { SetupError } from "./errors.js";

const BREW_NODE = /^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/;

// HomebrewのCellar実体は更新で消える。保存する起動先には同じformulaのoptを使う。
export function setupNodeExecutable(executable = process.execPath): string {
  const brew = BREW_NODE.exec(executable);
  if (!brew) return executable;
  const node = `${brew[1]}/opt/${brew[2]}/bin/node`;
  try { accessSync(node, constants.X_OK); }
  catch { throw new SetupError("node_runtime_unavailable", "HomebrewのNode起動先を実行できません。Nodeの導入状態を確認してください"); }
  return node;
}

/**
 * このprocessのNodeを、後からでも起こせる場所で返す。自分でNodeを起こす時と、呼び手へ「起こす先」として渡す時に使う。
 * `process.execPath`は起きた時の実体で、長く動くprocessでは後から消える事がある（Homebrewは版ごとの場所へ入れ、更新で前の版を消す。
 * 2026-10-12、MacでNodeが26.10.0_1から26.11.1へ上がり、前の版から起きていたprocessが、無いNodeを起こそうとして黙って失敗していた）。
 * Homebrewの時は同じformulaのopt（更新でも残る）を返す。実体が消えていて代わりも無い時は、PATHから探させる（`node`）。
 */
export function liveNodeExecutable(executable = process.execPath, exists: (file: string) => boolean = existsSync): string {
  const brew = BREW_NODE.exec(executable);
  if (brew) {
    const opt = `${brew[1]}/opt/${brew[2]}/bin/node`;
    if (exists(opt)) return opt;
  }
  return exists(executable) ? executable : "node";
}

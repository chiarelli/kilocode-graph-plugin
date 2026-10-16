/**
 * `trigger.ts` — decide full vs incremental (E3a-S4; guarda de ancestralidade na
 * E3a-S6a, §4).
 *
 * - **1º uso do workspace** (manifest ausente/vazio) ⇒ `index_path` (full).
 * - **Depois** ⇒ `incremental_index` com `use_git:true` e
 *   `git_range:{from: manifest.last_git_head, to:"HEAD"}` — **desde que** o
 *   `last_git_head` seja **ancestral** de HEAD (§4). Um checkout para trás, rebase
 *   ou divergência faz o incremental rodar com range inválido; a guarda
 *   (`git merge-base --is-ancestor`) cai em **full** nesse caso.
 * - Sem `last_git_head` (1º uso) ⇒ full.
 *
 * Mudanças não-commitadas ficam de fora do MVP (o modo git não as pega —
 * FR-507/§10). Módulo **puro** (sem I/O): a guarda entra como **predicado**
 * injetado (`isAncestor`), preservando a testabilidade sem spawn.
 */

import type { IndexMode } from "./runner.ts";

/** Decisão de gatilho: modo + range (quando incremental). */
export interface TriggerDecision {
  mode: IndexMode;
  /** Presente só no incremental: `{from: last_git_head, to: "HEAD"}`. */
  gitRange?: { from: string; to: string };
}

/** Estado mínimo do manifest que decide o modo. */
export interface TriggerInput {
  files: string[];
  last_git_head: string | null;
}

/** Opções da decisão: a guarda de ancestralidade (§4), injetada. */
export interface TriggerOptions {
  /**
   * `true` quando `from` (`last_git_head`) é ancestral de HEAD. Ausente ⇒ sem
   * guarda (comportamento S4: só a presença de `last_git_head` decide) — usado
   * pelos testes que não falam com git.
   */
  isAncestor?: (from: string) => boolean;
}

/**
 * Decide o modo com base no manifest. Vazio/sem head ⇒ full; com head **e
 * ancestral de HEAD** ⇒ incremental a partir dele; head não-ancestral (checkout
 * para trás/rebase/divergência) ⇒ full (§4).
 */
export function decideTrigger(
  manifest: TriggerInput,
  opts: TriggerOptions = {},
): TriggerDecision {
  if (manifest.files.length === 0 || !manifest.last_git_head) {
    return { mode: "full" };
  }
  // Guarda de ancestralidade (§4): nunca roda incremental com range inválido.
  if (opts.isAncestor && !opts.isAncestor(manifest.last_git_head)) {
    return { mode: "full" };
  }
  return {
    mode: "incremental",
    gitRange: { from: manifest.last_git_head, to: "HEAD" },
  };
}

/**
 * Gate do sentinela (§3): um **incremental** só pode iniciar se o sentinela
 * `graph-ready` existir (o full inicial já concluiu). O full do 1º uso **não** é
 * gated — é ele quem cria o sentinela. Pura: recebe a decisão e o estado do
 * sentinela, devolve `true` quando deve aguardar (não rodar).
 */
export function shouldWaitForReady(
  decision: TriggerDecision,
  ready: boolean,
): boolean {
  return decision.mode === "incremental" && !ready;
}

/** Chave do `HEAD` a gravar no manifest após um sync. */
export const HEAD_REF = "HEAD";

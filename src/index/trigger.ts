/**
 * `trigger.ts` — decide full vs incremental (E3a-S4).
 *
 * - **1º uso do workspace** (manifest ausente/vazio) ⇒ `index_path` (full).
 * - **Depois** ⇒ `incremental_index` com `use_git:true` e
 *   `git_range:{from: manifest.last_git_head, to:"HEAD"}`.
 * - Sem `last_git_head` (1º uso) ⇒ full.
 *
 * Mudanças não-commitadas ficam de fora do MVP (o modo git não as pega —
 * FR-507/§10). Módulo **puro** (sem I/O): recebe o manifest, devolve a decisão.
 */

import type { IndexMode } from "./runner.ts";

/** Decisão de gatilho: modo + range (quando incremental). */
export interface TriggerDecision {
  mode: IndexMode;
  /** Presente só no incremental: `{from: last_git_head, to: "HEAD"}`. */
  gitRange?: { from: string; to: string };
}

/**
 * Decide o modo com base no manifest. Vazio/sem head ⇒ full; com head ⇒
 * incremental a partir dele até `HEAD`.
 */
export function decideTrigger(manifest: {
  files: string[];
  last_git_head: string | null;
}): TriggerDecision {
  if (manifest.files.length === 0 || !manifest.last_git_head) {
    return { mode: "full" };
  }
  return {
    mode: "incremental",
    gitRange: { from: manifest.last_git_head, to: "HEAD" },
  };
}

/** Chave do `HEAD` a gravar no manifest após um sync. */
export const HEAD_REF = "HEAD";

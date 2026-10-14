/**
 * Orçamento da injeção de memória (E2-S1 tracer; endurecido na E2-S2).
 *
 * Duas camadas de corte (decisão 3 da spec): o **servidor** corta por
 * `max_tokens` (A1, por fato inteiro) e o **cliente** reafirma dois tetos —
 * `maxMemories` (nº de fatos) e `maxChars` (teto de chars do bloco final). O
 * corte é sempre **por fato inteiro** (nunca um fato pela metade), mesma
 * filosofia do A1 do servidor.
 *
 * `applyBudget` é puro: quando `maxChars` está setado, recebe o render do bloco
 * (`render`, injetado por `memory.ts`) só para medir — assim este módulo não
 * depende do formato do bloco (evita ciclo) e continua testável isolado.
 */

import type { Fact } from "../client.ts";

/** Limites do orçamento de injeção (subconjunto da config `inject.*`). */
export interface Budget {
  /** Nº máximo de fatos injetados. */
  maxMemories: number;
  /** Teto de chars do bloco final. `undefined`/negativo ⇒ sem teto de chars. */
  maxChars?: number;
}

/** Render do bloco (usado para medir o teto de `maxChars`). */
export type RenderFacts = (facts: Fact[]) => string;

/**
 * Aplica o orçamento do cliente, em duas etapas:
 *   1. corta ao teto `maxMemories` (mantém os mais relevantes — o recall
 *      devolve os melhores primeiro);
 *   2. se `maxChars` está setado, descarta fatos **inteiros** do fim até o bloco
 *      (`render`) caber no teto. Um único fato maior que o teto é descartado
 *      também (⇒ lista vazia ⇒ sem injeção, nunca um bloco estourado).
 *
 * Um teto de fatos não-positivo devolve lista vazia (degrada a "sem memória",
 * nunca injeta tudo).
 */
export function applyBudget(
  facts: Fact[],
  cfg: Budget,
  render?: RenderFacts,
): Fact[] {
  let kept = cfg.maxMemories <= 0 ? [] : facts.slice(0, cfg.maxMemories);
  if (cfg.maxChars === undefined || render === undefined) return kept;
  while (kept.length > 0 && render(kept).length > cfg.maxChars) {
    kept = kept.slice(0, -1);
  }
  return kept;
}

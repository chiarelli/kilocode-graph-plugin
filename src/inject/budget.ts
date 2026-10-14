/**
 * Orçamento da injeção de memória (E2-S1 tracer; endurecido na E2-S2).
 *
 * Duas camadas de corte (decisão 3 da spec): o **servidor** corta por
 * `max_tokens` (A1, por fato inteiro) e o **cliente** reafirma o teto de nº de
 * fatos (`maxMemories`). O corte de chars (`maxChars`) chega na E2-S2 — na
 * fatia tracer só há `maxMemories`.
 *
 * O corte é sempre **por fato inteiro** (nunca um fato pela metade), mesma
 * filosofia do A1 do servidor. Puro e testável — não toca rede nem config.
 */

import type { Fact } from "../client.ts";

/** Limites do orçamento de injeção (subconjunto da config `inject.*`). */
export interface Budget {
  /** Nº máximo de fatos injetados. */
  maxMemories: number;
  // TODO(tracer-bullet): `maxChars` (teto de chars do bloco final) — E2-S2
  // corta fatos inteiros do fim até o bloco caber (mesma filosofia do A1).
}

/**
 * Aplica o orçamento do cliente: corta a lista de fatos ao teto `maxMemories`,
 * do fim (mantém os mais relevantes, que o recall devolve primeiro). Um teto
 * não-positivo devolve lista vazia (degrada a "sem memória", nunca injeta tudo).
 */
export function applyBudget(facts: Fact[], cfg: Budget): Fact[] {
  if (cfg.maxMemories <= 0) return [];
  return facts.slice(0, cfg.maxMemories);
}

/**
 * Injeção de memória — do texto do usuário ao bloco injetado (E2-S1 tracer).
 *
 * Fluxo: `client.recall(query)` → `applyBudget` → formata o bloco com
 * procedência (`[CONTEXTO DE MEMÓRIA]`, sentinela `graph-memory` — FR-105).
 * Resposta vazia ⇒ `null` (não injeta bloco vazio).
 *
 * Puro no que dá: recebe o client (injetável) e a config; não lê env/arquivo.
 * O hook (`hooks/messages.ts`) é thin e só liga isto ao transform.
 *
 * Endurecimento (E2-S2): `maxChars` (corte por fato inteiro), `max_tokens` no
 * request, `tokens_estimated`/`truncated`, dedup por turno e log detalhado de
 * degradação. Aqui só o mínimo do tracer (`maxMemories` + `limit`).
 */

import type { Fact, MemtierClient } from "../client.ts";
import { applyBudget, type Budget } from "./budget.ts";

/** Sentinela do bloco de memória (não colide com `ov-memory` do antecessor). */
export const MEMORY_SENTINEL = "graph-memory";

/** Título do bloco — procedência visível ao modelo (FR-105). */
export const MEMORY_HEADER = "[CONTEXTO DE MEMÓRIA]";

/** Config da injeção consumida por `recallAndFormat` (subconjunto de `inject.*`). */
export interface RecallConfig extends Budget {
  /** `null` desliga o teto de chars (E2-S2). Ausente ⇒ sem teto no tracer. */
  maxChars?: number;
}

/** Só o que `memory.ts` precisa do client (permite stub estreito em teste). */
export type RecallClient = Pick<MemtierClient, "recall">;

/**
 * Formata um fato como linha, com procedência temporal quando houver `valid_at`.
 * `invalid_at` não aparece (o recall só devolve vigentes). Fato sem `valid_at`
 * não mostra data.
 */
function formatFact(fact: Fact): string {
  const suffix = fact.valid_at ? ` (válido desde ${fact.valid_at})` : "";
  return `- ${fact.fact}${suffix}`;
}

/**
 * Monta o bloco injetado (procedência + sentinela). Lista vazia ⇒ `null` — o
 * chamador não injeta bloco vazio.
 */
export function formatMemoryBlock(facts: Fact[]): string | null {
  if (facts.length === 0) return null;
  const lines = facts.map(formatFact).join("\n");
  return `\n\n<context ${MEMORY_SENTINEL}="true">\n${MEMORY_HEADER}\n${lines}\n</context>`;
}

/**
 * Recall + formatação. Devolve o bloco pronto para virar um part injetado, ou
 * `null` quando não há o que injetar (0 fatos após o orçamento).
 *
 * **Lança** o erro do client (HTTP tipado / transporte) — quem chama é o hook,
 * que degrada sem quebrar o turno (NFR-03). Manter o lançamento aqui deixa a
 * política de degradação num único ponto (o hook).
 */
export async function recallAndFormat(
  client: RecallClient,
  cfg: RecallConfig,
  query: string,
): Promise<string | null> {
  // TODO(tracer-bullet): enviar `max_tokens` (A1) e respeitar
  // `tokens_estimated`/`truncated`; dedup por turno — E2-S2.
  const result = await client.recall(query, { limit: cfg.maxMemories });
  const facts = applyBudget(result.facts, cfg);
  return formatMemoryBlock(facts);
}

/**
 * Orçamento da injeção — **só corte de contagem** (ADR-009, decisão 3).
 *
 * O ADR-009 trocou o modelo de limites: a unidade única é **tokens** e o teto de
 * volume vive **no servidor**, um por endpoint (`max_tokens` no body de cada
 * rota). O teto de chars do cliente (bloco conjunto) e o `max_tokens`
 * compartilhado **morreram** — não há mais o que medir em chars no cliente. Este
 * módulo fica só com o corte por **contagem**, sempre **por fato/chunk inteiro**
 * (nunca pela metade), a mesma filosofia do A1 do servidor.
 *
 * `applyJointBudget` continua sendo **um** ponto de composição das duas famílias
 * (memória + código) para não espalhar a lógica pelo hook; sem teto conjunto, ele
 * só aplica os tetos independentes de contagem.
 */

import type { CodeChunkHit, Fact } from "../client.ts";

/** Limites do orçamento de injeção (subconjunto da config `inject.*`). */
export interface Budget {
  /** Nº máximo de fatos injetados. */
  maxMemories: number;
}

/**
 * Orçamento CONJUNTO das duas famílias (E3c-S2, decisão 3 do ADR-004; reduzido a
 * contagem pelo ADR-009): `maxMemories` e `maxCodeChunks` são cortes
 * independentes por família.
 */
export interface JointBudget {
  maxMemories: number;
  maxCodeChunks: number;
}

/** Resultado do orçamento conjunto: o que sobrevive de cada família. */
export interface JointBudgetResult {
  facts: Fact[];
  chunks: CodeChunkHit[];
}

/**
 * Aplica o orçamento do cliente: corta ao teto `maxMemories` (mantém os mais
 * relevantes — o recall devolve os melhores primeiro).
 *
 * Um teto de fatos não-positivo devolve lista vazia (degrada a "sem memória",
 * nunca injeta tudo).
 */
export function applyBudget(facts: Fact[], cfg: Budget): Fact[] {
  return cfg.maxMemories <= 0 ? [] : facts.slice(0, cfg.maxMemories);
}

/**
 * Orçamento CONJUNTO das duas famílias (E3c-S2, decisão 3 do ADR-004; ADR-009
 * decisão 3 o reduz a contagem). Aplica os tetos independentes
 * (`maxMemories`, `maxCodeChunks`) — **nenhum** corte por char. O corte é por
 * família e por item inteiro; um teto não-positivo da família devolve lista vazia.
 */
export function applyJointBudget(
  facts: Fact[],
  chunks: CodeChunkHit[],
  cfg: JointBudget,
): JointBudgetResult {
  return {
    facts: applyBudget(facts, { maxMemories: cfg.maxMemories }),
    chunks: cfg.maxCodeChunks <= 0 ? [] : chunks.slice(0, cfg.maxCodeChunks),
  };
}

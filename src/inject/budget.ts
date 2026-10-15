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

import type { CodeChunkHit, Fact } from "../client.ts";

/** Limites do orçamento de injeção (subconjunto da config `inject.*`). */
export interface Budget {
  /** Nº máximo de fatos injetados. */
  maxMemories: number;
  /**
   * Teto de chars do bloco final. `undefined`/negativo/`0` ⇒ sem teto de chars
   * (é o que o contrato promete; `negativo` não pode desligar a injeção).
   */
  maxChars?: number;
}

/**
 * Orçamento CONJUNTO das duas famílias (E3c-S2, decisão 3 da spec): `maxChars` é
 * o teto do **total** (memória + código), não de cada bloco. `maxMemories` e
 * `maxCodeChunks` continuam sendo cortes independentes por família.
 */
export interface JointBudget {
  maxMemories: number;
  maxCodeChunks: number;
  /** Teto de chars do TOTAL injetado (memória + código). */
  maxChars?: number;
}

/** Resultado do orçamento conjunto: o que sobrevive de cada família. */
export interface JointBudgetResult {
  facts: Fact[];
  chunks: CodeChunkHit[];
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
  // Teto NÃO-positivo ⇒ sem teto de chars (contrato da interface). Sem este
  // guard, `maxChars` negativo drenava a lista até vazio (comparar
  // `length > -N` é sempre verdadeiro) e a injeção morria em silêncio.
  if (cfg.maxChars === undefined || cfg.maxChars <= 0 || render === undefined) {
    return kept;
  }
  while (kept.length > 0 && render(kept).length > cfg.maxChars) {
    kept = kept.slice(0, -1);
  }
  return kept;
}

/** Mede o TOTAL (memória + código) para o teto conjunto. */
export type RenderTotal = (facts: Fact[], chunks: CodeChunkHit[]) => number;

/**
 * Orçamento CONJUNTO das duas famílias (E3c-S2, decisão 3 da spec).
 *
 * Ordem do corte, quando o TOTAL (`maxChars`) estoura:
 *   1. aplica os tetos independentes (`maxMemories`, `maxCodeChunks`);
 *   2. corta **fatos inteiros de memória** primeiro, do fim para o começo
 *      (**código tem prioridade** — código truncado não compila);
 *   3. só se ainda estourar, corta **chunks inteiros de código**, do fim.
 *
 * Um chunk nunca é cortado pela metade (mesma regra do servidor). Um teto
 * não-positivo (`undefined`/`0`/negativo) ⇒ sem teto conjunto (contrato do
 * `maxChars`, igual ao `applyBudget`).
 */
export function applyJointBudget(
  facts: Fact[],
  chunks: CodeChunkHit[],
  cfg: JointBudget,
  renderTotal: RenderTotal,
): JointBudgetResult {
  let keptFacts = cfg.maxMemories <= 0 ? [] : facts.slice(0, cfg.maxMemories);
  let keptChunks =
    cfg.maxCodeChunks <= 0 ? [] : chunks.slice(0, cfg.maxCodeChunks);
  if (cfg.maxChars === undefined || cfg.maxChars <= 0) {
    return { facts: keptFacts, chunks: keptChunks };
  }
  // 2. memória cede primeiro (do fim), chunk inteiro por vez.
  while (keptFacts.length > 0 && renderTotal(keptFacts, keptChunks) > cfg.maxChars) {
    keptFacts = keptFacts.slice(0, -1);
  }
  // 3. só então o código cede (do fim), chunk inteiro por vez.
  while (keptChunks.length > 0 && renderTotal(keptFacts, keptChunks) > cfg.maxChars) {
    keptChunks = keptChunks.slice(0, -1);
  }
  return { facts: keptFacts, chunks: keptChunks };
}

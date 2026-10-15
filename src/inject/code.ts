/**
 * Injeção de código — do texto do usuário ao bloco injetado (E3c-S1 tracer;
 * endurecido na E3c-S2).
 *
 * Molde do `memory.ts`: `client.searchCode(query)` → (orçamento) → formata o
 * bloco com procedência por chunk (`[CÓDIGO RELEVANTE — path:inicio-fim]`,
 * sentinela `graph-code` — FR-105). Resposta vazia ⇒ `null` (nunca injeta bloco
 * vazio).
 *
 * Sanitização (decisão 4 da spec): o `code` vem do repositório — conteúdo
 * externo, como o `fact`. Um arquivo contendo `</context>` fecharia a sentinela
 * e injetaria texto fora do envelope. Neutralizamos `<`/`>` do `code` e do
 * `path` (`&lt;`/`&gt;`) **preservando** as quebras de linha e a indentação —
 * elas são o conteúdo e não podem ser achatadas como no fato.
 *
 * O wrapper (`<context graph-code="true">` … `</context>`) é nosso e fica
 * intacto: depois da neutralização, nenhuma tag pode ser aberta ou fechada pelo
 * conteúdo do repo.
 */

import type { CodeChunkHit, MemtierClient, SearchCodeOpts, SearchCodeResult } from "../client.ts";
import { log } from "../logger.ts";

/** Sentinela do bloco de código (distinta da de memória — FR-105). */
export const CODE_SENTINEL = "graph-code";

/** Título do bloco de código (procedência visível ao modelo). */
export const CODE_HEADER = "CÓDIGO RELEVANTE";

/** Config da injeção de código consumida por `code.ts` (subconjunto de `inject.*`). */
export interface CodeConfig {
  /** Nº máximo de chunks injetados (o mesmo valor vai no `limit` da busca). */
  maxCodeChunks: number;
  /** Teto de tokens no servidor (A1). `undefined` ⇒ sem orçamento A1. */
  maxTokens?: number;
  /** Teto da chamada de busca (ms) — governa o `AbortSignal`. */
  timeoutMs?: number;
}

/** O que `code.ts` precisa do client (permite stub estreito em teste). */
export type SearchClient = Pick<MemtierClient, "searchCode">;

/**
 * Neutraliza `<`/`>` do texto vindo do repo (`&lt;`/`&gt;`). Preserva quebras
 * de linha e indentação — são o conteúdo do código, não ruído.
 */
function sanitizeCodeText(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Cabeçalho de procedência de um chunk (`[CÓDIGO RELEVANTE — path:ini-fim]`). */
function chunkHeader(chunk: CodeChunkHit): string {
  return (
    `[${CODE_HEADER} — ${sanitizeCodeText(chunk.path)}:` +
    `${chunk.start_line}-${chunk.end_line}]`
  );
}

/**
 * Monta o bloco injetado (procedência por chunk + sentinela). Lista vazia ⇒
 * `null` — o chamador não injeta bloco vazio. Cada chunk é precedido pelo seu
 * cabeçalho e o texto é sanitizado (nunca confie no repo).
 */
export function formatCodeBlock(chunks: CodeChunkHit[]): string | null {
  if (chunks.length === 0) return null;
  const sections = chunks
    .map((c) => `${chunkHeader(c)}\n${sanitizeCodeText(c.code)}`)
    .join("\n\n");
  return `\n\n<context ${CODE_SENTINEL}="true">\n${sections}\n</context>`;
}

/** Teto da chamada de busca como `AbortSignal` (ou `undefined` sem teto). */
function timeoutSignal(cfg: CodeConfig): AbortSignal | undefined {
  return cfg.timeoutMs && cfg.timeoutMs > 0
    ? AbortSignal.timeout(cfg.timeoutMs)
    : undefined;
}

/** Opções de `searchCode` derivadas da config (limit/max_tokens/signal). */
function searchOpts(cfg: CodeConfig, signal?: AbortSignal): SearchCodeOpts {
  const opts: SearchCodeOpts = { limit: cfg.maxCodeChunks };
  if (cfg.maxTokens !== undefined) opts.maxTokens = cfg.maxTokens;
  if (signal) opts.signal = signal;
  return opts;
}

/** Loga o envelope A1 quando o servidor devolve `truncated`. */
function logBudget(result: SearchCodeResult): void {
  if (result.truncated) {
    log(
      `code_search truncated tokens_estimated=${result.tokensEstimated ?? "?"} ` +
        `(orçamento A1)`,
    );
  }
}

/**
 * Busca + corte por chunk inteiro + formatação, sem estado. Devolve o bloco
 * pronto ou `null` quando não há o que injetar (0 chunks). **Lança** o erro do
 * client — quem chama (o hook) degrada.
 *
 * TODO(tracer-bullet): o orçamento do TOTAL (`maxChars` compartilhado com a
 * memória, corte de chunks do fim — decisão 3) entra na E3c-S2.
 */
export async function searchAndFormat(
  client: SearchClient,
  cfg: CodeConfig,
  query: string,
  signal?: AbortSignal,
): Promise<string | null> {
  // Teto não-positivo ⇒ nada a injetar. Nunca buscar: `limit:0` é 422 no
  // servidor (ge=1) e um round-trip perdido no caminho crítico do turno.
  if (cfg.maxCodeChunks <= 0) return null;
  const result = await client.searchCode(
    query,
    searchOpts(cfg, signal ?? timeoutSignal(cfg)),
  );
  logBudget(result);
  const kept = result.chunks.slice(0, cfg.maxCodeChunks);
  return formatCodeBlock(kept);
}

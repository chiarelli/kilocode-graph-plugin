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
  /** Teto de tokens do endpoint de busca (ADR-009). `undefined` ⇒ sem teto A1. */
  codeMaxTokens?: number;
  /** Teto da chamada de busca (ms) — governa o `AbortSignal`. */
  timeoutMs?: number;
  /**
   * D5 — labels enviados na busca. `undefined` ⇒ o servidor usa o default dele
   * (`CodeChunk`). O plugin passa `["CodeSymbol"]` por default (config).
   *
   * Efeito da troca: só chunks de SÍMBOLO são injetados; `FullFile`/
   * `Contextual` deixam de aparecer. `[]` equivale a `undefined` (o client
   * filtra itens vazios e omite o campo — `labels: []` é 422 no servidor).
   */
  labels?: string[];
  /**
   * D7 — piso de relevância enviado ao servidor. `undefined` ⇒ o campo NÃO vai
   * no body (nenhum comportamento muda). Com servidor que não honra o campo, a
   * degradação é logada uma vez por turno (ver `warnIfFloorNotHonored`).
   */
  minScore?: number;
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

/** Opções de `searchCode` derivadas da config (limit/max_tokens/labels/piso/signal). */
function searchOpts(cfg: CodeConfig, signal?: AbortSignal): SearchCodeOpts {
  const opts: SearchCodeOpts = { limit: cfg.maxCodeChunks };
  if (cfg.codeMaxTokens !== undefined) opts.maxTokens = cfg.codeMaxTokens;
  if (cfg.labels !== undefined) opts.labels = cfg.labels;
  if (cfg.minScore !== undefined) opts.minScore = cfg.minScore;
  if (signal) opts.signal = signal;
  return opts;
}

/**
 * Degradação VISÍVEL do piso (D7 / decisão 6 do ADR-009): um servidor antigo
 * ignora `min_score` em silêncio (pydantic descarta campo extra) e devolve
 * chunks sem `raw_score` — o operador acharia que o piso está valendo.
 *
 * Critério: precisa haver ALGUM chunk sem `raw_score` (não "nenhum com"): um
 * servidor parcialmente compatível não pode degradar em silêncio para os
 * chunks que ficaram sem o campo. Lista vazia não avisa — não há o que julgar.
 *
 * Devolve `true` quando avisou, para quem chama manter "uma vez por turno" sem
 * reimplementar a condição (que divergiria do aviso).
 */
function warnIfFloorNotHonored(
  cfg: CodeConfig,
  chunks: CodeChunkHit[],
  escopo: string,
): boolean {
  if (cfg.minScore === undefined) return false;
  // Piso fora de [0,1] nem chega ao body (o client omite): avisar aqui
  // culparia o servidor por uma decisão do cliente.
  if (!Number.isFinite(cfg.minScore) || cfg.minScore < 0 || cfg.minScore > 1) {
    return false;
  }
  if (chunks.length === 0) return false;
  const semRaw = chunks.filter((chunk) => typeof chunk.raw_score !== "number");
  if (semRaw.length === 0) return false;
  log(
    `code_search: min_score=${cfg.minScore} configurado mas o servidor NÃO ` +
      `honrou o piso em ${semRaw.length}/${chunks.length} chunk(s) ` +
      `(sem raw_score) — esses seguem SEM filtro de relevância ` +
      `(${escopo})`,
  );
  return true;
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

/** Identidade de um chunk no turno (`path:start-end` — spec §6, sem `chunk_md5`). */
export function chunkIdentity(chunk: CodeChunkHit): string {
  return `${chunk.path}:${chunk.start_line}-${chunk.end_line}`;
}

/** Remove repetições da própria resposta (mesma identidade ⇒ um só chunk). */
function dedupeByIdentity(chunks: CodeChunkHit[]): CodeChunkHit[] {
  const seen = new Set<string>();
  const out: CodeChunkHit[] = [];
  for (const c of chunks) {
    const id = chunkIdentity(c);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(c);
  }
  return out;
}

/**
 * O que uma passada de busca devolve ANTES de formatar (E3c-S2): os chunks
 * filtrados pelo dedup do turno e cortados ao teto `maxCodeChunks`. Não há mais
 * teto de chars no cliente (ADR-009): o volume é limitado no servidor pelo
 * `max_tokens` por endpoint.
 */
export interface CodePrep {
  chunks: CodeChunkHit[];
  searchMs: number;
}

/**
 * Busca + corte por `maxCodeChunks`, sem formatar. Devolve os chunks prontos ou
 * `[]` quando não há o que injetar. **Lança** o erro do client.
 */
async function runSearch(
  client: SearchClient,
  cfg: CodeConfig,
  query: string,
  signal?: AbortSignal,
): Promise<{ chunks: CodeChunkHit[]; searchMs: number }> {
  const start = Date.now();
  const result = await client.searchCode(
    query,
    searchOpts(cfg, signal ?? timeoutSignal(cfg)),
  );
  const searchMs = Date.now() - start;
  logBudget(result);
  const kept = result.chunks.slice(0, Math.max(0, cfg.maxCodeChunks));
  return { chunks: kept, searchMs };
}

/**
 * Busca + corte por chunk inteiro + formatação, sem estado. Devolve o bloco
 * pronto ou `null` quando não há o que injetar (0 chunks). **Lança** o erro do
 * client — quem chama (o hook) degrada.
 *
 * Não há teto de chars no cliente (ADR-009): o volume é limitado no servidor
 * pelo `max_tokens` do endpoint. Este é o caminho só-de-código.
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
  const { chunks } = await runSearch(client, cfg, query, signal);
  // Caminho avulso não tem estado de turno: uma chamada = um aviso.
  warnIfFloorNotHonored(cfg, chunks, "busca avulsa");
  return formatCodeBlock(chunks);
}

/**
 * Injetor de código com **dedup por turno** (E3c-S2, decisão 6): a mesma
 * identidade de chunk (`path:start-end`) não é reinjetada no mesmo turno. O
 * `turnoId` é o **mesmo** da memória (o `id` da `UserMessage`) — as duas
 * famílias governam-se pelo mesmo turno.
 *
 * `prepare` (recall/busca) e `commit` (dedup + formatação) são separados para o
 * orquestrador rodar as duas buscas em PARALELO (decisão 2) e só então aplicar o
 * orçamento conjunto.
 */
export class CodeInjector {
  private readonly client: SearchClient;
  private readonly cfg: CodeConfig;
  private turnoId: string | null = null;
  private injectedThisTurn = false;
  private floorWarnedThisTurn = false;
  private readonly seen = new Set<string>();

  constructor(client: SearchClient, cfg: CodeConfig) {
    this.client = client;
    this.cfg = cfg;
  }

  /** Sincroniza o turno (limpa o dedup ao trocar de `turnoId`); `true` = pode tentar. */
  beginTurn(turnoId: string): boolean {
    if (turnoId !== this.turnoId) {
      this.turnoId = turnoId;
      this.seen.clear();
      this.injectedThisTurn = false;
      this.floorWarnedThisTurn = false;
    }
    return !this.injectedThisTurn;
  }

  /**
   * Busca e devolve os chunks filtrados pelo dedup (contra o já injetado no
   * turno E contra duplicatas da própria resposta), cortados ao teto
   * `maxCodeChunks`. `null` ⇒ nada a preparar (turno já injetou / teto zero).
   * **Lança** o erro do client — o orquestrador decide degradar.
   */
  async prepare(turnoId: string, query: string): Promise<CodePrep | null> {
    if (!this.beginTurn(turnoId)) return null;
    if (this.cfg.maxCodeChunks <= 0) return null;
    const { chunks, searchMs } = await runSearch(this.client, this.cfg, query);
    const fresh = dedupeByIdentity(
      chunks.filter((c) => !this.seen.has(chunkIdentity(c))),
    );
    // Uma vez por turno, não por passada: o hook pode chamar `prepare` mais de
    // uma vez no mesmo turno (novas mensagens) e o aviso não pode virar spam.
    // Marca só quando houve de fato degradação (chunks sem `raw_score`), para
    // que um turno sem resultado ainda avise se o próximo resultado degradar.
    if (!this.floorWarnedThisTurn) {
      this.floorWarnedThisTurn = warnIfFloorNotHonored(
        this.cfg,
        fresh,
        "injeção do turno",
      );
    }
    return { chunks: fresh, searchMs };
  }

  /**
   * Commita o resultado de `prepare` com a lista final (o orçamento conjunto pode
   * ter cortado mais). Marca o dedup e devolve o bloco — `null` quando a lista
   * final ficou vazia.
   */
  commit(prep: CodePrep, chunks: CodeChunkHit[]): CodeInjectionResult | null {
    this.injectedThisTurn = true;
    for (const c of chunks) this.seen.add(chunkIdentity(c));
    const block = formatCodeBlock(chunks);
    if (!block) return null;
    const injection: CodeInjectionResult = {
      block,
      chunks: chunks.length,
      chars: block.length,
      searchMs: prep.searchMs,
    };
    logCodeInjection(injection);
    return injection;
  }
}

/** Resultado de uma injeção de código — bloco + métricas do turno (base do E7). */
export interface CodeInjectionResult {
  /** Bloco formatado, pronto para virar um part de texto. */
  block: string;
  /** Nº de chunks injetados (após orçamento e dedup). */
  chunks: number;
  /** Chars do bloco injetado. */
  chars: number;
  /** Latência da busca HTTP (ms). */
  searchMs: number;
}

/** Linha de observabilidade do turno (E7): code_search_ms/chunks/injected_chars. */
export function logCodeInjection(m: CodeInjectionResult): void {
  log(
    `inject_code search_ms=${m.searchMs} chunks=${m.chunks} ` +
      `injected_chars=${m.chars}`,
  );
}

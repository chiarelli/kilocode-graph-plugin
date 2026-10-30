/**
 * Injeção de memória — do texto do usuário ao bloco injetado (E2-S1 tracer;
 * endurecido na E2-S2).
 *
 * Fluxo: `client.recall(query)` → (dedup por turno) → `applyBudget` → formata o
 * bloco com procedência (`[CONTEXTO DE MEMÓRIA]`, sentinela `graph-memory` —
 * FR-105). Resposta vazia ⇒ `null` (não injeta bloco vazio).
 *
 * Endurecimento (E2-S2): `max_tokens` no request (A1), `timeout_ms` como
 * `AbortSignal` da chamada, dedup por turno (não reinjeta a mesma memória —
 * FR-104), health gate opcional e log de `truncated`.
 *
 * ADR-009: o teto de volume é **por endpoint** (`memoryMaxTokens` → `max_tokens`
 * no body de `/v1/recall`); o corte de chars do cliente morreu.
 * `maxMemories` segue como corte de **contagem**.
 *
 * Recebe o client (injetável) e a config; não lê env/arquivo. O hook
 * (`hooks/messages.ts`) é thin e só liga isto ao transform.
 */

import type { Fact, MemtierClient, RecallOpts, RecallResult } from "../client.ts";
import { debug, log } from "../logger.ts";
import { applyBudget, type Budget } from "./budget.ts";
import { isValidUuid } from "./uuid.ts";

/** Sentinela do bloco de memória (não colide com `ov-memory` do antecessor). */
export const MEMORY_SENTINEL = "graph-memory";

/** Título do bloco — procedência visível ao modelo (FR-105). */
export const MEMORY_HEADER = "[CONTEXTO DE MEMÓRIA]";

/** Config da injeção consumida por `memory.ts` (subconjunto de `inject.*`). */
export interface RecallConfig extends Budget {
  /** Teto de tokens do endpoint de recall (ADR-009). `undefined` ⇒ sem teto A1. */
  memoryMaxTokens?: number;
  /** Teto da chamada de recall (ms) — governa o `AbortSignal`. */
  timeoutMs?: number;
  /** Checa `health()` antes do recall e degrada rápido se não estiver ok. */
  healthGate?: boolean;
}

/** O que `memory.ts` precisa do client (permite stub estreito em teste). */
export type RecallClient = Pick<MemtierClient, "recall"> &
  Partial<Pick<MemtierClient, "health">>;

/**
 * Sanitiza o texto VINDO DE FORA (o `fact` é conteúdo do grafo, não nosso).
 *
 * Sem isto, um fato contendo `\n</context>` FECHA o bloco da sentinela e o que
 * vier depois entra no turno como instrução fora do envelope — prompt injection
 * por memória envenenada, além de corromper a métrica de injeção (D-3).
 *
 * Quebras de linha viram espaço (um fato é UMA linha) e `<`/`>` do conteúdo são
 * neutralizados (`&lt;`/`&gt;`), de modo que nenhuma tag pode ser aberta ou
 * fechada pelo texto do fato. O wrapper (que é nosso) fica intacto.
 */
function sanitizeFactText(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Formata um fato como linha, com procedência temporal quando houver `valid_at`.
 * `invalid_at` não aparece (o recall só devolve vigentes). Fato sem `valid_at`
 * não mostra data.
 *
 * E8-S1: os marcadores de identidade vão no FIM da linha — `[id=<uuid>]` do fato
 * e `[ep=<uuid> +N]` do primeiro episódio. Ambos passam por `isValidUuid`
 * (forma `8-4-4-4-12`): um uuid torto degrada para a OMISSÃO do marcador, nunca
 * para um id que a tool devolveria vazio. A função é PURA — omitir não loga; o
 * aviso sai do injetor, que tem estado de turno (decisão 2).
 */
function formatFact(fact: Fact): string {
  const suffix = fact.valid_at
    ? ` (válido desde ${sanitizeFactText(fact.valid_at)})`
    : "";
  return `- ${sanitizeFactText(fact.fact)}${suffix}${identityMarkers(fact)}`;
}

/**
 * Marcadores `[id=…]` e `[ep=…]` de um fato, precedidos de espaço; `""` quando
 * nenhum é válido (a linha fica **byte-idêntica** à anterior — sem espaço
 * residual). Também decide, por campo, se houve degradação de forma, para o
 * injetor avisar uma vez por turno.
 */
function identityMarkers(fact: Fact): string {
  const markers: string[] = [];
  if (isValidUuid(fact.uuid)) markers.push(`[id=${fact.uuid}]`);
  const episodes = fact.episodes;
  if (Array.isArray(episodes) && isValidUuid(episodes[0])) {
    const extra = episodes.length - 1;
    markers.push(extra > 0 ? `[ep=${episodes[0]} +${extra}]` : `[ep=${episodes[0]}]`);
  }
  return markers.length > 0 ? ` ${markers.join(" ")}` : "";
}

/**
 * Quantos ITENS da família têm identidade **presente mas inválida** — o que o
 * injetor loga uma vez por turno (decisão 2). Ausência (`undefined`/`null`/
 * `""`/lista vazia) é servidor antigo esperado: não conta.
 *
 * Conta o **item** (fato), não o campo: um fato com `uuid` E `episodes[0]`
 * tortos é UM item afetado, e o log diz "N item(ns)" — contar dois campos do
 * mesmo fato faria a mensagem mentir sobre quantos itens degradaram.
 * `episodes` presente mas que não é lista também é item afetado: o campo veio
 * no fio com forma fora do contrato, e degradar sem avisar é o que a decisão 2
 * proíbe.
 */
function invalidIdentityCount(facts: Fact[]): number {
  return facts.filter((f) => itemHasInvalidIdentity(f)).length;
}

/** O item tem alguma identidade presente porém malformada? */
function itemHasInvalidIdentity(fact: Fact): boolean {
  if (presentButInvalid(fact.uuid)) return true;
  const episodes = fact.episodes;
  if (episodes === undefined || episodes === null) return false;
  if (!Array.isArray(episodes)) return true;
  if (episodes.length === 0) return false;
  return presentButInvalid(episodes[0]);
}

/** Um valor existe no fio mas não é uuid válido (ausência não é anomalia). */
function presentButInvalid(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value === "") return false;
  return !isValidUuid(value);
}

/**
 * Identidade de um fato no dedup do turno (decisão 4).
 *
 * Usa a MESMA validação do bloco: `uuid ?? fact` estaria errado — um uuid
 * malformado (ou `""`, que o `??` não protege) viraria chave de dedup enquanto
 * o marcador correspondente é omitido. O prefixo `text:` separa os dois espaços
 * de nome (um `fact` que por acaso fosse um uuid não colide com outro fato).
 */
export function factKey(fact: Fact): string {
  return isValidUuid(fact.uuid) ? fact.uuid : `text:${fact.fact}`;
}

/**
 * Remove repetições da própria resposta (mesma identidade ⇒ um só fato). Espelha
 * `dedupeByIdentity` do `CodeInjector`: o dedup do turno não pode deixar dois
 * itens de mesma identidade entrarem juntos.
 */
function dedupeByFactKey(facts: Fact[]): Fact[] {
  const seen = new Set<string>();
  const out: Fact[] = [];
  for (const f of facts) {
    const key = factKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
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
 * Resultado de uma injeção — bloco pronto + métricas do turno (base da
 * observabilidade do E7: `recall_ms`, `facts`, `injected_chars`).
 */
export interface InjectionResult {
  /** Bloco formatado, pronto para virar um part de texto. */
  block: string;
  /** Nº de fatos injetados (após orçamento e dedup). */
  facts: number;
  /** Chars do bloco injetado. */
  chars: number;
  /** Latência do recall HTTP (ms). */
  recallMs: number;
}

/** Opções de `recall` derivadas da config (limit/max_tokens/signal). */
function recallOpts(cfg: RecallConfig, signal?: AbortSignal): RecallOpts {
  const opts: RecallOpts = { limit: cfg.maxMemories };
  if (cfg.memoryMaxTokens !== undefined) opts.maxTokens = cfg.memoryMaxTokens;
  if (signal) opts.signal = signal;
  return opts;
}

/**
 * O que uma passada de recall devolve ANTES de formatar (E3c-S2): os fatos já
 * filtrados pelo dedup do turno e cortados ao teto `maxMemories`. Não há mais
 * teto de chars no cliente (ADR-009): o volume é limitado no servidor pelo
 * `max_tokens` por endpoint.
 */
export interface MemoryPrep {
  facts: Fact[];
  recallMs: number;
}

/** Timeout da chamada de recall como `AbortSignal` (ou `undefined` sem teto). */
function timeoutSignal(cfg: RecallConfig): AbortSignal | undefined {
  return cfg.timeoutMs && cfg.timeoutMs > 0
    ? AbortSignal.timeout(cfg.timeoutMs)
    : undefined;
}

/** Loga o envelope A1 quando o servidor devolve `truncated`. */
function logBudget(result: RecallResult): void {
  if (result.truncated) {
    log(
      `recall truncated tokens_estimated=${result.tokensEstimated ?? "?"} ` +
        `(orçamento A1)`,
    );
  }
}

/**
 * Recall de baixo nível: chama o client e loga o envelope A1. Lança no erro do
 * client (HTTP tipado / transporte) — a política de degradação fica no hook.
 */
async function runRecall(
  client: RecallClient,
  cfg: RecallConfig,
  query: string,
  signal?: AbortSignal,
): Promise<{ result: RecallResult; recallMs: number }> {
  const start = Date.now();
  const result = await client.recall(query, recallOpts(cfg, signal));
  const recallMs = Date.now() - start;
  logBudget(result);
  return { result, recallMs };
}

/** Linha de observabilidade do turno (E7): recall_ms/facts/injected_chars. */
export function logInjection(m: InjectionResult): void {
  log(
    `inject recall_ms=${m.recallMs} facts=${m.facts} injected_chars=${m.chars}`,
  );
}

/**
 * Emite o aviso de identidade malformada (decisão 2). Devolve `true` quando
 * avisou — quem tem estado de turno usa o retorno para "uma vez por turno" sem
 * reimplementar a condição (que divergiria do aviso).
 */
function warnMalformedIds(facts: Fact[], escopo: string): boolean {
  const invalid = invalidIdentityCount(facts);
  if (invalid === 0) return false;
  log(
    `recall: uuid fora do formato 8-4-4-4-12 em ${invalid} item(ns) — ` +
      `marcador(es) [id=]/[ep=] omitido(s) no bloco (${escopo})`,
  );
  return true;
}

/**
 * Recall + orçamento + formatação, sem estado. Devolve o bloco pronto para virar
 * um part injetado, ou `null` quando não há o que injetar (0 fatos após o
 * orçamento). **Lança** o erro do client — quem chama (o hook) degrada.
 *
 * Sem observabilidade de turno (isso é do `MemoryInjector`, o caminho do hook).
 * Caminho avulso não tem estado de turno: uma chamada = um aviso.
 */
export async function recallAndFormat(
  client: RecallClient,
  cfg: RecallConfig,
  query: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const { result } = await runRecall(client, cfg, query, signal);
  const facts = applyBudget(result.facts, cfg);
  warnMalformedIds(facts, "recall avulso");
  return formatMemoryBlock(facts);
}

/**
 * Injetor com estado de **dedup por turno** (FR-104): a mesma memória não é
 * reinjetada no mesmo turno.
 *
 * O **turno** aqui é o que o nome diz: uma mensagem do usuário e as respostas do
 * modelo até a próxima mensagem do usuário. A identidade é o `turnoId` — o `id`
 * da `UserMessage` do Kilo (estável e único por turno). O **texto** do usuário
 * NÃO serve: duas mensagens diferentes com o mesmo texto colapsariam no mesmo
 * turno e a segunda não receberia memória; e um turno que roda o `transform`
 * mais de uma vez não pode ser tratado como turno novo.
 *
 * Ao mudar o `turnoId`, o conjunto de fatos já injetados é limpo. Fatos já vistos
 * no turno são filtrados antes do orçamento — se nada sobra, devolve `null` (não
 * injeta bloco vazio).
 *
 * > Nota de vocabulário: no antecessor (openviking) `turno` designava o **batch
 * > de ingestão** (`turnQueue`, `ingestBatchSize` → `POST …/messages/batch`) —
 * > nome herdado, semanticamente impróprio. Aqui o termo volta ao sentido
 * > literal (um passo da conversa); o lote de ingestão é `batch` (E4).
 */
export class MemoryInjector {
  private readonly client: RecallClient;
  private readonly cfg: RecallConfig;
  /** `turnoId` corrente; `null` = nenhum turno visto ainda nesta sessão. */
  private turnoId: string | null = null;
  /** O turno corrente já injetou um bloco? Um turno injeta **no máximo um**. */
  private injectedThisTurn = false;
  /** Aviso de uuid malformado já saiu neste turno? Um **por turno por família**. */
  private idsWarnedThisTurn = false;
  private readonly seen = new Set<string>();

  constructor(client: RecallClient, cfg: RecallConfig) {
    this.client = client;
    this.cfg = cfg;
  }

  /** Health gate opcional — `true` quando pode tentar o recall. */
  async ready(): Promise<boolean> {
    if (!this.cfg.healthGate || !this.client.health) return true;
    try {
      return (await this.client.health()).ok;
    } catch {
      return false;
    }
  }

  /**
   * Sincroniza o turno: ao mudar o `turnoId`, limpa o dedup. Devolve `true`
   * quando a família AINDA não injetou neste turno (pode tentar). Idempotente —
   * chamável mais de uma vez no mesmo turno (o `transform` roda 2×).
   */
  beginTurn(turnoId: string): boolean {
    if (turnoId !== this.turnoId) {
      this.turnoId = turnoId;
      this.seen.clear();
      this.injectedThisTurn = false;
      this.idsWarnedThisTurn = false;
    }
    return !this.injectedThisTurn;
  }

  /**
   * Avisa UMA vez por turno quando a identidade veio presente mas malformada
   * (decisão 2). Um booleano, como `floorWarnedThisTurn` do `CodeInjector`:
   * repetir por uuid transformaria um deploy desalinhado em spam de log.
   * Ausência de uuid (servidor antigo) NÃO avisa — é degradação esperada.
   */
  private warnInvalidIds(facts: Fact[]): void {
    if (this.idsWarnedThisTurn) return;
    this.idsWarnedThisTurn = warnMalformedIds(facts, "injeção do turno");
  }

  /**
   * Prepara uma injeção de memória SEM commitar (E3c-S2): sincroniza o turno,
   * checa "um bloco por turno", faz o recall e devolve os fatos **filtrados pelo
   * dedup** e cortados ao teto `maxMemories`. `null` ⇒ nada a preparar (turno já
   * injetou / teto zero). **Lança** o erro do client — o orquestrador decide.
   */
  async prepare(turnoId: string, query: string): Promise<MemoryPrep | null> {
    if (!this.beginTurn(turnoId)) return null;
    const { result, recallMs } = await runRecall(
      this.client,
      this.cfg,
      query,
      timeoutSignal(this.cfg),
    );
    const fresh = dedupeByFactKey(
      result.facts.filter((f) => !this.seen.has(factKey(f))),
    );
    const facts = fresh.slice(0, Math.max(0, this.cfg.maxMemories));
    this.warnInvalidIds(facts);
    return { facts, recallMs };
  }

  /**
   * Commita o resultado de `prepare` com a lista final (`applyJointBudget` pode
   * ter cortado mais). Marca o dedup e devolve o bloco formatado — `null` quando
   * a lista final ficou vazia (não injeta bloco vazio). Só marca o turno como
   * injetado quando HOUVE bloco: lista vazia não consome o "um por turno" (mesma
   * semântica do E2 — a próxima passada do `transform` pode tentar de novo).
   */
  commit(prep: MemoryPrep, facts: Fact[]): InjectionResult | null {
    const block = formatMemoryBlock(facts);
    if (!block) return null;
    for (const f of facts) this.seen.add(factKey(f));
    this.injectedThisTurn = true;
    const injection: InjectionResult = {
      block,
      facts: facts.length,
      chars: block.length,
      recallMs: prep.recallMs,
    };
    logInjection(injection);
    return injection;
  }

  /**
   * Recall + dedup + orçamento + bloco (caminho só-de-memória, E2). `null` ⇒ nada
   * a injetar. Fina camada sobre `prepare`/`commit` com `applyBudget` (corte por
   * contagem — `maxMemories`; o volume é do servidor, ADR-009).
   *
   * `turnoId` identifica o turno (o `id` da `UserMessage`); `query` é o texto
   * usado no recall. Trocar de turno limpa o dedup; o mesmo turno NUNCA
   * reinjeta a mesma memória, por mais vezes que o `transform` rode nele.
   */
  async inject(turnoId: string, query: string): Promise<InjectionResult | null> {
    const prep = await this.prepare(turnoId, query);
    if (!prep) return null;
    const facts = applyBudget(prep.facts, this.cfg);
    const injection = this.commit(prep, facts);
    if (!injection) {
      debug(`recall: nada novo a injetar (${prep.facts.length} fatos)`);
    }
    return injection;
  }
}

/**
 * Injeção de memória — do texto do usuário ao bloco injetado (E2-S1 tracer;
 * endurecido na E2-S2).
 *
 * Fluxo: `client.recall(query)` → (dedup por turno) → `applyBudget` → formata o
 * bloco com procedência (`[CONTEXTO DE MEMÓRIA]`, sentinela `graph-memory` —
 * FR-105). Resposta vazia ⇒ `null` (não injeta bloco vazio).
 *
 * Endurecimento (E2-S2): `max_tokens` no request (A1), `maxChars` (corte por
 * fato inteiro, via `applyBudget`), `timeout_ms` como `AbortSignal` da chamada,
 * dedup por turno (não reinjeta a mesma memória — FR-104), health gate opcional
 * e log de `truncated`.
 *
 * Recebe o client (injetável) e a config; não lê env/arquivo. O hook
 * (`hooks/messages.ts`) é thin e só liga isto ao transform.
 */

import type { Fact, MemtierClient, RecallOpts, RecallResult } from "../client.ts";
import { debug, log } from "../logger.ts";
import { applyBudget, type Budget } from "./budget.ts";

/** Sentinela do bloco de memória (não colide com `ov-memory` do antecessor). */
export const MEMORY_SENTINEL = "graph-memory";

/** Título do bloco — procedência visível ao modelo (FR-105). */
export const MEMORY_HEADER = "[CONTEXTO DE MEMÓRIA]";

/** Config da injeção consumida por `memory.ts` (subconjunto de `inject.*`). */
export interface RecallConfig extends Budget {
  /** Teto de tokens no servidor (A1). `undefined` ⇒ sem orçamento A1. */
  maxTokens?: number;
  /** Teto da chamada de recall (ms) — governa o `AbortSignal`. */
  timeoutMs?: number;
  /** Checa `health()` antes do recall e degrada rápido se não estiver ok. */
  healthGate?: boolean;
}

/** O que `memory.ts` precisa do client (permite stub estreito em teste). */
export type RecallClient = Pick<MemtierClient, "recall"> &
  Partial<Pick<MemtierClient, "health">>;

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

/** Teto de chars medido sobre o bloco renderizado (para `applyBudget`). */
function renderForBudget(facts: Fact[]): string {
  return formatMemoryBlock(facts) ?? "";
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
  if (cfg.maxTokens !== undefined) opts.maxTokens = cfg.maxTokens;
  if (signal) opts.signal = signal;
  return opts;
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
function logInjection(m: InjectionResult): void {
  log(
    `inject recall_ms=${m.recallMs} facts=${m.facts} injected_chars=${m.chars}`,
  );
}

/**
 * Recall + orçamento + formatação, sem estado. Devolve o bloco pronto para virar
 * um part injetado, ou `null` quando não há o que injetar (0 fatos após o
 * orçamento). **Lança** o erro do client — quem chama (o hook) degrada.
 *
 * Sem observabilidade de turno (isso é do `MemoryInjector`, o caminho do hook).
 */
export async function recallAndFormat(
  client: RecallClient,
  cfg: RecallConfig,
  query: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const { result } = await runRecall(client, cfg, query, signal);
  const facts = applyBudget(result.facts, cfg, renderForBudget);
  return formatMemoryBlock(facts);
}

/**
 * Injetor com estado de **dedup por turno** (FR-104): a mesma memória não é
 * reinjetada no mesmo turno. O turno é identificado pelo texto do usuário; ao
 * mudar o turno, o conjunto de fatos já injetados é limpo. Fatos já vistos no
 * turno são filtrados antes do orçamento — se nada sobra, devolve `null` (não
 * injeta bloco vazio).
 */
export class MemoryInjector {
  private readonly client: RecallClient;
  private readonly cfg: RecallConfig;
  private turnKey: string | null = null;
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

  /** Recall + dedup + orçamento + bloco. `null` ⇒ nada a injetar. */
  async inject(query: string): Promise<InjectionResult | null> {
    if (query !== this.turnKey) {
      this.turnKey = query;
      this.seen.clear();
    }
    const { result, recallMs } = await runRecall(
      this.client,
      this.cfg,
      query,
      timeoutSignal(this.cfg),
    );

    const fresh = result.facts.filter((f) => !this.seen.has(f.fact));
    const facts = applyBudget(fresh, this.cfg, renderForBudget);
    const block = formatMemoryBlock(facts);
    if (!block) {
      debug(`recall: nada novo a injetar (${result.facts.length} fatos)`);
      return null;
    }
    for (const f of facts) this.seen.add(f.fact);
    const injection: InjectionResult = {
      block,
      facts: facts.length,
      chars: block.length,
      recallMs,
    };
    logInjection(injection);
    return injection;
  }
}

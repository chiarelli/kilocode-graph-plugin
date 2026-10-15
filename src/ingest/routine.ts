/**
 * `ingest/routine.ts` — a **única** rotina de ingestão (E4-S1).
 *
 * Os dois gatilhos (`message.updated` e, na S3, `session.idle`) acordam esta
 * rotina; o evento **nunca** ingere nem carrega conteúdo (ADR-007) — a rotina lê
 * o banco pelo cursor e decide. Na S1 o caminho é: limiar atingido ⇒ envia **um**
 * lote; abaixo do limiar, não envia (o resto é do `session.idle`, E4-S3).
 *
 * Garantias:
 *   - **nunca lança** pela interface `runIngest` (degrada e loga);
 *   - **trava por sessão**: chamadas concorrentes (os eventos repetem) não
 *     avançam o cursor duas vezes para o mesmo lote;
 *   - hash e cursor só são gravados **após** o `202` (aceite — L-1).
 */

import {
  AuthError,
  InfraError,
  MemtierHttpError,
  type MemtierClient,
} from "../client.ts";
import { debug, log, logFatal } from "../logger.ts";
import { buildBatch, shouldSend } from "./batch.ts";
import { IngestReadError, readBatch, type SqliteBackend } from "./db.ts";
import {
  hasSentBatch,
  loadState,
  markBatchSent,
  saveState,
  setCursor,
} from "./state.ts";

/** Config da ingestão (subconjunto de `ingest.*`). */
export interface IngestConfig {
  enabled: boolean;
  /** Tamanho do lote (decisão do dono; medido 20 = ótimo de custo). */
  batch_size: number;
  /** Teto de hashes por workspace (L-2; aplicado na E4-S4). */
  max_hashes: number;
}

/** O que a rotina precisa do client (permite stub estreito em teste). */
export type IngestClient = Pick<MemtierClient, "ingest">;

/** Dependências da rotina (injetáveis para teste, sem banco/rede reais). */
export interface IngestRuntime {
  cfg: IngestConfig;
  /** Caminho do estado (`.kilo/graph-ingest.json`). */
  statePath: string;
  client: IngestClient;
  /** Trava por sessão, compartilhada entre os gatilhos (uma execução por vez). */
  lock: Set<string>;
}

/** Resultado de uma passada (observabilidade + teste). */
export interface IngestOutcome {
  /** `true` quando um lote foi enviado e aceito (202). */
  sent: boolean;
  /** Linhas lidas do banco nesta passada (decide o limiar). */
  rows: number;
  hash?: string;
  jobId?: string;
  msgs?: number;
}

/**
 * Classifica a falha do envio para o log correto (nunca propaga):
 * `401`/`403` precisa de ação (visível); `503` é memtier degradado (discreto);
 * o resto é inesperado (visível).
 */
export function logIngestFailure(err: unknown): void {
  if (err instanceof AuthError) {
    logFatal(`ingest auth (${err.status})`, err);
    return;
  }
  if (err instanceof InfraError) {
    log(`ingest: memtier indisponível (${err.status}); lote não enviado`);
    return;
  }
  if (err instanceof MemtierHttpError) {
    logFatal(`ingest (${err.status})`, err);
    return;
  }
  if (err instanceof IngestReadError) {
    // Leitura do banco falhou (transitório): nada foi enviado nem perdido — o
    // próximo gatilho relê. Degrada em log, nunca fatal (NFR-03).
    log("ingest: banco indisponível; lote não enviado (retry no próximo gatilho)");
    return;
  }
  logFatal("ingest", err);
}

/**
 * Uma passada da rotina. **Pode lançar** no erro do client (HTTP/tipado) — a
 * política de degradação e a trava ficam em `runIngest`. Não avança o cursor
 * quando o envio falha (o próximo gatilho relê o mesmo lote).
 */
export async function ingestOnce(
  rt: IngestRuntime,
  backend: SqliteBackend,
  sessionId: string,
): Promise<IngestOutcome> {
  if (!rt.cfg.enabled) return { sent: false, rows: 0 };

  const state = loadState(rt.statePath);
  const prev = state.sessions[sessionId] ?? { last_ts: 0, last_id: "" };
  const { messages, last, rows } = readBatch(
    backend,
    sessionId,
    prev,
    rt.cfg.batch_size,
    // Linha "veneno" (`data` não-JSON): avança o cursor (é irrecuperável), mas
    // deixa rastro — nunca silenciosa (revisão adversarial da E4-S1).
    (msgId) => log(`ingest: linha ilegível ignorada id=${msgId} session=${sessionId}`),
  );

  if (rows === 0) {
    debug(`ingest: sem pendências session=${sessionId}`);
    return { sent: false, rows: 0 };
  }
  if (!shouldSend(rows, rt.cfg.batch_size)) {
    debug(
      `ingest: pendentes=${rows} < batch=${rt.cfg.batch_size} ` +
        `session=${sessionId}; aguardando`,
    );
    return { sent: false, rows };
  }

  // Lote cheio de LINHAS, mas nenhuma com texto: não há episódio a ingerir.
  // Avança o cursor (senão o limiar travaria) e segue — o `body` não pode ser
  // vazio (`min_length=1` no memtier).
  if (messages.length === 0) {
    if (last) {
      setCursor(state, sessionId, last);
      saveState(rt.statePath, state);
    }
    debug(`ingest: lote de ${rows} linhas sem texto session=${sessionId}`);
    return { sent: false, rows };
  }

  const batch = buildBatch(messages);
  if (hasSentBatch(state, batch.hash)) {
    if (last) {
      setCursor(state, sessionId, last);
      saveState(rt.statePath, state);
    }
    debug(`ingest: lote ${batch.hash} já enviado (dedup) session=${sessionId}`);
    return { sent: false, rows, hash: batch.hash };
  }

  const res = await rt.client.ingest(batch.body, batch.referenceTime);
  // Só após o 202: hash (idempotência) e cursor avançam juntos, no mesmo write.
  // L-1: o 202 confirma o ACEITE, não o processamento.
  markBatchSent(state, batch.hash);
  if (last) setCursor(state, sessionId, last);
  saveState(rt.statePath, state);

  log(
    `ingest sent session=${sessionId} rows=${rows} msgs=${messages.length} ` +
      `hash=${batch.hash} job_id=${res.job_id ?? "?"} status=${res.status ?? "?"} ` +
      `reference_time=${batch.referenceTime}`,
  );
  return { sent: true, rows, hash: batch.hash, jobId: res.job_id, msgs: messages.length };
}

/**
 * Interface estável da rotina: adquire a trava por sessão, roda uma passada e
 * **nunca lança** (falha vira log). Chamada em background pelos gatilhos.
 */
export async function runIngest(
  rt: IngestRuntime,
  backend: SqliteBackend,
  sessionId: string,
): Promise<void> {
  if (rt.lock.has(sessionId)) {
    debug(`ingest: execução concorrente ignorada session=${sessionId}`);
    return;
  }
  rt.lock.add(sessionId);
  try {
    await ingestOnce(rt, backend, sessionId);
  } catch (err) {
    logIngestFailure(err);
  } finally {
    rt.lock.delete(sessionId);
  }
}

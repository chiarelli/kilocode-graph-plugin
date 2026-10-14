/**
 * Hook do coletor de código (E3a-S1) — thin.
 *
 * Dispara a coleta **fora do turno** (FR-510): roda em background
 * (`void run().catch(...)`) e nunca é `await` no caminho crítico. O gatilho da
 * fatia 1 é o **boot** do plugin; a S4 adiciona o híbrido full/incremental por
 * `git_range` e a cadência por sessão.
 *
 * Minimal (`TODO(tracer-bullet)`): só boot; sem incremental/backpressure/paginação.
 */

import {
  AuthError,
  InfraError,
  type MemtierClient,
  MemtierHttpError,
} from "../client.ts";
import { debug, log, logFatal } from "../logger.ts";
import { buildSyncBody } from "../index/collector.ts";
import { runIndexer } from "../index/runner.ts";
import type { SyncResult } from "../types.ts";

/** Config do coletor (subconjunto de `code_index.*`). */
export interface CollectConfig {
  enabled: boolean;
  indexer_bin: string;
}

/** Dependências do hook (injetáveis para teste, sem spawn real). */
export interface CollectRuntime {
  cfg: CollectConfig;
  /** Diretório-raiz do repo (workspace resolvido). */
  repoRoot: string;
  identity: { workspace: string; program: string };
  client: Pick<MemtierClient, "syncCode">;
  /** Runner injetável (default `runIndexer`); stubado em teste. */
  run?: typeof runIndexer;
}

/** Classifica a falha do sync para o log correto (nunca propaga). */
function logSyncFailure(err: unknown): void {
  if (err instanceof AuthError) {
    logFatal(`collect sync auth (${err.status})`, err);
    return;
  }
  if (err instanceof InfraError) {
    log(`collect: memtier indisponível (${err.status}); coleta abortada`);
    return;
  }
  if (err instanceof MemtierHttpError) {
    logFatal(`collect sync (${err.status})`, err);
    return;
  }
  logFatal("collect sync", err);
}

/** Log de observabilidade da coleta (base do E7). */
function logCollection(
  indexerMs: number,
  files: number,
  edges: number,
  sync?: SyncResult,
): void {
  const stats = sync
    ? ` sync={upserted:${sync.upserted},deleted:${sync.deleted},` +
      `changed:${sync.changed},skipped:${sync.skipped}}`
    : " sync=skipped";
  log(`collect indexer_ms=${indexerMs} files=${files} edges=${edges}${stats}`);
}

/**
 * Coleta completa: spawna o indexer, monta o body e chama `/v1/code/sync`.
 * **Nunca lança** — degrada em qualquer falha (FR-510/E5). Devolve o
 * `SyncResult` quando houve sync (para o E2E provar o efeito do outro lado).
 */
export async function collectCode(rt: CollectRuntime): Promise<SyncResult | null> {
  if (!rt.cfg.enabled) {
    debug("collect: desligado (code_index.enabled=false)");
    return null;
  }
  const run = rt.run ?? runIndexer;
  const start = Date.now();

  let result;
  try {
    result = await run({
      bin: rt.cfg.indexer_bin,
      repoRoot: rt.repoRoot,
      mode: "full",
    });
  } catch (err) {
    logFatal("collect indexer", err);
    return null;
  }
  const indexerMs = Date.now() - start;

  if (result.skipped) {
    logCollection(indexerMs, 0, 0);
    return null;
  }

  const body = buildSyncBody(result.events, rt.identity);
  if (body.files.length === 0) {
    debug("collect: nenhum chunk emitido; nada a sincronizar");
    logCollection(indexerMs, 0, 0);
    return null;
  }

  try {
    const sync = await rt.client.syncCode(body.files, body.edges);
    logCollection(indexerMs, body.files.length, body.edges.length, sync);
    return sync;
  } catch (err) {
    // TODO(tracer-bullet): fallback 422 sem arestas (S4) — na S1 não há arestas.
    logSyncFailure(err);
    return null;
  }
}

/**
 * Registra o hook do coletor: no boot dispara a coleta em background (nunca
 * `await`). Devolve a promessa em voo para o `dispose` drenar (como o health).
 */
export function collectHook(rt: CollectRuntime): { boot: Promise<void> } {
  const boot = collectCode(rt)
    .then(() => undefined)
    .catch((err) => {
      // `collectCode` não deveria lançar; cinto de segurança contra rejeição
      // não tratada de uma promessa em background (nunca derruba o plugin).
      logFatal("collect boot", err);
    });
  return { boot };
}

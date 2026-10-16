/**
 * Hook do coletor de código (E3a-S1) — thin.
 *
 * Dispara a coleta **fora do turno** (FR-510): roda em background
 * (`void run().catch(...)`) e nunca é `await` no caminho crítico. O gatilho é o
 * **boot** do plugin; o `trigger.ts` decide full (1º uso) vs incremental
 * (`git_range` a partir do HEAD gravado). O backpressure fica no `runner`.
 */

import {
  AuthError,
  InfraError,
  type MemtierClient,
  MemtierHttpError,
} from "../client.ts";
import { debug, log, logFatal } from "../logger.ts";
import { buildSyncBody } from "../index/collector.ts";
import {
  emptyManifest,
  loadManifest,
  MANIFEST_REL_PATH,
  mergeManifest,
  removedFiles,
  saveManifest,
} from "../index/manifest.ts";
import { runIndexer, type IndexMode } from "../index/runner.ts";
import { decideTrigger } from "../index/trigger.ts";
import { join } from "node:path";
import type { SyncResult } from "../types.ts";

/** Config do coletor (subconjunto de `code_index.*`). */
export interface CollectConfig {
  enabled: boolean;
  indexer_bin: string;
  /**
   * Fonte de arquivos via git (`load_ignores`). Ausente/`false` ⇒ varre tudo.
   * Quando `true`, o indexer exige git + repositório (senão `GIT_UNAVAILABLE`).
   */
  load_ignores?: boolean;
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
  /**
   * Estado por workspace (manifest). Injetável para teste; default é o manifest
   * real em `<repo>/.kilo/graph-manifest.json`.
   */
  state?: CollectState;
}

/** Porta de estado do coletor (manifest) — implementada por `index/manifest.ts`. */
export interface CollectState {
  /** Estado atual (arquivos sincronizados + head). */
  load(): { files: string[]; last_git_head?: string | null };
  /** Persiste o estado pós-sync (arquivos atuais + head). */
  save(files: string[], head: string | null): void;
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
  removed: number,
  sync?: SyncResult,
): void {
  const stats = sync
    ? ` sync={upserted:${sync.upserted},deleted:${sync.deleted},` +
      `changed:${sync.changed},skipped:${sync.skipped}}`
    : " sync=skipped";
  log(
    `collect indexer_ms=${indexerMs} files=${files} edges=${edges} ` +
      `removed=${removed}${stats}`,
  );
}

/** Estado real do coletor: manifest em `<repo>/.kilo/graph-manifest.json`. */
function fileState(repoRoot: string, workspace: string): CollectState {
  const path = join(repoRoot, MANIFEST_REL_PATH);
  return {
    load: () => {
      const manifest = loadManifest(path, workspace);
      return { files: manifest.files, last_git_head: manifest.last_git_head };
    },
    save: (files, head) => {
      try {
        saveManifest(path, mergeManifest(workspace, files, head));
      } catch (err) {
        // Manifest é otimização/estado local: falha de escrita não é fatal (o
        // próximo sync reindexa tudo por falta do estado).
        debug(
          `collect: manifest não gravado (${err instanceof Error ? err.message : err})`,
        );
      }
    },
  };
}

/** HEAD atual do repo (base do incremental); `null` fora de um repo git. */
async function currentHead(repoRoot: string): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile("git", ["-C", repoRoot, "rev-parse", "HEAD"], (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
}

/**
 * Coleta completa: decide full/incremental (trigger), spawna o indexer, monta o
 * body (removidos do manifest) e chama `/v1/code/sync`. **Nunca lança** — degrada
 * em qualquer falha (FR-510/E5). Devolve o `SyncResult` quando houve sync.
 */
export async function collectCode(rt: CollectRuntime): Promise<SyncResult | null> {
  if (!rt.cfg.enabled) {
    debug("collect: desligado (code_index.enabled=false)");
    return null;
  }
  const run = rt.run ?? runIndexer;
  const state = rt.state ?? fileState(rt.repoRoot, rt.identity.workspace);
  const start = Date.now();

  const manifest = state.load();
  const trigger = decideTrigger({
    files: manifest.files,
    last_git_head: manifest.last_git_head ?? null,
  });
  const mode: IndexMode = trigger.mode;

  let result;
  try {
    result = await run({
      bin: rt.cfg.indexer_bin,
      repoRoot: rt.repoRoot,
      mode,
      gitRange: trigger.gitRange,
      loadIgnores: rt.cfg.load_ignores ?? false,
    });
  } catch (err) {
    logFatal("collect indexer", err);
    return null;
  }
  const indexerMs = Date.now() - start;

  if (result.skipped) {
    logCollection(indexerMs, 0, 0, 0);
    return null;
  }

  const present = collectPresent(result.events);
  // Removidos só se detectam no FULL: no incremental o stream traz apenas os
  // arquivos alterados no range — tratá-los como "estado completo" marcaria
  // todo inalterado como removido e apagaria o grafo (defeito medido).
  const removed =
    mode === "full"
      ? removedFiles(
          { ...emptyManifest(rt.identity.workspace), files: manifest.files },
          present,
        )
      : [];

  const buildStart = Date.now();
  const body = buildSyncBody(result.events, rt.identity, {
    repoRoot: rt.repoRoot,
    removed,
  });
  const buildMs = Date.now() - buildStart;
  debug(
    `collect: build files=${body.files.length} edges=${body.edges.length} ` +
      `build_ms=${buildMs} events=${result.events.length}`,
  );
  if (body.files.length === 0 && removed.length === 0) {
    debug("collect: nenhum chunk emitido; nada a sincronizar");
    logCollection(indexerMs, 0, 0, 0);
    return null;
  }

  try {
    const sync = await rt.client.syncCode(body.files, body.edges);
    logCollection(indexerMs, body.files.length, body.edges.length, removed.length, sync);
    // Estado pós-sync: arquivos ATUAIS (sem removidos) + HEAD atual. No
    // incremental, `present` só traz os alterados; mescla com os que já
    // estavam no manifest para não perder os inalterados.
    const merged = mode === "incremental"
      ? [...new Set([...manifest.files.filter((f) => !removed.includes(f)), ...present])]
      : present;
    state.save(merged, await currentHead(rt.repoRoot));
    return sync;
  } catch (err) {
    logSyncFailure(err);
    return null;
  }
}

/** Arquivos com `chunk_emitted` no stream (para o diff de removidos). */
function collectPresent(events: import("../types.ts").IndexerEvent[]): string[] {
  const seen = new Set<string>();
  for (const ev of events) {
    if (ev.event !== "chunk_emitted") continue;
    const p = ev.payload as { file?: unknown } | null;
    if (p && typeof p.file === "string" && p.file) seen.add(p.file);
  }
  return [...seen];
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

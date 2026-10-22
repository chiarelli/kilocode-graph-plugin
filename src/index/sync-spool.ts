/**
 * `sync-spool.ts` — sincronização em LOTES a partir do spool em disco.
 *
 * Substitui o caminho "acumula o job inteiro e chama `buildSyncBody(events)`":
 * aqui os eventos nunca voltam todos para a RAM. O índice de arestas (nomes de
 * símbolo por arquivo) é construído a partir dos METADADOS do spool, e cada lote
 * materializa só os chunks dos seus ≤`batchSize` arquivos.
 *
 * Por que por arquivo: o servidor reconcilia chunks por arquivo (`sync_file`);
 * reenviar um subconjunto apagaria os demais. O spool só é lido depois do
 * `job_completed`, quando todo arquivo está completo.
 *
 * Arestas: continuam resolvidas contra o conjunto COMPLETO de arquivos (o índice
 * global), então o lote carrega as arestas cuja ORIGEM está nele — mesma
 * semântica do envio em bloco anterior (o servidor exige a origem no payload).
 */

import type { SyncResult } from "../types.ts";
import {
  collectFiles,
  defaultReadFile,
  ensureFullFile,
  removedFile,
} from "./collector.ts";
import {
  buildEdgeIndex,
  resolveEdgesWithIndex,
  type CallEdge,
  type ImportEdge,
} from "./edges.ts";
import type { EventSpool } from "./spool.ts";

/** Identidade lógica do sync. */
export interface SyncIdentityLike {
  workspace: string;
  program: string;
}

/** Cliente mínimo usado pelo sincronizador (injetável em teste). */
export interface SyncClientLike {
  syncCode: (
    files: import("../types.ts").CodeFile[],
    edges: import("../types.ts").CodeEdge[],
  ) => Promise<SyncResult>;
}

/** Opções de `syncSpool`. */
export interface SyncSpoolOptions {
  /** Raiz do repo (para o `FullFile` sintético). */
  repoRoot: string;
  /** Arquivos removidos ⇒ `chunks: []`. */
  removed?: string[];
  /** Arquivos por lote (default 100; teto do servidor/cliente). */
  batchSize?: number;
  /** Leitor injetável (default `readFileSync` do collector). */
  readFile?: (path: string) => string;
}

/** Resultado agregado de todos os lotes. */
export interface SyncSpoolResult {
  sync: SyncResult;
  /** Arquivos efetivamente enviados (exclui removidos e vazios). */
  files: number;
  /** Arestas efetivamente enviadas. */
  edges: number;
  /** Removidos enviados (`chunks: []`). */
  removed: number;
}

const DEFAULT_BATCH_SIZE = 100;

function emptyAggregate(workspace: string | undefined): SyncResult {
  return {
    workspace,
    upserted: 0,
    deleted: 0,
    changed: 0,
    skipped: 0,
    edges_upserted: 0,
    edges_deleted: 0,
    results: [],
  };
}

/** Soma um `SyncResult` de lote no agregado (campos aditivos). */
function addInto(acc: SyncResult, res: SyncResult): void {
  acc.upserted += res.upserted ?? 0;
  acc.deleted += res.deleted ?? 0;
  acc.changed += res.changed ?? 0;
  acc.skipped += res.skipped ?? 0;
  acc.edges_upserted = (acc.edges_upserted ?? 0) + (res.edges_upserted ?? 0);
  acc.edges_deleted = (acc.edges_deleted ?? 0) + (res.edges_deleted ?? 0);
  if (res.results) acc.results = [...(acc.results ?? []), ...res.results];
}

/**
 * Sincroniza o spool em lotes de ≤`batchSize` arquivos. O pico de memória fica
 * limitado ao lote (chunks lidos do spool + `FullFile` do lote). Lança somente
 * o que o cliente lançar — o chamador decide a degradação.
 */
export async function syncSpool(
  spool: EventSpool,
  client: SyncClientLike,
  identity: SyncIdentityLike,
  opts: SyncSpoolOptions,
): Promise<SyncSpoolResult> {
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
  const removedSet = new Set(opts.removed ?? []);
  // Índice global (só nomes de símbolo): arestas resolvem entre lotes.
  const index = buildEdgeIndex(
    spool
      .files()
      .filter((f) => !removedSet.has(f.filePath))
      .map((f) => ({
        filePath: f.filePath,
        symbols: f.symbols,
        // `ensureFullFile` garante nó de arquivo para TODO arquivo enviado, então
        // a origem de `import_edge` sempre existe no grafo.
        hasFileChunk: true,
      })),
  );

  const files = spool.files().filter((f) => !removedSet.has(f.filePath));
  const aggregate = emptyAggregate(identity.workspace);
  let sentFiles = 0;
  let sentEdges = 0;

  // Removidos vão num lote próprio (tombstones não precisam da origem).
  const removedList = [...removedSet];
  const batches: Array<{ files: string[]; removed: string[] }> = [];
  for (let i = 0; i < files.length; i += batchSize) {
    batches.push({
      files: files.slice(i, i + batchSize).map((f) => f.filePath),
      removed: [],
    });
  }
  if (removedList.length === 0) {
    // nada
  } else if (batches.length === 0) {
    batches.push({ files: [], removed: removedList });
  } else {
    // Anexa os removidos ao último lote (um request a menos).
    batches[batches.length - 1]!.removed = removedList;
  }

  for (const batch of batches) {
    const read = opts.readFile ?? defaultReadFile;
    const languageOf = new Map(files.map((f) => [f.filePath, f.language]));
    const batchFiles = batch.files.map((filePath) => {
      // Só os chunks DESTE arquivo são materializados: o pico de RAM é o lote.
      const entry = collectFiles(spool.readFile(filePath))[0] ?? {
        file_path: filePath,
        language: languageOf.get(filePath) ?? "rust",
        chunks: [],
      };
      return ensureFullFile(entry, opts.repoRoot, read);
    });

    const imports: ImportEdge[] = [];
    const calls: CallEdge[] = [];
    for (const filePath of batch.files) {
      for (const ev of spool.readEdges(filePath)) {
        const payload = ev.payload as Record<string, unknown> | null;
        if (!payload) continue;
        if (ev.event === "import_edge") imports.push(payload as ImportEdge);
        else if (ev.event === "call_edge") calls.push(payload as CallEdge);
      }
    }
    const edges = resolveEdgesWithIndex(imports, calls, index);

    const toSend = [...batchFiles];
    for (const path of batch.removed) toSend.push(removedFile(path));
    if (toSend.length === 0) continue;

    const res = await client.syncCode(toSend, edges);
    addInto(aggregate, res);
    sentFiles += batchFiles.length;
    sentEdges += edges.length;
  }

  return {
    sync: aggregate,
    files: sentFiles,
    edges: sentEdges,
    removed: removedList.length,
  };
}

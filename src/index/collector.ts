/**
 * `collector.ts` — eventos do indexer → body do `POST /v1/code/sync` (E3a-S1).
 *
 * Fatia 1 (tracer): agrupa `chunk_emitted` por `file` em `files[]`. Mesma lógica
 * validada no probe (`montar_body`): `symbol_id` do indexer é o NOME PURO
 * (`protocol.md:105`) — usa-se CRU; uma linha não-JSON é ignorada (o parse
 * defensivo vive no `runner`, mas aqui também se valida o payload campo a campo).
 *
 * Módulo **puro** (sem I/O): recebe eventos, devolve estruturas. Endurecido nas
 * S2 (arestas), S3 (FullFile sintético/removidos) e S4 (paginação) — nunca rewrite.
 *
 * Minimal da fatia 1 (`TODO(tracer-bullet)`): `edges[]` sempre vazio (S2);
 * `removed` (`chunks: []`) e `FullFile` sintético ausentes (S3).
 */

import type { CodeChunk, CodeEdge, CodeFile, IndexerEvent } from "../types.ts";
import {
  resolveEdges,
  type CallEdge,
  type ImportEdge,
} from "./edges.ts";

/** Identidade lógica do sync (aditiva E11: `program`). */
export interface SyncIdentity {
  workspace: string;
  program: string;
}

/** Body de `POST /v1/code/sync`. */
export interface SyncBody extends SyncIdentity {
  files: CodeFile[];
  edges: CodeEdge[];
}

const CHUNK_KINDS = new Set(["Symbol", "FullFile", "Contextual"]);

/** Coerção estrita a número inteiro ≥0 (payload pode trazer `null`/string). */
function toInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

/**
 * `symbol_id` em NOME PURO (protocol.md:105). O indexer já o emite cru; o
 * `rsplit(":")` é **cinto de segurança** (mesma tolerância do probe) contra uma
 * versão que volte a qualificar com o caminho — nunca reconcatenar `file`.
 */
function bareSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const bare = raw.split(":").pop() ?? "";
  return bare.trim() === "" ? null : bare;
}

/** Payload de `chunk_emitted` como objeto (ou `null` se malformado). */
function chunkPayload(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  return payload as Record<string, unknown>;
}

/** Separa os eventos de aresta (`import_edge`/`call_edge`) do stream de chunks. */
export function collectEdges(events: IndexerEvent[]): {
  imports: ImportEdge[];
  calls: CallEdge[];
} {
  const imports: ImportEdge[] = [];
  const calls: CallEdge[] = [];
  for (const ev of events) {
    const payload = chunkPayload(ev.payload);
    if (!payload) continue;
    if (ev.event === "import_edge") imports.push(payload as ImportEdge);
    else if (ev.event === "call_edge") calls.push(payload as CallEdge);
  }
  return { imports, calls };
}

/**
 * Converte um `chunk_emitted` no `CodeChunk` do contrato, ou `null` se o payload
 * não tem o mínimo (sem `file`, `chunk_md5` ou `chunk_id` o servidor rejeitaria).
 */
export function toChunk(payload: Record<string, unknown>): CodeChunk | null {
  const chunkId = payload.chunk_id;
  const md5 = payload.chunk_md5;
  if (typeof chunkId !== "string" || chunkId.trim() === "") return null;
  if (typeof md5 !== "string" || md5.trim() === "") return null;

  const rawKind = payload.chunk_kind;
  const chunkKind =
    typeof rawKind === "string" && CHUNK_KINDS.has(rawKind) ? rawKind : "Symbol";

  // O indexer emite `symbol_id` como nome puro; `bareSymbol` faz o rsplit de
  // segurança contra uma versão que volte a qualificar com o caminho.
  const rawSym = payload.symbol_id;
  const symbol = bareSymbol(rawSym);

  return {
    chunk_id: chunkId,
    chunk_kind: chunkKind as CodeChunk["chunk_kind"],
    symbol_id: chunkKind === "Symbol" ? symbol : null,
    start_line: toInt(payload.start_line),
    end_line: toInt(payload.end_line),
    chunk_md5: md5,
    text: typeof payload.text === "string" ? payload.text : "",
  };
}

/**
 * Agrupa `chunk_emitted` por arquivo em `CodeFile[]` (ordem de primeira
 * aparição). Eventos de outro tipo (import/call/capabilities/job_*) são
 * ignorados nesta fatia.
 */
export function collectFiles(events: IndexerEvent[]): CodeFile[] {
  const byFile = new Map<string, CodeFile>();
  for (const ev of events) {
    if (ev.event !== "chunk_emitted") continue;
    const payload = chunkPayload(ev.payload);
    if (!payload) continue;
    const file = payload.file;
    if (typeof file !== "string" || file.trim() === "") continue;

    let entry = byFile.get(file);
    if (!entry) {
      const lang = payload.language;
      entry = {
        file_path: file,
        language: typeof lang === "string" && lang ? lang : "rust",
        chunks: [],
      };
      byFile.set(file, entry);
    }
    const chunk = toChunk(payload);
    if (chunk) entry.chunks.push(chunk);
  }
  return [...byFile.values()];
}

/**
 * Eventos → body do sync. S2 inclui `edges[]` (resolvidas); removidos/FullFile
 * sintético ficam para a S3.
 */
export function buildSyncBody(
  events: IndexerEvent[],
  identity: SyncIdentity,
): SyncBody {
  const files = collectFiles(events);
  const { imports, calls } = collectEdges(events);
  // TODO(tracer-bullet): removidos + FullFile sintético (S3).
  return {
    workspace: identity.workspace,
    program: identity.program,
    files,
    edges: resolveEdges(imports, calls, files),
  };
}

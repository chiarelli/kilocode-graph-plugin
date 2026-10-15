/**
 * `ingest/state.ts` — estado persistido da ingestão (E4-S1).
 *
 * Vive por workspace em `.kilo/graph-ingest.json`, com escrita **atômica**
 * (`write` + `rename`) — o padrão do antecessor e do `manifest.ts` (E3a):
 * um crash no meio nunca deixa um JSON pela metade.
 *
 * Guarda duas coisas (ADR-008):
 *   - `sessions[sid] = { last_ts, last_id }` — o cursor por **identidade**
 *     (nunca um contador de posição);
 *   - `sentBatchHashes` — prova de idempotência do cliente (o memtier não muda).
 *
 * Arquivo ausente/corrompido ⇒ estado **vazio** (degrada, não lança). O log do
 * reset explícito é do E4-S4 (L-3).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { SessionCursor } from "./db.ts";

/** Caminho default do estado de ingestão dentro do workspace. */
export const INGEST_STATE_REL_PATH = ".kilo/graph-ingest.json";

/** Estado persistido da ingestão por workspace. */
export interface IngestState {
  /** Cursor por sessão (`last_ts`/`last_id` do último rolê enviado). */
  sessions: Record<string, SessionCursor>;
  /** Hashes dos lotes já enviados (ordem FIFO — mais novo no fim). */
  sentBatchHashes: string[];
}

/** Estado vazio (workspace sem estado — cursor no início, sem hashes). */
export function emptyState(): IngestState {
  return { sessions: {}, sentBatchHashes: [] };
}

function isValidCursor(v: unknown): v is SessionCursor {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as SessionCursor).last_ts === "number" &&
    typeof (v as SessionCursor).last_id === "string"
  );
}

/**
 * Carrega o estado de `path`. Ausente/corrompido/parcial ⇒ vazio (o chamador
 * não lança; a ingestão recomeça do cursor inicial — custo aceito, L-3).
 * `readFile` injetável para teste.
 */
export function loadState(
  path: string,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf-8") as string,
): IngestState {
  if (!path) return emptyState();
  try {
    const parsed = JSON.parse(readFile(path)) as Partial<IngestState>;
    const sessions: Record<string, SessionCursor> = {};
    if (parsed.sessions && typeof parsed.sessions === "object") {
      for (const [sid, cur] of Object.entries(parsed.sessions)) {
        if (isValidCursor(cur)) sessions[sid] = { last_ts: cur.last_ts, last_id: cur.last_id };
      }
    }
    const hashes = Array.isArray(parsed.sentBatchHashes)
      ? parsed.sentBatchHashes.filter((h): h is string => typeof h === "string")
      : [];
    return { sessions, sentBatchHashes: hashes };
  } catch {
    // TODO(tracer-bullet): L-3 exige que o reset seja **logado**, nunca silencioso
    // (o cursor volta ao início e o próximo `session.idle` reenvia). Emitir o log
    // de reset é o endurecimento da E4-S4.
    return emptyState();
  }
}

/**
 * Grava o estado com escrita atômica (tmp + rename). Cria o `.kilo/` quando não
 * existir (sem isso a escrita falha em silêncio — defeito medido na E3a). `io`
 * injetável para teste.
 */
export function saveState(
  path: string,
  state: IngestState,
  io: {
    writeFile?: (p: string, data: string) => void;
    rename?: (from: string, to: string) => void;
    mkdir?: (p: string) => void;
  } = {},
): void {
  if (!path) return;
  const write = io.writeFile ?? ((p, d) => writeFileSync(p, d, "utf-8"));
  const rename = io.rename ?? renameSync;
  const mkdir = io.mkdir ?? ((p) => void mkdirSync(p, { recursive: true }));
  const dir = dirname(path);
  if (dir && dir !== ".") mkdir(dir);
  const tmp = `${path}.tmp`;
  write(tmp, `${JSON.stringify(state, null, 2)}\n`);
  rename(tmp, path);
}

/** `true` quando o lote (pelo hash) já foi enviado neste workspace. */
export function hasSentBatch(state: IngestState, hash: string): boolean {
  return state.sentBatchHashes.includes(hash);
}

/** Registra o hash do lote recém-aceito (chamado **só após** o 202 — L-1). */
export function markBatchSent(state: IngestState, hash: string): void {
  state.sentBatchHashes.push(hash);
}

/** Atualiza o cursor da sessão (avança sobre o último rolê lido). */
export function setCursor(state: IngestState, sessionId: string, cursor: SessionCursor): void {
  state.sessions[sessionId] = cursor;
}

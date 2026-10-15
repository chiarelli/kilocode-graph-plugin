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

/**
 * Registro auditável de um lote **aceito** (L-1). O `202` confirma o **aceite**,
 * não o processamento: `confirmed` é sempre `false` e existe justamente para
 * tornar a incerteza explícita — o operador pode identificar um lote perdido pelo
 * `job_id`/`hash`/`reference_time`. **Não** há reenvio nem espera por confirmação.
 */
export interface SentBatchAudit {
  hash: string;
  job_id?: string;
  reference_time: string;
  /** ISO-8601 do momento do aceite. */
  accepted_at: string;
  /** Sempre `false`: a confirmação seria de processamento, que não existe. */
  confirmed: false;
}

/** Estado persistido da ingestão por workspace. */
export interface IngestState {
  /** Cursor por sessão (`last_ts`/`last_id` do último rolê enviado). */
  sessions: Record<string, SessionCursor>;
  /** Hashes dos lotes já enviados (ordem FIFO — mais novo no fim). */
  sentBatchHashes: string[];
  /** Auditoria dos lotes aceitos (L-1; FIFO, mesmo teto dos hashes). */
  sentBatches?: SentBatchAudit[];
}

/** Estado vazio (workspace sem estado — cursor no início, sem hashes). */
export function emptyState(): IngestState {
  return { sessions: {}, sentBatchHashes: [], sentBatches: [] };
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
 * `readFile` injetável para teste; `onReset` é chamado (com o motivo) quando o
 * estado **não pôde** ser lido — o reset **nunca** é silencioso (L-3): a rotina
 * passa um logger aqui.
 */
export function loadState(
  path: string,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf-8") as string,
  onReset?: (reason: string) => void,
): IngestState {
  if (!path) return emptyState();
  let raw: string;
  try {
    raw = readFile(path);
  } catch (err) {
    // Arquivo ausente/ilegível (ENOENT, permissão): estado vazio. Para o ENOENT
    // de workspace NOVO isso é normal; o logger da rotina decide o nível.
    onReset?.(`ilegível: ${err instanceof Error ? err.message : String(err)}`);
    return emptyState();
  }
  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(raw);
  } catch (err) {
    // JSON corrompido: degrada para vazio, mas **registra** (o cursor volta ao
    // início e o próximo `session.idle` reenvia — comportamento do L-3, não
    // surpresa).
    onReset?.(`JSON corrompido: ${err instanceof Error ? err.message : String(err)}`);
    return emptyState();
  }
  // JSON válido mas de shape errado (`[]`, `123`, `"x"`, `null`) é tão
  // inutilizável quanto corrompido: o estado some (cursor ao início, reenvio) e,
  // sem este guard, o reset passaria **silencioso** (fere o L-3). `null`/escalar
  // lançaria ao ler `.sessions`; array devolveria `undefined` sem lançar.
  if (parsedRaw === null || typeof parsedRaw !== "object" || Array.isArray(parsedRaw)) {
    onReset?.(`shape inválido: ${Array.isArray(parsedRaw) ? "array" : typeof parsedRaw}`);
    return emptyState();
  }
  {
    const parsed = parsedRaw as Partial<IngestState>;
    const sessions: Record<string, SessionCursor> = {};
    if (parsed.sessions && typeof parsed.sessions === "object") {
      for (const [sid, cur] of Object.entries(parsed.sessions)) {
        if (isValidCursor(cur)) sessions[sid] = { last_ts: cur.last_ts, last_id: cur.last_id };
      }
    }
    const hashes = Array.isArray(parsed.sentBatchHashes)
      ? parsed.sentBatchHashes.filter((h): h is string => typeof h === "string")
      : [];
    const audit = Array.isArray(parsed.sentBatches)
      ? parsed.sentBatches.filter(
          (a): a is SentBatchAudit =>
            typeof a === "object" && a !== null && typeof (a as SentBatchAudit).hash === "string",
        )
      : [];
    return { sessions, sentBatchHashes: hashes, sentBatches: audit };
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

/**
 * Teto default de hashes por workspace (L-2). Generoso: cobre a janela em que a
 * mesma mensagem pode ser relida (o L-3). O antecessor acumulou 181+109 sem
 * limite; aqui o arquivo **não** cresce indefinidamente.
 */
export const DEFAULT_MAX_HASHES = 5000;

/**
 * Registra o hash do lote recém-aceito (chamado **só após** o 202 — L-1),
 * aplicando o **teto FIFO** (L-2): ao ultrapassar `maxHashes`, os hashes mais
 * antigos são evictados. O teto é por contagem (determinístico e testável), não
 * TTL. Um hash repetido não é re-inserido (evita lixo de duplicatas).
 */
export function markBatchSent(
  state: IngestState,
  hash: string,
  maxHashes: number = DEFAULT_MAX_HASHES,
): void {
  if (!state.sentBatchHashes.includes(hash)) state.sentBatchHashes.push(hash);
  // `maxHashes <= 0` ⇒ sem teto (unlimited); do contrário, FIFO até caber.
  if (maxHashes > 0 && state.sentBatchHashes.length > maxHashes) {
    state.sentBatchHashes.splice(0, state.sentBatchHashes.length - maxHashes);
  }
}

/**
 * Registra o lote aceito na **auditoria** (L-1): "enviado e aceito, **não**
 * confirmado". Chamado junto com `markBatchSent` (após o 202). Mantém o mesmo
 * teto FIFO dos hashes para não crescer sem limite.
 */
export function markBatchAccepted(
  state: IngestState,
  audit: SentBatchAudit,
  maxHashes: number = DEFAULT_MAX_HASHES,
): void {
  state.sentBatches = state.sentBatches ?? [];
  state.sentBatches.push(audit);
  if (maxHashes > 0 && state.sentBatches.length > maxHashes) {
    state.sentBatches.splice(0, state.sentBatches.length - maxHashes);
  }
}

/** Atualiza o cursor da sessão (avança sobre o último rolê lido). */
export function setCursor(state: IngestState, sessionId: string, cursor: SessionCursor): void {
  state.sessions[sessionId] = cursor;
}

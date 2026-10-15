/**
 * `ingest/db.ts` — leitura do `kilo.db` (E4-S1, tracer bullet).
 *
 * Fonte de verdade da ingestão: o conteúdo **nunca** vem do payload do evento
 * (ADR-007). Aqui se localiza o banco de sessões, se lê `message` + `part` e se
 * remonta o texto de cada mensagem (user E assistant).
 *
 * Backend SQLite: o runtime do Kilo pode ser Bun ou Node. Segue o antecessor
 * (`openviking-memory.js:975`): tenta `bun:sqlite`, depois `node:sqlite`. O
 * `import` é feito por especificador **não-literal** de propósito — o `tsc` não
 * resolve tipos de nenhum dos dois e o backend é tratado como dinâmico.
 *
 * Cursor por **identidade** `(time_created, id)` — nunca `OFFSET` (ADR-008): o
 * avanço é uma tupla, imune à remoção de linhas antes do cursor.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Fallback quando nenhum `.kilo/kilo.db` é achado a partir do workspace. */
export const DEFAULT_DB_PATH = join(homedir(), ".local/share/kilo/kilo.db");

/** Um resultado cru do SQLite (coluna → valor). */
export type DbRow = Record<string, unknown>;

/** Porta mínima de leitura do SQLite (permite backend falso em teste). */
export interface SqliteBackend {
  query(sql: string, params: unknown[]): DbRow[];
  close(): void;
}

/** Rolê já normalizada que a ingestão consome. */
export interface IngestMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Epoch ms (`message.time_created`). */
  time_created: number;
}

/** Cursor por identidade — par do último rolê lido (ADR-008). */
export interface SessionCursor {
  last_ts: number;
  last_id: string;
}

/** Resultado de uma leitura do banco em torno do cursor. */
export interface ReadBatch {
  /** Mensagens com texto (user/assistant), na ordem do banco. */
  messages: IngestMessage[];
  /** Par `(time_created, id)` do último rolê LIDO (avança o cursor), ou `null`. */
  last: SessionCursor | null;
  /** Nº de LINHAS lidas (não só as com texto) — decide o limiar do gatilho. */
  rows: number;
}

/**
 * Localiza o `kilo.db` a partir do diretório do projeto (caminhos do antecessor,
 * `openviking-memory.js:370`): `.kilo/kilo.db`, `.devcontainer/kilo/local/kilo.db`,
 * até 5 níveis acima (`<parent>/.kilo/kilo.db`) e, por fim, o banco global.
 * Nunca retorna `""` — devolve o candidato de fallback (o backend decide).
 */
export function findKiloDb(
  projectDir: string,
  exists: (p: string) => boolean = existsSync,
): string {
  const candidates = [
    join(projectDir, ".kilo", "kilo.db"),
    join(projectDir, ".devcontainer", "kilo", "local", "kilo.db"),
  ];
  for (const p of candidates) {
    if (exists(p)) return p;
  }
  let dir = projectDir;
  for (let i = 0; i < 5; i++) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const p = join(dir, ".kilo", "kilo.db");
    if (exists(p)) return p;
  }
  return DEFAULT_DB_PATH;
}

/** Backend falso/injetável construído sobre uma função `query` (teste). */
export function fakeBackend(
  query: (sql: string, params: unknown[]) => DbRow[],
): SqliteBackend {
  return { query, close: () => {} };
}

/** `bun:sqlite` → porta única. `Database` exige `{ readonly }` (minúsculo). */
async function openBunBackend(dbPath: string): Promise<SqliteBackend | null> {
  try {
    const spec = "bun:sqlite";
    const mod = (await import(spec)) as {
      Database?: new (p: string, o?: unknown) => unknown;
      default?: { Database?: new (p: string, o?: unknown) => unknown };
    };
    const Database = mod.Database ?? mod.default?.Database ?? mod.default;
    if (typeof Database !== "function") return null;
    const db = new Database(dbPath, { readonly: true }) as {
      query: (sql: string) => { all: (...p: unknown[]) => DbRow[] };
      close: () => void;
    };
    return {
      query: (sql, params) => db.query(sql).all(...params),
      close: () => db.close(),
    };
  } catch {
    return null;
  }
}

/** `node:sqlite` → porta única. `DatabaseSync` exige `{ readOnly }` (camelCase). */
async function openNodeBackend(dbPath: string): Promise<SqliteBackend | null> {
  try {
    const spec = "node:sqlite";
    const mod = (await import(spec)) as {
      DatabaseSync?: new (p: string, o?: unknown) => unknown;
    };
    const Database = mod.DatabaseSync;
    if (typeof Database !== "function") return null;
    const db = new Database(dbPath, { readOnly: true }) as {
      prepare: (sql: string) => { all: (...p: unknown[]) => DbRow[] };
      close: () => void;
    };
    return {
      query: (sql, params) => db.prepare(sql).all(...params),
      close: () => db.close(),
    };
  } catch {
    return null;
  }
}

/**
 * Abre o banco em modo leitura (bun:sqlite → node:sqlite). Lança quando nenhum
 * backend funciona/abre — o chamador degrada (nunca silencioso, ADR-007).
 */
export async function openSqliteBackend(dbPath: string): Promise<SqliteBackend> {
  const bun = await openBunBackend(dbPath);
  if (bun) return bun;
  const node = await openNodeBackend(dbPath);
  if (node) return node;
  throw new Error(`nenhum backend SQLite disponível para ${dbPath}`);
}

/** `true` quando o rolê é user/assistant (o gatilho não filtra, o leitor sim). */
function isIngestRole(role: unknown): role is "user" | "assistant" {
  return role === "user" || role === "assistant";
}

/** Texto dos `part` de tipo `text` de uma mensagem (injetável p/ teste). */
function reconstructContent(
  backend: SqliteBackend,
  msgId: string,
  parsed: { role?: unknown; mode?: unknown; summary?: { diffs?: unknown } },
): string {
  if (parsed.role === "assistant" && parsed.mode === "compaction") {
    // TODO(tracer-bullet): placeholder idêntico para toda compactação (40 linhas
    // no banco real) ⇒ várias mensagens com o MESMO conteúdo colidem no
    // `batchHash` e o lote pode ser deduplicado indevidamente. A linha traz um
    // `summary` real (hoje descartado) — extraí-lo (ou dar identidade a cada
    // mensagem) é o endurecimento da E4-S2.
    return "[session compacted]";
  }
  let rows: DbRow[];
  try {
    rows = backend.query("SELECT data FROM part WHERE message_id = ?", [msgId]);
  } catch {
    // TODO(tracer-bullet): falha transitória do `part` (SQLITE_BUSY/WAL) é
    // tratada como "sem texto" e o cursor avança — perde a mensagem. Distinguir
    // "sem texto" de "ilegível" e NÃO avançar (retry no próximo gatilho) é o
    // endurecimento da E4-S2.
    rows = [];
  }
  const texts: string[] = [];
  for (const r of rows) {
    const raw = r.data;
    if (typeof raw !== "string") continue;
    let p: { type?: unknown; text?: unknown };
    try {
      p = JSON.parse(raw) as { type?: unknown; text?: unknown };
    } catch {
      continue;
    }
    if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
      texts.push(p.text.trim());
    }
  }
  if (texts.length > 0) return texts.join("\n");
  // Fallback do antecessor: mensagem de usuário pode trazer o texto nos diffs.
  if (parsed.role === "user" && Array.isArray(parsed.summary?.diffs)) {
    return parsed.summary.diffs.filter((d): d is string => typeof d === "string").join("\n");
  }
  return "";
}

/**
 * Lê até `limit` mensagens da sessão **após** o cursor, na ordem
 * `(time_created, id)` — sem `OFFSET` (ADR-008). Só user/assistant com texto
 * viram `messages`; o cursor avança sobre o último rolê **lido** (inclusive os
 * sem texto, para não travar o limiar).
 */
export function readBatch(
  backend: SqliteBackend,
  sessionId: string,
  cursor: SessionCursor,
  limit: number,
): ReadBatch {
  const rows = backend.query(
    "SELECT id, time_created, data FROM message " +
      "WHERE session_id = ? " +
      "AND (time_created > ? OR (time_created = ? AND id > ?)) " +
      "ORDER BY time_created ASC, id ASC LIMIT ?",
    [sessionId, cursor.last_ts, cursor.last_ts, cursor.last_id, limit],
  );

  const messages: IngestMessage[] = [];
  let last: SessionCursor | null = null;
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id : "";
    const ts = typeof row.time_created === "number" ? row.time_created : Number(row.time_created);
    if (!id || !Number.isFinite(ts)) continue;
    last = { last_ts: ts, last_id: id };

    const raw = row.data;
    if (typeof raw !== "string") continue;
    let parsed: { role?: unknown; mode?: unknown; summary?: { diffs?: unknown } };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      // TODO(tracer-bullet): linha com `data` ilegível avança o cursor em
      // silêncio (nem `debug`). Registrar e decidir skip×retry (linha veneno não
      // pode ser invisível) é o endurecimento da E4-S2.
      continue;
    }
    if (!isIngestRole(parsed.role)) continue;
    const content = reconstructContent(backend, id, parsed);
    if (!content) continue;
    messages.push({ id, role: parsed.role, content, time_created: ts });
  }

  return { messages, last, rows: rows.length };
}

/** Leitor de arquivo injetável (mantido para testes/uso futuro). */
export type ReadFileLike = (path: string) => string;

/** Leitor default (utf-8). Exportado para reuso simétrico entre os módulos. */
export function defaultReadFile(path: string): string {
  return readFileSync(path, "utf-8") as string;
}

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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { debug, log, logFatal } from "../logger.ts";

/** Nome do arquivo do banco de sessões do Kilo (fixo por decisão do runtime). */
export const KILO_DB_FILENAME = "kilo.db";

/**
 * Fallback determinístico quando o runtime não responde: é o **próprio default
 * do runtime** no Linux (`~/.local/share/kilo/kilo.db`). Nunca é um caminho
 * inventado pelo plugin — apenas a última reserva se `GET /path` falhar.
 */
export const DEFAULT_DB_PATH = join(homedir(), ".local/share", "kilo", KILO_DB_FILENAME);

/**
 * Porta mínima de `client.path` do Kilo (o runtime expõe `GET /path` → diretórios
 * de estado/config do workspace). Estrutural: um fake em teste a implementa.
 */
export interface RuntimePathClient {
  path?: {
    get(opts: { query: { directory: string } }): Promise<{
      data?: { state?: unknown };
      error?: unknown;
    }>;
  };
}

/**
 * Resolve o caminho do `kilo.db` a partir do **runtime do Kilo** — o valor que o
 * runtime já determinou no boot (nunca `process.cwd()`, nunca env var). O
 * diretório de estado vem de `client.path.get().state`; o banco é
 * `<state>/kilo.db`. **Nunca lança** (NFR-03): sem a API do client, resposta
 * inválida ou erro ⇒ log e fallback para o default do runtime.
 */
export async function resolveRuntimeDbPath(
  client: RuntimePathClient | undefined,
  directory: string,
): Promise<string> {
  const pathApi = client?.path;
  if (!pathApi) {
    debug("ingest: client.path indisponível; usando o db default do runtime");
    return DEFAULT_DB_PATH;
  }
  try {
    const res = await pathApi.get({ query: { directory } });
    const state = res.data?.state;
    if (typeof state === "string" && state.trim() !== "") {
      const dbPath = join(state, KILO_DB_FILENAME);
      debug(`ingest: db do runtime resolvido em ${dbPath}`);
      return dbPath;
    }
    log(
      "ingest: `client.path.get` não devolveu `state`; usando o db default do runtime",
    );
  } catch (err) {
    logFatal("ingest resolve db path", err);
  }
  return DEFAULT_DB_PATH;
}

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

/**
 * Provedor do backend com **abertura lazy e retentável**. Um `kilo.db` ainda
 * não criado no 1º evento (ou um `SQLITE_BUSY` transitório) não pode inutilizar
 * a ingestão até o próximo restart (defeito medido na revisão adversarial da
 * E4-S1): a falha **não** é cacheada — a próxima chamada tenta abrir de novo. O
 * handle é fechado por `close()`, que o `dispose` do plugin drena.
 */
export interface BackendProvider {
  get(): Promise<SqliteBackend>;
  close(): void;
}

/** Provedor real (abre `dbPath` sob demanda); `open`/`onError` injetáveis. */
export function createBackendProvider(
  dbPath: string,
  opts: {
    open?: (p: string) => Promise<SqliteBackend>;
    onError?: (err: unknown) => void;
  } = {},
): BackendProvider {
  const open = opts.open ?? openSqliteBackend;
  let current: SqliteBackend | null = null;
  let inflight: Promise<SqliteBackend> | null = null;
  return {
    get: async () => {
      if (current) return current;
      if (!inflight) {
        inflight = open(dbPath)
          .then((b) => {
            current = b;
            return b;
          })
          .catch((err) => {
            // Não cacheia a falha: a próxima chamada tenta de novo.
            inflight = null;
            opts.onError?.(err);
            throw err;
          });
      }
      return inflight;
    },
    close: () => {
      const b = current;
      current = null;
      inflight = null;
      if (b) {
        try {
          b.close();
        } catch {
          // Fechar nunca pode derrubar o shutdown (NFR-03).
        }
      }
    },
  };
}

/** `true` quando o rolê é user/assistant (o gatilho não filtra, o leitor sim). */
function isIngestRole(role: unknown): role is "user" | "assistant" {
  return role === "user" || role === "assistant";
}

/**
 * Falha ao ler o banco (backend ocupado/WAL, arquivo travado). É **transitória**
 * por natureza: a leitura aborta e o cursor **não** avança, para o próximo
 * gatilho reler as mesmas mensagens. Distinta de "mensagem sem texto" (que
 * avança) — confundir as duas perde mensagens para sempre (defeito medido na
 * revisão adversarial da E4-S1).
 */
export class IngestReadError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "IngestReadError";
  }
}

/**
 * Texto dos `part` de tipo `text` de uma mensagem. Lança quando a consulta dos
 * `part` falha (banco ocupado/WAL): o chamador NÃO pode tratar isso como "sem
 * texto" — senão o cursor avança e a mensagem é perdida para sempre (defeito
 * medido na revisão adversarial da E4-S1).
 */
function reconstructContent(
  backend: SqliteBackend,
  msgId: string,
  parsed: { role?: unknown; mode?: unknown; summary?: unknown },
): string {
  // Compactação: o antecessor devolve o marcador literal e **não** consulta os
  // `part` (vazios). `summary` é um booleano no banco real — não há resumo a
  // extrair. Mantido idêntico ao antecessor para não divergir do corpus dele.
  if (parsed.role === "assistant" && parsed.mode === "compaction") {
    return "[session compacted]";
  }
  // Sem `try/catch`: erro de leitura propaga como `IngestReadError` (abaixo),
  // distinguindo "sem texto" de "não consegui ler".
  const rows = backend.query("SELECT data FROM part WHERE message_id = ?", [msgId]);
  const texts: string[] = [];
  for (const r of rows) {
    const raw = r.data;
    if (typeof raw !== "string") continue;
    let p: unknown;
    try {
      p = JSON.parse(raw);
    } catch {
      continue;
    }
    // `JSON.parse` de `"null"`/`"123"`/`'"x"'` NÃO é um objeto: sem este guard,
    // `p.type` lançaria `TypeError`, que `readBatch` classificaria como falha
    // TRANSITÓRIA de leitura (`IngestReadError`) — o cursor nunca avançaria e a
    // linha reprocessaria para sempre (achado da revisão adversarial). Não-objeto
    // é linha de `part` corrompida: pula (é irrecuperável), não trava.
    if (p === null || typeof p !== "object") continue;
    const part = p as { type?: unknown; text?: unknown };
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      texts.push(part.text.trim());
    }
  }
  if (texts.length > 0) return texts.join("\n");
  // Fallback do antecessor: mensagem de usuário pode trazer o texto nos diffs
  // (`summary.diffs`); no banco real `summary` é booleano, então o guard de array
  // segue valendo (defensivo, nunca dispara hoje).
  const summary = parsed.summary as { diffs?: unknown } | undefined;
  if (parsed.role === "user" && Array.isArray(summary?.diffs)) {
    return summary.diffs.filter((d): d is string => typeof d === "string").join("\n");
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
  onPoison?: (msgId: string) => void,
): ReadBatch {
  let rows: DbRow[];
  try {
    rows = backend.query(
      "SELECT id, time_created, data FROM message " +
        "WHERE session_id = ? " +
        "AND (time_created > ? OR (time_created = ? AND id > ?)) " +
        "ORDER BY time_created ASC, id ASC LIMIT ?",
      [sessionId, cursor.last_ts, cursor.last_ts, cursor.last_id, limit],
    );
  } catch (err) {
    // Leitura do banco falhou (ocupado/WAL): aborta SEM avançar o cursor — o
    // próximo gatilho relê o mesmo lote (nada é perdido nem enviado).
    throw new IngestReadError(`leitura de message falhou (${sessionId})`, err);
  }

  const messages: IngestMessage[] = [];
  let last: SessionCursor | null = null;
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id : "";
    // `time_created` é `integer NOT NULL` no banco real, mas `Number(null)===0`
    // e `Number("")===0` são finitos — um valor ausente viraria epoch 0 e
    // poluiria o `reference_time` do lote. Só aceita número ou string numérica
    // (nunca `null`/vazio/booleano). Linha sem ts válido é pulada.
    const ts = coerceEpoch(row.time_created);
    if (!id || ts === null) continue;

    const raw = row.data;
    if (typeof raw !== "string") {
      // Rolê sem payload textual: não há conteúdo a ler; avança (não trava).
      last = { last_ts: ts, last_id: id };
      continue;
    }
    let rawParsed: unknown;
    try {
      rawParsed = JSON.parse(raw);
    } catch {
      // Linha "veneno": o `data` não é JSON. Não é recuperável reprocessando
      // (o conteúdo é irrecuperável de fato), então o cursor avança — mas é
      // **registrado**, nunca silencioso.
      last = { last_ts: ts, last_id: id };
      onPoison?.(id);
      continue;
    }
    // `"null"`/`"123"`/`'"x"'`/`"[]"` são JSON válido mas não-objeto: sem este
    // guard, `parsed.role` lançaria `TypeError` FORA do `try` acima, e o cursor
    // nunca avançaria (linha veneno reprocessada para sempre). Pula e registra.
    if (rawParsed === null || typeof rawParsed !== "object" || Array.isArray(rawParsed)) {
      last = { last_ts: ts, last_id: id };
      onPoison?.(id);
      continue;
    }
    const parsed = rawParsed as { role?: unknown; mode?: unknown; summary?: unknown };
    if (!isIngestRole(parsed.role)) {
      last = { last_ts: ts, last_id: id };
      continue;
    }
    let content: string;
    try {
      content = reconstructContent(backend, id, parsed);
    } catch (err) {
      // Os `part` não puderam ser lidos: NÃO avança o cursor (nem marca este
      // rolê como lido) — a mensagem será relida no próximo gatilho. Lança para
      // a rotina degradar sem enviar um lote incompleto.
      throw new IngestReadError(`leitura de part falhou (${msgIdSafe(id)})`, err);
    }
    last = { last_ts: ts, last_id: id };
    if (!content) continue;
    messages.push({ id, role: parsed.role, content, time_created: ts });
  }

  return { messages, last, rows: rows.length };
}

/** ID para mensagem de erro (o próprio id já é string; guarda contra vazio). */
function msgIdSafe(id: string): string {
  return id || "?";
}

/**
 * Converte `time_created` num epoch ms finito, ou `null` quando não há número
 * confiável. Recusa explicitamente `null`/`undefined`/booleano/string vazia
 * (cujo `Number(...)` é `0`, não um epoch real) — sem isso um valor ausente
 * viraria epoch 0 e corromperia `reference_time` e a ordenação do cursor.
 */
function coerceEpoch(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Leitor de arquivo injetável (mantido para testes/uso futuro). */
export type ReadFileLike = (path: string) => string;

/** Leitor default (utf-8). Exportado para reuso simétrico entre os módulos. */
export function defaultReadFile(path: string): string {
  return readFileSync(path, "utf-8") as string;
}

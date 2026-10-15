/**
 * Hook da ingestão (E4-S1) — thin.
 *
 * Registra o hook genérico `event` do Kilo e, ao ver `message.updated` (na S3
 * também `session.idle`), **acorda** a rotina em background. O evento é só
 * sinal: nem o payload nem `parts` são fonte de conteúdo (ADR-007) — a rotina lê
 * o `kilo.db`.
 *
 * Nunca bloqueia o turno (FR-203): o handler resolve assim que dispara a rotina
 * (`void runIngest(...)`); a trava por sessão evita corrida entre os eventos
 * repetidos (`message.updated` dispara 2–3× por mensagem — medido).
 */

import { debug, logFatal } from "../logger.ts";
import { openSqliteBackend, type SqliteBackend } from "../ingest/db.ts";
import {
  runIngest,
  type IngestClient,
  type IngestConfig,
  type IngestRuntime,
} from "../ingest/routine.ts";

/** Dependências do hook (injetáveis para teste, sem banco/rede reais). */
export interface IngestHookRuntime {
  cfg: IngestConfig;
  /** Caminho do `kilo.db` (resolvido por `findKiloDb` no boot). */
  dbPath: string;
  /** Caminho do estado (`.kilo/graph-ingest.json`). */
  statePath: string;
  client: IngestClient;
  /** Backend SQLite injetável (teste) — quando ausente, abre o real. */
  backend?: SqliteBackend;
  /** Trava compartilhada entre os gatilhos (default criada aqui). */
  lock?: Set<string>;
}

/** Forma mínima do `Event` do SDK que a ingestão consome. */
interface EventLike {
  type?: unknown;
  properties?: {
    info?: { sessionID?: unknown };
    sessionID?: unknown;
  };
}

/** Extrai o `sessionID` do evento (`message.updated` traz em `properties.info`). */
export function sessionIdFromEvent(event: EventLike): string | null {
  const fromInfo = event.properties?.info?.sessionID;
  if (typeof fromInfo === "string" && fromInfo) return fromInfo;
  const fromProps = event.properties?.sessionID;
  if (typeof fromProps === "string" && fromProps) return fromProps;
  return null;
}

/**
 * Registra o gatilho `event`. Na S1 só `message.updated` acorda a rotina; o
 * `session.idle` (drenar tudo) entra na S3 apontando para a MESMA rotina.
 */
export function ingestHook(rt: IngestHookRuntime) {
  const lock = rt.lock ?? new Set<string>();
  const routineRt: IngestRuntime = {
    cfg: rt.cfg,
    statePath: rt.statePath,
    client: rt.client,
    lock,
  };

  // TODO(tracer-bullet): a promessa do backend é cacheada para sempre — uma
  // falha transitória no 1º evento (banco ainda não criado, SQLITE_BUSY) só é
  // recuperada reiniciando o plugin, e o handle nunca é fechado no `dispose`
  // (fd fica aberto). Retry da abertura + `close()` no shutdown é o
  // endurecimento da E4-S2.
  let backendPromise: Promise<SqliteBackend | null> | null = null;
  const getBackend = (): Promise<SqliteBackend | null> => {
    if (rt.backend) return Promise.resolve(rt.backend);
    if (!backendPromise) {
      backendPromise = openSqliteBackend(rt.dbPath).catch((err) => {
        // Degradação explícita (ADR-007): sem banco, a ingestão não roda — mas
        // nunca é silencioso.
        logFatal(`ingest open db (${rt.dbPath})`, err);
        return null;
      });
    }
    return backendPromise;
  };

  return {
    event: async (input: { event: unknown }): Promise<void> => {
      if (!rt.cfg.enabled) return;
      const event = (input?.event ?? {}) as EventLike;
      if (event.type !== "message.updated") return;
      const sessionId = sessionIdFromEvent(event);
      if (!sessionId) return;
      const backend = await getBackend();
      if (!backend) return;
      debug(`ingest wake session=${sessionId}`);
      // Background: o evento NUNCA espera a ingestão (FR-203). `runIngest`
      // engole os erros; a promessa não é drenada no shutdown.
      void runIngest(routineRt, backend, sessionId);
    },
  };
}

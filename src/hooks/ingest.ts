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
import {
  createBackendProvider,
  type BackendProvider,
  type SqliteBackend,
} from "../ingest/db.ts";
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
 * Registra o gatilho `event`. Os **dois** eventos apontam para a MESMA rotina
 * (ADR-007): `message.updated` só envia com o lote cheio; `session.idle` drena
 * tudo **inclusive o resto** (`drainAll`). A diferença é o parâmetro, não duas
 * implementações.
 */
export function ingestHook(rt: IngestHookRuntime) {
  const lock = rt.lock ?? new Set<string>();
  const routineRt: IngestRuntime = {
    cfg: rt.cfg,
    statePath: rt.statePath,
    client: rt.client,
    lock,
  };

  // Backend lazy e **retentável** (revisão adversarial da E4-S1): falha de
  // abertura não é cacheada, e o handle é fechado no `dispose`. Backend
  // injetado (teste) tem precedência e é embrulhado num provedor trivial.
  const provider: BackendProvider = rt.backend
    ? { get: async () => rt.backend!, close: () => {} }
    : createBackendProvider(rt.dbPath, {
        // Degradação explícita (ADR-007): sem banco a ingestão não roda — mas
        // nunca é silencioso.
        onError: (err) => logFatal(`ingest open db (${rt.dbPath})`, err),
      });

  return {
    event: async (input: { event: unknown }): Promise<void> => {
      if (!rt.cfg.enabled) return;
      const event = (input?.event ?? {}) as EventLike;
      // Os dois gatilhos acordam a MESMA rotina; `session.idle` leva `drainAll`.
      const drainAll =
        event.type === "session.idle"
          ? true
          : event.type === "message.updated"
            ? false
            : null;
      if (drainAll === null) return;
      const sessionId = sessionIdFromEvent(event);
      if (!sessionId) return;
      let backend: SqliteBackend;
      try {
        backend = await provider.get();
      } catch {
        // Já logado pelo `onError`; o próximo evento tenta abrir de novo.
        return;
      }
      debug(`ingest wake session=${sessionId} type=${event.type} drain=${drainAll}`);
      // Background: o evento NUNCA espera a ingestão (FR-203). `runIngest`
      // engole os erros; a promessa não é drenada no shutdown.
      void runIngest(routineRt, backend, sessionId, drainAll);
    },
    dispose: (): void => provider.close(),
  };
}

/**
 * Cliente HTTP do memtier (E1-S1, decisão 5).
 *
 * A E1 entrega só o necessário para o tracer (`health`) — recall/sync/ingest
 * entram na epic dona. O `fetch` é **injetável** (default `globalThis.fetch`)
 * para permitir stub em teste unitário sem rede real.
 *
 * Regra de degradação (NFR-03): `health()` **nunca lança**. Falha de
 * rede/timeout vira `HealthReport { ok:false, reason }`.
 */

import type { HealthReport } from "./types.ts";

/** Assinatura mínima de `fetch` usada pelo cliente (permite stub em teste). */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface MemtierClientOptions {
  /** Base do memtier (ex.: `http://127.0.0.1:8400`). */
  url: string;
  /** Bearer já resolvido (env nesta fatia). Vazio ⇒ sem header. */
  token?: string;
  /** Timeout por request do health. */
  timeout_ms?: number;
  /** `fetch` injetável (default `globalThis.fetch`). */
  fetch?: FetchLike;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 2000;

/** Deriva `ok` do status textual do servidor. */
function reportFromBody(
  status: string,
  body: Partial<HealthReport>,
): HealthReport {
  return {
    ok: status === "ok",
    status,
    falkordb: body.falkordb ?? "unknown",
    indices: body.indices ?? "unknown",
    error: body.error ?? null,
  };
}

/** Report degradado por falha de transporte (rede/timeout/abort). */
function transportFailure(reason: string): HealthReport {
  return {
    ok: false,
    status: "degraded",
    falkordb: "unknown",
    indices: "unknown",
    error: null,
    reason,
  };
}

export class MemtierClient {
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: MemtierClientOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.token = options.token ?? "";
    this.timeoutMs = options.timeout_ms ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
  }

  /** Headers comuns; `Authorization` só quando há token. Nunca loga o token. */
  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  /**
   * `GET /v1/health`. Sempre resolve num `HealthReport`; nunca lança no caminho
   * de degradação (NFR-03). `200` com `status:"ok"` ⇒ `ok:true`; `503` com
   * `status:"degraded"` ⇒ `ok:false`; erro de rede/timeout ⇒ `ok:false, reason`.
   */
  async health(signal?: AbortSignal): Promise<HealthReport> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}/v1/health`, {
        method: "GET",
        headers: this.headers(),
        signal: combined,
      });
    } catch (err) {
      // TODO(tracer-bullet): retry/backoff e distinção fina de causa (S2).
      return transportFailure(err instanceof Error ? err.message : String(err));
    }

    let body: Partial<HealthReport> = {};
    try {
      body = (await res.json()) as Partial<HealthReport>;
    } catch {
      // Body não-JSON num health degradado: deriva pelo status HTTP.
      return transportFailure(`non-JSON body (HTTP ${res.status})`);
    }

    const status = typeof body.status === "string" ? body.status : "degraded";
    return reportFromBody(status, body);
  }
}

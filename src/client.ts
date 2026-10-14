/**
 * Cliente HTTP do memtier (E1-S1 tracer; endurecido na E1-S2).
 *
 * A E1 entrega só o necessário para o tracer (`health`) + o que as próximas
 * epics consomem (identidade, token, erros tipados, `request` genérico). O
 * `fetch` e o leitor de arquivo são **injetáveis** para teste unitário sem rede.
 *
 * Regra de degradação (NFR-03): `health()` **nunca lança**. Já `request()`
 * (caminho de dados, dono futuro: E2/E3a) lança **erros tipados** para o
 * chamador decidir degradar.
 */

import { readFileSync } from "node:fs";

import type { HealthReport } from "./types.ts";

/** Assinatura mínima de `fetch` usada pelo cliente (permite stub em teste). */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Leitor de arquivo injetável (default `readFileSync` em utf-8). */
export type ReadFileLike = (path: string) => string;

export interface MemtierClientOptions {
  /** Base do memtier (ex.: `http://127.0.0.1:8400`). */
  url: string;
  /** Nome lógico do workspace (`workspaceName(dir)`). */
  workspace?: string;
  /** Programa (E11, default `"default"`). */
  program?: string;
  /** Bearer resolvido de `KILOCODE_GRAPH_TOKEN` (env) — vence o `token_file`. */
  token?: string;
  /** Caminho do arquivo de token (`{ token, workspace, program }`). Lazy. */
  token_file?: string;
  /** Timeout por request (ms). */
  timeout_ms?: number;
  /** Timeout do health (ms) — default 2000. */
  health_timeout_ms?: number;
  /** `fetch` injetável (default `globalThis.fetch`). */
  fetch?: FetchLike;
  /** Leitor de arquivo injetável (default `readFileSync` utf-8). */
  readFile?: ReadFileLike;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_HEALTH_TIMEOUT_MS = 2000;

/** Erro HTTP base — carrega o status para o chamador decidir. */
export class MemtierHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MemtierHttpError";
    this.status = status;
  }
}

/** `401`/`403` — token ausente/revogado ou sem capability. */
export class AuthError extends MemtierHttpError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = "AuthError";
  }
}

/** `503` — infraestrutura indisponível (IAM/FalkorDB/Redis down). */
export class InfraError extends MemtierHttpError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = "InfraError";
  }
}

/** Mapeia um status HTTP não-2xx num erro tipado reconhecível. */
export function httpError(status: number, detail: string): MemtierHttpError {
  const msg = `memtier HTTP ${status}: ${detail}`;
  if (status === 401 || status === 403) return new AuthError(status, msg);
  if (status === 503) return new InfraError(status, msg);
  return new MemtierHttpError(status, msg);
}

/** Deriva `ok` do status textual do servidor. */
function reportFromBody(status: string, body: Partial<HealthReport>): HealthReport {
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

/** Identidade lógica do escopo (E11) — nunca `group_id` (a borda resolve). */
export interface Identity {
  workspace: string;
  program: string;
}

export class MemtierClient {
  private readonly url: string;
  private readonly workspace: string;
  private readonly program: string;
  private readonly envToken: string;
  private readonly tokenFile: string;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly readFileImpl: ReadFileLike;
  /** Cache do token de arquivo: `undefined` = ainda não lido (lazy). */
  private fileToken: string | undefined;

  constructor(options: MemtierClientOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.workspace = options.workspace ?? "";
    this.program = options.program ?? "default";
    this.envToken = options.token ?? "";
    this.tokenFile = options.token_file ?? "";
    this.timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    this.healthTimeoutMs = options.health_timeout_ms ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
    this.readFileImpl =
      options.readFile ?? ((p) => readFileSync(p, "utf-8") as string);
  }

  /** Identidade lógica do cliente (`{ workspace, program }`) para os bodies. */
  resolveIdentity(): Identity {
    return { workspace: this.workspace, program: this.program };
  }

  /**
   * Token efetivo: env > `token_file` > ausente. O arquivo é lido **uma vez**
   * (lazy) e cacheado; ausente/corrompido ⇒ `""` (a borda decide 401). O valor
   * nunca é logado.
   */
  private token(): string {
    if (this.envToken) return this.envToken;
    if (this.fileToken !== undefined) return this.fileToken;
    this.fileToken = this.readTokenFile();
    return this.fileToken;
  }

  private readTokenFile(): string {
    if (!this.tokenFile) return "";
    try {
      const parsed = JSON.parse(this.readFileImpl(this.tokenFile)) as {
        token?: unknown;
      };
      return typeof parsed.token === "string" ? parsed.token : "";
    } catch {
      // Ausente/corrompido não é fatal: segue sem header, a borda responde 401.
      return "";
    }
  }

  /** Headers comuns; `Authorization` só quando há token. Nunca loga o token. */
  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    const token = this.token();
    if (token) h["Authorization"] = `Bearer ${token}`;
    return h;
  }

  /** Fetch com timeout combinado (chamada + `AbortSignal.timeout`). */
  private async doFetch(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return this.fetchImpl(`${this.url}${path}`, { ...init, signal: combined });
  }

  /**
   * Request JSON genérico (caminho de dados). Lança erro tipado em HTTP não-2xx
   * (`AuthError` 401/403, `InfraError` 503) — o chamador decide degradar.
   */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.doFetch(
      path,
      {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      this.timeoutMs,
      signal,
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "unknown error");
      throw httpError(res.status, detail);
    }
    return (await res.json()) as T;
  }

  /**
   * `GET /v1/health`. Sempre resolve num `HealthReport`; nunca lança no caminho
   * de degradação (NFR-03). `200` com `status:"ok"` ⇒ `ok:true`; `503` com
   * `status:"degraded"` ⇒ `ok:false`; erro de rede/timeout ⇒ `ok:false, reason`.
   */
  async health(signal?: AbortSignal): Promise<HealthReport> {
    let res: Response;
    try {
      res = await this.doFetch(
        "/v1/health",
        { method: "GET", headers: this.headers() },
        this.healthTimeoutMs,
        signal,
      );
    } catch (err) {
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

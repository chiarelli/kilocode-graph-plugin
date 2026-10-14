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

import type { CodeEdge, CodeFile, HealthReport, SyncResult } from "./types.ts";

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
  /** Timeout do recall (ms) — default 4000 (orçamento do hook). */
  recall_timeout_ms?: number;
  /** `fetch` injetável (default `globalThis.fetch`). */
  fetch?: FetchLike;
  /** Leitor de arquivo injetável (default `readFileSync` utf-8). */
  readFile?: ReadFileLike;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_HEALTH_TIMEOUT_MS = 2000;
const DEFAULT_RECALL_TIMEOUT_MS = 4000;

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

/**
 * Um fato de memória do recall (E2-S1). Espelha o contrato do memtier
 * (`memory.py:_serialize_fact`): `fact` é a frase atômica, `valid_at`/
 * `invalid_at` são ISO-8601 (ou `null`) e `score` é a relevância. `source` é
 * `"memory"`; `uuid`/`episodes` existem no fio mas a E2 não os consome.
 */
export interface Fact {
  fact: string;
  valid_at: string | null;
  invalid_at: string | null;
  score: number;
  source?: string;
}

/** Opções do recall (E2-S1). `maxTokens` liga o orçamento A1 no servidor. */
export interface RecallOpts {
  limit?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Resultado do recall — `tokensEstimated`/`truncated` só com `maxTokens`. */
export interface RecallResult {
  facts: Fact[];
  tokensEstimated?: number;
  truncated?: boolean;
}

/** Corpo de `POST /v1/recall` (aditivo E11: `program`). */
interface RecallBody {
  workspace: string;
  program: string;
  query: string;
  limit?: number;
  max_tokens?: number;
}

/** Resposta crua de `POST /v1/recall` (snake_case do memtier). */
interface RecallResponse {
  facts?: Fact[];
  tokens_estimated?: number;
  truncated?: boolean;
}

export class MemtierClient {
  private readonly url: string;
  private readonly workspace: string;
  private readonly program: string;
  private readonly envToken: string;
  private readonly tokenFile: string;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly recallTimeoutMs: number;
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
    this.recallTimeoutMs = options.recall_timeout_ms ?? DEFAULT_RECALL_TIMEOUT_MS;
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
    return this.sendJson<T>(method, path, body, this.timeoutMs, signal);
  }

  /**
   * Envia um request JSON com timeout explícito e devolve o body tipado;
   * HTTP não-2xx vira erro tipado (nunca passa cru).
   */
  private async sendJson<T>(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.doFetch(
      path,
      {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      timeoutMs,
      signal,
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "unknown error");
      throw httpError(res.status, detail);
    }
    return (await res.json()) as T;
  }

  /**
   * `POST /v1/recall` (E2-S1). `query` é o texto do usuário — sem teto de
   * tamanho no cliente (o servidor trunca; o hook nunca deve falhar por
   * tamanho). Envia `program` (aditivo E11) e, quando houver, `limit`/`max_tokens`.
   * Lança erro tipado no HTTP não-2xx — quem chama (o hook) degrada.
   */
  async recall(query: string, opts: RecallOpts = {}): Promise<RecallResult> {
    const identity = this.resolveIdentity();
    const body: RecallBody = {
      workspace: identity.workspace,
      program: identity.program,
      query,
    };
    if (opts.limit !== undefined) body.limit = opts.limit;
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

    const res = await this.sendJson<RecallResponse>(
      "POST",
      "/v1/recall",
      body,
      this.recallTimeoutMs,
      opts.signal,
    );

    const facts = Array.isArray(res.facts) ? res.facts : [];
    const result: RecallResult = { facts };
    if (typeof res.tokens_estimated === "number") {
      result.tokensEstimated = res.tokens_estimated;
    }
    if (typeof res.truncated === "boolean") result.truncated = res.truncated;
    return result;
  }

  /**
   * `POST /v1/code/sync` (E3a-S1). Envia o estado completo dos arquivos + as
   * arestas resolvidas e devolve a resposta 202. Body aditivo E11/E12
   * (`program`/`edges`). Sem paginação nesta fatia (1 request; S4 pagina).
   * Lança erro tipado no HTTP não-2xx — quem chama (o coletor) degrada.
   */
  async syncCode(
    files: CodeFile[],
    edges: CodeEdge[] = [],
    signal?: AbortSignal,
  ): Promise<SyncResult> {
    const identity = this.resolveIdentity();
    const body = {
      workspace: identity.workspace,
      program: identity.program,
      files,
      edges,
    };
    const res = await this.sendJson<SyncResult>(
      "POST",
      "/v1/code/sync",
      body,
      this.timeoutMs,
      signal,
    );
    return {
      workspace: res.workspace,
      upserted: res.upserted ?? 0,
      deleted: res.deleted ?? 0,
      changed: res.changed ?? 0,
      skipped: res.skipped ?? 0,
      edges_upserted: res.edges_upserted,
      edges_deleted: res.edges_deleted,
      results: res.results,
    };
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

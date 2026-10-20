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

import { debug } from "./logger.ts";
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
  /** Timeout da busca de código (ms) — default 4000 (orçamento do hook). */
  search_timeout_ms?: number;
  /** Timeout do sync de código (ms) — default 120000 (embedding é lento). */
  sync_timeout_ms?: number;
  /** Timeout do `/v1/ingest` (ms) — default 15000 (responde 202 imediato). */
  ingest_timeout_ms?: number;
  /** `fetch` injetável (default `globalThis.fetch`). */
  fetch?: FetchLike;
  /** Leitor de arquivo injetável (default `readFileSync` utf-8). */
  readFile?: ReadFileLike;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_HEALTH_TIMEOUT_MS = 2000;
const DEFAULT_RECALL_TIMEOUT_MS = 4000;
const DEFAULT_SEARCH_TIMEOUT_MS = 4000;
const DEFAULT_SYNC_TIMEOUT_MS = 120000;
const DEFAULT_INGEST_TIMEOUT_MS = 15000;

/** Limites do `POST /v1/code/sync` (memtier `code.py`, NFR-09). */
const MAX_FILES_PER_REQUEST = 100;
const MAX_EDGES_PER_REQUEST = 5000;

/** Limite de `limit` em `POST /v1/code/search` (memtier `code.py:131`). */
const MAX_SEARCH_LIMIT = 50;

/**
 * Limite de `query` em `POST /v1/code/search` (memtier `code.py:133`,
 * `MAX_QUERY_LENGTH`). Acima disso o servidor responde **422**
 * (`string_too_long`), não trunca — ao contrário do `recall`, que trunca em
 * `memory.recall` (D2). O cliente espelha o clamp de `limit`: trunca aqui para
 * que um turno com texto longo não perca a injeção inteira.
 */
const MAX_QUERY_LENGTH = 512;

/** Fração do orçamento reservada à CABEÇA do texto (o resto vai para a cauda). */
const QUERY_HEAD_RATIO = 0.25;

/**
 * Corta `text` em `cap` chars preservando os DOIS extremos, com âncora na
 * pergunta. Substitui o `slice(0, cap)` puro, que descartava a pergunta: no
 * corpus real ela está no último terço em 65% das mensagens longas (mediana
 * 0,84 da posição relativa) e, mesmo com pergunta, o `head` a mantinha em só
 * 8,1% dos casos.
 *
 * Regra (25/75): `floor(cap*0.25)` chars da cabeça + o restante da cauda.
 *
 * - Sem `?`, é o split 25/75 puro (contexto/tema + desfecho).
 * - Com `?` **depois** da cabeça, a cauda termina na pergunta: o texto que veio
 *   depois dela (tipicamente o `<system-reminder>` do host) é o menos
 *   informativo e fica de fora. Isso preserva a pergunta sem gastar orçamento
 *   com ruído que o próprio host anexa.
 * - Com `?` **dentro** da cabeça, a janela é a 25/75 normal (a pergunta já
 *   entrou; a cauda vale mais como contexto do que como eco da pergunta).
 *
 * Nunca devolve mais que `cap` chars e nunca gera vazio a partir de texto não
 * vazio. Texto que já cabe é devolvido INTACTO (sem normalização).
 */
export function clampQuery(text: string, cap: number = MAX_QUERY_LENGTH): string {
  if (text.length <= cap) return text;
  const headBudget = Math.floor(cap * QUERY_HEAD_RATIO);
  const tailBudget = cap - headBudget - 1; // -1 do separador
  const head = text.slice(0, headBudget);

  const lastQuestion = text.lastIndexOf("?");
  const tailStart = Math.max(headBudget, text.length - tailBudget);
  const anchored = lastQuestion >= headBudget && lastQuestion < tailStart;
  const tail = anchored
    ? text.slice(Math.max(headBudget, lastQuestion + 1 - tailBudget), lastQuestion + 1)
    : text.slice(tailStart);

  return `${head} ${tail}`;
}

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

/** Limite do detalhe de erro HTTP preservado na `message` (bytes de texto). */
const MAX_HTTP_DETAIL_CHARS = 2_048;

/** Marca de corte; mantida **dentro** do teto (o resultado nunca excede). */
const TRUNC_MARK = "… [truncated]";

/** Recorta `text` ao teto, anexando a marca de corte sem estourar o limite. */
function clipWithMark(text: string): string {
  if (text.length <= MAX_HTTP_DETAIL_CHARS) return text;
  const keep = Math.max(0, MAX_HTTP_DETAIL_CHARS - TRUNC_MARK.length);
  return `${text.slice(0, keep)}${TRUNC_MARK}`;
}

/**
 * Extrai um detalhe CURTO e útil de um body de erro HTTP. O memtier responde
 * 422 como `{"detail":[{"msg":"...","input":{...body inteiro...}}]}`; anexar o
 * body cru produziria uma `message` de vários MB (e travava a UI ao logar).
 * Prefere `detail[].msg` (a frase útil); senão, recorta o texto cru ao limite.
 * O resultado **nunca** excede `MAX_HTTP_DETAIL_CHARS`.
 */
export function extractHttpDetail(raw: string): string {
  const text = typeof raw === "string" ? raw : String(raw);
  if (text.length <= MAX_HTTP_DETAIL_CHARS) return text;
  try {
    const parsed = JSON.parse(text) as unknown;
    const detail = (parsed as { detail?: unknown } | null)?.detail;
    if (Array.isArray(detail)) {
      const msgs = detail
        .map((d) => (d as { msg?: unknown } | null)?.msg)
        .filter((m): m is string => typeof m === "string" && m.trim() !== "");
      // Junta as msgs úteis; se elas mesmas estourarem o teto, marca o corte
      // (o operador precisa saber que a lista foi cortada, não só a raw).
      if (msgs.length > 0) return clipWithMark(msgs.join("; "));
    }
    const message = (parsed as { message?: unknown } | null)?.message;
    if (typeof message === "string" && message.trim() !== "") {
      return clipWithMark(message);
    }
  } catch {
    // Body não-JSON: cai no recorte do texto cru abaixo.
  }
  return clipWithMark(text);
}

/**
 * Mapeia um status HTTP não-2xx num erro tipado reconhecível. O `detail` é
 * **sempre** passado por `extractHttpDetail` (defesa em profundidade): nenhum
 * call site pode fabricar um `message` de vários MB — foi o que travou a UI
 * quando um 422 ecoava o body inteiro. `extractHttpDetail` é idempotente para
 * um detalhe já curto (retorna como está).
 */
export function httpError(status: number, detail: string): MemtierHttpError {
  const msg = `memtier HTTP ${status}: ${extractHttpDetail(detail)}`;
  if (status === 401 || status === 403) return new AuthError(status, msg);
  if (status === 503) return new InfraError(status, msg);
  return new MemtierHttpError(status, msg);
}

/**
 * Fatia uma lista de arestas em lotes de ≤`size`. Lista vazia ⇒ `[[]]` (o lote
 * de arquivos ainda precisa ser enviado, mesmo sem arestas).
 */
export function chunkEdges<T>(edges: T[], size: number): T[][] {
  if (edges.length === 0) return [[]];
  const out: T[][] = [];
  for (let i = 0; i < edges.length; i += size) out.push(edges.slice(i, i + size));
  return out;
}

/** Deriva `ok` do status textual do servidor. */function reportFromBody(status: string, body: Partial<HealthReport>): HealthReport {
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

/**
 * Um chunk de código devolvido por `POST /v1/code/search` (E3c). Espelha o
 * contrato do memtier (`main.py:execute_code_search`): `path`/`symbol` identificam
 * o trecho, `start_line`/`end_line` dão a procedência, `code` é o texto,
 * `score`/`match` a relevância (`match ∈ vector|fulltext|hybrid`). Não há
 * `chunk_md5` — a identidade do chunk no cliente é `path:start-end` (spec §6).
 */
export interface CodeChunkHit {
  path: string;
  symbol: string | null;
  start_line: number;
  end_line: number;
  code: string;
  /** Ordem (RRF normalizado pelo top-1): sempre `[0,1]`, top-1 = 1.0. */
  score: number;
  /**
   * Magnitude (`max(cosine, bm25/bm25_top)`) — é sobre ela que o `min_score`
   * do servidor age. No componente fulltext é relativa ao topo da MESMA
   * query (não comparável entre queries). Opcional: servidor antigo não manda.
   */
  raw_score?: number;
  match: string;
}

/**
 * Opções da busca de código (E3c). `maxTokens` liga o orçamento A1 no servidor.
 * `labels` restringe os labels do Cypher (D5); `minScore` liga o piso de
 * relevância do servidor (D6/D7) — nunca re-filtrado no cliente.
 */
export interface SearchCodeOpts {
  limit?: number;
  maxTokens?: number;
  labels?: string[];
  minScore?: number;
  signal?: AbortSignal;
}

/** Resultado da busca — `tokensEstimated`/`truncated` só com `maxTokens`. */
export interface SearchCodeResult {
  chunks: CodeChunkHit[];
  tokensEstimated?: number;
  truncated?: boolean;
}

/**
 * Corpo de `POST /v1/code/search` (aditivo E11: `program`). `labels` só entra
 * com ≥1 item (lista vazia explícita é 422 no servidor) e `min_score` só
 * quando configurado.
 */
interface CodeSearchBody {
  workspace: string;
  program: string;
  query: string;
  limit?: number;
  max_tokens?: number;
  labels?: string[];
  min_score?: number;
}

/** Resposta crua de `POST /v1/code/search` (snake_case do memtier). */
interface CodeSearchResponse {
  chunks?: CodeChunkHit[];
  tokens_estimated?: number;
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

/**
 * Corpo de `POST /v1/ingest` (E4). `body` é o texto do episódio (1..64KB no
 * memtier); `reference_time` é a data da **mensagem mais atual do lote**
 * (ISO-8601), nunca a do envio.
 */
interface IngestBody {
  workspace: string;
  program: string;
  body: string;
  reference_time?: string;
}

/** Resposta de `POST /v1/ingest` (202 imediato — o worker processa à parte). */
export interface IngestResult {
  job_id?: string;
  workspace?: string;
  status?: string;
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
  private readonly searchTimeoutMs: number;
  private readonly syncTimeoutMs: number;
  private readonly ingestTimeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly readFileImpl: ReadFileLike;
  /** Cache do token de arquivo: `undefined` = ainda não lido (lazy). */
  private fileToken: string | undefined;

  constructor(options: MemtierClientOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.workspace = options.workspace ?? "";
    this.program = options.program ?? "default";
    // `trim()`: token só-espaços não pode vencer o `token_file` (defeito medido).
    this.envToken = (options.token ?? "").trim();
    this.tokenFile = options.token_file ?? "";
    this.timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    this.healthTimeoutMs = options.health_timeout_ms ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.recallTimeoutMs = options.recall_timeout_ms ?? DEFAULT_RECALL_TIMEOUT_MS;
    this.searchTimeoutMs = options.search_timeout_ms ?? DEFAULT_SEARCH_TIMEOUT_MS;
    this.syncTimeoutMs = options.sync_timeout_ms ?? DEFAULT_SYNC_TIMEOUT_MS;
    this.ingestTimeoutMs = options.ingest_timeout_ms ?? DEFAULT_INGEST_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
    this.readFileImpl =
      options.readFile ?? ((p) => readFileSync(p, "utf-8") as string);
  }

  /** Identidade lógica do cliente (`{ workspace, program }`) para os bodies. */
  resolveIdentity(): Identity {
    return { workspace: this.workspace, program: this.program };
  }

  /**
   * Token efetivo (env > `token_file` > `""`), para quem precisa do **valor**
   * fora daqui — o registro do MCP remoto (E3b) injeta o mesmo bearer no header
   * do servidor MCP. Nunca logar o retorno (ver `logger.formatToken`).
   */
  resolveToken(): string {
    return this.token();
  }

  /**
   * Token efetivo: env > `token_file` > ausente. O arquivo é lido **uma vez**
   * (lazy) e cacheado **apenas quando dá um token**; um resultado vazio NÃO é
   * cacheado — assim uma chave que aparece depois (provisionamento externo,
   * rotação, arquivo criado após o boot) é relida na próxima chamada, em vez de
   * fixar `""` até reiniciar (defeito medido: o `health()` do boot forçava a
   * primeira leitura vazia e todo recall/ingest seguia sem `Authorization`).
   * O valor nunca é logado.
   */
  private token(): string {
    if (this.envToken) return this.envToken;
    if (this.fileToken) return this.fileToken;
    const fresh = this.readTokenFile();
    if (fresh) this.fileToken = fresh;
    return fresh;
  }

  private readTokenFile(): string {
    if (!this.tokenFile) return "";
    try {
      const parsed = JSON.parse(this.readFileImpl(this.tokenFile)) as {
        token?: unknown;
      };
      return typeof parsed.token === "string" ? parsed.token.trim() : "";
    } catch {
      // Ausente/corrompido não é fatal: segue sem header, a borda responde 401.
      // (Não cacheado — o arquivo pode aparecer/consertar depois.)
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
    // Medido: `AbortSignal.timeout(0)` não nasce abortado, mas o timer de 0ms
    // dispara no PRÓXIMO tick — mata qualquer I/O real. Timeout ausente, `0` ou
    // negativo significa "sem teto" (o contrato dos defaults via
    // `?? DEFAULT_*`), não "aborta no primeiro tick". O guard fica aqui para
    // cobrir todas as rotas de uma vez, em vez de confiar que cada story mandou
    // um valor > 0.
    const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const sig = timeout
      ? signal
        ? AbortSignal.any([signal, timeout])
        : timeout
      : signal;
    return this.fetchImpl(`${this.url}${path}`, { ...init, signal: sig });
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
      throw httpError(res.status, extractHttpDetail(detail));
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
   * `POST /v1/code/search` (E3c-S1). Busca híbrida read-only do workspace.
   * `limit` é limitado a `MAX_SEARCH_LIMIT` (50) — o servidor devolve **422**
   * acima disso, então o cliente nunca manda. Quando houver `maxTokens`, envia
   * `max_tokens` (orçamento A1 no servidor).
   *
   * `labels` PASSOU a ser enviado (D5; antes era sempre omitido): só entra com
   * ao menos um item útil — `labels: []` explícito é **422** no servidor e
   * itens vazios são descartados. Omitir pede o default do servidor.
   * `minScore` (D7) vira `min_score` só quando definido e em `[0,1]`; fora
   * disso é omitido em vez de falhar o turno com 422. O piso é aplicado no
   * SERVIDOR sobre `raw_score` — o cliente **não** re-filtra por score (D6).
   * `query` é CORTADA em `MAX_QUERY_LENGTH` (512) — mesmo limite do body do
   * servidor: acima disso ele responde 422 e o turno perde a injeção. O corte
   * é `clampQuery` (25% cabeça + 75% cauda, ancorado no último `?`), não um
   * prefixo: preservar os dois extremos mantém o tema E a pergunta. O
   * truncamento por comprimento é do mesmo contrato do `recall` (D2), só que
   * aqui é o cliente que o aplica (a rota de código NÃO trunca no servidor).
   * Lança erro tipado no HTTP não-2xx — quem chama (o hook) degrada.
   */
  async searchCode(
    query: string,
    opts: SearchCodeOpts = {},
  ): Promise<SearchCodeResult> {
    const identity = this.resolveIdentity();
    const body: CodeSearchBody = {
      workspace: identity.workspace,
      program: identity.program,
      // Truncar é o que impede o 422 de `string_too_long` derrubar o turno
      // inteiro (o hook degrada, mas sem código). Comprimento, não bytes.
      // `clampQuery` mantém a pergunta (âncora no último `?`) — o `slice(0,
      // cap)` antigo a descartava em 65% das mensagens longas.
      query: clampQuery(query, MAX_QUERY_LENGTH),
    };
    if (opts.limit !== undefined) {
      body.limit = Math.min(opts.limit, MAX_SEARCH_LIMIT);
    }
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    // D5: `labels` AGORA é enviado (antes era sempre omitido). Só com ≥1 item
    // ÚTIL: `labels: []` e itens vazios são 422 no servidor, e o caminho da
    // busca não pode falhar por um array malformado vindo de config.
    if (opts.labels !== undefined) {
      const labels = opts.labels.filter((label) => label.trim() !== "");
      if (labels.length > 0) body.labels = labels;
    }
    // D6/D7: o piso vai para o SERVIDOR (ele vê a escala crua); o cliente não
    // filtra por score em nenhum momento. Valor fora de [0,1] é OMITIDO em vez
    // de virar 422 no caminho do turno (o resolver de config já garante isso;
    // esta guarda protege chamadores diretos do client).
    if (
      opts.minScore !== undefined &&
      Number.isFinite(opts.minScore) &&
      opts.minScore >= 0 &&
      opts.minScore <= 1
    ) {
      body.min_score = opts.minScore;
    }

    const res = await this.sendJson<CodeSearchResponse>(
      "POST",
      "/v1/code/search",
      body,
      this.searchTimeoutMs,
      opts.signal,
    );

    const chunks = Array.isArray(res.chunks) ? res.chunks : [];
    const result: SearchCodeResult = { chunks };
    if (typeof res.tokens_estimated === "number") {
      result.tokensEstimated = res.tokens_estimated;
    }
    if (typeof res.truncated === "boolean") result.truncated = res.truncated;
    return result;
  }

  /**
   * `POST /v1/ingest` (E4-S1). Enfileira um episódio de memória (202 imediato;
   * o worker roda o `add_episode` à parte, NFR-03). `referenceTime` é a data da
   * mensagem mais atual do lote (ISO-8601). Lança erro tipado no HTTP não-2xx —
   * quem chama (a rotina) degrada e NÃO avança o cursor.
   */
  async ingest(
    body: string,
    referenceTime?: string,
    signal?: AbortSignal,
  ): Promise<IngestResult> {
    const identity = this.resolveIdentity();
    const reqBody: IngestBody = {
      workspace: identity.workspace,
      program: identity.program,
      body,
    };
    if (referenceTime) reqBody.reference_time = referenceTime;
    return this.sendJson<IngestResult>(
      "POST",
      "/v1/ingest",
      reqBody,
      this.ingestTimeoutMs,
      signal,
    );
  }

  /**
   * `POST /v1/code/sync` (E3a-S1; paginação/fallback na S4). Fatia `files` em
   * lotes de ≤`MAX_FILES_PER_REQUEST` (100) e agrega os `SyncResult`. As arestas
   * são agrupadas por arquivo de ORIGEM e enviadas **no lote que contém a
   * origem** (o servidor exige a origem no payload quando a aresta é de nível de
   * arquivo — ADR-012 D3). Se um lote der 422, reenvia **sem as arestas**
   * (fallback: a dependência é menos crítica que os chunks) e loga.
   */
  async syncCode(
    files: CodeFile[],
    edges: CodeEdge[] = [],
    signal?: AbortSignal,
  ): Promise<SyncResult> {
    if (files.length <= MAX_FILES_PER_REQUEST) {
      return this.sendSyncCode(files, edges, signal);
    }
    const aggregated: SyncResult = {
      workspace: this.workspace,
      upserted: 0,
      deleted: 0,
      changed: 0,
      skipped: 0,
      edges_upserted: 0,
      edges_deleted: 0,
      results: [],
    };
    const edgesByOrigin = new Map<string, CodeEdge[]>();
    for (const e of edges) {
      const list = edgesByOrigin.get(e.from_file) ?? [];
      list.push(e);
      edgesByOrigin.set(e.from_file, list);
    }
    for (let i = 0; i < files.length; i += MAX_FILES_PER_REQUEST) {
      const batch = files.slice(i, i + MAX_FILES_PER_REQUEST);
      const batchEdges = batch.flatMap((f) => edgesByOrigin.get(f.file_path) ?? []);
      // BACKLOG pendência #2: 100 arquivos produzem >5.000 arestas facilmente
      // ⇒ 422 no lote inteiro. Fatia as arestas também: o mesmo lote de arquivos
      // é reenviado com cada fatia de ≤5.000 arestas (idempotente no servidor).
      const edgeGroups = chunkEdges(batchEdges, MAX_EDGES_PER_REQUEST);
      for (const group of edgeGroups) {
        const res = await this.sendSyncCode(batch, group, signal);
        aggregated.upserted += res.upserted;
        aggregated.deleted += res.deleted;
        aggregated.changed += res.changed;
        aggregated.skipped += res.skipped;
        aggregated.edges_upserted =
          (aggregated.edges_upserted ?? 0) + (res.edges_upserted ?? 0);
        aggregated.edges_deleted =
          (aggregated.edges_deleted ?? 0) + (res.edges_deleted ?? 0);
        if (res.results) {
          aggregated.results = [...(aggregated.results ?? []), ...res.results];
        }
      }
    }
    return aggregated;
  }

  /** Um request de sync (sem paginação). Rede + parse da resposta 202. */
  private async sendSyncCode(
    files: CodeFile[],
    edges: CodeEdge[],
    signal?: AbortSignal,
  ): Promise<SyncResult> {
    const identity = this.resolveIdentity();
    const body = {
      workspace: identity.workspace,
      program: identity.program,
      files,
      edges,
    };
    let res: SyncResult;
    try {
      res = await this.sendJson<SyncResult>(
        "POST",
        "/v1/code/sync",
        body,
        this.syncTimeoutMs,
        signal,
      );
    } catch (err) {
      // Fallback 422: a aresta órfã derruba o lote. Reenvia só os chunks (a
      // navegação degrada, o conteúdo não). Nunca se aplica sem arestas.
      if (!(err instanceof MemtierHttpError) || err.status !== 422 || edges.length === 0) {
        throw err;
      }
      debug(
        `collect: sync 422 com ${edges.length} arestas; reenviando sem arestas`,
      );
      res = await this.sendJson<SyncResult>(
        "POST",
        "/v1/code/sync",
        { ...body, edges: [] },
        this.syncTimeoutMs,
        signal,
      );
    }
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

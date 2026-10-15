/**
 * Tipos compartilhados da fundação (E1).
 *
 * `HealthReport` espelha o body de `GET /v1/health` do memtier
 * (`graphiti-daemon/src/memtier/graph.py` — `HealthReport.as_dict`) acrescido de
 * `reason` para o caminho de degradação por transporte (rede/timeout), onde o
 * servidor não chega a responder.
 */

/** Relatório de saúde do memtier — sempre retornado, ok ou degradado. */
export interface HealthReport {
  /** `status === "ok"`. Nunca lança: degradação é um valor, não uma exceção. */
  ok: boolean;
  /** `"ok"` | `"degraded"` (vindo do servidor, ou derivado do transporte). */
  status: string;
  falkordb: string;
  indices: string;
  error: string | null;
  /** Só no caminho de transporte (rede/timeout/abort): descrição do erro. */
  reason?: string;
}

/**
 * Chunk de código no body de `POST /v1/code/sync` (espelha `CodeChunkBody` do
 * memtier, E5-S1/S2). `symbol_id` é NOME puro do símbolo (`"main"`), nunca
 * qualificado com o arquivo — a identidade `{file}:{symbol}` é do servidor.
 * `Symbol` exige `symbol_id`; `FullFile`/`Contextual` o proíbem (ADR-002).
 */
export interface CodeChunk {
  chunk_id: string;
  chunk_kind: "Symbol" | "FullFile" | "Contextual";
  symbol_id: string | null;
  start_line: number;
  end_line: number;
  chunk_md5: string;
  text: string;
}

/** Arquivo (com seus chunks) no body de `POST /v1/code/sync` (`CodeFileBody`). */
export interface CodeFile {
  file_path: string;
  language: string;
  chunks: CodeChunk[];
}

/** Aresta de código no body (`CodeEdgeBody`, ADR-012). Alvo tem de existir. */
export interface CodeEdge {
  from_file: string;
  from_symbol_id?: string | null;
  to_file: string;
  to_symbol_id?: string | null;
  edge_kind: "import" | "call";
}

/** Resposta de `POST /v1/code/sync` (202; `changed`/`skipped` aditivos A2). */
export interface SyncResult {
  workspace?: string;
  upserted: number;
  deleted: number;
  changed: number;
  skipped: number;
  edges_upserted?: number;
  edges_deleted?: number;
  results?: Array<{
    file_path: string;
    upserted?: number;
    deleted?: number;
    changed?: number;
    skipped?: number;
  }>;
}

/**
 * Evento do protocolo JSONL do `rust-ast-indexer` (doc/protocol.md): cada linha
 * do stdout é um JSON independente. `payload` é `unknown` porque o formato varia
 * por evento; o `collector` valida campo a campo.
 */
export interface IndexerEvent {
  protocol_version?: string;
  type?: string;
  event?: string;
  job_id?: string;
  payload?: unknown;
}

/**
 * Contexto mínimo do plugin que a fundação consome. Estruturalmente compatível
 * com o `PluginInput` do SDK (que traz `client`, `directory`, `worktree`).
 */
export interface PluginCtx {
  client?: unknown;
  directory?: string | null;
  worktree?: string | null;
}

/** Configuração efetiva do plugin (env > arquivo > default; `options` acima). */
export interface Config {
  daemon: {
    url: string;
    token_file: string;
    /** Bearer resolvido de `KILOCODE_GRAPH_TOKEN` (env). Nunca logado. */
    token: string;
    /**
     * Bearer do **gestor** resolvido de `KILOCODE_GRAPH_MANAGER_TOKEN` (env).
     * Vazio ⇒ provisionamento do workspace desligado. Nunca logado.
     */
    manager_token: string;
    program: string;
    /**
     * Override do nome do workspace (vazio ⇒ derivado de `workspaceName(dir)` =
     * `<stem>-<sha1 8>`). Setado ⇒ identidade explícita, usada como veio — o
     * memtier escopa o bearer ao nome EXATO, então tokens pré-escopados (E2E,
     * migração) precisam pinar o nome. Não recebe o sufixo de hash.
     */
    workspace: string;
    health_timeout_ms: number;
  };
  inject: {
    enabled: boolean;
    max_memories: number;
    max_chars: number;
    max_tokens: number;
    timeout_ms: number;
    /** E3c — liga a injeção do bloco de código (default `false`). */
    code_enabled: boolean;
    /** E3c — nº máx. de chunks de código injetados (default 3). */
    max_code_chunks: number;
  };
  code_index: {
    enabled: boolean;
    indexer_bin: string;
    /** Timeout por request de sync (ms). Default 120000 (embedding é lento). */
    sync_timeout_ms: number;
  };
  ingest: {
    /** Liga a ingestão assíncrona (default `false`). */
    enabled: boolean;
    /** Tamanho do lote lido do banco (decisão do dono; default 20). */
    batch_size: number;
    /** Teto de hashes de lote por workspace (L-2; default 5000). */
    max_hashes: number;
    /** Timeout do `/v1/ingest` (ms; default 15000). */
    timeout_ms: number;
  };
  mcp: {
    enabled: boolean;
    name: string;
    /** Timeout de fetch de tools do MCP no Kilo (ms). Default 15000. */
    timeout_ms: number;
  };
  debug: boolean;
}

/**
 * Tipos compartilhados da fundação (E1).
 *
 * `HealthReport` espelha o body de `GET /v1/health` do memtier
 * (`graphiti-daemon/src/memtier/graph.py` — `HealthReport.as_dict`) acrescido de
 * `reason` para o caminho de degradação por transporte (rede/timeout), onde o
 * servidor não chega a responder.
 */

/**
 * Estratégias de chunking aceitas pelo `rust-ast-indexer`, em snake_case
 * (`doc/indexer_spec.md`). Fonte única: o tipo `ChunkingOptions["strategy"]`
 * deriva daqui e o validador de config (`config.ts`) usa `.includes` — adicionar
 * uma estratégia em um lugar só não pode fazer a outra ponta rejeitá-la em
 * silêncio.
 */
export const CHUNKING_STRATEGIES = [
  "symbol_boundary",
  "semantic",
  "line_limited",
] as const;

/**
 * Opções de chunking repassadas ao `rust-ast-indexer` (`options.chunking`).
 * Espelha `ChunkingOptions` do indexer (`doc/indexer_spec.md`); todos os campos
 * têm default no indexer, então um objeto PARCIAL é válido. `strategy` usa
 * snake_case (`symbol_boundary` | `semantic` | `line_limited`).
 */
export interface ChunkingOptions {
  strategy?: (typeof CHUNKING_STRATEGIES)[number];
  /** Máx. de linhas por chunk; `0` = sem limite (obrigatório p/ symbol_boundary). */
  max_lines?: number;
  /** Linhas de sobreposição entre chunks; `0` = sem overlap. */
  overlap_lines?: number;
  /** Injeta imports/escopo como prefixo do chunk. */
  include_context?: boolean;
  /** Conta tokens no metadata interno (requer feature `token_counting`). */
  token_counting?: boolean;
}

/**
 * Impressão ESTÁVEL da config de chunking (ordem fixa das chaves). Persistida no
 * manifest: mudá-la dispara um full de reindexação (o incremental não re-chunka
 * arquivos inalterados). `undefined` (chunking não configurado) ⇒ string vazia.
 * Pura e sem dependências — usável no manifest e no coletor.
 */
export function chunkingFingerprint(opts?: ChunkingOptions): string {
  if (!opts) return "";
  return JSON.stringify([
    opts.strategy ?? "",
    opts.max_lines ?? "",
    opts.overlap_lines ?? "",
    opts.include_context ?? "",
    opts.token_counting ?? "",
  ]);
}

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
    /**
     * Interpretador JS do CLI standalone (boot + hook). Vazio ⇒
     * `process.execPath`; num host Bun (extension host do Kilo) o helper
     * `resolveNodeRuntime` propaga `BUN_BE_BUN=1`. Setado ⇒ pinar um
     * `node`/`bun` explícito (CI/host sem Bun).
     */
    node_bin: string;
  };
  inject: {
    enabled: boolean;
    max_memories: number;
    /**
     * ADR-009 — teto de tokens do bloco de MEMÓRIA (unidade `chars/4`, a do
     * memtier). Vai no body de `POST /v1/recall` como `max_tokens`. Substitui o
     * teto de chars do cliente e o `max_tokens` compartilhado do ADR-004.
     */
    memory_max_tokens: number;
    /**
     * ADR-009 — teto de tokens do bloco de CÓDIGO. Vai no body de
     * `POST /v1/code/search` como `max_tokens`. Independente do de memória: cada
     * endpoint carrega o SEU teto.
     */
    code_max_tokens: number;
    timeout_ms: number;
    /** E3c — liga a injeção do bloco de código (default `false`). */
    code_enabled: boolean;
    /** E3c — nº máx. de chunks de código injetados (default 3). */
    max_code_chunks: number;
    /**
     * D5 — labels enviados na busca de código. Default `["CodeSymbol"]` (só o
     * plugin; o default do servidor continua `("CodeChunk",)`). Configurável
     * por env CSV/JSON; lista vazia/inválida ⇒ default (o servidor responde
     * 422 para `labels: []` explícito).
     */
    code_labels: string[];
    /**
     * D7 — piso de relevância do código (`min_score` no body). `undefined` =
     * desligado (o campo não é enviado). Só tem efeito com servidor que honra
     * o campo; com um servidor antigo o piso é IGNORADO em silêncio por ele
     * (pydantic extra) e a injeção registra a degradação uma vez por turno.
     * Default `undefined` — a calibração no corpus real fica para depois.
     *
     * Calibração: o servidor já corta a perna vetorial (`VEC_MIN_SCORE =
     * 0.65`), então um piso abaixo disso só afeta chunks fulltext-only.
     */
    code_min_score?: number;
  };
  code_index: {
    enabled: boolean;
    indexer_bin: string;
    /** Timeout por request de sync (ms). Default 120000 (embedding é lento). */
    sync_timeout_ms: number;
    /**
     * Fonte de arquivos via git (`git ls-files --exclude-standard`), honrando o
     * ignore-stack. Default `false` (varre tudo). Quando `true` e o git estiver
     * ausente ou o diretório não for um repositório, o indexer responde
     * `GIT_UNAVAILABLE` e aborta o job (sem degradar para um scan completo).
     */
    load_ignores: boolean;
    /**
     * Estratégia de chunking do `rust-ast-indexer` (`options.chunking`),
     * repassada crua. `undefined` ⇒ a chave não vai no payload e o indexer
     * aplica o default dele (`Semantic`, 200 linhas). Contrato do indexer
     * (`doc/indexer_spec.md`): `strategy ∈ {symbol_boundary, semantic,
     * line_limited}`; com `symbol_boundary`, use `max_lines: 0` e
     * `overlap_lines: 0` (senão o chunker descarta/mistura chunks).
     *
     * ATENÇÃO (version skew): o `strategy` snake_case e o `#[serde(default)]`
     * exigem um binário do indexer ATUALIZADO. Com um binário ANTIGO, o payload
     * snake_case falha no serde e o indexer cai em `Semantic` em SILÊNCIO (o
     * operador acha que `symbol_boundary` está ativo). Atualize `indexer_bin`
     * junto com o plugin.
     */
    chunking?: ChunkingOptions;
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

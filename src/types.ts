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
    program: string;
    health_timeout_ms: number;
  };
  inject: {
    enabled: boolean;
    max_memories: number;
    max_chars: number;
    max_tokens: number;
    timeout_ms: number;
  };
  code_index: {
    enabled: boolean;
    indexer_bin: string;
  };
  mcp: {
    enabled: boolean;
    name: string;
  };
  debug: boolean;
}

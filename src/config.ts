/**
 * Configuração do plugin (E1-S1, decisão 2).
 *
 * Precedência: `options` (do `kilo.jsonc`) > env var > arquivo JSON > default.
 * Idêntico ao `resolveOverride` do antecessor (`openviking-memory.js:93`).
 *
 * Nada hardcoded (FR-303): todo default vive em `DEFAULTS`. As chaves de E2/E3a/
 * E3b são **declaradas aqui com default** e lidas pela epic dona — declarar todas
 * evita churn de config entre epics (decisão do dono, 2026-10-14).
 *
 * Arquivo: `<workspace>/.kilo/graph-plugin.json` (por workspace) e
 * `~/.config/kilo/graph-plugin.json` (global). JSON fixado (o ecossistema Kilo
 * usa JSON no `.kilo/`); o ARCH §6 é ajustado para refletir isso na E1-S3.
 *
 * **Escopo por workspace.** O arquivo de config do workspace é lido do
 * diretório resolvido do workspace (`ctx.worktree` > `ctx.directory` > cwd), lido
 * no **runtime do Kilo** — NUNCA de `process.cwd()`, que num plugin instalado
 * globalmente aponta para o processo do Kilo, não para o projeto. `loadConfig`
 * recebe esse diretório como segundo argumento.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Config } from "./types.ts";

/** Defaults — a única fonte de verdade dos valores não configurados (FR-303). */
export const DEFAULTS = {
  daemon: {
    url: "http://127.0.0.1:8400",
    token_file: ".kilo/graph-key.json",
    program: "default",
    // Vazio ⇒ o nome do workspace é DERIVADO do diretório
    // (`workspaceName(dir)` = `<stem>-<sha1 8 do caminho>`). Setado ⇒ identidade
    // EXPLÍCITA, usada como veio (escapa do derivado). Necessário porque o
    // memtier escopa o bearer ao nome EXATO do workspace (medido: `alfa` vs
    // `alfa-1a2b3c4d` ⇒ 403), então quem tem token pré-escopado (E2E, migração)
    // precisa pinar o nome. NÃO recebe o sufixo de hash.
    workspace: "",
    health_timeout_ms: 2000,
    // Provisionamento: bearer do gestor. Vazio ⇒ provisionamento desligado
    // (a chave do workspace é pré-requisito manual, como antes).
    manager_token: "",
  },
  inject: {
    enabled: false,
    max_memories: 5,
    max_chars: 3000,
    max_tokens: 2000,
    timeout_ms: 4000,
    // E3c — injeção de código (segunda onda; declarada pela epic dona, pois o
    // E1 fechou antes da E3c ser especada — ver histórico do BACKLOG).
    code_enabled: false,
    max_code_chunks: 3,
  },
  code_index: {
    enabled: false,
    indexer_bin: "",
    sync_timeout_ms: 120000,
  },
  ingest: {
    // Defaults desligados (preferência do dono, coerente com index/inject).
    enabled: false,
    // Tamanho do lote (valor de config — decisão do dono). Medido: 20 é o
    // ponto de custo ótimo (~140× mais barato que batch=1, qualidade ~igual).
    batch_size: 20,
    // Teto de hashes por workspace (L-2): FIFO ao ultrapassar (aplicado S4).
    max_hashes: 5000,
    // Timeout do `/v1/ingest` (responde 202 imediato; folga p/ fila).
    timeout_ms: 15000,
  },
  mcp: {
    enabled: true,
    name: "memtier",
    timeout_ms: 15000,
  },
  debug: false,
} as const;

/** Overrides vindos do `kilo.jsonc` (`plugin: [[path, { ... }]]`). */
export type PluginOptions = Record<string, unknown>;

/**
 * Resolve um valor por precedência `options` > env > arquivo > default.
 * Suporta o placeholder `{env:VAR}` em `options` (como o antecessor).
 */
function resolveOverride(
  val: unknown,
  envValue: string | undefined,
  fileValue: string | undefined,
  fallback: string,
): string {
  if (val !== undefined && val !== null) {
    if (typeof val === "string") {
      const m = /^\{env:(.+)\}$/.exec(val);
      if (m) {
        const resolved = process.env[m[1] as string] ?? fileValue;
        return trimOr(resolved, fallback);
      }
    }
    return String(val).trim();
  }
  return trimOr(envValue ?? fileValue, fallback);
}

/**
 * `trim()` de um valor de string; vazio/só-espaços ⇒ `fallback`. Defeito medido:
 * um env var `" "` (artefato de cópia/quoting) era honrado como setado — ex.:
 * `KILOCODE_GRAPH_URL=" "` virava base vazia e toda chamada falhava, e
 * `KILOCODE_GRAPH_PROGRAM=" "` mandava um slug inválido. Vazio agora cai no
 * default, como se não estivesse setado.
 */
function trimOr(raw: string | undefined, fallback: string): string {
  if (raw === undefined) return fallback;
  const t = raw.trim();
  return t === "" ? fallback : t;
}

/** Lê o valor de `options` aninhado (ex.: `options.daemon.url`). */
function pick(options: PluginOptions | undefined, path: string): unknown {
  if (!options) return undefined;
  const parts = path.split(".");
  let cur: unknown = options;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Config `false`/`true` estrita; qualquer outro valor cai no default. */
function resolveBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

/** Inteiro estrito; valor inválido cai no default (nunca `NaN` silencioso). */
function resolveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) ? n : fallback;
}

/**
 * Inteiro estritamente **positivo**; `<= 0` (ou inválido) cai no default. Usado
 * onde `0`/negativo seria um modo degenerado silencioso — p.ex. `ingest.batch_size`
 * com `LIMIT 0`/`LIMIT -n` (que no SQLite significa "sem limite") travaria ou
 * varreria a tabela.
 */
function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  const n = resolveInt(raw, fallback);
  return n > 0 ? n : fallback;
}

function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "kilo");
  return join(homedir(), ".config", "kilo");
}

/** Objeto simples (não array/nulo) — candidato a merge recursivo. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Merge **profundo** (só um nível de recursão basta: a config é `{secao:{chave}}`).
 * Um objeto aninhado do arquivo do workspace complementa o do global em vez de
 * substituí-lo inteiro — sem isso, split de chaves entre os dois arquivos (ex.:
 * `daemon.url` no global, `daemon.program` no workspace) descartava uma delas.
 */
function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const prev = out[k];
    out[k] = isPlainObject(prev) && isPlainObject(v) ? deepMerge(prev, v) : v;
  }
  return out;
}

/**
 * Carrega `.kilo/graph-plugin.json` do workspace (resolvido no runtime do Kilo)
 * mesclado sobre o global `~/.config/kilo/graph-plugin.json`. O `dir` do
 * workspace é a fonte de escopo — nunca `process.cwd()` (plugin global). O merge
 * é **profundo** (ver `deepMerge`).
 */
function loadConfigFile(dir: string): Record<string, unknown> {
  const paths = [
    join(globalConfigDir(), "graph-plugin.json"),
    join(dir, ".kilo", "graph-plugin.json"),
  ];
  let result: Record<string, unknown> = {};
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
      if (isPlainObject(parsed)) result = deepMerge(result, parsed);
    } catch {
      // Arquivo de config corrompido não é fatal — defaults assumem.
    }
  }
  return result;
}

/** Lê um valor aninhado do arquivo de config (ex.: `inject.max_chars`). */
function filePick(
  file: Record<string, unknown>,
  path: string,
): string | undefined {
  const parts = path.split(".");
  let cur: unknown = file;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  if (cur === undefined || cur === null) return undefined;
  return typeof cur === "string" ? cur : JSON.stringify(cur);
}

/**
 * Monta a configuração efetiva. `options` vem do `kilo.jsonc`; env e arquivos
 * são lidos do ambiente/workspace. `dir` é o diretório do workspace resolvido
 * no runtime do Kilo (`resolveWorkspaceDir(ctx)`); default `process.cwd()` só
 * para chamadas legadas/teste — o boot de produção SEMPRE passa o `dir`.
 */
export function loadConfig(
  options?: PluginOptions,
  dir: string = process.cwd(),
): Config {
  const env = process.env;
  const file = loadConfigFile(dir);

  const resolve = (
    key: string,
    envName: string,
    fallback: string,
  ): string =>
    resolveOverride(pick(options, key), env[envName], filePick(file, key), fallback);

  return {
    daemon: {
      url: resolve("daemon.url", "KILOCODE_GRAPH_URL", DEFAULTS.daemon.url),
      token_file: resolve(
        "daemon.token_file",
        "KILOCODE_GRAPH_TOKEN_FILE",
        DEFAULTS.daemon.token_file,
      ),
      // `trim()`: um token só-espaços não pode vencer o `token_file` (defeito
      // medido — virava `Authorization: Bearer    ` e o arquivo nunca era lido).
      token: env.KILOCODE_GRAPH_TOKEN?.trim() ?? "",
      // Env-only, como `token`: o bearer do gestor é credencial viva, não config
      // de arquivo. Vazio ⇒ provisionamento desligado.
      manager_token: env.KILOCODE_GRAPH_MANAGER_TOKEN?.trim() ?? "",
      program: resolve(
        "daemon.program",
        "KILOCODE_GRAPH_PROGRAM",
        DEFAULTS.daemon.program,
      ),
      workspace: resolve(
        "daemon.workspace",
        "KILOCODE_GRAPH_WORKSPACE",
        DEFAULTS.daemon.workspace,
      ),
      health_timeout_ms: resolveInt(
        resolve(
          "daemon.health_timeout_ms",
          "KILOCODE_GRAPH_HEALTH_TIMEOUT_MS",
          String(DEFAULTS.daemon.health_timeout_ms),
        ),
        DEFAULTS.daemon.health_timeout_ms,
      ),
    },
    inject: {
      enabled: resolveBool(
        resolve(
          "inject.enabled",
          "KILOCODE_GRAPH_INJECT_ENABLED",
          String(DEFAULTS.inject.enabled),
        ),
        DEFAULTS.inject.enabled,
      ),
      max_memories: resolveInt(
        resolve(
          "inject.max_memories",
          "KILOCODE_GRAPH_INJECT_MAX_MEMORIES",
          String(DEFAULTS.inject.max_memories),
        ),
        DEFAULTS.inject.max_memories,
      ),
      max_chars: resolveInt(
        resolve(
          "inject.max_chars",
          "KILOCODE_GRAPH_INJECT_MAX_CHARS",
          String(DEFAULTS.inject.max_chars),
        ),
        DEFAULTS.inject.max_chars,
      ),
      max_tokens: resolveInt(
        resolve(
          "inject.max_tokens",
          "KILOCODE_GRAPH_INJECT_MAX_TOKENS",
          String(DEFAULTS.inject.max_tokens),
        ),
        DEFAULTS.inject.max_tokens,
      ),
      timeout_ms: resolveInt(
        resolve(
          "inject.timeout_ms",
          "KILOCODE_GRAPH_INJECT_TIMEOUT_MS",
          String(DEFAULTS.inject.timeout_ms),
        ),
        DEFAULTS.inject.timeout_ms,
      ),
      code_enabled: resolveBool(
        resolve(
          "inject.code_enabled",
          "KILOCODE_GRAPH_INJECT_CODE_ENABLED",
          String(DEFAULTS.inject.code_enabled),
        ),
        DEFAULTS.inject.code_enabled,
      ),
      max_code_chunks: resolveInt(
        resolve(
          "inject.max_code_chunks",
          "KILOCODE_GRAPH_INJECT_MAX_CODE_CHUNKS",
          String(DEFAULTS.inject.max_code_chunks),
        ),
        DEFAULTS.inject.max_code_chunks,
      ),
    },
    code_index: {
      enabled: resolveBool(
        resolve(
          "code_index.enabled",
          "KILOCODE_GRAPH_INDEX_ENABLED",
          String(DEFAULTS.code_index.enabled),
        ),
        DEFAULTS.code_index.enabled,
      ),
      indexer_bin: resolve(
        "code_index.indexer_bin",
        "KILOCODE_GRAPH_INDEXER_BIN",
        DEFAULTS.code_index.indexer_bin,
      ),
      sync_timeout_ms: resolveInt(
        resolve(
          "code_index.sync_timeout_ms",
          "KILOCODE_GRAPH_INDEX_SYNC_TIMEOUT_MS",
          String(DEFAULTS.code_index.sync_timeout_ms),
        ),
        DEFAULTS.code_index.sync_timeout_ms,
      ),
    },
    ingest: {
      enabled: resolveBool(
        resolve(
          "ingest.enabled",
          "KILOCODE_GRAPH_INGEST_ENABLED",
          String(DEFAULTS.ingest.enabled),
        ),
        DEFAULTS.ingest.enabled,
      ),
      batch_size: resolvePositiveInt(
        resolve(
          "ingest.batch_size",
          "KILOCODE_GRAPH_INGEST_BATCH_SIZE",
          String(DEFAULTS.ingest.batch_size),
        ),
        DEFAULTS.ingest.batch_size,
      ),
      max_hashes: resolveInt(
        resolve(
          "ingest.max_hashes",
          "KILOCODE_GRAPH_INGEST_MAX_HASHES",
          String(DEFAULTS.ingest.max_hashes),
        ),
        DEFAULTS.ingest.max_hashes,
      ),
      timeout_ms: resolveInt(
        resolve(
          "ingest.timeout_ms",
          "KILOCODE_GRAPH_INGEST_TIMEOUT_MS",
          String(DEFAULTS.ingest.timeout_ms),
        ),
        DEFAULTS.ingest.timeout_ms,
      ),
    },
    mcp: {
      enabled: resolveBool(
        resolve(
          "mcp.enabled",
          "KILOCODE_GRAPH_MCP_ENABLED",
          String(DEFAULTS.mcp.enabled),
        ),
        DEFAULTS.mcp.enabled,
      ),
      name: resolve("mcp.name", "KILOCODE_GRAPH_MCP_NAME", DEFAULTS.mcp.name),
      timeout_ms: resolveInt(
        resolve(
          "mcp.timeout_ms",
          "KILOCODE_GRAPH_MCP_TIMEOUT_MS",
          String(DEFAULTS.mcp.timeout_ms),
        ),
        DEFAULTS.mcp.timeout_ms,
      ),
    },
    debug: resolveBool(
      resolve("debug", "KILOCODE_GRAPH_DEBUG", String(DEFAULTS.debug)),
      DEFAULTS.debug,
    ),
  };
}

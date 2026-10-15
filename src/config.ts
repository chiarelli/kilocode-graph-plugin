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
 * Arquivo: `.kilo/graph-plugin.json` (por workspace) e
 * `~/.config/kilo/graph-plugin.json` (global). JSON fixado (o ecossistema Kilo
 * usa JSON no `.kilo/`); o ARCH §6 é ajustado para refletir isso na E1-S3.
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
    health_timeout_ms: 2000,
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
        return resolved !== undefined ? resolved : fallback;
      }
    }
    return String(val);
  }
  return envValue ?? fileValue ?? fallback;
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

function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "kilo");
  return join(homedir(), ".config", "kilo");
}

/** Carrega `.kilo/graph-plugin.json` (workspace) mesclado sobre o global. */
function loadConfigFile(): Record<string, unknown> {
  const paths = [
    join(globalConfigDir(), "graph-plugin.json"),
    join(process.cwd(), ".kilo", "graph-plugin.json"),
  ];
  let result: Record<string, unknown> = {};
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
      if (parsed && typeof parsed === "object") {
        result = { ...result, ...(parsed as Record<string, unknown>) };
      }
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
 * são lidos do ambiente/workspace. Puro o suficiente para teste (chamadores de
 * teste isolam o cwd/global — ver `tests/config.test.ts`).
 */
export function loadConfig(options?: PluginOptions): Config {
  const env = process.env;
  const file = loadConfigFile();

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
      token: env.KILOCODE_GRAPH_TOKEN ?? "",
      program: resolve(
        "daemon.program",
        "KILOCODE_GRAPH_PROGRAM",
        DEFAULTS.daemon.program,
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

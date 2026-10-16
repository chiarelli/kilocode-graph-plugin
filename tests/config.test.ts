/**
 * E1-S1 — `config.ts`: defaults e precedência `options` > env > default.
 * Puro: nenhum teste abre socket. Env é setada/restaurada por teste.
 *
 * Hermético ao cwd: um `.kilo/graph-plugin.json` de dev no workspace (gitignored)
 * mudaria o resultado de `loadConfig()`. Os testes rodam num diretório temporário
 * vazio, então o arquivo de config do cwd nunca é lido (o global segue o mesmo
 * padrão, também vazio).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";

import { DEFAULTS, loadConfig } from "../src/config.ts";
import { __setLogSink } from "../src/logger.ts";

const ENV_KEYS = [
  "KILOCODE_GRAPH_URL",
  "KILOCODE_GRAPH_PROGRAM",
  "KILOCODE_GRAPH_TOKEN",
  "KILOCODE_GRAPH_INJECT_ENABLED",
  "KILOCODE_GRAPH_INJECT_MEMORY_MAX_TOKENS",
  "KILOCODE_GRAPH_INJECT_CODE_MAX_TOKENS",
  "KILOCODE_GRAPH_INJECT_MAX_CHARS",
  "KILOCODE_GRAPH_INJECT_MAX_TOKENS",
  "KILOCODE_GRAPH_INDEX_SYNC_TIMEOUT_MS",
] as const;

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

const originalCwd = process.cwd();
let sandbox = "";

before(() => {
  // cwd temporário: sem `.kilo/graph-plugin.json` de dev para contaminar.
  sandbox = mkdtempSync(join(tmpdir(), "graph-config-test-"));
  process.chdir(sandbox);
});

after(() => {
  process.chdir(originalCwd);
  rmSync(sandbox, { recursive: true, force: true });
});

afterEach(clearEnv);

test("config_defaults: sem env/options usa DEFAULTS", () => {
  clearEnv();
  const cfg = loadConfig();
  assert.equal(cfg.daemon.url, "http://127.0.0.1:8400");
  assert.equal(cfg.daemon.program, "default");
  assert.equal(cfg.inject.timeout_ms, 4000);
  assert.equal(cfg.inject.enabled, false);
  assert.equal(cfg.code_index.enabled, false);
  assert.equal(cfg.debug, false);
  // Nenhum default hardcoded fora de DEFAULTS.
  assert.equal(cfg.daemon.url, DEFAULTS.daemon.url);
});

test("config_precedence: options > env > default", () => {
  clearEnv();
  process.env.KILOCODE_GRAPH_URL = "http://env:9000";
  process.env.KILOCODE_GRAPH_PROGRAM = "envprog";

  // env vence o default
  assert.equal(loadConfig().daemon.url, "http://env:9000");
  // options vence o env
  const cfg = loadConfig({
    daemon: { url: "http://options:1111", program: "optprog" },
  });
  assert.equal(cfg.daemon.url, "http://options:1111");
  assert.equal(cfg.daemon.program, "optprog");
});

test("config_invalid_bool: valor não-booleano cai no default", () => {
  clearEnv();
  process.env.KILOCODE_GRAPH_INJECT_ENABLED = "yes-please";
  assert.equal(loadConfig().inject.enabled, false);
});

test("config_memory_max_tokens_env: KILOCODE_GRAPH_INJECT_MEMORY_MAX_TOKENS é honrado", () => {
  clearEnv();
  process.env.KILOCODE_GRAPH_INJECT_MEMORY_MAX_TOKENS = "1500";
  assert.equal(loadConfig().inject.memory_max_tokens, 1500);
});

test("config_code_max_tokens_env: KILOCODE_GRAPH_INJECT_CODE_MAX_TOKENS é honrado", () => {
  clearEnv();
  process.env.KILOCODE_GRAPH_INJECT_CODE_MAX_TOKENS = "500";
  assert.equal(loadConfig().inject.code_max_tokens, 500);
});

test("config_tokens_defaults: sem env/arquivo ⇒ ambos os tetos são 2000", () => {
  clearEnv();
  const cfg = loadConfig();
  assert.equal(cfg.inject.memory_max_tokens, 2000);
  assert.equal(cfg.inject.code_max_tokens, 2000);
  assert.equal(cfg.inject.memory_max_tokens, DEFAULTS.inject.memory_max_tokens);
  assert.equal(cfg.inject.code_max_tokens, DEFAULTS.inject.code_max_tokens);
});

/** Coleta as linhas emitidas por `fn` via sink de log injetável (só teste). */
function captureLogs(fn: () => void): string[] {
  const lines: string[] = [];
  __setLogSink((l) => lines.push(l));
  try {
    fn();
  } finally {
    __setLogSink(null);
  }
  return lines;
}

test("config_legacy_max_chars_warns: env legada ⇒ 1 aviso; valor IGNORADO", () => {
  clearEnv();
  process.env.KILOCODE_GRAPH_INJECT_MAX_CHARS = "1234";
  let cfg!: ReturnType<typeof loadConfig>;
  const lines = captureLogs(() => {
    cfg = loadConfig();
  });
  // Exatamente um aviso de depreciação (nunca silêncio).
  assert.equal(lines.filter((l) => l.toLowerCase().includes("depreciada")).length, 1);
  assert.match(lines.join("\n"), /INJECT_MAX_CHARS/);
  assert.match(lines.join("\n"), /MEMORY_MAX_TOKENS/);
  // O valor legado NÃO é honrado: as chaves novas ficam no default.
  assert.equal(cfg.inject.memory_max_tokens, 2000);
  assert.equal(cfg.inject.code_max_tokens, 2000);
});

test("config_legacy_max_tokens_warns: env legada ⇒ 1 aviso; valor IGNORADO", () => {
  clearEnv();
  process.env.KILOCODE_GRAPH_INJECT_MAX_TOKENS = "999";
  let cfg!: ReturnType<typeof loadConfig>;
  const lines = captureLogs(() => {
    cfg = loadConfig();
  });
  assert.equal(lines.filter((l) => l.toLowerCase().includes("depreciada")).length, 1);
  assert.match(lines.join("\n"), /INJECT_MAX_TOKENS/);
  assert.equal(cfg.inject.memory_max_tokens, 2000);
  assert.equal(cfg.inject.code_max_tokens, 2000);
});

test("config_no_legacy_no_warning: sem envs legadas ⇒ nenhum aviso de depreciação", () => {
  clearEnv();
  const lines = captureLogs(() => {
    loadConfig();
  });
  assert.equal(lines.filter((l) => l.toLowerCase().includes("depreciada")).length, 0);
});

test("config_token_cap_clamped: <=0 ou >16000 (422 no servidor) cai no default", () => {
  clearEnv();
  // `<=0` é 422 (`ge=1`); `>16000` é 422 (`MAX_RESPONSE_TOKENS`). O cliente nunca
  // manda acima do teto interno (ADR-009, decisão 1) ⇒ fora de [1,16000] = default.
  for (const bad of ["0", "-5", "16001", "50000", "abc", "2.5"]) {
    process.env.KILOCODE_GRAPH_INJECT_MEMORY_MAX_TOKENS = bad;
    process.env.KILOCODE_GRAPH_INJECT_CODE_MAX_TOKENS = bad;
    const cfg = loadConfig();
    assert.equal(cfg.inject.memory_max_tokens, 2000, `memória: ${bad} ⇒ default`);
    assert.equal(cfg.inject.code_max_tokens, 2000, `código: ${bad} ⇒ default`);
  }
  // Os limites válidos das pontas passam intactos.
  process.env.KILOCODE_GRAPH_INJECT_MEMORY_MAX_TOKENS = "1";
  process.env.KILOCODE_GRAPH_INJECT_CODE_MAX_TOKENS = "16000";
  const cfg = loadConfig();
  assert.equal(cfg.inject.memory_max_tokens, 1);
  assert.equal(cfg.inject.code_max_tokens, 16000);
});

test("config_invalid_type: número inválido cai no default (nunca NaN)", () => {
  clearEnv();
  process.env.KILOCODE_GRAPH_INJECT_TIMEOUT_MS = "abc";
  const cfg = loadConfig();
  assert.equal(cfg.inject.timeout_ms, 4000);
  assert.ok(Number.isFinite(cfg.inject.timeout_ms));
});

test("config_int_via_options: inteiro de options é aceito", () => {
  clearEnv();
  const cfg = loadConfig({ inject: { max_memories: "7" } });
  assert.equal(cfg.inject.max_memories, 7);
});

test("config_code_sync_timeout: default 120000 e env honrada", () => {
  clearEnv();
  assert.equal(loadConfig().code_index.sync_timeout_ms, 120000);
  process.env.KILOCODE_GRAPH_INDEX_SYNC_TIMEOUT_MS = "5000";
  assert.equal(loadConfig().code_index.sync_timeout_ms, 5000);
});

test("config_code_load_ignores: default false e env honrada", () => {
  clearEnv();
  assert.equal(loadConfig().code_index.load_ignores, false);
  process.env.KILOCODE_GRAPH_INDEX_LOAD_IGNORES = "true";
  assert.equal(loadConfig().code_index.load_ignores, true);
  process.env.KILOCODE_GRAPH_INDEX_LOAD_IGNORES = "false";
  assert.equal(loadConfig().code_index.load_ignores, false);
});

test("config_ingest_defaults: as chaves de `ingest.*` (E4) têm os defaults declarados", () => {
  clearEnv();
  const cfg = loadConfig();
  assert.equal(cfg.ingest.enabled, false, "ingestão desligada por default (preferência do dono)");
  assert.equal(cfg.ingest.batch_size, 20);
  assert.equal(cfg.ingest.max_hashes, 5000);
  assert.equal(cfg.ingest.timeout_ms, 15000);
});

test("config_ingest_env: `KILOCODE_GRAPH_INGEST_*` são honradas end-to-end", () => {
  clearEnv();
  process.env.KILOCODE_GRAPH_INGEST_ENABLED = "true";
  process.env.KILOCODE_GRAPH_INGEST_BATCH_SIZE = "7";
  process.env.KILOCODE_GRAPH_INGEST_MAX_HASHES = "123";
  process.env.KILOCODE_GRAPH_INGEST_TIMEOUT_MS = "9000";
  const cfg = loadConfig();
  assert.equal(cfg.ingest.enabled, true);
  assert.equal(cfg.ingest.batch_size, 7);
  assert.equal(cfg.ingest.max_hashes, 123);
  assert.equal(cfg.ingest.timeout_ms, 9000);
});

test("config_ingest_batch_size_positive: 0/negativo/ inválido cai no default (não vira LIMIT 0/-n)", () => {
  clearEnv();
  for (const bad of ["0", "-5", "abc", "2.5"]) {
    process.env.KILOCODE_GRAPH_INGEST_BATCH_SIZE = bad;
    assert.equal(
      loadConfig().ingest.batch_size,
      20,
      `batch_size=${bad} deve cair no default (senão LIMIT 0/-n varre/para a leitura)`,
    );
  }
  // Um positivo válido passa.
  process.env.KILOCODE_GRAPH_INGEST_BATCH_SIZE = "1";
  assert.equal(loadConfig().ingest.batch_size, 1);
});

// ---------------------------------------------------------------------------
// Escopo por workspace: o config do workspace vem do `dir` RESOLVIDO, não do cwd
// ---------------------------------------------------------------------------

/** Cria `<dir>/.kilo/graph-plugin.json` com o conteúdo dado. */
function writeWorkspaceConfig(dir: string, content: unknown): void {
  mkdirSync(join(dir, ".kilo"), { recursive: true });
  writeFileSync(
    join(dir, ".kilo", "graph-plugin.json"),
    JSON.stringify(content),
  );
}

test("config_workspace_dir: o arquivo do WORKSPACE (`dir`) é lido, não o do cwd", () => {
  clearEnv();
  // `dir` com uma config; cwd (sandbox) com OUTRA — devem divergir.
  const dir = mkdtempSync(join(tmpdir(), "graph-ws-"));
  try {
    writeWorkspaceConfig(dir, { daemon: { program: "from-workspace" } });
    writeWorkspaceConfig(sandbox, { daemon: { program: "from-cwd" } });
    const cfg = loadConfig(undefined, dir);
    assert.equal(
      cfg.daemon.program,
      "from-workspace",
      "o `dir` vence o cwd (plugin global instalado não lê o cwd do processo)",
    );
    assert.notEqual(cfg.daemon.program, "from-cwd");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(sandbox, ".kilo"), { recursive: true, force: true });
  }
});

test("config_workspace_dir_ignores_cwd: config só no cwd NÃO é lida se o dir não a tem", () => {
  clearEnv();
  const dir = mkdtempSync(join(tmpdir(), "graph-ws-"));
  try {
    writeWorkspaceConfig(sandbox, { daemon: { program: "from-cwd" } });
    // `dir` vazio ⇒ cai no default, NUNCA no arquivo do cwd.
    assert.equal(loadConfig(undefined, dir).daemon.program, "default");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(sandbox, ".kilo"), { recursive: true, force: true });
  }
});

test("config_deep_merge: chaves aninhadas de global+workspace NÃO se anulam", () => {
  clearEnv();
  const dir = mkdtempSync(join(tmpdir(), "graph-ws-"));
  const xdg = mkdtempSync(join(tmpdir(), "graph-xdg-"));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  try {
    // Global define `daemon.url`; o workspace define só `daemon.program`. Com
    // merge raso, o `daemon` do workspace substituiria o inteiro e a `url` do
    // global se perderia (voltando ao default) — defeito medido.
    mkdirSync(join(xdg, "kilo"), { recursive: true });
    writeFileSync(
      join(xdg, "kilo", "graph-plugin.json"),
      JSON.stringify({ daemon: { url: "http://from-global:7777" } }),
    );
    process.env.XDG_CONFIG_HOME = xdg;
    writeWorkspaceConfig(dir, { daemon: { program: "from-workspace" } });
    const cfg = loadConfig(undefined, dir);
    assert.equal(cfg.daemon.program, "from-workspace");
    assert.equal(
      cfg.daemon.url,
      "http://from-global:7777",
      "a `url` do global sobrevive ao merge do `daemon` do workspace",
    );
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    rmSync(dir, { recursive: true, force: true });
    rmSync(xdg, { recursive: true, force: true });
  }
});

test("config_deep_merge_workspace_wins: chave nos dois arquivos ⇒ workspace vence", () => {
  clearEnv();
  const dir = mkdtempSync(join(tmpdir(), "graph-ws-"));
  const xdg = mkdtempSync(join(tmpdir(), "graph-xdg-"));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  try {
    mkdirSync(join(xdg, "kilo"), { recursive: true });
    writeFileSync(
      join(xdg, "kilo", "graph-plugin.json"),
      JSON.stringify({ daemon: { url: "http://global:1", program: "gp" } }),
    );
    process.env.XDG_CONFIG_HOME = xdg;
    writeWorkspaceConfig(dir, { daemon: { program: "wp" } });
    const cfg = loadConfig(undefined, dir);
    assert.equal(cfg.daemon.program, "wp", "workspace vence o global na mesma chave");
    assert.equal(cfg.daemon.url, "http://global:1", "chave só-global é preservada");
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    rmSync(dir, { recursive: true, force: true });
    rmSync(xdg, { recursive: true, force: true });
  }
});

test("config_env_trim: env só-espaços cai no default (não vira base vazia)", () => {
  clearEnv();
  process.env.KILOCODE_GRAPH_URL = "   ";
  process.env.KILOCODE_GRAPH_PROGRAM = "   ";
  const cfg = loadConfig();
  assert.equal(cfg.daemon.url, DEFAULTS.daemon.url);
  assert.equal(cfg.daemon.program, DEFAULTS.daemon.program);
});

test("config_env_trim_spaces: env com espaços em volta é trimada", () => {
  clearEnv();
  process.env.KILOCODE_GRAPH_URL = "  http://h:9000  ";
  assert.equal(loadConfig().daemon.url, "http://h:9000");
});

test("config_token_whitespace: token só-espaços vira vazio (não vence o arquivo)", () => {
  clearEnv();
  process.env.KILOCODE_GRAPH_TOKEN = "   ";
  assert.equal(loadConfig().daemon.token, "");
});

test("config_manager_token: default vazio e env honrada (env-only)", () => {
  clearEnv();
  assert.equal(loadConfig().daemon.manager_token, "");
  process.env.KILOCODE_GRAPH_MANAGER_TOKEN = "  mgr-tok  ";
  assert.equal(loadConfig().daemon.manager_token, "mgr-tok");
});

test("config_workspace_override: default vazio e env/options honradas", () => {
  clearEnv();
  // Vazio ⇒ o boot deriva de `workspaceName(dir)` (não pina identidade).
  assert.equal(loadConfig().daemon.workspace, "");
  process.env.KILOCODE_GRAPH_WORKSPACE = "alfa";
  assert.equal(loadConfig().daemon.workspace, "alfa");
  const cfg = loadConfig({ daemon: { workspace: "pinned-ws" } });
  assert.equal(cfg.daemon.workspace, "pinned-ws", "options vence o env");
});

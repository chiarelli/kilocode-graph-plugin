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

/**
 * Prefixo de TODA env do plugin. A limpeza é por PREFIXO, não por lista fixa:
 * com lista, qualquer chave nova (ou já setada no `.bashrc` do operador —
 * `MANAGER_TOKEN`, `DEBUG`, `INJECT_*`) vazava para os testes e fazia
 * `config_defaults`/`config_manager_token` falharem sem defeito de runtime.
 */
const ENV_PREFIX = "KILOCODE_GRAPH_";

function clearEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(ENV_PREFIX)) delete process.env[key];
  }
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

test("config_token_cap_clamped: >16000 CLAMPA em 16000 (com log); inválido cai no default", () => {
  clearEnv();
  // D8: `16384` é o valor do `.bashrc` do operador — antes caía no default 2000
  // EM SILÊNCIO. Agora clampa no teto interno, com log.
  process.env.KILOCODE_GRAPH_INJECT_CODE_MAX_TOKENS = "16384";
  let clamped = 0;
  const clampLines = captureLogs(() => {
    clamped = loadConfig().inject.code_max_tokens;
  });
  assert.equal(clamped, 16000);
  assert.equal(
    clampLines.filter((l) => l.includes("CLAMPADO")).length,
    1,
    clampLines.join("\n"),
  );

  // Abaixo de 1 / não-inteiro / não-numérico: default, também com log.
  for (const bad of ["0", "-5", "abc", "2.5"]) {
    process.env.KILOCODE_GRAPH_INJECT_MEMORY_MAX_TOKENS = bad;
    process.env.KILOCODE_GRAPH_INJECT_CODE_MAX_TOKENS = bad;
    let cfg!: ReturnType<typeof loadConfig>;
    const lines = captureLogs(() => {
      cfg = loadConfig();
    });
    assert.equal(cfg.inject.memory_max_tokens, 2000, `memória: ${bad} ⇒ default`);
    assert.equal(cfg.inject.code_max_tokens, 2000, `código: ${bad} ⇒ default`);
    assert.ok(
      lines.filter((l) => l.includes("inválido")).length >= 1,
      `sem log do valor inválido ${bad}: ${lines}`,
    );
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

test("config_code_chunking: default = symbol_boundary com max_lines 0", () => {
  clearEnv();
  const chunking = loadConfig().code_index.chunking;
  assert.equal(chunking?.strategy, "symbol_boundary");
  assert.equal(chunking?.max_lines, 0);
  assert.equal(chunking?.overlap_lines, 0);
  assert.equal(chunking?.include_context, true);
  assert.equal(chunking?.token_counting, false);
});

test("config_code_chunking: options (objeto) tem precedência", () => {
  clearEnv();
  const cfg = loadConfig({
    code_index: { chunking: { strategy: "semantic", max_lines: 120 } },
  });
  assert.equal(cfg.code_index.chunking?.strategy, "semantic");
  assert.equal(cfg.code_index.chunking?.max_lines, 120);
});

test("config_code_chunking: env (string JSON) é honrada", () => {
  clearEnv();
  process.env.KILOCODE_GRAPH_INDEX_CHUNKING =
    '{"strategy":"line_limited","max_lines":40}';
  const chunking = loadConfig().code_index.chunking;
  assert.equal(chunking?.strategy, "line_limited");
  assert.equal(chunking?.max_lines, 40);
});

test("config_code_chunking: valor inválido cai no default (não vira INVALID_PAYLOAD)", () => {
  clearEnv();
  // strategy desconhecida no objeto.
  assert.equal(
    loadConfig({ code_index: { chunking: { strategy: "bogus" } as never } }).code_index
      .chunking?.strategy,
    "symbol_boundary",
  );
  // env não-JSON.
  process.env.KILOCODE_GRAPH_INDEX_CHUNKING = "not json";
  assert.equal(loadConfig().code_index.chunking?.strategy, "symbol_boundary");
});

test("config_code_chunking_symbol_boundary_forces_max_lines_0: fecha o footgun do drop", () => {
  clearEnv();
  // Um objeto parcial/errado (symbol_boundary com max_lines>0 ou ausente) é
  // normalizado para max_lines:0 — sem isso o indexer (versão antiga) descarta
  // símbolos grandes e o coletor apaga os chunks do arquivo no full.
  const withLines = loadConfig({
    code_index: { chunking: { strategy: "symbol_boundary", max_lines: 50 } },
  });
  assert.equal(withLines.code_index.chunking?.max_lines, 0);

  const partial = loadConfig({
    code_index: { chunking: { strategy: "symbol_boundary" } },
  });
  assert.equal(partial.code_index.chunking?.max_lines, 0);

  // Outras estratégias NÃO são forçadas.
  const semantic = loadConfig({
    code_index: { chunking: { strategy: "semantic", max_lines: 50 } },
  });
  assert.equal(semantic.code_index.chunking?.max_lines, 50);
});

test("config_code_chunking: env com symbol_boundary também é normalizada", () => {
  clearEnv();
  process.env.KILOCODE_GRAPH_INDEX_CHUNKING =
    '{"strategy":"symbol_boundary","max_lines":10}';
  assert.equal(loadConfig().code_index.chunking?.max_lines, 0);
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

test("config_code_labels: default, CSV, JSON e inválidos", () => {
  clearEnv();
  assert.deepEqual(loadConfig().inject.code_labels, ["CodeSymbol"]);
  assert.deepEqual(loadConfig().inject.code_labels, DEFAULTS.inject.code_labels);

  process.env.KILOCODE_GRAPH_INJECT_CODE_LABELS = "CodeSymbol,CodeChunk";
  assert.deepEqual(loadConfig().inject.code_labels, ["CodeSymbol", "CodeChunk"]);

  process.env.KILOCODE_GRAPH_INJECT_CODE_LABELS = '["CodeChunk"]';
  assert.deepEqual(loadConfig().inject.code_labels, ["CodeChunk"]);

  // Lista vazia / JSON inválido / item não-string ⇒ default (nunca `[]`, que o
  // servidor recusa com 422).
  for (const bad of ["", "[]", "[", "[1]", "CodeSymbol,,CodeChunk"]) {
    process.env.KILOCODE_GRAPH_INJECT_CODE_LABELS = bad;
    assert.deepEqual(
      loadConfig().inject.code_labels,
      ["CodeSymbol"],
      `labels inválidas: ${bad}`,
    );
  }
});

test("config_code_min_score: default desligado, env e inválidos", () => {
  clearEnv();
  // D7: desligado por default ⇒ o campo NÃO vai no body.
  assert.equal(loadConfig().inject.code_min_score, undefined);
  assert.equal(loadConfig().inject.code_min_score, DEFAULTS.inject.code_min_score);

  process.env.KILOCODE_GRAPH_INJECT_CODE_MIN_SCORE = "0.65";
  assert.equal(loadConfig().inject.code_min_score, 0.65);

  for (const bad of ["1.5", "-0.1", "abc", ""]) {
    process.env.KILOCODE_GRAPH_INJECT_CODE_MIN_SCORE = bad;
    assert.equal(
      loadConfig().inject.code_min_score,
      undefined,
      `min_score inválido: ${bad}`,
    );
  }
  // Pontas válidas.
  process.env.KILOCODE_GRAPH_INJECT_CODE_MIN_SCORE = "0";
  assert.equal(loadConfig().inject.code_min_score, 0);
  process.env.KILOCODE_GRAPH_INJECT_CODE_MIN_SCORE = "1";
  assert.equal(loadConfig().inject.code_min_score, 1);
});

test("config_code_labels_returns_copy: mutar o resultado não corrompe DEFAULTS", () => {
  clearEnv();
  const cfg = loadConfig();
  cfg.inject.code_labels.push("Intruso");
  assert.deepEqual(DEFAULTS.inject.code_labels, ["CodeSymbol"]);
  assert.deepEqual(loadConfig().inject.code_labels, ["CodeSymbol"]);
});

test("config_token_cap_empty_string: vazio = não configurado, sem ruído de log", () => {
  clearEnv();
  process.env.KILOCODE_GRAPH_INJECT_CODE_MAX_TOKENS = "";
  let cfg!: ReturnType<typeof loadConfig>;
  const lines = captureLogs(() => {
    cfg = loadConfig();
  });
  assert.equal(cfg.inject.code_max_tokens, 2000);
  assert.equal(
    lines.filter((l) => l.includes("inválido")).length,
    0,
    lines.join("\n"),
  );
});

// --- Guardas de recurso: backpressure + CPU guard --------------------------

test("config_code_backpressure: default ligado com valores aceitos pelo indexer", () => {
  clearEnv();
  const bp = loadConfig().code_index.backpressure;
  assert.ok(bp, "sem backpressure o indexer não freia");
  assert.deepEqual(bp, {
    max_queue_size: 500,
    threshold_percent: 90,
    ack_required: false,
    pause_timeout_secs: 60,
  });
});

test("config_code_backpressure_invalid: max_queue_size<10 / threshold fora de 80–99 ⇒ default", () => {
  clearEnv();
  // O indexer aborta o job com BACKPRESSURE_CONFIG nesses casos: um valor
  // inválido NÃO pode chegar ao binário.
  const lowQueue = loadConfig({
    code_index: { backpressure: { max_queue_size: 5 } },
  }).code_index.backpressure;
  assert.equal((lowQueue as { max_queue_size: number }).max_queue_size, 500);

  const badThreshold = loadConfig({
    code_index: { backpressure: { threshold_percent: 50 } },
  }).code_index.backpressure;
  assert.equal((badThreshold as { threshold_percent: number }).threshold_percent, 90);
});

test("config_code_backpressure_false: desliga o envio", () => {
  clearEnv();
  assert.equal(loadConfig({ code_index: { backpressure: false } }).code_index.backpressure, false);
  process.env.KILOCODE_GRAPH_INDEX_BACKPRESSURE = "false";
  assert.equal(loadConfig().code_index.backpressure, false);
});

test("config_code_backpressure_env: string JSON sobrepõe o default", () => {
  clearEnv();
  process.env.KILOCODE_GRAPH_INDEX_BACKPRESSURE =
    '{"max_queue_size":64,"threshold_percent":85,"ack_required":false,"pause_timeout_secs":30}';
  const bp = loadConfig().code_index.backpressure as unknown as Record<string, number>;
  assert.equal(bp.max_queue_size, 64);
  assert.equal(bp.threshold_percent, 85);
  assert.equal(bp.pause_timeout_secs, 30);
});

test("config_code_cpu_guard: default 85/75 com nice 10", () => {
  clearEnv();
  assert.deepEqual(loadConfig().code_index.cpu_guard, {
    enabled: true,
    threshold_percent: 85,
    resume_percent: 75,
    sample_ms: 1000,
    max_pause_ms: 30000,
    nice: 10,
  });
});

test("config_code_cpu_guard_overrides: parcial mescla com o default", () => {
  clearEnv();
  const guard = loadConfig({
    code_index: { cpu_guard: { threshold_percent: 70, resume_percent: 60 } },
  }).code_index.cpu_guard as unknown as Record<string, number>;
  assert.equal(guard.threshold_percent, 70);
  assert.equal(guard.resume_percent, 60);
  assert.equal(guard.nice, 10, "campo não informado mantém o default");
});

test("config_code_cpu_guard_invalid: resume>threshold ou percentual fora de 0–100 ⇒ default", () => {
  clearEnv();
  const inverted = loadConfig({
    code_index: { cpu_guard: { threshold_percent: 60, resume_percent: 80 } },
  }).code_index.cpu_guard as unknown as Record<string, number>;
  assert.equal(inverted.threshold_percent, 85, "oscilação seria inevitável");

  const outOfRange = loadConfig({
    code_index: { cpu_guard: { threshold_percent: 120 } },
  }).code_index.cpu_guard as unknown as Record<string, number>;
  assert.equal(outOfRange.threshold_percent, 85);
});

test("config_code_cpu_guard_false: desliga a guarda", () => {
  clearEnv();
  assert.equal(loadConfig({ code_index: { cpu_guard: false } }).code_index.cpu_guard, false);
  process.env.KILOCODE_GRAPH_INDEX_CPU_GUARD = "false";
  assert.equal(loadConfig().code_index.cpu_guard, false);
});

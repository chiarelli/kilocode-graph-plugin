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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";

import { DEFAULTS, loadConfig } from "../src/config.ts";

const ENV_KEYS = [
  "KILOCODE_GRAPH_URL",
  "KILOCODE_GRAPH_PROGRAM",
  "KILOCODE_GRAPH_TOKEN",
  "KILOCODE_GRAPH_INJECT_ENABLED",
  "KILOCODE_GRAPH_INJECT_MAX_CHARS",
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

test("config_max_chars_env: KILOCODE_GRAPH_INJECT_MAX_CHARS é honrado", () => {
  clearEnv();
  process.env.KILOCODE_GRAPH_INJECT_MAX_CHARS = "1234";
  assert.equal(loadConfig().inject.max_chars, 1234);
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

test("config_ingest_defaults: as chaves de `ingest.*` (E4) têm os defaults declarados", () => {
  clearEnv();
  const cfg = loadConfig();
  assert.equal(cfg.ingest.enabled, false, "ingestão desligada por default (preferência do dono)");
  assert.equal(cfg.ingest.batch_size, 20);
  assert.equal(cfg.ingest.max_hashes, 5000);
  assert.equal(cfg.ingest.timeout_ms, 15000);
  assert.equal(cfg.ingest.db_path, "");
});

test("config_ingest_env: `KILOCODE_GRAPH_INGEST_*` são honradas end-to-end", () => {
  clearEnv();
  process.env.KILOCODE_GRAPH_INGEST_ENABLED = "true";
  process.env.KILOCODE_GRAPH_INGEST_BATCH_SIZE = "7";
  process.env.KILOCODE_GRAPH_INGEST_MAX_HASHES = "123";
  process.env.KILOCODE_GRAPH_INGEST_TIMEOUT_MS = "9000";
  process.env.KILOCODE_GRAPH_INGEST_DB_PATH = "/tmp/x.db";
  const cfg = loadConfig();
  assert.equal(cfg.ingest.enabled, true);
  assert.equal(cfg.ingest.batch_size, 7);
  assert.equal(cfg.ingest.max_hashes, 123);
  assert.equal(cfg.ingest.timeout_ms, 9000);
  assert.equal(cfg.ingest.db_path, "/tmp/x.db");
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

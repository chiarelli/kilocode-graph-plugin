/**
 * E1-S1 — `config.ts`: defaults e precedência `options` > env > default.
 * Puro: nenhum teste abre socket. Env é setada/restaurada por teste.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { DEFAULTS, loadConfig } from "../src/config.ts";

const ENV_KEYS = [
  "KILOCODE_GRAPH_URL",
  "KILOCODE_GRAPH_PROGRAM",
  "KILOCODE_GRAPH_TOKEN",
  "KILOCODE_GRAPH_INJECT_ENABLED",
  "KILOCODE_GRAPH_INJECT_MAX_CHARS",
] as const;

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

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

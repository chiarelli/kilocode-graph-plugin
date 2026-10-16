/**
 * E3a-S6a §7 — paridade de config boot × CLI: `persistConfigState`/`loadConfigState`
 * e a remoção de segredos do arquivo persistido.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  CONFIG_STATE_REL_PATH,
  configStateFrom,
  loadConfig,
  loadConfigState,
  persistConfigState,
} from "../src/config.ts";

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "graph-config-state-"));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("config_state_roundtrip: persistida é relida como options (§7)", () => {
  const dir = tmpDir();
  const cfg = loadConfig(
    { code_index: { enabled: true, indexer_bin: "/bin/x", load_ignores: true } },
    dir,
  );
  persistConfigState(dir, cfg);
  const state = loadConfigState(dir);
  assert.ok(state);
  // A config do CLI (persistida + dir) reproduz a MESMA config do boot.
  const cliCfg = loadConfig(state, dir);
  assert.deepEqual(cliCfg.code_index, cfg.code_index);
  // Os campos NÃO-secretos de `daemon` são idênticos aos do boot.
  assert.equal(cliCfg.daemon.url, cfg.daemon.url);
  assert.equal(cliCfg.daemon.program, cfg.daemon.program);
  assert.equal(cliCfg.daemon.workspace, cfg.daemon.workspace);
  assert.equal(cliCfg.daemon.health_timeout_ms, cfg.daemon.health_timeout_ms);
});

test("config_state_no_secrets: token/manager_token NÃO vão para o arquivo", () => {
  const dir = tmpDir();
  process.env.KILOCODE_GRAPH_TOKEN = "super-secret-token";
  process.env.KILOCODE_GRAPH_MANAGER_TOKEN = "manager-secret";
  try {
    const cfg = loadConfig(undefined, dir);
    persistConfigState(dir, cfg);
    const raw = readFileSync(join(dir, CONFIG_STATE_REL_PATH), "utf-8");
    assert.ok(!raw.includes("super-secret-token"), "token de usuário não persiste");
    assert.ok(!raw.includes("manager-secret"), "token de gestor não persiste");
    // `token_file` (caminho, não segredo) permanece; nenhuma chave `token` crua.
    const parsed = JSON.parse(raw) as { daemon: Record<string, unknown> };
    assert.equal("token" in parsed.daemon, false);
    assert.equal("manager_token" in parsed.daemon, false);
  } finally {
    delete process.env.KILOCODE_GRAPH_TOKEN;
    delete process.env.KILOCODE_GRAPH_MANAGER_TOKEN;
  }
});

test("config_state_missing: sem arquivo ⇒ undefined (CLI cai no path normal)", () => {
  const dir = tmpDir();
  assert.equal(loadConfigState(dir), undefined);
});

test("config_state_corrupt: JSON inválido ⇒ undefined (nunca lança)", () => {
  const dir = tmpDir();
  mkdirSync(join(dir, ".kilo"), { recursive: true });
  writeFileSync(join(dir, CONFIG_STATE_REL_PATH), "{not json");
  assert.equal(loadConfigState(dir), undefined);
});

test("configStateFrom_strips_token_like_keys: shape do estado não carrega token", () => {
  const dir = tmpDir();
  const cfg = loadConfig(undefined, dir);
  const state = configStateFrom(cfg) as Record<string, unknown>;
  const daemon = state.daemon as Record<string, unknown>;
  assert.equal("token" in daemon, false);
  assert.equal("manager_token" in daemon, false);
});

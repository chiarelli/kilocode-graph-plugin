/**
 * `runtime.ts` — resolve o interpretador JS do CLI. Cobre o defeito raiz: num
 * host Bun (extension host do Kilo) o `process.execPath` NÃO é Node; sem
 * `BUN_BE_BUN=1` o binário trata o `.ts` como diretório e a coleta não roda.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isBunHost, resolveNodeRuntime } from "../src/runtime.ts";

test("runtime_node_host: sem Bun ⇒ bin é o override, env intacto, sem prefixo", () => {
  const rt = resolveNodeRuntime("/usr/bin/node", false);
  assert.equal(rt.bin, "/usr/bin/node");
  assert.equal(rt.shellEnvPrefix, "");
  assert.equal(rt.env.BUN_BE_BUN, undefined);
});

test("runtime_bun_host: com Bun ⇒ propaga BUN_BE_BUN=1 e o prefixo do shell", () => {
  const rt = resolveNodeRuntime("/opt/kilo", true);
  assert.equal(rt.bin, "/opt/kilo");
  assert.equal(rt.env.BUN_BE_BUN, "1");
  assert.equal(rt.shellEnvPrefix, "BUN_BE_BUN=1 ");
});

test("runtime_override_empty_falls_back_to_execPath: vazio ⇒ process.execPath", () => {
  const rt = resolveNodeRuntime("   ", false);
  assert.equal(rt.bin, process.execPath);
});

test("runtime_isBunHost_matches_versions: reflete process.versions.bun", () => {
  assert.equal(isBunHost(), typeof process.versions.bun === "string");
});

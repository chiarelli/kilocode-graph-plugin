/**
 * Confinamento do `token_file` ao workspace (`src/index.ts:resolveTokenFile`).
 *
 * Defeito medido: um `token_file` absoluto (ou com `../..`) era honrado como
 * veio, e o provisionamento escrevia (destrutivamente) no caminho apontado —
 * contradizendo o escopo por workspace. A resolução agora CONFINA ao `dir`.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { resolveTokenFile } from "../src/index.ts";

const DIR = "/home/u/proj";
const DEFAULT = join(DIR, ".kilo", "graph-key.json");

test("token_file_default: relativo é resolvido dentro do workspace", () => {
  assert.equal(resolveTokenFile(DIR, ".kilo/graph-key.json"), DEFAULT);
});

test("token_file_relative_ok: subcaminho relativo fica dentro do workspace", () => {
  assert.equal(resolveTokenFile(DIR, "state/key.json"), join(DIR, "state/key.json"));
});

test("token_file_empty: vazio cai no default do workspace (nunca `''`)", () => {
  assert.equal(resolveTokenFile(DIR, ""), DEFAULT);
});

test("token_file_escape_relative: `../..` é recusado, cai no default", () => {
  assert.equal(resolveTokenFile(DIR, "../../etc/cron.d/x"), DEFAULT);
});

test("token_file_absolute_outside: absoluto fora do workspace é recusado", () => {
  assert.equal(resolveTokenFile(DIR, "/home/u/.ssh/authorized_keys"), DEFAULT);
  assert.equal(resolveTokenFile(DIR, "/etc/passwd"), DEFAULT);
});

test("token_file_absolute_inside: absoluto DENTRO do workspace é honrado", () => {
  const inside = join(DIR, ".kilo", "custom-key.json");
  assert.equal(resolveTokenFile(DIR, inside), inside);
});

/**
 * E3a-S4 — `index/trigger.ts`: decisão full vs incremental. Puro.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { decideTrigger, shouldWaitForReady } from "../src/index/trigger.ts";

test("trigger_first_use: manifest vazio ⇒ full", () => {
  assert.deepEqual(decideTrigger({ files: [], last_git_head: null }), {
    mode: "full",
  });
});

test("trigger_no_head: manifest com arquivos mas sem head ⇒ full", () => {
  assert.deepEqual(
    decideTrigger({ files: ["a.rs"], last_git_head: null }),
    { mode: "full" },
  );
});

test("trigger_incremental: manifest com head ⇒ incremental + git_range", () => {
  const d = decideTrigger({ files: ["a.rs"], last_git_head: "abc123" });
  assert.equal(d.mode, "incremental");
  assert.deepEqual(d.gitRange, { from: "abc123", to: "HEAD" });
});

// --- E3a-S6a §4: guarda de ancestralidade ----------------------------------

test("trigger_guard_ancestor: head ancestral de HEAD ⇒ incremental", () => {
  const d = decideTrigger(
    { files: ["a.rs"], last_git_head: "abc123" },
    { isAncestor: () => true },
  );
  assert.equal(d.mode, "incremental");
});

test("trigger_guard_non_ancestor: head NÃO-ancestral (checkout para trás) ⇒ full", () => {
  const d = decideTrigger(
    { files: ["a.rs"], last_git_head: "abc123" },
    { isAncestor: () => false },
  );
  assert.equal(d.mode, "full", "range inválido nunca vira incremental");
});

test("trigger_guard_first_use_no_query: manifest vazio ⇒ full sem consultar git", () => {
  let asked = false;
  const d = decideTrigger(
    { files: [], last_git_head: null },
    {
      isAncestor: () => {
        asked = true;
        return true;
      },
    },
  );
  assert.equal(d.mode, "full");
  assert.equal(asked, false, "1º uso decide sem git");
});

test("trigger_ready_gate: incremental sem sentinela ⇒ aguarda", () => {
  assert.equal(
    shouldWaitForReady({ mode: "incremental", gitRange: { from: "a", to: "HEAD" } }, false),
    true,
  );
  assert.equal(
    shouldWaitForReady({ mode: "incremental", gitRange: { from: "a", to: "HEAD" } }, true),
    false,
  );
  // O full do 1º uso NÃO é gated (é quem cria o sentinela).
  assert.equal(shouldWaitForReady({ mode: "full" }, false), false);
});

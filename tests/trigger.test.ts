/**
 * E3a-S4 — `index/trigger.ts`: decisão full vs incremental. Puro.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { decideTrigger } from "../src/index/trigger.ts";

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

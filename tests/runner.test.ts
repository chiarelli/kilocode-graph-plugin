/**
 * E3a-S1 — `index/runner.ts`: comando JSONL, parse defensivo e degradação do
 * spawn. Nenhum teste abre socket; o spawn real só é exercitado no E2E.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCommand, parseLine, runIndexer } from "../src/index/runner.ts";

test("runner_no_bin: indexer_bin vazio ⇒ não spawna, skipped, sem lançar", async () => {
  const result = await runIndexer({ bin: "", repoRoot: "/tmp", mode: "full" });
  assert.equal(result.skipped, true);
  assert.deepEqual(result.events, []);
  assert.match(result.reason ?? "", /vazio/);
});

test("runner_bin_missing: caminho inexistente ⇒ skipped, sem lançar", async () => {
  const result = await runIndexer({
    bin: "/does/not/exist/rust_indexer",
    repoRoot: "/tmp",
    mode: "full",
  });
  assert.equal(result.skipped, true);
  assert.deepEqual(result.events, []);
});

test("build_command_full: index_path com extract options", () => {
  const cmd = JSON.parse(
    buildCommand("full", "/repo", {
      bin: "x",
      repoRoot: "/repo",
      mode: "full",
    }),
  ) as { command: string; payload: { path: string; options: Record<string, boolean> } };
  assert.equal(cmd.command, "index_path");
  assert.equal(cmd.payload.path, "/repo");
  assert.equal(cmd.payload.options.extract_imports, true);
  assert.equal(cmd.payload.options.extract_calls, true);
});

test("build_command_incremental: use_git + git_range", () => {
  const cmd = JSON.parse(
    buildCommand("incremental", "/repo", {
      bin: "x",
      repoRoot: "/repo",
      mode: "incremental",
      gitRange: { from: "abc", to: "HEAD" },
    }),
  ) as { command: string; payload: { use_git: boolean; git_range: { from: string } } };
  assert.equal(cmd.command, "incremental_index");
  assert.equal(cmd.payload.use_git, true);
  assert.equal(cmd.payload.git_range.from, "abc");
});

test("parse_line_junk: linha não-JSON ⇒ null (ignorada)", () => {
  assert.equal(parseLine("not json {"), null);
  assert.equal(parseLine(""), null);
  assert.equal(parseLine("   "), null);
});

test("parse_line_object_only: array/escalar ⇒ null", () => {
  assert.equal(parseLine("[1,2,3]"), null);
  assert.equal(parseLine("42"), null);
});

test("parse_line_valid: JSON objeto ⇒ evento", () => {
  const ev = parseLine('{"event":"job_completed","payload":{"processed":1}}');
  assert.equal(ev?.event, "job_completed");
});

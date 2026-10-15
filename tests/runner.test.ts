/**
 * E3a-S1 — `index/runner.ts`: comando JSONL, parse defensivo e degradação do
 * spawn. Nenhum teste abre socket; o spawn real só é exercitado no E2E.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCommand, controlForEvent, controlLine, parseLine, runIndexer } from "../src/index/runner.ts";

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
    }).line,
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
    }).line,
  ) as { command: string; payload: { use_git: boolean; git_range: { from: string } } };
  assert.equal(cmd.command, "incremental_index");
  assert.equal(cmd.payload.use_git, true);
  assert.equal(cmd.payload.git_range.from, "abc");
});

test("build_command_load_ignores: default false, presente em options", () => {
  const cmd = JSON.parse(
    buildCommand("full", "/repo", { bin: "x", repoRoot: "/repo", mode: "full" }).line,
  ) as { payload: { options: Record<string, unknown> } };
  assert.equal(cmd.payload.options.load_ignores, false);
});

test("build_command_load_ignores: true propaga em options", () => {
  const cmd = JSON.parse(
    buildCommand("full", "/repo", {
      bin: "x",
      repoRoot: "/repo",
      mode: "full",
      loadIgnores: true,
    }).line,
  ) as { payload: { options: Record<string, unknown> } };
  assert.equal(cmd.payload.options.load_ignores, true);
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

// --- E3a-S4: backpressure (two-way) ----------------------------------------

test("runner_resume_on_backpressure_error: code=BACKPRESSURE ⇒ ack", () => {
  const ev = { event: "error", payload: { code: "BACKPRESSURE", detail: { pause_required: true } } };
  assert.equal(controlForEvent(ev), "ack");
});

test("runner_ack_on_pause: evento pause ⇒ ack (drena a fila)", () => {
  assert.equal(controlForEvent({ event: "pause", payload: { reason: "output_queue_full" } }), "ack");
});

test("runner_resume_on_resume: evento resume ⇒ resume (idempotente)", () => {
  assert.equal(controlForEvent({ event: "resume", payload: {} }), "resume");
});

test("runner_no_control_normal: chunk_emitted ⇒ sem comando", () => {
  assert.equal(controlForEvent({ event: "chunk_emitted", payload: {} }), null);
});

test("runner_no_control_other_error: error não-BACKPRESSURE ⇒ sem comando", () => {
  assert.equal(controlForEvent({ event: "error", payload: { code: "IO_ERR" } }), null);
});

test("control_line_shape: ack com job_id e count", () => {
  const cmd = JSON.parse(controlLine("ack", "job-1")) as {
    command: string;
    job_id: string;
    payload: { count: number };
  };
  assert.equal(cmd.command, "ack");
  assert.equal(cmd.job_id, "job-1");
  assert.equal(cmd.payload.count, 500);
});

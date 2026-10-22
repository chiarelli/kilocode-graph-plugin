/**
 * E3a-S1 — `index/runner.ts`: comando JSONL, parse defensivo e degradação do
 * spawn. Nenhum teste abre socket; o spawn real só é exercitado no E2E.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { test } from "node:test";

import { buildCommand, controlForEvent, controlLine, jobErrorFromEvent, parseLine, runIndexer } from "../src/index/runner.ts";

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

test("build_command_chunking: ausente ⇒ não vai no payload (indexer usa seu default)", () => {
  const cmd = JSON.parse(
    buildCommand("full", "/repo", { bin: "x", repoRoot: "/repo", mode: "full" }).line,
  ) as { payload: { options: Record<string, unknown> } };
  assert.equal("chunking" in cmd.payload.options, false);
});

test("build_command_chunking: presente ⇒ encaminhado CRU em options.chunking", () => {
  const chunking = {
    strategy: "symbol_boundary",
    max_lines: 0,
    overlap_lines: 0,
    include_context: true,
    token_counting: false,
  } as const;
  const cmd = JSON.parse(
    buildCommand("full", "/repo", {
      bin: "x",
      repoRoot: "/repo",
      mode: "full",
      chunking,
    }).line,
  ) as { payload: { options: Record<string, unknown> } };
  assert.deepEqual(cmd.payload.options.chunking, chunking);
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

test("runner_ack_on_backpressure_error: code=BACKPRESSURE ⇒ ack", () => {
  const ev = { event: "error", payload: { code: "BACKPRESSURE", detail: { pause_required: true } } };
  assert.equal(controlForEvent(ev), "ack");
});

test("runner_ack_on_pause: evento pause ⇒ ack (drena a fila)", () => {
  assert.equal(controlForEvent({ event: "pause", payload: { reason: "output_queue_full" } }), "ack");
});

test("runner_no_reply_on_resume: evento resume é notificação ⇒ nenhum comando", () => {
  // Regressão: responder `resume` chamava `force_resume()`/`reset_queue()` no
  // indexer, zerando a contabilidade da fila e mascarando a carga real.
  assert.equal(controlForEvent({ event: "resume", payload: {} }), null);
});

test("runner_no_control_normal: chunk_emitted ⇒ sem comando", () => {
  assert.equal(controlForEvent({ event: "chunk_emitted", payload: {} }), null);
});

test("runner_no_control_other_error: error não-BACKPRESSURE ⇒ sem comando", () => {
  assert.equal(controlForEvent({ event: "error", payload: { code: "IO_ERR" } }), null);
});

test("control_line_shape: ack carrega o count DRENADO (nunca fixo)", () => {
  const cmd = JSON.parse(controlLine("ack", "job-1", 37)) as {
    command: string;
    job_id: string;
    payload: { count: number };
  };
  assert.equal(cmd.command, "ack");
  assert.equal(cmd.job_id, "job-1");
  assert.equal(cmd.payload.count, 37, "count deve refletir o consumo real");
});

test("control_line_default_count: sem count explícito ⇒ 1 (nunca 500)", () => {
  const cmd = JSON.parse(controlLine("ack", "job-1")) as {
    payload: { count: number };
  };
  assert.equal(cmd.payload.count, 1);
});

test("control_line_no_payload_on_resume: resume não manda payload de ack", () => {
  const cmd = JSON.parse(controlLine("resume", "job-1", 9)) as {
    payload?: unknown;
  };
  assert.equal(cmd.payload, undefined);
});

// --- E3a-S6/GIT_UNAVAILABLE: erro de job não-recuperável -------------------

test("jobErrorFromEvent_git_unavailable: code/recoverable extraídos", () => {
  const err = jobErrorFromEvent({
    event: "error",
    payload: { code: "GIT_UNAVAILABLE", message: "load_ignores requires git", recoverable: false },
  });
  assert.deepEqual(err, {
    code: "GIT_UNAVAILABLE",
    message: "load_ignores requires git",
    recoverable: false,
  });
});

test("jobErrorFromEvent_recoverable_explicit: BACKPRESSURE é recuperável", () => {
  const err = jobErrorFromEvent({
    event: "error",
    payload: { code: "BACKPRESSURE", recoverable: true },
  });
  assert.equal(err?.recoverable, true);
});

test("jobErrorFromEvent_default_fatal: sem `recoverable` explícito ⇒ fatal", () => {
  // Na dúvida, tratar como fatal: nunca destruir o grafo por erro ambíguo.
  const err = jobErrorFromEvent({ event: "error", payload: { code: "WALKER_ERROR" } });
  assert.equal(err?.recoverable, false);
  assert.equal(err?.message, "WALKER_ERROR", "sem message ⇒ usa o code");
});

test("jobErrorFromEvent_non_error_event: chunk_emitted ⇒ null", () => {
  assert.equal(jobErrorFromEvent({ event: "chunk_emitted", payload: {} }), null);
});

test("jobErrorFromEvent_malformed: payload não-objeto ⇒ null", () => {
  assert.equal(jobErrorFromEvent({ event: "error", payload: null }), null);
});

test("jobErrorFromEvent_array_payload: array ⇒ null (não um falso fatal UNKNOWN)", () => {
  // Array passa em `typeof === "object"`; sem a guarda, viraria fatal `UNKNOWN`.
  assert.equal(jobErrorFromEvent({ event: "error", payload: [] }), null);
  assert.equal(jobErrorFromEvent({ event: "error", payload: [{ code: "X" }] }), null);
});

// --- runIndexer: propagação REAL do erro até `result.error` ----------------

/** Escreve um "indexer" falso em shell que emite as linhas JSONL dadas. */
function fakeIndexer(lines: string[]): string {
  const dir = mkdtempSync(pjoin(tmpdir(), "fake-idx-"));
  const bin = pjoin(dir, "idx.sh");
  const body = lines.map((l) => `echo ${JSON.stringify(l)}`).join("\n");
  writeFileSync(bin, `#!/bin/sh\n${body}\nexit 0\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test("runIndexer_error_event: error fatal + job_completed ⇒ result.error", async () => {
  const bin = fakeIndexer([
    JSON.stringify({
      event: "error",
      payload: { code: "GIT_UNAVAILABLE", message: "no git", recoverable: false },
    }),
    JSON.stringify({ event: "job_completed", payload: { processed: 0, errors: 1 } }),
  ]);
  try {
    const result = await runIndexer({ bin, repoRoot: "/tmp", mode: "full" });
    assert.equal(result.error?.code, "GIT_UNAVAILABLE");
    assert.equal(result.skipped, false);
  } finally {
    rmSync(pjoin(bin, ".."), { recursive: true, force: true });
  }
});

test("runIndexer_error_no_completed: error fatal SEM job_completed ⇒ não trava; result.error", async () => {
  // `INVALID_PAYLOAD` faz early-return sem `job_completed`; o processo sai e o
  // `close` deve propagar o erro (não esperar o timeout perder o `jobError`).
  const bin = fakeIndexer([
    JSON.stringify({
      event: "error",
      payload: { code: "INVALID_PAYLOAD", message: "missing payload", recoverable: false },
    }),
  ]);
  try {
    const result = await runIndexer({ bin, repoRoot: "/tmp", mode: "full" });
    assert.equal(result.error?.code, "INVALID_PAYLOAD");
  } finally {
    rmSync(pjoin(bin, ".."), { recursive: true, force: true });
  }
});

test("runIndexer_recoverable_error: erro recuperável NÃO vira result.error", async () => {
  const bin = fakeIndexer([
    JSON.stringify({ event: "error", payload: { code: "BACKPRESSURE", recoverable: true } }),
    JSON.stringify({ event: "job_completed", payload: { processed: 1, errors: 0 } }),
  ]);
  try {
    const result = await runIndexer({ bin, repoRoot: "/tmp", mode: "full" });
    assert.equal(result.error, undefined, "recuperável ⇒ segue o fluxo normal");
  } finally {
    rmSync(pjoin(bin, ".."), { recursive: true, force: true });
  }
});

// --- Regressões: backpressure enviado + streaming (memória) -----------------

test("build_command_backpressure_default: envia options.backpressure", () => {
  const cmd = JSON.parse(
    buildCommand("full", "/repo", { bin: "x", repoRoot: "/repo", mode: "full" }).line,
  ) as { payload: { options: Record<string, unknown> } };
  const bp = cmd.payload.options.backpressure as Record<string, unknown>;
  assert.ok(bp, "sem backpressure o indexer não ativa o monitor");
  assert.equal(bp.max_queue_size, 500);
  assert.equal(bp.threshold_percent, 90);
  assert.equal(bp.ack_required, false);
  assert.equal(bp.pause_timeout_secs, 60);
});

test("build_command_backpressure_false: não envia a chave", () => {
  const cmd = JSON.parse(
    buildCommand("full", "/repo", {
      bin: "x",
      repoRoot: "/repo",
      mode: "full",
      backpressure: false,
    }).line,
  ) as { payload: { options: Record<string, unknown> } };
  assert.equal("backpressure" in cmd.payload.options, false);
});

test("build_command_backpressure_override: valores do operador são honrados", () => {
  const cmd = JSON.parse(
    buildCommand("full", "/repo", {
      bin: "x",
      repoRoot: "/repo",
      mode: "full",
      backpressure: { max_queue_size: 64, threshold_percent: 85 },
    }).line,
  ) as { payload: { options: Record<string, unknown> } };
  const bp = cmd.payload.options.backpressure as Record<string, unknown>;
  assert.equal(bp.max_queue_size, 64);
  assert.equal(bp.threshold_percent, 85);
  assert.equal(bp.pause_timeout_secs, 60, "não configurado ⇒ default");
});

test("runIndexer_on_event_streams: eventos vão ao consumidor e NÃO ficam em RAM", async () => {
  const bin = fakeIndexer([
    JSON.stringify({ event: "chunk_emitted", payload: { file: "a.rs" } }),
    JSON.stringify({ event: "chunk_emitted", payload: { file: "b.rs" } }),
    JSON.stringify({ event: "job_completed", payload: {} }),
  ]);
  const seen: string[] = [];
  try {
    const result = await runIndexer({
      bin,
      repoRoot: "/tmp",
      mode: "full",
      cpuGuard: false,
      onEvent: (ev) => seen.push(String(ev.event)),
    });
    assert.deepEqual(result.events, [], "streaming não retém os eventos");
    assert.equal(result.eventCount, 3);
    assert.deepEqual(seen, ["chunk_emitted", "chunk_emitted", "job_completed"]);
  } finally {
    rmSync(pjoin(bin, ".."), { recursive: true, force: true });
  }
});

test("runIndexer_ack_counts_drained: ack carrega o nº real de eventos drenados", async () => {
  // O defeito original: `pause` ⇒ `ack {count:500}` fixo, zerando a fila do
  // indexer independentemente do consumo real. Aqui o "indexer" emite 3 chunks,
  // pausa, e registra o comando que recebeu no stdin.
  const dir = mkdtempSync(pjoin(tmpdir(), "ack-count-"));
  const bin = pjoin(dir, "idx.sh");
  const out = pjoin(dir, "ack.txt");
  const chunk = JSON.stringify({
    event: "chunk_emitted",
    payload: { file: "a.rs", chunk_id: "c", chunk_md5: "m" },
  });
  writeFileSync(
    bin,
    `#!/bin/sh\n` +
      `echo '${chunk}'\n` +
      `echo '${chunk}'\n` +
      `echo '${chunk}'\n` +
      `echo '${JSON.stringify({ event: "pause", payload: { reason: "output_queue_full" } })}'\n` +
      `IFS= read -r _cmd\n` +
      `IFS= read -r line\n` +
      `printf '%s' "$line" > '${out}'\n` +
      `echo '${JSON.stringify({ event: "job_completed", payload: {} })}'\n`,
  );
  chmodSync(bin, 0o755);
  try {
    const result = await runIndexer({
      bin,
      repoRoot: "/tmp",
      mode: "full",
      cpuGuard: false,
    });
    assert.equal(result.skipped, false);
    const ack = JSON.parse(readFileSync(out, "utf-8")) as {
      command: string;
      payload: { count: number };
    };
    assert.equal(ack.command, "ack");
    assert.equal(ack.payload.count, 3, "3 chunks drenados ⇒ count 3");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

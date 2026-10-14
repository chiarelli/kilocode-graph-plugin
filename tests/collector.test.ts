/**
 * E3a-S1 — `index/collector.ts`: eventos JSONL → body do sync. Puro (sem rede).
 *
 * Usa a fixture REAL gravada do `rust-ast-indexer` (`tests/fixtures/
 * indexer_events.jsonl`) para os casos de agrupamento e nome puro do símbolo.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildSyncBody,
  collectFiles,
  toChunk,
} from "../src/index/collector.ts";
import type { IndexerEvent } from "../src/types.ts";

/** Lê a fixture e devolve os eventos parseados (linha a linha). */
function loadFixture(): IndexerEvent[] {
  const raw = readFileSync(
    new URL("./fixtures/indexer_events.jsonl", import.meta.url),
    "utf8",
  );
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as IndexerEvent);
}

const IDENTITY = { workspace: "waweb", program: "default" };

function chunkEvent(
  file: string,
  symbol: string | null,
  extra: Record<string, unknown> = {},
): IndexerEvent {
  return {
    event: "chunk_emitted",
    payload: {
      chunk_id: `${file}#${symbol}`,
      chunk_kind: symbol ? "Symbol" : "FullFile",
      file,
      language: "rust",
      symbol_id: symbol,
      start_line: 1,
      end_line: 2,
      chunk_md5: `md5-${file}-${symbol}`,
      text: "fn x() {}",
      ...extra,
    },
  };
}

test("build_body_groups_by_file: 2 arquivos, 3 chunks ⇒ files.length==2", () => {
  const events = [
    chunkEvent("src/a.rs", "a1"),
    chunkEvent("src/a.rs", "a2"),
    chunkEvent("src/b.rs", "b1"),
  ];
  const body = buildSyncBody(events, IDENTITY, { readFile: () => "x" });
  assert.equal(body.files.length, 2);
  const a = body.files.find((f) => f.file_path === "src/a.rs");
  // 2 Symbols + 1 FullFile sintético (S3).
  assert.equal(a?.chunks.filter((c) => c.chunk_kind === "Symbol").length, 2);
});

test("build_body_symbol_bare: symbol_id 'main' usado cru (sem file:)", () => {
  const body = buildSyncBody([chunkEvent("src/main.rs", "main")], IDENTITY, {
    readFile: () => "x",
  });
  const sym = body.files[0]?.chunks.find((c) => c.chunk_kind === "Symbol");
  assert.equal(sym?.symbol_id, "main");
});

test("build_body_symbol_bare_strips_qualified: 'src/x.rs:main' ⇒ 'main'", () => {
  const body = buildSyncBody(
    [chunkEvent("src/x.rs", "src/x.rs:main")],
    IDENTITY,
    { readFile: () => "x" },
  );
  // Cinto de segurança: nunca reconcatena o arquivo (produziria
  // 'src/x.rs:src/x.rs:main'); a chave é montada pelo servidor.
  const sym = body.files[0]?.chunks.find((c) => c.chunk_kind === "Symbol");
  assert.equal(sym?.symbol_id, "main");
});

test("build_body_ignores_junk: evento sem file/chunk inválido é ignorado", () => {
  const events: IndexerEvent[] = [
    chunkEvent("src/a.rs", "a1"),
    { event: "chunk_emitted", payload: { file: "" } },
    { event: "capabilities", payload: { languages: ["rust"] } },
    { event: "job_completed", payload: { processed: 1 } },
  ];
  const body = buildSyncBody(events, IDENTITY, { readFile: () => "x" });
  assert.equal(body.files.length, 1);
  assert.equal(
    body.files[0]?.chunks.filter((c) => c.chunk_kind === "Symbol").length,
    1,
  );
});

test("sync_body_shape: body tem workspace/program/files/edges", () => {
  const body = buildSyncBody([chunkEvent("src/a.rs", "a1")], IDENTITY, {
    readFile: () => "x",
  });
  assert.equal(body.workspace, "waweb");
  assert.equal(body.program, "default");
  assert.ok(Array.isArray(body.files));
  assert.ok(Array.isArray(body.edges));
});

test("toChunk_rejects_missing_md5: sem chunk_md5 ⇒ null", () => {
  assert.equal(toChunk({ chunk_id: "c1", chunk_kind: "Symbol" }), null);
});

test("toChunk_fullfile_drops_symbol: FullFile não aceita symbol_id", () => {
  const chunk = toChunk({
    chunk_id: "full-1",
    chunk_kind: "FullFile",
    symbol_id: "x",
    chunk_md5: "m",
    start_line: 0,
    end_line: 1,
    text: "",
  });
  assert.equal(chunk?.symbol_id, null);
});

test("fixture_real_events: agrupa os 2 arquivos do índice real", () => {
  const events = loadFixture();
  const files = collectFiles(events);
  const paths = files.map((f) => f.file_path).sort();
  assert.deepEqual(paths, ["src/db.rs", "src/main.rs"]);
  // O real não emite FullFile; emite Symbols com nome puro.
  for (const f of files) {
    for (const c of f.chunks) {
      assert.equal(c.chunk_kind, "Symbol");
      assert.ok(c.symbol_id && !c.symbol_id.includes("/"));
    }
  }
});

// --- E3a-S3: FullFile sintético + removidos ---------------------------------

test("fullfile_synthetic: arquivo sem FullFile do indexer ⇒ 1 FullFile inserido", () => {
  const body = buildSyncBody([chunkEvent("src/a.rs", "a1")], IDENTITY, {
    readFile: () => "fn a1() {}\n",
  });
  const a = body.files.find((f) => f.file_path === "src/a.rs");
  assert.equal(a?.chunks.filter((c) => c.chunk_kind === "FullFile").length, 1);
  assert.equal(a?.chunks[0]?.chunk_id, "full-src/a.rs");
  assert.equal(a?.chunks[0]?.symbol_id, null);
});

test("no_dup_fullfile: indexer já emitiu FullFile ⇒ não duplica", () => {
  const events: IndexerEvent[] = [
    chunkEvent("src/a.rs", null), // FullFile (symbol null)
    chunkEvent("src/a.rs", "a1"),
  ];
  const body = buildSyncBody(events, IDENTITY, { readFile: () => "x" });
  const a = body.files.find((f) => f.file_path === "src/a.rs");
  assert.equal(a?.chunks.filter((c) => c.chunk_kind === "FullFile").length, 1);
});

test("removed_chunks_empty: removido entra com chunks: []", () => {
  const body = buildSyncBody([chunkEvent("src/a.rs", "a1")], IDENTITY, {
    readFile: () => "x",
    removed: ["src/gone.rs"],
  });
  const gone = body.files.find((f) => f.file_path === "src/gone.rs");
  assert.ok(gone);
  assert.deepEqual(gone?.chunks, []);
});

test("removed_skips_present: removido que ainda está no payload é ignorado", () => {
  const body = buildSyncBody([chunkEvent("src/a.rs", "a1")], IDENTITY, {
    readFile: () => "x",
    removed: ["src/a.rs"],
  });
  assert.equal(body.files.filter((f) => f.chunks.length === 0).length, 0);
});

test("fullfile_unreadable: arquivo ilegível ⇒ FullFile com texto vazio", () => {
  const body = buildSyncBody([chunkEvent("src/a.rs", "a1")], IDENTITY, {
    readFile: () => {
      throw new Error("EACCES");
    },
  });
  const a = body.files.find((f) => f.file_path === "src/a.rs");
  const full = a?.chunks.find((c) => c.chunk_kind === "FullFile");
  assert.equal(full?.text, "");
  assert.ok(full?.chunk_md5, "md5 do texto vazio existe");
});

test("build_body_handles_malformed_payload: payload null não lança", () => {
  const events: IndexerEvent[] = [{ event: "chunk_emitted", payload: null }];
  assert.doesNotThrow(() => buildSyncBody(events, IDENTITY, { readFile: () => "x" }));
});

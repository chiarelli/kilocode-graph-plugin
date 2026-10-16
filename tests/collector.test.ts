/**
 * E3a-S1 — `index/collector.ts`: eventos JSONL → body do sync. Puro (sem rede).
 *
 * Usa a fixture REAL gravada do `rust-ast-indexer` (`tests/fixtures/
 * indexer_events.jsonl`) para os casos de agrupamento e nome puro do símbolo.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildSyncBody,
  capChunkText,
  collectFiles,
  MAX_FULLFILE_CHARS,
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

// --- Tetos de texto (422 string_too_long): FullFile E Symbol ---------------

test("capChunkText_below_limit_unchanged: ≤teto ⇒ texto idêntico", () => {
  const text = "x".repeat(MAX_FULLFILE_CHARS);
  assert.equal(capChunkText(text), text);
});

test("capChunkText_above_limit_truncated_with_mark: nunca excede o teto", () => {
  const out = capChunkText("x".repeat(MAX_FULLFILE_CHARS + 1));
  assert.ok(out.length <= MAX_FULLFILE_CHARS, `len=${out.length}`);
  assert.ok(out.includes("[truncated]"), "marca o corte (consumidor distingue)");
});

test("capChunkText_never_splits_surrogate_pair: emoji na fronteira do corte", () => {
  // Cortar no meio de um par substituto deixa Unicode inválido (o memtier pode
  // recusar). A fronteira recua 1 unidade em vez de partir o par.
  const mark = "\n… [truncated]";
  const keep = MAX_FULLFILE_CHARS - mark.length;
  const straddle = "a".repeat(keep - 1) + "😀" + "b".repeat(50);
  const out = capChunkText(straddle);
  const atCut = out.charCodeAt(out.length - mark.length - 1);
  assert.ok(
    !(atCut >= 0xd800 && atCut <= 0xdbff),
    `surrogate solto na fronteira: U+${atCut.toString(16).toUpperCase()}`,
  );
  assert.ok(out.length <= MAX_FULLFILE_CHARS);
});

test("fullfile_truncation: arquivo >teto ⇒ FullFile capado, end_line do enviado", () => {
  // O arquivo inteiro (178070 chars no probe) estoura o teto do memtier (100000).
  // Fixture MULTILINHA: prova que `end_line` cai (não é auto-referente com 1 linha).
  const huge = `${"x".repeat(100)}\n`.repeat(1_000); // 101.000 chars, 1000 linhas
  const originalLines = huge.split("\n").length;
  const body = buildSyncBody([chunkEvent("src/big.rs", "sym")], IDENTITY, {
    readFile: () => huge,
  });
  const full = body.files[0]?.chunks.find((c) => c.chunk_kind === "FullFile");
  assert.ok(full, "FullFile sintético existe");
  assert.ok(full!.text.length <= MAX_FULLFILE_CHARS, `len=${full!.text.length}`);
  assert.ok(full!.text.includes("[truncated]"));
  assert.equal(full!.end_line, full!.text.split("\n").length);
  assert.ok(
    full!.end_line < originalLines,
    `end_line=${full!.end_line} deveria ser < ${originalLines} (texto cortado)`,
  );
  // md5 coerente com o texto ENVIADO (não com o original).
  const md5 = (s: string) => createHash("md5").update(s, "utf-8").digest("hex");
  assert.notEqual(full!.chunk_md5, md5(huge), "md5 do original não vale p/ o cortado");
});

test("symbol_truncation: Symbol >teto do indexer ⇒ capado e md5 recalculado", () => {
  // Um símbolo gigante do indexer derrubaria o lote inteiro; o cap mantém o
  // md5 coerente com o texto enviado (senão o servidor pularia a atualização).
  const huge = "y".repeat(MAX_FULLFILE_CHARS + 100);
  const chunk = toChunk({
    chunk_id: "c-huge",
    chunk_kind: "Symbol",
    file: "src/big.rs",
    symbol_id: "big",
    start_line: 1,
    end_line: 1,
    chunk_md5: "indexer-provided-md5",
    text: huge,
  });
  assert.ok(chunk);
  assert.ok(chunk!.text.length <= MAX_FULLFILE_CHARS, `len=${chunk!.text.length}`);
  assert.notEqual(chunk!.chunk_md5, "indexer-provided-md5", "md5 recalculado no corte");
});

test("symbol_truncation_end_line: end_line cai para o texto enviado, não o do indexer", () => {
  // Multi-linha: 60.000 linhas viram ~44.995 ao cortar. Manter `end_line=60000`
  // faria o servidor inferir linhas que não existem no chunk enviado.
  const big = "a\n".repeat(60_000);
  const chunk = toChunk({
    chunk_id: "c-lines",
    chunk_kind: "Symbol",
    file: "src/big.rs",
    symbol_id: "big",
    start_line: 1,
    end_line: 60_000,
    chunk_md5: "m",
    text: big,
  });
  assert.ok(chunk);
  assert.equal(chunk!.end_line, chunk!.text.split("\n").length);
  assert.ok(chunk!.end_line < 60_000, `end_line=${chunk!.end_line} deveria ter caído`);
});

test("toChunk_non_string_text_recomputes_md5: text ausente ⇒ md5 do indexer não vale", () => {
  // `text` ausente/não-string vira "" mas o md5 do indexer descreveria outro
  // conteúdo — mantê-lo faria o servidor pular a atualização.
  const chunk = toChunk({
    chunk_id: "c-none",
    chunk_kind: "Symbol",
    file: "src/a.rs",
    symbol_id: "a",
    start_line: 1,
    end_line: 1,
    chunk_md5: "indexer-md5",
    text: undefined,
  });
  assert.equal(chunk!.text, "");
  assert.notEqual(chunk!.chunk_md5, "indexer-md5", "md5 recalculado quando text ≠ original");
});

test("symbol_no_truncation_keeps_indexer_md5: ≤teto ⇒ md5 do indexer preservado", () => {
  const chunk = toChunk({
    chunk_id: "c-ok",
    chunk_kind: "Symbol",
    file: "src/a.rs",
    symbol_id: "a",
    start_line: 1,
    end_line: 1,
    chunk_md5: "indexer-md5",
    text: "fn a() {}",
  });
  assert.equal(chunk!.chunk_md5, "indexer-md5", "sem corte, idempotência preservada");
  assert.equal(chunk!.end_line, 1, "sem corte, end_line do indexer preservado");
});

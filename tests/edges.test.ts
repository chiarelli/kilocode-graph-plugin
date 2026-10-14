/**
 * E3a-S2 — `index/edges.ts`: resolução de arestas Rust, descarte de órfãs e
 * dedup. Puro (sem rede). Cobre a tabela de testes da spec §E3a-S2.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { collectEdges, buildSyncBody } from "../src/index/collector.ts";
import { resolveEdges, resolveModule } from "../src/index/edges.ts";
import type { CodeFile, IndexerEvent } from "../src/types.ts";

/** Arquivo com chunks Symbol (nome puro). */
function file(path: string, symbols: string[]): CodeFile {
  return {
    file_path: path,
    language: "rust",
    chunks: symbols.map((s, i) => ({
      chunk_id: `${path}#${s}`,
      chunk_kind: "Symbol" as const,
      symbol_id: s,
      start_line: i,
      end_line: i + 1,
      chunk_md5: `md5-${path}-${s}`,
      text: "",
    })),
  };
}

/** Adiciona o `FullFile` sintético (origem das arestas de nível de arquivo). */
function withFullFile(f: CodeFile): CodeFile {
  return {
    ...f,
    chunks: [
      {
        chunk_id: `full-${f.file_path}`,
        chunk_kind: "FullFile",
        symbol_id: null,
        start_line: 1,
        end_line: 10,
        chunk_md5: `md5-full-${f.file_path}`,
        text: "",
      },
      ...f.chunks,
    ],
  };
}

const FILES = [
  withFullFile(file("src/main.rs", ["main"])),
  withFullFile(file("src/db.rs", ["connect", "validate"])),
];

test("resolve_rust_crate: crate::db + src/db.rs existe ⇒ src/db.rs", () => {
  const known = new Set(["src/db.rs"]);
  assert.equal(resolveModule("src/main.rs", "crate::db", known), "src/db.rs");
});

test("resolve_rust_std: std::collections ⇒ descartada (null)", () => {
  assert.equal(resolveModule("src/main.rs", "std::collections", new Set(["src/collections.rs"])), null);
});

test("resolve_rust_mod_rs: crate::a + src/a/mod.rs ⇒ mod.rs", () => {
  const known = new Set(["src/a/mod.rs"]);
  assert.equal(resolveModule("src/lib.rs", "crate::a", known), "src/a/mod.rs");
});

test("resolve_missing_target: alvo não indexado ⇒ descartada", () => {
  const known = new Set(["src/db.rs"]);
  assert.equal(resolveModule("src/main.rs", "crate::missing", known), null);
});

test("resolve_rust_self_super: self e super relativos ao diretório do arquivo", () => {
  // Mesma regra do probe: `self::`/`super::` partem de `dirname(src)`.
  assert.equal(resolveModule("src/a.rs", "self::b", new Set(["src/b.rs"])), "src/b.rs");
  assert.equal(resolveModule("src/sub/mod.rs", "super::top", new Set(["src/top.rs"])), "src/top.rs");
  assert.equal(resolveModule("src/a.rs", "self::b", new Set(["src/db.rs"])), null);
});

test("resolve_edges_import: import resolvido vira aresta import", () => {
  const edges = resolveEdges(
    [{ from_file: "src/main.rs", to_module: "crate::db", imported_symbol: "connect" }],
    [],
    FILES,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.edge_kind, "import");
  assert.equal(edges[0]?.to_file, "src/db.rs");
  assert.equal(edges[0]?.to_symbol_id, "connect");
});

test("import_missing_target_discarded: crate::missing ⇒ sem aresta (nunca 422)", () => {
  const edges = resolveEdges(
    [{ from_file: "src/main.rs", to_module: "crate::missing" }],
    [],
    FILES,
  );
  assert.deepEqual(edges, []);
});

test("call_last_segment: Parser::parse + parse existe ⇒ to_symbol_id", () => {
  const edges = resolveEdges(
    [],
    [{ from_file: "src/main.rs", caller_symbol_id: "main", callee_name: "Parser::parse" }],
    [file("src/main.rs", ["main"]), file("src/parser.rs", ["parse"])],
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.edge_kind, "call");
  assert.equal(edges[0]?.from_symbol_id, "main");
  assert.equal(edges[0]?.to_symbol_id, "parse");
});

test("call_last_segment_dotted: dsn.to_string ⇒ último segmento", () => {
  const edges = resolveEdges(
    [],
    [{ from_file: "src/db.rs", caller_symbol_id: "connect", callee_name: "dsn.to_string" }],
    [file("src/db.rs", ["connect"]), file("src/str.rs", ["to_string"])],
  );
  assert.equal(edges[0]?.to_symbol_id, "to_string");
});

test("call_unknown_callee: callee inexistente ⇒ descartada", () => {
  const edges = resolveEdges(
    [],
    [{ from_file: "src/db.rs", caller_symbol_id: "connect", callee_name: "nope" }],
    FILES,
  );
  assert.deepEqual(edges, []);
});

test("call_unknown_caller: caller não é símbolo conhecido ⇒ descartada", () => {
  const edges = resolveEdges(
    [],
    [{ from_file: "src/db.rs", caller_symbol_id: "ghost", callee_name: "connect" }],
    FILES,
  );
  assert.deepEqual(edges, []);
});

test("edge_dedup: mesma aresta 2× ⇒ 1 aresta", () => {
  const imp = { from_file: "src/main.rs", to_module: "crate::db", imported_symbol: "connect" };
  const edges = resolveEdges([imp, { ...imp }], [], FILES);
  assert.equal(edges.length, 1);
});

test("edge_kind_enum: todas as arestas são import|call", () => {
  const edges = resolveEdges(
    [{ from_file: "src/main.rs", to_module: "crate::db" }],
    [{ from_file: "src/db.rs", caller_symbol_id: "connect", callee_name: "validate" }],
    FILES,
  );
  for (const e of edges) assert.ok(["import", "call"].includes(e.edge_kind));
});

test("import_origin_missing_discarded: sem FullFile de origem ⇒ descartada (S3 sintetiza)", () => {
  // Sem o `FullFile` sintético (S3), a origem da aresta de nível de arquivo não
  // existe como CodeChunk ⇒ ADR-012 D3 reprovaria (422). Descarta.
  const edges = resolveEdges(
    [{ from_file: "src/main.rs", to_module: "crate::db", imported_symbol: "connect" }],
    [],
    [file("src/main.rs", ["main"]), file("src/db.rs", ["connect"])],
  );
  assert.deepEqual(edges, []);
});

test("build_body_includes_edges: buildSyncBody popula edges[]", () => {
  const events: IndexerEvent[] = [
    {
      event: "chunk_emitted",
      payload: {
        chunk_id: "full-main", chunk_kind: "FullFile", file: "src/main.rs", language: "rust",
        symbol_id: null, start_line: 1, end_line: 3, chunk_md5: "mf", text: "",
      },
    },
    {
      event: "chunk_emitted",
      payload: {
        chunk_id: "c1", chunk_kind: "Symbol", file: "src/main.rs", language: "rust",
        symbol_id: "main", start_line: 1, end_line: 2, chunk_md5: "m1", text: "",
      },
    },
    {
      event: "chunk_emitted",
      payload: {
        chunk_id: "c2", chunk_kind: "Symbol", file: "src/db.rs", language: "rust",
        symbol_id: "connect", start_line: 1, end_line: 2, chunk_md5: "m2", text: "",
      },
    },
    {
      event: "import_edge",
      payload: { from_file: "src/main.rs", to_module: "crate::db", imported_symbol: "connect" },
    },
  ];
  const body = buildSyncBody(events, { workspace: "ws", program: "default" });
  assert.equal(body.edges.length, 1);
  assert.equal(body.edges[0]?.edge_kind, "import");
  assert.equal(body.edges[0]?.to_symbol_id, "connect");
});

test("collect_edges_splits: events separados em imports/calls", () => {
  const events: IndexerEvent[] = [
    { event: "import_edge", payload: { from_file: "a", to_module: "b" } },
    { event: "call_edge", payload: { from_file: "a", caller_symbol_id: "x", callee_name: "y" } },
    { event: "chunk_emitted", payload: { file: "a", chunk_id: "c", chunk_md5: "m" } },
  ];
  const { imports, calls } = collectEdges(events);
  assert.equal(imports.length, 1);
  assert.equal(calls.length, 1);
});

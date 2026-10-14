/**
 * E3a-S3 — `index/manifest.ts`: load/save atômico, removidos e corrupção.
 * Puro (leitor/writer injetados; nenhum arquivo real).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  emptyManifest,
  isFirstUse,
  loadManifest,
  mergeManifest,
  removedFiles,
  saveManifest,
} from "../src/index/manifest.ts";

test("manifest_empty: workspace novo ⇒ vazio (força full)", () => {
  const m = emptyManifest("ws");
  assert.equal(m.workspace, "ws");
  assert.equal(m.last_git_head, null);
  assert.deepEqual(m.files, []);
  assert.equal(isFirstUse(m), true);
});

test("manifest_corrupt: JSON inválido ⇒ tratado como vazio", () => {
  const m = loadManifest("/bad.json", "ws", () => "{not json");
  assert.deepEqual(m.files, []);
  assert.equal(m.last_git_head, null);
});

test("manifest_load: JSON válido ⇒ campos lidos", () => {
  const m = loadManifest("/ok.json", "ws", () =>
    JSON.stringify({
      workspace: "outro",
      last_git_head: "abc",
      files: ["a", "b"],
      updated_at: "2026-01-01T00:00:00Z",
    }),
  );
  assert.equal(m.workspace, "outro");
  assert.equal(m.last_git_head, "abc");
  assert.deepEqual(m.files, ["a", "b"]);
});

test("manifest_load_missing: arquivo ausente (leitor lança) ⇒ vazio", () => {
  const m = loadManifest("/missing.json", "ws", () => {
    throw new Error("ENOENT");
  });
  assert.deepEqual(m.files, []);
});

test("manifest_removed: arquivo saiu do payload ⇒ entra em removed", () => {
  const m = { ...emptyManifest("ws"), files: ["a.rs", "b.rs", "c.rs"] };
  assert.deepEqual(removedFiles(m, ["a.rs", "c.rs"]), ["b.rs"]);
});

test("manifest_removed_none: tudo presente ⇒ []", () => {
  const m = { ...emptyManifest("ws"), files: ["a.rs"] };
  assert.deepEqual(removedFiles(m, ["a.rs", "z.rs"]), []);
});

test("manifest_atomic_write: grava em tmp e renomeia; JSON válido", () => {
  const calls: Array<[string, string]> = [];
  let renamed: [string, string] | null = null;
  saveManifest("/ws/.kilo/graph-manifest.json", mergeManifest("ws", ["a.rs"], "sha"), {
    writeFile: (p, d) => calls.push([p, d]),
    rename: (from, to) => {
      renamed = [from, to];
    },
    mkdir: () => {},
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0]![0], /\.tmp$/);
  assert.deepEqual(renamed, ["/ws/.kilo/graph-manifest.json.tmp", "/ws/.kilo/graph-manifest.json"]);
  const parsed = JSON.parse(calls[0]![1]) as { files: string[]; last_git_head: string };
  assert.deepEqual(parsed.files, ["a.rs"]);
  assert.equal(parsed.last_git_head, "sha");
});

test("manifest_merge_dedups: arquivos duplicados ⇒ um só", () => {
  const m = mergeManifest("ws", ["a.rs", "a.rs", "b.rs"], null);
  assert.deepEqual(m.files, ["a.rs", "b.rs"]);
});

test("manifest_no_path: caminho vazio ⇒ save é no-op (não lança)", () => {
  assert.doesNotThrow(() => saveManifest("", emptyManifest("ws")));
});

test("manifest_creates_dir: cria o diretório pai (.kilo) antes de gravar", () => {
  let madeDir = "";
  let renamed: [string, string] | null = null;
  saveManifest("/repo/.kilo/graph-manifest.json", emptyManifest("ws"), {
    writeFile: () => {},
    rename: (from, to) => {
      renamed = [from, to];
    },
    mkdir: (p) => {
      madeDir = p;
    },
  });
  assert.equal(madeDir, "/repo/.kilo");
  assert.ok(renamed, "deve renomear o tmp para o destino");
});

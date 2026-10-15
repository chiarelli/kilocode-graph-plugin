/**
 * E1-S1 — `workspace.ts`: resolução de diretório e nome lógico. Puro.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveWorkspaceDir, workspaceName } from "../src/workspace.ts";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASHED = /^[a-z0-9][a-z0-9_-]*[a-z0-9]-[0-9a-f]{8}$/;

test("workspace_name_always_hashed: basename válido ⇒ `<stem>-<sha1 8>`", () => {
  assert.match(workspaceName("/home/u/kilocode-graph-plugin"), /^kilocode-graph-plugin-[0-9a-f]{8}$/);
  assert.match(workspaceName("/home/u/waweb"), /^waweb-[0-9a-f]{8}$/);
  // O sufixo é o sha1(8) do caminho RESOLVIDO, não do basename.
  const a = workspaceName("/home/u/foo");
  const b = workspaceName("/home/v/foo");
  assert.equal(a.slice(0, 4), "foo-");
  assert.notEqual(a, b, "mesmo basename, paths distintos ⇒ hashes distintos");
});

test("workspace_name_charset_and_len: casa o charset da borda e ≤64", () => {
  for (const dir of ["/home/u/waweb", "/home/u/My Project!", "/home/u/a--b", "/home/u/_iam"]) {
    const name = workspaceName(dir);
    assert.match(name, NAME_RE, `dir=${dir} nome=${name}`);
    assert.ok(name.length <= 64, `dir=${dir} len=${name.length}`);
    assert.ok(!name.includes("--"), `dir=${dir} contém '--'`);
  }
});

test("workspace_name_sanitized: saneamento lossy mantém o hash (sempre)", () => {
  assert.match(workspaceName("/home/u/My Project!"), /^my-project-[0-9a-f]{8}$/);
  assert.match(workspaceName("/home/u/a--b"), /^a-b-[0-9a-f]{8}$/);
});

test("workspace_name_reserved: '_iam' ⇒ stem `ws` + hash", () => {
  assert.match(workspaceName("/home/u/_iam"), /^ws-[0-9a-f]{8}$/);
});

test("workspace_name_deterministic: mesmo dir ⇒ mesmo nome", () => {
  assert.equal(workspaceName("/home/u/proj"), workspaceName("/home/u/proj"));
});

test("workspace_name_truncated: basename longo trunca a ≤64 COM hash", () => {
  const long = "a".repeat(100);
  const name = workspaceName(`/home/u/${long}`);
  assert.ok(name.length <= 64, `len=${name.length}`);
  assert.match(name, HASHED);
});

// Contrato 1:1 — o `sha1 8` do caminho garante injetividade em TODAS as
// fronteiras: basename idêntico, saneamento lossy e truncamento.
test("workspace_name_basename_collision: homônimos ⇒ distintos (hash do path)", () => {
  assert.notEqual(
    workspaceName("/home/u/a/foo"),
    workspaceName("/home/u/b/foo"),
    "mesmo basename em pais diferentes não pode colidir",
  );
});

test("workspace_name_truncation_collision: truncados ao mesmo prefixo ⇒ distintos", () => {
  assert.notEqual(
    workspaceName(`/home/u/${"a".repeat(70)}-1`),
    workspaceName(`/home/u/${"a".repeat(70)}-2`),
  );
});

test("workspace_name_sanitize_collision: saneados ao mesmo nome ⇒ distintos", () => {
  assert.notEqual(
    workspaceName("/home/u/My Project!"),
    workspaceName("/home/u/my project?"),
  );
});

test("workspace_dir_priority: worktree vence directory e cwd", () => {
  assert.equal(
    resolveWorkspaceDir({ worktree: "/wt", directory: "/dir" }),
    "/wt",
  );
});

test("workspace_dir_fallback_directory: sem worktree usa directory", () => {
  assert.equal(resolveWorkspaceDir({ directory: "/dir" }), "/dir");
});

test("workspace_dir_ignores_root: '/' é descartado, cai no cwd", () => {
  assert.equal(resolveWorkspaceDir({ worktree: "/", directory: "/" }), process.cwd());
});

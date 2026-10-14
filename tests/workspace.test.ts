/**
 * E1-S1 — `workspace.ts`: resolução de diretório e nome lógico. Puro.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveWorkspaceDir, workspaceName } from "../src/workspace.ts";

test("workspace_name_valid: basename simples casa o charset da borda", () => {
  assert.equal(workspaceName("/home/u/waweb"), "waweb");
  const re = /^[a-z0-9][a-z0-9_-]{0,63}$/;
  assert.match(workspaceName("/home/u/waweb"), re);
});

test("workspace_name_sanitized: espaços e símbolos viram hífen", () => {
  assert.equal(workspaceName("/home/u/My Project!"), "my-project");
});

test("workspace_name_no_double_dash: '--' colapsa (borda proíbe)", () => {
  assert.equal(workspaceName("/home/u/a--b"), "a-b");
  assert.ok(!workspaceName("/home/u/a--b").includes("--"));
});

test("workspace_name_reserved: '_iam' usa fallback ws-<hash>", () => {
  const name = workspaceName("/home/u/_iam");
  assert.match(name, /^ws-[0-9a-f]{8}$/);
});

test("workspace_name_deterministic: mesmo dir ⇒ mesmo nome", () => {
  assert.equal(workspaceName("/home/u/proj"), workspaceName("/home/u/proj"));
});

test("workspace_name_truncated: basename longo trunca a 64", () => {
  const long = "a".repeat(100);
  const name = workspaceName(`/home/u/${long}`);
  assert.equal(name.length, 64);
  assert.ok(long.startsWith(name));
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

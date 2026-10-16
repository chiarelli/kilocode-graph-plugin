/**
 * E3a-S6a — `index/git.ts`: porta de git sobre um executor fake (sem spawn real).
 * Cobre a resolução do `--git-path hooks` relativo contra a raiz (§1) e a guarda
 * de ancestralidade (§4).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createGitPort, type GitExec, type GitResult } from "../src/index/git.ts";

/** Executor fake: casa por prefixo de args e devolve o resultado. */
function fakeExec(
  table: Array<{ match: string[]; result: Partial<GitResult> }>,
): GitExec {
  return (_root, args) => {
    for (const row of table) {
      if (row.match.every((m, i) => args[i] === m)) {
        return { status: 0, stdout: "", stderr: "", ...row.result };
      }
    }
    return { status: 1, stdout: "", stderr: "no match" };
  };
}

test("git_isRepo: --is-inside-work-tree true ⇒ true", () => {
  const git = createGitPort(
    fakeExec([{ match: ["rev-parse", "--is-inside-work-tree"], result: { stdout: "true\n" } }]),
  );
  assert.equal(git.isRepo("/r"), true);
});

test("git_isRepo_false: fora de repo ⇒ false", () => {
  const git = createGitPort(
    fakeExec([{ match: ["rev-parse", "--is-inside-work-tree"], result: { stdout: "false\n" } }]),
  );
  assert.equal(git.isRepo("/r"), false);
});

test("git_head: devolve o sha (trim); sem commit ⇒ null", () => {
  const git = createGitPort(
    fakeExec([{ match: ["rev-parse", "HEAD"], result: { stdout: "  deadbeef\n" } }]),
  );
  assert.equal(git.head("/r"), "deadbeef");
  const none = createGitPort(fakeExec([{ match: ["rev-parse", "HEAD"], result: { status: 128 } }]));
  assert.equal(none.head("/r"), null);
});

test("git_isAncestor: status 0 ⇒ true; status 1 ⇒ false", () => {
  const yes = createGitPort(
    fakeExec([{ match: ["merge-base", "--is-ancestor", "a", "HEAD"], result: { status: 0 } }]),
  );
  assert.equal(yes.isAncestor("/r", "a", "HEAD"), true);
  const no = createGitPort(
    fakeExec([{ match: ["merge-base", "--is-ancestor", "a", "HEAD"], result: { status: 1 } }]),
  );
  assert.equal(no.isAncestor("/r", "a", "HEAD"), false);
});

test("git_isAncestor_empty_ref: ref vazia ⇒ false, sem rodar git", () => {
  let ran = false;
  const git = createGitPort((_r, _a) => {
    ran = true;
    return { status: 0, stdout: "", stderr: "" };
  });
  assert.equal(git.isAncestor("/r", "", "HEAD"), false);
  assert.equal(ran, false);
});

test("git_deletedFiles: --no-renames --diff-filter=D devolve os caminhos", () => {
  // `--no-renames`: um rename vira `D`+`A` (a origem conta como removida).
  const git = createGitPort(
    fakeExec([
      {
        match: ["diff", "--name-only", "--no-renames", "--diff-filter=D", "a", "HEAD"],
        result: { stdout: "src/gone.rs\nsrc/old.rs\n" },
      },
    ]),
  );
  assert.deepEqual(git.deletedFiles("/r", "a", "HEAD"), [
    "src/gone.rs",
    "src/old.rs",
  ]);
});

test("git_hooksDir_relative: `--git-path hooks` relativo é resolvido contra a raiz", () => {
  // Fatos do ambiente: git 2.34.1 devolve caminho RELATIVO (ex.: `.husky`).
  const git = createGitPort(
    fakeExec([{ match: ["rev-parse", "--git-path", "hooks"], result: { stdout: ".husky\n" } }]),
  );
  assert.equal(git.hooksDir("/repo"), "/repo/.husky");
});

test("git_hooksDir_absolute: caminho absoluto é honrado como veio", () => {
  const git = createGitPort(
    fakeExec([
      { match: ["rev-parse", "--git-path", "hooks"], result: { stdout: "/abs/hooks\n" } },
    ]),
  );
  assert.equal(git.hooksDir("/repo"), "/abs/hooks");
});

test("git_hooksDir_none: sem repo ⇒ null", () => {
  const git = createGitPort(
    fakeExec([{ match: ["rev-parse", "--git-path", "hooks"], result: { status: 128 } }]),
  );
  assert.equal(git.hooksDir("/repo"), null);
});

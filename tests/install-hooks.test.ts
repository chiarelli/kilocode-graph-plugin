/**
 * E3a-S6a — `index/install-hooks.ts`: instalação idempotente dos hooks git, sem
 * `core.hooksPath`, sem sobrescrever hook do usuário. Sem git nem disco real
 * (GitPort + IO injetados).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { GitPort } from "../src/index/git.ts";
import {
  HOOK_MARKER,
  HOOK_NAMES,
  hookScript,
  installHooks,
  isOwnHook,
  shellQuote,
} from "../src/index/install-hooks.ts";

/** Git fake: repo em `/repo`, hooks em `/repo/.git/hooks`. */
function fakeGit(over: Partial<GitPort> = {}): GitPort {
  return {
    isRepo: () => true,
    head: () => "abc",
    isAncestor: () => true,
    deletedFiles: () => [],
    hooksDir: () => "/repo/.git/hooks",
    ...over,
  };
}

/** IO em memória: mapa path→conteúdo, sem tocar o disco. */
function memIo(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const chmods: Array<[string, number]> = [];
  return {
    files,
    chmods,
    io: {
      exists: (p: string) => files.has(p),
      readFile: (p: string) => files.get(p) ?? "",
      writeFile: (p: string, d: string) => void files.set(p, d),
      mkdir: () => {},
      chmod: (p: string, m: number) => void chmods.push([p, m]),
    },
  };
}

test("install_hooks_creates_when_absent: dir vazio ⇒ 4 scripts com marcador", () => {
  const mem = memIo();
  const res = installHooks({
    repoRoot: "/repo",
    cliPath: "/plugin/src/cli.ts",
    nodeBin: "/usr/bin/node",
    git: fakeGit(),
    io: mem.io,
  });
  assert.deepEqual(res.installed, [...HOOK_NAMES]);
  assert.equal(res.skippedForeign.length, 0);
  for (const name of HOOK_NAMES) {
    const content = mem.files.get(`/repo/.git/hooks/${name}`);
    assert.ok(content, `hook ${name} gravado`);
    assert.ok(isOwnHook(content!), `${name} tem a linha-marcadora`);
    assert.match(content!, /#!\/bin\/sh/);
  }
  // O caminho do node é ABSOLUTO e embutido (não confia no PATH do git).
  const postCommit = mem.files.get("/repo/.git/hooks/post-commit")!;
  assert.match(postCommit, /'\/usr\/bin\/node' '\/plugin\/src\/cli\.ts'/);
  // CRÍTICO: o `--workspace` é embutido (o CLI o exige; o argv do git não o traz).
  // Sem ele todo hook sairia com exit 2 e não sincronizaria nada.
  assert.match(postCommit, /--workspace '\/repo'/);
  assert.match(postCommit, /--mode auto --source post-commit/);
  // Destacado: o git NÃO espera a indexação.
  assert.match(postCommit, /&$/m);
  // Executável.
  assert.ok(mem.chmods.every(([, m]) => m === 0o755));
});

test("install_hooks_workspace_embedded: o --workspace casa o repoRoot do install", () => {
  const mem = memIo();
  installHooks({
    repoRoot: "/some/workspace",
    cliPath: "/plugin/src/cli.ts",
    git: fakeGit({ hooksDir: () => "/some/workspace/.git/hooks" }),
    io: mem.io,
  });
  assert.match(
    mem.files.get("/some/workspace/.git/hooks/post-merge")!,
    /--workspace '\/some\/workspace'/,
  );
});

test("install_hooks_regenerates_when_paths_change: hook próprio desatualizado ⇒ regenera", () => {
  const mem = memIo();
  const git = fakeGit();
  // 1º install com node/cli antigos.
  installHooks({ repoRoot: "/repo", cliPath: "/old/cli.ts", nodeBin: "/old/node", git, io: mem.io });
  const before = mem.files.get("/repo/.git/hooks/post-commit")!;
  assert.match(before, /'\/old\/node'/);
  // 2º install com caminhos novos: o hook PRÓPRIO é regenerado (senão apontaria
  // para caminho morto e falharia em silêncio).
  const res = installHooks({
    repoRoot: "/repo",
    cliPath: "/new/cli.ts",
    nodeBin: "/new/node",
    git,
    io: mem.io,
  });
  assert.deepEqual(res.installed, [...HOOK_NAMES]);
  assert.match(mem.files.get("/repo/.git/hooks/post-commit")!, /'\/new\/node'/);
});

test("shellQuote_escapes_single_quotes: caminho com aspa não quebra o script", () => {
  assert.equal(shellQuote("/a b/c"), "'/a b/c'");
  assert.equal(shellQuote("/it's/x"), "'/it'\\''s/x'");
});

test("install_hooks_noop_when_exists: hook do usuário ⇒ NÃO sobrescreve", () => {
  const userScript = "#!/bin/sh\necho user hook\n";
  const mem = memIo({ "/repo/.git/hooks/post-commit": userScript });
  const res = installHooks({
    repoRoot: "/repo",
    cliPath: "/plugin/src/cli.ts",
    git: fakeGit(),
    io: mem.io,
  });
  assert.deepEqual(res.skippedForeign, ["post-commit"]);
  assert.equal(mem.files.get("/repo/.git/hooks/post-commit"), userScript);
  // Os outros 3 são instalados.
  assert.equal(res.installed.length, 3);
  assert.ok(!res.installed.includes("post-commit"));
});

test("install_hooks_idempotent: roda 2× ⇒ segundo run não regrava os próprios", () => {
  const mem = memIo();
  const opts = {
    repoRoot: "/repo",
    cliPath: "/plugin/src/cli.ts",
    git: fakeGit(),
    io: mem.io,
  };
  const first = installHooks(opts);
  const before = mem.files.get("/repo/.git/hooks/post-commit");
  const second = installHooks(opts);
  assert.deepEqual(first.installed, [...HOOK_NAMES]);
  assert.deepEqual(second.installed, []);
  assert.deepEqual(second.skippedOwn, [...HOOK_NAMES]);
  // Conteúdo inalterado entre runs.
  assert.equal(mem.files.get("/repo/.git/hooks/post-commit"), before);
});

test("install_hooks_not_git: fora de repo ⇒ no-op", () => {
  const mem = memIo();
  const res = installHooks({
    repoRoot: "/tmp/x",
    cliPath: "/plugin/src/cli.ts",
    git: fakeGit({ isRepo: () => false }),
    io: mem.io,
  });
  assert.equal(res.notGit, true);
  assert.equal(res.installed.length, 0);
  assert.equal(mem.files.size, 0);
});

test("install_hooks_no_hooks_dir: sem diretório de hooks ⇒ no-op", () => {
  const mem = memIo();
  const res = installHooks({
    repoRoot: "/repo",
    cliPath: "/plugin/src/cli.ts",
    git: fakeGit({ hooksDir: () => null }),
    io: mem.io,
  });
  assert.equal(res.notGit, true);
  assert.equal(res.installed.length, 0);
});

test("hookScript_never_sets_hooksPath: o script não toca core.hooksPath", () => {
  const script = hookScript("/usr/bin/node", "/p/src/cli.ts", "/ws", "post-merge");
  assert.ok(!script.includes("hooksPath"), "não altera core.hooksPath");
  assert.ok(script.includes(HOOK_MARKER));
  assert.ok(script.includes("--workspace '/ws'"));
});

test("hookScript_runs_end_to_end: o script REAL invoca o CLI com --workspace", () => {
  // Prova a correção CRÍTICA no caminho REAL: gera o script e o EXECUTA com um
  // CLI stub que registra seus argumentos. Sem `--workspace` o CLI real sairia
  // com exit 2 e nada sincronizaria — este teste falha se o flag sumir de novo.
  const dir = mkdtempSync(join(tmpdir(), "graph-hook-e2e-"));
  try {
    const argsFile = join(dir, "args.txt");
    const stubCli = join(dir, "stub-cli.mjs");
    // Stub: grava process.argv num arquivo e sai 0. Roda em replaced/background,
    // então o hook retorna antes; damos um instante e lemos.
    writeFileSync(
      stubCli,
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(argsFile)}, process.argv.slice(2).join(" "));\n`,
    );
    const script = hookScript(process.execPath, stubCli, "/the/ws", "post-commit");
    const scriptPath = join(dir, "post-commit");
    writeFileSync(scriptPath, script, { mode: 0o755 });

    execFileSync("/bin/sh", [scriptPath], { stdio: "ignore" });
    // O processo é destacado (`&` + disown): espera o arquivo aparecer.
    const deadline = Date.now() + 5000;
    while (!existsSync(argsFile) && Date.now() < deadline) {
      execFileSync(process.execPath, ["-e", "setTimeout(()=>{},30)"]);
    }
    const got = readFileSync(argsFile, "utf-8");
    assert.match(got, /--workspace \/the\/ws/);
    assert.match(got, /--mode auto/);
    assert.match(got, /--source post-commit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

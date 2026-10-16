/**
 * E3a-S6d — E2E de FECHAMENTO do delta em runtime (gated `E2E=1`).
 *
 * Prova o critério de aceite da epic contra a stack REAL, sem mock de infra:
 *   1. materializa um repo git de verdade;
 *   2. `installHooks` instala os hooks (§1) e o CLI é o **único escritor**;
 *   3. um `git commit` REAL dispara o hook → CLI (`--mode auto`) → incremental
 *      → `/v1/code/sync`;
 *   4. **confere o EFEITO do outro lado**: o grafo contém o delta (o símbolo novo
 *      é buscável) — o retorno da chamada não é a evidência;
 *   5. `git rm` + commit → o arquivo deletado SAI do grafo (`chunks: []`).
 *
 * Pré-requisitos (gated): `E2E=1`; memtier vivo; binário do indexer buildado;
 * bearer de código (`E2E_CODE_TOKEN`). Sem o token, a suíte skippa.
 *
 * O hook é destacado (`&` + disown): o teste aguarda por POLLING do efeito no
 * grafo (não um `await` do processo), respeitando o fire-and-forget.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MemtierClient } from "../../src/client.ts";
import { cliPath } from "../../src/cli-spawn.ts";
import { createGitPort } from "../../src/index/git.ts";
import { installHooks } from "../../src/index/install-hooks.ts";

const E2E = process.env.E2E === "1";
const MEMTIER_URL = process.env.KILOCODE_GRAPH_URL ?? "http://127.0.0.1:8400";
const INDEXER =
  process.env.E2E_INDEXER ??
  "/home/hermes/Projetos/rust-ast-indexer/rust_indexer/target/release/rust_indexer";
// Token DEDICADO: o bearer é escopado ao NOME EXATO do workspace, então o token
// de código (`e2e-tok-b`, escopo `beta`) daria 401 neste workspace — a suíte usa
// um token próprio (default `e2e-delta-tok`, escopo `delta-e2e`).
const TOKEN = process.env.E2E_DELTA_TOKEN ?? "e2e-delta-tok";
// Workspace PRÓPRIO desta suíte (não colide com `alfa`/`beta` dos outros E2E).
const WS = process.env.E2E_DELTA_WS ?? "delta-e2e";
const PROGRAM = process.env.E2E_PROGRAM ?? "default";
// Sem `E2E=1` a suíte skippa (não fabrica credencial fora do modo E2E); dentro
// do modo E2E o token dedicado tem default (o `MEMTIER_API_TOKENS` do stack o
// define). `E2E_DELTA_TOKEN` sobrescreve quando o stack usa outro escopo.

/** Cria um repo git com config de usuário local (sem tocar o global). */
function initRepo(dir: string): void {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "e2e@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "e2e"]);
}

function commitAll(dir: string, msg: string): void {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", msg]);
}

/** Aguarda `cond` virar `true` (polling), ou falha no timeout. */
async function waitFor(
  cond: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`timeout aguardando: ${label} (${timeoutMs}ms)`);
}

/** `true` quando algum chunk do workspace contém `needle`. */
async function graphHas(
  client: MemtierClient,
  needle: string,
): Promise<boolean> {
  const r = await client.request<{ chunks?: Array<{ code?: string; path?: string }> }>(
    "POST",
    "/v1/code/search",
    { workspace: WS, program: PROGRAM, query: needle, limit: 10 },
  );
  return (r.chunks ?? []).some((c) => `${c.code ?? ""}${c.path ?? ""}`.includes(needle));
}

test("e2e: post-commit atualiza o grafo; delete sai com chunks: []", {
  skip: !E2E || !TOKEN,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "graph-delta-e2e-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  initRepo(repo);

  const client = new MemtierClient({
    url: MEMTIER_URL,
    workspace: WS,
    program: PROGRAM,
    token: TOKEN,
  });

  const S1 = "SIXA_PROBE_SYMBOL";
  const S2 = "SIXB_DELETED_SYMBOL";
  const fileA = join(repo, "src", "a.rs");
  const fileB = join(repo, "src", "b.rs");

  try {
    // Estado inicial: dois arquivos commitados.
    writeFileSync(fileA, `pub fn ${S1}() -> u32 {\n    1\n}\n`);
    writeFileSync(fileB, `pub fn ${S2}() -> u32 {\n    2\n}\n`);
    commitAll(repo, "init");

    // Config persistida do workspace (§7): o CLI resolve a MESMA config do boot.
    mkdirSync(join(repo, ".kilo"), { recursive: true });
    writeFileSync(
      join(repo, ".kilo", "graph-config.json"),
      JSON.stringify({
        daemon: { url: MEMTIER_URL, program: PROGRAM, workspace: WS },
        code_index: { enabled: true, indexer_bin: INDEXER, load_ignores: true },
      }),
    );
    // Chave do workspace: o CLI a usa como token (o mesmo bearer do teste).
    writeFileSync(
      join(repo, ".kilo", "graph-key.json"),
      JSON.stringify({ token: TOKEN, workspace: WS, program: PROGRAM }),
      { mode: 0o600 },
    );

    // Instala os hooks REAIS (§1) apontando para o CLI deste plugin.
    const install = installHooks({
      repoRoot: repo,
      cliPath: cliPath(),
      git: createGitPort(),
    });
    assert.deepEqual(
      install.installed.sort(),
      ["post-checkout", "post-commit", "post-merge", "post-rewrite"],
      "os 4 hooks devem ser instalados",
    );

    // --- FULL inicial: sem `graph-ready`, o CLI decide FULL e o cria ---------
    // (o primeiro `git commit` já existia antes dos hooks; forçamos o full
    // rodando o CLI uma vez em `auto`, como o boot faria.)
    execFileSync(process.execPath, [cliPath(), "--workspace", repo, "--mode", "auto", "--source", "boot"], {
      stdio: "ignore",
    });
    await waitFor(() => graphHas(client, S1), 120_000, "full inicial: S1 no grafo");
    assert.ok(
      await graphHas(client, S2),
      "o full inicial deve indexar os dois arquivos",
    );

    // --- DELTA: novo commit dispara o hook → CLI incremental -----------------
    const S3 = "SIXC_DELTA_SYMBOL";
    writeFileSync(
      fileA,
      `pub fn ${S1}() -> u32 {\n    1\n}\n\npub fn ${S3}() -> u32 {\n    3\n}\n`,
    );
    commitAll(repo, "add delta symbol");

    // EFEITO do outro lado: o símbolo do delta entra no grafo sem reiniciar.
    await waitFor(
      () => graphHas(client, S3),
      120_000,
      "delta pós-commit: S3 no grafo",
    );

    // --- DELEÇÃO: git rm + commit ⇒ o arquivo sai (chunks: []) ---------------
    execFileSync("git", ["-C", repo, "rm", "-q", "src/b.rs"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "remove b"]);
    await waitFor(
      async () => !(await graphHas(client, S2)),
      120_000,
      "deleção: S2 sai do grafo",
    );
  } finally {
    // Limpa o workspace do teste (best-effort) e o repo.
    try {
      await client.syncCode(
        ["src/a.rs", "src/b.rs"].map((p) => ({
          file_path: p,
          language: "rust",
          chunks: [],
        })),
      );
    } catch {
      // best-effort.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

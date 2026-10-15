/**
 * E3c-S3 — E2E de FECHAMENTO da injeção de código (gated `E2E=1`).
 *
 * Cadeia COMPLETA contra a stack real, sem mock de infra:
 *   binário rust_indexer → eventos JSONL → buildSyncBody → POST /v1/code/sync →
 *   boot do plugin com `inject.code_enabled=true` → `messages.transform` →
 *   POST /v1/code/search (o símbolo novo é achado) → bloco `<context
 *   graph-code="true">` injetado no último turno, com o caminho REAL.
 *
 * Diferente do E2E de memória (E2), este prova o push de CÓDIGO: o grafo
 * populado pela E3a é buscado e vira um part no turno.
 *
 * Pré-requisitos (gated): `E2E=1`; memtier vivo; binário buildado; bearer do
 * workspace de código (`E2E_CODE_TOKEN`/`E2E_CODE_WS`).
 *
 * ⚠️ **Não passa por acidente:** quando `E2E=1`, a ausência de
 * `E2E_CODE_TOKEN` é **falha**, não skip (exigência da spec §E3c-S3). Fora do
 * modo E2E (sem `E2E=1`), a suíte skippa normalmente.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MemtierClient } from "../../src/client.ts";
import { buildSyncBody } from "../../src/index/collector.ts";
import { runIndexer } from "../../src/index/runner.ts";
import pluginModule from "../../src/index.ts";
import { workspaceName } from "../../src/workspace.ts";

const E2E = process.env.E2E === "1";
const MEMTIER_URL = process.env.KILOCODE_GRAPH_URL ?? "http://127.0.0.1:8400";
const INDEXER = process.env.E2E_INDEXER ??
  "/home/hermes/Projetos/rust-ast-indexer/rust_indexer/target/release/rust_indexer";
/** Bearer do workspace de CÓDIGO (o MESMO do E3a). Nunca hardcoded. */
const TOKEN = process.env.E2E_CODE_TOKEN ?? "";
const WS = process.env.E2E_CODE_WS ?? "beta";
const PROGRAM = process.env.E2E_PROGRAM ?? "default";
const REPO = process.env.E2E_E3C_REPO ?? "/tmp/e3c_inject_repo";

/** Símbolo de nome ÚNICO — a busca por ele só acha se o sync gravou. */
const SYMBOL = "funcao_e3c_marcador_unico";
const PROBE = `pub fn ${SYMBOL}(entrada: &str) -> usize {
    entrada.len()
}

pub fn outra_funcao_qualquer() {}
`;

function materialize(): void {
  rmSync(REPO, { recursive: true, force: true });
  mkdirSync(`${REPO}/src`, { recursive: true });
  writeFileSync(`${REPO}/src/e3c_probe.rs`, PROBE);
}

/** Monta um workspace real: dir cujo basename resolve para `WS` + token_file. */
function makeWorkspace(): { dir: string; tokenFile: string } {
  const base = mkdtempSync(join(tmpdir(), "graph-e3c-e2e-"));
  const dir = join(base, WS);
  const kiloDir = join(dir, ".kilo");
  mkdirSync(kiloDir, { recursive: true });
  const tokenFile = join(kiloDir, "graph-key.json");
  writeFileSync(
    tokenFile,
    JSON.stringify({ token: TOKEN, workspace: WS, program: PROGRAM }),
  );
  return { dir, tokenFile };
}

test("e2e: código indexado ⇒ bloco graph-code no turno com o caminho real", {
  // Fora do modo E2E: skip normal. Em E2E=1 sem token: NÃO skip (falha abaixo).
  skip: !E2E,
}, async () => {
  // Exigência da spec: sem o token do workspace de código, o E2E FALHA (nunca
  // passa por acidente com um skip silencioso).
  assert.ok(
    TOKEN,
    "E2E_CODE_TOKEN ausente: o E2E da E3c exige o bearer do workspace de código",
  );

  materialize();
  const client = new MemtierClient({
    url: MEMTIER_URL,
    workspace: WS,
    program: PROGRAM,
    token: TOKEN,
  });

  // Limpa estado anterior do probe (best-effort) e indexa.
  await client.syncCode([
    { file_path: "src/e3c_probe.rs", language: "rust", chunks: [] },
  ]);
  const run = await runIndexer({ bin: INDEXER, repoRoot: REPO, mode: "full" });
  assert.equal(run.skipped, false, "o indexer deve rodar");
  const body = buildSyncBody(
    run.events,
    { workspace: WS, program: PROGRAM },
    { repoRoot: REPO },
  );
  const sync = await client.syncCode(body.files, body.edges);
  assert.ok(
    sync.upserted >= 1,
    `o sync deve gravar o probe (upserted=${sync.upserted})`,
  );

  // 1) EFEITO DO OUTRO LADO: o símbolo novo é buscável no grafo.
  const search = await client.searchCode(SYMBOL, { limit: 5 });
  const hit = search.chunks.find((c) => c.path.includes("e3c_probe.rs"));
  assert.ok(
    hit,
    `o símbolo ${SYMBOL} deve ser achado; hits=${search.chunks.map((c) => c.path).join(",")}`,
  );
  assert.ok(hit.code.includes(SYMBOL), "o chunk devolvido deve conter o símbolo");

  // 2) O PLUGIN injeta o bloco de código no turno (boot real + transform real).
  const { dir, tokenFile } = makeWorkspace();
  try {
    assert.equal(workspaceName(dir), WS, `basename deve resolver para ${WS}`);
    const hooks = await pluginModule.server(
      { directory: dir, worktree: null },
      {
        daemon: {
          url: MEMTIER_URL,
          token_file: tokenFile,
          program: PROGRAM,
          health_timeout_ms: 3000,
        },
        inject: {
          enabled: false, // só código: prova o push de código isolado
          code_enabled: true,
          max_code_chunks: 3,
          max_chars: 3000,
          max_tokens: 2000,
          timeout_ms: 4000,
        },
        debug: true,
      },
    );
    const transform = hooks["experimental.chat.messages.transform"];
    assert.ok(transform, "o hook messages.transform deve estar registrado");

    const messages = [
      { info: { role: "user", id: "turno-e3c" }, parts: [{ type: "text", text: SYMBOL }] },
    ];
    const start = Date.now();
    await transform({}, { messages });
    const elapsed = Date.now() - start;
    await hooks.dispose?.();

    const parts = messages[0]?.parts ?? [];
    assert.equal(parts.length, 2, "um part de código deve ser injetado");
    const injected = String(parts[1]?.text ?? "");
    assert.match(
      injected,
      /<context graph-code="true">/,
      `bloco de código ausente; injetado: ${injected.slice(0, 200)}`,
    );
    assert.match(injected, /\[CÓDIGO RELEVANTE — src\/e3c_probe\.rs:/);
    assert.match(injected, new RegExp(SYMBOL));
    // Sem memória injetada (inject.enabled=false) — só o bloco de código.
    assert.doesNotMatch(injected, /graph-memory="true"/);
    // Orçamento do hook (NFR-01) preservado.
    assert.ok(elapsed <= 4000, `injeção estourou o orçamento: ${elapsed}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    // Limpa o probe do grafo e o repo temporário.
    await client.syncCode([
      { file_path: "src/e3c_probe.rs", language: "rust", chunks: [] },
    ]);
    rmSync(REPO, { recursive: true, force: true });
  }
});

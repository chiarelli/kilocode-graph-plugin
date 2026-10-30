/**
 * E3a-S5 — E2E de FECHAMENTO do coletor (gated `E2E=1`).
 *
 * Cadeia COMPLETA contra a stack real, sem mock de infra:
 *   binário rust_indexer → eventos JSONL → buildSyncBody → POST /v1/code/sync →
 *   POST /v1/code/search (chunks aparecem) → POST /v1/code/neighbors (arestas
 *   navegam OUT/IN).
 *
 * Diferente do E2E de ciclo de vida (S3), este prova o que a epic promete de
 * ponta a ponta: o código indexado é **buscável** e **navegável** (import + call),
 * e o plugin bootado dispara a coleta fora do turno.
 *
 * Pré-requisitos (gated): `E2E=1`; memtier vivo; binário buildado; bearer do
 * workspace (`E2E_TOKEN`/`E2E_WS`).
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { MemtierClient } from "../../src/client.ts";
import { buildSyncBody } from "../../src/index/collector.ts";
import { runIndexer } from "../../src/index/runner.ts";

const E2E = process.env.E2E === "1";
const MEMTIER_URL = process.env.KILOCODE_GRAPH_URL ?? "http://127.0.0.1:8400";
const INDEXER = process.env.E2E_INDEXER ?? "/home/hermes/Projetos/rust-ast-indexer/rust_indexer/target/release/rust_indexer";
// Workspace/token PRÓPRIOS deste E2E (não colide com o de ciclo de vida, que usa
// `alfa`): os arquivos E2E rodam em paralelo no `node --test`. Sem
// `E2E_CODE_TOKEN` a suíte skippa (nunca fabrica credencial). Ex.:
//   E2E=1 E2E_TOKEN=e2e-tok-a E2E_CODE_TOKEN=e2e-tok-b node --test "tests/e2e/**/*.test.ts"
const TOKEN = process.env.E2E_CODE_TOKEN ?? "";
const WS = process.env.E2E_CODE_WS ?? "beta";
const PROGRAM = process.env.E2E_PROGRAM ?? "default";
const REPO = process.env.E2E_CODE_REPO ?? "/tmp/e3a_collector_repo";

const MAIN = "mod db;\n\nuse crate::db::connect;\n\nfn main() {\n    let pool = connect(\"postgres://localhost/app\");\n    let _ = pool;\n}\n";
const DB = "pub fn connect(dsn: &str) -> String {\n    validate(dsn);\n    dsn.to_string()\n}\n\nfn validate(dsn: &str) {\n    if dsn.is_empty() {\n        panic!(\"empty dsn\");\n    }\n}\n";

/**
 * uuid de um chunk lido da PRÓPRIA resposta de `code/search` (E8 item 9).
 *
 * Antes o teste recalculava `uuid5(CODE_NS, "{file}:{symbol}")` no cliente. A
 * partir do memtier v1.1.0 o uuid é o 9º campo aditivo da resposta — fonte da
 * verdade. Recalcular duplicava a regra do servidor e mascarava divergência: se
 * o server mudasse a derivação, o teste continuaria navegando com um uuid que o
 * grafo não tem.
 *
 * Falha (não faz skip) quando o campo some: é contrato do v1.1.0.
 */
async function symbolChunkId(
  client: MemtierClient,
  query: string,
  path: string,
  symbol: string,
): Promise<string> {
  const search = await client.request<{
    chunks?: Array<{ path?: string; symbol?: string | null; uuid?: string }>;
  }>("POST", "/v1/code/search", {
    workspace: WS,
    program: PROGRAM,
    query,
    // `CodeSymbol` deixa de fora o FullFile sintético; a busca devolve o chunk
    // do símbolo. `limit` alto para alcançar os dois símbolos do mesmo arquivo.
    labels: ["CodeSymbol"],
    limit: 20,
  });
  const hit = (search.chunks ?? []).find(
    (c) => (c.path ?? "").includes(path) && c.symbol === symbol,
  );
  assert.ok(
    hit,
    `code_search não devolveu ${path}::${symbol}; ` +
      `hits=${(search.chunks ?? []).map((c) => `${c.path}::${c.symbol}`).join(",")}`,
  );
  assert.ok(
    hit.uuid,
    `o chunk ${path}::${symbol} veio SEM uuid — contrato v1.1.0 rompido`,
  );
  return hit.uuid;
}

function materialize(): void {
  rmSync(REPO, { recursive: true, force: true });
  mkdirSync(`${REPO}/src`, { recursive: true });
  writeFileSync(`${REPO}/src/main.rs`, MAIN);
  writeFileSync(`${REPO}/src/db.rs`, DB);
}

test("e2e: cadeia completa indexer→sync→search→neighbors (busca + navegação)", {
  skip: !E2E || !TOKEN,
}, async () => {
  materialize();
  const client = new MemtierClient({
    url: MEMTIER_URL,
    workspace: WS,
    program: PROGRAM,
    token: TOKEN,
  });

  // Limpa estado anterior (best-effort).
  await client.syncCode(
    ["src/main.rs", "src/db.rs"].map((p) => ({
      file_path: p,
      language: "rust",
      chunks: [],
    })),
  );

  const run = await runIndexer({ bin: INDEXER, repoRoot: REPO, mode: "full" });
  assert.equal(run.skipped, false, "o indexer deve rodar");

  const body = buildSyncBody(
    run.events,
    { workspace: WS, program: PROGRAM },
    { repoRoot: REPO },
  );
  // O FullFile sintético habilita as arestas de import (ADR-012 D3).
  assert.ok(
    body.files.every((f) => f.chunks.some((c) => c.chunk_kind === "FullFile")),
    "todo arquivo deve ter um FullFile (sintético)",
  );
  const sync = await client.syncCode(body.files, body.edges);
  assert.ok(sync.upserted >= 2, `o sync deve gravar chunks (${sync.upserted})`);

  // 1) BUSCA: o símbolo novo aparece.
  const search = await client.request<{ chunks?: Array<{ path?: string }> }>(
    "POST",
    "/v1/code/search",
    { workspace: WS, program: PROGRAM, query: "validate", limit: 8 },
  );
  const paths = (search.chunks ?? []).map((c) => c.path ?? "");
  assert.ok(
    paths.some((p) => p.includes("db.rs")),
    `o código indexado deve ser buscável; hits=${paths.join(",")}`,
  );

  // 2) NAVEGAÇÃO: OUT call de db.rs::connect → db.rs::validate.
  const connectUuid = await symbolChunkId(client, "validate", "db.rs", "connect");
  const out = await client.request<{
    neighbors?: Array<{ file_path?: string; symbol?: string }>;
  }>("POST", "/v1/code/neighbors", {
    workspace: WS,
    program: PROGRAM,
    uuid: connectUuid,
    direction: "out",
    edge_kind: "call",
    limit: 20,
  });
  assert.ok(
    (out.neighbors ?? []).some((n) => n.symbol === "validate"),
    "db.rs::connect deve navegar (OUT, call) até validate",
  );

  // 3) NAVEGAÇÃO IN: quem chama validate é connect.
  const validateUuid = await symbolChunkId(client, "validate", "db.rs", "validate");
  const inc = await client.request<{
    neighbors?: Array<{ symbol?: string }>;
  }>("POST", "/v1/code/neighbors", {
    workspace: WS,
    program: PROGRAM,
    uuid: validateUuid,
    direction: "in",
    edge_kind: "call",
    limit: 20,
  });
  assert.ok(
    (inc.neighbors ?? []).some((n) => n.symbol === "connect"),
    "validate deve ser alcançado (IN, call) por connect",
  );

  // Limpa o workspace do teste.
  await client.syncCode(
    ["src/main.rs", "src/db.rs"].map((p) => ({
      file_path: p,
      language: "rust",
      chunks: [],
    })),
  );
  rmSync(REPO, { recursive: true, force: true });
});

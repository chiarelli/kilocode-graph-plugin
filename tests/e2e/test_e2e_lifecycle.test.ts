/**
 * E3a-S3 — E2E do ciclo de vida do coletor (gated `E2E=1`).
 *
 * Adapta `~/spikes/010-navegabilidade-codigo/probe_e2e_lifecycle.py` para a
 * cadeia REAL do plugin: spawn do binário do `rust-ast-indexer` → eventos JSONL
 * → `buildSyncBody` → `POST /v1/code/sync` contra o memtier vivo. Sem mock de
 * infra (`globalThis.fetch`).
 *
 * Fases (o mesmo repo de fixture do probe, isolado em /tmp):
 *   F1 cresce (1→3 símbolos): `deleted=0`
 *   F2 encolhe (3→1): `deleted>=2`
 *   F3 deleta o arquivo (`chunks: []`): `deleted>=1`, 0 chunks no grafo
 *   F4 reenvio idêntico: `upserted=0, deleted=0`
 *
 * Pré-requisitos (gated): `E2E=1`; memtier de pé em `127.0.0.1:8400`; binário
 * buildado; bearer do workspace via `E2E_TOKEN`/`E2E_WS`.
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
const TOKEN = process.env.E2E_TOKEN ?? "";
const WS = process.env.E2E_CODE_WS ?? "alfa";
const REPO = process.env.E2E_CODE_REPO ?? "/tmp/e3a_lifecycle_repo";

const MAIN = "mod db;\nmod metrics;\n\nuse crate::db::connect;\n\nfn main() {\n    let pool = connect(\"postgres://localhost/app\");\n    metrics::inc(\"main.start\");\n    let _ = pool;\n}\n";
const DB = "pub fn connect(dsn: &str) -> String {\n    validate(dsn);\n    dsn.to_string()\n}\n\nfn validate(dsn: &str) {\n    if dsn.is_empty() {\n        panic!(\"empty dsn\");\n    }\n}\n";
const METRICS = "pub fn inc(name: &str) {\n    let _ = name;\n}\n";
const METRICS_GROW = `${METRICS}\npub fn decrementar_contador(name: &str) {\n    let _ = name;\n}\n\npub fn zerar_todas_metricas() {}\n`;

function materialize(): void {
  rmSync(REPO, { recursive: true, force: true });
  mkdirSync(`${REPO}/src`, { recursive: true });
  writeFileSync(`${REPO}/src/main.rs`, MAIN);
  writeFileSync(`${REPO}/src/db.rs`, DB);
  writeFileSync(`${REPO}/src/metrics.rs`, METRICS);
}

async function indexAndSync(
  client: MemtierClient,
  removed: string[] = [],
) {
  const run = await runIndexer({ bin: INDEXER, repoRoot: REPO, mode: "full" });
  assert.equal(run.skipped, false, "o indexer deve rodar");
  const body = buildSyncBody(
    run.events,
    { workspace: WS, program: process.env.E2E_PROGRAM ?? "default" },
    { repoRoot: REPO, removed },
  );
  return client.syncCode(body.files, body.edges);
}

test("e2e: ciclo de vida do coletor (cresce/encolhe/deleta/idempotência)", {
  skip: !E2E || !TOKEN,
}, async () => {
  materialize();
  const client = new MemtierClient({
    url: MEMTIER_URL,
    workspace: WS,
    program: process.env.E2E_PROGRAM ?? "default",
    token: TOKEN,
  });

  // Limpa o estado anterior do repo no grafo (best-effort).
  await client.syncCode(
    ["src/main.rs", "src/db.rs", "src/metrics.rs"].map((p) => ({
      file_path: p,
      language: "rust",
      chunks: [],
    })),
  );

  // F1 — ingestão inicial
  const f1 = await indexAndSync(client);
  assert.ok(f1.upserted >= 3, `ingestão inicial deve gravar chunks (${f1.upserted})`);

  // F2 — CRESCE metrics.rs
  writeFileSync(`${REPO}/src/metrics.rs`, METRICS_GROW);
  const f2 = await indexAndSync(client);
  assert.equal(f2.deleted, 0, "crescer não deve deletar");

  // F3 — ENCOLHE metrics.rs (1 símbolo)
  writeFileSync(`${REPO}/src/metrics.rs`, METRICS);
  const f3 = await indexAndSync(client);
  assert.ok(f3.deleted >= 2, `encolher deve deletar órfãos (deleted=${f3.deleted})`);

  // F4 — DELETA o arquivo: some do disco E o coletor manda `chunks: []`
  // (o servidor não auto-deleta arquivo ausente — spike 010/A1).
  rmSync(`${REPO}/src/metrics.rs`, { force: true });
  const del = await client.syncCode([
    { file_path: "src/metrics.rs", language: "rust", chunks: [] },
  ]);
  assert.ok(del.deleted >= 1, "deletar o arquivo deve remover seus chunks");

  // F5 — reenvio idêntico (metrics.rs já não está no disco ⇒ não volta no body)
  const f5 = await indexAndSync(client);
  assert.equal(f5.upserted, 0, "reenvio idêntico não reescreve");
  assert.equal(f5.deleted, 0, "reenvio idêntico não deleta");

  // Frescor: o arquivo deletado não volta na busca (0 chunks no grafo).
  const search = await client.request<{ chunks?: Array<{ path?: string }> }>(
    "POST",
    "/v1/code/search",
    { workspace: WS, program: process.env.E2E_PROGRAM ?? "default", query: "metrics", limit: 8 },
  );
  const hits = (search.chunks ?? []).map((c) => c.path ?? "");
  assert.ok(
    !hits.some((p) => p.includes("metrics")),
    `o arquivo deletado não deve voltar na busca: ${hits.join(",")}`,
  );

  rmSync(REPO, { recursive: true, force: true });
});

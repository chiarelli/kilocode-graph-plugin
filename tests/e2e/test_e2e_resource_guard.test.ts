/**
 * E2E (gated `E2E=1`) das GUARDAS DE RECURSO — o que esta entrega adiciona:
 *
 *   1. `options.backpressure` chega ao indexer e ele freia de fato (com
 *      `max_queue_size` pequeno, o binário pausa e o runner responde `ack` com
 *      a contagem real, em vez do antigo `count:500` fixo);
 *   2. `onEvent`/spool: o job inteiro NÃO volta em RAM e o sync em lotes grava
 *      todos os arquivos no memtier real.
 *
 * A política de CPU (nice + SIGSTOP em 85%) é verificada unitariamente em
 * `tests/cpu-guard.test.ts`: sinalizar processos numa CI compartilhada flakaria.
 *
 * Pré-requisitos: `E2E=1`, memtier vivo, binário buildado, `E2E_CODE_TOKEN`.
 * Sem token a suíte skippa (nunca fabrica credencial).
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { MemtierClient } from "../../src/client.ts";
import { EventSpool } from "../../src/index/spool.ts";
import { runIndexer } from "../../src/index/runner.ts";
import { syncSpool } from "../../src/index/sync-spool.ts";

const E2E = process.env.E2E === "1";
const MEMTIER_URL = process.env.KILOCODE_GRAPH_URL ?? "http://127.0.0.1:8400";
const INDEXER =
  process.env.E2E_INDEXER ??
  "/home/hermes/Projetos/rust-ast-indexer/rust_indexer/target/release/rust_indexer";
const TOKEN = process.env.E2E_CODE_TOKEN ?? "";
const WS = process.env.E2E_CODE_WS ?? "beta";
const PROGRAM = process.env.E2E_PROGRAM ?? "default";
const REPO = process.env.E2E_RESOURCE_REPO ?? "/tmp/e3a_resource_guard_repo";

const FILE_COUNT = 120;

/** Materializa um repo com `FILE_COUNT` arquivos Rust independentes. */
function materialize(): void {
  rmSync(REPO, { recursive: true, force: true });
  mkdirSync(`${REPO}/src`, { recursive: true });
  for (let i = 0; i < FILE_COUNT; i++) {
    writeFileSync(
      `${REPO}/src/f${i}.rs`,
      `pub fn s${i}(x: u32) -> u32 {\n    x + ${i}\n}\n\nfn helper${i}() -> u32 {\n    s${i}(1)\n}\n`,
    );
  }
}

test("e2e: backpressure ligado, streaming em spool e sync em lotes", {
  skip: !E2E || !TOKEN,
}, async () => {
  materialize();
  const client = new MemtierClient({
    url: MEMTIER_URL,
    workspace: WS,
    program: PROGRAM,
    token: TOKEN,
  });
  const spool = EventSpool.create();
  try {
    const run = await runIndexer({
      bin: INDEXER,
      repoRoot: REPO,
      mode: "full",
      // Fila pequena: o binário DEVE pausar e o runner responder `ack` com a
      // contagem real. `pause_timeout_secs` curto evita travar o teste se o ack
      // parar de funcionar.
      backpressure: {
        max_queue_size: 10,
        threshold_percent: 80,
        ack_required: false,
        pause_timeout_secs: 5,
      },
      // Guarda desligada no E2E: SIGSTOP numa CI compartilhada flakaria.
      cpuGuard: false,
      onEvent: (ev) => spool.write(ev),
    });
    spool.close();

    assert.equal(run.skipped, false, "o indexer deve rodar");
    assert.equal(run.error, undefined, "sem erro de job");
    assert.deepEqual(run.events, [], "streaming: o runner não retém os eventos");
    assert.ok(
      (run.eventCount ?? 0) >= FILE_COUNT,
      `deve haver ao menos 1 evento por arquivo (${run.eventCount})`,
    );

    const before = Date.now();
    const sent = await syncSpool(spool, client, { workspace: WS, program: PROGRAM }, {
      repoRoot: REPO,
      batchSize: 50,
    });
    assert.ok(sent.files >= FILE_COUNT, `todos os arquivos devem ser enviados (${sent.files})`);
    assert.ok(sent.sync.upserted > 0, "o sync deve gravar chunks");
    // Sanidade de custo: 120 arquivos pequenos em lotes de 50 não devem levar
    // minutos (o backpressure mal calibrado travaria até o pause_timeout).
    assert.ok(
      Date.now() - before < 120_000,
      `sync em lotes demorou ${Date.now() - before}ms`,
    );

    // Um arquivo do fim do corpus é buscável — prova que os lotes gravados
    // cobrem o range inteiro (nenhum lote perdido).
    const search = await client.request<{ chunks?: Array<{ path?: string }> }>(
      "POST",
      "/v1/code/search",
      { workspace: WS, program: PROGRAM, query: `helper${FILE_COUNT - 1}`, limit: 5 },
    );
    const paths = (search.chunks ?? []).map((c) => c.path ?? "");
    assert.ok(
      paths.some((p) => p.includes(`f${FILE_COUNT - 1}.rs`)),
      `o último arquivo deve estar buscável; hits=${paths.join(",")}`,
    );
  } finally {
    spool.dispose();
    // Limpa o workspace de teste (best-effort).
    await client
      .syncCode(
        Array.from({ length: FILE_COUNT }, (_, i) => ({
          file_path: `src/f${i}.rs`,
          language: "rust",
          chunks: [],
        })),
      )
      .catch(() => undefined);
    rmSync(REPO, { recursive: true, force: true });
  }
});

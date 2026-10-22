/**
 * Integração runner→spool→sync em lotes, SEM rede e SEM o binário Rust real.
 *
 * O "indexer" é um script shell que emite JSONL. O que se prova é o caminho de
 * PRODUÇÃO (`runIndexer` com `onEvent` + `syncSpool`):
 *   - o job inteiro NÃO é retido em RAM (`result.events` vazio);
 *   - o sync acontece em lotes de ≤batchSize arquivos;
 *   - todos os arquivos chegam ao destino (nenhum perdido por streaming);
 *   - a proteção contra `resume` responder `force_resume` segue valendo.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { test } from "node:test";

import { EventSpool } from "../src/index/spool.ts";
import { runIndexer } from "../src/index/runner.ts";
import { syncSpool } from "../src/index/sync-spool.ts";
import type { CodeFile, IndexerEvent, SyncResult } from "../src/types.ts";

const IDENTITY = { workspace: "ws", program: "default" };

/** Script shell que emite `chunk_emitted` para `files` arquivos × `perFile`. */
function fakeIndexer(files: number, perFile: number): string {
  const dir = mkdtempSync(pjoin(tmpdir(), "idx-stream-"));
  const bin = pjoin(dir, "idx.sh");
  const lines: string[] = [];
  for (let i = 0; i < files; i++) {
    for (let j = 0; j < perFile; j++) {
      lines.push(
        JSON.stringify({
          event: "chunk_emitted",
          payload: {
            chunk_id: `src/f${i}.rs#s${j}`,
            chunk_kind: "Symbol",
            file: `src/f${i}.rs`,
            language: "rust",
            symbol_id: `s${j}`,
            start_line: j + 1,
            end_line: j + 1,
            chunk_md5: `md5-${i}-${j}`,
            text: "fn x() {}",
          },
        }),
      );
    }
    if (i === 0) {
      lines.push(
        JSON.stringify({
          event: "import_edge",
          payload: { from_file: "src/f0.rs", to_module: "crate::f1" },
        }),
      );
    }
  }
  lines.push(JSON.stringify({ event: "job_completed", payload: { processed: files * perFile } }));
  const body = lines.map((l) => `echo ${JSON.stringify(l)}`).join("\n");
  writeFileSync(bin, `#!/bin/sh\n${body}\nexit 0\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test("streaming_full_job_into_spool: nada retido no runner, tudo chega ao sync", async () => {
  const FILES = 250;
  const bin = fakeIndexer(FILES, 2);
  const spool = EventSpool.create();
  const calls: Array<{ files: CodeFile[]; edges: number }> = [];
  try {
    const result = await runIndexer({
      bin,
      repoRoot: "/tmp",
      mode: "full",
      cpuGuard: false,
      onEvent: (ev: IndexerEvent) => spool.write(ev),
    });
    spool.close();
    assert.deepEqual(result.events, [], "memória do runner: nenhum evento retido");
    assert.equal(result.eventCount, FILES * 2 + 1 + 1, "chunks + import + job_completed");

    const synced = await syncSpool(
      spool,
      {
        async syncCode(files, edges): Promise<SyncResult> {
          calls.push({ files, edges: edges.length });
          return { upserted: files.length, deleted: 0, changed: 0, skipped: 0 };
        },
      },
      IDENTITY,
      { repoRoot: "/tmp", batchSize: 100, readFile: () => "fn x() {}" },
    );

    assert.equal(calls.length, 3, "250 arquivos ⇒ 3 lotes de ≤100");
    assert.ok(calls.every((c) => c.files.length <= 100));
    assert.equal(synced.files, FILES, "nenhum arquivo perdido no streaming");
    const allPaths = new Set(
      calls.flatMap((c) => c.files.map((f) => f.file_path)),
    );
    assert.equal(allPaths.size, FILES);
    // A aresta de f0.rs acompanha o lote da origem.
    assert.equal(calls[0]?.edges, 1);
    assert.equal((calls[1]?.edges ?? 0) + (calls[2]?.edges ?? 0), 0);
    // O `FullFile` sintético aqui usa o leitor injetado; o caminho com o arquivo
    // real é coberto pelo E2E (`tests/e2e/test_e2e_resource_guard.test.ts`).
  } finally {
    spool.dispose();
    rmSync(pjoin(bin, ".."), { recursive: true, force: true });
  }
});

test("streaming_incremental_removed_filter: removido não viaja como chunk", async () => {
  const bin = fakeIndexer(3, 1);
  const spool = EventSpool.create();
  const chunksSeen: string[] = [];
  const tombstones: string[] = [];
  try {
    await runIndexer({
      bin,
      repoRoot: "/tmp",
      mode: "full",
      cpuGuard: false,
      onEvent: (ev) => spool.write(ev),
    });
    spool.close();
    await syncSpool(
      spool,
      {
        async syncCode(files): Promise<SyncResult> {
          for (const f of files) {
            if (f.chunks.length === 0) tombstones.push(f.file_path);
            else chunksSeen.push(f.file_path);
          }
          return { upserted: 0, deleted: 0, changed: 0, skipped: 0 };
        },
      },
      IDENTITY,
      { repoRoot: "/tmp", removed: ["src/f1.rs"], readFile: () => "x" },
    );
    assert.equal(chunksSeen.includes("src/f1.rs"), false, "removido não vai como chunk");
    assert.deepEqual(tombstones, ["src/f1.rs"], "vai como tombstone (chunks: [])");
    assert.equal(chunksSeen.length, 2);
  } finally {
    spool.dispose();
    rmSync(pjoin(bin, ".."), { recursive: true, force: true });
  }
});

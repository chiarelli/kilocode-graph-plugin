/**
 * Regressões do spool em disco + sync em lotes (`index/spool.ts`,
 * `index/sync-spool.ts`).
 *
 * O defeito original: o runner acumulava o job inteiro em `events[]` e o
 * coletor montava o body completo. Aqui se prova que:
 *   - eventos são separados por arquivo (arquivo completo só é lido depois);
 *   - um arquivo com >`batchSize` acompanhantes NÃO materializa tudo de uma vez;
 *   - arestas acompanham o lote da sua origem (servidor exige a origem);
 *   - o `dispose` remove o diretório.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EventSpool } from "../src/index/spool.ts";
import { syncSpool } from "../src/index/sync-spool.ts";
import type { CodeEdge, CodeFile, IndexerEvent, SyncResult } from "../src/types.ts";

const IDENTITY = { workspace: "ws", program: "default" };

function chunk(file: string, symbol: string | null): IndexerEvent {
  return {
    event: "chunk_emitted",
    payload: {
      chunk_id: `${file}#${symbol ?? "full"}`,
      chunk_kind: symbol ? "Symbol" : "FullFile",
      file,
      language: "rust",
      symbol_id: symbol,
      start_line: 1,
      end_line: 2,
      chunk_md5: `md5-${file}-${symbol ?? "full"}`,
      text: `fn ${symbol ?? "full"}() {}`,
    },
  };
}

function noopClient(calls: Array<{ files: CodeFile[]; edges: CodeEdge[] }>) {
  return {
    async syncCode(files: CodeFile[], edges: CodeEdge[]): Promise<SyncResult> {
      calls.push({ files, edges });
      return { upserted: files.length, deleted: 0, changed: 0, skipped: 0 };
    },
  };
}

function withSpool(fn: (spool: EventSpool) => void | Promise<void>) {
  const base = mkdtempSync(join(tmpdir(), "spool-test-"));
  const spool = EventSpool.create(base);
  const run = async () => {
    try {
      await fn(spool);
    } finally {
      spool.dispose();
      rmSync(base, { recursive: true, force: true });
    }
  };
  return run();
}

test("spool_groups_by_file: eventos de arquivos intercalados ficam separados", async () => {
  await withSpool((spool) => {
    spool.write(chunk("src/a.rs", "a1"));
    spool.write(chunk("src/b.rs", "b1"));
    spool.write(chunk("src/a.rs", "a2"));
    spool.close();

    const a = spool.readFile("src/a.rs");
    const b = spool.readFile("src/b.rs");
    assert.equal(a.length, 2);
    assert.equal(b.length, 1);
    assert.deepEqual(
      a.map((e) => (e.payload as { symbol_id?: string }).symbol_id),
      ["a1", "a2"],
    );
  });
});

test("spool_ignores_control_events: job_completed/file_listed não viram arquivo", async () => {
  await withSpool((spool) => {
    spool.write({ event: "job_completed", payload: { processed: 1 } });
    spool.write({
      event: "file_listed",
      payload: { file: { path: "src/a.rs", size: 1, mtime: 0, hash: "" } },
    });
    spool.close();
    assert.deepEqual(spool.files(), []);
  });
});

test("spool_registry_symbols: guarda nomes (não texto) para o índice de arestas", async () => {
  await withSpool((spool) => {
    spool.write(chunk("src/a.rs", "alfa"));
    spool.write(chunk("src/a.rs", "beta"));
    spool.close();
    const [file] = spool.files();
    assert.equal(file?.filePath, "src/a.rs");
    assert.deepEqual([...(file?.symbols ?? [])].sort(), ["alfa", "beta"]);
    assert.equal(file?.language, "rust");
  });
});

test("spool_edges_by_origin: arestas separadas pelo from_file", async () => {
  await withSpool((spool) => {
    spool.write({
      event: "import_edge",
      payload: { from_file: "src/a.rs", to_module: "crate::b" },
    });
    spool.write({
      event: "call_edge",
      payload: { from_file: "src/b.rs", caller_symbol_id: "src/b.rs:b", callee_name: "a" },
    });
    spool.close();
    assert.deepEqual(spool.edgesOrigins().sort(), ["src/a.rs", "src/b.rs"]);
    assert.equal(spool.readEdges("src/a.rs").length, 1);
    assert.equal(spool.readEdges("src/c.rs").length, 0);
  });
});

test("spool_dispose_removes_directory", async () => {
  const base = mkdtempSync(join(tmpdir(), "spool-dispose-"));
  const spool = EventSpool.create(base);
  const path = spool.path;
  spool.write(chunk("src/a.rs", "a1"));
  spool.dispose();
  assert.deepEqual(readdirSync(base), []);
  rmSync(base, { recursive: true, force: true });
  assert.equal(path.length > 0, true);
});

test("sync_spool_batches_by_file: >batchSize ⇒ múltiplos requests", async () => {
  await withSpool(async (spool) => {
    for (const f of ["a.rs", "b.rs", "c.rs", "d.rs", "e.rs"]) {
      spool.write(chunk(f, f.replace(".rs", "")));
    }
    spool.close();
    const calls: Array<{ files: CodeFile[]; edges: CodeEdge[] }> = [];
    const result = await syncSpool(spool, noopClient(calls), IDENTITY, {
      repoRoot: "/repo",
      batchSize: 2,
      readFile: () => "conteudo",
    });
    assert.equal(calls.length, 3, "5 arquivos com lote 2 ⇒ 3 requests");
    assert.deepEqual(
      calls.map((c) => c.files.length),
      [2, 2, 1],
    );
    assert.equal(result.files, 5);
  });
});

test("sync_spool_batch_never_exceeds_limit: lote não materializa o corpus inteiro", async () => {
  await withSpool(async (spool) => {
    for (let i = 0; i < 250; i++) spool.write(chunk(`f${i}.rs`, `s${i}`));
    spool.close();
    const calls: Array<{ files: CodeFile[]; edges: CodeEdge[] }> = [];
    const result = await syncSpool(spool, noopClient(calls), IDENTITY, {
      repoRoot: "/repo",
      batchSize: 100,
      readFile: () => "x",
    });
    assert.equal(calls.length, 3);
    assert.ok(
      calls.every((c) => c.files.length <= 100),
      "nenhum request pode passar de batchSize",
    );
    assert.equal(result.files, 250);
  });
});

test("sync_spool_edges_follow_origin_batch: aresta vai no lote do from_file", async () => {
  await withSpool(async (spool) => {
    spool.write(chunk("src/a.rs", "alfa"));
    spool.write(chunk("src/b.rs", "beta"));
    spool.write({
      event: "import_edge",
      payload: { from_file: "src/b.rs", to_module: "crate::a" },
    });
    spool.close();
    const calls: Array<{ files: CodeFile[]; edges: CodeEdge[] }> = [];
    await syncSpool(spool, noopClient(calls), IDENTITY, {
      repoRoot: "/repo",
      batchSize: 1,
      readFile: () => "x",
    });
    // Lote 1 = a.rs (sem aresta); lote 2 = b.rs (com a aresta de import).
    assert.equal(calls[0]?.edges.length, 0);
    assert.equal(calls[1]?.edges.length, 1);
    assert.equal(calls[1]?.edges[0]?.from_file, "src/b.rs");
  });
});

test("sync_spool_removed_last_batch: removidos entram com chunks: []", async () => {
  await withSpool(async (spool) => {
    spool.write(chunk("src/a.rs", "a"));
    spool.close();
    const calls: Array<{ files: CodeFile[]; edges: CodeEdge[] }> = [];
    const result = await syncSpool(spool, noopClient(calls), IDENTITY, {
      repoRoot: "/repo",
      removed: ["src/gone.rs"],
      readFile: () => "x",
    });
    const gone = calls.at(-1)?.files.find((f) => f.file_path === "src/gone.rs");
    assert.ok(gone);
    assert.deepEqual(gone?.chunks, []);
    assert.equal(result.removed, 1);
  });
});

test("sync_spool_only_removed: sem arquivos, ainda envia os tombstones", async () => {
  await withSpool(async (spool) => {
    spool.close();
    const calls: Array<{ files: CodeFile[]; edges: CodeEdge[] }> = [];
    await syncSpool(spool, noopClient(calls), IDENTITY, {
      repoRoot: "/repo",
      removed: ["src/gone.rs"],
      readFile: () => "x",
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.files.map((f) => f.file_path), ["src/gone.rs"]);
  });
});

test("sync_spool_aggregates_results: soma upserted/edges dos lotes", async () => {
  await withSpool(async (spool) => {
    spool.write(chunk("a.rs", "a"));
    spool.write(chunk("b.rs", "b"));
    spool.close();
    const client = {
      async syncCode(files: CodeFile[]): Promise<SyncResult> {
        return {
          upserted: files.length,
          deleted: 1,
          changed: 2,
          skipped: 3,
          edges_upserted: 1,
        };
      },
    };
    const result = await syncSpool(spool, client, IDENTITY, {
      repoRoot: "/repo",
      batchSize: 1,
      readFile: () => "x",
    });
    assert.equal(result.sync.upserted, 2);
    assert.equal(result.sync.deleted, 2);
    assert.equal(result.sync.changed, 4);
    assert.equal(result.sync.skipped, 6);
    assert.equal(result.sync.edges_upserted, 2);
  });
});

test("spool_caps_open_fds: muitos arquivos não esgotam descritores", async () => {
  // Regressão de recurso: 1 sink aberto por arquivo estouraria `ulimit -n` num
  // repo grande (o indexer emite arquivos intercalados em paralelo). O teto de
  // sinks abertos fecha os mais antigos; os dados continuam íntegros.
  const FILES = 300;
  await withSpool((spool) => {
    for (let i = 0; i < FILES; i++) spool.write(chunk(`src/f${i}.rs`, `s${i}`));
    spool.close();
    for (let i = 0; i < FILES; i++) {
      const events = spool.readFile(`src/f${i}.rs`);
      assert.equal(events.length, 1, `arquivo f${i}.rs deve ter seu evento`);
    }
  });
});

test("spool_interleaved_files: escrita intercalada após evicção não perde nem duplica", async () => {
  // A ordem intercalada é o caso REAL (threads do rayon). O fd reaberto em
  // `append` não pode truncar nem sobrescrever o que já foi drenado.
  await withSpool((spool) => {
    const FILES = 60;
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < FILES; i++) spool.write(chunk(`src/f${i}.rs`, `r${round}`));
    }
    spool.close();
    for (let i = 0; i < FILES; i++) {
      const events = spool.readFile(`src/f${i}.rs`);
      assert.equal(events.length, 3, `f${i}.rs deve ter 3 chunks`);
      assert.deepEqual(
        events.map((e) => (e.payload as { symbol_id?: string }).symbol_id),
        ["r0", "r1", "r2"],
        "ordem de escrita preservada",
      );
    }
  });
});

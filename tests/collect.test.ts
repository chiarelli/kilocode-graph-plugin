/**
 * E3a-S1 — `hooks/collect.ts` + `client.syncCode`: body shape, parse da resposta
 * 202 e degradação (nunca lança). Sem rede nem spawn real (runner/client stubados).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MemtierClient, type FetchLike } from "../src/client.ts";
import { collectCode, collectHook, type CollectRuntime } from "../src/hooks/collect.ts";
import type { IndexerEvent, SyncResult } from "../src/types.ts";

const IDENTITY = { workspace: "waweb", program: "default" };

/** Evento chunk_emitted mínimo (fixture-like). */
function chunkEvent(file: string, symbol: string): IndexerEvent {
  return {
    event: "chunk_emitted",
    payload: {
      chunk_id: `${file}#${symbol}`,
      chunk_kind: "Symbol",
      file,
      language: "rust",
      symbol_id: symbol,
      start_line: 1,
      end_line: 2,
      chunk_md5: `md5-${file}-${symbol}`,
      text: "fn x() {}",
    },
  };
}

/** Runtime com runner e client stubados. */
function runtime(overrides: Partial<CollectRuntime> = {}): CollectRuntime {
  return {
    cfg: { enabled: true, indexer_bin: "/fake/indexer" },
    repoRoot: "/repo",
    identity: IDENTITY,
    client: { syncCode: async (): Promise<SyncResult> => EMPTY_SYNC },
    run: async () => ({
      events: [chunkEvent("src/a.rs", "a1")],
      skipped: false,
    }),
    ...overrides,
  };
}

const EMPTY_SYNC: SyncResult = {
  upserted: 1,
  deleted: 0,
  changed: 1,
  skipped: 0,
};

test("collect_disabled: code_index.enabled=false ⇒ sem spawn/sync", async () => {
  let called = false;
  const rt = runtime({
    cfg: { enabled: false, indexer_bin: "/fake" },
    client: {
      syncCode: async () => {
        called = true;
        return EMPTY_SYNC;
      },
    },
  });
  const result = await collectCode(rt);
  assert.equal(result, null);
  assert.equal(called, false);
});

test("collect_syncs_chunks: 1 arquivo ⇒ syncCode chamado; devolve SyncResult", async () => {
  let files = 0;
  const rt = runtime({
    client: {
      syncCode: async (f) => {
        files = f.length;
        return EMPTY_SYNC;
      },
    },
  });
  const result = await collectCode(rt);
  assert.equal(files, 1);
  assert.equal(result?.upserted, 1);
});

test("collect_skipped_indexer: runner skipped ⇒ sem sync; devolve null", async () => {
  let called = false;
  const rt = runtime({
    run: async () => ({ events: [], skipped: true, reason: "indexer_bin vazio" }),
    client: {
      syncCode: async () => {
        called = true;
        return EMPTY_SYNC;
      },
    },
  });
  assert.equal(await collectCode(rt), null);
  assert.equal(called, false);
});

test("collect_no_chunks: runner ok mas 0 chunks ⇒ sem sync", async () => {
  let called = false;
  const rt = runtime({
    run: async () => ({ events: [], skipped: false }),
    client: {
      syncCode: async () => {
        called = true;
        return EMPTY_SYNC;
      },
    },
  });
  assert.equal(await collectCode(rt), null);
  assert.equal(called, false);
});

test("collect_sync_fails: syncCode lança ⇒ não propaga (degrada)", async () => {
  const rt = runtime({
    client: {
      syncCode: async () => {
        throw new Error("ECONNREFUSED");
      },
    },
  });
  await assert.doesNotReject(() => collectCode(rt));
  assert.equal(await collectCode(rt), null);
});

test("collect_runner_throws: runner lança ⇒ não propaga", async () => {
  const rt = runtime({
    run: async () => {
      throw new Error("spawn ERROR");
    },
  });
  await assert.doesNotReject(() => collectCode(rt));
});

test("collect_hook_returns_boot_promise: background, não bloqueia", async () => {
  const rt = runtime();
  const { boot } = collectHook(rt);
  assert.ok(boot instanceof Promise);
  await boot;
});

// --- E3a-S3: removidos via manifest ----------------------------------------

/** Manifest em memória para o teste: `load` devolve `initial`, `save` acumula. */
function fakeState(initial: string[]) {
  const saved: string[][] = [];
  return {
    initial,
    saved,
    load: () => ({ files: initial }),
    save: (files: string[]) => {
      saved.push(files);
    },
  };
}

test("collect_sends_removed: arquivo saiu do repo ⇒ body inclui chunks: []", async () => {
  let sentFiles: Array<{ file_path: string; chunks: unknown[] }> = [];
  const rt = runtime({
    run: async () => ({
      events: [chunkEvent("src/a.rs", "a1")],
      skipped: false,
    }),
    state: fakeState(["src/a.rs", "src/gone.rs"]),
    client: {
      syncCode: async (f) => {
        sentFiles = f as never;
        return EMPTY_SYNC;
      },
    },
  });
  await collectCode(rt);
  const gone = sentFiles.find((f) => f.file_path === "src/gone.rs");
  assert.ok(gone, "o removido deve estar no body");
  assert.deepEqual(gone?.chunks, []);
});

test("collect_saves_current: manifest pós-sync grava só os arquivos atuais", async () => {
  const st = fakeState(["src/a.rs", "src/gone.rs"]);
  const rt = runtime({
    run: async () => ({ events: [chunkEvent("src/a.rs", "a1")], skipped: false }),
    state: st,
  });
  await collectCode(rt);
  assert.deepEqual(st.saved[0], ["src/a.rs"]);
});

test("collect_first_use: manifest vazio ⇒ sem removidos", async () => {
  let sentFiles: Array<{ file_path: string }> = [];
  const rt = runtime({
    run: async () => ({ events: [chunkEvent("src/a.rs", "a1")], skipped: false }),
    state: fakeState([]),
    client: {
      syncCode: async (f) => {
        sentFiles = f;
        return EMPTY_SYNC;
      },
    },
  });
  await collectCode(rt);
  assert.equal(sentFiles.length, 1);
  assert.equal(sentFiles[0]?.file_path, "src/a.rs");
});

test("collect_incremental_no_removed: incremental não marca inalterados como removidos", async () => {
  // Manifest com head ⇒ trigger incremental. O stream só traz o alterado; o
  // inalterado (src/keep.rs) NÃO pode virar `chunks: []` (apagaria o grafo).
  let sentFiles: Array<{ file_path: string; chunks: unknown[] }> = [];
  const rt = runtime({
    run: async (opts) => {
      assert.equal(opts.mode, "incremental");
      return { events: [chunkEvent("src/changed.rs", "c1")], skipped: false };
    },
    state: {
      load: () => ({ files: ["src/keep.rs", "src/changed.rs"], last_git_head: "abc" }),
      save: () => {},
    },
    client: {
      syncCode: async (f) => {
        sentFiles = f as never;
        return EMPTY_SYNC;
      },
    },
  });
  await collectCode(rt);
  const keep = sentFiles.find((f) => f.file_path === "src/keep.rs");
  assert.equal(keep, undefined, "inalterado não deve ser enviado como removido");
});

test("collect_load_ignores: repassa load_ignores do cfg ao runner", async () => {
  let seen: { loadIgnores?: boolean } | undefined;
  const rt = runtime({
    cfg: { enabled: true, indexer_bin: "/fake/indexer", load_ignores: true },
    run: async (opts) => {
      seen = opts;
      return { events: [chunkEvent("src/a.rs", "a1")], skipped: false };
    },
  });
  await collectCode(rt);
  assert.equal(seen?.loadIgnores, true);
});

test("collect_load_ignores_off: default false quando cfg não define", async () => {
  let seen: { loadIgnores?: boolean } | undefined;
  const rt = runtime({
    run: async (opts) => {
      seen = opts;
      return { events: [chunkEvent("src/a.rs", "a1")], skipped: false };
    },
  });
  await collectCode(rt);
  assert.equal(seen?.loadIgnores, false);
});

test("collect_incremental_merges_manifest: estado pós-incremental preserva inalterados", async () => {
  const saved: string[][] = [];
  const rt = runtime({
    run: async () => ({ events: [chunkEvent("src/changed.rs", "c1")], skipped: false }),
    state: {
      load: () => ({ files: ["src/keep.rs", "src/changed.rs"], last_git_head: "abc" }),
      save: (files) => saved.push(files),
    },
    client: { syncCode: async () => EMPTY_SYNC },
  });
  await collectCode(rt);
  assert.deepEqual(saved[0]?.sort(), ["src/changed.rs", "src/keep.rs"]);
});

// --- client.syncCode -------------------------------------------------------

test("sync_body_shape: body tem workspace/program/files/edges", async () => {
  let body: Record<string, unknown> = {};
  const client = new MemtierClient({
    url: "http://memtier:8400",
    workspace: "waweb",
    program: "default",
    fetch: (async (_i, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response("{}", { status: 202 });
    }) as FetchLike,
  });
  await client.syncCode(
    [{ file_path: "src/a.rs", language: "rust", chunks: [] }],
    [],
  );
  assert.equal(body.workspace, "waweb");
  assert.equal(body.program, "default");
  assert.ok(Array.isArray(body.files));
  assert.ok(Array.isArray(body.edges));
});

test("sync_parses_result: 202 ⇒ upserted/deleted lidos", async () => {
  const client = new MemtierClient({
    url: "http://memtier:8400",
    workspace: "waweb",
    fetch: (async () =>
      new Response(
        JSON.stringify({
          upserted: 3,
          deleted: 1,
          changed: 3,
          skipped: 0,
        }),
        { status: 202 },
      )) as FetchLike,
  });
  const result = await client.syncCode([
    { file_path: "src/a.rs", language: "rust", chunks: [] },
  ]);
  assert.equal(result.upserted, 3);
  assert.equal(result.deleted, 1);
});

// --- E3a-S4: paginação + fallback 422 --------------------------------------

/** Arquivo vazio (só conta para a paginação). */
function emptyFile(i: number) {
  return { file_path: `src/f${i}.rs`, language: "rust", chunks: [] };
}

test("sync_paginates_100: 250 arquivos ⇒ 3 requests (100/100/50)", async () => {
  const sizes: number[] = [];
  const client = new MemtierClient({
    url: "http://memtier:8400",
    workspace: "ws",
    fetch: (async (_i, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { files: unknown[] };
      sizes.push(body.files.length);
      return new Response(JSON.stringify({ upserted: 0, deleted: 0, changed: 0, skipped: 0 }), { status: 202 });
    }) as FetchLike,
  });
  const files = Array.from({ length: 250 }, (_v, i) => emptyFile(i));
  await client.syncCode(files, []);
  assert.deepEqual(sizes, [100, 100, 50]);
});

test("sync_aggregates: 3 respostas ⇒ upserted somado", async () => {
  let n = 0;
  const client = new MemtierClient({
    url: "http://memtier:8400",
    workspace: "ws",
    fetch: (async () => {
      n += 1;
      return new Response(
        JSON.stringify({ upserted: n, deleted: 0, changed: n, skipped: 0 }),
        { status: 202 },
      );
    }) as FetchLike,
  });
  const files = Array.from({ length: 250 }, (_v, i) => emptyFile(i));
  const result = await client.syncCode(files, []);
  assert.equal(result.upserted, 1 + 2 + 3);
});

test("sync_422_fallback: 422 com edges ⇒ reenvia sem edges", async () => {
  const bodies: Array<{ edges: unknown[] }> = [];
  const client = new MemtierClient({
    url: "http://memtier:8400",
    workspace: "ws",
    fetch: (async (_i, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { edges: unknown[] };
      bodies.push(body);
      if (body.edges.length > 0) {
        return new Response(JSON.stringify({ detail: "aresta órfã" }), { status: 422 });
      }
      return new Response(JSON.stringify({ upserted: 1, deleted: 0, changed: 1, skipped: 0 }), { status: 202 });
    }) as FetchLike,
  });
  const result = await client.syncCode(
    [{ file_path: "src/a.rs", language: "rust", chunks: [] }],
    [{ from_file: "src/a.rs", to_file: "src/b.rs", edge_kind: "import" }],
  );
  assert.equal(bodies.length, 2, "deve tentar com arestas e reenviar sem");
  assert.equal(bodies[0]?.edges.length, 1);
  assert.equal(bodies[1]?.edges.length, 0);
  assert.equal(result.upserted, 1);
});

test("sync_422_no_edges: 422 sem arestas ⇒ propaga (nada a degradar)", async () => {
  const client = new MemtierClient({
    url: "http://memtier:8400",
    workspace: "ws",
    fetch: (async () => new Response("{}", { status: 422 })) as FetchLike,
  });
  await assert.rejects(
    () => client.syncCode([{ file_path: "src/a.rs", language: "rust", chunks: [] }], []),
    (err: unknown) => (err as { status?: number }).status === 422,
  );
});

test("sync_single_no_pagination: ≤100 arquivos ⇒ 1 request", async () => {
  let calls = 0;
  const client = new MemtierClient({
    url: "http://memtier:8400",
    workspace: "ws",
    fetch: (async () => {
      calls += 1;
      return new Response(JSON.stringify({ upserted: 0, deleted: 0, changed: 0, skipped: 0 }), { status: 202 });
    }) as FetchLike,
  });
  await client.syncCode([emptyFile(0)], []);
  assert.equal(calls, 1);
});

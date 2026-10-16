/**
 * E3a-S6a — CLI standalone + decisões de delta: sentinela (`graph-ready`),
 * guarda de ancestralidade, removidos no incremental, paridade de config (§7) e
 * trava cross-process.
 *
 * Unit: git/runner/client/estado stubados (sem spawn real nem rede). A única
 * exceção é `cli_lock_serializes_two_procs`, que usa spawn REAL de dois processos
 * (o `O_EXCL` é o comportamento sob teste).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { main, parseArgs, runCli } from "../src/cli.ts";
import type { CollectRuntime, CollectState } from "../src/hooks/collect.ts";
import { collectCode } from "../src/hooks/collect.ts";
import { CONFIG_STATE_REL_PATH, READY_REL_PATH } from "../src/config.ts";
import type { GitPort } from "../src/index/git.ts";
import type { IndexerEvent, SyncResult } from "../src/types.ts";

const dirs: string[] = [];
function tmpDir(prefix = "graph-cli-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const EMPTY_SYNC: SyncResult = { upserted: 1, deleted: 0, changed: 1, skipped: 0 };

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

/** Git fake (sem spawn): repo, head e ancestralidade controlados. */
function fakeGit(over: Partial<GitPort> = {}): GitPort {
  return {
    isRepo: () => true,
    head: () => "HEAD_SHA",
    isAncestor: () => true,
    deletedFiles: () => [],
    hooksDir: () => "/repo/.git/hooks",
    ...over,
  };
}

/** Estado em memória (manifest). */
function memState(initial: {
  files: string[];
  last_git_head?: string | null;
}): CollectState & { saved: Array<{ files: string[]; head: string | null }> } {
  const saved: Array<{ files: string[]; head: string | null }> = [];
  return {
    saved,
    load: () => ({
      files: initial.files,
      last_git_head: initial.last_git_head ?? null,
    }),
    save: (files, head) => void saved.push({ files, head }),
  };
}

/** Runtime de coleta com fakes; captura o que for preciso. */
function runtime(over: Partial<CollectRuntime> = {}): CollectRuntime {
  return {
    cfg: { enabled: true, indexer_bin: "/fake/indexer" },
    repoRoot: "/repo",
    identity: { workspace: "ws", program: "default" },
    client: { syncCode: async () => EMPTY_SYNC },
    run: async () => ({
      events: [chunkEvent("src/a.rs", "a1")],
      skipped: false,
    }),
    ...over,
  };
}

// --- parseArgs -------------------------------------------------------------

test("parseArgs_workspace_required: sem --workspace ⇒ erro", () => {
  const p = parseArgs([]);
  assert.ok("error" in p);
});

test("parseArgs_defaults_auto: modo default = auto", () => {
  const p = parseArgs(["--workspace", "/w"]);
  assert.ok(!("error" in p));
  assert.equal((p as { mode: string }).mode, "auto");
});

test("parseArgs_invalid_mode: --mode xyz ⇒ erro", () => {
  const p = parseArgs(["--workspace", "/w", "--mode", "xyz"]);
  assert.ok("error" in p);
});

test("parseArgs_source: --source post-merge é lido", () => {
  const p = parseArgs(["--workspace", "/w", "--source", "post-merge"]);
  assert.equal((p as { source?: string }).source, "post-merge");
});

// --- Sentinela (§3) --------------------------------------------------------

test("cli_aborts_without_ready: incremental sem graph-ready ⇒ não roda, null", async () => {
  let ran = false;
  const rt = runtime({
    run: async (opts) => {
      ran = true;
      assert.equal(opts.mode, "incremental");
      return { events: [], skipped: false };
    },
    state: memState({ files: ["src/a.rs"], last_git_head: "abc" }),
    git: fakeGit(),
    ready: () => false,
  });
  assert.equal(await collectCode(rt), null);
  assert.equal(ran, false, "não deve spawnar o indexer antes do full inicial");
});

test("cli_incremental_runs_when_ready: incremental com graph-ready ⇒ roda", async () => {
  let mode = "";
  const rt = runtime({
    run: async (opts) => {
      mode = opts.mode;
      return { events: [chunkEvent("src/a.rs", "a1")], skipped: false };
    },
    state: memState({ files: ["src/a.rs"], last_git_head: "abc" }),
    git: fakeGit(),
    ready: () => true,
  });
  assert.ok(await collectCode(rt));
  assert.equal(mode, "incremental");
});

test("cli_boot_writes_ready: full inicial conclui ⇒ onFullComplete dispara", async () => {
  let readyCalls = 0;
  const rt = runtime({
    state: memState({ files: [] }), // 1º uso ⇒ full
    git: fakeGit(),
    onFullComplete: () => void (readyCalls += 1),
  });
  await collectCode(rt);
  assert.equal(readyCalls, 1, "full inicial arma o incremental");
});

test("cli_ready_not_written_on_incremental: incremental NÃO chama onFullComplete", async () => {
  let readyCalls = 0;
  const rt = runtime({
    state: memState({ files: ["src/a.rs"], last_git_head: "abc" }),
    git: fakeGit(),
    ready: () => true,
    onFullComplete: () => void (readyCalls += 1),
  });
  await collectCode(rt);
  assert.equal(readyCalls, 0);
});

test("cli_empty_full_arms_ready: full sem chunks (repo vazio) AINDA arma o sentinela", async () => {
  // M3: sem isto o sentinela nunca nasce e todo boot refaz full para sempre.
  let readyCalls = 0;
  const saved: Array<{ files: string[]; head: string | null }> = [];
  const rt = runtime({
    run: async () => ({ events: [], skipped: false }), // full vazio
    state: {
      load: () => ({ files: [], last_git_head: null }),
      save: (files, head) => void saved.push({ files, head }),
    },
    git: fakeGit({ head: () => "EMPTY_SHA" }),
    onFullComplete: () => void (readyCalls += 1),
  });
  await collectCode(rt);
  assert.equal(readyCalls, 1, "full vazio ainda arma o incremental");
  assert.deepEqual(saved[0], { files: [], head: "EMPTY_SHA" }, "HEAD gravado");
});

// --- Guarda de ancestralidade (§4) -----------------------------------------

test("cli_ancestor_incremental: last é ancestral de HEAD ⇒ incremental + git_range", async () => {
  let seen: { mode: string; gitRange?: { from: string; to: string } } | null = null;
  const calls: Array<[string, string, string]> = [];
  const rt = runtime({
    run: async (opts) => {
      seen = { mode: opts.mode, gitRange: opts.gitRange };
      return { events: [chunkEvent("src/a.rs", "a1")], skipped: false };
    },
    state: memState({ files: ["src/a.rs"], last_git_head: "old123" }),
    // F5: captura os ARGS para provar que a guarda recebe (repoRoot, from, HEAD
    // resolvido) — um fake `()=>true` esconderia args trocados.
    git: fakeGit({
      head: () => "HEAD_SHA",
      isAncestor: (root, a, b) => {
        calls.push([root, a, b]);
        return true;
      },
    }),
    ready: () => true,
  });
  await collectCode(rt);
  assert.equal(seen!.mode, "incremental");
  // H2: o `to` do range é o SHA resolvido, não o literal "HEAD".
  assert.deepEqual(seen!.gitRange, { from: "old123", to: "HEAD_SHA" });
  assert.deepEqual(calls, [["/repo", "old123", "HEAD_SHA"]]);
});

test("cli_non_ancestor_full: checkout para trás ⇒ full", async () => {
  let mode = "";
  const rt = runtime({
    run: async (opts) => {
      mode = opts.mode;
      return { events: [chunkEvent("src/a.rs", "a1")], skipped: false };
    },
    state: memState({ files: ["src/a.rs"], last_git_head: "diverged" }),
    git: fakeGit({ isAncestor: () => false }),
    ready: () => true,
  });
  await collectCode(rt);
  assert.equal(mode, "full", "range inválido nunca vira incremental (§4)");
});

// --- Removidos no incremental (§5) -----------------------------------------

test("cli_removed_files: deleção no range ⇒ removed com chunks: []", async () => {
  let sentFiles: Array<{ file_path: string; chunks: unknown[] }> = [];
  const delCalls: Array<[string, string, string]> = [];
  const rt = runtime({
    run: async () => ({ events: [chunkEvent("src/keep.rs", "k1")], skipped: false }),
    state: memState({ files: ["src/keep.rs", "src/gone.rs"], last_git_head: "old" }),
    git: fakeGit({
      head: () => "NEW_SHA",
      // Captura os args: prova que o range é (repoRoot, from, HEAD resolvido).
      deletedFiles: (root, from, to) => {
        delCalls.push([root, from, to]);
        return ["src/gone.rs"];
      },
    }),
    ready: () => true,
    client: {
      syncCode: async (f) => {
        sentFiles = f as never;
        return EMPTY_SYNC;
      },
    },
  });
  await collectCode(rt);
  const gone = sentFiles.find((f) => f.file_path === "src/gone.rs");
  assert.ok(gone, "arquivo deletado deve entrar no body como removido");
  assert.deepEqual(gone?.chunks, []);
  assert.deepEqual(delCalls, [["/repo", "old", "NEW_SHA"]]);
});

test("cli_removed_wins_over_ghost_chunk: chunk do indexer p/ arquivo deletado não vence o git", async () => {
  // M2: o indexer emite um `chunk_emitted` para um arquivo que o git reporta
  // deletado (nó fantasma "medido"). O git é a verdade: o arquivo tem de sair
  // (`chunks: []`), não virar upsert.
  let sentFiles: Array<{ file_path: string; chunks: unknown[] }> = [];
  const rt = runtime({
    run: async () => ({
      events: [
        chunkEvent("src/gone.rs", "ghost"), // fantasma do indexer
        chunkEvent("src/keep.rs", "k1"),
      ],
      skipped: false,
    }),
    state: memState({ files: ["src/keep.rs", "src/gone.rs"], last_git_head: "old" }),
    git: fakeGit({ deletedFiles: () => ["src/gone.rs"] }),
    ready: () => true,
    client: {
      syncCode: async (f) => {
        sentFiles = f as never;
        return EMPTY_SYNC;
      },
    },
  });
  await collectCode(rt);
  const gone = sentFiles.find((f) => f.file_path === "src/gone.rs");
  assert.ok(gone, "o deletado deve estar no body");
  assert.deepEqual(gone?.chunks, [], "o fantasma não pode ressuscitar o arquivo");
});

test("cli_workspace_identity_change_forces_full: manifest de outro workspace ⇒ full", async () => {
  let mode = "";
  const rt = runtime({
    identity: { workspace: "new-ws", program: "default" },
    run: async (opts) => {
      mode = opts.mode;
      return { events: [chunkEvent("src/a.rs", "a1")], skipped: false };
    },
    // O manifest é de OUTRO workspace (mesmo com head): incremental reusaria um
    // manifest alheio e o grafo novo ficaria incompleto ⇒ força full.
    state: {
      load: () => ({ files: ["src/a.rs"], last_git_head: "abc", workspace: "old-ws" }),
      save: () => {},
    },
    git: fakeGit(),
    ready: () => true,
  });
  await collectCode(rt);
  assert.equal(mode, "full");
});

test("cli_forceMode_incremental_non_ancestor_full: incremental forçado sem range válido ⇒ full", async () => {
  let mode = "";
  const rt = runtime({
    forceMode: "incremental",
    run: async (opts) => {
      mode = opts.mode;
      return { events: [chunkEvent("src/a.rs", "a1")], skipped: false };
    },
    state: memState({ files: ["src/a.rs"], last_git_head: "diverged" }),
    git: fakeGit({ isAncestor: () => false }),
    ready: () => true,
  });
  await collectCode(rt);
  assert.equal(mode, "full", "nunca roda incremental com range inválido (§4)");
});

test("cli_incremental_no_deletes: sem deleções ⇒ nenhum removed", async () => {
  let sentFiles: Array<{ file_path: string; chunks: unknown[] }> = [];
  const rt = runtime({
    run: async () => ({ events: [chunkEvent("src/keep.rs", "k1")], skipped: false }),
    state: memState({ files: ["src/keep.rs", "src/other.rs"], last_git_head: "old" }),
    git: fakeGit({ deletedFiles: () => [] }),
    ready: () => true,
    client: {
      syncCode: async (f) => {
        sentFiles = f as never;
        return EMPTY_SYNC;
      },
    },
  });
  await collectCode(rt);
  // `src/other.rs` não está no stream mas NÃO pode virar removido (o stream do
  // incremental não é um estado completo — só as deleções do git contam).
  assert.equal(sentFiles.find((f) => f.file_path === "src/other.rs"), undefined);
});

// --- runCli: workspace/config (§2/§7) --------------------------------------

test("cli_workspace_from_arg: lê a config do --workspace, não o cwd", async () => {
  const ws = tmpDir();
  mkdirSync(join(ws, ".kilo"), { recursive: true });
  writeFileSync(
    join(ws, CONFIG_STATE_REL_PATH),
    JSON.stringify({
      daemon: { workspace: "pinned", program: "default" },
      code_index: { enabled: true, indexer_bin: "/bin/from-ws" },
    }),
  );
  let captured: CollectRuntime | null = null;
  const code = await runCli(
    { workspace: ws, mode: "auto", source: "post-commit" },
    {
      git: fakeGit(),
      collectCode: async (rt) => {
        captured = rt;
        return null;
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(captured!.repoRoot, ws, "usa o --workspace, não o cwd");
  assert.equal((captured!.cfg as { indexer_bin: string }).indexer_bin, "/bin/from-ws");
  assert.equal(captured!.identity.workspace, "pinned");
});

test("cli_config_parity: config persistida (§7) vence o default do CLI", async () => {
  const ws = tmpDir();
  mkdirSync(join(ws, ".kilo"), { recursive: true });
  writeFileSync(
    join(ws, CONFIG_STATE_REL_PATH),
    JSON.stringify({ code_index: { enabled: true, load_ignores: true } }),
  );
  let seen = false;
  await runCli(
    { workspace: ws, mode: "auto" },
    {
      git: fakeGit(),
      collectCode: async (rt) => {
        seen = (rt.cfg as { load_ignores?: boolean }).load_ignores === true;
        return null;
      },
    },
  );
  assert.equal(seen, true, "o CLI usa a MESMA config persistida pelo boot");
});

test("cli_disabled_is_noop: code_index.enabled=false ⇒ exit 0, sem erro", async () => {
  const ws = tmpDir();
  mkdirSync(join(ws, ".kilo"), { recursive: true });
  writeFileSync(
    join(ws, CONFIG_STATE_REL_PATH),
    JSON.stringify({ code_index: { enabled: false } }),
  );
  let called = false;
  const code = await runCli(
    { workspace: ws, mode: "auto" },
    {
      git: fakeGit(),
      collectCode: async () => {
        called = true;
        return null;
      },
    },
  );
  assert.equal(code, 0);
  // O CLI invoca `collectCode`; é ele quem decide desligar (enabled=false).
  assert.equal(called, true);
});

test("cli_boot_writes_ready_file: full inicial grava graph-ready no disco", async () => {
  const ws = tmpDir();
  const code = await runCli(
    {
      workspace: ws,
      mode: "full",
      source: "boot",
    },
    {
      git: fakeGit(),
      // `collectCode` real traria o runner real; aqui exercitamos o wiring do
      // `onFullComplete` invocando-o via um stub que simula o full concluído.
      collectCode: async (rt) => {
        rt.onFullComplete?.();
        return EMPTY_SYNC;
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(existsSync(join(ws, READY_REL_PATH)), true, "graph-ready criado");
});

test("cli_main_returns_2_on_bad_args: sem --workspace ⇒ exit 2", async () => {
  assert.equal(await main([]), 2);
});

// --- Trava cross-process (§3b) — spawn REAL --------------------------------

test("cli_lock_serializes_two_procs", async () => {
  // Dois processos REAIS disputam `<ws>/.kilo/graph.lock` via `acquireLock` (§3b).
  // Cada um, sob a trava, escreve "begin" → espera → "end" num arquivo. Se a
  // trava for eficaz, os blocos NÃO se intercalam (begin,end begin,end).
  const ws = tmpDir("graph-lock-procs-");
  const logFile = join(ws, "order.log");
  const lockPath = join(ws, "graph.lock");
  const lockModuleUrl = new URL("../src/index/lock.ts", import.meta.url).href;

  const child = `
import { appendFileSync } from "node:fs";
import { acquireLock } from ${JSON.stringify(lockModuleUrl)};
const lock = await acquireLock({ path: ${JSON.stringify(lockPath)}, timeoutMs: 10000, retryMs: 5 });
appendFileSync(${JSON.stringify(logFile)}, "begin\\n");
await new Promise((r) => setTimeout(r, 120));
appendFileSync(${JSON.stringify(logFile)}, "end\\n");
lock.release();
`;
  const spawnChild = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", child], {
        stdio: "ignore",
      });
      p.on("error", reject);
      p.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`child exit=${code}`)),
      );
    });

  await Promise.all([spawnChild(), spawnChild()]);

  const lines = readFileSync(logFile, "utf-8").trim().split("\n");
  assert.deepEqual(
    lines,
    ["begin", "end", "begin", "end"],
    "blocos serializados (sem interleave)",
  );
});

test("cli_lock_stale_reclaimed: lock órfão dentro do CLI ⇒ retoma", async () => {
  // Um lock stale (mtime antigo) não pode travar o CLI para sempre: a coleta o
  // reclama e prossegue.
  const ws = tmpDir("graph-lock-stale-");
  mkdirSync(join(ws, ".kilo"), { recursive: true });
  const lockPath = join(ws, ".kilo", "graph.lock");
  writeFileSync(lockPath, "999999");
  const old = (Date.now() - 120_000) / 1000;
  const { utimesSync } = await import("node:fs");
  utimesSync(lockPath, old, old);

  let ran = false;
  const rt = runtime({
    repoRoot: ws,
    lockPath,
    run: async () => {
      ran = true;
      return { events: [chunkEvent("src/a.rs", "a1")], skipped: false };
    },
    git: fakeGit(),
    state: memState({ files: [] }),
  });
  await collectCode(rt);
  assert.equal(ran, true, "lock stale é reclamado e a coleta prossegue");
});

/**
 * E8-S3 — E2E de IDA-E-VOLTA do id injetado (gated `E2E=1`).
 *
 * Fecha os achados 3/4/6 da RFC-001 provando o ciclo completo contra o servidor
 * real: o id que o plugin injeta é **utilizável** pelas tools, e o conteúdo
 * volta do outro lado.
 *
 *   1. `recall` real → bloco injetado tem `[id=<uuid 36>]` e `[ep=<uuid 36>]`
 *      (aceita `+N` — o grafo local devolve fatos com 2 episódios).
 *   2. esse `[ep=…]` → `POST /v1/memory/episodes` (`uuids: []`) resolve com
 *      `content` não vazio. **Contraprova:** o `[id=…]` do FATO em `uuids`
 *      devolve `resolved: 0` — a chave do episódio é o uuid do episódio.
 *   3. `code_search` real → bloco tem `[id=<uuid 36>]`; esse uuid →
 *      `POST /v1/code/neighbors` responde 200.
 *   4. `system.transform` real → cita as tools de memória e NÃO as de código
 *      quando `code_index.enabled=false`.
 *
 * Tokens por suíte (RUNBOOK-E2E): memória `E2E_TOKEN`, código `E2E_CODE_TOKEN`.
 * Cada bloco só roda com o seu token; o resto do arquivo não inventa credencial.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MemtierClient } from "../../src/client.ts";
import pluginModule from "../../src/index.ts";
import { isValidUuid } from "../../src/inject/uuid.ts";
import { workspaceName } from "../../src/workspace.ts";

const E2E = process.env.E2E === "1";
/**
 * URL do stack local. **Não** herda `KILOCODE_GRAPH_URL`: a máquina de dev pode
 * ter a env apontando para o memtier remoto (com outra credencial), e o E2E
 * local falharia com 401 de um servidor que não é o alvo do teste.
 */
const MEMTIER_URL = process.env.E2E_MEMTIER_URL ?? "http://127.0.0.1:8400";

/** Workspace/credencial da MEMÓRIA (seed `alfa`, bearer show-once). */
const MEM_TOKEN = process.env.E2E_TOKEN ?? process.env.KILOCODE_GRAPH_TOKEN ?? "";
const MEM_WS = process.env.E2E_WS ?? "alfa";
const MEM_QUERY = process.env.E2E_QUERY ?? "losartan";

/** Workspace/credencial de CÓDIGO (bearer escopado ao workspace indexado). */
const CODE_TOKEN = process.env.E2E_CODE_TOKEN ?? "";
const CODE_WS = process.env.E2E_CODE_WS ?? "beta";
/**
 * Query que casa um chunk de SÍMBOLO no workspace de código. O default do
 * plugin (`labels: ["CodeSymbol"]`) descarta o chunk de arquivo inteiro, então a
 * query precisa acertar um símbolo (a fixture do workspace `beta` tem `beta`).
 */
const CODE_QUERY = process.env.E2E_CODE_QUERY ?? "beta";

const PROGRAM = process.env.E2E_PROGRAM ?? "default";

/** Workspace real: dir cujo basename resolve para `ws` + token_file. */
function makeWorkspace(ws: string, token: string): { dir: string; tokenFile: string } {
  const base = mkdtempSync(join(tmpdir(), "graph-e2e-e8-"));
  const dir = join(base, ws);
  const kiloDir = join(dir, ".kilo");
  mkdirSync(kiloDir, { recursive: true });
  const tokenFile = join(kiloDir, "graph-key.json");
  writeFileSync(
    tokenFile,
    JSON.stringify({ token, workspace: ws, program: PROGRAM }),
  );
  return { dir, tokenFile };
}

/** Boota o plugin no workspace real e devolve os hooks. */
async function boot(
  ws: string,
  token: string,
  options: Record<string, unknown>,
) {
  const { dir, tokenFile } = makeWorkspace(ws, token);
  const hooks = await pluginModule.server(
    { directory: dir, worktree: null },
    {
      daemon: {
        url: MEMTIER_URL,
        token_file: tokenFile,
        program: PROGRAM,
        workspace: ws,
        health_timeout_ms: 3000,
      },
      debug: true,
      ...options,
    },
  );
  return { dir, hooks };
}

/** `[id=…]`/`[ep=…]` do bloco injetado (o primeiro de cada). */
function marker(block: string, kind: "id" | "ep"): string | undefined {
  const match = block.match(new RegExp(`\\[${kind}=([^\\]\\s]+)`));
  return match?.[1];
}

/** POST direto (as rotas de memória não passam pelo client do plugin). */
async function post(
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${MEMTIER_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

// --- 1+2: memória — id injetado → memory_episodes ---------------------------

test("e2e: [ep=…] injetado resolve o conteúdo original; [id=…] do fato não", {
  skip: !E2E || !MEM_TOKEN,
}, async () => {
  const { dir, hooks } = await boot(MEM_WS, MEM_TOKEN, {
    inject: { enabled: true, max_memories: 5, memory_max_tokens: 2000 },
    mcp: { enabled: true },
    code_index: { enabled: false },
  });
  let episodeId: string | undefined;
  let factId: string | undefined;
  try {
    const messages = [
      { info: { role: "user", id: "turno-e8-mem" }, parts: [{ type: "text", text: MEM_QUERY }] },
    ];
    await hooks["experimental.chat.messages.transform"]({}, { messages });
    const injected = String(messages[0]?.parts[1]?.text ?? "");

    factId = marker(injected, "id");
    episodeId = marker(injected, "ep");
    assert.ok(factId, `bloco sem [id=…]; injetado: ${injected.slice(0, 300)}`);
    assert.ok(episodeId, `bloco sem [ep=…]; injetado: ${injected.slice(0, 300)}`);
    // A entrada que a tool exige: uuid COMPLETO.
    assert.ok(isValidUuid(factId), `[id=…] não é uuid canônico: ${factId}`);
    assert.ok(isValidUuid(episodeId), `[ep=…] não é uuid canônico: ${episodeId}`);
    assert.equal(factId.length, 36);
    assert.equal(episodeId.length, 36);
    // O bloco não carrega score (decisão 3 da E8).
    assert.doesNotMatch(injected, /score=/);
  } finally {
    await hooks.dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }

  // 2) IDA-E-VOLTA: o id do EPISÓDIO resolve o `content` no servidor real.
  const resolved = await post("/v1/memory/episodes", MEM_TOKEN, {
    workspace: MEM_WS,
    program: PROGRAM,
    uuids: [episodeId],
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.json.resolved, 1, JSON.stringify(resolved.json).slice(0, 300));
  const episodes = resolved.json.episodes as Array<Record<string, unknown>>;
  assert.equal(episodes[0]?.uuid, episodeId, "o uuid devolvido é o injetado");
  assert.ok(
    typeof episodes[0]?.content === "string" && (episodes[0]!.content as string).length > 0,
    "o episódio tem de trazer `content` não vazio",
  );

  // CONTRA-PROVA: o uuid do FATO não é a chave do episódio (`uuids`, não `uuid`).
  const counter = await post("/v1/memory/episodes", MEM_TOKEN, {
    workspace: MEM_WS,
    program: PROGRAM,
    uuids: [factId],
  });
  assert.equal(counter.status, 200);
  assert.equal(counter.json.resolved, 0, "o uuid do fato NÃO resolve episódio");

  // E o campo singular é 422 (o contrato é `uuids: []`).
  const singular = await post("/v1/memory/episodes", MEM_TOKEN, {
    workspace: MEM_WS,
    program: PROGRAM,
    uuid: episodeId,
  });
  assert.equal(singular.status, 422, "`uuid` singular deve ser 422 (campo é `uuids`)");
});

// --- 3: código — [id=…] do chunk → code_neighbors ---------------------------

test("e2e: [id=…] do chunk navega em code_neighbors (200)", {
  skip: !E2E || !CODE_TOKEN,
}, async () => {
  const { dir, hooks } = await boot(CODE_WS, CODE_TOKEN, {
    // Pina o piso (`""` ⇒ ausente ⇒ default `undefined`): a máquina de dev pode
    // ter `KILOCODE_GRAPH_INJECT_CODE_MIN_SCORE` setada, e o piso do AMBIENTE
    // filtraria o chunk do probe por um motivo que não é o alvo deste teste.
    inject: { enabled: false, code_enabled: true, max_code_chunks: 3, code_min_score: "" },
    mcp: { enabled: true },
    code_index: { enabled: false },
  });
  let chunkId: string | undefined;
  try {
    const messages = [
      { info: { role: "user", id: "turno-e8-code" }, parts: [{ type: "text", text: CODE_QUERY }] },
    ];
    await hooks["experimental.chat.messages.transform"]({}, { messages });
    const injected = String(messages[0]?.parts[1]?.text ?? "");
    chunkId = marker(injected, "id");
    assert.ok(chunkId, `bloco de código sem [id=…]; injetado: ${injected.slice(0, 300)}`);
    assert.ok(isValidUuid(chunkId), `[id=…] não é uuid canônico: ${chunkId}`);
    assert.equal(chunkId.length, 36);
  } finally {
    await hooks.dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }

  // 3) IDA-E-VOLTA: o uuid do chunk é entrada válida de `code_neighbors`.
  const neighbors = await post("/v1/code/neighbors", CODE_TOKEN, {
    workspace: CODE_WS,
    program: PROGRAM,
    uuid: chunkId,
  });
  assert.equal(neighbors.status, 200, JSON.stringify(neighbors.json).slice(0, 300));
  assert.ok(Array.isArray(neighbors.json.neighbors), "resposta tem `neighbors` (mesmo [])");
});

// --- 4: system.transform derivado da config --------------------------------

test("e2e: system.transform cita memória e omite código com code_index desligado", {
  skip: !E2E || !MEM_TOKEN,
}, async () => {
  const { dir, hooks } = await boot(MEM_WS, MEM_TOKEN, {
    inject: { enabled: true },
    mcp: { enabled: true },
    code_index: { enabled: false },
  });
  try {
    const out = { system: ["prompt do host"] };
    await hooks["experimental.chat.system.transform"]({ model: {} }, out);
    assert.equal(out.system.length, 2);
    assert.equal(out.system[0], "prompt do host");
    const text = out.system[1]!;
    assert.ok(text.includes("memory_neighbors"));
    assert.ok(text.includes("memory_episodes"));
    assert.ok(text.includes("memory_neighbors"));
    assert.ok(!text.includes("code_search"));
    assert.ok(!text.includes("code_neighbors"));
    assert.ok(!text.includes("code_sync"));
    assert.ok(!text.includes("ingest"));
  } finally {
    await hooks.dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- token do workspace de memória: o E2E não passa por acidente ------------

test("e2e: workspace pinado resolve o nome derivado do diretório", {
  skip: !E2E,
}, () => {
  const { dir } = makeWorkspace(MEM_WS, "");
  rmSync(dir, { recursive: true, force: true });
  assert.match(workspaceName(dir), new RegExp(`^${MEM_WS}-[0-9a-f]{8}$`));
});

// --- 5: a própria rota de recall do client traz uuid/episodes ---------------

test("e2e: recall do client traz uuid e episodes (contrato v1.1.0)", {
  skip: !E2E || !MEM_TOKEN,
}, async () => {
  const client = new MemtierClient({
    url: MEMTIER_URL,
    workspace: MEM_WS,
    program: PROGRAM,
    token: MEM_TOKEN,
  });
  const result = await client.recall(MEM_QUERY, { limit: 3, maxTokens: 2000 });
  assert.ok(result.facts.length > 0);
  const withIds = result.facts.filter(
    (f) => isValidUuid(f.uuid) && Array.isArray(f.episodes) && f.episodes.length > 0,
  );
  assert.ok(
    withIds.length > 0,
    `nenhum fato com uuid+episodes; primeiros: ${JSON.stringify(result.facts[0])}`,
  );
  for (const episode of withIds[0]!.episodes!) {
    assert.ok(isValidUuid(episode), `episode fora da forma canônica: ${episode}`);
  }
});

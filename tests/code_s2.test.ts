/**
 * E3c-S2 — endurecimento da injeção de código: paralelismo com o recall,
 * orçamento de CONTAGEM das duas famílias (ADR-009: sem teto conjunto em chars)
 * e dedup do chunk por turno. Nenhum teste abre socket (client/fetch stubados).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MemtierClient, type FetchLike } from "../src/client.ts";
import type { CodeChunkHit, Fact } from "../src/client.ts";
import { applyJointBudget } from "../src/inject/budget.ts";
import {
  messagesHook,
  type TransformMessage,
} from "../src/hooks/messages.ts";

function fact(text: string): Fact {
  return { fact: text, valid_at: null, invalid_at: null, score: 1 };
}

function chunk(over: Partial<CodeChunkHit> = {}): CodeChunkHit {
  return {
    path: "src/db.rs",
    symbol: "connect",
    start_line: 1,
    end_line: 5,
    code: "fn connect() {}\n",
    score: 1,
    match: "hybrid",
    ...over,
  };
}

/** `fetch` que despacha recall vs code/search; permite atraso/erro por perna. */
function legFetch(opts: {
  facts?: Fact[];
  chunks?: CodeChunkHit[];
  recallDelayMs?: number;
  searchDelayMs?: number;
  recallStatus?: number;
  searchStatus?: number;
  onRecallBody?: (body: Record<string, unknown>) => void;
  onSearchBody?: (body: Record<string, unknown>) => void;
}): FetchLike {
  return async (input, init) => {
    const url = String(input);
    if (url.includes("/v1/recall")) {
      if (opts.recallDelayMs) await new Promise((r) => setTimeout(r, opts.recallDelayMs));
      if (opts.onRecallBody) {
        opts.onRecallBody(
          JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        );
      }
      const status = opts.recallStatus ?? 200;
      return new Response(JSON.stringify({ facts: opts.facts ?? [] }), { status });
    }
    if (url.includes("/v1/code/search")) {
      if (opts.searchDelayMs) await new Promise((r) => setTimeout(r, opts.searchDelayMs));
      if (opts.onSearchBody) {
        opts.onSearchBody(
          JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        );
      }
      const status = opts.searchStatus ?? 200;
      return new Response(JSON.stringify({ chunks: opts.chunks ?? [] }), { status });
    }
    return new Response("not found", { status: 404 });
  };
}

function rtClient(fetchImpl: FetchLike): MemtierClient {
  return new MemtierClient({
    url: "http://memtier:8400",
    workspace: "ws",
    fetch: fetchImpl,
  });
}

function userTurn(text: string, id = "turno-1"): TransformMessage[] {
  return [{ info: { role: "user", id }, parts: [{ type: "text", text }] }];
}

function hook(client: MemtierClient, over: {
  enabled?: boolean;
  codeEnabled?: boolean;
  maxMemories?: number;
  maxCodeChunks?: number;
  memoryMaxTokens?: number;
  codeMaxTokens?: number;
} = {}) {
  return messagesHook({
    enabled: over.enabled ?? true,
    cfg: {
      maxMemories: over.maxMemories ?? 5,
      ...(over.memoryMaxTokens !== undefined ? { memoryMaxTokens: over.memoryMaxTokens } : {}),
    },
    codeEnabled: over.codeEnabled ?? true,
    codeCfg: {
      maxCodeChunks: over.maxCodeChunks ?? 3,
      ...(over.codeMaxTokens !== undefined ? { codeMaxTokens: over.codeMaxTokens } : {}),
    },
    client,
  });
}

// --- orçamento de CONTAGEM das duas famílias (ADR-009) ----------------------

test("joint_budget_counts_only: cortes independentes por contagem; nenhum corte por char", () => {
  const facts = Array.from({ length: 8 }, (_v, i) => fact(`fato longo numero ${i} `.repeat(6)));
  const chunks = [
    chunk({ path: "src/a.rs", code: "x".repeat(900) }),
    chunk({ path: "src/b.rs", code: "y".repeat(900) }),
    chunk({ path: "src/c.rs", code: "z".repeat(900) }),
    chunk({ path: "src/d.rs", code: "w".repeat(900) }),
  ];
  const { facts: f, chunks: c } = applyJointBudget(facts, chunks, {
    maxMemories: 3,
    maxCodeChunks: 2,
  });
  // Slices independentes: memória corta em 3, código corta em 2.
  assert.equal(f.length, 3);
  assert.equal(c.length, 2);
  // Nenhum item foi descartado por tamanho (nada de corte por char): o chunk de
  // 900 chars sobrevive porque o teto é de CONTAGEM, não de volume.
  assert.equal(c[0]?.path, "src/a.rs");
  assert.equal(c[1]?.path, "src/b.rs");
});

test("joint_budget_zero_family: teto de contagem <=0 ⇒ família vazia (não injeta tudo)", () => {
  const facts = [fact("a"), fact("b")];
  const chunks = [chunk(), chunk({ path: "b" })];
  const { facts: f, chunks: c } = applyJointBudget(facts, chunks, {
    maxMemories: 0,
    maxCodeChunks: 3,
  });
  assert.equal(f.length, 0, "maxMemories<=0 ⇒ sem memória");
  assert.equal(c.length, 2, "o código segue com o seu próprio teto");
  const r2 = applyJointBudget(facts, chunks, { maxMemories: 5, maxCodeChunks: 0 });
  assert.equal(r2.facts.length, 2);
  assert.equal(r2.chunks.length, 0, "maxCodeChunks<=0 ⇒ sem código");
});

// --- paralelismo ------------------------------------------------------------

test("parallel_not_serial: recall 200ms + busca 200ms ⇒ turno < ~400ms", async () => {
  const client = rtClient(
    legFetch({
      facts: [fact("f")],
      chunks: [chunk()],
      recallDelayMs: 200,
      searchDelayMs: 200,
    }),
  );
  const messages = userTurn("q");
  const start = Date.now();
  await hook(client)["experimental.chat.messages.transform"]({}, { messages });
  const elapsed = Date.now() - start;
  assert.ok(
    elapsed < 400,
    `deve rodar em paralelo (~200ms), não a soma sequencial (${elapsed}ms)`,
  );
  // Ambos os blocos vieram.
  assert.equal(messages[0]?.parts.length, 3);
});

// --- degradação parcial -----------------------------------------------------

test("partial_failure_memory_only: busca 503 ⇒ bloco de memória sai; sem código; não lança", async () => {
  const client = rtClient(
    legFetch({ facts: [fact("f0")], searchStatus: 503 }),
  );
  const messages = userTurn("q");
  await assert.doesNotReject(() =>
    hook(client)["experimental.chat.messages.transform"]({}, { messages }),
  );
  assert.equal(messages[0]?.parts.length, 2);
  assert.match(String(messages[0]?.parts[1]?.text), /graph-memory="true"/);
  assert.doesNotMatch(String(messages[0]?.parts[1]?.text), /graph-code="true"/);
});

test("partial_failure_code_only: recall 503 ⇒ bloco de código sai; sem memória", async () => {
  const client = rtClient(
    legFetch({ recallStatus: 503, chunks: [chunk()] }),
  );
  const messages = userTurn("q");
  await assert.doesNotReject(() =>
    hook(client)["experimental.chat.messages.transform"]({}, { messages }),
  );
  assert.equal(messages[0]?.parts.length, 2);
  assert.match(String(messages[0]?.parts[1]?.text), /graph-code="true"/);
  assert.doesNotMatch(String(messages[0]?.parts[1]?.text), /graph-memory="true"/);
});

// --- dedup ------------------------------------------------------------------

test("dedup_same_turn_code: transform 2× no mesmo turno ⇒ injeta 1 bloco de código", async () => {
  const client = rtClient(legFetch({ chunks: [chunk()] }));
  const h = hook(client);
  const first = userTurn("q", "turno-1");
  await h["experimental.chat.messages.transform"]({}, { messages: first });
  assert.equal(first[0]?.parts.length, 2, "1ª passada injeta o código");
  const second = userTurn("q", "turno-1");
  await h["experimental.chat.messages.transform"]({}, { messages: second });
  assert.equal(second[0]?.parts.length, 1, "mesmo turno ⇒ não reinjeta");
});

test("dedup_chunk_identity: mesmo chunk (path:ini-fim) não repete no bloco", async () => {
  // A própria resposta traz o MESMO chunk duas vezes (mesma identidade
  // `path:start-end`): o bloco injeta o chunk uma só vez.
  const client = rtClient(
    legFetch({ chunks: [chunk(), chunk({ score: 0.9 })] }),
  );
  const h = hook(client);
  const t1 = userTurn("q", "turno-1");
  await h["experimental.chat.messages.transform"]({}, { messages: t1 });
  const injected = String(t1[0]?.parts[1]?.text ?? "");
  assert.equal(injected.match(/src\/db\.rs:1-5/g)?.length, 1, "chunk não se repete");

  // Turno NOVO mas mesmo chunk: o dedup é por turno, então reinjeta.
  const t2 = userTurn("q", "turno-2");
  await h["experimental.chat.messages.transform"]({}, { messages: t2 });
  assert.equal(t2[0]?.parts.length, 2, "turno novo reinjeta o chunk");
});

test("dedup_new_turn_code: turno novo ⇒ injeta de novo", async () => {
  const client = rtClient(legFetch({ chunks: [chunk()] }));
  const h = hook(client);
  const t1 = userTurn("q", "turno-A");
  await h["experimental.chat.messages.transform"]({}, { messages: t1 });
  assert.equal(t1[0]?.parts.length, 2);
  const t2 = userTurn("q", "turno-B");
  await h["experimental.chat.messages.transform"]({}, { messages: t2 });
  assert.equal(t2[0]?.parts.length, 2, "turno diferente injeta de novo");
});

// --- tetos por endpoint (ADR-009): cada body com o SEU max_tokens ------------

test("code_body_uses_code_tokens: config de código ⇒ body de code com max_tokens", async () => {
  let recallBody: Record<string, unknown> = {};
  let searchBody: Record<string, unknown> = {};
  const client = rtClient(
    legFetch({
      facts: [fact("a")],
      chunks: [chunk()],
      onRecallBody: (b) => {
        recallBody = b;
      },
      onSearchBody: (b) => {
        searchBody = b;
      },
    }),
  );
  const messages = userTurn("q");
  await hook(client, { memoryMaxTokens: 1500, codeMaxTokens: 4000 })[
    "experimental.chat.messages.transform"
  ]({}, { messages });
  // Cada endpoint carrega o SEU teto no próprio body (dois valores distintos).
  assert.equal(recallBody.max_tokens, 1500, "recall usa o teto de memória");
  assert.equal(searchBody.max_tokens, 4000, "code/search usa o teto de código");
});

test("endpoints_independent: os dois tetos NÃO se misturam entre os bodies", async () => {
  let recallBody: Record<string, unknown> = {};
  let searchBody: Record<string, unknown> = {};
  const client = rtClient(
    legFetch({
      facts: [fact("a")],
      chunks: [chunk()],
      onRecallBody: (b) => {
        recallBody = b;
      },
      onSearchBody: (b) => {
        searchBody = b;
      },
    }),
  );
  const messages = userTurn("q");
  await hook(client, { memoryMaxTokens: 1500, codeMaxTokens: 4000 })[
    "experimental.chat.messages.transform"
  ]({}, { messages });
  // Discriminação: o teto de memória NUNCA chega ao body de código e vice-versa.
  assert.notEqual(recallBody.max_tokens, searchBody.max_tokens);
  assert.notEqual(recallBody.max_tokens, 4000, "código não vaza para o recall");
  assert.notEqual(searchBody.max_tokens, 1500, "memória não vaza para o code");
});

// --- orçamento de contagem na fiação real do hook ---------------------------

test("hook_joint_budget: tetos de contagem independentes por família (ADR-009)", async () => {
  const facts = Array.from({ length: 8 }, (_v, i) => fact(`fato ${i} `.repeat(8)));
  const codeChunks = [
    chunk({ path: "src/a.rs", code: "k".repeat(200) }),
    chunk({ path: "src/b.rs", code: "k".repeat(200) }),
    chunk({ path: "src/c.rs", code: "k".repeat(200) }),
    chunk({ path: "src/d.rs", code: "k".repeat(200) }),
  ];
  const client = rtClient(legFetch({ facts, chunks: codeChunks }));
  const messages = userTurn("q");
  await hook(client, { maxMemories: 3, maxCodeChunks: 2 })[
    "experimental.chat.messages.transform"
  ]({}, { messages });
  const parts = messages[0]?.parts ?? [];
  const codePart = String(parts.find((p) => String(p.text).includes("graph-code"))?.text ?? "");
  const memoryPart = String(parts.find((p) => String(p.text).includes("graph-memory"))?.text ?? "");
  // Cada família obedece só ao SEU teto de contagem.
  assert.equal(memoryPart.match(/^- /gm)?.length, 3, "3 fatos de memória");
  assert.equal(codePart.match(/\[CÓDIGO RELEVANTE/g)?.length, 2, "2 chunks de código");
});

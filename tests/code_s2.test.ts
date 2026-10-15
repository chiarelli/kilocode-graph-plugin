/**
 * E3c-S2 — endurecimento da injeção de código: paralelismo com o recall,
 * orçamento do TOTAL (`maxChars`, código prioritário) e dedup do chunk por
 * turno. Nenhum teste abre socket (client/fetch stubados).
 *
 * Cobre a tabela de testes da E3c-S2 (spec §E3c-S2).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MemtierClient, type FetchLike } from "../src/client.ts";
import type { CodeChunkHit, Fact } from "../src/client.ts";
import { applyJointBudget } from "../src/inject/budget.ts";
import { formatMemoryBlock } from "../src/inject/memory.ts";
import { formatCodeBlock } from "../src/inject/code.ts";
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

/** Mede o TOTAL exatamente como o orquestrador (bloco de memória + de código). */
function renderTotal(facts: Fact[], chunks: CodeChunkHit[]): number {
  return (formatMemoryBlock(facts)?.length ?? 0) + (formatCodeBlock(chunks)?.length ?? 0);
}

/** `fetch` que despacha recall vs code/search; permite atraso/erro por perna. */
function legFetch(opts: {
  facts?: Fact[];
  chunks?: CodeChunkHit[];
  recallDelayMs?: number;
  searchDelayMs?: number;
  recallStatus?: number;
  searchStatus?: number;
}): FetchLike {
  return async (input) => {
    const url = String(input);
    if (url.includes("/v1/recall")) {
      if (opts.recallDelayMs) await new Promise((r) => setTimeout(r, opts.recallDelayMs));
      const status = opts.recallStatus ?? 200;
      return new Response(JSON.stringify({ facts: opts.facts ?? [] }), { status });
    }
    if (url.includes("/v1/code/search")) {
      if (opts.searchDelayMs) await new Promise((r) => setTimeout(r, opts.searchDelayMs));
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
  maxChars?: number;
} = {}) {
  return messagesHook({
    enabled: over.enabled ?? true,
    cfg: {
      maxMemories: over.maxMemories ?? 5,
      ...(over.maxChars !== undefined ? { maxChars: over.maxChars } : {}),
    },
    codeEnabled: over.codeEnabled ?? true,
    codeCfg: { maxCodeChunks: over.maxCodeChunks ?? 3 },
    client,
  });
}

// --- orçamento do TOTAL (applyJointBudget, puro) ----------------------------

test("budget_total_chars: total > maxChars ⇒ corta fatos de memória ANTES de chunks", () => {
  const facts = Array.from({ length: 5 }, (_v, i) => fact(`fato ${i} `.repeat(6)));
  const chunks = [chunk({ path: "src/a.rs", code: "x".repeat(120) })];
  // Teto justo acima do bloco de código: sobra pouco para a memória, que cede
  // ANTES do chunk (código prioritário).
  const chunkLen = formatCodeBlock(chunks)?.length ?? 0;
  const cfg = { maxMemories: 5, maxCodeChunks: 3, maxChars: chunkLen + 60 };
  const { facts: keptFacts, chunks: keptChunks } = applyJointBudget(
    facts,
    chunks,
    cfg,
    renderTotal,
  );
  assert.ok(keptFacts.length < 5, "a memória deve ceder primeiro");
  assert.equal(keptChunks.length, 1, "o chunk de código sobrevive");
  assert.ok(renderTotal(keptFacts, keptChunks) <= cfg.maxChars);
});

test("budget_code_priority: ainda acima após cortar toda a memória ⇒ só então corta chunks", () => {
  // Este chunk sozinho estoura o teto; a memória já foi toda removida.
  const chunkGrande = chunk({ code: "y".repeat(500) });
  const cfg = { maxMemories: 5, maxCodeChunks: 3, maxChars: 400 };
  const { facts, chunks } = applyJointBudget(
    [fact("m1")],
    [chunkGrande, chunk({ path: "src/b.rs", code: "z".repeat(200) })],
    cfg,
    renderTotal,
  );
  assert.equal(facts.length, 0, "memória cedeu inteira antes de qualquer chunk");
  assert.ok(chunks.length < 2, "só depois o código cede (do fim)");
});

test("chunk_never_half: 1 chunk maior que o teto restante ⇒ descartado inteiro", () => {
  const grande = chunk({ code: "w".repeat(900) });
  const { facts, chunks } = applyJointBudget(
    [fact("m")],
    [grande],
    { maxMemories: 5, maxCodeChunks: 3, maxChars: 100 },
    renderTotal,
  );
  assert.equal(facts.length, 0);
  assert.equal(chunks.length, 0, "chunk descartado inteiro, nunca pela metade");
});

test("budget_no_cap: maxChars undefined ⇒ corta só por maxMemories/maxCodeChunks", () => {
  const facts = [fact("a"), fact("b"), fact("c"), fact("d")];
  const chunks = [chunk(), chunk({ path: "b" }), chunk({ path: "c" }), chunk({ path: "d" })];
  const { facts: f, chunks: c } = applyJointBudget(
    facts,
    chunks,
    { maxMemories: 2, maxCodeChunks: 1 },
    renderTotal,
  );
  assert.equal(f.length, 2);
  assert.equal(c.length, 1);
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

// --- orçamento conjunto na fiação real do hook ------------------------------

test("hook_joint_budget: maxChars corta a memória antes de tocar no código", async () => {
  const facts = Array.from({ length: 5 }, (_v, i) => fact(`fato ${i} `.repeat(8)));
  const codeChunks = [chunk({ code: "k".repeat(200) })];
  const codeLen = formatCodeBlock(codeChunks)?.length ?? 0;
  const client = rtClient(legFetch({ facts, chunks: codeChunks }));
  const messages = userTurn("q");
  await hook(client, { maxMemories: 5, maxCodeChunks: 3, maxChars: codeLen + 60 })[
    "experimental.chat.messages.transform"
  ]({}, { messages });
  // O bloco de código sai; o de memória foi podado (ou sumiu).
  const parts = messages[0]?.parts ?? [];
  const codePart = parts.find((p) => String(p.text).includes("graph-code"));
  assert.ok(codePart, "o código sobrevive ao corte");
  const memoryPart = parts.find((p) => String(p.text).includes("graph-memory"));
  if (memoryPart) {
    const totalLen = parts
      .slice(1)
      .reduce((n, p) => n + String(p.text).length, 0);
    assert.ok(totalLen <= codeLen + 60, "o total respeita o teto conjunto");
  }
});

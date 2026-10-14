/**
 * E2-S1 — injeção de memória: `client.recall`, formatação do bloco e o hook
 * `messages.transform`. Nenhum teste abre socket (client/fetch stubados).
 *
 * Cobre a tabela de testes da E2-S1 (spec §E2-S1) mais o corpo do recall.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { AuthError, MemtierClient, type FetchLike } from "../src/client.ts";
import {
  MEMORY_HEADER,
  MEMORY_SENTINEL,
  MemoryInjector,
  formatMemoryBlock,
  recallAndFormat,
} from "../src/inject/memory.ts";
import { applyBudget } from "../src/inject/budget.ts";
import type { Fact } from "../src/client.ts";
import { injectMemoryIntoMessages, type TransformMessage } from "../src/hooks/messages.ts";

/** Stub de `fetch` que captura o request e devolve `{ facts }` (ou o status dado). */
function recallFetch(
  facts: Fact[],
  onBody?: (body: Record<string, unknown>) => void,
  status = 200,
): FetchLike {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    onBody?.(body);
    return new Response(JSON.stringify({ facts }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function fact(text: string, validAt: string | null = null): Fact {
  return { fact: text, valid_at: validAt, invalid_at: null, score: 1 };
}

test("recall_body_shape: body tem workspace/program/query/limit/max_tokens", async () => {
  let body: Record<string, unknown> = {};
  const client = new MemtierClient({
    url: "http://memtier:8400",
    workspace: "waweb",
    program: "default",
    fetch: recallFetch([], (b) => {
      body = b;
    }),
  });
  await client.recall("onde fica o billing", { limit: 5, maxTokens: 2000 });
  assert.equal(body.workspace, "waweb");
  assert.equal(body.program, "default");
  assert.equal(body.query, "onde fica o billing");
  assert.equal(body.limit, 5);
  assert.equal(body.max_tokens, 2000);
});

test("recall_omits_optional_fields: sem opts ⇒ só identidade+query", async () => {
  let body: Record<string, unknown> = {};
  const client = new MemtierClient({
    url: "http://memtier:8400",
    workspace: "ws",
    fetch: recallFetch([], (b) => {
      body = b;
    }),
  });
  await client.recall("q");
  assert.deepEqual(Object.keys(body).sort(), ["program", "query", "workspace"]);
});

test("recall_parses_facts: 200 com 2 fatos ⇒ facts.length==2", async () => {
  const client = new MemtierClient({
    url: "http://memtier:8400",
    workspace: "ws",
    fetch: recallFetch([fact("a"), fact("b")]),
  });
  const result = await client.recall("q", { limit: 5 });
  assert.equal(result.facts.length, 2);
  assert.equal(result.facts[0]?.fact, "a");
});

test("recall_parses_budget_envelope: tokens_estimated/truncated mapeados", async () => {
  const client = new MemtierClient({
    url: "http://memtier:8400",
    workspace: "ws",
    fetch: async () =>
      new Response(
        JSON.stringify({ facts: [fact("a")], tokens_estimated: 42, truncated: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });
  const result = await client.recall("q", { maxTokens: 100 });
  assert.equal(result.tokensEstimated, 42);
  assert.equal(result.truncated, true);
});

test("recall_401_typed: 401 ⇒ erro tipado (não cru)", async () => {
  const client = new MemtierClient({
    url: "http://memtier:8400",
    workspace: "ws",
    fetch: async () => new Response("unauthorized", { status: 401 }),
  });
  await assert.rejects(
    () => client.recall("q"),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test("format_block_provenance: 2 fatos ⇒ sentinela graph-memory + cabeçalho", () => {
  const block = formatMemoryBlock([fact("fato um", "2026-04-22"), fact("fato dois")]);
  assert.ok(block);
  assert.match(block, new RegExp(`<context ${MEMORY_SENTINEL}="true">`));
  assert.match(block, new RegExp(MEMORY_HEADER.replace(/[[\]]/g, "\\$&")));
  assert.match(block, /- fato um \(válido desde 2026-04-22\)/);
  assert.match(block, /- fato dois/);
  // Fato sem valid_at não mostra data.
  assert.doesNotMatch(block, /fato dois \(válido desde/);
});

test("format_block_empty: 0 fatos ⇒ null (não injeta bloco vazio)", () => {
  assert.equal(formatMemoryBlock([]), null);
});

test("apply_budget_maxmemories: 8 fatos, max 5 ⇒ 5 fatos", () => {
  const facts = Array.from({ length: 8 }, (_v, i) => fact(`f${i}`));
  const kept = applyBudget(facts, { maxMemories: 5 });
  assert.equal(kept.length, 5);
  assert.equal(kept[0]?.fact, "f0");
});

test("recall_and_format: orçamento aplicado antes de formatar", async () => {
  const client = new MemtierClient({
    url: "http://memtier:8400",
    workspace: "ws",
    fetch: recallFetch([
      fact("f0"),
      fact("f1"),
      fact("f2"),
    ]),
  });
  const block = await recallAndFormat(client, { maxMemories: 2 }, "q");
  assert.ok(block);
  assert.match(block, /- f0/);
  assert.match(block, /- f1/);
  assert.doesNotMatch(block, /- f2/);
});

// --- hook messages.transform ------------------------------------------------

interface RuntimeOpts {
  enabled?: boolean;
  maxMemories?: number;
  maxChars?: number;
  maxTokens?: number;
  timeoutMs?: number;
  healthGate?: boolean;
  status?: number;
}

/** Monta `enabled` + injector (uma instância, como `messagesHook` no boot). */
function rt(facts: Fact[], overrides: RuntimeOpts = {}) {
  const client = new MemtierClient({
    url: "http://memtier:8400",
    workspace: "ws",
    fetch: recallFetch(facts, undefined, overrides.status ?? 200),
  });
  const cfg = {
    maxMemories: overrides.maxMemories ?? 5,
    ...(overrides.maxChars !== undefined ? { maxChars: overrides.maxChars } : {}),
    ...(overrides.maxTokens !== undefined ? { maxTokens: overrides.maxTokens } : {}),
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
    ...(overrides.healthGate !== undefined ? { healthGate: overrides.healthGate } : {}),
  };
  return {
    enabled: overrides.enabled ?? true,
    injector: new MemoryInjector(client, cfg),
  };
}

function userTurn(text: string): TransformMessage[] {
  return [{ info: { role: "user" }, parts: [{ type: "text", text }] }];
}

test("transform_injects: messages com 1 user ⇒ part novo no último user", async () => {
  const messages = userTurn("qual o timeout do billing?");
  const { enabled, injector } = rt([fact("timeout = 30s")]);
  await injectMemoryIntoMessages(messages, enabled, injector);
  assert.equal(messages[0]?.parts.length, 2);
  assert.match(String(messages[0]?.parts[1]?.text), /timeout = 30s/);
  assert.match(String(messages[0]?.parts[1]?.text), /graph-memory="true"/);
});

test("transform_disabled: inject.enabled=false ⇒ nenhum part novo", async () => {
  const messages = userTurn("q");
  const { enabled, injector } = rt([fact("x")], { enabled: false });
  await injectMemoryIntoMessages(messages, enabled, injector);
  assert.equal(messages[0]?.parts.length, 1);
});

test("transform_no_user: só assistant ⇒ não injeta", async () => {
  const messages: TransformMessage[] = [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "oi" }] },
  ];
  const { enabled, injector } = rt([fact("x")]);
  await injectMemoryIntoMessages(messages, enabled, injector);
  assert.equal(messages[0]?.parts.length, 1);
});

test("transform_no_recall: 0 fatos ⇒ não injeta bloco vazio", async () => {
  const messages = userTurn("q");
  const { enabled, injector } = rt([]);
  await injectMemoryIntoMessages(messages, enabled, injector);
  assert.equal(messages[0]?.parts.length, 1);
});

test("transform_recall_fails: recall lança ⇒ hook não lança; sem part", async () => {
  const messages = userTurn("q");
  const injector = new MemoryInjector(
    {
      recall: async () => {
        throw new Error("ECONNREFUSED");
      },
    },
    { maxMemories: 5 },
  );
  await assert.doesNotReject(() =>
    injectMemoryIntoMessages(messages, true, injector),
  );
  assert.equal(messages[0]?.parts.length, 1);
});

// --- E2-S2: orçamento, max_tokens, dedup, degradação ------------------------

/** Render do bloco para medir o teto de chars (mesmo formato do memory.ts). */
const renderBlock = (facts: Fact[]): string => formatMemoryBlock(facts) ?? "";

test("budget_maxchars_whole_facts: 5 fatos longos, max 100 chars ⇒ fatos inteiros", () => {
  const facts = Array.from({ length: 5 }, (_v, i) =>
    fact(`fato suficientemente longo numero ${i} para estourar o teto`),
  );
  const kept = applyBudget(facts, { maxMemories: 5, maxChars: 100 }, renderBlock);
  assert.ok(kept.length < 5, "deve cortar fatos inteiros");
  assert.ok(renderBlock(kept).length <= 100, "bloco cabe no teto");
  // Nenhum fato veio pela metade.
  for (const k of kept) assert.ok(facts.some((f) => f.fact === k.fact));
});

test("budget_maxchars_drops_all_when_single_fact_too_long", () => {
  const facts = [fact("x".repeat(500))];
  const kept = applyBudget(facts, { maxMemories: 5, maxChars: 20 }, renderBlock);
  assert.equal(kept.length, 0);
});

test("budget_sends_max_tokens: config ⇒ request tem max_tokens", async () => {
  let body: Record<string, unknown> = {};
  const client = new MemtierClient({
    url: "http://memtier:8400",
    workspace: "ws",
    fetch: recallFetch([fact("a")], (b) => {
      body = b;
    }),
  });
  await recallAndFormat(client, { maxMemories: 5, maxTokens: 2000 }, "q");
  assert.equal(body.max_tokens, 2000);
});

test("budget_respects_truncated: truncated ⇒ log + bloco usa o que veio", async () => {
  const client = new MemtierClient({
    url: "http://memtier:8400",
    workspace: "ws",
    fetch: async () =>
      new Response(
        JSON.stringify({
          facts: [fact("só o primeiro")],
          tokens_estimated: 2000,
          truncated: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });
  const logPath = "/tmp/kilocode-graph-plugin.log";
  const before = readFileSync(logPath, "utf-8").length;
  const block = await recallAndFormat(client, { maxMemories: 5, maxTokens: 2000 }, "q");
  assert.ok(block);
  assert.match(block, /só o primeiro/);
  const appended = readFileSync(logPath, "utf-8").slice(before);
  assert.match(appended, /recall truncated/, "truncated deve ser logado");
});

test("dedup_same_turn: transform 2× mesmo turno ⇒ injeta 1×", async () => {
  const { enabled, injector } = rt([fact("fato fixo")]);
  const first = userTurn("mesma pergunta");
  await injectMemoryIntoMessages(first, enabled, injector);
  assert.equal(first[0]?.parts.length, 2);
  const second = userTurn("mesma pergunta");
  await injectMemoryIntoMessages(second, enabled, injector);
  assert.equal(second[0]?.parts.length, 1, "não reinjeta o mesmo fato no turno");
});

test("dedup_new_turn_clears: turno novo ⇒ injeta de novo", async () => {
  const { enabled, injector } = rt([fact("fato fixo")]);
  const first = userTurn("pergunta um");
  await injectMemoryIntoMessages(first, enabled, injector);
  const second = userTurn("pergunta dois");
  await injectMemoryIntoMessages(second, enabled, injector);
  assert.equal(second[0]?.parts.length, 2, "turno novo reinjeta");
});

test("auth_error_logged: 401 ⇒ log visível (não silencioso); sem part", async () => {
  const messages = userTurn("q");
  const { enabled, injector } = rt([], { status: 401 });
  const logPath = "/tmp/kilocode-graph-plugin.log";
  const before = readFileSync(logPath, "utf-8").length;
  await assert.doesNotReject(() =>
    injectMemoryIntoMessages(messages, enabled, injector),
  );
  assert.equal(messages[0]?.parts.length, 1);
  const appended = readFileSync(logPath, "utf-8").slice(before);
  assert.match(appended, /recall auth \(401\)/, "401 deve gerar log visível");
});

test("health_gate_blocks_recall: health degradado ⇒ sem part", async () => {
  const messages = userTurn("q");
  const injector = new MemoryInjector(
    {
      recall: async () => {
        throw new Error("recall não deveria ser chamado");
      },
      health: async () => ({
        ok: false,
        status: "degraded",
        falkordb: "down",
        indices: "not_ready",
        error: null,
      }),
    },
    { maxMemories: 5, healthGate: true },
  );
  await injectMemoryIntoMessages(messages, true, injector);
  assert.equal(messages[0]?.parts.length, 1);
});

test("observability_log: inject loga recall_ms/facts/injected_chars", async () => {
  const { injector } = rt([fact("f0"), fact("f1")], { maxMemories: 5 });
  const logPath = "/tmp/kilocode-graph-plugin.log";
  const before = readFileSync(logPath, "utf-8").length;
  const injection = await injector.inject("q");
  assert.ok(injection);
  assert.equal(injection.facts, 2);
  assert.equal(injection.chars, injection.block.length);
  assert.ok(injection.recallMs >= 0);
  const appended = readFileSync(logPath, "utf-8").slice(before);
  assert.match(appended, /inject recall_ms=\d+ facts=2 injected_chars=\d+/);
});

test("timeout_no_inject: recall pendura ⇒ aborta; sem injeção; turno segue", async () => {
  const messages = userTurn("q");
  const client = new MemtierClient({
    url: "http://memtier:8400",
    workspace: "ws",
    recall_timeout_ms: 20,
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error("no abort")), 1000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
  });
  const injector = new MemoryInjector(client, { maxMemories: 5, timeoutMs: 20 });
  const start = Date.now();
  await assert.doesNotReject(() =>
    injectMemoryIntoMessages(messages, true, injector),
  );
  assert.equal(messages[0]?.parts.length, 1);
  assert.ok(Date.now() - start < 900, "deve abortar no timeout, não pendurar");
});

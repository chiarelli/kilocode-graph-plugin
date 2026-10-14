/**
 * E2-S1 — injeção de memória: `client.recall`, formatação do bloco e o hook
 * `messages.transform`. Nenhum teste abre socket (client/fetch stubados).
 *
 * Cobre a tabela de testes da E2-S1 (spec §E2-S1) mais o corpo do recall.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AuthError, MemtierClient, type FetchLike } from "../src/client.ts";
import {
  MEMORY_HEADER,
  MEMORY_SENTINEL,
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

function rt(facts: Fact[], overrides: Partial<{ enabled: boolean; maxMemories: number }> = {}) {
  const client = new MemtierClient({
    url: "http://memtier:8400",
    workspace: "ws",
    fetch: recallFetch(facts),
  });
  return {
    enabled: overrides.enabled ?? true,
    cfg: { maxMemories: overrides.maxMemories ?? 5 },
    client,
  };
}

function userTurn(text: string): TransformMessage[] {
  return [{ info: { role: "user" }, parts: [{ type: "text", text }] }];
}

test("transform_injects: messages com 1 user ⇒ part novo no último user", async () => {
  const messages = userTurn("qual o timeout do billing?");
  await injectMemoryIntoMessages(messages, rt([fact("timeout = 30s")]));
  assert.equal(messages[0]?.parts.length, 2);
  assert.match(String(messages[0]?.parts[1]?.text), /timeout = 30s/);
  assert.match(String(messages[0]?.parts[1]?.text), /graph-memory="true"/);
});

test("transform_disabled: inject.enabled=false ⇒ nenhum part novo", async () => {
  const messages = userTurn("q");
  await injectMemoryIntoMessages(messages, rt([fact("x")], { enabled: false }));
  assert.equal(messages[0]?.parts.length, 1);
});

test("transform_no_user: só assistant ⇒ não injeta", async () => {
  const messages: TransformMessage[] = [
    { info: { role: "assistant" }, parts: [{ type: "text", text: "oi" }] },
  ];
  await injectMemoryIntoMessages(messages, rt([fact("x")]));
  assert.equal(messages[0]?.parts.length, 1);
});

test("transform_no_recall: 0 fatos ⇒ não injeta bloco vazio", async () => {
  const messages = userTurn("q");
  await injectMemoryIntoMessages(messages, rt([]));
  assert.equal(messages[0]?.parts.length, 1);
});

test("transform_recall_fails: recall lança ⇒ hook não lança; sem part", async () => {
  const messages = userTurn("q");
  const failing = {
    client: {
      recall: async () => {
        throw new Error("ECONNREFUSED");
      },
    },
  };
  await assert.doesNotReject(() =>
    injectMemoryIntoMessages(messages, {
      enabled: true,
      cfg: { maxMemories: 5 },
      ...failing,
    }),
  );
  assert.equal(messages[0]?.parts.length, 1);
});

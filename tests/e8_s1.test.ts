/**
 * E8-S1 — identidade no bloco injetado: `uuid`/`episodes` no fio, marcadores
 * `[id=<uuid>]`/`[ep=<uuid> +N]` nos dois blocos, `factKey` e a mesma validação.
 *
 * Cobre a tabela de testes da spec §E8-S1. Nenhum teste abre socket: o client
 * é stubado. `formatFact`/`chunkHeader` são privados — os testes de marcador
 * entram por `formatMemoryBlock`/`formatCodeBlock`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { CodeChunkHit, Fact } from "../src/client.ts";
import { CodeInjector } from "../src/inject/code.ts";
import { formatCodeBlock } from "../src/inject/code.ts";
import { MemoryInjector, factKey, formatMemoryBlock, recallAndFormat } from "../src/inject/memory.ts";
import { isValidUuid } from "../src/inject/uuid.ts";
import { __setLogSink } from "../src/logger.ts";

const UUID_A = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const UUID_B = "cdd38cb4-7eea-4b8f-9f13-3c1e6a2b9d47";
const UUID_C = "11111111-2222-4333-8444-555555555555";

function fact(over: Partial<Fact> = {}): Fact {
  return {
    fact: "fato um",
    valid_at: null,
    invalid_at: null,
    score: 1,
    ...over,
  };
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

/** Stub estreito de recall (sem rede). */
function recallStub(facts: Fact[]) {
  return { recall: async () => ({ facts }) };
}

/** Stub estreito de busca (sem rede). */
function searchStub(chunks: CodeChunkHit[]) {
  return { searchCode: async () => ({ chunks }) };
}

/** Captura as linhas de log do escopo e devolve a lista. */
async function captureLogs(fn: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  __setLogSink((line) => lines.push(line));
  try {
    await fn();
  } finally {
    __setLogSink(null);
  }
  return lines;
}

// --- marcadores de memória --------------------------------------------------

test("fact_marker_full_uuid: uuid + 1 episódio ⇒ [id=…] e [ep=…]", () => {
  const block = formatMemoryBlock([fact({ uuid: UUID_A, episodes: [UUID_B] })]);
  assert.ok(block);
  assert.match(block, new RegExp(`\\[id=${UUID_A}\\]`));
  assert.match(block, new RegExp(`\\[ep=${UUID_B}\\]`));
  const id = block.match(/\[id=([^\]]+)\]/)?.[1];
  assert.equal(id?.length, 36, "o uuid vai COMPLETO");
});

test("fact_marker_plus_n: 3 episódios ⇒ [ep=<primeiro> +2]", () => {
  const block = formatMemoryBlock([
    fact({ uuid: UUID_A, episodes: [UUID_B, UUID_C, UUID_A] }),
  ]);
  assert.ok(block);
  assert.match(block, new RegExp(`\\[ep=${UUID_B} \\+2\\]`));
  // Os outros dois não aparecem como marcador.
  assert.equal(block.match(/\[ep=/g)?.length, 1);
});

test("fact_marker_no_uuid: sem uuid/episodes ⇒ linha byte-idêntica", () => {
  const block = formatMemoryBlock([fact({ valid_at: "2026-01-02T00:00:00Z" })]);
  assert.ok(block);
  const line = block.split("\n").find((l) => l.startsWith("- "));
  assert.equal(line, "- fato um (válido desde 2026-01-02T00:00:00Z)");
});

test("fact_marker_ep_without_id: episódio sem uuid do fato ⇒ só [ep=…]", () => {
  const block = formatMemoryBlock([fact({ episodes: [UUID_B] })]);
  assert.ok(block);
  assert.match(block, new RegExp(`\\[ep=${UUID_B}\\]`));
  assert.ok(!block.includes("[id="), "sem uuid do fato não há [id=]");
});

test("fact_marker_malformed_uuid: uuid curto ⇒ marcador omitido, pura não loga", async () => {
  const lines = await captureLogs(() => {
    const block = formatMemoryBlock([fact({ uuid: "cdd38cb4-7eea" })]);
    assert.ok(block);
    assert.ok(!block.includes("[id="));
  });
  assert.equal(lines.length, 0, "formatFact é pura — nunca loga");
});

test("malformed_uuid_warn_once: 2 fatos, prepare 2× no turno ⇒ 1 aviso", async () => {
  const injector = new MemoryInjector(
    recallStub([fact({ fact: "a", uuid: "torto" }), fact({ fact: "b", uuid: "x" })]),
    { maxMemories: 5 },
  );
  const lines = await captureLogs(async () => {
    await injector.prepare("t1", "q");
    await injector.prepare("t1", "q");
  });
  const warns = lines.filter((l) => l.includes("fora do formato"));
  assert.equal(warns.length, 1, lines.join("\n"));
  assert.match(warns[0]!, /2 item/);
});

test("malformed_uuid_counts_items_not_fields: 1 fato com uuid E episódio tortos ⇒ 1 item", async () => {
  const injector = new MemoryInjector(
    recallStub([fact({ uuid: "torto", episodes: ["outro-torto"] })]),
    { maxMemories: 5 },
  );
  const lines = await captureLogs(async () => {
    await injector.prepare("t1", "q");
  });
  const warns = lines.filter((l) => l.includes("fora do formato"));
  assert.equal(warns.length, 1, lines.join("\n"));
  // O contador conta o ITEM, não os dois campos afetados.
  assert.match(warns[0]!, /1 item/);
});

test("episodes_not_array_warns_and_omits: campo fora do contrato ⇒ sem [ep=] + aviso", async () => {
  const injector = new MemoryInjector(
    // Servidor fora do contrato: `episodes` como string em vez de lista.
    recallStub([fact({ uuid: UUID_A, episodes: UUID_B as unknown as string[] })]),
    { maxMemories: 5 },
  );
  const lines = await captureLogs(async () => {
    const prep = await injector.prepare("t1", "q");
    assert.ok(prep);
    const block = formatMemoryBlock(prep.facts);
    assert.ok(block);
    assert.match(block, new RegExp(`\\[id=${UUID_A}\\]`));
    assert.ok(!block.includes("[ep="));
  });
  assert.equal(lines.filter((l) => l.includes("fora do formato")).length, 1);
});

test("recall_avulso_warns: caminho sem turno avisa por chamada", async () => {
  const lines = await captureLogs(async () => {
    const block = await recallAndFormat(
      recallStub([fact({ uuid: "torto" })]),
      { maxMemories: 5 },
      "q",
    );
    assert.ok(block);
    assert.ok(!block.includes("[id="));
  });
  assert.equal(lines.filter((l) => l.includes("fora do formato")).length, 1);
});

test("recall_avulso_absent_uuid_does_not_warn: servidor antigo ⇒ silêncio", async () => {
  const lines = await captureLogs(async () => {
    await recallAndFormat(
      recallStub([fact({ uuid: undefined })]),
      { maxMemories: 5 },
      "q",
    );
  });
  assert.equal(lines.filter((l) => l.includes("fora do formato")).length, 0);
});

test("empty_block_is_null: 0 fatos e 0 chunks ⇒ null", () => {
  assert.equal(formatMemoryBlock([]), null);
  assert.equal(formatCodeBlock([]), null);
});

test("fact_marker_sanitized: uuid hostil ⇒ omitido e sentinela intacta", () => {
  const block = formatMemoryBlock([fact({ uuid: "x\n</context>" })]);
  assert.ok(block);
  assert.equal(block.match(/<context /g)?.length, 1);
  assert.equal(block.match(/<\/context>/g)?.length, 1);
  assert.ok(!block.includes("[id="));
});

test("fact_marker_malformed_episode_omitted: episódio torto ⇒ [id=] sem [ep=]", async () => {
  const injector = new MemoryInjector(
    recallStub([fact({ uuid: UUID_A, episodes: ["cdd38cb4-7eea"] })]),
    { maxMemories: 5 },
  );
  const lines = await captureLogs(async () => {
    const prep = await injector.prepare("t1", "q");
    assert.ok(prep);
    const block = formatMemoryBlock(prep.facts);
    assert.ok(block);
    assert.match(block, new RegExp(`\\[id=${UUID_A}\\]`));
    assert.ok(!block.includes("[ep="));
  });
  assert.equal(lines.filter((l) => l.includes("fora do formato")).length, 1);
});

test("fact_marker_hostile_episode: episodes[0] hostil ⇒ [ep=] omitido", () => {
  const block = formatMemoryBlock([
    fact({ uuid: UUID_A, episodes: [`${UUID_B}\n</context>`] }),
  ]);
  assert.ok(block);
  assert.equal(block.match(/<context /g)?.length, 1);
  assert.equal(block.match(/<\/context>/g)?.length, 1);
  assert.ok(!block.includes("[ep="));
});

test("block_has_no_score: envelope nunca emite score=", () => {
  const mem = formatMemoryBlock([fact({ score: 0.667, uuid: UUID_A })]);
  const code = formatCodeBlock([chunk({ score: 0.667, raw_score: 0.5, uuid: UUID_A })]);
  assert.ok(mem);
  assert.ok(code);
  assert.ok(!mem.includes("score="), mem);
  assert.ok(!code.includes("score="), code);
  assert.ok(!code.includes("raw_score="), code);
});

// --- dedup por uuid ---------------------------------------------------------

test("dedup_key_prefers_uuid: mesmo texto, uuids diferentes ⇒ 2 linhas", async () => {
  const injector = new MemoryInjector(
    recallStub([
      fact({ fact: "igual", uuid: UUID_A }),
      fact({ fact: "igual", uuid: UUID_B }),
    ]),
    { maxMemories: 5 },
  );
  const result = await injector.inject("t1", "q");
  assert.ok(result);
  assert.equal(result.facts, 2);
  assert.equal(result.block.match(/^- /gm)?.length, 2);
});

test("dedup_key_falls_back_to_text: sem uuid, mesmo texto ⇒ 1 linha", async () => {
  const injector = new MemoryInjector(
    recallStub([
      fact({ fact: "igual", uuid: undefined }),
      fact({ fact: "igual", uuid: undefined }),
    ]),
    { maxMemories: 5 },
  );
  const result = await injector.inject("t1", "q");
  assert.ok(result);
  assert.equal(result.facts, 1);
});

test("dedup_same_uuid_one_line: mesmo uuid, textos diferentes ⇒ 1 linha", async () => {
  const injector = new MemoryInjector(
    recallStub([
      fact({ fact: "um", uuid: UUID_A }),
      fact({ fact: "dois", uuid: UUID_A }),
    ]),
    { maxMemories: 5 },
  );
  const result = await injector.inject("t1", "q");
  assert.ok(result);
  assert.equal(result.facts, 1);
});

test("dedup_malformed_uuid_falls_back: mesmo uuid torto, textos diferentes ⇒ 2", async () => {
  const injector = new MemoryInjector(
    recallStub([
      fact({ fact: "um", uuid: "torto" }),
      fact({ fact: "dois", uuid: "torto" }),
    ]),
    { maxMemories: 5 },
  );
  const lines = await captureLogs(async () => {
    const result = await injector.inject("t1", "q");
    assert.ok(result);
    assert.equal(result.block.match(/^- /gm)?.length, 2);
  });
  assert.equal(lines.filter((l) => l.includes("fora do formato")).length, 1);
});

test("dedup_empty_uuid_falls_back: uuid \"\", textos diferentes ⇒ 2 linhas", async () => {
  const injector = new MemoryInjector(
    recallStub([
      fact({ fact: "um", uuid: "" }),
      fact({ fact: "dois", uuid: "" }),
    ]),
    { maxMemories: 5 },
  );
  const result = await injector.inject("t1", "q");
  assert.ok(result);
  assert.equal(result.facts, 2);
});

// --- unidades exportadas ----------------------------------------------------

test("is_valid_uuid_shape: 36 chars, hífens nas posições 8/13/18/23 ⇒ true", () => {
  assert.equal(UUID_A.length, 36);
  assert.equal(isValidUuid(UUID_A), true);
  assert.equal(isValidUuid(UUID_C), true);
});

test("is_valid_uuid_rejects: 35 chars, sem hífens, maiúsculo, null, \"\" ⇒ false", () => {
  assert.equal(isValidUuid(UUID_A.slice(0, 35)), false);
  assert.equal(isValidUuid(UUID_A.replace(/-/g, "")), false);
  assert.equal(isValidUuid(UUID_A.toUpperCase()), false);
  assert.equal(isValidUuid(null), false);
  assert.equal(isValidUuid(undefined), false);
  assert.equal(isValidUuid(""), false);
  assert.equal(isValidUuid(42), false);
});

test("is_valid_uuid_rejects_misplaced_hyphens: 36 chars, hífen fora de 8/13/18/23", () => {
  // 36 chars, mas os hífens caem em 4/9/14/19 em vez de 8/13/18/23.
  const moved = "3f25-04e0-4f89-11d3-9a0c0305e82c3301";
  assert.equal(moved.length, 36);
  assert.equal(isValidUuid(moved), false);
  // Sem o 1º hífen (32 chars): também fora da forma canônica.
  assert.equal(isValidUuid("3f2504e04f89-11d3-9a0c-0305e82c3301"), false);
});

test("fact_key_prefers_valid_uuid: uuid válido vence o texto", () => {
  assert.equal(factKey(fact({ uuid: UUID_A })), UUID_A);
});

test("fact_key_falls_back_with_prefix: sem uuid válido usa text:<texto>", () => {
  assert.equal(factKey(fact({ fact: "oi", uuid: "" })), "text:oi");
  assert.equal(factKey(fact({ fact: "oi", uuid: "torto" })), "text:oi");
  assert.equal(factKey(fact({ fact: "oi" })), "text:oi");
});

// --- marcadores de código ---------------------------------------------------

test("chunk_marker_full_uuid: chunk com uuid ⇒ cabeçalho + [id=…]", () => {
  const block = formatCodeBlock([chunk({ uuid: UUID_A })]);
  assert.ok(block);
  assert.match(
    block,
    new RegExp(`\\[CÓDIGO RELEVANTE — src/db\\.rs:1-5\\] \\[id=${UUID_A}\\]`),
  );
});

test("chunk_marker_no_uuid: chunk sem uuid ⇒ cabeçalho atual, sem marcador", () => {
  const block = formatCodeBlock([chunk()]);
  assert.ok(block);
  assert.match(block, /\[CÓDIGO RELEVANTE — src\/db\.rs:1-5\]\n/);
  assert.ok(!block.includes("[id="));
});

test("code_marker_malformed_warns: 2 chunks tortos, prepare 2× ⇒ 1 aviso", async () => {
  const injector = new CodeInjector(
    searchStub([
      chunk({ uuid: "torto" }),
      chunk({ path: "src/other.rs", uuid: "outro-torto" }),
    ]),
    { maxCodeChunks: 3 },
  );
  const lines = await captureLogs(async () => {
    const first = await injector.prepare("t1", "q");
    assert.ok(first);
    const block = formatCodeBlock(first.chunks);
    assert.ok(block);
    assert.ok(!block.includes("[id="));
    await injector.prepare("t1", "q");
  });
  assert.equal(lines.filter((l) => l.includes("fora do formato")).length, 1);
});

test("code_absent_uuid_does_not_warn: servidor antigo ⇒ nenhum aviso", async () => {
  const injector = new CodeInjector(searchStub([chunk()]), { maxCodeChunks: 3 });
  const lines = await captureLogs(async () => {
    await injector.prepare("t1", "q");
  });
  assert.equal(lines.filter((l) => l.includes("fora do formato")).length, 0);
});

/**
 * S2 (ADR-009 Bloco A) — E2E de FECHAMENTO dos tetos por endpoint (gated `E2E=1`).
 *
 * Prova, contra a stack REAL (sem mock de infra), que `memory_max_tokens` e
 * `code_max_tokens` limitam **cada bloco de forma independente**:
 *   - teto de memória pequeno ⇒ bloco de memória cortado; bloco de CÓDIGO intacto;
 *   - teto de código pequeno  ⇒ bloco de código cortado; bloco de MEMÓRIA intacto;
 *   - os dois distintos       ⇒ cada bloco obedece só ao SEU teto.
 *
 * A evidência é o **bloco injetado** (o efeito), nunca o retorno da chamada: o
 * servidor devolve um **prefixo** da lista quando `max_tokens` trunca (medido), de
 * modo que o teto pequeno produz menos fatos/chunks que o teto grande.
 *
 * Pré-requisito do bearer: `/v1/recall` e `/v1/code/search` são rotas PROTEGIDAS.
 * O workspace `alfa` (`E2E_TOKEN` = `e2e-tok-a`) tem fatos de memória E chunks de
 * código (o seed do E2E do daemon), então um ÚNICO boot enxerga as duas famílias.
 * Sem token, em `E2E=1`, o teste **FALHA** (nunca skippa silencioso — mesma regra
 * do E2E da E3c).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import pluginModule from "../../src/index.ts";

const E2E = process.env.E2E === "1";
const MEMTIER_URL = process.env.KILOCODE_GRAPH_URL ?? "http://127.0.0.1:8400";
/** Bearer do workspace com as DUAS famílias (fatos de memória E chunks). */
const TOKEN = process.env.E2E_TOKEN ?? process.env.KILOCODE_GRAPH_TOKEN ?? "";
const WS = process.env.E2E_WS ?? "alfa";
const PROGRAM = process.env.E2E_PROGRAM ?? "default";
/** Query que casa fatos de memória E chunks de código no workspace `alfa`. */
const QUERY = process.env.E2E_LIMITS_QUERY ?? "losartana";

/** Teto pequeno vs grande, por endpoint (medidos: cortam a lista do servidor). */
const MEM_SMALL = 200;
const MEM_LARGE = 2000;
const CODE_SMALL = 400;
const CODE_LARGE = 2000;

/** Monta um workspace real: dir cujo basename resolve para `WS` + token_file. */
function makeWorkspace(): { dir: string; tokenFile: string } {
  const base = mkdtempSync(join(tmpdir(), "graph-limits-e2e-"));
  const dir = join(base, WS);
  const kiloDir = join(dir, ".kilo");
  mkdirSync(kiloDir, { recursive: true });
  const tokenFile = join(kiloDir, "graph-key.json");
  writeFileSync(
    tokenFile,
    JSON.stringify({ token: TOKEN, workspace: WS, program: PROGRAM }),
  );
  return { dir, tokenFile };
}

/** Blocos injetados no turno (contagem por bloco), após um boot+transform reais. */
async function injectTurn(opts: {
  memoryMaxTokens: number;
  codeMaxTokens: number;
  turnoId: string;
}): Promise<{ memFacts: number; codeChunks: number }> {
  const { dir, tokenFile } = makeWorkspace();
  try {
    // O token é escopado ao nome EXATO (`alfa`); o boot PINA a identidade via
    // `daemon.workspace` (o derivado carrega o hash do caminho ⇒ 403).
    const hooks = await pluginModule.server(
      { directory: dir, worktree: null },
      {
        daemon: {
          url: MEMTIER_URL,
          token_file: tokenFile,
          program: PROGRAM,
          workspace: WS,
          health_timeout_ms: 3000,
        },
        inject: {
          enabled: true,
          code_enabled: true,
          max_memories: 5,
          max_code_chunks: 3,
          memory_max_tokens: opts.memoryMaxTokens,
          code_max_tokens: opts.codeMaxTokens,
          timeout_ms: 4000,
        },
        // Coleta (E3a) fica desligada: o grafo de `alfa` já tem os chunks do seed.
        code_index: { enabled: false },
        debug: true,
      },
    );
    const transform = hooks["experimental.chat.messages.transform"];
    assert.ok(transform, "o hook messages.transform deve estar registrado");

    const messages = [
      { info: { role: "user", id: opts.turnoId }, parts: [{ type: "text", text: QUERY }] },
    ];
    await transform({}, { messages });
    await hooks.dispose?.();

    const parts = messages[0]?.parts ?? [];
    const memPart = String(
      parts.find((p) => String(p.text ?? "").includes('graph-memory="true"'))?.text ?? "",
    );
    const codePart = String(
      parts.find((p) => String(p.text ?? "").includes('graph-code="true"'))?.text ?? "",
    );
    // Um fato por linha `- `; um chunk por cabeçalho `[CÓDIGO RELEVANTE`.
    const memFacts = memPart.match(/^- /gm)?.length ?? 0;
    const codeChunks = codePart.match(/\[CÓDIGO RELEVANTE/g)?.length ?? 0;
    return { memFacts, codeChunks };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("e2e_memory_tokens_limits_block: teto de memória pequeno corta a memória; código intacto", {
  skip: !E2E,
}, async () => {
  assert.ok(
    TOKEN,
    "E2E_TOKEN ausente: o E2E dos tetos exige o bearer do workspace com fatos+código",
  );

  const high = await injectTurn({
    memoryMaxTokens: MEM_LARGE,
    codeMaxTokens: CODE_LARGE,
    turnoId: "lim-mem-high",
  });
  const low = await injectTurn({
    memoryMaxTokens: MEM_SMALL,
    codeMaxTokens: CODE_LARGE,
    turnoId: "lim-mem-low",
  });

  // Efeito no bloco de MEMÓRIA: o teto pequeno devolve menos fatos (prefixo).
  assert.ok(high.memFacts >= 2, `baseline de memória insuficiente: ${high.memFacts}`);
  assert.ok(
    low.memFacts < high.memFacts,
    `teto de memória não cortou: low=${low.memFacts} high=${high.memFacts}`,
  );
  // Efeito no bloco de CÓDIGO: INTACTO (o teto de memória não o toca).
  assert.equal(
    low.codeChunks,
    high.codeChunks,
    `teto de memória mexeu no bloco de código: low=${low.codeChunks} high=${high.codeChunks}`,
  );
  assert.ok(high.codeChunks >= 1, "baseline de código vazio (grafo de alfa sem chunks)");
});

test("e2e_code_tokens_limits_block: teto de código pequeno corta o código; memória intacta", {
  skip: !E2E,
}, async () => {
  assert.ok(
    TOKEN,
    "E2E_TOKEN ausente: o E2E dos tetos exige o bearer do workspace com fatos+código",
  );

  const high = await injectTurn({
    memoryMaxTokens: MEM_LARGE,
    codeMaxTokens: CODE_LARGE,
    turnoId: "lim-code-high",
  });
  const low = await injectTurn({
    memoryMaxTokens: MEM_LARGE,
    codeMaxTokens: CODE_SMALL,
    turnoId: "lim-code-low",
  });

  // Efeito no bloco de CÓDIGO: o teto pequeno devolve menos chunks (prefixo).
  assert.ok(high.codeChunks >= 2, `baseline de código insuficiente: ${high.codeChunks}`);
  assert.ok(
    low.codeChunks < high.codeChunks,
    `teto de código não cortou: low=${low.codeChunks} high=${high.codeChunks}`,
  );
  // Efeito no bloco de MEMÓRIA: INTACTO (o teto de código não o toca).
  assert.equal(
    low.memFacts,
    high.memFacts,
    `teto de código mexeu no bloco de memória: low=${low.memFacts} high=${high.memFacts}`,
  );
});

test("e2e_endpoints_independent: cada bloco obedece só ao SEU teto (distintos)", {
  skip: !E2E,
}, async () => {
  assert.ok(
    TOKEN,
    "E2E_TOKEN ausente: o E2E dos tetos exige o bearer do workspace com fatos+código",
  );

  // Os dois pequenos e DISTINTOS: memória corta pela SUA cota, código pela dele.
  const both = await injectTurn({
    memoryMaxTokens: MEM_SMALL,
    codeMaxTokens: CODE_SMALL,
    turnoId: "lim-both-small",
  });
  // Baselines independentes (um endpoint grande de cada vez).
  const memLowOnly = await injectTurn({
    memoryMaxTokens: MEM_SMALL,
    codeMaxTokens: CODE_LARGE,
    turnoId: "lim-indep-mem",
  });
  const codeLowOnly = await injectTurn({
    memoryMaxTokens: MEM_LARGE,
    codeMaxTokens: CODE_SMALL,
    turnoId: "lim-indep-code",
  });

  // Cada bloco no cenário "ambos pequenos" coincide com o SEU cenário isolado —
  // o teto de um endpoint não influencia o outro.
  assert.equal(both.memFacts, memLowOnly.memFacts, "o teto de código afetou a memória");
  assert.equal(both.codeChunks, codeLowOnly.codeChunks, "o teto de memória afetou o código");
});

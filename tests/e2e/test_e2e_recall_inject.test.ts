/**
 * E2-S3 — E2E real da injeção de memória (gated `E2E=1`).
 *
 * Roda contra a stack REAL do memtier (`127.0.0.1:8400`, de pé), sem mock de
 * infra: o `fetch` é o `globalThis.fetch`. Prova o efeito ponta a ponta exigido
 * pela E2 ("recall real injetado no turno"):
 *
 *   1. Um `POST /v1/recall` real (o MESMO caminho do plugin, via
 *      `MemtierClient.recall`) devolve ≥1 fato do workspace — **efeito do outro
 *      lado**, não o retorno local.
 *   2. O plugin **boota** de verdade (`server(ctx, options)`) com
 *      `inject.enabled=true` e um `token_file` real; o hook
 *      `experimental.chat.messages.transform` injeta o bloco `<context
 *      graph-memory="true">` no último turno do usuário.
 *   3. A latência do recall fica dentro do orçamento de 4s (NFR-01).
 *
 * Pré-requisito do bearer (medido 2026-10-14): `/v1/recall` é rota PROTEGIDA
 * (401 sem token). O token vem do ambiente do próprio E2E
 * (`E2E_TOKEN`/`KILOCODE_GRAPH_TOKEN`) — o MESMO bearer show-once que o daemon
 * usa nos seus E2E (`E2E_TOKEN_A`, escopado ao workspace `alfa`). Sem token a
 * suíte **skippa com motivo explícito** (nunca fabbrica credencial).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MemtierClient } from "../../src/client.ts";
import pluginModule from "../../src/index.ts";
import { workspaceName } from "../../src/workspace.ts";

const E2E = process.env.E2E === "1";
const MEMTIER_URL = process.env.KILOCODE_GRAPH_URL ?? "http://127.0.0.1:8400";
/** Bearer show-once (workspace com fatos). Nunca hardcoded. */
const TOKEN = process.env.E2E_TOKEN ?? process.env.KILOCODE_GRAPH_TOKEN ?? "";
/** Workspace com fatos reais (o seed do E2E do daemon, `alfa`). */
const WS = process.env.E2E_WS ?? "alfa";
/** Programa do escopo do bearer (aditivo E11). Default `default`. */
const PROGRAM = process.env.E2E_PROGRAM ?? "default";
/** Query que casa fatos do workspace (termo do seed). */
const QUERY = process.env.E2E_QUERY ?? "losartan";

const BUDGET_MS = 4000; // NFR-01

/** Monta um workspace real: dir cujo basename resolve para `WS` + token_file. */
function makeWorkspace(): { dir: string; tokenFile: string } {
  const base = mkdtempSync(join(tmpdir(), "graph-e2e-e2-"));
  const dir = join(base, WS);
  const kiloDir = join(dir, ".kilo");
  mkdirSync(kiloDir, { recursive: true });
  const tokenFile = join(kiloDir, "graph-key.json");
  writeFileSync(
    tokenFile,
    JSON.stringify({ token: TOKEN, workspace: WS, program: "default" }),
  );
  return { dir, tokenFile };
}

test("e2e: recall real contra o memtier ⇒ ≥1 fato (efeito do outro lado)", {
  skip: !E2E || !TOKEN,
}, async () => {
  const client = new MemtierClient({
    url: MEMTIER_URL,
    workspace: WS,
    program: PROGRAM,
    token: TOKEN,
    recall_timeout_ms: BUDGET_MS,
  });
  const start = Date.now();
  const result = await client.recall(QUERY, { limit: 5, maxTokens: 2000 });
  const elapsed = Date.now() - start;

  assert.ok(result.facts.length > 0, `recall não trouxe fatos para "${QUERY}"`);
  assert.ok(
    elapsed <= BUDGET_MS,
    `recall estourou o orçamento: ${elapsed}ms > ${BUDGET_MS}ms`,
  );
});

test("e2e: plugin boota com inject.enabled e injeta bloco de memória no turno", {
  skip: !E2E || !TOKEN,
}, async () => {
  const { dir, tokenFile } = makeWorkspace();
  try {
    // O nome DERIVADO agora carrega o hash do caminho; o token legado é escopado
    // ao nome EXATO (`alfa`), então o boot PINA a identidade via
    // `daemon.workspace`. O derivado tem a forma `<stem>-<sha1 8>`.
    assert.match(workspaceName(dir), /^alfa-[0-9a-f]{8}$/);

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
        inject: { enabled: true, max_memories: 5, max_chars: 3000, max_tokens: 2000 },
        debug: true,
      },
    );

    const transform = hooks["experimental.chat.messages.transform"];
    assert.ok(transform, "o hook messages.transform deve estar registrado");

    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: QUERY }] },
    ];
    const start = Date.now();
    await transform({}, { messages });
    const elapsed = Date.now() - start;
    await hooks.dispose?.();

    const parts = messages[0]?.parts ?? [];
    assert.equal(parts.length, 2, "um part de contexto deve ser injetado");
    const injected = String(parts[1]?.text ?? "");
    assert.match(
      injected,
      /<context graph-memory="true">/,
      `bloco de memória ausente; injetado: ${injected.slice(0, 200)}`,
    );
    assert.match(injected, /\[CONTEXTO DE MEMÓRIA\]/);
    assert.match(injected, /^- /m, "ao menos um fato deve aparecer no bloco");
    assert.ok(
      elapsed <= BUDGET_MS,
      `injeção estourou o orçamento: ${elapsed}ms > ${BUDGET_MS}ms`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

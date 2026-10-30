/**
 * E8-S2 — E2E do `system.transform` (gated `E2E=1`).
 *
 * Tracer bullet desta story: `experimental.chat.system.transform` nunca
 * atravessou camada nenhuma deste plugin. O teste **boota o plugin de verdade**
 * (`server(ctx, options)`), pega o hook registrado e o chama como o host chama
 * — provando que a superfície existe no objeto devolvido, que o texto entra, e
 * que o prompt do host NÃO é substituído.
 *
 * A derivação é de CONFIG (decisão 6): não há round-trip ao MCP aqui. O resíduo
 * (MCP registrado mas indisponível ao vivo) é declarado na spec.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import pluginModule from "../../src/index.ts";
import { INSTRUCTION_MAX_CHARS } from "../../src/hooks/system.ts";

const E2E = process.env.E2E === "1";

/** Boota o plugin num diretório temporário, sem daemon alcançável. */
async function boot(options: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "graph-e2e-e8s2-"));
  const hooks = await pluginModule.server(
    { directory: dir, worktree: null },
    {
      daemon: {
        url: "http://127.0.0.1:9",
        token_file: join(dir, "graph-key.json"),
        workspace: "e8s2",
      },
      ...options,
    },
  );
  return { dir, hooks };
}

test("e2e: system.transform entra no prompt sem substituir o host", {
  skip: !E2E,
}, async () => {
  const { dir, hooks } = await boot({
    inject: { enabled: true },
    mcp: { enabled: true },
    code_index: { enabled: false },
  });
  try {
    const transform = hooks["experimental.chat.system.transform"];
    assert.ok(transform, "o hook system.transform deve estar registrado");

    const out = { system: ["prompt do host"] };
    await transform({ model: { id: "modelo-e2e" } }, out);

    assert.equal(out.system.length, 2, "um elemento deve ser acrescentado");
    assert.equal(out.system[0], "prompt do host", "o prompt do host é intacto");
    const text = out.system[1]!;
    assert.ok(text.includes("memory_neighbors"));
    assert.ok(text.includes("memory_episodes"));
    assert.ok(text.includes("recall"));
    // `code_index.enabled=false` ⇒ sem tools de código.
    assert.ok(!text.includes("code_search"));
    assert.ok(!text.includes("code_neighbors"));
    assert.ok(!text.includes("code_sync"));
    assert.ok(!text.includes("ingest"));
    assert.ok(
      text.length <= INSTRUCTION_MAX_CHARS,
      `instrução com ${text.length} chars estoura o teto`,
    );

    // Idempotência real: o host pode chamar o hook mais de uma vez no turno.
    await transform({ model: { id: "modelo-e2e" } }, out);
    assert.equal(out.system.length, 2, "não duplica o texto");
  } finally {
    await hooks.dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: system.transform intacto com mcp desligado", {
  skip: !E2E,
}, async () => {
  const { dir, hooks } = await boot({
    inject: { enabled: true },
    mcp: { enabled: false },
    code_index: { enabled: true },
  });
  try {
    const out = { system: ["prompt do host"] };
    await hooks["experimental.chat.system.transform"]!({ model: {} }, out);
    assert.deepEqual(out.system, ["prompt do host"]);
  } finally {
    await hooks.dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e: system.transform com code_index ligado cita code_search", {
  skip: !E2E,
}, async () => {
  const { dir, hooks } = await boot({
    inject: { enabled: true, code_enabled: false },
    mcp: { enabled: true },
    code_index: { enabled: true },
  });
  try {
    const out = { system: ["prompt do host"] };
    await hooks["experimental.chat.system.transform"]!({ model: {} }, out);
    assert.equal(out.system.length, 2);
    // Pull ≠ push: sem `inject.code_enabled` (bloco desligado), a tool de
    // código continua anunciada porque há conteúdo no grafo.
    assert.ok(out.system[1]!.includes("code_search"));
    assert.ok(out.system[1]!.includes("code_neighbors"));
  } finally {
    await hooks.dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

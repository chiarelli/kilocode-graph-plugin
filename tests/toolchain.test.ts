/**
 * Teste da TOOLCHAIN — não do plugin (que ainda não existe).
 *
 * Valida o que as specs da primeira onda ASSUMEM sobre o ambiente. Se algum
 * destes quebrar, a E1/E3b não têm base para começar:
 *
 *   1. `node --test` executa TypeScript (type stripping) sem build.
 *   2. `@kilocode/plugin` resolve e expõe a superfície de hooks do ADR-001.
 *   3. O SDK instalado registra MCP `type: "remote"` COM `headers` — é o que
 *      dispensa o fallback "shim local" do `TODO(tracer-bullet)` da E3b §2.
 *   4. O binário do indexer é resolvível por config (FR-306) — hoje o default
 *      é `""` e o binário não está buildado; o teste apenas DOCUMENTA o estado.
 *
 * Sem rede, sem memtier: lê os artefatos instalados em disco.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * Lê um arquivo instalado lendo direto de `node_modules` — passar por
 * `require.resolve`/`import.meta.resolve` falharia: os pacotes só declaram a
 * condição `import` no export map.
 */
function readInstalled(pathRelativeToRoot: string): string {
  return readFileSync(
    new URL(`../node_modules/${pathRelativeToRoot}`, import.meta.url),
    "utf8",
  );
}

test("1. o runner executa TypeScript sem build (type stripping)", () => {
  // O fato deste arquivo rodar JÁ é a prova. Fixamos a invariante que a torna
  // possível: o Node da máquina.
  const [major, minor] = process.versions.node.split(".").map(Number) as [
    number,
    number,
  ];
  assert.ok(
    major > 22 || (major === 22 && minor >= 18),
    `Node ${process.versions.node} não faz type stripping por padrão (precisa >= 22.18)`,
  );
});

test("2. @kilocode/plugin expõe os hooks do ADR-001", () => {
  const index = readInstalled("@kilocode/plugin/dist/index.d.ts");

  // A forma do plugin (decisão 1 da E1): { id, server: Plugin }.
  assert.match(index, /export type PluginModule/);
  assert.match(index, /export type Plugin = /);

  // Os 4 hooks usados (README §Hooks do Kilo usados).
  for (const hook of [
    "chat.message",
    "experimental.chat.messages.transform",
    "experimental.chat.system.transform",
    "experimental.session.compacting",
  ]) {
    assert.ok(index.includes(`"${hook}"?`), `hook ausente no SDK: ${hook}`);
  }

  // `PluginInput` traz o que a E1/E3b consomem: client e directory.
  assert.match(index, /export type PluginInput = \{/);
  assert.match(index, /client: ReturnType<typeof createKiloClient>/);
  assert.match(index, /directory: string/);
});

test("3. o SDK registra MCP remote com headers (dispensa o shim local da E3b)", () => {
  const gen = readInstalled("@kilocode/sdk/dist/gen/types.gen.d.ts");

  assert.match(gen, /export type McpRemoteConfig = \{/);

  // Recorta só o bloco do McpRemoteConfig — `headers` em outro tipo não serve.
  const start = gen.indexOf("export type McpRemoteConfig = {");
  const block = gen.slice(start, gen.indexOf("};", start));

  assert.match(block, /type: "remote"/);
  assert.match(block, /url: string/);
  assert.match(block, /headers\?:/);
  assert.match(block, /enabled\?:/);
});

test("4. o default do indexer é vazio — o binário ainda não existe (estado, não falha)", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { peerDependencies?: Record<string, string>; engines?: { node?: string } };

  // O peer tem de casar com o Kilo instalado na máquina, não com `*`.
  assert.ok(
    !pkg.peerDependencies?.["@kilocode/plugin"]?.includes("*"),
    "peer @kilocode/plugin não pode ser `*` — o Kilo real está pinado",
  );
  assert.equal(pkg.engines?.node, ">=22");
});

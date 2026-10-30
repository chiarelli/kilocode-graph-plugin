/**
 * E8-S2 — instrução de sistema derivada do estado (`system.transform`).
 *
 * Cobre a tabela da spec §E8-S2: presença/ausência por config, derivação de
 * tools (pull ≠ push), append sem substituir, idempotência, never-throws, teto
 * de custo e o registro do hook no plugin.
 *
 * Nenhum teste abre socket: o hook é puro (só config efetiva, ADR-004).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  INSTRUCTION_MAX_CHARS,
  appendInstruction,
  buildInstruction,
  systemHook,
  systemRuntimeFrom,
  type SystemRuntime,
} from "../src/hooks/system.ts";
import { DEFAULTS, loadConfig } from "../src/config.ts";
import pluginModule from "../src/index.ts";

function rt(over: Partial<SystemRuntime> = {}): SystemRuntime {
  return {
    enabled: true,
    instructionEnabled: true,
    mcpEnabled: true,
    codeIndexEnabled: true,
    ...over,
  };
}

function instruction(over: Partial<SystemRuntime> = {}): string {
  const text = buildInstruction(rt(over));
  assert.ok(text, "instrução deveria existir");
  return text;
}

// --- presença e derivação de tools -----------------------------------------

test("system_instruction_present: inject+mcp+code_index ⇒ 1 elemento com as 5 tools", () => {
  const out = { system: ["prompt do host"] };
  appendInstruction(rt(), out);
  assert.equal(out.system.length, 2);
  const text = out.system[1]!;
  for (const tool of [
    "recall",
    "memory_episodes",
    "memory_neighbors",
    "code_search",
    "code_neighbors",
  ]) {
    assert.ok(text.includes(tool), `falta a tool ${tool}`);
  }
});

test("system_instruction_pull_only: code_index ligado, inject.code_enabled desligado ⇒ cita código", () => {
  // `SystemRuntime` não tem `code_enabled` por design: a tool é PULL e depende
  // do CONTEÚDO (`code_index.enabled`), nunca do push (`inject.code_enabled`).
  // A derivação passa pela CONFIG de verdade (não só pelo tipo): o runtime é
  // montado do objeto cru, que carrega `code_enabled: false`.
  const runtime = systemRuntimeFrom({
    inject: { enabled: true, instruction_enabled: true, code_enabled: false } as never,
    mcp: { enabled: true },
    code_index: { enabled: true },
  });
  assert.equal(runtime.codeIndexEnabled, true);
  const text = instruction(runtime);
  assert.ok(text.includes("code_search"));
  assert.ok(text.includes("code_neighbors"));
});

test("system_runtime_ignores_code_enabled: push desligado não remove tools de código", () => {
  const on = systemRuntimeFrom({
    inject: { enabled: true, instruction_enabled: true },
    mcp: { enabled: true },
    code_index: { enabled: true },
  });
  const off = systemRuntimeFrom({
    inject: { enabled: true, instruction_enabled: true, code_enabled: false } as never,
    mcp: { enabled: true },
    code_index: { enabled: true },
  });
  assert.deepEqual(off, on, "inject.code_enabled não participa da derivação");
});

test("system_instruction_no_code: code_index desligado ⇒ memória, sem tools de código", () => {
  const text = instruction({ codeIndexEnabled: false });
  assert.ok(text.includes("memory_neighbors"));
  assert.ok(text.includes("memory_episodes"));
  assert.ok(text.includes("recall"));
  assert.ok(!text.includes("code_search"));
  assert.ok(!text.includes("code_neighbors"));
});

test("system_instruction_off: instruction_enabled=false ⇒ array intacto", () => {
  const out = { system: ["prompt do host"] };
  appendInstruction(rt({ instructionEnabled: false }), out);
  assert.deepEqual(out.system, ["prompt do host"]);
});

test("system_instruction_inject_off: inject.enabled=false ⇒ array intacto", () => {
  const out = { system: ["prompt do host"] };
  appendInstruction(rt({ enabled: false }), out);
  assert.deepEqual(out.system, ["prompt do host"]);
});

test("system_instruction_mcp_off: mcp.enabled=false ⇒ array intacto e nenhuma tool", () => {
  const out = { system: ["prompt do host"] };
  const state = rt({ mcpEnabled: false });
  appendInstruction(state, out);
  assert.deepEqual(out.system, ["prompt do host"]);
  assert.equal(buildInstruction(state), null);
});

test("system_instruction_no_write_tools: nunca cita ingest nem code_sync", () => {
  for (const over of [{}, { codeIndexEnabled: false }] as const) {
    const text = instruction(over);
    assert.ok(!/\bingest\b/.test(text), text);
    assert.ok(!/\bcode_sync\b/.test(text), text);
  }
});

test("system_instruction_mentions_uuids_plural: memory_episodes usa `uuids` (array)", () => {
  const text = instruction();
  assert.match(text, /memory_episodes \(uuids/);
});

// --- append, idempotência, robustez ----------------------------------------

test("system_appends_not_replaces: output com 1 item ⇒ len 2, [0] intacto", () => {
  const out = { system: ["prompt do host"] };
  appendInstruction(rt(), out);
  assert.equal(out.system.length, 2);
  assert.equal(out.system[0], "prompt do host");
  assert.ok(out.system[1]!.includes("memory_neighbors"));
});

test("system_idempotent: hook chamado 2× no mesmo output ⇒ 1 ocorrência", async () => {
  const out = { system: ["prompt do host"] };
  const hook = systemHook(rt());
  const fn = hook["experimental.chat.system.transform"];
  await fn({ model: {} }, out);
  await fn({ model: {} }, out);
  assert.equal(out.system.length, 2);
  assert.equal(out.system.filter((s) => s.includes("memory_neighbors")).length, 1);
});

test("system_never_throws: estado malformado não lança e não escreve", () => {
  const out = { system: ["prompt do host"] };
  assert.doesNotThrow(() =>
    appendInstruction(undefined as unknown as SystemRuntime, out),
  );
  assert.deepEqual(out.system, ["prompt do host"]);
});

test("system_output_not_array: system undefined/string ⇒ não lança, nada escrito", () => {
  assert.doesNotThrow(() => appendInstruction(rt(), {}));
  const asString = { system: "prompt do host" as unknown as string[] };
  assert.doesNotThrow(() => appendInstruction(rt(), asString));
  assert.equal(asString.system, "prompt do host");
  assert.doesNotThrow(() =>
    appendInstruction(rt(), undefined as unknown as { system: string[] }),
  );
});

test("instruction_cost_ceiling: texto ≤ INSTRUCTION_MAX_CHARS (chars/4)", () => {
  const full = instruction({ codeIndexEnabled: true });
  assert.ok(
    full.length <= INSTRUCTION_MAX_CHARS,
    `instrução com ${full.length} chars estoura o teto ${INSTRUCTION_MAX_CHARS}`,
  );
  assert.equal(INSTRUCTION_MAX_CHARS, 1000);
});

test("instruction_three_paragraphs: estrutura fixada (o quê / como / ids)", () => {
  const text = instruction();
  const paragraphs = text.split("\n\n");
  assert.equal(paragraphs.length, 3, text);
  assert.match(paragraphs[0]!, /AMOSTRA/);
  assert.match(paragraphs[1]!, /memory_neighbors/);
  assert.match(paragraphs[2]!, /\[id=/);
  assert.match(paragraphs[2]!, /\[ep=/);
});

// --- config -----------------------------------------------------------------

test("config_instruction_default_true: sem env/arquivo ⇒ true", () => {
  assert.equal(DEFAULTS.inject.instruction_enabled, true);
  const dir = mkdtempSync(join(tmpdir(), "e8s2-config-"));
  try {
    assert.equal(loadConfig({}, dir).inject.instruction_enabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config_instruction_env_false_wins: env=false vence o default", () => {
  const dir = mkdtempSync(join(tmpdir(), "e8s2-config-"));
  const previous = process.env.KILOCODE_GRAPH_INJECT_INSTRUCTION_ENABLED;
  process.env.KILOCODE_GRAPH_INJECT_INSTRUCTION_ENABLED = "false";
  try {
    assert.equal(loadConfig({}, dir).inject.instruction_enabled, false);
  } finally {
    if (previous === undefined) delete process.env.KILOCODE_GRAPH_INJECT_INSTRUCTION_ENABLED;
    else process.env.KILOCODE_GRAPH_INJECT_INSTRUCTION_ENABLED = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config_instruction_options_win: options=false vence env=true", () => {
  const dir = mkdtempSync(join(tmpdir(), "e8s2-config-"));
  const previous = process.env.KILOCODE_GRAPH_INJECT_INSTRUCTION_ENABLED;
  process.env.KILOCODE_GRAPH_INJECT_INSTRUCTION_ENABLED = "true";
  try {
    const cfg = loadConfig({ inject: { instruction_enabled: false } }, dir);
    assert.equal(cfg.inject.instruction_enabled, false);
  } finally {
    if (previous === undefined) delete process.env.KILOCODE_GRAPH_INJECT_INSTRUCTION_ENABLED;
    else process.env.KILOCODE_GRAPH_INJECT_INSTRUCTION_ENABLED = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config_instruction_garbage_falls_back: env=\"talvez\" ⇒ default true", () => {
  const dir = mkdtempSync(join(tmpdir(), "e8s2-config-"));
  const previous = process.env.KILOCODE_GRAPH_INJECT_INSTRUCTION_ENABLED;
  process.env.KILOCODE_GRAPH_INJECT_INSTRUCTION_ENABLED = "talvez";
  try {
    assert.equal(loadConfig({}, dir).inject.instruction_enabled, true);
  } finally {
    if (previous === undefined) delete process.env.KILOCODE_GRAPH_INJECT_INSTRUCTION_ENABLED;
    else process.env.KILOCODE_GRAPH_INJECT_INSTRUCTION_ENABLED = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config_instruction_not_persisted: configStateFrom não inclui a chave nova", async () => {
  const { configStateFrom } = await import("../src/config.ts");
  const dir = mkdtempSync(join(tmpdir(), "e8s2-config-"));
  try {
    const state = configStateFrom(loadConfig({}, dir));
    const inject = state.inject as Record<string, unknown>;
    assert.ok(!("instruction_enabled" in inject));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- registro no plugin -----------------------------------------------------

test("system_hook_registered: plugin(ctx) devolve os DOIS hooks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e8s2-boot-"));
  const previousUrl = process.env.KILOCODE_GRAPH_URL;
  // Sem daemon alcançável: o boot não bloqueia no health (background).
  process.env.KILOCODE_GRAPH_URL = "http://127.0.0.1:9";
  try {
    const hooks = await pluginModule.server(
      { directory: dir, worktree: null },
      { daemon: { url: "http://127.0.0.1:9", token_file: join(dir, "key.json") } },
    );
    await hooks.dispose?.();
    assert.equal(typeof hooks["experimental.chat.messages.transform"], "function");
    assert.equal(typeof hooks["experimental.chat.system.transform"], "function");
  } finally {
    if (previousUrl === undefined) delete process.env.KILOCODE_GRAPH_URL;
    else process.env.KILOCODE_GRAPH_URL = previousUrl;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("system_plugin_derives_from_config: inject+mcp ligados ⇒ texto no boot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e8s2-boot-"));
  try {
    const hooks = await pluginModule.server(
      { directory: dir, worktree: null },
      {
        daemon: {
          url: "http://127.0.0.1:9",
          token_file: join(dir, "key.json"),
          workspace: "ws",
        },
        inject: { enabled: true },
        mcp: { enabled: true },
        code_index: { enabled: false },
      },
    );
    const out = { system: ["prompt do host"] };
    await hooks["experimental.chat.system.transform"]({ model: {} }, out);
    await hooks.dispose?.();
    assert.equal(out.system.length, 2);
    assert.equal(out.system[0], "prompt do host");
    assert.ok(out.system[1]!.includes("memory_neighbors"));
    assert.ok(!out.system[1]!.includes("code_search"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

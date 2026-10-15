/**
 * E3b-S1 — `mcp/register.ts`: config pura + fluxo `status`→`add`→`connect` e
 * degradação (nunca lança). Sem rede: `client.mcp` é stubado.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildMcpConfig,
  isValidMcpName,
  registerMemtierMcp,
  scheduleMcpRegistration,
  shouldRefreshMcpRegistration,
  type KiloLikeClient,
  type KiloMcpClient,
  type KiloMcpStatus,
  type McpRegisterConfig,
  type McpRemoteConfig,
} from "../src/mcp/register.ts";
import {
  isMcpDefinedInKiloConfig,
  stripJsoncComments,
  stripTrailingCommas,
} from "../src/mcp/kilo-config.ts";

/** Config base do registro; cada teste sobrescreve o que importa. */
function cfg(overrides: Partial<McpRegisterConfig> = {}): McpRegisterConfig {
  return {
    enabled: true,
    name: "memtier",
    url: "http://127.0.0.1:8400",
    token: "tok-123",
    directory: "/repo",
    timeout_ms: 15000,
    ...overrides,
  };
}

/** Fake de `client.mcp` que registra as chamadas e devolve respostas dadas. */
function fakeMcp(
  opts: {
    status?: KiloMcpStatus | undefined;
    statusError?: unknown;
    addThrows?: boolean;
    addError?: unknown;
    connectError?: unknown;
  } = {},
) {
  const calls: string[] = [];
  const statusMap: Record<string, KiloMcpStatus> = {};
  if (opts.status) statusMap.memtier = opts.status;
  const mcp: KiloMcpClient = {
    status: async () => {
      calls.push("status");
      if (opts.statusError !== undefined) return { error: opts.statusError };
      return { data: statusMap };
    },
    add: async () => {
      calls.push("add");
      if (opts.addThrows) throw new Error("boom");
      if (opts.addError !== undefined) return { error: opts.addError };
      return { data: {} };
    },
    connect: async () => {
      calls.push("connect");
      if (opts.connectError !== undefined) return { error: opts.connectError };
      return { data: {} };
    },
    disconnect: async () => {
      calls.push("disconnect");
      return { data: {} };
    },
  };
  return { client: { mcp } as KiloLikeClient, calls };
}

/** Fake que captura o corpo do `add` (para assertar `timeout`/`enabled`). */
function capturingMcp() {
  const calls: string[] = [];
  let added: { name: string; config: McpRemoteConfig } | undefined;
  const mcp: KiloMcpClient = {
    status: async () => {
      calls.push("status");
      return { data: {} };
    },
    add: async (opts) => {
      calls.push("add");
      added = opts.body as { name: string; config: McpRemoteConfig };
      return { data: {} };
    },
    connect: async () => {
      calls.push("connect");
      return { data: {} };
    },
    disconnect: async () => {
      calls.push("disconnect");
      return { data: {} };
    },
  };
  return { client: { mcp } as KiloLikeClient, calls, added: () => added };
}

// --- buildMcpConfig (puro) -------------------------------------------------

test("build_config_remote: url base vira …/v1/mcp com type remote", () => {
  const config = buildMcpConfig({ url: "http://127.0.0.1:8400", token: "", timeout_ms: 15000 });
  assert.equal(config.type, "remote");
  assert.equal(config.url, "http://127.0.0.1:8400/v1/mcp");
  assert.equal(config.enabled, true);
});

test("build_config_auth: token presente ⇒ header Authorization Bearer", () => {
  const config = buildMcpConfig({ url: "http://memtier:8400", token: "abc", timeout_ms: 15000 });
  assert.equal(config.headers?.Authorization, "Bearer abc");
});

test("build_config_no_token: sem token ⇒ sem header (borda decide 401)", () => {
  const config = buildMcpConfig({ url: "http://memtier:8400", token: "", timeout_ms: 15000 });
  assert.equal(config.headers, undefined);
});

test("build_config_trims_slash: url com barra final não duplica", () => {
  const config = buildMcpConfig({ url: "http://memtier:8400/", token: "", timeout_ms: 15000 });
  assert.equal(config.url, "http://memtier:8400/v1/mcp");
});

// --- registerMemtierMcp ----------------------------------------------------

test("register_adds_and_connects: status vazio ⇒ add + connect", async () => {
  const { client, calls } = fakeMcp();
  await registerMemtierMcp(client, cfg());
  assert.deepEqual(calls, ["status", "add", "connect"]);
});

test("register_skips_when_connected: status connected ⇒ não chama add", async () => {
  const { client, calls } = fakeMcp({ status: { status: "connected" } });
  await registerMemtierMcp(client, cfg());
  assert.deepEqual(calls, ["status"]);
});

test("register_disabled: mcp.enabled=false ⇒ não chama nada", async () => {
  const { client, calls } = fakeMcp();
  await registerMemtierMcp(client, cfg({ enabled: false }));
  assert.deepEqual(calls, []);
});

test("register_add_passes_remote_config: body com name + config remote", async () => {
  let added: { name: string; config: { type: string; url: string } } | undefined;
  const client: KiloLikeClient = {
    mcp: {
      status: async () => ({ data: {} }),
      add: async (opts) => {
        added = opts.body as never;
        return { data: {} };
      },
      connect: async () => ({ data: {} }),
      disconnect: async () => ({ data: {} }),
    },
  };
  await registerMemtierMcp(client, cfg());
  assert.equal(added?.name, "memtier");
  assert.equal(added?.config.type, "remote");
  assert.equal(added?.config.url, "http://127.0.0.1:8400/v1/mcp");
});

test("register_failure_not_fatal: add lança ⇒ não propaga", async () => {
  const { client } = fakeMcp({ addThrows: true });
  await assert.doesNotReject(() => registerMemtierMcp(client, cfg()));
});

test("register_status_error: status devolve erro ⇒ não registra", async () => {
  const { client, calls } = fakeMcp({ statusError: { status: 500 } });
  await registerMemtierMcp(client, cfg());
  assert.deepEqual(calls, ["status"]);
});

test("register_connect_error: connect devolve erro ⇒ não lança", async () => {
  const { client } = fakeMcp({ connectError: { status: 500 } });
  await assert.doesNotReject(() => registerMemtierMcp(client, cfg()));
});

// --- E3b-S2: override, refresh, SDK antigo ---------------------------------

/** Diretório temporário com um `kilo.jsonc` (e cleanup). */
function withKiloConfig(content: string, fn: (dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "graph-mcp-"));
  try {
    mkdirSync(join(dir, ".kilo"), { recursive: true });
    writeFileSync(join(dir, ".kilo", "kilo.jsonc"), content);
    return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

test("override_skips: kilo.jsonc com mcp.memtier ⇒ plugin não registra", async () => {
  const { client, calls } = fakeMcp();
  await withKiloConfig(
    `{ "mcp": { "memtier": { "type": "remote", "url": "http://other:1/v1/mcp" } } }`,
    async (dir) => {
      await registerMemtierMcp(client, cfg({ directory: dir }));
    },
  );
  assert.deepEqual(calls, [], "com override não deve nem consultar o cliente");
});

test("override_comments: kilo.jsonc com // não confunde o parse", async () => {
  const { client, calls } = fakeMcp();
  await withKiloConfig(
    `{\n  // servidor definido pelo usuário\n  "mcp": { "memtier": { "type": "remote" } }\n}`,
    async (dir) => {
      await registerMemtierMcp(client, cfg({ directory: dir }));
    },
  );
  assert.deepEqual(calls, []);
});

test("no_override_registers: kilo.jsonc sem mcp.memtier ⇒ registra", async () => {
  const { client, calls } = fakeMcp();
  await withKiloConfig(`{ "mcp": { "outro": {} } }`, async (dir) => {
    await registerMemtierMcp(client, cfg({ directory: dir }));
  });
  assert.deepEqual(calls, ["status", "add", "connect"]);
});

test("shouldRefresh_true_on_failed", () => {
  assert.equal(shouldRefreshMcpRegistration({ status: "failed" }), true);
  assert.equal(
    shouldRefreshMcpRegistration({ status: "failed", error: "spawn ENOENT" }),
    true,
  );
});

test("shouldRefresh_true_on_enoent", () => {
  assert.equal(
    shouldRefreshMcpRegistration({ status: "connected", error: "open ENOENT" }),
    true,
  );
});

test("shouldRefresh_false_when_connected", () => {
  assert.equal(shouldRefreshMcpRegistration({ status: "connected" }), false);
  assert.equal(shouldRefreshMcpRegistration(undefined), false);
});

test("shouldRefresh_true_on_any_not_connected: D-6", () => {
  // Qualquer estado não-conectado precisa de refresh (não deixar morto/mudo).
  for (const status of ["disabled", "connecting", "disconnected", "error"]) {
    assert.equal(
      shouldRefreshMcpRegistration({ status }),
      true,
      `status=${status} deve refrescar`,
    );
  }
});

test("refresh_failed: status failed ⇒ disconnect + add + connect", async () => {
  const { client, calls } = fakeMcp({ status: { status: "failed" } });
  await registerMemtierMcp(client, cfg());
  assert.deepEqual(calls, ["status", "disconnect", "add", "connect"]);
});

test("refresh_not_connected: D-6 status disabled/connecting/disconnected/error ⇒ repara", async () => {
  for (const status of ["disabled", "connecting", "disconnected", "error"]) {
    const { client, calls } = fakeMcp({ status: { status } });
    await registerMemtierMcp(client, cfg());
    assert.deepEqual(
      calls,
      ["status", "disconnect", "add", "connect"],
      `status=${status}: MCP deve ser reparado, não deixado morto`,
    );
  }
});

test("register_add_409_not_fatal: D-7 ⇒ trata como já-existe e conecta", async () => {
  const { client, calls } = fakeMcp({ addError: { status: 409, detail: "already exists" } });
  await assert.doesNotReject(() => registerMemtierMcp(client, cfg()));
  assert.deepEqual(calls, ["status", "add", "connect"], "409 não impede o connect");
});

test("register_add_error_not_409: erro real do add ⇒ não conecta", async () => {
  const { client, calls } = fakeMcp({ addError: { status: 500, detail: "boom" } });
  await registerMemtierMcp(client, cfg());
  assert.deepEqual(calls, ["status", "add"], "erro não-409 aborta antes do connect");
});

test("sdk_without_mcp: client.mcp undefined ⇒ log; não lança", async () => {
  await assert.doesNotReject(() => registerMemtierMcp({}, cfg()));
  await assert.doesNotReject(() => registerMemtierMcp(undefined, cfg()));
});

// --- D-11: scheduleMcpRegistration (caminho background) ---------------------

test("schedule_returns_immediately: D-11 dispara sem bloquear o boot", () => {
  // `add` que nunca resolve: se `schedule` esperasse, o teste penduraria.
  let addStarted = false;
  const client: KiloLikeClient = {
    mcp: {
      status: async () => ({ data: {} }),
      add: async () => {
        addStarted = true;
        return new Promise(() => {}); // pendura para sempre
      },
      connect: async () => ({ data: {} }),
      disconnect: async () => ({ data: {} }),
    },
  };
  const start = Date.now();
  scheduleMcpRegistration(client, cfg());
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 50, `schedule deve retornar imediatamente (${elapsed}ms)`);
  assert.equal(addStarted, false, "o add acontece em background, não no retorno");
});

test("schedule_background_registers: D-11 o registro completa em background", async () => {
  const { client, calls } = fakeMcp();
  scheduleMcpRegistration(client, cfg());
  // Dá tempo do microtask/macrotask do registro rodar.
  const deadline = Date.now() + 1000;
  while (!calls.includes("connect") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.deepEqual(calls, ["status", "add", "connect"]);
});

test("schedule_never_rejects: D-11 client sem mcp ⇒ não lança", async () => {
  assert.doesNotThrow(() => scheduleMcpRegistration({}, cfg()));
  // E o `.catch` interno não vira rejeição não-tratada.
  await new Promise((r) => setTimeout(r, 20));
});

// --- D-5: junção de URL -----------------------------------------------------

test("build_config_url_with_query: D-5 base com ?query não corrompe", () => {
  const config = buildMcpConfig({
    url: "http://127.0.0.1:8400?x=1",
    token: "",
    timeout_ms: 15000,
  });
  assert.equal(config.url, "http://127.0.0.1:8400/v1/mcp");
});

test("build_config_url_with_fragment: D-5 base com #fragment não corrompe", () => {
  const config = buildMcpConfig({
    url: "http://127.0.0.1:8400#frag",
    token: "",
    timeout_ms: 15000,
  });
  assert.equal(config.url, "http://127.0.0.1:8400/v1/mcp");
});

test("build_config_url_with_subpath: D-5 base com subpath preserva o path", () => {
  const config = buildMcpConfig({
    url: "http://h:8400/api",
    token: "",
    timeout_ms: 15000,
  });
  assert.equal(config.url, "http://h:8400/api/v1/mcp");
});

test("build_config_url_empty: D-5 url vazia ⇒ lança (o chamador degrada)", () => {
  assert.throws(() => buildMcpConfig({ url: "", token: "", timeout_ms: 15000 }));
});

test("build_config_no_scheme: D-5 host sem esquema ⇒ assume http", () => {
  const config = buildMcpConfig({ url: "127.0.0.1:8400", token: "", timeout_ms: 15000 });
  assert.equal(config.url, "http://127.0.0.1:8400/v1/mcp");
});

// --- D-8: validação do nome -------------------------------------------------

test("isValidMcpName: rejeita vazio, barra, traversal, espaço", () => {
  assert.equal(isValidMcpName("memtier"), true);
  assert.equal(isValidMcpName(""), false);
  assert.equal(isValidMcpName("a/b"), false);
  assert.equal(isValidMcpName("../evil"), false);
  assert.equal(isValidMcpName("a\\b"), false);
  assert.equal(isValidMcpName("with space"), false);
  assert.equal(isValidMcpName(" lead"), false);
});

test("register_invalid_name: D-8 nome inválido ⇒ não chama o cliente", async () => {
  for (const name of ["", "a/b", "../evil"]) {
    const { client, calls } = fakeMcp();
    await registerMemtierMcp(client, cfg({ name }));
    assert.deepEqual(calls, [], `nome ${JSON.stringify(name)} não deve registrar`);
  }
});

// --- D-9: token só-espaços --------------------------------------------------

test("build_config_whitespace_token: D-9 token só-espaços ⇒ sem header", () => {
  const config = buildMcpConfig({ url: "http://h:8400", token: "   ", timeout_ms: 15000 });
  assert.equal(config.headers, undefined);
});

test("build_config_token_trimmed: D-9 token com espaços nas pontas ⇒ trim", () => {
  const config = buildMcpConfig({ url: "http://h:8400", token: "  abc  ", timeout_ms: 15000 });
  assert.equal(config.headers?.Authorization, "Bearer abc");
});

// --- D-13: timeout/enabled no corpo do add ----------------------------------

test("register_add_body_has_timeout_enabled: D-13", async () => {
  const { client, added } = capturingMcp();
  await registerMemtierMcp(client, cfg({ timeout_ms: 12345 }));
  assert.equal(added()?.config.timeout, 12345, "timeout do add = mcp.timeout_ms");
  assert.equal(added()?.config.enabled, true, "enabled do add = true");
});

// --- kilo-config (S2) ------------------------------------------------------

test("strip_jsonc_comments: remove // e /* */ mas preserva strings", () => {
  const raw = `{\n // linha\n "url": "http://x//y", /* bloco */\n "n": 1\n}`;
  const parsed = JSON.parse(stripJsoncComments(raw)) as { url: string; n: number };
  assert.equal(parsed.url, "http://x//y", "// dentro de string não é comentário");
  assert.equal(parsed.n, 1);
});

test("getKiloMcpOverride: ausente ⇒ undefined", async () => {
  await withKiloConfig(`{ "mcp": {} }`, (dir) => {
    assert.equal(isMcpDefinedInKiloConfig(dir, "memtier"), false);
  });
});

test("getKiloMcpOverride: presente ⇒ entry do usuário", async () => {
  await withKiloConfig(
    `{ "mcp": { "memtier": { "type": "remote", "url": "u" } } }`,
    (dir) => {
      assert.equal(isMcpDefinedInKiloConfig(dir, "memtier"), true);
    },
  );
});

test("getKiloMcpOverride: sem arquivo ⇒ undefined (registro implícito)", () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-mcp-empty-"));
  try {
    assert.equal(isMcpDefinedInKiloConfig(dir, "memtier"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- D-3: vírgula final (trailing comma) ------------------------------------

test("stripTrailingCommas: remove vírgula final de objeto e array", () => {
  assert.equal(stripTrailingCommas('{"a":1,}'), '{"a":1}');
  assert.equal(stripTrailingCommas("[1,2,]"), "[1,2]");
  assert.equal(stripTrailingCommas('{"a":[1,],}'), '{"a":[1]}');
});

test("stripTrailingCommas: preserva vírgula dentro de string", () => {
  assert.equal(stripTrailingCommas('{"a":"x,}"}'), '{"a":"x,}"}');
});

test("trailing_comma_override: D-3 kilo.jsonc com vírgula final ⇒ override honrado", async () => {
  const { client, calls } = fakeMcp();
  await withKiloConfig(
    `{\n  "mcp": {\n    "memtier": { "type": "remote", "url": "http://u:1/v1/mcp" },\n  },\n}`,
    async (dir) => {
      await registerMemtierMcp(client, cfg({ directory: dir }));
    },
  );
  assert.deepEqual(calls, [], "override com vírgula final deve bloquear o registro");
});

test("trailing_comma_parse: stripJsoncComments+stripTrailingCommas parseiam", () => {
  const raw = `{ \n "mcp": { "memtier": { }, }, // fim\n }`;
  const parsed = JSON.parse(
    stripTrailingCommas(stripJsoncComments(raw)),
  ) as { mcp: Record<string, unknown> };
  assert.ok(parsed.mcp.memtier);
});

// --- D-4: precedência entre arquivos ----------------------------------------

test("config_falls_through: D-4 arquivo existente sem mcp não sombreia", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-mcp-precedence-"));
  try {
    mkdirSync(join(dir, ".kilo"), { recursive: true });
    // `.kilo/kilo.jsonc` existe mas não tem `mcp`; a raiz `kilo.jsonc` define.
    writeFileSync(join(dir, ".kilo", "kilo.jsonc"), `{ "foo": 1 }`);
    writeFileSync(
      join(dir, "kilo.jsonc"),
      `{ "mcp": { "memtier": { "type": "remote" } } }`,
    );
    assert.equal(
      isMcpDefinedInKiloConfig(dir, "memtier"),
      true,
      "o override da raiz não pode ser sombreado",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config_falls_through_invalid: D-4 arquivo inválido não sombreia", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-mcp-invalid-"));
  try {
    mkdirSync(join(dir, ".kilo"), { recursive: true });
    writeFileSync(join(dir, ".kilo", "kilo.jsonc"), `{ this is not json ]`);
    writeFileSync(
      join(dir, "kilo.jsonc"),
      `{ "mcp": { "memtier": {} } }`,
    );
    assert.equal(isMcpDefinedInKiloConfig(dir, "memtier"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- D-10: valor `false`/`null` bloqueia ------------------------------------

test("memtier_false_blocks: D-10 mcp.memtier=false ⇒ não registra", async () => {
  const { client, calls } = fakeMcp();
  await withKiloConfig(`{ "mcp": { "memtier": false } }`, async (dir) => {
    await registerMemtierMcp(client, cfg({ directory: dir }));
  });
  assert.deepEqual(calls, [], "false é intenção explícita de desligar");
});

test("memtier_null_blocks: D-10 mcp.memtier=null ⇒ não registra", async () => {
  const { client, calls } = fakeMcp();
  await withKiloConfig(`{ "mcp": { "memtier": null } }`, async (dir) => {
    await registerMemtierMcp(client, cfg({ directory: dir }));
  });
  assert.deepEqual(calls, []);
});

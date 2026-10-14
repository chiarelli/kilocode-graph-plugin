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
  registerMemtierMcp,
  shouldRefreshMcpRegistration,
  type KiloLikeClient,
  type KiloMcpClient,
  type KiloMcpStatus,
  type McpRegisterConfig,
} from "../src/mcp/register.ts";
import { getKiloMcpOverride, stripJsoncComments } from "../src/mcp/kilo-config.ts";

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

test("refresh_failed: status failed ⇒ disconnect + add + connect", async () => {
  const { client, calls } = fakeMcp({ status: { status: "failed" } });
  await registerMemtierMcp(client, cfg());
  assert.deepEqual(calls, ["status", "disconnect", "add", "connect"]);
});

test("register_disabled_existing: já registrado (status disabled) ⇒ não duplica", async () => {
  const { client, calls } = fakeMcp({ status: { status: "disabled" } });
  await registerMemtierMcp(client, cfg());
  assert.deepEqual(calls, ["status"]);
});

test("sdk_without_mcp: client.mcp undefined ⇒ log; não lança", async () => {
  await assert.doesNotReject(() => registerMemtierMcp({}, cfg()));
  await assert.doesNotReject(() => registerMemtierMcp(undefined, cfg()));
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
    assert.equal(getKiloMcpOverride(dir, "memtier"), undefined);
  });
});

test("getKiloMcpOverride: presente ⇒ entry do usuário", async () => {
  await withKiloConfig(
    `{ "mcp": { "memtier": { "type": "remote", "url": "u" } } }`,
    (dir) => {
      const entry = getKiloMcpOverride(dir, "memtier");
      assert.equal(entry?.url, "u");
    },
  );
});

test("getKiloMcpOverride: sem arquivo ⇒ undefined (registro implícito)", () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-mcp-empty-"));
  try {
    assert.equal(getKiloMcpOverride(dir, "memtier"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

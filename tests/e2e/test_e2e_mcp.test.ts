/**
 * E3b-S3 — E2E real do registro do MCP (gated `E2E=1`).
 *
 * Roda contra a stack REAL do memtier (`127.0.0.1:8400`, de pé). Prova o efeito
 * ponta a ponta exigido pela E3b ("tools listáveis/chamáveis via cliente MCP"):
 *
 *   1. O plugin **boota** de verdade (`server(ctx, options)`) num workspace sem
 *      `kilo.jsonc` definindo o MCP (registro **implícito**). Um espião de
 *      `client.mcp` captura o `McpRemoteConfig` que o plugin registraria.
 *   2. O config capturado aponta para o `/v1/mcp` real com o bearer do workspace.
 *   3. Um cliente MCP real (JSON-RPC sobre Streamable HTTP) **conecta** nesse
 *      `/v1/mcp` e prova o efeito do outro lado: as **4 tools**
 *      (`recall`/`ingest`/`code_search`/`code_sync`) listam, e `recall` e
 *      `code_search` são **chamáveis** (`isError:false`).
 *
 * Pré-requisito do bearer: `/v1/mcp` é rota PROTEGIDA (401 sem token, medido).
 * O token vem de `E2E_TOKEN`/`KILOCODE_GRAPH_TOKEN` ou do `.kilo/graph-key.json`
 * real do repo (workspace `kilocode-graph-plugin`) — nunca fabricado. Sem token a
 * suíte **skippa com motivo**.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import pluginModule from "../../src/index.ts";
import type {
  KiloLikeClient,
  KiloMcpClient,
  McpRemoteConfig,
} from "../../src/mcp/register.ts";
import { workspaceName } from "../../src/workspace.ts";

const E2E = process.env.E2E === "1";
const MEMTIER_URL = process.env.KILOCODE_GRAPH_URL ?? "http://127.0.0.1:8400";
const WS = "kilocode-graph-plugin";
/** Programa do escopo do bearer (o `graph-key.json` real usa `graphplugin`). */
const PROGRAM = process.env.E2E_PROGRAM ?? "graphplugin";

/** Token + programa: env (preferido) ou o `.kilo/graph-key.json` real do repo. */
function resolveKey(): { token: string; program: string } {
  const envToken = process.env.E2E_TOKEN ?? process.env.KILOCODE_GRAPH_TOKEN;
  if (envToken) return { token: envToken, program: PROGRAM };
  try {
    const parsed = JSON.parse(
      readFileSync(join(process.cwd(), ".kilo", "graph-key.json"), "utf-8"),
    ) as { token?: unknown; program?: unknown };
    return {
      token: typeof parsed.token === "string" ? parsed.token : "",
      program: typeof parsed.program === "string" ? parsed.program : PROGRAM,
    };
  } catch {
    return { token: "", program: PROGRAM };
  }
}

const KEY = resolveKey();
const TOKEN = KEY.token;

/** Cliente MCP mínimo: JSON-RPC 2.0 sobre Streamable HTTP (POST). */
async function mcpRequest(
  config: McpRemoteConfig,
  method: string,
  params: Record<string, unknown>,
  id: number,
): Promise<{ result?: unknown; error?: unknown }> {
  const res = await fetch(config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(config.headers ?? {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  assert.ok(res.ok, `MCP HTTP ${res.status} em ${method}`);
  return (await res.json()) as { result?: unknown; error?: unknown };
}

/** Lista as tools do MCP (initialize + tools/list) e devolve os nomes. */
async function listTools(config: McpRemoteConfig): Promise<string[]> {
  const init = await mcpRequest(
    config,
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e3b-e2e", version: "1" },
    },
    1,
  );
  assert.ok(init.result, `initialize falhou: ${JSON.stringify(init.error)}`);

  const list = await mcpRequest(config, "tools/list", {}, 2);
  const tools = (list.result as { tools?: Array<{ name: string }> } | undefined)?.tools;
  assert.ok(Array.isArray(tools), `tools/list sem tools: ${JSON.stringify(list)}`);
  return tools.map((t) => t.name);
}

/** Chama uma tool e devolve o resultado bruto do JSON-RPC. */
async function callTool(
  config: McpRemoteConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content?: Array<{ text?: string }>; isError?: boolean }> {
  const res = await mcpRequest(config, "tools/call", { name, arguments: args }, 3);
  assert.ok(res.result, `tools/call ${name} falhou: ${JSON.stringify(res.error)}`);
  return res.result as { content?: Array<{ text?: string }>; isError?: boolean };
}

/** Espião de `client.mcp`: captura o `McpRemoteConfig` do `add`. */
function spyMcp(): { client: KiloLikeClient; registered: () => McpRemoteConfig | undefined } {
  let config: McpRemoteConfig | undefined;
  const mcp: KiloMcpClient = {
    status: async () => ({ data: {} }),
    add: async (opts) => {
      config = opts.body.config;
      return { data: {} };
    },
    connect: async () => ({ data: {} }),
    disconnect: async () => ({ data: {} }),
  };
  return { client: { mcp }, registered: () => config };
}

test("e2e: registro implícito do MCP + 4 tools reais listáveis/chamáveis", {
  skip: !E2E || !TOKEN,
}, async () => {
  const base = mkdtempSync(join(tmpdir(), "graph-e2e-e3b-"));
  const dir = join(base, WS);
  const kiloDir = join(dir, ".kilo");
  mkdirSync(kiloDir, { recursive: true });
  const tokenFile = join(kiloDir, "graph-key.json");
  writeFileSync(
    tokenFile,
    JSON.stringify({ token: TOKEN, workspace: WS, program: KEY.program }),
  );

  try {
    assert.equal(workspaceName(dir), WS);

    const { client, registered } = spyMcp();
    const hooks = await pluginModule.server(
      { directory: dir, worktree: null, client },
      {
        daemon: {
          url: MEMTIER_URL,
          token_file: tokenFile,
          program: KEY.program,
          health_timeout_ms: 3000,
        },
        mcp: { enabled: true, name: "memtier" },
        debug: true,
      },
    );
    await hooks.dispose?.();

    // O registro é background; espera curta pelo `add` do espião (registro
    // implícito: nenhum kilo.jsonc definiu o MCP).
    const deadline = Date.now() + 3000;
    while (!registered() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const config = registered();
    assert.ok(config, "o plugin deve registrar o MCP implicitamente no boot");
    assert.equal(config.type, "remote");
    assert.equal(config.url, `${MEMTIER_URL}/v1/mcp`);
    assert.equal(config.headers?.Authorization, `Bearer ${TOKEN}`);

    // Efeito do outro lado: o config que o plugin registrou conecta no memtier
    // MCP real e as 4 tools respondem.
    const tools = await listTools(config);
    for (const name of ["recall", "ingest", "code_search", "code_sync"]) {
      assert.ok(tools.includes(name), `tool "${name}" ausente; tools=${tools.join(",")}`);
    }

    const recall = await callTool(config, "recall", {
      workspace: WS,
      program: KEY.program,
      query: "plugin",
      limit: 3,
    });
    assert.equal(recall.isError, false, "recall deve responder sem erro");

    const search = await callTool(config, "code_search", {
      workspace: WS,
      program: KEY.program,
      query: "registerMemtierMcp",
      limit: 3,
    });
    assert.equal(search.isError, false, "code_search deve responder sem erro");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("e2e: MCP remoto sem token ⇒ 401 (rota protegida)", { skip: !E2E }, async () => {
  const config: McpRemoteConfig = {
    type: "remote",
    url: `${MEMTIER_URL}/v1/mcp`,
    enabled: true,
    timeout: 5000,
  };
  const res = await fetch(config.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(res.status, 401);
});

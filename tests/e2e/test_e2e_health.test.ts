/**
 * E1-S3 — E2E real da fundação (gated `E2E=1`).
 *
 * Roda contra a stack REAL do memtier (`127.0.0.1:8400`, de pé). Sem mock de
 * infra: o `fetch` é o `globalThis.fetch`.
 *
 * Prova o efeito ponta a ponta exigido pela E1 ("health real + workspace
 * resolvido do dir"):
 *   1. O plugin **boota** de verdade (`server(ctx, options)`) num workspace
 *      real, com um `token_file` real (`{ token, workspace, program }`), e o
 *      boot chama `GET /v1/health` — observado no log do plugin.
 *   2. Um `MemtierClient` com o `fetch` real chama `/v1/health` contra a stack
 *      viva e recebe `ok:true` — **efeito do outro lado**, não o retorno da
 *      chamada local.
 *
 * Nota de contrato (medida 2026-10-14): `GET /v1/health` é **aberto** (FR-305)
 * — responde 200 com ou sem token. Por isso o E1 prova a fundação sem um bearer
 * por workspace; `.kilo/graph-key.json` é pré-requisito do E2E de RECALL (E2),
 * não do health da E1. O `token_file` aqui é real (o client o lê lazy), mas o
 * valor não é exigido para o health.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MemtierClient } from "../../src/client.ts";
import pluginModule from "../../src/index.ts";
import { workspaceName } from "../../src/workspace.ts";

const E2E = process.env.E2E === "1";
const MEMTIER_URL = process.env.KILOCODE_GRAPH_URL ?? "http://127.0.0.1:8400";
const LOG_PATH = "/tmp/kilocode-graph-plugin.log";

function readLog(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

test("e2e: health real contra o memtier vivo ⇒ ok:true", { skip: !E2E }, async () => {
  const client = new MemtierClient({ url: MEMTIER_URL, health_timeout_ms: 3000 });
  const report = await client.health();
  assert.equal(report.ok, true, `health degradou: ${report.reason ?? report.error}`);
  assert.equal(report.status, "ok");
  assert.equal(report.falkordb, "ok");
  assert.equal(report.indices, "ready");
});

test("e2e: plugin boota num workspace real, resolve nome e loga health ok", { skip: !E2E }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-e2e-"));
  const kiloDir = join(dir, ".kilo");
  mkdirSync(kiloDir, { recursive: true });
  const tokenFile = join(kiloDir, "graph-key.json");

  const wsName = workspaceName(dir);
  writeFileSync(
    tokenFile,
    JSON.stringify({ token: "e2e-placeholder", workspace: wsName, program: "default" }),
  );

  const before = readLog(LOG_PATH).length;
  const hooks = await pluginModule.server(
    { directory: dir, worktree: null },
    {
      // Config real do workspace: aponta o token_file e a URL do memtier.
      daemon: { url: MEMTIER_URL, token_file: tokenFile, health_timeout_ms: 3000 },
      debug: true,
    },
  );
  // `dispose` drena o health disparado no boot — garante que a chamada real
  // terminou antes de lermos o log.
  await hooks.dispose?.();

  const appended = readLog(LOG_PATH).slice(before);
  rmSync(dir, { recursive: true, force: true });

  assert.match(
    appended,
    new RegExp(`boot workspace=${wsName}\\b`),
    `o boot deve logar o workspace resolvido (${wsName}); log: ${appended}`,
  );
  assert.match(
    appended,
    /health ok=true status=ok/,
    `o health real do boot deve ser ok=true; log: ${appended}`,
  );
});

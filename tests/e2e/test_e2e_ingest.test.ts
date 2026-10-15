/**
 * E4-S1 — E2E real da ingestão assíncrona (gated `E2E=1`).
 *
 * Roda contra a stack REAL do memtier (`127.0.0.1:8400`, de pé), sem mock de
 * infra. Prova o efeito ponta a ponta exigido pela E4-S1 ("1 lote real sai do
 * banco e é aceito pelo memtier; o episódio aparece no grafo"):
 *
 *   1. Um `kilo.db` temporário e REAL (`node:sqlite`) com 20 mensagens
 *      (user+assistant) numa sessão.
 *   2. O plugin **boota** de verdade (`server(ctx, options)`) com
 *      `ingest.enabled=true`, apontando `ingest.db_path` para esse banco.
 *   3. O hook `event` recebe um `message.updated` REAL — a rotina lê o banco e
 *      envia 1 lote. O **efeito do outro lado** não é o retorno local: é o
 *      marcador do episódio aparecendo no `/v1/recall` real (o worker processou).
 *
 * Pré-requisito do bearer: `/v1/ingest` é rota PROTEGIDA (401 sem token) e o
 * token é escopado ao workspace/program. Usa `E2E_INGEST_TOKEN` (fallback
 * `E2E_TOKEN`, escopo `alfa`/`default` no runbook). Em `E2E=1` sem token a
 * suíte **FALHA** (nunca skippa em silêncio — a lição D-1/D-2 do E3b).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MemtierClient } from "../../src/client.ts";
import pluginModule from "../../src/index.ts";
import { INGEST_STATE_REL_PATH, loadState } from "../../src/ingest/state.ts";
import { workspaceName } from "../../src/workspace.ts";

const E2E = process.env.E2E === "1";
const MEMTIER_URL = process.env.KILOCODE_GRAPH_URL ?? "http://127.0.0.1:8400";
/** Token dedicado da ingestão (fallback `E2E_TOKEN`, escopo `alfa`). */
const TOKEN =
  process.env.E2E_INGEST_TOKEN ??
  process.env.E2E_TOKEN ??
  process.env.KILOCODE_GRAPH_TOKEN ??
  "";
const WS = process.env.E2E_INGEST_WS ?? process.env.E2E_WS ?? "alfa";
const PROGRAM = process.env.E2E_INGEST_PROGRAM ?? process.env.E2E_PROGRAM ?? "default";

const BATCH = 20;
/** Tempo máximo esperando o worker do memtier processar (backpressure serial). */
const WORKER_TIMEOUT_MS = Number(process.env.E2E_INGEST_WORKER_MS ?? 180000);

/** Cria um `kilo.db` real (node:sqlite) com `BATCH` mensagens user/assistant. */
async function createKiloDb(
  path: string,
  sessionId: string,
  marker: string,
): Promise<void> {
  const spec = "node:sqlite";
  const mod = (await import(spec)) as {
    DatabaseSync: new (p: string) => {
      exec: (sql: string) => void;
      prepare: (sql: string) => { run: (...a: unknown[]) => void };
      close: () => void;
    };
  };
  const db = new mod.DatabaseSync(path);
  db.exec(
    "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);",
  );
  db.exec(
    "CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);",
  );
  const insMsg = db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)",
  );
  const insPart = db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
  );
  const base = Date.now() - BATCH * 1000;
  for (let i = 0; i < BATCH; i++) {
    const id = `msg_e2e_${String(i).padStart(3, "0")}`;
    const ts = base + i * 1000;
    const role = i % 2 === 0 ? "user" : "assistant";
    const text =
      i === 0
        ? `O codigo secreto do projeto Orion e ${marker}, decidido por Ana.`
        : `Mensagem ${i} da conversa de teste sobre o projeto Orion e seus servicos.`;
    insMsg.run(id, sessionId, ts, ts, JSON.stringify({ role, mode: "code" }));
    insPart.run(
      `prt_${i}`,
      id,
      sessionId,
      ts,
      ts,
      JSON.stringify({ type: "text", text }),
    );
  }
  db.close();
}

/** Poll do `/v1/recall` real até o marcador aparecer (efeito do outro lado). */
async function waitForFact(marker: string): Promise<boolean> {
  const client = new MemtierClient({ url: MEMTIER_URL, workspace: WS, program: PROGRAM, token: TOKEN });
  const start = Date.now();
  while (Date.now() - start < WORKER_TIMEOUT_MS) {
    try {
      const res = await client.recall(marker, { limit: 5 });
      if (res.facts.some((f) => f.fact.includes(marker))) return true;
    } catch {
      // memtier momentaneamente fora — tenta de novo.
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  return false;
}

test(
  "e2e: lote real do banco ⇒ /v1/ingest 202 e episódio aparece no grafo",
  { skip: !E2E },
  async () => {
    assert.ok(
      TOKEN,
      "E2E_INGEST_TOKEN (ou E2E_TOKEN) é obrigatório em E2E=1 — nunca fabricar credencial",
    );

    const base = mkdtempSync(join(tmpdir(), "graph-e2e-e4-"));
    const dir = join(base, WS);
    const kiloDir = join(dir, ".kilo");
    mkdirSync(kiloDir, { recursive: true });
    const dbPath = join(kiloDir, "kilo.db");
    const tokenFile = join(kiloDir, "graph-key.json");
    writeFileSync(
      tokenFile,
      JSON.stringify({ token: TOKEN, workspace: WS, program: PROGRAM }),
    );
    const sessionId = `ses_e2e_${Date.now().toString(36)}`;
    const marker = `ORION_${Date.now().toString(36)}`;
    await createKiloDb(dbPath, sessionId, marker);

    const wsName = workspaceName(dir);
    assert.equal(wsName, WS, `basename do workspace deve resolver para ${WS}`);

    const hooks = await pluginModule.server(
      { directory: dir, worktree: null },
      {
        daemon: { url: MEMTIER_URL, token_file: tokenFile, program: PROGRAM, health_timeout_ms: 3000 },
        ingest: { enabled: true, batch_size: BATCH, db_path: dbPath },
        debug: true,
      },
    );

    try {
      const event = hooks.event;
      assert.ok(event, "o hook `event` deve estar registrado");

      const start = Date.now();
      await event({
        event: { type: "message.updated", properties: { info: { sessionID: sessionId } } },
      });
      const hookMs = Date.now() - start;
      // FR-203: o hook não bloqueia — resolve antes de a ingestão terminar.
      assert.ok(hookMs < 1000, `hook bloqueou o turno: ${hookMs}ms`);

      // Efeito LADO PLUGIN: o estado foi persistido (lote aceito) e o cursor
      // avançou sobre o último rolê lido.
      const statePath = join(dir, INGEST_STATE_REL_PATH);
      const deadline = Date.now() + 20000;
      let st = loadState(statePath);
      while (st.sentBatchHashes.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        st = loadState(statePath);
      }
      assert.equal(st.sentBatchHashes.length, 1, "um hash de lote deve ser gravado");
      assert.ok(st.sessions[sessionId], "o cursor da sessão deve ser persistido");

      // Efeito DO OUTRO LADO: o worker do memtier processou e o fato aparece.
      const found = await waitForFact(marker);
      assert.ok(found, `episódio não apareceu no grafo (marcador ${marker})`);
    } finally {
      await hooks.dispose?.();
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test(
  "e2e: segundo message.updated abaixo do limiar NÃO reenvia (cursor avançou)",
  { skip: !E2E },
  async () => {
    assert.ok(TOKEN, "E2E_INGEST_TOKEN (ou E2E_TOKEN) é obrigatório em E2E=1");

    const base = mkdtempSync(join(tmpdir(), "graph-e2e-e4b-"));
    const dir = join(base, WS);
    const kiloDir = join(dir, ".kilo");
    mkdirSync(kiloDir, { recursive: true });
    const dbPath = join(kiloDir, "kilo.db");
    const tokenFile = join(kiloDir, "graph-key.json");
    writeFileSync(
      tokenFile,
      JSON.stringify({ token: TOKEN, workspace: WS, program: PROGRAM }),
    );
    const sessionId = `ses_e2e_${Date.now().toString(36)}`;
    await createKiloDb(dbPath, sessionId, `ORION_${Date.now().toString(36)}`);

    const hooks = await pluginModule.server(
      { directory: dir, worktree: null },
      {
        daemon: { url: MEMTIER_URL, token_file: tokenFile, program: PROGRAM, health_timeout_ms: 3000 },
        ingest: { enabled: true, batch_size: BATCH, db_path: dbPath },
        debug: true,
      },
    );

    try {
      const event = hooks.event!;
      await event({
        event: { type: "message.updated", properties: { info: { sessionID: sessionId } } },
      });
      const statePath = join(dir, INGEST_STATE_REL_PATH);
      const deadline = Date.now() + 20000;
      while (loadState(statePath).sentBatchHashes.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const after1 = loadState(statePath);
      assert.equal(after1.sentBatchHashes.length, 1);

      // Segundo gatilho: as 20 mensagens já foram lidas (cursor avançado) e não
      // há pendentes ⇒ nenhum novo hash.
      await event({
        event: { type: "message.updated", properties: { info: { sessionID: sessionId } } },
      });
      await new Promise((r) => setTimeout(r, 500));
      const after2 = readFileSync(statePath, "utf-8");
      assert.equal(JSON.parse(after2).sentBatchHashes.length, 1, "não deve reenviar");
    } finally {
      await hooks.dispose?.();
      rmSync(base, { recursive: true, force: true });
    }
  },
);

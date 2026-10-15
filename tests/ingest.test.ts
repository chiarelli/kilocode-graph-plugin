/**
 * E4-S1 — ingestão assíncrona: `db.ts`, `batch.ts`, `state.ts`, `routine.ts`,
 * `hooks/ingest.ts` e `client.ingest`. Sem banco nem rede reais: o backend
 * SQLite e o client são injetados; o estado usa um diretório temporário.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AuthError,
  InfraError,
  MemtierClient,
  MemtierHttpError,
  type FetchLike,
} from "../src/client.ts";
import {
  buildBatch,
  batchHash,
  latestReferenceTime,
  renderBody,
  shouldSend,
} from "../src/ingest/batch.ts";
import {
  DEFAULT_DB_PATH,
  fakeBackend,
  findKiloDb,
  readBatch,
  type DbRow,
  type IngestMessage,
  type SqliteBackend,
} from "../src/ingest/db.ts";
import { ingestOnce, runIngest, type IngestRuntime } from "../src/ingest/routine.ts";
import {
  emptyState,
  hasSentBatch,
  INGEST_STATE_REL_PATH,
  loadState,
  saveState,
} from "../src/ingest/state.ts";
import { ingestHook, sessionIdFromEvent } from "../src/hooks/ingest.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Linha crua de `message` (o `data` é o JSON do Kilo com o `role`). */
interface FakeMsg {
  id: string;
  session_id: string;
  time_created: number;
  role: "user" | "assistant";
  texts?: string[];
  mode?: string;
}

/**
 * Backend fake realista: honra o cursor `(time_created, id)` na query de
 * `message` e devolve os `part` por `message_id`. Assim o teste exercita o
 * caminho real de `readBatch`, não um stub ingênuo.
 */
function makeBackend(msgs: FakeMsg[]): SqliteBackend {
  return fakeBackend((sql: string, params: unknown[]): DbRow[] => {
    if (sql.includes("FROM message")) {
      const [sid, ts, ts2, id, limit] = params as [string, number, number, string, number];
      return msgs
        .filter(
          (m) =>
            m.session_id === sid &&
            (m.time_created > ts ||
              (m.time_created === ts2 && m.id > id)),
        )
        .sort((a, b) => a.time_created - b.time_created || (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map((m) => ({
          id: m.id,
          time_created: m.time_created,
          data: JSON.stringify({ role: m.role, mode: m.mode }),
        }));
    }
    if (sql.includes("FROM part")) {
      const mid = params[0] as string;
      const m = msgs.find((x) => x.id === mid);
      return (m?.texts ?? []).map((t) => ({
        data: JSON.stringify({ type: "text", text: t }),
      }));
    }
    return [];
  });
}

/** Gera `n` mensagens user/assistant alternadas com texto. */
function genMsgs(n: number, startTs = 1000): FakeMsg[] {
  const out: FakeMsg[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `msg_${String(i).padStart(3, "0")}`,
      session_id: "ses_a",
      time_created: startTs + i,
      role: i % 2 === 0 ? "user" : "assistant",
      texts: [`texto ${i}`],
    });
  }
  return out;
}

function tmpState(): { dir: string; statePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "graph-ingest-"));
  return {
    dir,
    statePath: join(dir, INGEST_STATE_REL_PATH),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Client stub que registra as chamadas de `ingest`. */
function stubClient(
  impl: (body: string, rt?: string) => Promise<{ job_id?: string; status?: string }>,
) {
  const calls: Array<{ body: string; referenceTime?: string }> = [];
  return {
    calls,
    client: {
      ingest: async (body: string, referenceTime?: string) => {
        calls.push({ body, referenceTime });
        return impl(body, referenceTime);
      },
    },
  };
}

function rt(
  statePath: string,
  client: IngestRuntime["client"],
  over: Partial<IngestRuntime["cfg"]> = {},
): IngestRuntime {
  return {
    cfg: { enabled: true, batch_size: 20, max_hashes: 5000, ...over },
    statePath,
    client,
    lock: new Set<string>(),
  };
}

// ---------------------------------------------------------------------------
// batch.ts
// ---------------------------------------------------------------------------

function msg(id: string, role: "user" | "assistant", content: string, ts = 1): IngestMessage {
  return { id, role, content, time_created: ts };
}

test("batch_hash_deterministic: mesmo lote ⇒ mesmo hash; conteúdo/role muda ⇒ muda", () => {
  const a = [msg("1", "user", "oi"), msg("2", "assistant", "olá")];
  const b = [msg("1", "user", "oi"), msg("2", "assistant", "olá")];
  assert.equal(batchHash(a), batchHash(b));
  assert.notEqual(batchHash(a), batchHash([msg("1", "user", "oi")]));
  assert.notEqual(
    batchHash([msg("1", "user", "x")]),
    batchHash([msg("1", "assistant", "x")]),
  );
  // Estável entre chamadas (sem aleatoriedade).
  assert.equal(batchHash(a), batchHash(a));
});

test("batch_render_body: cada mensagem vira `role: content` separado por linha em branco", () => {
  const body = renderBody([msg("1", "user", "oi"), msg("2", "assistant", "olá")]);
  assert.equal(body, "user: oi\n\nassistant: olá");
});

test("batch_reference_time: é a mensagem MAIS ATUAL (não a mais antiga)", () => {
  const batch = buildBatch([
    msg("1", "user", "a", 1000),
    msg("2", "assistant", "b", 3000),
    msg("3", "user", "c", 2000),
  ]);
  assert.equal(batch.referenceTime, new Date(3000).toISOString());
  assert.equal(latestReferenceTime([msg("1", "user", "a", 500)]), new Date(500).toISOString());
});

test("batch_reference_time_empty: lote sem timestamp válido lança", () => {
  assert.throws(() => latestReferenceTime([]), /time_created/);
});

test("batch_threshold: só envia com o lote CHEIO (rows >= batch)", () => {
  assert.equal(shouldSend(19, 20), false);
  assert.equal(shouldSend(20, 20), true);
  assert.equal(shouldSend(25, 20), true);
  assert.equal(shouldSend(0, 20), false);
});

// ---------------------------------------------------------------------------
// db.ts — localização e leitura
// ---------------------------------------------------------------------------

test("db_find_project: `.kilo/kilo.db` do projeto tem prioridade", () => {
  const exists = (p: string) => p === join("/repo", ".kilo", "kilo.db");
  assert.equal(findKiloDb("/repo", exists), join("/repo", ".kilo", "kilo.db"));
});

test("db_find_devcontainer: segundo candidato quando não há `.kilo/`", () => {
  const dev = join("/repo", ".devcontainer", "kilo", "local", "kilo.db");
  assert.equal(findKiloDb("/repo", (p) => p === dev), dev);
});

test("db_find_walks_up: sobe até 5 níveis atrás de `<parent>/.kilo/kilo.db`", () => {
  const target = join("/a", ".kilo", "kilo.db");
  assert.equal(findKiloDb("/a/b/c/d", (p) => p === target), target);
});

test("db_find_fallback: nada encontrado ⇒ banco global", () => {
  assert.equal(findKiloDb("/nope", () => false), DEFAULT_DB_PATH);
});

test("db_read_batch: remonta texto (user+assistant), cursor por tupla e sem OFFSET", () => {
  const msgs = genMsgs(3, 100);
  const backend = makeBackend(msgs);
  const read = readBatch(backend, "ses_a", { last_ts: 0, last_id: "" }, 10);
  assert.equal(read.rows, 3);
  assert.equal(read.messages.length, 3);
  assert.deepEqual(
    read.messages.map((m) => m.content),
    ["texto 0", "texto 1", "texto 2"],
  );
  assert.deepEqual(read.last, { last_ts: 102, last_id: "msg_002" });
});

test("db_read_batch_cursor_advances: cursor avança e não relê o já lido", () => {
  const backend = makeBackend(genMsgs(5, 100));
  const first = readBatch(backend, "ses_a", { last_ts: 0, last_id: "" }, 2);
  assert.equal(first.rows, 2);
  const second = readBatch(backend, "ses_a", first.last!, 2);
  assert.deepEqual(
    second.messages.map((m) => m.id),
    ["msg_002", "msg_003"],
  );
});

test("db_read_batch_skips_nontext: linha sem texto não vira mensagem, mas avança o cursor", () => {
  const backend = makeBackend([
    { id: "msg_000", session_id: "ses_a", time_created: 1, role: "user", texts: [] },
    { id: "msg_001", session_id: "ses_a", time_created: 2, role: "assistant", texts: ["ok"] },
  ]);
  const read = readBatch(backend, "ses_a", { last_ts: 0, last_id: "" }, 10);
  assert.equal(read.rows, 2);
  assert.equal(read.messages.length, 1);
  assert.equal(read.messages[0]!.id, "msg_001");
  assert.deepEqual(read.last, { last_ts: 2, last_id: "msg_001" });
});

test("db_read_batch_other_session: só a sessão pedida é lida", () => {
  const backend = makeBackend([
    { id: "m1", session_id: "ses_a", time_created: 1, role: "user", texts: ["a"] },
    { id: "m2", session_id: "ses_b", time_created: 2, role: "user", texts: ["b"] },
  ]);
  const read = readBatch(backend, "ses_b", { last_ts: 0, last_id: "" }, 10);
  assert.deepEqual(read.messages.map((m) => m.content), ["b"]);
});

// ---------------------------------------------------------------------------
// state.ts
// ---------------------------------------------------------------------------

test("state_empty_default: estado vazio", () => {
  assert.deepEqual(emptyState(), { sessions: {}, sentBatchHashes: [] });
});

test("state_load_missing_or_corrupt: degrada para vazio, não lança", () => {
  assert.deepEqual(loadState("/nope.json", () => {
    throw new Error("ENOENT");
  }), emptyState());
  assert.deepEqual(loadState("/bad.json", () => "{not json"), emptyState());
});

test("state_load_valid: cursor e hashes válidos são lidos; inválidos descartados", () => {
  const raw = JSON.stringify({
    sessions: {
      ses_a: { last_ts: 10, last_id: "m1" },
      ses_bad: { last_ts: "x" },
    },
    sentBatchHashes: ["h1", 2, "h2"],
  });
  const st = loadState("/ok.json", () => raw);
  assert.deepEqual(st.sessions.ses_a, { last_ts: 10, last_id: "m1" });
  assert.equal(st.sessions.ses_bad, undefined);
  assert.deepEqual(st.sentBatchHashes, ["h1", "h2"]);
});

test("state_atomic_write: grava em tmp e renomeia; cria o diretório", () => {
  const writes: Array<[string, string]> = [];
  let renamed: [string, string] | null = null;
  let madeDir = "";
  saveState("/ws/.kilo/graph-ingest.json", emptyState(), {
    writeFile: (p, d) => writes.push([p, d]),
    rename: (from, to) => {
      renamed = [from, to];
    },
    mkdir: (p) => {
      madeDir = p;
    },
  });
  assert.equal(madeDir, "/ws/.kilo");
  assert.match(writes[0]![0], /\.tmp$/);
  assert.deepEqual(renamed, [
    "/ws/.kilo/graph-ingest.json.tmp",
    "/ws/.kilo/graph-ingest.json",
  ]);
  assert.doesNotThrow(() => JSON.parse(writes[0]![1]));
});

test("state_has_sent: membership do hash", () => {
  const st = { sessions: {}, sentBatchHashes: ["abc"] };
  assert.equal(hasSentBatch(st, "abc"), true);
  assert.equal(hasSentBatch(st, "zzz"), false);
});

// ---------------------------------------------------------------------------
// routine.ts
// ---------------------------------------------------------------------------

test("ingest_once_sends_at_threshold: lote cheio ⇒ envia, grava hash e avança cursor", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const backend = makeBackend(genMsgs(20, 1000));
    const { client, calls } = stubClient(async () => ({ job_id: "job_1", status: "queued" }));
    const outcome = await ingestOnce(rt(statePath, client), backend, "ses_a");

    assert.equal(outcome.sent, true);
    assert.equal(outcome.msgs, 20);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.body, /^user: texto 0\n\nassistant: texto 1/);
    // reference_time = mensagem mais atual (time_created 1019).
    assert.equal(calls[0]!.referenceTime, new Date(1019).toISOString());

    const st = loadState(statePath);
    assert.deepEqual(st.sessions.ses_a, { last_ts: 1019, last_id: "msg_019" });
    assert.equal(st.sentBatchHashes.length, 1);
    assert.equal(st.sentBatchHashes[0], outcome.hash);
  } finally {
    cleanup();
  }
});

test("ingest_once_below_threshold: pendentes < batch ⇒ NÃO envia e NÃO avança o cursor", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const backend = makeBackend(genMsgs(5, 1000));
    const { client, calls } = stubClient(async () => ({ job_id: "j" }));
    const outcome = await ingestOnce(rt(statePath, client), backend, "ses_a");
    assert.equal(outcome.sent, false);
    assert.equal(outcome.rows, 5);
    assert.equal(calls.length, 0);
    // Nada persistido: o cursor continua no início.
    assert.deepEqual(loadState(statePath).sessions, {});
  } finally {
    cleanup();
  }
});

test("ingest_once_dedup: lote já enviado (hash no estado) ⇒ não reenvia, mas avança o cursor", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const msgs = genMsgs(20, 1000);
    const backend = makeBackend(msgs);
    const hash = batchHash(
      msgs.map((m, i) => ({
        id: m.id,
        role: m.role,
        content: `texto ${i}`,
        time_created: m.time_created,
      })),
    );
    saveState(statePath, { sessions: {}, sentBatchHashes: [hash] });
    const { client, calls } = stubClient(async () => ({ job_id: "j" }));
    const outcome = await ingestOnce(rt(statePath, client), backend, "ses_a");
    assert.equal(outcome.sent, false);
    assert.equal(calls.length, 0);
    assert.deepEqual(loadState(statePath).sessions.ses_a, {
      last_ts: 1019,
      last_id: "msg_019",
    });
  } finally {
    cleanup();
  }
});

test("ingest_once_client_error: erro do client propaga; cursor NÃO avança", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const backend = makeBackend(genMsgs(20, 1000));
    const { client } = stubClient(async () => {
      throw new MemtierHttpError(500, "boom");
    });
    await assert.rejects(() => ingestOnce(rt(statePath, client), backend, "ses_a"));
    const st = loadState(statePath);
    assert.deepEqual(st.sessions, {});
    assert.deepEqual(st.sentBatchHashes, []);
  } finally {
    cleanup();
  }
});

test("ingest_once_empty_text: lote cheio sem texto ⇒ não envia, avança o cursor", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const backend = makeBackend(genMsgs(20, 1000).map((m) => ({ ...m, texts: [] })));
    const { client, calls } = stubClient(async () => ({ job_id: "j" }));
    const outcome = await ingestOnce(rt(statePath, client), backend, "ses_a");
    assert.equal(outcome.sent, false);
    assert.equal(calls.length, 0);
    assert.deepEqual(loadState(statePath).sessions.ses_a, {
      last_ts: 1019,
      last_id: "msg_019",
    });
  } finally {
    cleanup();
  }
});

test("ingest_once_disabled: desligado ⇒ no-op", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const backend = makeBackend(genMsgs(20, 1000));
    const { client, calls } = stubClient(async () => ({ job_id: "j" }));
    const outcome = await ingestOnce(
      rt(statePath, client, { enabled: false }),
      backend,
      "ses_a",
    );
    assert.equal(outcome.sent, false);
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

test("run_ingest_never_throws: falha do client vira log, sem exceção", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const backend = makeBackend(genMsgs(20, 1000));
    const { client } = stubClient(async () => {
      throw new AuthError(401, "sem token");
    });
    await assert.doesNotReject(() => runIngest(rt(statePath, client), backend, "ses_a"));
  } finally {
    cleanup();
  }
});

test("run_ingest_lock: chamadas concorrentes na mesma sessão ⇒ uma execução", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const backend = makeBackend(genMsgs(20, 1000));
    let inFlight = 0;
    let maxInFlight = 0;
    let count = 0;
    const { client } = stubClient(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      count++;
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return { job_id: "j" };
    });
    const runtime = rt(statePath, client);
    await Promise.all([
      runIngest(runtime, backend, "ses_a"),
      runIngest(runtime, backend, "ses_a"),
      runIngest(runtime, backend, "ses_a"),
    ]);
    assert.equal(count, 1, "só uma passada deve enviar");
    assert.equal(maxInFlight, 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// hooks/ingest.ts
// ---------------------------------------------------------------------------

test("session_id_from_event: message.updated (info.sessionID) e session.idle (sessionID)", () => {
  assert.equal(
    sessionIdFromEvent({ type: "message.updated", properties: { info: { sessionID: "ses_x" } } }),
    "ses_x",
  );
  assert.equal(
    sessionIdFromEvent({ type: "session.idle", properties: { sessionID: "ses_y" } }),
    "ses_y",
  );
  assert.equal(sessionIdFromEvent({ type: "message.updated", properties: {} }), null);
});

test("hook_disabled: desligado ⇒ nenhum evento dispara a rotina", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const { client, calls } = stubClient(async () => ({ job_id: "j" }));
    const hooks = ingestHook({
      cfg: { enabled: false, batch_size: 20, max_hashes: 5000 },
      dbPath: "ignored",
      statePath,
      client,
      backend: makeBackend(genMsgs(20, 1000)),
    });
    await hooks.event({
      event: { type: "message.updated", properties: { info: { sessionID: "ses_a" } } },
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

test("hook_message_updated: acorda a rotina em background (não bloqueia) e ingere", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const { client, calls } = stubClient(async () => ({ job_id: "job_9", status: "queued" }));
    const hooks = ingestHook({
      cfg: { enabled: true, batch_size: 20, max_hashes: 5000 },
      dbPath: "ignored",
      statePath,
      client,
      backend: makeBackend(genMsgs(20, 1000)),
    });
    await hooks.event({
      event: { type: "message.updated", properties: { info: { sessionID: "ses_a" } } },
    });
    // O handler resolve antes da rotina; espera o efeito (estado persistido).
    await waitFor(() => {
      try {
        return loadState(statePath).sentBatchHashes.length === 1;
      } catch {
        return false;
      }
    });
    assert.equal(calls.length, 1);
  } finally {
    cleanup();
  }
});

test("hook_ignores_other_events: session.idle (S3) não é tratado na S1", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const { client, calls } = stubClient(async () => ({ job_id: "j" }));
    const hooks = ingestHook({
      cfg: { enabled: true, batch_size: 20, max_hashes: 5000 },
      dbPath: "ignored",
      statePath,
      client,
      backend: makeBackend(genMsgs(20, 1000)),
    });
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_a" } } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// client.ingest
// ---------------------------------------------------------------------------

function stubFetch(
  status: number,
  body: unknown,
  onCall?: (input: string | URL, init?: RequestInit) => void,
): FetchLike {
  return async (input, init) => {
    onCall?.(input, init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

test("client_ingest_ok: 202 ⇒ job_id; envia workspace/program/body/reference_time", async () => {
  let seen: { url: string; body: unknown } | null = null;
  const client = new MemtierClient({
    url: "http://memtier:8400",
    workspace: "alfa",
    program: "default",
    fetch: stubFetch(202, { job_id: "j1", workspace: "alfa", status: "queued" }, (input, init) => {
      seen = { url: String(input), body: JSON.parse(String(init?.body)) };
    }),
  });
  const res = await client.ingest("user: oi", "2026-01-01T00:00:00.000Z");
  assert.equal(res.job_id, "j1");
  assert.equal(res.status, "queued");
  assert.equal(seen!.url, "http://memtier:8400/v1/ingest");
  assert.deepEqual(seen!.body, {
    workspace: "alfa",
    program: "default",
    body: "user: oi",
    reference_time: "2026-01-01T00:00:00.000Z",
  });
});

test("client_ingest_auth: 401 ⇒ AuthError", async () => {
  const client = new MemtierClient({
    url: "http://memtier:8400",
    fetch: stubFetch(401, { detail: "sem token" }),
  });
  await assert.rejects(() => client.ingest("x"), (e: unknown) => e instanceof AuthError);
});

test("client_ingest_infra: 503 ⇒ InfraError", async () => {
  const client = new MemtierClient({
    url: "http://memtier:8400",
    fetch: stubFetch(503, { detail: "fila down" }),
  });
  await assert.rejects(() => client.ingest("x"), (e: unknown) => e instanceof InfraError);
});

// ---------------------------------------------------------------------------

/** Espera uma condição virar verdadeira (para efeitos em background). */
async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

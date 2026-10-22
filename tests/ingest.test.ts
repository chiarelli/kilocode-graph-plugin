/**
 * E4-S1 — ingestão assíncrona: `db.ts`, `batch.ts`, `state.ts`, `routine.ts`,
 * `hooks/ingest.ts` e `client.ingest`. Sem banco nem rede reais: o backend
 * SQLite e o client são injetados; o estado usa um diretório temporário.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  createBackendProvider,
  DEFAULT_DB_PATH,
  defaultDbPath,
  fakeBackend,
  IngestReadError,
  listWorkspaceSessions,
  lookupSessionScope,
  readBatch,
  resolveRuntimeDbPath,
  sessionBelongsToWorkspace,
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
  markBatchAccepted,
  markBatchSent,
  saveState,
} from "../src/ingest/state.ts";
import { ingestHook, sessionIdFromEvent } from "../src/hooks/ingest.ts";
import { __setLogSink } from "../src/logger.ts";

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
// db.ts — localização (pelo runtime) e leitura
// ---------------------------------------------------------------------------

test("db_runtime_path: usa Path.data do runtime (XDG_DATA_HOME) + `kilo.db`", () => {
  // O runtime guarda o banco em `Path.data`, NUNCA em `Path.state` (~/.local/state).
  // Aqui, com XDG_DATA_HOME setado, o db deriva dele — não de `state`.
  const db = resolveRuntimeDbPath({ XDG_DATA_HOME: "/home/u/.local/share" });
  assert.equal(db, join("/home/u/.local/share", "kilo", "kilo.db"));
});

test("db_runtime_path_default_data: sem XDG_DATA_HOME ⇒ ~/.local/share/kilo/kilo.db", () => {
  assert.equal(defaultDbPath({}, "/home/u"), join("/home/u/.local/share/kilo", "kilo.db"));
});

test("db_runtime_path_kilo_db_abs: KILO_DB absoluto é honrado como está", () => {
  assert.equal(
    resolveRuntimeDbPath({ KILO_DB: "/custom/dir/my.db" }),
    "/custom/dir/my.db",
  );
});

test("db_runtime_path_kilo_db_memory: KILO_DB=:memory: é honrado", () => {
  assert.equal(resolveRuntimeDbPath({ KILO_DB: ":memory:" }), ":memory:");
});

test("db_runtime_path_kilo_db_relative: KILO_DB relativo cai em Path.data", () => {
  assert.equal(
    resolveRuntimeDbPath({ XDG_DATA_HOME: "/data", KILO_DB: "alt.db" }),
    join("/data", "kilo", "alt.db"),
  );
});

test("db_runtime_path_no_xdg: sem env ⇒ default do runtime (nunca Path.state)", () => {
  // `DEFAULT_DB_PATH` é a regra do runtime aplicada ao env atual; e nunca aponta
  // para `.local/state` (o defeito original usava `Path.state`).
  assert.equal(DEFAULT_DB_PATH, defaultDbPath());
  assert.ok(!DEFAULT_DB_PATH.includes("/.local/state/"), DEFAULT_DB_PATH);
});

test("db_runtime_path_xdg_relative_ignored: XDG_DATA_HOME relativo cai no default", () => {
  // Um XDG_DATA_HOME relativo resolveria contra o cwd do daemon (lugar errado);
  // a regra do runtime o ignora. Sem isto, o plugin abriria um banco inexistente.
  assert.equal(
    defaultDbPath({ XDG_DATA_HOME: "rel/dir" }, "/home/u"),
    join("/home/u/.local/share/kilo", "kilo.db"),
  );
});

test("db_runtime_path_kilo_db_blank: KILO_DB vazio/whitespace cai no default", () => {
  assert.equal(
    defaultDbPath({ KILO_DB: "" }, "/home/u"),
    join("/home/u/.local/share/kilo", "kilo.db"),
  );
  assert.equal(
    defaultDbPath({ KILO_DB: "   " }, "/home/u"),
    join("/home/u/.local/share/kilo", "kilo.db"),
  );
});

test("db_runtime_path_kilo_db_subpath: subcaminho relativo é resolvido em Path.data", () => {
  assert.equal(
    defaultDbPath({ XDG_DATA_HOME: "/data", KILO_DB: "sub/dir.db" }, "/home/u"),
    join("/data", "kilo", "sub/dir.db"),
  );
});

test("db_runtime_path_xdg_whitespace: XDG_DATA_HOME com espaços é trimado", () => {
  assert.equal(
    defaultDbPath({ XDG_DATA_HOME: "  /data/x  " }, "/home/u"),
    join("/data/x", "kilo", "kilo.db"),
  );
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
  assert.deepEqual(emptyState(), { sessions: {}, sentBatchHashes: [], sentBatches: [] });
});

test("state_load_missing_or_corrupt: degrada para vazio, não lança", () => {
  assert.deepEqual(loadState("/nope.json", () => {
    throw new Error("ENOENT");
  }), emptyState());
  assert.deepEqual(loadState("/bad.json", () => "{not json"), emptyState());
});

test("s4_l3_reset_logged: reset do estado é reportado (ausente e corrompido)", () => {
  // L-3: o reset nunca é silencioso. `onReset` é chamado com o motivo nos dois
  // casos — arquivo ilegível (ENOENT) e JSON corrompido.
  const reasons: string[] = [];
  const missing = loadState(
    "/nope.json",
    () => {
      throw new Error("ENOENT: no such file");
    },
    (r) => reasons.push(r),
  );
  assert.deepEqual(missing, emptyState());
  assert.equal(reasons.length, 1);
  assert.match(reasons[0]!, /ilegível/);

  const corrupt = loadState("/bad.json", () => "{not json", (r) => reasons.push(r));
  assert.deepEqual(corrupt, emptyState());
  assert.equal(reasons.length, 2);
  assert.match(reasons[1]!, /JSON corrompido/);
});

test("state_load_valid: cursor e hashes válidos são lidos; inválidos descartados", () => {
  const raw = JSON.stringify({
    sessions: {
      ses_a: { last_ts: 10, last_id: "m1" },
      ses_bad: { last_ts: "x" },
    },
    sentBatchHashes: ["h1", 2, "h2"],
    sentBatches: [
      { hash: "h1", reference_time: "x", accepted_at: "y", confirmed: false },
      { hash: 3 },
      null,
    ],
  });
  const st = loadState("/ok.json", () => raw);
  assert.deepEqual(st.sessions.ses_a, { last_ts: 10, last_id: "m1" });
  assert.equal(st.sessions.ses_bad, undefined);
  assert.deepEqual(st.sentBatchHashes, ["h1", "h2"]);
  assert.equal(st.sentBatches!.length, 1);
  assert.equal(st.sentBatches![0]!.hash, "h1");
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

test("hook_ignores_unknown_events: eventos que não são os dois gatilhos são ignorados", async () => {
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
    await hooks.event({
      event: { type: "message.part.updated", properties: { sessionID: "ses_a" } },
    });
    await hooks.event({ event: { type: "session.drained", properties: { sessionID: "ses_a" } } });
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
// E4-S2 — cursor por identidade + idempotência
// ---------------------------------------------------------------------------

/**
 * Demonstração aritmética do defeito do `OFFSET` (padrão E3a/E3b), com o cursor
 * real (`readBatch`) do lado correto.
 *
 * A parte (a) mostra o **modelo** posicional: uma remoção antes do cursor desloca
 * a posição numérica e pula mensagens. A parte (b) prova que o `readBatch` (por
 * tupla) NÃO pula. Nota honesta: a parte (a) é aritmética sobre um array, não
 * exercita o `readBatch` — a garantia de que o SQL real **não contém `OFFSET`** é
 * provada por `s2_offset_regression_realsqlite` (guarda de shape sobre o SQL
 * emitido) + a comparação contra SQLite real. Juntos, reintroduzir `OFFSET` no
 * `readBatch` reprova (o guard de shape falha).
 *
 * Dataset: 100 mensagens `(ts, id)`; o cursor já leu até a posição 50; então 20
 * linhas ANTES do cursor são removidas (compactação); quem lê a seguir?
 */
test("s2_offset_regression: cursor posicional PULA após remoção; tupla NÃO (discriminação)", () => {
  const all = genMsgs(100, 1000);
  const readCursor = { last_ts: all[49]!.time_created, last_id: all[49]!.id };

  // Cenário: 20 linhas antes do cursor foram removidas (compactação).
  const remaining = all.filter((m) => !(m.time_created >= 1030 && m.time_created < 1050));

  // (a) Abordagem DEFEITUOSA: posição numérica. O cursor está em "posição 50";
  // ao remover 20 linhas antes dele, a posição 50 do conjunto encolhido aponta
  // 20 mensagens ADIANTE ⇒ as mensagens logo após o cursor são puladas.
  const posRead = remaining.slice(50, 55); // o OV avança `OFFSET` numérico
  assert.deepEqual(
    posRead.map((m) => m.time_created),
    [1070, 1071, 1072, 1073, 1074],
    "OFFSET numérico retoma 20 posições adiante (defeito medido): as 5 seguintes saíram",
  );
  const posSkipped = remaining.filter(
    (m) => m.time_created > readCursor.last_ts && m.time_created < posRead[0]!.time_created,
  );
  assert.equal(posSkipped.length, 20, "OFFSET numérico PULA 20 mensagens (defeito medido)");

  // (b) Abordagem CORRETA: tupla `(time_created, id)`. Nada é pulado.
  const backend = makeBackend(remaining);
  const read = readBatch(backend, "ses_a", readCursor, 5);
  assert.deepEqual(
    read.messages.map((m) => m.time_created),
    [1050, 1051, 1052, 1053, 1054],
    "o cursor por tupla retoma exatamente na linha seguinte ao cursor",
  );
});

test("s2_read_error_does_not_advance: falha ao ler os `part` NÃO avança o cursor", () => {
  const base = makeBackend(genMsgs(20, 1000));
  let partCalls = 0;
  // Primeira leitura dos `part` falha (SQLITE_BUSY/WAL); as seguintes funcionam.
  const flaky: SqliteBackend = {
    query: (sql, params) => {
      if (sql.includes("FROM part")) {
        partCalls++;
        if (partCalls === 1) throw new Error("SQLITE_BUSY: database is locked");
      }
      return base.query(sql, params);
    },
    close: () => {},
  };

  assert.throws(
    () => readBatch(flaky, "ses_a", { last_ts: 0, last_id: "" }, 20),
    (e: unknown) => e instanceof IngestReadError,
    "leitura de `part` indisponível deve lançar IngestReadError (transitório)",
  );

  // A retentativa (agora o banco respondeu) recupera as MESMAS mensagens —
  // prova de que o cursor não avançou sobre o lote que falhou.
  const read = readBatch(flaky, "ses_a", { last_ts: 0, last_id: "" }, 20);
  assert.equal(read.messages.length, 20);
  assert.equal(read.messages[0]!.content, "texto 0");
});

test("s2_ingest_read_error_degrades_without_sending: rotina loga e não envia", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const base = makeBackend(genMsgs(20, 1000));
    const flaky: SqliteBackend = {
      query: (sql, params) => {
        if (sql.includes("FROM part")) throw new Error("disk I/O error");
        return base.query(sql, params);
      },
      close: () => {},
    };
    const { client, calls } = stubClient(async () => ({ job_id: "j" }));
    await assert.doesNotReject(() => runIngest(rt(statePath, client), flaky, "ses_a"));
    assert.equal(calls.length, 0, "lote incompleto não pode ser enviado");
    assert.deepEqual(loadState(statePath).sessions, {}, "cursor não avançou");
  } finally {
    cleanup();
  }
});

test("s2_poison_row_logged: linha com `data` não-JSON avança mas deixa rastro", () => {
  const msgs = genMsgs(3, 1000);
  const backend = fakeBackend((sql: string, params: unknown[]): DbRow[] => {
    if (sql.includes("FROM message")) {
      const [sid, ts, ts2, id, limit] = params as [string, number, number, string, number];
      const rows = [
        { id: msgs[0]!.id, session_id: sid, time_created: 1000, data: JSON.stringify({ role: "user" }) },
        { id: "msg_poison", session_id: sid, time_created: 1001, data: "{nao-e-json" },
        { id: msgs[2]!.id, session_id: sid, time_created: 1002, data: JSON.stringify({ role: "assistant" }) },
      ];
      return rows
        .filter(
          (m) =>
            (m.time_created as number) > ts ||
            ((m.time_created as number) === ts2 && (m.id as string) > id),
        )
        .slice(0, limit);
    }
    if (sql.includes("FROM part")) {
      const mid = params[0] as string;
      return [{ data: JSON.stringify({ type: "text", text: `txt ${mid}` }) }];
    }
    return [];
  });
  const poisoned: string[] = [];
  const read = readBatch(backend, "ses_a", { last_ts: 0, last_id: "" }, 10, (id) =>
    poisoned.push(id),
  );
  assert.deepEqual(poisoned, ["msg_poison"], "a linha veneno deve ser reportada");
  // Avança o cursor (irrecuperável) e não vira mensagem.
  assert.deepEqual(read.last, { last_ts: 1002, last_id: msgs[2]!.id });
  assert.equal(read.messages.some((m) => m.id === "msg_poison"), false);
  // Segundo run não relê a veneno (cursor já passou) — não é retrabalho eterno.
  const again = readBatch(backend, "ses_a", read.last!, 10, (id) => poisoned.push(id));
  assert.deepEqual(poisoned, ["msg_poison"]);
  assert.equal(again.rows, 0);
});

test("s2_restart_no_resend: estado em disco ⇒ novo runtime NÃO reenvia o já enviado", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const backend = makeBackend(genMsgs(20, 1000));
    const first = stubClient(async () => ({ job_id: "j1" }));
    const firstOutcome = await ingestOnce(rt(statePath, first.client), backend, "ses_a");
    assert.equal(firstOutcome.sent, true);
    assert.equal(first.calls.length, 1);

    // Simula RESTART: runtime e trava novos, MESMO arquivo de estado. O cursor
    // já cobriu as 20 mensagens ⇒ nenhum pendente ⇒ nenhum envio.
    const second = stubClient(async () => ({ job_id: "j2" }));
    const secondOutcome = await runIngest(rt(statePath, second.client), backend, "ses_a");
    void secondOutcome;
    assert.equal(second.calls.length, 0, "restart não pode reenviar o lote já aceito");

    // E mesmo reenviando um gatilho abaixo do limiar, nada sai.
    await runIngest(rt(statePath, second.client), backend, "ses_a");
    assert.equal(second.calls.length, 0);
  } finally {
    cleanup();
  }
});

test("s2_hash_recorded_only_after_accept: falha do envio não grava hash (retry possível)", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const backend = makeBackend(genMsgs(20, 1000));
    let fail = true;
    const calls: string[] = [];
    const client = {
      ingest: async (body: string) => {
        calls.push(body);
        if (fail) throw new InfraError(503, "fila down");
        return { job_id: "j" };
      },
    };
    await assert.doesNotReject(() => runIngest(rt(statePath, client), backend, "ses_a"));
    assert.equal(calls.length, 1);
    // Nada persistido: sem hash e sem cursor ⇒ o próximo gatilho relê e reenvia.
    assert.deepEqual(loadState(statePath), emptyState());

    fail = false;
    await runIngest(rt(statePath, client), backend, "ses_a");
    assert.equal(calls.length, 2, "após o 202 o mesmo lote é reenviado (nada foi gravado)");
    const st = loadState(statePath);
    assert.equal(st.sentBatchHashes.length, 1, "hash gravado só após o aceite");
    assert.ok(st.sessions.ses_a, "cursor avança junto com o hash");
  } finally {
    cleanup();
  }
});

/**
 * DISCRIMINAÇÃO do OFFSET contra SQLite REAL (`node:sqlite`): a prova do
 * ADR-008 reproduzida — remover 40 linhas ANTES do cursor. Com cursor por
 * tupla, `PULADAS = 0`; com `OFFSET` numérico, as mensagens que "desceram"
 * ficariam para sempre atrás do cursor.
 */
test("s2_offset_regression_realsqlite: remoção antes do cursor ⇒ PULADAS=0 (real)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-ingest-sql-"));
  const dbPath = join(dir, "kilo.db");
  try {
    const spec = "node:sqlite";
    const { DatabaseSync } = (await import(spec)) as {
      DatabaseSync: new (p: string) => {
        exec: (s: string) => void;
        prepare: (s: string) => { run: (...a: unknown[]) => void; all: (...a: unknown[]) => DbRow[] };
        close: () => void;
      };
    };
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);",
    );
    db.exec(
      "CREATE TABLE part (id TEXT, message_id TEXT, data TEXT);",
    );
    const insM = db.prepare(
      "INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)",
    );
    const insP = db.prepare("INSERT INTO part (id, message_id, data) VALUES (?,?,?)");
    for (let i = 0; i < 100; i++) {
      insM.run(`msg_${String(i).padStart(3, "0")}`, "ses_a", 1000 + i, JSON.stringify({ role: "user" }));
      insP.run(`p_${i}`, `msg_${String(i).padStart(3, "0")}`, JSON.stringify({ type: "text", text: `t${i}` }));
    }
    // Cursor já leu até a posição 60 (ts=1059, msg_059): o que veio ANTES dele
    // (ts <= 1059) é "passado".
    const cursor = { last_ts: 1059, last_id: "msg_059" };
    // Reproduz a compactação do ADR-008: remove 40 linhas **estritamente antes**
    // do cursor (posições 20..59, ts 1020..1059). As 40 mensagens ainda NÃO lidas
    // (ts 1060..1099) ficam intactas — é exatamente o cenário em que o `OFFSET`
    // numérico pula.
    db.exec("DELETE FROM message WHERE time_created >= 1020 AND time_created <= 1059");
    const remainingAfterCursor = db
      .prepare("SELECT count(*) AS c FROM message WHERE time_created > 1059")
      .all()[0]!.c as number;
    assert.equal(remainingAfterCursor, 40, "as 40 mensagens pós-cursor devem sobreviver");

    // Guarda de SHAPE do SQL (discriminação direta): o `readBatch` não pode
    // emitir `OFFSET` — reintroduzir posição numérica tem de **reprovar** aqui.
    let capturedSql = "";
    const backend: SqliteBackend = {
      query: (sql, params) => {
        if (sql.includes("FROM message")) capturedSql = sql;
        return db.prepare(sql).all(...params);
      },
      close: () => db.close(),
    };
    const first = readBatch(backend, "ses_a", cursor, 1000);
    assert.ok(
      !/offset/i.test(capturedSql),
      `readBatch não pode usar OFFSET (cursor por identidade, ADR-008); SQL=${capturedSql}`,
    );
    // PULADAS = 0: a primeira lida é a imediatamente após o cursor (ts=1060).
    assert.equal(first.messages[0]!.time_created, 1060, "deve retomar em ts=1060 (PULADAS=0)");
    assert.equal(first.messages[0]!.id, "msg_060");
    // Todas as 40 mensagens pós-cursor são alcançáveis (nenhum buraco).
    assert.equal(first.messages.length, 40);
    assert.equal(first.messages.at(-1)!.id, "msg_099", "a sequência pós-cursor sai completa");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Correções da revisão adversarial (fechamento E4) — casos de borda confirmados
// ---------------------------------------------------------------------------

test("adv_l1_log_emitted: o log do envio registra aceite NÃO confirmado", async () => {
  const { statePath, cleanup } = tmpState();
  const lines: string[] = [];
  __setLogSink((l) => lines.push(l));
  try {
    const backend = makeBackend(genMsgs(20, 1000));
    const { client } = stubClient(async () => ({ job_id: "job_xyz", status: "queued" }));
    await ingestOnce(rt(statePath, client), backend, "ses_a");
    const sent = lines.find((l) => l.includes("ingest sent"));
    assert.ok(sent, "a linha de envio deve ser emitida");
    assert.match(sent!, /accepted_not_confirmed=true/, "aceite ≠ processamento no log");
    assert.match(sent!, /job_id=job_xyz/);
  } finally {
    __setLogSink(null);
    cleanup();
  }
});

test("adv_l3_log_emitted: o reset do estado é emitido pela rotina (uma vez por classe)", async () => {
  const { statePath, cleanup } = tmpState();
  const lines: string[] = [];
  __setLogSink((l) => lines.push(l));
  try {
    // Estado ausente: a rotina deve emitir a linha de reset.
    const backend = makeBackend(genMsgs(5, 1000));
    const { client } = stubClient(async () => ({ job_id: "j" }));
    await runIngest(rt(statePath, client), backend, "ses_a", true);
    const resets = lines.filter((l) => l.includes("estado resetado"));
    assert.equal(resets.length, 1, "reset registrado (ausente)");
    // Novo gatilho, mesmo estado ausente: NÃO repete a linha (dedup).
    await runIngest(rt(statePath, client), backend, "ses_a", true);
    assert.equal(
      lines.filter((l) => l.includes("estado resetado")).length,
      1,
      "o reset não repete a cada gatilho",
    );
    // Corrupção (classe diferente) ⇒ nova linha.
    saveState(statePath, emptyState());
    writeFileSync(statePath, "{not json", "utf-8");
    await runIngest(rt(statePath, client), backend, "ses_a", true);
    assert.ok(
      lines.some((l) => l.includes("estado resetado (JSON corrompido")),
      "corrupção registra o reset",
    );
  } finally {
    __setLogSink(null);
    cleanup();
  }
});

test("adv_l2_cap_wired_through_routine: max_hashes da config limita o estado em produção", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    // 63 pendentes, lote=20, teto=2 ⇒ o dreno manda 4 lotes, mas o arquivo de
    // estado guarda só os 2 hashes mais recentes (FIFO aplicado pela ROTINA, não
    // só pela função pura — prova o encanamento config→rotina).
    const backend = makeBackend(genMsgs(63, 1000));
    const { client, calls } = stubClient(async () => ({ job_id: "j" }));
    await runIngest(rt(statePath, client, { max_hashes: 2 }), backend, "ses_a", true);
    assert.equal(calls.length, 4, "4 lotes enviados");
    const st = loadState(statePath);
    assert.equal(st.sentBatchHashes.length, 2, "estado limitado pelo teto da config");
    assert.equal(st.sentBatches!.length, 2, "a auditoria respeita o mesmo teto");
  } finally {
    cleanup();
  }
});

test("adv_part_json_null_does_not_stick: part `data`=null/JSON escalar não trava o cursor", () => {
  // `JSON.parse("null")`/`"123"`/`'"x"'` são válidos mas NÃO-objeto: sem o guard,
  // `p.type` lançaria `TypeError`, classificado como falha TRANSITÓRIA ⇒ cursor
  // nunca avança (livelock). Deve pular como "sem texto" e avançar.
  const backend = fakeBackend((sql: string, params: unknown[]): DbRow[] => {
    if (sql.includes("FROM message")) {
      const [sid, ts, ts2, id, limit] = params as [string, number, number, string, number];
      const rows = [
        { id: "m1", session_id: sid, time_created: 1000, data: JSON.stringify({ role: "user" }) },
        { id: "m2", session_id: sid, time_created: 1001, data: JSON.stringify({ role: "user" }) },
      ];
      return rows
        .filter((m) => m.time_created > ts || (m.time_created === ts2 && m.id > id))
        .slice(0, limit);
    }
    if (sql.includes("FROM part")) {
      const mid = params[0] as string;
      // m1: part "null" (JSON válido, não-objeto). m2: texto normal.
      if (mid === "m1") return [{ data: "null" }, { data: "123" }, { data: '"x"' }];
      return [{ data: JSON.stringify({ type: "text", text: "texto m2" }) }];
    }
    return [];
  });
  const read = readBatch(backend, "ses_a", { last_ts: 0, last_id: "" }, 10);
  assert.deepEqual(read.last, { last_ts: 1001, last_id: "m2" }, "o cursor avança sobre m1");
  assert.deepEqual(read.messages.map((m) => m.id), ["m2"], "m1 sem texto, m2 lido");
});

test("adv_message_data_scalar_poison: message `data`=null/escalar avança e reporta", () => {
  const backend = fakeBackend((sql: string, params: unknown[]): DbRow[] => {
    if (sql.includes("FROM message")) {
      const [sid, ts, ts2, id, limit] = params as [string, number, number, string, number];
      const rows = [
        { id: "m1", session_id: sid, time_created: 1000, data: "null" },
        { id: "m2", session_id: sid, time_created: 1001, data: "[1,2]" },
        { id: "m3", session_id: sid, time_created: 1002, data: JSON.stringify({ role: "user" }) },
      ];
      return rows
        .filter((m) => m.time_created > ts || (m.time_created === ts2 && m.id > id))
        .slice(0, limit);
    }
    if (sql.includes("FROM part")) {
      return [{ data: JSON.stringify({ type: "text", text: `t ${params[0]}` }) }];
    }
    return [];
  });
  const poisoned: string[] = [];
  const read = readBatch(backend, "ses_a", { last_ts: 0, last_id: "" }, 10, (id) => poisoned.push(id));
  assert.deepEqual(poisoned, ["m1", "m2"], "não-objeto é linha veneno (reportada)");
  assert.deepEqual(read.last, { last_ts: 1002, last_id: "m3" });
});

test("adv_null_timestamp_not_epoch_zero: time_created NULL não vira 1970", () => {
  const backend = fakeBackend((sql: string): DbRow[] => {
    if (sql.includes("FROM message")) {
      return [
        { id: "m1", time_created: null, data: JSON.stringify({ role: "user" }) },
        { id: "m2", time_created: 1000, data: JSON.stringify({ role: "user" }) },
      ];
    }
    if (sql.includes("FROM part")) {
      return [{ data: JSON.stringify({ type: "text", text: "hi" }) }];
    }
    return [];
  });
  const read = readBatch(backend, "ses_a", { last_ts: 0, last_id: "" }, 10);
  // m1 (ts null) é pulada; m2 é lida com o ts real.
  assert.deepEqual(read.messages.map((m) => m.id), ["m2"]);
  assert.equal(read.messages[0]!.time_created, 1000);
});

test("adv_dropped_idle_drain_is_coalesced: idle durante passada não descarta o dreno", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    // 7 pendentes, lote=5: o `message.updated` (single-pass) envia 1 lote de 5 e
    // fica PRESO no envio (holding a trava) enquanto o `session.idle` chega.
    const backend = makeBackend(genMsgs(7, 1000));
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const calls: string[] = [];
    const client = {
      ingest: async (body: string) => {
        calls.push(body);
        if (calls.length === 1) await gate; // segura só a 1ª passada
        return { job_id: "j" };
      },
    };
    const runtime = rt(statePath, client, { batch_size: 5 });
    // `message.updated`: envia o 1º lote de 5 e trava no `await gate`.
    const single = runIngest(runtime, backend, "ses_a", false);
    // `session.idle` chega com a trava tomada ⇒ deve CONSOLIDAR o dreno (não
    // descartar) — senão as 2 restantes ficariam presas (fere a decisão 4).
    const idle = runIngest(runtime, backend, "ses_a", true);
    await idle; // retorna cedo (trava tomada), mas sinalizou o dreno
    release();
    await single; // o detentor da trava absorve o dreno pedido
    // O dreno consolidado envia o resto (2) — total 2 lotes.
    assert.equal(calls.length, 2, "o idle consolidado drena o resto (não é descartado)");
    assert.equal(loadState(statePath).sessions.ses_a!.last_id, "msg_006");
  } finally {
    cleanup();
  }
});

test("adv_cross_session_state_not_lost: duas sessões concorrentes não se sobrescrevem", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const backendA = makeBackend(genMsgs(20, 1000));
    const backendB = fakeBackend((sql: string, params: unknown[]): DbRow[] => {
      if (sql.includes("FROM message")) {
        const [sid, ts, ts2, id, limit] = params as [string, number, number, string, number];
        return Array.from({ length: 20 }, (_, i) => ({
          id: `b_${String(i).padStart(3, "0")}`,
          session_id: sid,
          time_created: 2000 + i,
          data: JSON.stringify({ role: "user" }),
        }))
          .filter((m) => m.time_created > ts || (m.time_created === ts2 && m.id > id))
          .slice(0, limit);
      }
      if (sql.includes("FROM part")) {
        return [{ data: JSON.stringify({ type: "text", text: `txt ${params[0]}` }) }];
      }
      return [];
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const client = {
      ingest: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return { job_id: "j" };
      },
    };
    const runtime = rt(statePath, client);
    await Promise.all([
      runIngest(runtime, backendA, "ses_a", true),
      runIngest(runtime, backendB, "ses_b", true),
    ]);
    // O mutex por workspace serializa a transação ler-modificar-gravar: as DUAS
    // sessões coexistem no estado (antes, a última escrita apagava a primeira).
    const st = loadState(statePath);
    assert.ok(st.sessions.ses_a, "cursor de ses_a preservado");
    assert.ok(st.sessions.ses_b, "cursor de ses_b preservado");
    assert.equal(st.sentBatchHashes.length, 2, "os dois hashes sobrevivem");
    assert.equal(maxInFlight, 1, "a seção crítica do estado é serializada");
  } finally {
    cleanup();
  }
});

test("adv_loadstate_wrong_shape_logged: JSON válido de shape errado registra o reset", () => {
  for (const raw of ["[]", "123", '"x"', "null", "true"]) {
    const reasons: string[] = [];
    const st = loadState("/s.json", () => raw, (r) => reasons.push(r));
    assert.deepEqual(st, emptyState(), `shape ${raw} ⇒ estado vazio`);
    assert.equal(reasons.length, 1, `shape ${raw} ⇒ reset registrado (L-3)`);
  }
});

test("adv_config_batch_size_positive: batch_size<=0 cai no default (não vira LIMIT 0/neg)", () => {
  // Comportamento do resolvedor: validar via a função pura é o alvo; a config
  // real é coberta por config.test.ts. Aqui garantimos que `shouldSend` nunca
  // dispara com batch<=0 e que `readBatch` com limit<=0 não varre a tabela.
  assert.equal(shouldSend(5, 0), false);
  assert.equal(shouldSend(5, -1), false);
});

test("adv_invalid_id_ts_window_logs_and_stops: janela inteira sem id/ts válidos não gira", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    // Todas as linhas com id vazio ou ts não-numérico.
    const backend = fakeBackend((sql: string): DbRow[] => {
      if (sql.includes("FROM message")) {
        return [
          { id: "", time_created: 1000, data: JSON.stringify({ role: "user" }) },
          { id: "m2", time_created: null, data: JSON.stringify({ role: "user" }) },
        ];
      }
      return [];
    });
    const { client, calls } = stubClient(async () => ({ job_id: "j" }));
    await assert.doesNotReject(() => runIngest(rt(statePath, client), backend, "ses_a", true));
    assert.equal(calls.length, 0, "nada a enviar");
    // Não avança o cursor (nada válido) e não gira infinitamente (retorna).
  } finally {
    cleanup();
  }
});

test("s2_backend_provider_retries_after_failure: falha de abertura NÃO é cacheada", async () => {
  let attempts = 0;
  const fake: SqliteBackend = { query: () => [], close: () => {} };
  const provider = createBackendProvider("/missing/kilo.db", {
    open: async () => {
      attempts++;
      if (attempts === 1) throw new Error("ENOENT: banco ainda não existe");
      return fake;
    },
  });
  await assert.rejects(() => provider.get(), /ENOENT/);
  // A 2ª tentativa abre de verdade (antes, a promessa rejeitada ficava cacheada
  // para sempre — a ingestão só voltaria reiniciando o plugin).
  assert.equal(await provider.get(), fake);
  assert.equal(attempts, 2);
});

test("s2_backend_provider_close: fecha o handle uma vez e não relança", async () => {
  let closed = 0;
  const fake: SqliteBackend = { query: () => [], close: () => { closed++; } };
  const provider = createBackendProvider("/ok", { open: async () => fake });
  const b1 = await provider.get();
  assert.equal(b1, fake);
  assert.equal(await provider.get(), fake, "handle é reusado enquanto aberto");
  provider.close();
  assert.equal(closed, 1);
  // Fechar duas vezes não relança nem fecha novamente.
  provider.close();
  assert.equal(closed, 1);
});

test("s2_backend_provider_close_never_throws: erro do close não derruba o shutdown", () => {
  const provider = createBackendProvider("/x", { open: async () => ({ query: () => [], close: () => { throw new Error("boom"); } }) });
  assert.doesNotThrow(() => provider.close());
});

test("s2_backend_provider_lazy_path: resolvedor de caminho não roda até a 1ª abertura", async () => {
  // Regressão do deadlock de boot: quando o caminho do `kilo.db` vem do runtime
  // (`client.path.get`, chamada HTTP ao próprio servidor), ele NÃO pode ser
  // resolvido no boot do plugin — o `server()` travaria. Aqui o resolvedor
  // (assíncrono, como o `path.get`) só pode ser chamado na 1ª `get()`.
  let resolves = 0;
  const fake: SqliteBackend = { query: () => [], close: () => {} };
  const provider = createBackendProvider(
    async () => {
      resolves++;
      return "/runtime/kilo.db";
    },
    { open: async (p) => { assert.equal(p, "/runtime/kilo.db"); return fake; } },
  );
  assert.equal(resolves, 0, "resolvedor não roda ao construir o provider");
  assert.equal(await provider.get(), fake);
  assert.equal(resolves, 1, "resolvedor roda exatamente uma vez, na abertura");
});

test("s2_hook_dispose_closes_backend: o hook expõe `dispose` que fecha o provedor", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    let closed = 0;
    const fake: SqliteBackend = { query: () => [], close: () => { closed++; } };
    const { client } = stubClient(async () => ({ job_id: "j" }));
    const hooks = ingestHook({
      cfg: { enabled: true, batch_size: 20, max_hashes: 5000 },
      dbPath: "ignored",
      statePath,
      client,
      backend: fake,
    });
    assert.equal(typeof hooks.dispose, "function");
    // O backend INJETADO é embrulhado num provedor trivial (close no-op) — o
    // importante é que `dispose` exista e não lance. O provedor real é coberto
    // acima.
    hooks.dispose();
    assert.equal(closed, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// E4-S3 — session.idle drena tudo (o resto) + message.updated respeita o limiar
// ---------------------------------------------------------------------------

/** Roda o dreno completo (`session.idle`) e devolve os corpos enviados. */
async function drain(
  statePath: string,
  backend: SqliteBackend,
  batchSize: number,
): Promise<string[]> {
  const { client, calls } = stubClient(async () => ({ job_id: "j" }));
  await runIngest(rt(statePath, client, { batch_size: batchSize }), backend, "ses_a", true);
  return calls.map((c) => c.body);
}

test("s3_owner_example_63_20: 63 pendentes ⇒ 3 lotes de 20 + 1 de 3 (exemplo do dono)", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const backend = makeBackend(genMsgs(63, 1000));
    const bodies = await drain(statePath, backend, 20);
    assert.equal(bodies.length, 4, "3 lotes cheios + 1 resto");
    assert.equal(bodies[0]!.split("\n\n").length, 20);
    assert.equal(bodies[1]!.split("\n\n").length, 20);
    assert.equal(bodies[2]!.split("\n\n").length, 20);
    assert.equal(bodies[3]!.split("\n\n").length, 3, "o último lote leva o resto");
    // Cursor final cobriu as 63 ⇒ próxima passada não tem pendentes.
    const st = loadState(statePath);
    assert.equal(st.sessions.ses_a!.last_id, "msg_062");
    assert.equal(st.sentBatchHashes.length, 4);
  } finally {
    cleanup();
  }
});

test("s3_remainder_5: 5 pendentes ⇒ 1 lote de 5 (não fica preso abaixo do limiar)", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const backend = makeBackend(genMsgs(5, 1000));
    const bodies = await drain(statePath, backend, 20);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]!.split("\n\n").length, 5);
    assert.equal(loadState(statePath).sessions.ses_a!.last_id, "msg_004");
  } finally {
    cleanup();
  }
});

test("s3_zero_pendentes: nada pendente ⇒ não dispara (nem envia)", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const backend = makeBackend([]);
    const { client, calls } = stubClient(async () => ({ job_id: "j" }));
    const outcome = await ingestOnce(rt(statePath, client), backend, "ses_a", true);
    assert.equal(outcome.sent, false);
    assert.equal(outcome.rows, 0);
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

test("s3_trigger_difference: message.updated NÃO envia abaixo do limiar; session.idle envia", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const backend = makeBackend(genMsgs(5, 1000));
    const updated = stubClient(async () => ({ job_id: "j" }));
    const o1 = await ingestOnce(rt(statePath, updated.client), backend, "ses_a", false);
    assert.equal(o1.sent, false, "message.updated abaixo do limiar não envia");
    assert.equal(updated.calls.length, 0);

    const idle = stubClient(async () => ({ job_id: "j" }));
    await runIngest(rt(statePath, idle.client), backend, "ses_a", true);
    assert.equal(idle.calls.length, 1, "session.idle drena o resto");
  } finally {
    cleanup();
  }
});

test("s3_drain_cursor_concurrent: dois drenos concorrentes não corrompem o cursor", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const backend = makeBackend(genMsgs(63, 1000));
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: string[] = [];
    const client = {
      ingest: async (body: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        calls.push(body);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { job_id: "j" };
      },
    };
    const lock = new Set<string>();
    const runtime = rt(statePath, client, { batch_size: 20 });
    runtime.lock = lock;
    await Promise.all([
      runIngest(runtime, backend, "ses_a", true),
      runIngest(runtime, backend, "ses_a", true),
    ]);
    // A trava serializa: nenhuma sobreposição de envio e o cursor cobre tudo.
    assert.equal(maxInFlight, 1, "envios não podem se sobrepor na mesma sessão");
    const st = loadState(statePath);
    assert.equal(st.sessions.ses_a!.last_id, "msg_062", "cursor cobriu as 63");
    // Nenhum lote duplicado (hash distinto por lote).
    assert.equal(new Set(st.sentBatchHashes).size, st.sentBatchHashes.length);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// E4-S4 — limitações L-1/L-2/L-3 como critério de aceite
// ---------------------------------------------------------------------------

test("s4_l1_audit_accept_not_confirm: lote aceito é registrado como NÃO confirmado", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const backend = makeBackend(genMsgs(20, 1000));
    const { client } = stubClient(async () => ({ job_id: "job_l1", status: "queued" }));
    const outcome = await ingestOnce(rt(statePath, client), backend, "ses_a");
    assert.equal(outcome.sent, true);

    const st = loadState(statePath);
    assert.equal(st.sentBatches!.length, 1, "o lote aceito tem registro auditável");
    const audit = st.sentBatches![0]!;
    assert.equal(audit.hash, outcome.hash);
    assert.equal(audit.job_id, "job_l1");
    assert.equal(audit.reference_time, new Date(1019).toISOString());
    assert.equal(audit.confirmed, false, "o 202 confirma o ACEITE, não o processamento");
    assert.match(audit.accepted_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    cleanup();
  }
});

test("s4_l1_worker_failure_not_resent: lote que 'morre' no worker NÃO é reenviado (sem retry)", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const backend = makeBackend(genMsgs(20, 1000));
    const { client, calls } = stubClient(async () => ({ job_id: "j", status: "queued" }));
    // 1ª passada: aceito (o worker pode tê-lo perdido — o plugin não sabe).
    await ingestOnce(rt(statePath, client), backend, "ses_a");
    assert.equal(calls.length, 1);
    const audit = loadState(statePath).sentBatches![0]!;
    // O operador consegue IDENTIFICAR o lote perdido pelos dados de auditoria.
    assert.ok(audit.job_id && audit.hash && audit.reference_time);

    // Gatilhos subsequentes: nenhum reenvio (não há retry conservador — decisão
    // do dono; reenviar duplicaria arestas, medido 9→11).
    await runIngest(rt(statePath, client), backend, "ses_a", true);
    await runIngest(rt(statePath, client), backend, "ses_a", true);
    assert.equal(calls.length, 1, "o lote perdido não é reenviado");
  } finally {
    cleanup();
  }
});

test("s4_l2_hash_cap_fifo: ultrapassar o teto evicta os mais antigos (não cresce sem limite)", () => {
  const st = emptyState();
  const cap = 3;
  for (let i = 0; i < 5; i++) markBatchSent(st, `h${i}`, cap);
  assert.equal(st.sentBatchHashes.length, cap, "arquivo limitado pelo teto");
  assert.deepEqual(st.sentBatchHashes, ["h2", "h3", "h4"], "FIFO: os antigos saem");
  // Os hashes recentes continuam presentes (dedup ainda funciona na janela).
  assert.equal(hasSentBatch(st, "h4"), true);
  assert.equal(hasSentBatch(st, "h0"), false);
});

test("s4_l2_hash_cap_unlimited_and_dedup: teto<=0 é ilimitado; hash repetido não duplica", () => {
  const st = emptyState();
  for (let i = 0; i < 10; i++) markBatchSent(st, `h${i}`, 0);
  assert.equal(st.sentBatchHashes.length, 10, "sem teto quando maxHashes<=0");
  markBatchSent(st, "h9", 0);
  assert.equal(st.sentBatchHashes.length, 10, "hash repetido não re-insere");
});

test("s4_l2_audit_also_bounded: a auditoria L-1 respeita o mesmo teto", () => {
  const st = emptyState();
  for (let i = 0; i < 5; i++) {
    markBatchAccepted(st, {
      hash: `h${i}`,
      reference_time: "t",
      accepted_at: "a",
      confirmed: false,
    }, 2);
  }
  assert.equal(st.sentBatches!.length, 2);
  assert.equal(st.sentBatches![1]!.hash, "h4");
});

test("s4_l3_corrupt_state_degrades_and_replays: corromper o estado ⇒ degrada e reinsere", async () => {
  const { statePath, cleanup } = tmpState();
  try {
    const backend = makeBackend(genMsgs(20, 1000));
    const first = stubClient(async () => ({ job_id: "j1" }));
    await ingestOnce(rt(statePath, first.client), backend, "ses_a");
    assert.equal(first.calls.length, 1);

    // Corrompe o estado em disco (L-3).
    saveState(statePath, emptyState()); // zera (simula perda)
    const second = stubClient(async () => ({ job_id: "j2" }));
    await runIngest(rt(statePath, second.client), backend, "ses_a", true);
    // Comportamento DEFINIDO (documentado, não surpresa): o estado perdido faz o
    // cursor voltar ao início e o lote é reenviado — o grafo pode duplicar (custo
    // aceito). O que importa é degradar sem lançar e registrar (coberto pelo
    // `s4_l3_reset_logged`).
    assert.equal(second.calls.length, 1, "estado perdido ⇒ reenvio (consequência do L-3)");
  } finally {
    cleanup();
  }
});

test("s2_rows_threshold_semantics: limiar conta LINHAS (sanção ADR-007 §4.4), pinado", () => {
  // 20 linhas com só 1 texto ainda dispara (o lote sai com 1 mensagem) — este é
  // o comportamento do antecessor e do ADR-007; o teste o pinça para que uma
  // mudança futura de semântica seja intencional, não acidental.
  assert.equal(shouldSend(20, 20), true);
  assert.equal(shouldSend(19, 20), false);
});

// ---------------------------------------------------------------------------
// Guarda de workspace do `--ingest` (fail-closed)
// ---------------------------------------------------------------------------

/** Backend fake com UMA sessão e seu projeto (vínculo `session→project`). */
function scopeBackend(
  session: { project_id: string; directory: string; worktree: string } | null,
  extraDirs: string[] = [],
): SqliteBackend {
  return fakeBackend((sql: string): DbRow[] => {
    if (sql.includes("FROM session")) {
      return session ? [{ ...session }] : [];
    }
    if (sql.includes("FROM project_directory")) {
      return extraDirs.map((directory) => ({ directory }));
    }
    return [];
  });
}

test("scope_lookup_found: sessão existente ⇒ worktree + directory", () => {
  const scope = lookupSessionScope(
    scopeBackend({ project_id: "p1", directory: "/ws", worktree: "/ws" }),
    "ses_a",
  );
  assert.equal(scope.found, true);
  assert.equal(scope.projectWorktree, "/ws");
  assert.equal(scope.sessionDirectory, "/ws");
});

test("scope_lookup_missing: sessão inexistente ⇒ found=false", () => {
  assert.equal(lookupSessionScope(scopeBackend(null), "ses_nope").found, false);
});

test("scope_lookup_db_error: banco ilegível ⇒ found=false (nunca lança)", () => {
  const bad: SqliteBackend = {
    query: () => {
      throw new Error("SQLITE_BUSY");
    },
    close: () => {},
  };
  assert.equal(lookupSessionScope(bad, "ses_a").found, false);
});

test("scope_belongs_same: vínculo dentro do workspace ⇒ true", () => {
  const b = scopeBackend({ project_id: "p1", directory: "/ws", worktree: "/ws" });
  assert.equal(sessionBelongsToWorkspace(b, "ses_a", "/ws"), true);
});

test("scope_belongs_nested: sessão em subdir do workspace ⇒ true", () => {
  const b = scopeBackend({ project_id: "p1", directory: "/ws/sub", worktree: "/ws" });
  assert.equal(sessionBelongsToWorkspace(b, "ses_a", "/ws"), true);
});

test("scope_belongs_extra_dir: worktree secundária dentro do workspace ⇒ true", () => {
  const b = scopeBackend(
    { project_id: "p1", directory: "/elsewhere", worktree: "/elsewhere" },
    ["/ws/wt-1"],
  );
  assert.equal(sessionBelongsToWorkspace(b, "ses_a", "/ws"), true);
});

test("scope_rejects_other: sessão de OUTRO workspace ⇒ false", () => {
  const b = scopeBackend({
    project_id: "p2",
    directory: "/other/repo",
    worktree: "/other/repo",
  });
  assert.equal(sessionBelongsToWorkspace(b, "ses_x", "/ws"), false);
});

test("scope_rejects_prefix: /ws-evil NÃO casa /ws (sem prefixo ingênuo)", () => {
  const b = scopeBackend({
    project_id: "pe",
    directory: "/ws-evil",
    worktree: "/ws-evil",
  });
  assert.equal(sessionBelongsToWorkspace(b, "ses_evil", "/ws"), false);
});

test("scope_rejects_missing: sessão inexistente ⇒ false (fail-closed)", () => {
  assert.equal(sessionBelongsToWorkspace(scopeBackend(null), "ses_nope", "/ws"), false);
});

// ---------------------------------------------------------------------------
// Listagem do workspace (`--ingest --all`: mais antiga primeiro)
// ---------------------------------------------------------------------------

/**
 * Fake para `listWorkspaceSessions`: a query principal é `FROM session` (com
 * subquery `FROM project_directory` embutida — por isso `session` é checado
 * primeiro) e a dedicada de secundárias é `FROM project_directory` com LIKE.
 */
function listBackend(
  sessions: Array<{
    id: string;
    project_id: string;
    directory: string;
    worktree: string;
    time_created: number;
  }>,
  inWsProjectIds: string[] = [],
): SqliteBackend {
  return fakeBackend((sql: string): DbRow[] => {
    if (sql.includes("FROM session")) return sessions.map((s) => ({ ...s }));
    if (sql.includes("FROM project_directory")) {
      return inWsProjectIds.map((project_id) => ({ project_id }));
    }
    return [];
  });
}

test("list_oldest_first: ordena por time_created ASC (desempate por id)", () => {
  const b = listBackend([
    { id: "ses_new", project_id: "p", directory: "/ws", worktree: "/ws", time_created: 300 },
    { id: "ses_old", project_id: "p", directory: "/ws", worktree: "/ws", time_created: 100 },
    { id: "ses_mid", project_id: "p", directory: "/ws", worktree: "/ws", time_created: 200 },
  ]);
  assert.deepEqual(
    listWorkspaceSessions(b, "/ws").map((s) => s.id),
    ["ses_old", "ses_mid", "ses_new"],
  );
});

test("list_excludes_other_workspace: sessão alheia nunca entra", () => {
  const b = listBackend([
    { id: "ses_own", project_id: "p", directory: "/ws", worktree: "/ws", time_created: 1 },
    {
      id: "ses_out",
      project_id: "q",
      directory: "/other/repo",
      worktree: "/other/repo",
      time_created: 0,
    },
  ]);
  assert.deepEqual(
    listWorkspaceSessions(b, "/ws").map((s) => s.id),
    ["ses_own"],
  );
});

test("list_rejects_prefix: /ws-evil não entra em /ws", () => {
  const b = listBackend([
    {
      id: "ses_evil",
      project_id: "pe",
      directory: "/ws-evil",
      worktree: "/ws-evil",
      time_created: 1,
    },
  ]);
  assert.deepEqual(listWorkspaceSessions(b, "/ws"), []);
});

test("list_includes_nested: subdir do workspace entra", () => {
  const b = listBackend([
    { id: "ses_sub", project_id: "p", directory: "/ws/sub", worktree: "/ws", time_created: 1 },
  ]);
  assert.deepEqual(
    listWorkspaceSessions(b, "/ws").map((s) => s.id),
    ["ses_sub"],
  );
});

test("list_db_error: banco ilegível ⇒ [] (nunca lança)", () => {
  const bad: SqliteBackend = {
    query: () => {
      throw new Error("SQLITE_BUSY");
    },
    close: () => {},
  };
  assert.deepEqual(listWorkspaceSessions(bad, "/ws"), []);
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

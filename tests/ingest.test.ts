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
  createBackendProvider,
  DEFAULT_DB_PATH,
  fakeBackend,
  findKiloDb,
  IngestReadError,
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
// E4-S2 — cursor por identidade + idempotência
// ---------------------------------------------------------------------------

/**
 * DISCRIMINAÇÃO do OFFSET (padrão E3a/E3b): reproduz o defeito medido no
 * antecessor. Um cursor **posicional** (`LIMIT n OFFSET k`) pula mensagens
 * quando linhas antes do cursor são removidas (compactação); o cursor por
 * **tupla** `(time_created, id)` não. Se alguém reintroduzir `OFFSET` no
 * `readBatch`, este teste **reprova**.
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
    // Cursor já leu até a posição 50 (ts=1049).
    const cursor = { last_ts: 1049, last_id: "msg_049" };
    // Compactação remove 40 linhas ANTES do cursor (posições 20..59).
    db.exec("DELETE FROM message WHERE time_created >= 1020 AND time_created < 1060");

    const backend: SqliteBackend = {
      query: (sql, params) => db.prepare(sql).all(...params),
      close: () => db.close(),
    };
    const first = readBatch(backend, "ses_a", cursor, 1000);
    // Nenhuma mensagem PULADA: a primeira lida é a imediatamente após o cursor
    // (ts=1060). As remoções não deslocam a identidade.
    assert.equal(first.messages[0]!.time_created, 1060, "deve retomar em ts=1060 (PULADAS=0)");
    assert.equal(first.messages[0]!.id, "msg_060");
    // Todas as mensagens com ts > cursor continuam alcançáveis (nenhum buraco).
    assert.equal(first.messages.length, 40);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

test("s2_rows_threshold_semantics: limiar conta LINHAS (sanção ADR-007 §4.4), pinado", () => {
  // 20 linhas com só 1 texto ainda dispara (o lote sai com 1 mensagem) — este é
  // o comportamento do antecessor e do ADR-007; o teste o pinça para que uma
  // mudança futura de semântica seja intencional, não acidental.
  assert.equal(shouldSend(20, 20), true);
  assert.equal(shouldSend(19, 20), false);
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

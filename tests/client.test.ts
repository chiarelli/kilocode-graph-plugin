/**
 * E1-S1 — `client.ts`: `health()` com `fetch` injetado. Nenhum teste abre socket.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AuthError,
  InfraError,
  MemtierClient,
  MemtierHttpError,
  extractHttpDetail,
  httpError,
  type FetchLike,
  type ReadFileLike,
} from "../src/client.ts";

/** Stub que devolve uma `Response` construída a partir do status e body. */
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

test("health_ok: 200 {status:ok} ⇒ {ok:true,status:ok}", async () => {
  const client = new MemtierClient({
    url: "http://memtier:8400",
    fetch: stubFetch(200, {
      status: "ok",
      falkordb: "ok",
      indices: "ready",
      error: null,
    }),
  });
  const report = await client.health();
  assert.equal(report.ok, true);
  assert.equal(report.status, "ok");
  assert.equal(report.falkordb, "ok");
  assert.equal(report.indices, "ready");
});

test("health_degraded: 503 {status:degraded} ⇒ {ok:false}", async () => {
  const client = new MemtierClient({
    url: "http://memtier:8400",
    fetch: stubFetch(503, {
      status: "degraded",
      falkordb: "down",
      indices: "not_ready",
      error: "lifespan não inicializado",
    }),
  });
  const report = await client.health();
  assert.equal(report.ok, false);
  assert.equal(report.status, "degraded");
  assert.equal(report.falkordb, "down");
});

test("health_network_error: fetch lança ⇒ {ok:false,reason}, não lança", async () => {
  const client = new MemtierClient({
    url: "http://memtier:8400",
    fetch: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const report = await client.health();
  assert.equal(report.ok, false);
  assert.match(report.reason ?? "", /ECONNREFUSED/);
});

test("health_timeout: fetch pendura ⇒ aborta no timeout, {ok:false}", async () => {
  const client = new MemtierClient({
    url: "http://memtier:8400",
    timeout_ms: 20,
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        // `AbortSignal.timeout` é unref'd; um timer ref'd mantém o event loop
        // vivo até o abort disparar (o fetch real faria o mesmo via socket).
        const keepAlive = setTimeout(() => reject(new Error("no abort")), 1000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
  });
  const report = await client.health();
  assert.equal(report.ok, false);
  assert.ok(report.reason);
});

test("health_sends_bearer_when_token_present", async () => {
  let auth: string | undefined;
  const client = new MemtierClient({
    url: "http://memtier:8400",
    token: "s3cr3t",
    fetch: stubFetch(200, { status: "ok" }, (_i, init) => {
      auth = new Headers(init?.headers).get("Authorization") ?? undefined;
    }),
  });
  await client.health();
  assert.equal(auth, "Bearer s3cr3t");
});

test("health_no_bearer_without_token", async () => {
  let auth: string | undefined = "unset";
  const client = new MemtierClient({
    url: "http://memtier:8400",
    fetch: stubFetch(200, { status: "ok" }, (_i, init) => {
      auth = new Headers(init?.headers).get("Authorization") ?? undefined;
    }),
  });
  await client.health();
  assert.equal(auth, undefined);
});

test("health_hits_v1_health_path", async () => {
  let called = "";
  const client = new MemtierClient({
    url: "http://memtier:8400/",
    fetch: stubFetch(200, { status: "ok" }, (input) => {
      called = String(input);
    }),
  });
  await client.health();
  assert.equal(called, "http://memtier:8400/v1/health");
});

// --- E1-S2: endurecimento --------------------------------------------------

test("token_from_env: env vence o arquivo", async () => {
  let auth: string | undefined;
  const client = new MemtierClient({
    url: "http://memtier:8400",
    token: "envtoken",
    token_file: "/does/not/matter.json",
    readFile: () => JSON.stringify({ token: "filetoken" }),
    fetch: stubFetch(200, { status: "ok" }, (_i, init) => {
      auth = new Headers(init?.headers).get("Authorization") ?? undefined;
    }),
  });
  await client.health();
  assert.equal(auth, "Bearer envtoken");
});

test("token_from_file: lê o arquivo e cacheia (1 leitura)", async () => {
  let reads = 0;
  let auth: string | undefined;
  const readFile: ReadFileLike = () => {
    reads += 1;
    return JSON.stringify({ token: "filetoken" });
  };
  const client = new MemtierClient({
    url: "http://memtier:8400",
    token_file: "/ws/.kilo/graph-key.json",
    readFile,
    fetch: stubFetch(200, { status: "ok" }, (_i, init) => {
      auth = new Headers(init?.headers).get("Authorization") ?? undefined;
    }),
  });
  await client.health();
  await client.health();
  assert.equal(auth, "Bearer filetoken");
  assert.equal(reads, 1, "token_file deve ser lido uma vez (cache)");
});

test("token_absent: sem env nem arquivo ⇒ sem header (borda decide 401)", async () => {
  let auth: string | undefined = "unset";
  const client = new MemtierClient({
    url: "http://memtier:8400",
    token_file: "/missing.json",
    readFile: () => {
      throw new Error("ENOENT");
    },
    fetch: stubFetch(200, { status: "ok" }, (_i, init) => {
      auth = new Headers(init?.headers).get("Authorization") ?? undefined;
    }),
  });
  await client.health();
  assert.equal(auth, undefined);
});

// Defeito medido: o cache fixava `""` na primeira leitura vazia (o `health()` do
// boot), então uma chave que aparecesse DEPOIS era ignorada até reiniciar.
test("token_appears_later: chave criada após a 1ª leitura vazia é usada", async () => {
  let present = false;
  const auths: Array<string | undefined> = [];
  const client = new MemtierClient({
    url: "http://memtier:8400",
    token_file: "/ws/.kilo/graph-key.json",
    readFile: () => {
      if (!present) throw new Error("ENOENT");
      return JSON.stringify({ token: "late-token" });
    },
    fetch: stubFetch(200, { status: "ok" }, (_i, init) => {
      auths.push(new Headers(init?.headers).get("Authorization") ?? undefined);
    }),
  });
  await client.health(); // 1ª leitura: ausente ⇒ sem header
  assert.equal(auths[0], undefined);
  present = true; // provisionamento/rotação externa cria a chave
  await client.health(); // deve RELER e usar
  assert.equal(auths[1], "Bearer late-token", "não pode fixar o vazio para sempre");
});

test("token_empty_is_not_cached: arquivo corrompido depois consertado é relido", async () => {
  let raw = "not json";
  let auth: string | undefined;
  const client = new MemtierClient({
    url: "http://memtier:8400",
    token_file: "/ws/.kilo/graph-key.json",
    readFile: () => raw,
    fetch: stubFetch(200, { status: "ok" }, (_i, init) => {
      auth = new Headers(init?.headers).get("Authorization") ?? undefined;
    }),
  });
  await client.health();
  assert.equal(auth, undefined);
  raw = JSON.stringify({ token: "fixed" });
  await client.health();
  assert.equal(auth, "Bearer fixed");
});

test("token_whitespace_env: env só-espaços NÃO vence o arquivo", async () => {
  let auth: string | undefined;
  const client = new MemtierClient({
    url: "http://memtier:8400",
    token: "   ",
    token_file: "/ws/.kilo/graph-key.json",
    readFile: () => JSON.stringify({ token: "filetoken" }),
    fetch: stubFetch(200, { status: "ok" }, (_i, init) => {
      auth = new Headers(init?.headers).get("Authorization") ?? undefined;
    }),
  });
  await client.health();
  assert.equal(auth, "Bearer filetoken", "só-espaços cai no arquivo, não em `Bearer    `");
});

test("token_file_whitespace_token: token só-espaços no arquivo ⇒ sem header", async () => {
  let auth: string | undefined = "unset";
  const client = new MemtierClient({
    url: "http://memtier:8400",
    token_file: "/ws/.kilo/graph-key.json",
    readFile: () => JSON.stringify({ token: "   " }),
    fetch: stubFetch(200, { status: "ok" }, (_i, init) => {
      auth = new Headers(init?.headers).get("Authorization") ?? undefined;
    }),
  });
  await client.health();
  assert.equal(auth, undefined);
});

test("http_401_typed: request 401 ⇒ AuthError", async () => {
  const client = new MemtierClient({
    url: "http://memtier:8400",
    fetch: stubFetch(401, "unauthorized"),
  });
  await assert.rejects(
    () => client.request("POST", "/v1/recall", {}),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test("http_403_typed: request 403 ⇒ AuthError", async () => {
  const client = new MemtierClient({
    url: "http://memtier:8400",
    fetch: stubFetch(403, "forbidden"),
  });
  await assert.rejects(
    () => client.request("POST", "/v1/code/sync", {}),
    (err: unknown) => err instanceof AuthError && err.status === 403,
  );
});

test("http_503_typed: request 503 ⇒ InfraError", async () => {
  const client = new MemtierClient({
    url: "http://memtier:8400",
    fetch: stubFetch(503, "down"),
  });
  await assert.rejects(
    () => client.request("POST", "/v1/recall", {}),
    (err: unknown) => err instanceof InfraError && err.status === 503,
  );
});

test("http_other_typed: request 422 ⇒ MemtierHttpError (não Auth/Infra)", async () => {
  const client = new MemtierClient({
    url: "http://memtier:8400",
    fetch: stubFetch(422, "unprocessable"),
  });
  await assert.rejects(
    () => client.request("POST", "/v1/code/sync", {}),
    (err: unknown) =>
      err instanceof MemtierHttpError &&
      !(err instanceof AuthError) &&
      !(err instanceof InfraError) &&
      err.status === 422,
  );
});

test("http_error_message_bounded: body gigante não vira message gigante", async () => {
  // O memtier ecoa o `input` (body inteiro) no detalhe do 422. A `message` do
  // erro não pode carregar isso — foi o que travou a UI (4,7 MB no console).
  const huge = JSON.stringify({
    detail: [{ type: "value_error", msg: "duplicidade de identidade: x:y", input: "z".repeat(4_000_000) }],
  });
  const client = new MemtierClient({ url: "http://memtier:8400", fetch: stubFetch(422, huge) });
  await assert.rejects(
    () => client.request("POST", "/v1/code/sync", {}),
    (err: unknown) => {
      assert.ok(err instanceof MemtierHttpError && err.status === 422);
      assert.ok(
        (err as Error).message.length < 4096,
        `message tem ${(err as Error).message.length} chars — deveria ser limitada`,
      );
      // A parte útil (a msg do servidor) é preservada.
      assert.ok((err as Error).message.includes("duplicidade de identidade"));
      return true;
    },
  );
});

test("extractHttpDetail_non_json_truncates_raw", () => {
  const raw = "e".repeat(10_000);
  const out = extractHttpDetail(raw);
  assert.ok(out.length <= 2_048 + 16, `len=${out.length}`);
  assert.ok(out.includes("truncated"));
});

test("extractHttpDetail_small_json_unchanged", () => {
  const raw = JSON.stringify({ detail: [{ msg: "boom", input: "x" }] });
  assert.equal(extractHttpDetail(raw), raw);
});

test("extractHttpDetail_never_exceeds_cap: JSON gigante com msg longa ⇒ capado+marcado", () => {
  // `detail[].msg` que por si só estoura o teto: o resultado deve ficar DENTRO do
  // cap (antes a marca de corte era anexada além do limite).
  const raw = JSON.stringify({ detail: [{ msg: "z".repeat(10_000) }] });
  const out = extractHttpDetail(raw);
  assert.ok(out.length <= 2_048, `len=${out.length}`);
  assert.ok(out.includes("truncated"));
});

test("httpError_caps_detail: body de vários MB ⇒ message limitada (defesa central)", () => {
  // Sem isto, qualquer call site (ex.: `provision.ts`, que passa `res.text()` cru)
  // poderia fabricar uma `message` de MB e travar a UI ao logar.
  const huge = "z".repeat(4_000_000);
  const err = httpError(422, huge);
  assert.ok(err.message.length < 4_096, `message tem ${err.message.length} chars`);
  assert.ok(err.message.length <= 2_048 + 32, "respeita o teto do detalhe + prefixo");
});

test("httpError_small_detail_intact: detalhe curto passa como está", () => {
  const err = httpError(422, "duplicidade de identidade: x:y");
  assert.ok(err.message.includes("duplicidade de identidade: x:y"));
});

test("program_in_identity: resolveIdentity devolve {workspace,program}", () => {
  const client = new MemtierClient({
    url: "http://memtier:8400",
    workspace: "waweb",
    program: "custom",
  });
  assert.deepEqual(client.resolveIdentity(), {
    workspace: "waweb",
    program: "custom",
  });
});

test("program_default_identity: sem program ⇒ 'default'", () => {
  const client = new MemtierClient({ url: "http://memtier:8400", workspace: "ws" });
  assert.equal(client.resolveIdentity().program, "default");
});

test("token_never_logged: formatToken não expõe o valor", async () => {
  const { formatToken } = await import("../src/logger.ts");
  assert.equal(formatToken("supersecret"), "SET(len=11)");
  assert.ok(!formatToken("supersecret").includes("supersecret"));
});

/**
 * E1-S1 — `client.ts`: `health()` com `fetch` injetado. Nenhum teste abre socket.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MemtierClient, type FetchLike } from "../src/client.ts";

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

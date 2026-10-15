/**
 * Provisionamento do workspace 1:1 (`src/provision.ts`).
 *
 * `provision.ts` controla o vínculo 1:1 e o segredo em repouso — precisa de
 * cobertura de discriminação (não de eco de fixture). Aqui o `fetch` é FAKE
 * (sem rede) e o IO é injetado (sem disco), então cada ramo do fluxo de 5 passos
 * e cada guarda é exercitado de verdade.
 *
 * Cada teste asserta o EFEITO: quais requests saíram, com que bearer, e o que
 * foi (ou não) gravado.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { FetchLike } from "../src/client.ts";
import {
  ensureWorkspaceKey,
  hasUsableKey,
  type ProvisionIo,
  type ProvisionOptions,
  writeKeyFile,
} from "../src/provision.ts";

/** Registro de uma chamada feita pelo fluxo. */
interface Call {
  url: string;
  method: string;
  auth: string | undefined;
  body: unknown;
}

/**
 * Fake do plano de controle do memtier: responde conforme o caminho e registra
 * as chamadas. `overrides` permite forçar status/corpo por rota (para os
 * caminhos de falha). Default = fluxo feliz completo.
 */
function fakePlane(overrides: Partial<Record<string, () => Response>> = {}): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? "GET",
      auth: headers["Authorization"],
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    for (const [suffix, fn] of Object.entries(overrides)) {
      if (url.endsWith(suffix) && fn) return fn();
    }
    if (url.endsWith("/v1/mgmt/programs")) return json(201, { programa: "p" });
    if (url.endsWith("/v1/mgmt/workspaces"))
      return json(201, { group_id: "p--w" });
    if (url.endsWith("/v1/mgmt/invites")) return json(201, { invite_id: "inv-1" });
    if (url.endsWith("/v1/auth/claim-user")) return json(200, { token: "claim-tok" });
    if (url.endsWith("/v1/auth/rotate")) return json(200, { token: "rotated-tok" });
    return json(404, { detail: "not found" });
  };
  return { fetch: fetchImpl, calls };
}

/** IO em memória: nada toca o disco; permite inspecionar o que foi escrito. */
function memIo(initial: Record<string, string> = {}): ProvisionIo & {
  files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
    exists: (p) => files.has(p),
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: (p, d) => void files.set(p, d),
    rename: (from, to) => {
      const v = files.get(from);
      if (v === undefined) throw new Error(`ENOENT: ${from}`);
      files.delete(from);
      files.set(to, v);
    },
    mkdir: () => {},
  };
}

function baseOpts(over: Partial<ProvisionOptions> = {}): ProvisionOptions {
  return {
    url: "http://memtier:8400",
    managerToken: "manager-secret",
    workspace: "myws",
    program: "graphplugin",
    keyFile: "/ws/.kilo/graph-key.json",
    fetch: fakePlane().fetch,
    io: memIo(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// disabled / exists — os caminhos que NÃO fazem rede
// ---------------------------------------------------------------------------

test("provision_disabled: sem manager token não faz request algum", async () => {
  const { fetch, calls } = fakePlane();
  const out = await ensureWorkspaceKey(baseOpts({ managerToken: "", fetch }));
  assert.deepEqual(out, { provisioned: false, reason: "disabled" });
  assert.equal(calls.length, 0);
});

test("provision_disabled_whitespace: manager token só-espaços desliga", async () => {
  const { fetch, calls } = fakePlane();
  const out = await ensureWorkspaceKey(baseOpts({ managerToken: "   ", fetch }));
  assert.deepEqual(out, { provisioned: false, reason: "disabled" });
  assert.equal(calls.length, 0);
});

test("provision_exists: chave utilizável ⇒ NÃO sobrescreve nem faz rede", async () => {
  const io = memIo({
    "/ws/.kilo/graph-key.json": JSON.stringify({
      token: "existing-tok",
      workspace: "myws",
      program: "graphplugin",
    }),
  });
  const { fetch, calls } = fakePlane();
  const out = await ensureWorkspaceKey(baseOpts({ fetch, io }));
  assert.deepEqual(out, { provisioned: false, reason: "exists" });
  assert.equal(calls.length, 0, "não pode tocar a rede se a chave existe");
  // A chave original permanece byte-a-byte (nunca sobrescreve chave utilizável).
  assert.equal(
    io.files.get("/ws/.kilo/graph-key.json"),
    JSON.stringify({ token: "existing-tok", workspace: "myws", program: "graphplugin" }),
  );
});

test("provision_empty_keyfile: sem caminho de chave ⇒ failed, sem request", async () => {
  const { fetch, calls } = fakePlane();
  const out = await ensureWorkspaceKey(baseOpts({ keyFile: "", fetch }));
  assert.deepEqual(out, { provisioned: false, reason: "failed" });
  assert.equal(calls.length, 0, "não queima um bearer sem onde persistir");
});

// ---------------------------------------------------------------------------
// provisioned — o fluxo feliz de 5 passos
// ---------------------------------------------------------------------------

test("provision_happy: 5 passos na ordem, bearer certo por rota, chave rotacionada gravada", async () => {
  const { fetch, calls } = fakePlane();
  const io = memIo();
  const out = await ensureWorkspaceKey(baseOpts({ fetch, io }));

  assert.deepEqual(out, { provisioned: true, reason: "provisioned" });
  assert.deepEqual(
    calls.map((c) => c.url.replace("http://memtier:8400", "")),
    [
      "/v1/mgmt/programs",
      "/v1/mgmt/workspaces",
      "/v1/mgmt/invites",
      "/v1/auth/claim-user",
      "/v1/auth/rotate",
    ],
  );
  // Bearer por rota: mgmt com o gestor; claim SEM auth; rotate com o claim.
  const [c0, c1, c2, c3, c4] = calls as [Call, Call, Call, Call, Call];
  assert.equal(c0.auth, "Bearer manager-secret");
  assert.equal(c1.auth, "Bearer manager-secret");
  assert.equal(c2.auth, "Bearer manager-secret");
  assert.equal(c3.auth, undefined, "claim-user é rota pública");
  assert.equal(c4.auth, "Bearer claim-tok", "rotate usa o bearer do claim");
  // Bodies escopados ao par (programa, workspace).
  assert.deepEqual(c1.body, { programa: "graphplugin", workspace: "myws" });
  assert.deepEqual(c2.body, {
    kind: "user",
    name: "myws",
    programa: "graphplugin",
    workspace: "myws",
  });
  assert.deepEqual(c3.body, { invite_id: "inv-1" });
  // A chave persistida é a ROTACIONADA (nunca a show-once do claim).
  const saved = JSON.parse(io.files.get("/ws/.kilo/graph-key.json") as string);
  assert.deepEqual(saved, {
    token: "rotated-tok",
    workspace: "myws",
    program: "graphplugin",
  });
});

test("provision_program_409: programa já existente (409) é tolerado e segue", async () => {
  const { fetch, calls } = fakePlane({
    "/v1/mgmt/programs": () =>
      new Response("exists", { status: 409 }),
  });
  const out = await ensureWorkspaceKey(baseOpts({ fetch, io: memIo() }));
  assert.deepEqual(out, { provisioned: true, reason: "provisioned" });
  assert.equal(calls.length, 5, "409 no programa não aborta o fluxo");
});

test("provision_workspace_200: workspace duplicado (200 idempotente) é tolerado", async () => {
  const { fetch } = fakePlane({
    "/v1/mgmt/workspaces": () =>
      new Response(JSON.stringify({ group_id: "p--w" }), { status: 200 }),
  });
  const out = await ensureWorkspaceKey(baseOpts({ fetch, io: memIo() }));
  assert.deepEqual(out, { provisioned: true, reason: "provisioned" });
});

// ---------------------------------------------------------------------------
// failed — cada ponto de falha degrada (nunca lança) e NÃO grava chave
// ---------------------------------------------------------------------------

test("provision_fail_programs: 500 no programa ⇒ failed, chave não gravada", async () => {
  const io = memIo();
  const { fetch } = fakePlane({
    "/v1/mgmt/programs": () => new Response("boom", { status: 500 }),
  });
  const out = await ensureWorkspaceKey(baseOpts({ fetch, io }));
  assert.deepEqual(out, { provisioned: false, reason: "failed" });
  assert.equal(io.files.has("/ws/.kilo/graph-key.json"), false);
});

test("provision_fail_workspace_403: gestor não owns ⇒ failed (403 é fatal)", async () => {
  const { fetch } = fakePlane({
    "/v1/mgmt/workspaces": () => new Response("denied", { status: 403 }),
  });
  const out = await ensureWorkspaceKey(baseOpts({ fetch, io: memIo() }));
  assert.deepEqual(out, { provisioned: false, reason: "failed" });
});

test("provision_fail_invite_missing_id: resposta sem invite_id ⇒ failed", async () => {
  const { fetch } = fakePlane({
    "/v1/mgmt/invites": () =>
      new Response(JSON.stringify({}), { status: 201 }),
  });
  const out = await ensureWorkspaceKey(baseOpts({ fetch, io: memIo() }));
  assert.deepEqual(out, { provisioned: false, reason: "failed" });
});

test("provision_fail_claim_missing_token: claim sem token ⇒ failed", async () => {
  const { fetch } = fakePlane({
    "/v1/auth/claim-user": () =>
      new Response(JSON.stringify({ token: "" }), { status: 200 }),
  });
  const out = await ensureWorkspaceKey(baseOpts({ fetch, io: memIo() }));
  assert.deepEqual(out, { provisioned: false, reason: "failed" });
});

test("provision_fail_rotate_same_token: rotate ecoa o claim ⇒ failed (não persiste must_rotate)", async () => {
  const io = memIo();
  const { fetch } = fakePlane({
    "/v1/auth/rotate": () =>
      new Response(JSON.stringify({ token: "claim-tok" }), { status: 200 }),
  });
  const out = await ensureWorkspaceKey(baseOpts({ fetch, io }));
  assert.deepEqual(out, { provisioned: false, reason: "failed" });
  assert.equal(io.files.has("/ws/.kilo/graph-key.json"), false);
});

test("provision_fail_network: fetch lança (memtier fora do ar) ⇒ failed, nunca lança", async () => {
  const fetch: FetchLike = async () => {
    throw new Error("ECONNREFUSED");
  };
  const out = await ensureWorkspaceKey(baseOpts({ fetch, io: memIo() }));
  assert.deepEqual(out, { provisioned: false, reason: "failed" });
});

// ---------------------------------------------------------------------------
// concorrência — chamadas no MESMO processo são serializadas por keyFile
// ---------------------------------------------------------------------------

test("provision_concurrent_same_process: duas chamadas ⇒ UM fluxo, uma gravação", async () => {
  let rotates = 0;
  const { fetch, calls } = fakePlane({
    "/v1/auth/rotate": () => {
      rotates++;
      return new Response(JSON.stringify({ token: `rotated-${rotates}` }), {
        status: 200,
      });
    },
  });
  const io = memIo();
  const opts = baseOpts({ fetch, io });
  const [a, b] = await Promise.all([
    ensureWorkspaceKey(opts),
    ensureWorkspaceKey(opts),
  ]);
  assert.deepEqual(a, { provisioned: true, reason: "provisioned" });
  assert.deepEqual(b, { provisioned: true, reason: "provisioned" });
  assert.equal(rotates, 1, "o fluxo de 5 passos roda UMA vez, não duas");
  // O segundo chamador reusa o resultado; a chave é a do único fluxo.
  const saved = JSON.parse(io.files.get("/ws/.kilo/graph-key.json") as string);
  assert.equal(saved.token, "rotated-1");
  assert.equal(calls.length, 5, "5 requests no total, não 10");
});

// ---------------------------------------------------------------------------
// hasUsableKey / writeKeyFile — unidade
// ---------------------------------------------------------------------------

test("hasUsableKey: token vazio/só-espaços/corrompido ⇒ false (provisiona por cima)", () => {
  const keyFile = "/ws/k.json";
  const cases: Array<[string, boolean]> = [
    [JSON.stringify({ token: "x" }), true],
    [JSON.stringify({ token: "" }), false],
    [JSON.stringify({ token: "   " }), false],
    [JSON.stringify({ token: null }), false],
    [JSON.stringify({}), false],
    ["not json", false],
    [JSON.stringify([1, 2]), false],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(
      hasUsableKey(keyFile, { exists: () => true, readFile: () => raw }),
      expected,
      `raw=${raw}`,
    );
  }
  assert.equal(hasUsableKey("", { exists: () => true, readFile: () => "{}" }), false);
  assert.equal(
    hasUsableKey(keyFile, { exists: () => false, readFile: () => "{}" }),
    false,
  );
});

test("writeKeyFile: grava em `.tmp` e renomeia (atômico), criando o diretório", () => {
  const io = memIo();
  const created: string[] = [];
  writeKeyFile(
    { ...baseOpts(), io: { ...io, mkdir: (p) => created.push(p) }, tmpSuffix: "42" },
    { token: "t", workspace: "w", program: "p" },
  );
  assert.deepEqual(created, ["/ws/.kilo"], "cria o `.kilo/` antes de gravar");
  assert.equal(io.files.has("/ws/.kilo/graph-key.json.tmp.42"), false, "tmp não fica");
  assert.deepEqual(JSON.parse(io.files.get("/ws/.kilo/graph-key.json") as string), {
    token: "t",
    workspace: "w",
    program: "p",
  });
});

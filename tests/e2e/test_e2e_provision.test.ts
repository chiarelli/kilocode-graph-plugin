/**
 * E2E real do PROVISIONAMENTO do workspace 1:1 (gated `E2E=1`).
 *
 * Roda contra a stack REAL do memtier (`127.0.0.1:8400`, de pé). Prova o efeito
 * ponta a ponta da afirmação do README: com o bearer do **gestor** no ambiente
 * (`KILOCODE_GRAPH_MANAGER_TOKEN`) e a chave do workspace **ausente**, o plugin
 * cria o workspace memtier no boot e salva a chave.
 *
 * Fluxo exercitado de verdade (não mock):
 *   1. O plugin **boota** (`server(ctx, options)`) num workspace SEM
 *      `.kilo/graph-key.json` e com o manager token no ambiente.
 *   2. O plugin roda os 5 passos do plano de controle contra o memtier vivo
 *      (program → workspace → invite → claim-user → rotate) e grava a chave.
 *   3. **Efeito do outro lado:** a chave gravada autentica no plano de dados
 *      (`POST /v1/recall` → 200) — prova que é o bearer ROTACIONADO (um bearer
 *      de claim responderia 403 `rotation_required`).
 *   4. **Segundo boot** com a chave presente NÃO reprovisiona (a chave é
 *      byte-a-byte a mesma) — prova "nunca sobrescreve chave utilizável".
 *   5. **Sem** o manager token, nenhum arquivo de chave é criado.
 *
 * Pré-requisito: `E2E_MANAGER_TOKEN` — um bearer de GESTOR real (preset
 * `gestor`, capability `manage`). O bootstrap-admin (`admin`) NÃO serve: ele não
 * tem `manage` (403). Em `E2E=1` sem o token, o teste **falha** (nunca skip
 * silencioso).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import pluginModule from "../../src/index.ts";
import { workspaceName } from "../../src/workspace.ts";

const E2E = process.env.E2E === "1";
const MEMTIER_URL = process.env.KILOCODE_GRAPH_URL ?? "http://127.0.0.1:8400";
const MANAGER_TOKEN = process.env.E2E_MANAGER_TOKEN ?? "";
/**
 * Programa do E2E. **Único por execução** por padrão: um programa só é "owned"
 * pelo gestor que o criou (`_require_program_owner` ⇒ 403 para outro gestor), e
 * cada execução cunha um gestor novo — um nome fixo tornaria a 2ª execução
 * vermelha por ambiente (medido: `e2eprov` ⇒ 403 "não owns"). `E2E_PROVISION_PROGRAM`
 * permite fixar (ex.: um programa já owned pelo gestor).
 */
const PROGRAM =
  process.env.E2E_PROVISION_PROGRAM ?? `e2eprov${Date.now().toString(36)}`;

/** Workspace de um diretório temporário único (evita colisão entre execuções). */
function freshWorkspace(): { dir: string; ws: string; kiloDir: string } {
  const base = mkdtempSync(join(tmpdir(), "graph-e2e-prov-"));
  const dir = join(base, "e2e-prov");
  const kiloDir = join(dir, ".kilo");
  mkdirSync(kiloDir, { recursive: true });
  return { dir, ws: workspaceName(dir), kiloDir };
}

/** `POST /v1/recall` com um bearer; devolve o status (efeito do outro lado). */
async function recallStatus(token: string, ws: string): Promise<number> {
  const res = await fetch(`${MEMTIER_URL}/v1/recall`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ program: PROGRAM, workspace: ws, query: "provision e2e" }),
  });
  return res.status;
}

test("e2e provision: manager token ⇒ cria workspace, grava chave, e a chave autentica", {
  skip: !E2E,
}, async () => {
  assert.ok(
    MANAGER_TOKEN,
    "E2E_MANAGER_TOKEN ausente: o E2E do provisionamento exige um bearer de " +
      "gestor real (preset gestor; o bootstrap-admin não tem capability manage)",
  );

  const { dir, ws, kiloDir } = freshWorkspace();
  const keyFile = join(kiloDir, "graph-key.json");
  const prevManager = process.env.KILOCODE_GRAPH_MANAGER_TOKEN;
  process.env.KILOCODE_GRAPH_MANAGER_TOKEN = MANAGER_TOKEN;
  try {
    assert.equal(existsSync(keyFile), false, "pré-condição: chave ausente");

    // Boot 1: provisiona.
    const hooks = await pluginModule.server(
      { directory: dir, worktree: null },
      {
        daemon: {
          url: MEMTIER_URL,
          token_file: keyFile,
          program: PROGRAM,
          health_timeout_ms: 3000,
        },
        debug: true,
      },
    );
    await hooks.dispose?.();

    // Efeito local: a chave foi gravada, no formato do bearer do workspace.
    assert.ok(existsSync(keyFile), "o boot deve criar .kilo/graph-key.json");
    const saved = JSON.parse(readFileSync(keyFile, "utf-8")) as {
      token: string;
      workspace: string;
      program: string;
    };
    assert.equal(saved.workspace, ws);
    assert.equal(saved.program, PROGRAM);
    assert.ok(saved.token.length > 0, "a chave deve conter um token não-vazio");
    // Modo 0600: o segredo não nasce legível por terceiros.
    assert.equal(
      statSync(keyFile).mode & 0o777,
      0o600,
      "a chave do workspace deve ser gravada em 0600",
    );

    // Efeito do OUTRO lado: o bearer gravado autentica no plano de dados. Um
    // bearer de claim (não rotacionado) daria 403 `rotation_required` — 200
    // prova que o plugin persistiu o token ROTACIONADO.
    assert.equal(
      await recallStatus(saved.token, ws),
      200,
      "a chave gravada deve autenticar no /v1/recall (bearer rotacionado)",
    );

    // Boot 2: a chave existe ⇒ NÃO reprovisiona (não sobrescreve utilizável).
    const hooks2 = await pluginModule.server(
      { directory: dir, worktree: null },
      {
        daemon: {
          url: MEMTIER_URL,
          token_file: keyFile,
          program: PROGRAM,
          health_timeout_ms: 3000,
        },
        debug: true,
      },
    );
    await hooks2.dispose?.();
    const after = JSON.parse(readFileSync(keyFile, "utf-8")) as { token: string };
    assert.equal(
      after.token,
      saved.token,
      "um segundo boot não pode reescrever a chave existente",
    );
  } finally {
    if (prevManager === undefined) delete process.env.KILOCODE_GRAPH_MANAGER_TOKEN;
    else process.env.KILOCODE_GRAPH_MANAGER_TOKEN = prevManager;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e provision: SEM manager token ⇒ nenhuma chave criada (desligado)", {
  skip: !E2E,
}, async () => {
  const { dir, kiloDir } = freshWorkspace();
  const keyFile = join(kiloDir, "graph-key.json");
  const prevManager = process.env.KILOCODE_GRAPH_MANAGER_TOKEN;
  delete process.env.KILOCODE_GRAPH_MANAGER_TOKEN;
  try {
    const hooks = await pluginModule.server(
      { directory: dir, worktree: null },
      {
        daemon: {
          url: MEMTIER_URL,
          token_file: keyFile,
          program: PROGRAM,
          health_timeout_ms: 3000,
        },
        debug: true,
      },
    );
    await hooks.dispose?.();
    assert.equal(
      existsSync(keyFile),
      false,
      "sem o bearer do gestor, o provisionamento não cria a chave",
    );
  } finally {
    if (prevManager !== undefined) process.env.KILOCODE_GRAPH_MANAGER_TOKEN = prevManager;
    rmSync(dir, { recursive: true, force: true });
  }
});

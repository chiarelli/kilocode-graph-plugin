/**
 * `cli-spawn.ts` — o boot spawna o CLI destacado. Cobre o caminho PRIMÁRIO da
 * correção: num host Bun, o filho precisa receber `BUN_BE_BUN=1` no env, senão o
 * binário trata o `.ts` como diretório e a coleta falha em silêncio
 * (`stdio: "ignore"` esconde o erro).
 */

import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { test } from "node:test";

import { spawnCollectCli } from "../src/cli-spawn.ts";

/** Captura os argumentos passados ao `spawn` injetado. */
function captureSpawn(): {
  calls: Array<{ bin: string; args: string[]; opts: Record<string, unknown> }>;
  spawnFn: typeof spawn;
} {
  const calls: Array<{ bin: string; args: string[]; opts: Record<string, unknown> }> = [];
  // Stub mínimo: registra a chamada e devolve um "child" inerte (com `on`/`unref`).
  const spawnFn = ((bin: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ bin, args, opts });
    return { on: () => {}, unref: () => {} };
  }) as unknown as typeof spawn;
  return { calls, spawnFn };
}

test("spawn_collect_cli_bun_host_sets_BUN_BE_BUN: host Bun ⇒ env propaga o escape hatch", () => {
  const { calls, spawnFn } = captureSpawn();
  const ok = spawnCollectCli({
    workspace: "/ws",
    cliPath: "/p/src/cli.ts",
    nodeBin: "/opt/kilo",
    hostIsBun: true,
    spawnFn,
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.bin, "/opt/kilo");
  const env = call.opts.env as NodeJS.ProcessEnv;
  assert.equal(env.BUN_BE_BUN, "1", "host Bun deve propagar BUN_BE_BUN=1");
  // `--workspace` obrigatório: sem ele o CLI sai 2 e nada sincroniza.
  assert.deepEqual(call.args, [
    "/p/src/cli.ts",
    "--workspace",
    "/ws",
    "--mode",
    "auto",
  ]);
});

test("spawn_collect_cli_node_host_no_BUN_BE_BUN: host Node ⇒ env intacto", () => {
  const { calls, spawnFn } = captureSpawn();
  spawnCollectCli({
    workspace: "/ws",
    cliPath: "/p/src/cli.ts",
    nodeBin: "/usr/bin/node",
    hostIsBun: false,
    spawnFn,
  });
  const env = calls[0]!.opts.env as NodeJS.ProcessEnv;
  assert.equal(env.BUN_BE_BUN, undefined, "host Node não injeta BUN_BE_BUN");
});

test("spawn_collect_cli_source_in_args: --source é propagado", () => {
  const { calls, spawnFn } = captureSpawn();
  spawnCollectCli({
    workspace: "/ws",
    cliPath: "/p/src/cli.ts",
    source: "boot",
    hostIsBun: false,
    spawnFn,
  });
  assert.deepEqual(calls[0]!.args.slice(-2), ["--source", "boot"]);
});

/**
 * `cli-spawn.ts` — o boot invoca o CLI standalone em `auto` (E3a-S6a, §1b/§2).
 *
 * O CLI é o **único escritor** do grafo; o plugin **não** coleta. No boot, o
 * plugin spawna `node <plugin>/src/cli.ts --mode auto` **em background** (nunca
 * `await` no caminho crítico — FR-510) e instala os hooks git.
 *
 * O processo é **destacado e desanexado** (`detached: true` + `unref()` +
 * `stdio: "ignore"`): o boot não espera a indexação (que pode levar minutos) e o
 * filho não segura o shutdown do plugin. Nunca lança — falha vira log.
 *
 * O caminho do CLI é derivado de `import.meta.url` (o próprio `src/` do plugin),
 * então o boot e o hook apontam para o MESMO arquivo.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { debug, log } from "./logger.ts";

/** Caminho absoluto do `src/cli.ts` do plugin (vizinho deste módulo). */
export function cliPath(): string {
  return fileURLToPath(new URL("./cli.ts", import.meta.url));
}

export interface SpawnCliOptions {
  /** Raiz do workspace (passado explicitamente ao CLI). */
  workspace: string;
  /** Modo do CLI (`auto` no boot; o hook usa `auto` também). */
  mode?: "auto" | "full" | "incremental";
  /** Fonte do disparo (observabilidade; ex.: `boot`, `post-commit`). */
  source?: string;
  /** Caminho do CLI (default `cliPath()`); injetável em teste. */
  cliPath?: string;
  /** Caminho do `node` (default `process.execPath`); injetável em teste. */
  nodeBin?: string;
  /** `spawn` injetável (teste sem processo real). */
  spawnFn?: typeof spawn;
}

/**
 * Spawna o CLI destacado (fire-and-forget). Devolve `true` quando o processo foi
 * criado. **Nunca lança**.
 */
export function spawnCollectCli(opts: SpawnCliOptions): boolean {
  const node = opts.nodeBin ?? process.execPath;
  const cli = opts.cliPath ?? cliPath();
  const mode = opts.mode ?? "auto";
  const args = [cli, "--workspace", opts.workspace, "--mode", mode];
  if (opts.source) args.push("--source", opts.source);
  const spawnFn = opts.spawnFn ?? spawn;
  try {
    const child = spawnFn(node, args, {
      detached: true,
      stdio: "ignore",
    });
    // `spawn` reporta falha assíncrona (ENOENT do `node`, etc.) por evento
    // `'error'`, não por throw — sem um listener, o Node lança `uncaughtException`
    // e derruba o processo do boot. Loga e segue (o boot nunca quebra por isso).
    child.on("error", (err) => {
      log(
        `collect: CLI não spawnou (${err instanceof Error ? err.message : err})`,
      );
    });
    // Desanexa: o boot não espera o CLI (indexação pode levar minutos).
    child.unref?.();
    debug(`collect: CLI spawnado em background (mode=${mode}, source=${opts.source ?? "boot"})`);
    return true;
  } catch (err) {
    log(
      `collect: falha ao spawnar o CLI (${err instanceof Error ? err.message : err})`,
    );
    return false;
  }
}

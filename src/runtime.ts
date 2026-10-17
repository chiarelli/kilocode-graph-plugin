/**
 * `runtime.ts` — resolve o interpretador JS do CLI standalone (correção do delta
 * em runtime).
 *
 * O plugin roda **dentro do extension host do Kilo**, que **não é Node**: é um
 * executável **Bun de arquivo único** (`process.execPath` → `.../bin/kilo`).
 * Esse binário, ao receber um `.ts` como 1º argumento, trata o caminho como
 * diretório de projeto e sai com erro — **nenhum CLI é executado**, e a coleta
 * (boot e hook pós-commit) falha em silêncio (o hook descarta stdout/stderr).
 *
 * O Bun expõe um escape hatch (`BUN_BE_BUN=1`, Bun ≥ 1.2.16) que faz o MESMO
 * binário agir como o CLI do `bun`, que roda `.ts` nativamente. Este módulo
 * centraliza a decisão para os DOIS pontos que embutem o interpretador: o spawn
 * do boot (`cli-spawn`) e o script do hook (`install-hooks`).
 *
 * Precedência: um override explícito (`daemon.node_bin` /
 * `KILOCODE_GRAPH_NODE_BIN`) vence `process.execPath`. Host Bun ⇒ propaga
 * `BUN_BE_BUN=1`; host Node ⇒ env intacto (o binário já é Node).
 */

/** Interpretador resolvido + env a propagar para o processo filho. */
export interface NodeRuntime {
  /** Binário do interpretador (override explícito > `process.execPath`). */
  bin: string;
  /** Env do processo filho (com `BUN_BE_BUN=1` quando o host é Bun). */
  env: NodeJS.ProcessEnv;
  /** Prefixo POSIX para o script do hook (ex.: `BUN_BE_BUN=1 `); vazio no Node. */
  shellEnvPrefix: string;
}

/** `true` quando o processo atual roda sobre o runtime do Bun. */
export function isBunHost(): boolean {
  return typeof (process.versions as Record<string, string | undefined>).bun === "string";
}

/**
 * Resolve o interpretador do CLI. `override` vazio/só-espaços cai em
 * `process.execPath`. O `hostIsBun` é injetável para o teste cobrir os dois hosts
 * sem depender do runtime real.
 */
export function resolveNodeRuntime(
  override?: string,
  hostIsBun: boolean = isBunHost(),
): NodeRuntime {
  const bin = override?.trim() || process.execPath;
  if (!hostIsBun) {
    return { bin, env: process.env, shellEnvPrefix: "" };
  }
  return {
    bin,
    env: { ...process.env, BUN_BE_BUN: "1" },
    shellEnvPrefix: "BUN_BE_BUN=1 ",
  };
}

/**
 * `cli.ts` — CLI standalone do coletor (E3a-S6a, §2).
 *
 * Invocável por `node <plugin>/src/cli.ts` (Node ≥22, type-stripping). O CLI é o
 * **único escritor** do grafo (§1b): assume full **e** incremental. Duas origens
 * o invocam — o boot do plugin e os hooks git (post-commit/checkout/merge/rewrite):
 *
 *   node src/cli.ts --workspace <repo-root> --mode auto [--source post-commit]
 *
 * Resolve, a partir do `--workspace` explícito (§2): a config (§7, via
 * `graph-config.json` persistido + env + arquivo), o nome do workspace
 * (`config.daemon.workspace || workspaceName(dir)`) e a chave
 * (`resolveTokenFile`). **Reusa** as regras do boot — não reimplementa.
 *
 * Modo `auto` (default): híbrido (§1b) — full no 1º uso, incremental depois
 * (manifest + guarda de ancestralidade decidem). **Não** é full fixo.
 *
 * Garantias:
 *   - **Fire-and-forget** a partir do hook (o script o destaca — §1).
 *   - **Nunca lança** para o chamador: erro vira exit code + linha de log.
 *   - **Sentinela** (§3): um incremental só roda com `graph-ready` presente; o
 *     full inicial é quem o cria.
 *   - **Trava cross-process** (§3b): serializa boot × commit e commit × commit.
 *
 * `runCli` recebe dependências injetáveis para o teste unitário rodar sem git,
 * sem spawn e sem rede.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { MemtierClient } from "./client.ts";
import {
  loadConfig,
  loadConfigState,
  READY_REL_PATH,
} from "./config.ts";
import { collectCode, type CollectRuntime } from "./hooks/collect.ts";
import { createGitPort, type GitPort } from "./index/git.ts";
import { LOCK_REL_PATH } from "./index/lock.ts";
import { debug, log, logFatal } from "./logger.ts";
import { resolveTokenFile } from "./token-file.ts";
import { workspaceName } from "./workspace.ts";

/** Modo de indexação pedido na linha de comando. */
export type CliMode = "auto" | "full" | "incremental";

/** Argumentos resolvidos do CLI. */
export interface CliArgs {
  /** Raiz do repo (workspace). Obrigatório e explícito (§2). */
  workspace: string;
  mode: CliMode;
  /** Origem do disparo (observabilidade §S6c; ex.: `boot`, `post-commit`). */
  source?: string;
}

/**
 * Faz o parse de `--workspace <dir>`, `--mode <auto|full|incremental>` e
 * `--source <name>`. Devolve `{ error }` em falta/valor inválido — o `main`
 * converte em exit code (nunca lança).
 */
export function parseArgs(argv: string[]): CliArgs | { error: string } {
  let workspace = "";
  let mode: CliMode = "auto";
  let source: string | undefined;
  // Valor de uma flag: ausente OU outro flag (`--mode`) ⇒ erro explícito, em vez
  // de consumir o próximo flag como se fosse o valor (`--workspace --mode` não
  // pode virar workspace `"--mode"`).
  const valueOf = (flag: string, i: number): string | { error: string } => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      return { error: `${flag} exige um valor` };
    }
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--workspace") {
      const v = valueOf("--workspace", i);
      if (typeof v !== "string") return v;
      workspace = v;
      i += 1;
    } else if (a === "--mode") {
      const v = valueOf("--mode", i);
      if (typeof v !== "string") return v;
      if (v !== "auto" && v !== "full" && v !== "incremental") {
        return { error: `--mode inválido: ${v}` };
      }
      mode = v;
      i += 1;
    } else if (a === "--source") {
      const v = valueOf("--source", i);
      if (typeof v !== "string") return v;
      source = v;
      i += 1;
    }
    // Flags desconhecidas são ignoradas (o script do hook pode repassar "$@").
  }
  if (!workspace) return { error: "--workspace é obrigatório" };
  return { workspace, mode, ...(source ? { source } : {}) };
}

/** Dependências injetáveis (default: produção). */
export interface CliDeps {
  loadConfig?: typeof loadConfig;
  loadConfigState?: typeof loadConfigState;
  collectCode?: typeof collectCode;
  git?: GitPort;
  exists?: (p: string) => boolean;
  writeReady?: (p: string, data: string) => void;
}

/** Grava o sentinela `graph-ready` (best-effort; nunca lança). */
function writeReadyFile(path: string): void {
  try {
    const parent = dirname(path);
    if (parent && parent !== ".") mkdirSync(parent, { recursive: true });
    writeFileSync(path, `${new Date().toISOString()}\n`, "utf-8");
  } catch (err) {
    debug(
      `collect: graph-ready não gravado (${err instanceof Error ? err.message : err})`,
    );
  }
}

/**
 * Executa uma coleta CLI. Devolve o **exit code** (0 = ok, 1 = falha degradada,
 * 2 = args inválidos). **Nunca lança**.
 */
export async function runCli(args: CliArgs, deps: CliDeps = {}): Promise<number> {
  const dir = args.workspace;
  const loadConfigFn = deps.loadConfig ?? loadConfig;
  const loadStateFn = deps.loadConfigState ?? loadConfigState;
  const collectFn = deps.collectCode ?? collectCode;
  const git = deps.git ?? createGitPort();
  const exists = deps.exists ?? existsSync;
  const writeReady = deps.writeReady ?? writeReadyFile;

  try {
    // §7: a config persistida do boot entra como `options` (o CLI não tem o
    // `options` inline do `kilo.jsonc`); env e arquivo complementam. Segredos
    // não vêm daqui (só a `graph-key.json` carrega token).
    const config = loadConfigFn(loadStateFn(dir), dir);
    const workspace = config.daemon.workspace || workspaceName(dir);
    const keyFile = resolveTokenFile(dir, config.daemon.token_file);

    const client = new MemtierClient({
      url: config.daemon.url,
      workspace,
      program: config.daemon.program,
      token: config.daemon.token,
      token_file: keyFile,
      sync_timeout_ms: config.code_index.sync_timeout_ms,
    });

    const readyPath = join(dir, READY_REL_PATH);
    const rt: CollectRuntime = {
      cfg: config.code_index,
      repoRoot: dir,
      identity: { workspace, program: config.daemon.program },
      client,
      git,
      lockPath: join(dir, LOCK_REL_PATH),
      ready: () => exists(readyPath),
      onFullComplete: () => writeReady(readyPath, `${new Date().toISOString()}\n`),
      forceMode: args.mode,
      // S6c: a linha de observabilidade do coletor carrega a origem do disparo
      // (`boot`/`post-commit`/…), distinguindo o delta de runtime do boot.
      source: args.source ?? "cli",
    };

    // `null` cobre: desligado, sentinela ausente (aguardando full inicial),
    // indexer fora, erro fatal do job, trava ocupada. Não é erro do CLI — a
    // coleta degrada sem propagar (o hook não pode falhar um commit por isso).
    await collectFn(rt);
    return 0;
  } catch (err) {
    // `collectCode` não deveria lançar; cinto de segurança (nunca propaga).
    logFatal("collect cli", err);
    return 1;
  }
}

/** Entrada do processo: parse + execução, devolvendo o exit code. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    log(`collect cli: ${parsed.error}`);
    return 2;
  }
  return runCli(parsed);
}

// Executa só quando invocado como script (não quando importado por teste).
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      logFatal("collect cli", err);
      process.exitCode = 1;
    });
}

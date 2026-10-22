/**
 * `cli.ts` — CLI standalone do coletor (E3a-S6a, §2) + ingestão manual por sessão.
 *
 * Invocável por `node <plugin>/src/cli.ts` (Node ≥22, type-stripping). O CLI é o
 * **único escritor** do grafo (§1b): assume full **e** incremental. Duas origens
 * o invocam — o boot do plugin e os hooks git (post-commit/checkout/merge/rewrite):
 *
 *   node src/cli.ts --workspace <repo-root> --mode auto [--source post-commit]
 *
 * Além da coleta, o CLI ingere sessões do Kilo sob demanda (dreno completo,
 * como o `session.idle`) — uma ou mais, ou todas as do workspace:
 *
 *   node src/cli.ts --workspace <repo-root> --ingest <session_id> [--ingest <id2> ...]
 *   node src/cli.ts --workspace <repo-root> --ingest --all
 *
 * A ingestão manual é **confinada ao workspace**: a sessão só é ingerida quando
 * algum dos seus vínculos no `kilo.db` (`project.worktree`,
 * `session.directory`, worktrees secundárias) está **dentro** de `--workspace`
 * (`sessionBelongsToWorkspace`, fail-closed — sessão inexistente/banco ilegível
 * ⇒ recusa, exit 2). Sem isso, passar um `session_id` qualquer ingeriria memórias
 * de OUTRO workspace no grafo/memória deste (vazamento cruzado).
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
import {
  createBackendProvider,
  listWorkspaceSessions,
  resolveRuntimeDbPath,
  sessionBelongsToWorkspace,
  type DbPathSource,
  type SqliteBackend,
} from "./ingest/db.ts";
import {
  runIngest,
  type IngestOutcome,
  type IngestRuntime,
} from "./ingest/routine.ts";
import { INGEST_STATE_REL_PATH } from "./ingest/state.ts";
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
  /**
   * Sessões do Kilo a ingerir (dreno completo). `--ingest <id>` é repetível
   * (acumula); `--ingest --all` ingere TODAS as do workspace (da mais antiga
   * para a mais nova), ignorando ids avulsos. Quando presente, o CLI ingere
   * SÓ sessões e pula a coleta de código — nunca os dois no mesmo run.
   */
  ingest?: { ids: string[]; all: boolean };
}

/**
 * Faz o parse de `--workspace <dir>`, `--mode <auto|full|incremental>`,
 * `--source <name>`, `--ingest <session_id>` (repetível) e `--all` (só vale
 * com `--ingest`). Devolve `{ error }` em falta/valor inválido — o `main`
 * converte em exit code (nunca lança).
 */
export function parseArgs(argv: string[]): CliArgs | { error: string } {
  let workspace = "";
  let mode: CliMode = "auto";
  let source: string | undefined;
  const ingestIds: string[] = [];
  let ingestAll = false;
  // `--all` rastreia se houve `--ingest` em qualquer posição: `--all` sozinho
  // (sem `--ingest`) é erro de uso.
  let sawIngest = false;
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
    } else if (a === "--ingest") {
      sawIngest = true;
      // `--ingest --all`: o `--all` ocupa a posição do valor (é flag, não id).
      // `--ingest <id>` (repetível): acumula.
      const next = argv[i + 1];
      if (next === "--all") {
        ingestAll = true;
        i += 1;
      } else {
        const v = valueOf("--ingest", i);
        if (typeof v !== "string") return v;
        if (!v.trim()) return { error: "--ingest exige um session_id" };
        ingestIds.push(v);
        i += 1;
      }
    } else if (a === "--all") {
      ingestAll = true;
    }
    // Flags desconhecidas são ignoradas (o script do hook pode repassar "$@").
  }
  if (!workspace) return { error: "--workspace é obrigatório" };
  if (ingestAll && !sawIngest) {
    return { error: "--all exige --ingest (--ingest --all)" };
  }
  const base = { workspace, mode, ...(source ? { source } : {}) };
  const ingest =
    ingestIds.length > 0 || ingestAll
      ? { ids: ingestIds, all: ingestAll }
      : undefined;
  return ingest ? { ...base, ingest } : base;
}

/** Dependências injetáveis (default: produção). */
export interface CliDeps {
  loadConfig?: typeof loadConfig;
  loadConfigState?: typeof loadConfigState;
  collectCode?: typeof collectCode;
  git?: GitPort;
  exists?: (p: string) => boolean;
  writeReady?: (p: string, data: string) => void;
  /**
   * Backend SQLite da ingestão (teste). Quando ausente, abre o `kilo.db` real
   * (regra do runtime, `resolveRuntimeDbPath`).
   */
  ingestBackend?: SqliteBackend;
  /** Caminho do `kilo.db` (default: regra do runtime). */
  dbPath?: DbPathSource;
  /** Rotina de ingestão (default `runIngest`); stubada em teste. */
  runIngestFn?: typeof runIngest;
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
      ingest_timeout_ms: config.ingest.timeout_ms,
    });

    // Ingestão manual de sessões: dreno completo (como o `session.idle`),
    // confinada ao workspace (fail-closed — ver o header do módulo).
    if (args.ingest) {
      return runIngestSessions(dir, args.ingest, { config, client, deps });
    }

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

/**
 * Ingere sessões do Kilo (dreno completo, como o `session.idle`) a partir dos
 * `session_id`s — ou TODAS as do workspace (`--ingest --all`, da mais antiga
 * para a mais nova). **Confinada ao workspace**: cada sessão só é ingerida
 * quando algum vínculo dela no `kilo.db` está dentro de `dir`; as recusadas
 * (outro workspace/inexistente) são **puladas com log** (não abortam o lote).
 * Exit codes: `0` = concluído (mesmo que todas recusadas/sem pendências),
 * `1` = banco indisponível, `2` = uso inválido (`--all` sem lista — pego no
 * parse — ou nenhuma sessão elegível).
 */
async function runIngestSessions(
  dir: string,
  ingest: { ids: string[]; all: boolean },
  opts: {
    config: ReturnType<typeof loadConfig>;
    client: MemtierClient;
    deps: CliDeps;
  },
): Promise<number> {
  const { config, client, deps } = opts;
  const dbPath: DbPathSource = deps.dbPath ?? resolveRuntimeDbPath();
  // Backend injetado (teste) tem precedência; senão abre o `kilo.db` real pela
  // regra do runtime (lazy via provedor — falha de abertura não é cacheada).
  const provider = deps.ingestBackend
    ? { get: async () => deps.ingestBackend!, close: () => {} }
    : createBackendProvider(dbPath, {
        onError: (err) => logFatal("ingest cli open db", err),
      });
  let backend: SqliteBackend;
  try {
    backend = await provider.get();
  } catch {
    // Já logado pelo `onError`; o próximo run tenta de novo.
    return 1;
  }
  try {
    // Alvos: `--all` ⇒ TODAS as do workspace (ordenadas); senão os ids
    // avulsos (na ordem dada, duplicatas removidas).
    const targetIds = ingest.all
      ? listWorkspaceSessions(backend, dir).map((s) => s.id)
      : [...new Set(ingest.ids)];
    if (targetIds.length === 0) {
      const msg = ingest.all
        ? `ingest cli: nenhuma sessão do workspace ${dir} para ingerir`
        : "ingest cli: nenhum session_id informado";
      log(msg);
      reportError(msg);
      return 2;
    }

    const runFn = deps.runIngestFn ?? runIngest;
    const rt: IngestRuntime = {
      cfg: {
        enabled: true,
        batch_size: config.ingest.batch_size,
        max_hashes: config.ingest.max_hashes,
      },
      statePath: join(dir, INGEST_STATE_REL_PATH),
      client,
      lock: new Set<string>(),
    };
    let drained = 0;
    let refused = 0;
    let totalSent = 0;
    let totalRows = 0;
    let lastJob: string | undefined;
    // `drainAll = true`: o resto (< `batch_size`) também sai — igual ao
    // `session.idle`. A rotina nunca lança (falha vira log) e devolve as
    // passadas (para o resumo no console).
    for (const sessionId of targetIds) {
      // Guarda de workspace (fail-closed): sessão de OUTRO workspace — ou
      // inexistente — NUNCA entra no grafo/memória deste. No modo lote a
      // recusa pula a sessão (não aborta as demais).
      if (!sessionBelongsToWorkspace(backend, sessionId, dir)) {
        const msg =
          `ingest cli: sessão ${sessionId} não pertence ao workspace ${dir}; pulada`;
        log(msg);
        reportError(msg);
        refused += 1;
        continue;
      }
      const outcomes: IngestOutcome[] = await runFn(rt, backend, sessionId, true);
      drained += 1;
      totalSent += outcomes.filter((o) => o.sent).length;
      totalRows += outcomes.reduce((acc, o) => acc + (o.rows ?? 0), 0);
      const job = outcomes.map((o) => o.jobId).filter((j): j is string => !!j).at(-1);
      if (job) lastJob = job;
      const line =
        `ingest cli: sessão ${sessionId} drenada ` +
        `(lotes_enviados=${outcomes.filter((o) => o.sent).length} ` +
        `rows=${outcomes.reduce((acc, o) => acc + (o.rows ?? 0), 0)}` +
        (job ? ` job_id=${job}` : "") +
        `)`;
      log(line);
      reportLine(stripGraphPrefix(line));
    }
    const summary =
      `ingest cli: concluído (sessões=${drained} recusadas=${refused} ` +
      `lotes_enviados=${totalSent} rows=${totalRows}` +
      (lastJob ? ` job_id=${lastJob}` : "") +
      `)`;
    log(summary);
    reportLine(stripGraphPrefix(summary));
    return 0;
  } finally {
    provider.close();
  }
}

/**
 * Imprime uma linha no stdout (o caminho visível ao operador). Falha de
 * escrita nunca derruba o CLI.
 */
function reportLine(line: string): void {
  try {
    process.stdout.write(`${line}\n`);
  } catch {
    // stdout indisponível (pipe fechado): o arquivo já tem a linha.
  }
}

/** Erro de uso/escopo: arquivo + stderr (stdout fica para o resumo de sucesso). */
function reportError(line: string): void {
  try {
    process.stderr.write(`[graph] ${stripGraphPrefix(line)}\n`);
  } catch {
    // stderr indisponível: o arquivo já tem a linha.
  }
}

/** Tira o prefixo de log (`[graph] `) quando a linha já vai para o console. */
function stripGraphPrefix(line: string): string {
  return line.replace(/^\[graph\] /, "");
}

/** Entrada do processo: parse + execução, devolvendo o exit code. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    // Erro de uso tem de ser VISÍVEL no console: `log()` vai só para o
    // arquivo (`/tmp/kilocode-graph-plugin.log`) — sem o `console.error` o
    // usuário vê exit 2 sem nenhuma mensagem (defeito reportado).
    const msg = `collect cli: ${parsed.error}`;
    log(msg);
    reportError(msg);
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

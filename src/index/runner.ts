/**
 * Spawn do `rust-ast-indexer` e leitura do JSONL (E3a-S1 tracer).
 *
 * O indexer é **PULL** (não tem watch mode): o plugin spawna o binário por job,
 * escreve 1 comando no stdin, lê o stdout linha a linha (cada linha é um JSON
 * independente) e resolve ao ver `job_completed`. Um processo por job — sem
 * estado de daemon.
 *
 * Protocolo (doc/protocol.md): `{protocol_version, type:"command", command,
 * seq, job_id, payload}`. Linha não-JSON é ignorada (mesma tolerância do probe).
 *
 * Backpressure (S4, protocolo two-way — `protocol.md:159` e §"Armadilhas"): se a
 * fila do indexer encher, ele pausa e espera resposta. Um runner que só lê trava
 * para sempre. Trata:
 *   - evento `pause` ⇒ responde `ack {count}` com o nº de eventos REALMENTE
 *     drenados desde o último ack (antes era `count:500` fixo — a fila caía a
 *     zero sempre e o produtor nunca desacelerava);
 *   - `error` com `code=BACKPRESSURE` ⇒ idem (`ack` com a contagem real);
 *   - evento `resume` ⇒ **nenhum comando**. `resume` do indexer é notificação
 *     (o monitor já saiu da pausa); responder `resume` chamava `force_resume()`
 *     no indexer, que faz `reset_queue()` — zerava a contabilidade e mascarava
 *     a carga real.
 *
 * Erro de job NÃO-recuperável (ex.: `GIT_UNAVAILABLE`, `INVALID_PAYLOAD`) ⇒ o
 * job é encerrado já, carregando o erro: o stream não representa um estado
 * completo e o coletor não pode tratá-lo como "full vazio" (apagaria o grafo).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

import { debug, log } from "../logger.ts";
import type { ChunkingOptions, IndexerEvent } from "../types.ts";
import { CpuGuard, type CpuGuardConfig, type CpuGuardSnapshot } from "./cpu-guard.ts";

/**
 * Config de backpressure enviada ao indexer em `options.backpressure`. Sem ela o
 * indexer NUNCA ativa o monitor (`indexer.rs`: `match &opts.backpressure`), não
 * emite `pause` e emite todos os chunks sem freio.
 */
export interface BackpressureOptions {
  /** Tamanho da fila que dispara `pause` (mínimo 10 no indexer). Default 500. */
  max_queue_size?: number;
  /**
   * Teto da fila em BYTES. A fila pausa no PRIMEIRO teto (eventos OU bytes):
   * o teto por eventos não protege contra chunk gigante (poucos eventos, muitos
   * MB). `0`/ausente no indexer = desligado.
   */
  max_queue_bytes?: number;
  /** Percentual do teto abaixo do qual o indexer retoma (80–99). Default 90. */
  threshold_percent?: number;
  /** `resume` exige ack do consumidor. Default `false`. */
  ack_required?: boolean;
  /** Segundos até o indexer retomar sozinho (anti-travamento). Default 60. */
  pause_timeout_secs?: number;
}

/** Backpressure padrão do plugin: freia o indexer bem antes do pipe encher. */
export const DEFAULT_BACKPRESSURE: Required<BackpressureOptions> = {
  max_queue_size: 500,
  max_queue_bytes: 0,
  threshold_percent: 90,
  ack_required: false,
  pause_timeout_secs: 60,
};

/** Modo de indexação: full (`index_path`) ou incremental (`incremental_index`). */
export type IndexMode = "full" | "incremental";

/** Opções de um job de indexação. */
export interface RunIndexerOptions {
  /** Caminho do binário (`code_index.indexer_bin`). Vazio ⇒ desligado. */
  bin: string;
  /** Raiz do repo a indexar. */
  repoRoot: string;
  /** Modo (full na S1; incremental na S4). */
  mode: IndexMode;
  /** Extrai imports/calls (arestas). Default `true`. */
  extractImports?: boolean;
  extractCalls?: boolean;
  /**
   * Opções de chunking do `rust-ast-indexer` (`options.chunking`), repassadas
   * CRUAS ao payload. Chave ausente ⇒ o indexer usa o default dele (`Semantic`,
   * 200 linhas). A forma do objeto é o contrato do indexer
   * (`doc/indexer_spec.md`): `{strategy, max_lines, overlap_lines,
   * include_context, token_counting}`, com `strategy ∈ {symbol_boundary,
   * semantic, line_limited}`.
   *
   * Version skew: `symbol_boundary` (snake_case) exige um binário ATUALIZADO
   * (com `rename_all="snake_case"` no enum). Com um binário antigo, o serde
   * falha e o indexer cai em `Semantic` em silêncio — mantenha `indexer_bin`
   * alinhado ao plugin.
   */
  chunking?: ChunkingOptions;
  /**
   * Fonte de arquivos via git (`git ls-files --exclude-standard`), honrando o
   * ignore-stack completo. Default `false` (varre tudo). Quando `true` e o git
   * estiver ausente ou o diretório não for um repositório, o indexer responde
   * `GIT_UNAVAILABLE` e aborta o job (sem degradar para um scan completo).
   */
  loadIgnores?: boolean;
  /** Range do incremental (S4). */
  gitRange?: { from: string; to: string };
  /** Timeout do job (ms); estouro ⇒ encerra e devolve o que veio. */
  jobTimeoutMs?: number;
  /**
   * Backpressure enviado em `options.backpressure`. `false` ⇒ não envia (o
   * indexer emite sem freio). Default: `DEFAULT_BACKPRESSURE`.
   */
  backpressure?: BackpressureOptions | false;
  /**
   * Guarda de CPU (prioridade `nice` + pausa em 85% do sistema). `false` ⇒
   * desliga. Default: `DEFAULT_CPU_GUARD`.
   */
  cpuGuard?: Partial<CpuGuardConfig> | false;
  /**
   * Concorrência do indexer (`options.max_concurrency`). Enviado SEMPRE (o
   * default do indexer é `num_cpus`, que satura a máquina). `undefined` ⇒ o
   * chamador já resolveu via orçamento do boot.
   */
  maxConcurrency?: number;
  /**
   * Limites de conteúdo (`options.limits`). Enviado quando presente; o indexer
   * pula arquivos gigantes com `file_skipped` em vez de parsear.
   */
  limits?: import("../types.ts").IndexLimits;
  /**
   * Consumidor de streaming: recebe cada evento no instante em que é lido.
   * Presente ⇒ o runner NÃO acumula `events` em RAM (o consumidor decide onde
   * guardar — no coletor, spool em disco). Ausente ⇒ comportamento legado
   * (array em memória; testes/e2e que montam o body no fim).
   */
  onEvent?: (event: IndexerEvent) => void;
}

/** Resultado de um job: eventos coletados + motivo de saída opcional. */
export interface RunIndexerResult {
  /** Eventos lidos. Vazio quando `onEvent` foi usado (nada retido em RAM). */
  events: IndexerEvent[];
  /** Nº de eventos lidos (sempre preenchido; útil no modo streaming). */
  eventCount?: number;
  /** Estado final da guarda de CPU (quando habilitada). */
  cpu?: CpuGuardSnapshot;
  /** `true` quando o binário/caminho não existe (não é erro fatal — FR-306). */
  skipped: boolean;
  /** Detalhe da degradação (binário ausente, exit != 0, timeout). */
  reason?: string;
  /**
   * Erro **não-recuperável** do job (evento `error` com `recoverable:false`,
   * ex.: `GIT_UNAVAILABLE` quando `load_ignores` exige git). Presente ⇒ o
   * stream NÃO é um estado completo: o coletor não pode tratá-lo como "todos
   * os demais arquivos foram removidos".
   */
  error?: IndexerJobError;
}

/** Erro de job do indexer (evento `error`), tipado para o coletor decidir. */
export interface IndexerJobError {
  /** Código do protocolo (`GIT_UNAVAILABLE`, `WALKER_ERROR`, …). */
  code: string;
  message: string;
  /** `true` quando o job pode continuar (ex.: `BACKPRESSURE`); default `false`. */
  recoverable: boolean;
}

/**
 * Extrai o erro de um evento `error` como `IndexerJobError` (ou `null` se o
 * payload for malformado). `recoverable` só é `true` quando **explícito** — na
 * dúvida, trata como fatal (nunca destruir o grafo por um erro ambíguo).
 */
export function jobErrorFromEvent(event: IndexerEvent): IndexerJobError | null {
  if (event.event !== "error") return null;
  const payload = event.payload as
    | { code?: unknown; message?: unknown; recoverable?: unknown }
    | null;
  // Array também é `typeof "object"`; não é um payload de erro válido (payload
  // array viraria um falso fatal `UNKNOWN`). Exige um objeto simples.
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const code = typeof payload.code === "string" ? payload.code : "UNKNOWN";
  const message = typeof payload.message === "string" ? payload.message : code;
  return { code, message, recoverable: payload.recoverable === true };
}

const DEFAULT_JOB_TIMEOUT_MS = 300_000;

/** Monta o comando JSONL do job (payload do probe/spec §2) + o `job_id`. */
export function buildCommand(
  mode: IndexMode,
  repoRoot: string,
  opts: RunIndexerOptions = {} as RunIndexerOptions,
): { line: string; jobId: string } {
  const command = mode === "incremental" ? "incremental_index" : "index_path";
  const payload: Record<string, unknown> = { path: repoRoot };
  if (mode === "incremental") {
    payload.use_git = true;
    if (opts.gitRange) {
      payload.git_range = { from: opts.gitRange.from, to: opts.gitRange.to };
    }
  }
  payload.options = {
    extract_imports: opts.extractImports ?? true,
    extract_calls: opts.extractCalls ?? true,
    load_ignores: opts.loadIgnores ?? false,
  };
  // Concorrência é teto de CPU/RAM: enviada SEMPRE (o default do indexer é
  // `num_cpus`, que satura a máquina). O coletor resolve via orçamento do boot.
  if (opts.maxConcurrency !== undefined) {
    (payload.options as Record<string, unknown>).max_concurrency = opts.maxConcurrency;
  }
  // Limites de conteúdo: o indexer pula gigantes com `file_skipped`.
  if (opts.limits) {
    (payload.options as Record<string, unknown>).limits = opts.limits;
  }
  // Chunking é repassado CRU (contrato do indexer); ausente ⇒ a chave não vai,
  // e o indexer aplica o default dele (não impomos valores que ele desconheça).
  if (opts.chunking) {
    (payload.options as Record<string, unknown>).chunking = opts.chunking;
  }
  // Backpressure: sem ela o indexer não instancia o monitor e nunca emite
  // `pause` — o plugin ficaria lendo um stream sem freio.
  if (opts.backpressure !== false) {
    const bp = { ...DEFAULT_BACKPRESSURE, ...(opts.backpressure ?? {}) };
    (payload.options as Record<string, unknown>).backpressure = bp;
  }
  const jobId = `graph-${mode}-${Date.now()}`;
  const line = JSON.stringify({
    protocol_version: "1.0.0",
    type: "command",
    command,
    seq: 1,
    job_id: jobId,
    payload,
  });
  return { line, jobId };
}

/** Parse defensivo de uma linha JSONL: inválida ⇒ `null` (ignorada). */
export function parseLine(line: string): IndexerEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as IndexerEvent;
    }
    return null;
  } catch {
    return null;
  }
}

/** Tipo do comando de controle respondido ao backpressure. */
export type ControlCommand = "ack" | "resume";

/**
 * Decide o comando de controle a enviar para um evento (ou `null`):
 *   - `pause` ⇒ `ack` (o indexer está bloqueado esperando drenagem);
 *   - `error` com `code=BACKPRESSURE` ⇒ `ack` (forma defensiva do protocolo);
 *   - `resume` ⇒ `null` — é notificação, não pedido. Responder `resume` chamava
 *     `force_resume()`/`reset_queue()` no indexer e zerava a fila real.
 */
export function controlForEvent(event: IndexerEvent): ControlCommand | null {
  if (event.event === "pause") return "ack";
  if (event.event === "error") {
    const payload = event.payload as { code?: unknown } | null;
    if (payload && payload.code === "BACKPRESSURE") return "ack";
  }
  return null;
}

/**
 * Linha JSON do comando de controle. `ack` carrega o nº de eventos drenados
 * desde o último ack (`count`), nunca um valor fixo: decrementar 500 de uma fila
 * de 500 é o mesmo que ignorar o consumo real e nunca desacelerar o produtor.
 */
export function controlLine(
  command: ControlCommand,
  jobId: string,
  count = 1,
): string {
  return JSON.stringify({
    protocol_version: "1.0.0",
    type: "command",
    command,
    job_id: jobId,
    ...(command === "ack" ? { payload: { count } } : {}),
  });
}

/**
 * Spawna o indexer e devolve os eventos até `job_completed`. Degrada sem lançar:
 * `bin` vazio/caminho inexistente ⇒ `{events:[], skipped:true}` (FR-306). Falha
 * do processo ⇒ `skipped:false` + `reason` (o coletor loga e segue).
 */
export async function runIndexer(
  opts: RunIndexerOptions,
): Promise<RunIndexerResult> {
  const bin = opts.bin?.trim() ?? "";
  if (!bin) {
    debug("collect: indexer_bin vazio; coleta desligada");
    return { events: [], skipped: true, reason: "indexer_bin vazio" };
  }

  const events: IndexerEvent[] = [];
  const streaming = typeof opts.onEvent === "function";
  let eventCount = 0;
  const { line, jobId } = buildCommand(opts.mode, opts.repoRoot, opts);
  const timeoutMs = opts.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;

  return new Promise<RunIndexerResult>((resolve) => {
    let child: ChildProcess;
    // `nice` rebaixa a prioridade SEM limitar núcleos: o indexer continua com
    // toda a máquina, mas cede quando outra coisa precisa de CPU. Só é usado
    // quando o utilitário existe — um `nice` ausente não pode desligar a coleta.
    const nice = opts.cpuGuard === false ? 0 : (opts.cpuGuard?.nice ?? 10);
    const usingNice =
      process.platform !== "win32" &&
      nice > 0 &&
      (existsSync("/usr/bin/nice") || existsSync("/bin/nice"));
    try {
      child = usingNice
        ? spawn("nice", [`-n`, String(nice), bin], {
            stdio: ["pipe", "pipe", "pipe"],
          })
        : spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      // Binário inexistente/ não-executável: não é erro fatal (FR-306).
      const reason = err instanceof Error ? err.message : String(err);
      log(`collect: indexer não spawnou (${reason}); seguindo sem coleta`);
      resolve({ events: [], skipped: true, reason });
      return;
    }

    const guard =
      opts.cpuGuard === false || !child.pid
        ? null
        : new CpuGuard(child.pid, opts.cpuGuard ?? {});
    guard?.start();

    let settled = false;
    /** Erro não-recuperável do job (o último visto) — decide a degradação. */
    let jobError: IndexerJobError | null = null;
    /** Eventos desde o último `ack` — o que o consumidor REALMENTE drenou. */
    let unacked = 0;
    const finish = (result: RunIndexerResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      guard?.stop();
      rl.close();
      try {
        // SIGCONT antes do SIGKILL: um processo em SIGSTOP ignoraria o SIGKILL.
        if (guard?.status().paused) child.kill("SIGCONT");
        child.kill("SIGKILL");
      } catch {
        // Processo já morto.
      }
      resolve({
        ...result,
        events: streaming ? [] : result.events,
        eventCount,
        ...(guard ? { cpu: guard.status() } : {}),
      });
    };
    /** Resolve o job já, carregando o erro corrente (se houver). */
    const finishWithError = (reason?: string): void => {
      finish({
        events,
        skipped: false,
        ...(reason ? { reason } : {}),
        ...(jobError ? { error: jobError } : {}),
      });
    };

    const timer = setTimeout(() => {
      // Timeout também propaga o erro corrente: um erro fatal sem `job_completed`
      // (ex.: `INVALID_PAYLOAD`, que faz early-return e deixa o processo vivo)
      // chega aqui — omiti-lo reintroduziria o wipe do grafo no modo full.
      finishWithError(`timeout do job (${timeoutMs}ms)`);
    }, timeoutMs);

    child.on("error", (err) => {
      log(`collect: indexer falhou (${err.message}); seguindo sem coleta`);
      finish({ events, skipped: true, reason: err.message });
    });

    child.on("close", (code) => {
      // 127/126 vindos do `nice`: o binário não existe/não é executável. É a
      // degradação FR-306 (não um erro do job) — sem isto o `nice` mascararia o
      // ENOENT do spawn direto.
      if (usingNice && (code === 127 || code === 126)) {
        finish({
          events,
          skipped: true,
          reason: `indexer não executável (exit=${code})`,
        });
        return;
      }
      if (code && code !== 0) {
        finishWithError(`indexer exit=${code}`);
        return;
      }
      // Sem `job_completed` mas saiu limpo: devolve o que veio, com o erro
      // corrente (se houve) para o coletor não tratar o stream como completo.
      finishWithError();
    });

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (raw) => {
      const ev = parseLine(raw);
      if (!ev) return;
      eventCount += 1;
      // Só eventos que ENTRAM na fila do indexer contam para o ack
      // (`chunk_emitted`/`import_edge`/`call_edge`); `pause`/`resume`/`job_*`
      // não incrementam `queue_size` no monitor.
      const isData =
        ev.event === "chunk_emitted" ||
        ev.event === "import_edge" ||
        ev.event === "call_edge";
      if (isData) unacked += 1;
      if (streaming) {
        try {
          opts.onEvent!(ev);
        } catch (err) {
          // Falha do consumidor não pode derrubar o job: loga e segue.
          log(
            `collect: consumidor de eventos falhou (${err instanceof Error ? err.message : err})`,
          );
        }
      } else {
        events.push(ev);
      }
      // Backpressure (two-way): responde `ack` no stdin do processo. O `count`
      // é o que foi drenado desde o último ack — nunca um valor fixo.
      const control = controlForEvent(ev);
      if (control) {
        // `ack` sempre drena ao menos 1: um `count:0` deixaria o indexer pausado
        // até o `pause_timeout` mesmo com o consumidor ativo.
        const count = Math.max(1, unacked);
        debug(`collect: indexer ${ev.event} → enviando ${control} (${count})`);
        try {
          child.stdin!.write(`${controlLine(control, jobId, count)}\n`);
          unacked = 0;
        } catch {
          // stdin fechado (processo saindo): o `close` resolve o job.
        }
      }
      // Erro NÃO-recuperável: guarda e ENCERRA já (não espera `job_completed` —
      // nem todo erro o emite; `INVALID_PAYLOAD`/`INVALID_COMMAND`/`JOB_NOT_FOUND`
      // fazem early-return e o processo ficaria vivo até o timeout).
      const jobErr = jobErrorFromEvent(ev);
      if (jobErr && !jobErr.recoverable) {
        jobError = jobErr;
        finishWithError();
        return;
      }
      if (ev.event === "job_completed") finishWithError();
    });

    // stderr é diagnóstico; nunca derruba o job.
    child.stderr?.on("data", (buf: Buffer) => {
      debug(`collect: indexer stderr: ${buf.toString().trim().slice(0, 200)}`);
    });

    // `child.stdin.write` pode falhar DEPOIS do retorno (EPIPE assíncrono) se o
    // processo já saiu (ex.: erro fatal que encerra o job antes de ler o
    // comando). O `try/catch` síncrono não cobre isso; sem este handler o
    // stream emite `error` e vira `uncaughtException`. Aqui é seguro ignorar: o
    // `close`/timeout resolve o job.
    child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      debug(`collect: indexer stdin (${err.code ?? err.message}); ignorado`);
    });

    try {
      child.stdin!.write(`${line}\n`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      finish({ events, skipped: true, reason });
    }
  });
}

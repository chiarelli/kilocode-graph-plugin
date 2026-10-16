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
 *   - evento `pause` ⇒ responde `ack {count}` (drena a fila; resume automático);
 *   - evento `resume` ⇒ responde `resume` (idempotente, mantém o job fluindo);
 *   - `error` com `code=BACKPRESSURE` ⇒ responde `ack` (**defensivo**: a versão
 *     atual do indexer sinaliza backpressure por `pause`, não por esse código).
 *
 * Erro de job NÃO-recuperável (ex.: `GIT_UNAVAILABLE`, `INVALID_PAYLOAD`) ⇒ o
 * job é encerrado já, carregando o erro: o stream não representa um estado
 * completo e o coletor não pode tratá-lo como "full vazio" (apagaria o grafo).
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { debug, log } from "../logger.ts";
import type { IndexerEvent } from "../types.ts";

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
}

/** Resultado de um job: eventos coletados + motivo de saída opcional. */
export interface RunIndexerResult {
  events: IndexerEvent[];
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
 * Decide o comando de controle a enviar para um evento (ou `null`). Cobre as
 * duas formas do protocolo:
 *   - `pause` ⇒ `ack` com `count` (drena a fila; o resume automático só dispara
 *     quando a fila cai abaixo do threshold, e ela só cai com `ack`);
 *   - `error` com `code=BACKPRESSURE` ⇒ `ack` (a spec §E3a-S1 citava `resume`,
 *     mas o próprio protocolo manda drenar com `ack` — enviar ambos é seguro);
 *   - `resume` ⇒ `resume` (idempotente; mantém o job fluindo).
 */
export function controlForEvent(event: IndexerEvent): ControlCommand | null {
  if (event.event === "pause") return "ack";
  if (event.event === "resume") return "resume";
  if (event.event === "error") {
    const payload = event.payload as { code?: unknown } | null;
    if (payload && payload.code === "BACKPRESSURE") return "ack";
  }
  return null;
}

/** Linha JSON do comando de controle (`ack`/`resume`) com o `job_id` do job. */
export function controlLine(command: ControlCommand, jobId: string): string {
  return JSON.stringify({
    protocol_version: "1.0.0",
    type: "command",
    command,
    job_id: jobId,
    payload: { count: 500 },
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
  const { line, jobId } = buildCommand(opts.mode, opts.repoRoot, opts);
  const timeoutMs = opts.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;

  return new Promise<RunIndexerResult>((resolve) => {
    let child;
    try {
      child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      // Binário inexistente/ não-executável: não é erro fatal (FR-306).
      const reason = err instanceof Error ? err.message : String(err);
      log(`collect: indexer não spawnou (${reason}); seguindo sem coleta`);
      resolve({ events: [], skipped: true, reason });
      return;
    }

    let settled = false;
    /** Erro não-recuperável do job (o último visto) — decide a degradação. */
    let jobError: IndexerJobError | null = null;
    const finish = (result: RunIndexerResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      try {
        child.kill("SIGKILL");
      } catch {
        // Processo já morto.
      }
      resolve(result);
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
      if (code && code !== 0) {
        finishWithError(`indexer exit=${code}`);
        return;
      }
      // Sem `job_completed` mas saiu limpo: devolve o que veio, com o erro
      // corrente (se houve) para o coletor não tratar o stream como completo.
      finishWithError();
    });

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const ev = parseLine(line);
      if (!ev) return;
      events.push(ev);
      // Backpressure (two-way): responde `ack`/`resume` no stdin do processo.
      // Um runner que só lê deixa o job preso em `pause` para sempre.
      const control = controlForEvent(ev);
      if (control) {
        debug(`collect: indexer ${ev.event} → enviando ${control}`);
        try {
          child.stdin.write(`${controlLine(control, jobId)}\n`);
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
      child.stdin.write(`${line}\n`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      finish({ events, skipped: true, reason });
    }
  });
}

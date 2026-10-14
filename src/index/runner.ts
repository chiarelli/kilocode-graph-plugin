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
 * Minimal da fatia 1 (`TODO(tracer-bullet)`): backpressure (`pause`→`ack`/
 * `error.code=BACKPRESSURE`→`resume`) e timeout do job entram na S4.
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
  /** Modo (S4 usa "incremental"; a S1 só exercita "full"). */
  mode: IndexMode;
  /** Extrai imports/calls (arestas). Default `true`. */
  extractImports?: boolean;
  extractCalls?: boolean;
  /** Range do incremental (S4). Sem uso na fatia 1. */
  gitRange?: { from: string; to: string };
  /** Resolve ao ver `job_completed`; limita uma leitura patológica. */
  jobTimeoutMs?: number;
}

/** Resultado de um job: eventos coletados + motivo de saída opcional. */
export interface RunIndexerResult {
  events: IndexerEvent[];
  /** `true` quando o binário/caminho não existe (não é erro fatal — FR-306). */
  skipped: boolean;
  /** Detalhe da degradação (binário ausente, exit != 0, timeout). */
  reason?: string;
}

const DEFAULT_JOB_TIMEOUT_MS = 300_000;

/** Monta o comando JSONL do job (payload do probe/spec §2). */
export function buildCommand(
  mode: IndexMode,
  repoRoot: string,
  opts: RunIndexerOptions = {} as RunIndexerOptions,
): string {
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
  };
  return JSON.stringify({
    protocol_version: "1.0.0",
    type: "command",
    command,
    seq: 1,
    job_id: `graph-${mode}-${Date.now()}`,
    payload,
  });
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
  const command = buildCommand(opts.mode, opts.repoRoot, opts);
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

    const timer = setTimeout(() => {
      finish({ events, skipped: false, reason: `timeout do job (${timeoutMs}ms)` });
    }, timeoutMs);

    child.on("error", (err) => {
      log(`collect: indexer falhou (${err.message}); seguindo sem coleta`);
      finish({ events, skipped: true, reason: err.message });
    });

    child.on("close", (code) => {
      if (code && code !== 0) {
        finish({ events, skipped: false, reason: `indexer exit=${code}` });
        return;
      }
      // Sem `job_completed` mas saiu limpo: devolve o que veio.
      finish({ events, skipped: false });
    });

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const ev = parseLine(line);
      if (!ev) return;
      events.push(ev);
      if (ev.event === "job_completed") finish({ events, skipped: false });
    });

    // stderr é diagnóstico; nunca derruba o job.
    child.stderr?.on("data", (buf: Buffer) => {
      debug(`collect: indexer stderr: ${buf.toString().trim().slice(0, 200)}`);
    });

    try {
      child.stdin.write(`${command}\n`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      finish({ events, skipped: true, reason });
    }
  });
}

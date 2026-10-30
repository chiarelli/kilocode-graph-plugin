/**
 * `budget.ts` — orçamento prévio de memória da coleta de código.
 *
 * O pico de RAM da coleta tem de ser função de um ORÇAMENTO calculado no boot,
 * não do tamanho do repositório. A ordem de precedência é:
 * `config explícita` > `orçamento calculado` > `default estático`.
 *
 * Leitura (pura + injetável):
 *   - `MemAvailable` de `/proc/meminfo` (RAM real, não total);
 *   - limite do cgroup (`memory.max` v2 ou `memory.limit_in_bytes` v1) quando
 *     menor que a RAM (container com teto abaixo do host);
 *   - ausência de leitura ⇒ fallback 4 GiB / 4 CPUs (nunca zero).
 *
 * Divisão do usável (reserva = max(1 GiB, 20%)):
 *   - 25% fila do indexer (`max_queue_bytes`);
 *   - 10% buffers de escrita do spool;
 *   - 45% lote de sync;
 *   - 20% folga.
 *
 * Derivados (sempre com clamp para nunca degradar a zero):
 *   - `maxQueueSize = queue_bytes / avg_event_bytes`, clamp [10, 10000]
 *     (10 = mínimo do protocolo; 10000 = teto de sanidade);
 *   - `batchSize = sync_bytes / avg_spool_file_bytes`, clamp [10, 100]
 *     (100 = `MAX_FILES_PER_REQUEST` do servidor);
 *   - `maxConcurrency = ncpu - 1`, clamp [1, 8].
 *
 * Limites de conteúdo (estáticos, sobrescrevíveis por config):
 *   - `max_file_bytes = 1 MiB` (arquivo acima ⇒ `file_skipped`, sem parsear);
 *   - `max_chunk_bytes = 128 KiB` (chunk acima ⇒ truncado com `truncated`);
 *   - `max_chunks_per_file = 2000` (arquivo acima ⇒ `file_skipped chunks_capped`);
 *   - `max_full_files = 60000` (full acima ⇒ recusa sem retry cego).
 */

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const KB = 1024;

/** Fallback quando `/proc/meminfo` não pode ser lido. */
export const FALLBACK_MEM_BYTES = 4 * GB;
/** Fallback quando a contagem de CPUs não pode ser lida. */
export const FALLBACK_CPU_COUNT = 4;
/** Piso da reserva de segurança (o que sobra para o resto do sistema). */
export const RESERVE_FLOOR_BYTES = 1 * GB;
/** Fração da reserva sobre a memória efetiva. */
export const RESERVE_FRACTION = 0.2;

/** Frações do usável por componente. */
export const BUDGET_SPLIT = {
  indexerQueue: 0.25,
  spoolBuffer: 0.1,
  syncBatch: 0.45,
  headroom: 0.2,
} as const;

/** Tamanho médio estimado de um evento JSONL (para derivar a fila). */
export const DEFAULT_AVG_EVENT_BYTES = 4 * KB;
/** Tamanho médio estimado de um arquivo materializado do spool (para o lote). */
export const DEFAULT_AVG_SPOOL_FILE_BYTES = 256 * KB;

/** Limites de fila do indexer. */
export const QUEUE_SIZE_MIN = 10;
export const QUEUE_SIZE_MAX = 10000;
/** Limites do lote de sync (teto = limite do servidor por request). */
export const BATCH_SIZE_MIN = 10;
export const BATCH_SIZE_MAX = 100;
/** Limites da concorrência do indexer. */
export const CONCURRENCY_MIN = 1;
export const CONCURRENCY_MAX = 8;
/** Piso do usável: abaixo disso, ainda reserva fila mínima útil. */
export const USABLE_FLOOR_BYTES = 256 * MB;

/** Limites de conteúdo aplicados ao indexer. */
export interface IndexLimits {
  /** Arquivo acima deste tamanho ⇒ `file_skipped`, sem parsear. */
  max_file_bytes: number;
  /** Chunk acima deste tamanho ⇒ truncado com `truncated: true`. */
  max_chunk_bytes: number;
  /** Arquivo acima deste nº de chunks ⇒ `file_skipped` (`chunks_capped`). */
  max_chunks_per_file: number;
}

/** Limites estáticos (default quando a config não os sobrescreve). */
export const DEFAULT_LIMITS: IndexLimits = {
  max_file_bytes: 1 * MB,
  max_chunk_bytes: 128 * KB,
  max_chunks_per_file: 2000,
};

/** Teto de arquivos num full antes de recusar (recusa sem retry cego). */
export const DEFAULT_MAX_FULL_FILES = 60_000;

/** Leitores de memória injetáveis (default: `/proc` + cgroup + `os`). */
export interface MemoryReaders {
  /** `MemAvailable` em bytes; `null` quando ilegível. */
  memAvailableBytes: () => number | null;
  /** Limite do cgroup em bytes; `null` quando ausente/ilegível/ilimitado. */
  cgroupLimitBytes: () => number | null;
  /** Nº de CPUs; `0`/negativo ⇒ fallback. */
  cpuCount: () => number;
}

/** Orçamento calculado (antes dos overrides de config). */
export interface IndexBudget {
  memAvailableBytes: number;
  /** Limite do cgroup (quando governa); `null` quando a RAM governa. */
  limitBytes: number | null;
  reserveBytes: number;
  indexerQueueBytes: number;
  spoolBufferBytes: number;
  syncBatchBytes: number;
  headroomBytes: number;
  maxQueueSize: number;
  batchSize: number;
  maxConcurrency: number;
  limits: IndexLimits;
  maxFullFiles: number;
}

/** O que a config explícita pode sobrescrever (chaves de `code_index`). */
export interface BudgetConfigOverrides {
  max_concurrency?: number;
  sync_batch_size?: number;
  max_full_files?: number;
  limits?: Partial<IndexLimits>;
  /** `false` ⇒ backpressure desligado (fila calculada é ignorada no envio). */
  backpressure?: { max_queue_bytes?: number; max_queue_size?: number } | false;
}

/** Orçamento efetivo (calculado + overrides), pronto para o runner/sync. */
export interface EffectiveIndexBudget extends IndexBudget {
  maxQueueBytes: number;
  /** Chaves que vieram da config explícita (observabilidade). */
  overrides: string[];
}

/** Leitores reais (`/proc/meminfo`, cgroup v1/v2, `node:os`). */
export const procMemoryReaders: MemoryReaders = {
  memAvailableBytes: () => readMemAvailable(),
  cgroupLimitBytes: () => readCgroupLimit(),
  cpuCount: () => readCpuCount(),
};

function readMemAvailable(): number | null {
  try {
    // Import lazy: `node:fs`/`node:os` só no caminho de produção (teste injeta).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const text = readFileSync("/proc/meminfo", "utf-8") as string;
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text);
    if (!m) return null;
    const kb = Number(m[1]);
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
  } catch {
    return null;
  }
}

function readCgroupLimit(): number | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const paths = [
      "/sys/fs/cgroup/memory.max", // v2 (`max` = sem limite)
      "/sys/fs/cgroup/memory/memory.limit_in_bytes", // v1
    ];
    for (const p of paths) {
      let raw = "";
      try {
        raw = (readFileSync(p, "utf-8") as string).trim();
      } catch {
        continue;
      }
      if (raw === "" || raw === "max") continue;
      const n = Number(raw);
      // v1 usa um inteiro gigante (2^63) como "sem limite" — ignora.
      if (Number.isFinite(n) && n > 0 && n < Number.MAX_SAFE_INTEGER / 2) return n;
    }
    return null;
  } catch {
    return null;
  }
}

function readCpuCount(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { cpus } = require("node:os") as typeof import("node:os");
    const n = (cpus() as unknown[]).length;
    return Number.isInteger(n) && n > 0 ? n : FALLBACK_CPU_COUNT;
  } catch {
    return FALLBACK_CPU_COUNT;
  }
}

/** Clamp inteiro em `[min, max]`. */
function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Calcula o orçamento a partir dos leitores. Puro e total: nunca lança, nunca
 * devolve zero — máquina minúscula ainda reserva fila/lote mínimos úteis.
 */
export function computeBudget(readers: MemoryReaders): IndexBudget {
  const mem = readers.memAvailableBytes();
  const memAvailableBytes =
    mem !== null && Number.isFinite(mem) && mem > 0 ? Math.trunc(mem) : FALLBACK_MEM_BYTES;
  const limit = readers.cgroupLimitBytes();
  const effective =
    limit !== null && Number.isFinite(limit) && limit > 0
      ? Math.min(memAvailableBytes, Math.trunc(limit))
      : memAvailableBytes;
  const reserveBytes = Math.max(
    RESERVE_FLOOR_BYTES,
    Math.floor(effective * RESERVE_FRACTION),
  );
  let usable = effective - reserveBytes;
  // Máquina minúscula: reserva nunca zera o usável (fila mínima útil).
  if (usable < USABLE_FLOOR_BYTES) usable = Math.min(effective, USABLE_FLOOR_BYTES);

  const indexerQueueBytes = Math.floor(usable * BUDGET_SPLIT.indexerQueue);
  const spoolBufferBytes = Math.floor(usable * BUDGET_SPLIT.spoolBuffer);
  const syncBatchBytes = Math.floor(usable * BUDGET_SPLIT.syncBatch);
  const headroomBytes = Math.max(
    0,
    usable - indexerQueueBytes - spoolBufferBytes - syncBatchBytes,
  );

  const cpus = readers.cpuCount();
  const cpuCount =
    Number.isInteger(cpus) && cpus > 0 ? cpus : FALLBACK_CPU_COUNT;

  return {
    memAvailableBytes,
    limitBytes:
      limit !== null && Number.isFinite(limit) && limit > 0 && limit < memAvailableBytes
        ? Math.trunc(limit)
        : null,
    reserveBytes,
    indexerQueueBytes,
    spoolBufferBytes,
    syncBatchBytes,
    headroomBytes,
    maxQueueSize: clampInt(
      Math.floor(indexerQueueBytes / DEFAULT_AVG_EVENT_BYTES),
      QUEUE_SIZE_MIN,
      QUEUE_SIZE_MAX,
    ),
    batchSize: clampInt(
      Math.floor(syncBatchBytes / DEFAULT_AVG_SPOOL_FILE_BYTES),
      BATCH_SIZE_MIN,
      BATCH_SIZE_MAX,
    ),
    maxConcurrency: clampInt(cpuCount - 1, CONCURRENCY_MIN, CONCURRENCY_MAX),
    limits: { ...DEFAULT_LIMITS },
    maxFullFiles: DEFAULT_MAX_FULL_FILES,
  };
}

/**
 * Aplica os overrides de config sobre o calculado. Só valores válidos vencem
 * (inteiro positivo); inválido ⇒ mantém o calculado (nunca zero/silencioso).
 */
export function applyOverrides(
  budget: IndexBudget,
  cfg: BudgetConfigOverrides,
): EffectiveIndexBudget {
  const overrides: string[] = [];
  let maxConcurrency = budget.maxConcurrency;
  let batchSize = budget.batchSize;
  let maxFullFiles = budget.maxFullFiles;
  const limits: IndexLimits = { ...budget.limits };
  let maxQueueBytes = budget.indexerQueueBytes;
  let maxQueueSize = budget.maxQueueSize;

  if (
    cfg.max_concurrency !== undefined &&
    Number.isInteger(cfg.max_concurrency) &&
    (cfg.max_concurrency as number) > 0
  ) {
    maxConcurrency = clampInt(
      cfg.max_concurrency as number,
      CONCURRENCY_MIN,
      CONCURRENCY_MAX,
    );
    overrides.push("max_concurrency");
  }
  if (
    cfg.sync_batch_size !== undefined &&
    Number.isInteger(cfg.sync_batch_size) &&
    (cfg.sync_batch_size as number) > 0
  ) {
    batchSize = clampInt(
      cfg.sync_batch_size as number,
      BATCH_SIZE_MIN,
      BATCH_SIZE_MAX,
    );
    overrides.push("sync_batch_size");
  }
  if (
    cfg.max_full_files !== undefined &&
    Number.isInteger(cfg.max_full_files) &&
    (cfg.max_full_files as number) > 0
  ) {
    maxFullFiles = cfg.max_full_files as number;
    overrides.push("max_full_files");
  }
  if (cfg.limits && typeof cfg.limits === "object") {
    for (const k of [
      "max_file_bytes",
      "max_chunk_bytes",
      "max_chunks_per_file",
    ] as const) {
      const v = cfg.limits[k];
      if (v !== undefined && Number.isInteger(v) && (v as number) > 0) {
        limits[k] = v as number;
        overrides.push(`limits.${k}`);
      }
    }
  }
  if (cfg.backpressure !== undefined && cfg.backpressure !== false) {
    const bp = cfg.backpressure as { max_queue_bytes?: unknown; max_queue_size?: unknown };
    if (
      bp.max_queue_bytes !== undefined &&
      Number.isInteger(bp.max_queue_bytes) &&
      (bp.max_queue_bytes as number) > 0
    ) {
      maxQueueBytes = bp.max_queue_bytes as number;
      overrides.push("backpressure.max_queue_bytes");
    }
    if (
      bp.max_queue_size !== undefined &&
      Number.isInteger(bp.max_queue_size) &&
      (bp.max_queue_size as number) >= QUEUE_SIZE_MIN
    ) {
      maxQueueSize = clampInt(
        bp.max_queue_size as number,
        QUEUE_SIZE_MIN,
        QUEUE_SIZE_MAX,
      );
      overrides.push("backpressure.max_queue_size");
    }
  }

  return {
    ...budget,
    limits,
    maxFullFiles,
    maxConcurrency,
    batchSize,
    maxQueueBytes,
    maxQueueSize,
    overrides,
  };
}

/**
 * Linha de log do orçamento efetivo (boot). Uma linha, campos estáveis —
 * o operador vê o que governa o pico de RAM sem abrir config.
 */
export function formatBudgetLine(b: EffectiveIndexBudget): string {
  const mb = (n: number): number => Math.round(n / MB);
  return (
    `budget mem_avail_mb=${mb(b.memAvailableBytes)}` +
    (b.limitBytes !== null ? ` cgroup_limit_mb=${mb(b.limitBytes)}` : "") +
    ` reserve_mb=${mb(b.reserveBytes)}` +
    ` queue=${b.maxQueueSize}ev/${mb(b.maxQueueBytes)}mb` +
    ` batch=${b.batchSize}` +
    ` conc=${b.maxConcurrency}` +
    ` file=${mb(b.limits.max_file_bytes)}mb` +
    ` chunk=${Math.round(b.limits.max_chunk_bytes / KB)}kb` +
    ` chunks_per_file=${b.limits.max_chunks_per_file}` +
    ` full_files=${b.maxFullFiles}` +
    ` overrides=${b.overrides.length > 0 ? b.overrides.join(",") : "-"}` +
    ` avg_event_b=${DEFAULT_AVG_EVENT_BYTES} avg_file_b=${DEFAULT_AVG_SPOOL_FILE_BYTES}`
  );
}

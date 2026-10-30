/**
 * Regressões do orçamento prévio de memória (`index/budget.ts`).
 *
 * O pico de RAM da coleta tem de ser função do ORÇAMENTO calculado no boot,
 * não do tamanho do repositório. Estes testes provam (sem tocar em `/proc`):
 *   - a divisão do orçamento (fila do indexer, spool, sync, reserva);
 *   - a derivação de `max_queue_size`, `batchSize` e `maxConcurrency`;
 *   - que cgroup menor que a RAM vence; que leitura ausente cai em fallback;
 *   - que config explícita vence o calculado (e é listada em `overrides`);
 *   - que a linha de log carrega todos os campos efetivos.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyOverrides,
  computeBudget,
  DEFAULT_AVG_EVENT_BYTES,
  DEFAULT_AVG_SPOOL_FILE_BYTES,
  DEFAULT_LIMITS,
  formatBudgetLine,
  type EffectiveIndexBudget,
  type IndexBudget,
  type MemoryReaders,
} from "../src/index/budget.ts";

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

function readers(over: Partial<MemoryReaders> = {}): MemoryReaders {
  return {
    memAvailableBytes: () => 16 * GB,
    cgroupLimitBytes: () => null,
    cpuCount: () => 4,
    ...over,
  };
}

test("budget_splits_usable_memory: reserva + 4 fatias somam o efetivo", () => {
  const b = computeBudget(readers());
  assert.equal(b.memAvailableBytes, 16 * GB);
  assert.equal(b.limitBytes, null);
  // Reserva = max(1GiB, 20%) = 3.2GiB; usável = 12.8GiB.
  const usable = 16 * GB - Math.max(GB, Math.floor((16 * GB) / 5));
  assert.equal(
    b.indexerQueueBytes + b.spoolBufferBytes + b.syncBatchBytes + b.headroomBytes,
    usable,
  );
  assert.ok(b.indexerQueueBytes > 0);
  assert.ok(b.spoolBufferBytes > 0);
  assert.ok(b.syncBatchBytes > 0);
  assert.ok(b.headroomBytes > 0);
});

test("budget_cgroup_wins_when_smaller: limite do container governa", () => {
  const b = computeBudget(readers({ cgroupLimitBytes: () => 2 * GB }));
  assert.equal(b.limitBytes, 2 * GB);
  // Reserva = max(1GiB, 20% de 2GiB=0.4GiB) = 1GiB; usável = 1GiB.
  assert.equal(
    b.indexerQueueBytes + b.spoolBufferBytes + b.syncBatchBytes + b.headroomBytes,
    1 * GB,
  );
});

test("budget_derives_queue_batch_concurrency: valores dentro dos tetos", () => {
  const b: IndexBudget = computeBudget(readers());
  // Fila: 25% do usável / 4KB por evento, clamp [10, 10000].
  const expectedQueue = Math.min(
    10000,
    Math.max(10, Math.floor(b.indexerQueueBytes / DEFAULT_AVG_EVENT_BYTES)),
  );
  assert.equal(b.maxQueueSize, expectedQueue);
  // Lote: 45% do usável / 256KB por arquivo, clamp [10, 100] (teto do servidor).
  const expectedBatch = Math.min(
    100,
    Math.max(10, Math.floor(b.syncBatchBytes / DEFAULT_AVG_SPOOL_FILE_BYTES)),
  );
  assert.equal(b.batchSize, expectedBatch);
  // Concorrência: ncpu-1, clamp [1, 8].
  assert.equal(b.maxConcurrency, 3);
  // Limites estáticos entram no orçamento como default.
  assert.deepEqual(b.limits, DEFAULT_LIMITS);
});

test("budget_fallback_without_readers: sem /proc, assume 4GiB/4cpu", () => {
  const b = computeBudget({
    memAvailableBytes: () => null,
    cgroupLimitBytes: () => null,
    cpuCount: () => 0,
  });
  assert.equal(b.memAvailableBytes, 4 * GB);
  assert.equal(b.maxConcurrency, 3);
  assert.ok(b.maxQueueSize >= 10);
});

test("budget_tiny_machine: reserva nunca zera o usável", () => {
  const b = computeBudget(
    readers({ memAvailableBytes: () => 512 * MB, cpuCount: () => 1 }),
  );
  assert.ok(b.indexerQueueBytes >= 64 * 1024, "fila mínima útil");
  assert.equal(b.maxConcurrency, 1);
  assert.ok(b.batchSize >= 10);
  assert.ok(b.maxQueueSize >= 10);
});

test("overrides_explicit_wins: config explícita vence o calculado", () => {
  const b = computeBudget(readers());
  const eff = applyOverrides(b, {
    max_concurrency: 2,
    sync_batch_size: 25,
    max_full_files: 5000,
    limits: { max_file_bytes: 2 * MB },
    backpressure: { max_queue_bytes: 32 * MB, max_queue_size: 100 },
  });
  assert.equal(eff.maxConcurrency, 2);
  assert.equal(eff.batchSize, 25);
  assert.equal(eff.maxFullFiles, 5000);
  assert.equal(eff.limits.max_file_bytes, 2 * MB);
  assert.equal(eff.limits.max_chunk_bytes, DEFAULT_LIMITS.max_chunk_bytes);
  assert.equal(eff.maxQueueBytes, 32 * MB);
  assert.equal(eff.maxQueueSize, 100);
  assert.deepEqual(
    [...eff.overrides].sort(),
    [
      "backpressure.max_queue_bytes",
      "backpressure.max_queue_size",
      "limits.max_file_bytes",
      "max_concurrency",
      "max_full_files",
      "sync_batch_size",
    ].sort(),
  );
});

test("overrides_empty_config: sem explícito, tudo vem do orçamento", () => {
  const b = computeBudget(readers());
  const eff: EffectiveIndexBudget = applyOverrides(b, {});
  assert.deepEqual(eff.overrides, []);
  assert.equal(eff.maxConcurrency, b.maxConcurrency);
  assert.equal(eff.batchSize, b.batchSize);
  assert.equal(eff.maxQueueSize, b.maxQueueSize);
  assert.equal(eff.maxQueueBytes, b.indexerQueueBytes);
  assert.deepEqual(eff.limits, b.limits);
});

test("overrides_backpressure_false: sem backpressure, fila é irrelevante", () => {
  const b = computeBudget(readers());
  const eff = applyOverrides(b, { backpressure: false });
  assert.equal(eff.maxQueueSize, b.maxQueueSize);
  assert.equal(eff.maxQueueBytes, b.indexerQueueBytes);
});

test("budget_line_logs_effective_values: boot mostra o orçamento", () => {
  const eff = applyOverrides(computeBudget(readers()), { max_concurrency: 2 });
  const line = formatBudgetLine(eff);
  assert.match(line, /^budget /);
  for (const k of [
    "mem_avail_mb=",
    "queue=",
    "batch=",
    "conc=2",
    "file=",
    "chunk=",
    "chunks_per_file=",
    "full_files=",
    "overrides=",
  ]) {
    assert.ok(line.includes(k), `linha deve conter ${k}: ${line}`);
  }
});

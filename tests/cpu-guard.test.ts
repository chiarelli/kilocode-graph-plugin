/**
 * Regressões da guarda de CPU (`index/cpu-guard.ts`).
 *
 * Nada toca `/proc` real: os leitores são fixtures e o `signal` é registrado em
 * memória. O que se prova é a POLÍTICA (pausa em 85% do sistema com o indexer
 * consumindo, retomada em 75%, timeout que nunca deixa o job travado) — que é
 * onde estavam os defeitos que causavam saturação sem controle.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CpuGuard,
  parseProcStat,
  processCpuPercent,
  systemCpuPercent,
  type CpuReaders,
  type ProcessSample,
  type SystemSample,
} from "../src/index/cpu-guard.ts";

test("parse_proc_stat: soma ticks e separa idle+iowait", () => {
  const sample = parseProcStat(
    "cpu  100 0 100 800 20 0 0 0 0 0\ncpu0 1 2 3 4 5 6 7 8 9 10\n",
  );
  assert.deepEqual(sample, { idle: 820, total: 1020 });
});

test("parse_proc_stat_invalid: sem linha cpu / valores não numéricos ⇒ null", () => {
  assert.equal(parseProcStat(""), null);
  assert.equal(parseProcStat("cpu0 1 2 3 4"), null);
  assert.equal(parseProcStat("cpu  a b c d"), null);
});

test("system_cpu_percent: 85% de ocupação", () => {
  const prev: SystemSample = { idle: 0, total: 0 };
  const cur: SystemSample = { idle: 15, total: 100 };
  assert.equal(systemCpuPercent(prev, cur), 85);
});

test("system_cpu_percent_no_progress: ticks iguais ⇒ null (sem divisão por zero)", () => {
  const s: SystemSample = { idle: 10, total: 100 };
  assert.equal(systemCpuPercent(s, s), null);
});

test("process_cpu_percent: 1 core cheio numa máquina de 4 ⇒ 25%", () => {
  const prev: ProcessSample = { ticks: 0 };
  const cur: ProcessSample = { ticks: 100 };
  // 100 ticks em 1s com HZ=100 = 1 core; /4 cores = 25%.
  assert.equal(processCpuPercent(prev, cur, 1000, 100, 4), 25);
});

/** Harness: fila de amostras do sistema/processo + sinais capturados. */
function harness(
  systemSeries: Array<SystemSample | null>,
  processSeries: Array<ProcessSample | null>,
  opts: { cpuCount?: number; maxPauseMs?: number } = {},
) {
  let now = 0;
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const readers: CpuReaders = {
    system: () => systemSeries.shift() ?? null,
    process: () => processSeries.shift() ?? null,
  };
  const guard = new CpuGuard(
    1234,
    {
      sample_ms: 1000,
      threshold_percent: 85,
      resume_percent: 75,
      max_pause_ms: opts.maxPauseMs ?? 30_000,
    },
    {
      readers,
      signal: (pid, signal) => signals.push({ pid, signal }),
      now: () => now,
      ticksPerSecond: 100,
      cpuCount: opts.cpuCount ?? 4,
    },
  );
  return {
    guard,
    signals,
    advance(ms: number) {
      now += ms;
    },
  };
}

test("cpu_guard_pauses_at_85_with_busy_indexer: SIGSTOP", () => {
  const h = harness(
    [
      { idle: 100, total: 1000 }, // baseline
      { idle: 110, total: 1100 }, // 100% ocupado no delta
    ],
    [{ ticks: 0 }, { ticks: 100 }],
  );
  h.guard.tick(); // baseline
  h.advance(1000);
  h.guard.tick();
  assert.deepEqual(h.signals, [{ pid: 1234, signal: "SIGSTOP" }]);
  assert.equal(h.guard.status().paused, true);
  assert.equal(h.guard.status().pauses, 1);
});

test("cpu_guard_no_pause_when_system_cool: 50% não pausa", () => {
  const h = harness(
    [
      { idle: 100, total: 1000 },
      { idle: 150, total: 1100 }, // 50% ocupado
    ],
    [{ ticks: 0 }, { ticks: 100 }],
  );
  h.guard.tick();
  h.advance(1000);
  h.guard.tick();
  assert.deepEqual(h.signals, []);
  assert.equal(h.guard.status().paused, false);
});

test("cpu_guard_no_pause_when_indexer_idle: sistema cheio mas processo sem CPU ⇒ não pausa", () => {
  // Gate duplo: pausar um processo ocioso não alivia nada (a carga é de outro).
  const h = harness(
    [
      { idle: 100, total: 1000 },
      { idle: 110, total: 1100 }, // sistema 90%
    ],
    [{ ticks: 0 }, { ticks: 0 }], // indexer sem CPU
  );
  h.guard.tick();
  h.advance(1000);
  h.guard.tick();
  assert.deepEqual(h.signals, []);
});

test("cpu_guard_resumes_under_75: SIGCONT quando o sistema normaliza", () => {
  const h = harness(
    [
      { idle: 100, total: 1000 },
      { idle: 110, total: 1100 }, // pausa
      { idle: 210, total: 1200 }, // 90% idle ⇒ 10% ocupado
    ],
    [{ ticks: 0 }, { ticks: 100 }, { ticks: 100 }],
  );
  h.guard.tick();
  h.advance(1000);
  h.guard.tick();
  h.advance(1000);
  h.guard.tick();
  assert.deepEqual(
    h.signals.map((s) => s.signal),
    ["SIGSTOP", "SIGCONT"],
  );
  assert.equal(h.guard.status().paused, false);
});

test("cpu_guard_max_pause_timeout: nunca deixa o job pausado para sempre", () => {
  const h = harness(
    [
      { idle: 100, total: 1000 },
      { idle: 110, total: 1100 }, // pausa
      { idle: 115, total: 1300 }, // continua saturado
      { idle: 120, total: 1500 }, // continua saturado, mas estourou o teto
    ],
    [{ ticks: 0 }, { ticks: 100 }, { ticks: 100 }, { ticks: 100 }],
    { maxPauseMs: 1500 },
  );
  h.guard.tick();
  h.advance(1000);
  h.guard.tick();
  h.advance(1000);
  h.guard.tick(); // 1000ms pausado, ainda não estourou
  assert.equal(h.guard.status().paused, true);
  h.advance(1000);
  h.guard.tick(); // 2000ms > 1500ms ⇒ retoma
  assert.equal(h.guard.status().paused, false);
  assert.equal(h.guard.status().pausedMs >= 1500, true);
});

test("cpu_guard_signal_error_does_not_throw: processo já saiu", () => {
  const h = harness(
    [
      { idle: 100, total: 1000 },
      { idle: 110, total: 1100 },
    ],
    [{ ticks: 0 }, { ticks: 100 }],
  );
  // Reinstala o signal para falhar (ESRCH).
  (h.guard as unknown as { signal: () => void }).signal = () => {
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  };
  h.guard.tick();
  h.advance(1000);
  assert.doesNotThrow(() => h.guard.tick());
  assert.equal(h.guard.status().paused, false);
});

test("cpu_guard_stop_resumes_when_paused: SIGCONT no encerramento", () => {
  const h = harness(
    [
      { idle: 100, total: 1000 },
      { idle: 110, total: 1100 },
    ],
    [{ ticks: 0 }, { ticks: 100 }],
  );
  // `tick` direto (sem `start`, que consumiria as amostras do baseline).
  h.guard.tick();
  h.advance(1000);
  h.guard.tick();
  assert.equal(h.guard.status().paused, true);
  h.guard.stop();
  assert.equal(h.guard.status().paused, false);
  assert.equal(h.signals.at(-1)?.signal, "SIGCONT");
});

test("cpu_guard_disabled_start: não registra timer nem sinal", () => {
  const h = harness([], []);
  const disabled = new CpuGuard(1234, { enabled: false }, { readers: h.guard["readers"] });
  disabled.start();
  disabled.stop();
  assert.deepEqual(h.signals, []);
});

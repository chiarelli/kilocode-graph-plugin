/**
 * `cpu-guard.ts` — guarda de CPU do processo do indexer (sem limitar núcleos).
 *
 * Estratégia: o indexer herda a máquina inteira (o `max_concurrency` do plugin
 * é deliberadamente alto — não cortamos paralelismo). Em vez de restringir
 * cores, o plugin:
 *   1. spawna o binário com `nice` (prioridade menor);
 *   2. amostra `/proc/stat` (CPU do SISTEMA) e `/proc/<pid>/stat` (CPU do
 *      processo) a cada `sample_ms`;
 *   3. quando o sistema passa de `threshold_percent` **e** o indexer está
 *      consumindo CPU, envia `SIGSTOP` (pausa o processo) e espera;
 *   4. retoma com `SIGCONT` quando a CPU do sistema cai a `resume_percent` ou
 *      menos, ou ao estourar `max_pause_ms` (nunca deixa o job travado).
 *
 * Por que o gate duplo: numa máquina com muitos núcleos o indexer sozinho pode
 * nunca chegar a 85% do total — mas se o sistema como um todo está saturado, o
 * indexer é quem deve ceder. Se o sistema está alto e o indexer NÃO está
 * gastando CPU (ex.: embedding do daemon), pausá-lo não ajuda em nada.
 *
 * Parsers são puros e injetáveis (`CpuReaders`) — testes não tocam `/proc`.
 */

import { readFileSync } from "node:fs";

/** Amostra de CPU do sistema (ticks acumulados do `/proc/stat`). */
export interface SystemSample {
  /** Ticks ociosos (idle + iowait). */
  idle: number;
  /** Ticks totais (soma de todos os campos). */
  total: number;
}

/** Amostra de CPU de um processo (ticks de user+system do `/proc/<pid>/stat`). */
export interface ProcessSample {
  /** Ticks de CPU (utime + stime). */
  ticks: number;
}

/** Leitores injetáveis (default: `/proc`). Testes passam fixtures. */
export interface CpuReaders {
  system(): SystemSample | null;
  process(pid: number): ProcessSample | null;
}

/** Configuração efetiva da guarda. */
export interface CpuGuardConfig {
  /** Liga a guarda (default `true`). */
  enabled: boolean;
  /** Pausa quando a CPU do SISTEMA ≥ este percentual (default 85). */
  threshold_percent: number;
  /** Retoma quando a CPU do SISTEMA ≤ este percentual (default 75). */
  resume_percent: number;
  /** Intervalo de amostragem (ms, default 1000). */
  sample_ms: number;
  /** Pausa máxima antes de retomar de qualquer forma (ms, default 30000). */
  max_pause_ms: number;
  /** Prioridade `nice` do processo (default 10; 0 = não aplicar). */
  nice: number;
}

export const DEFAULT_CPU_GUARD: CpuGuardConfig = {
  enabled: true,
  threshold_percent: 85,
  resume_percent: 75,
  sample_ms: 1000,
  max_pause_ms: 30_000,
  nice: 10,
};

/** Tipos de sinal usados pela guarda (injetável para teste). */
export type SignalFn = (pid: number, signal: NodeJS.Signals) => void;

/** Lê a primeira linha `cpu ...` do `/proc/stat`. `null` quando indisponível. */
export function parseProcStat(text: string): SystemSample | null {
  const line = text.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal guest guest_nice
  if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [user, nice, system, idle, iowait = 0, ...rest] = parts;
  const total =
    (user ?? 0) + (nice ?? 0) + (system ?? 0) + (idle ?? 0) + iowait +
    rest.reduce((a, b) => a + b, 0);
  return { idle: (idle ?? 0) + iowait, total };
}

/**
 * Percentual de CPU do sistema entre duas amostras (0–100). `null` quando não
 * houve avanço de ticks (amostras no mesmo instante) — evita divisão por zero.
 */
export function systemCpuPercent(prev: SystemSample, cur: SystemSample): number | null {
  const dTotal = cur.total - prev.total;
  const dIdle = cur.idle - prev.idle;
  if (dTotal <= 0) return null;
  const busy = Math.max(0, dTotal - Math.max(0, dIdle));
  return Math.min(100, (busy / dTotal) * 100);
}

/**
 * Percentual de CPU do processo em relação à máquina inteira. Sem o número de
 * núcleos (injetado) o valor seria relativo a 1 core.
 */
export function processCpuPercent(
  prev: ProcessSample,
  cur: ProcessSample,
  elapsedMs: number,
  ticksPerSecond: number,
  cpuCount: number,
): number | null {
  const dTicks = cur.ticks - prev.ticks;
  if (elapsedMs <= 0 || cpuCount <= 0) return null;
  const seconds = elapsedMs / 1000;
  const pct = (dTicks / (seconds * ticksPerSecond)) / cpuCount * 100;
  return Math.max(0, Math.min(100, pct));
}

/** Leitores reais baseados em `/proc` (Linux). */
export const procCpuReaders: CpuReaders = {
  system(): SystemSample | null {
    try {
      return parseProcStat(readFileSync("/proc/stat", "utf-8"));
    } catch {
      return null;
    }
  },
  process(pid: number): ProcessSample | null {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, "utf-8");
      // O 2º campo (`comm`) pode conter espaços e parênteses; tudo depois do
      // ÚLTIMO `)` está na ordem estável do `proc(5)`.
      const close = raw.lastIndexOf(")");
      if (close < 0) return null;
      const fields = raw.slice(close + 2).trim().split(/\s+/);
      // Depois de `)` o campo 3 (state) é o índice 0; utime (14) e stime (15)
      // ficam em 11 e 12.
      const utime = Number(fields[11]);
      const stime = Number(fields[12]);
      if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
      return { ticks: utime + stime };
    } catch {
      return null;
    }
  },
};

/** Estado observável da guarda (para log/teste). */
export interface CpuGuardSnapshot {
  paused: boolean;
  lastSystemPercent: number | null;
  lastProcessPercent: number | null;
  pauses: number;
  /** Tempo total pausado (ms). */
  pausedMs: number;
}

/**
 * Guarda de CPU de UM processo. `start`/`stop` são idempotentes; `stop` sempre
 * retoma o processo (SIGCONT) antes de desligar o timer.
 */
export class CpuGuard {
  private readonly cfg: CpuGuardConfig;
  private readonly pid: number;
  private readonly readers: CpuReaders;
  private readonly signal: SignalFn;
  private readonly now: () => number;
  private readonly ticksPerSecond: number;
  private readonly cpuCount: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private prevSystem: SystemSample | null = null;
  private prevProcess: ProcessSample | null = null;
  private prevAt = 0;
  private pausedAt: number | null = null;
  private snapshot: CpuGuardSnapshot = {
    paused: false,
    lastSystemPercent: null,
    lastProcessPercent: null,
    pauses: 0,
    pausedMs: 0,
  };

  constructor(
    pid: number,
    cfg: Partial<CpuGuardConfig> = {},
    deps: {
      readers?: CpuReaders;
      signal?: SignalFn;
      now?: () => number;
      ticksPerSecond?: number;
      cpuCount?: number;
    } = {},
  ) {
    this.cfg = { ...DEFAULT_CPU_GUARD, ...cfg };
    this.pid = pid;
    this.readers = deps.readers ?? procCpuReaders;
    this.signal = deps.signal ?? ((p, s) => process.kill(p, s));
    this.now = deps.now ?? (() => Date.now());
    this.ticksPerSecond = deps.ticksPerSecond ?? 100;
    this.cpuCount = deps.cpuCount ?? 1;
  }

  /** Estado atual (cópia — não expõe a referência interna). */
  status(): CpuGuardSnapshot {
    return { ...this.snapshot };
  }

  /** Inicia a amostragem. No-op quando desabilitada ou sem pid válido. */
  start(): void {
    if (!this.cfg.enabled || this.timer !== null || this.pid <= 0) return;
    this.prevSystem = this.readers.system();
    this.prevProcess = this.readers.process(this.pid);
    this.prevAt = this.now();
    this.timer = setInterval(() => this.tick(), this.cfg.sample_ms);
    // Nunca segura o event loop do plugin (o job tem o seu próprio timeout).
    this.timer.unref?.();
  }

  /** Para a amostragem e garante SIGCONT (processo pausado não pode ficar). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.snapshot.paused) this.resume();
  }

  /** Uma amostra. Exposta para teste (sem timer). */
  tick(): void {
    const at = this.now();
    const system = this.readers.system();
    const proc = this.readers.process(this.pid);
    const elapsed = at - this.prevAt;
    const systemPct =
      system && this.prevSystem ? systemCpuPercent(this.prevSystem, system) : null;
    const processPct =
      proc && this.prevProcess && elapsed > 0
        ? processCpuPercent(
            this.prevProcess,
            proc,
            elapsed,
            this.ticksPerSecond,
            this.cpuCount,
          )
        : null;

    if (system) this.prevSystem = system;
    if (proc) this.prevProcess = proc;
    this.prevAt = at;
    this.snapshot.lastSystemPercent = systemPct ?? this.snapshot.lastSystemPercent;
    this.snapshot.lastProcessPercent = processPct ?? this.snapshot.lastProcessPercent;

    if (!this.snapshot.paused) {
      const systemHot = systemPct !== null && systemPct >= this.cfg.threshold_percent;
      // Gate duplo: sistema saturado E o indexer consumindo. Se o processo não
      // aparece (já saiu) ou está ocioso, pausar não resolve a carga.
      const procBusy = processPct === null || processPct >= 1;
      if (systemHot && procBusy) this.pause();
      return;
    }

    // Pausado: o processo está parado, então a decisão é só do sistema. O
    // timeout protege contra nunca normalizar (ex.: outra carga permanente).
    const cool = systemPct === null || systemPct <= this.cfg.resume_percent;
    const overdue = this.pausedAt !== null && at - this.pausedAt >= this.cfg.max_pause_ms;
    if (cool || overdue) this.resume();
  }

  private pause(): void {
    try {
      this.signal(this.pid, "SIGSTOP");
    } catch {
      return; // processo já saiu: nada a pausar
    }
    this.snapshot.paused = true;
    this.snapshot.pauses += 1;
    this.pausedAt = this.now();
  }

  private resume(): void {
    try {
      this.signal(this.pid, "SIGCONT");
    } catch {
      // já saiu
    }
    if (this.pausedAt !== null) {
      this.snapshot.pausedMs += this.now() - this.pausedAt;
      this.pausedAt = null;
    }
    this.snapshot.paused = false;
  }
}

/**
 * `lock.ts` — trava cross-process do coletor (E3a-S6a, §3b).
 *
 * Boot e post-commit são **processos SO distintos** (o plugin spawna o CLI; o
 * git spawna o CLI). A serialização real é uma **trava cross-process** em torno
 * de *load manifest → index → sync → save*: um lockfile criado com `O_EXCL`
 * (`open(..., "wx")`), que grava o `pid`, com retry até um timeout finito.
 *
 * A trava em memória do repo (`routine.ts`) **não** cobre dois processos —
 * por isso o lockfile vive no disco (`<ws>/.kilo/graph.lock`).
 *
 * Robustez:
 *   - **Timeout finito**: ao estourar, desiste com log (nunca espera para sempre).
 *   - **Stale**: um lock com `mtime` mais velho que `staleMs` é considerado órfão
 *     (processo morto) e removido, retomando com log. Default de `staleMs` =
 *     `timeoutMs` (o dono fixou "mtime mais velho que o timeout").
 *
 * Módulo com I/O de arquivo; `now`/`sleep` são injetáveis para o teste não
 * depender de relógio real. Nunca lança: erro de fs degrada para `null`.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import { log } from "../logger.ts";

/** Orçamento de espera default pela trava (ms). */
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
/**
 * Idade (mtime) que torna um lock **sem pid legível** elegível a reclaim (ms).
 * É um **fallback** — a detecção primária de órfão é por **processo morto**
 * (`isPidAlive`). Um full pode levar MINUTOS e mantém a trava o tempo todo; usar
 * só o mtime (com um valor curto) faria um segundo CLI "roubar" a trava de um
 * full vivo, correndo dois escritores (exatamente o que a trava evita). Por isso
 * o default é folgado (10 min) e só vale quando não há pid para checar.
 */
export const DEFAULT_STALE_MS = 600_000;
/** Intervalo default entre tentativas (ms). */
export const DEFAULT_RETRY_MS = 100;

/** Nome do lockfile dentro do workspace. */
export const LOCK_REL_PATH = ".kilo/graph.lock";

/** Handle da trava; `release()` remove o lockfile (idempotente). */
export interface LockHandle {
  release(): void;
}

export interface AcquireLockOptions {
  /** Caminho do lockfile (ex.: `<ws>/.kilo/graph.lock`). Vazio ⇒ no-op (handle). */
  path: string;
  /** Orçamento total de espera (ms). Default `DEFAULT_LOCK_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Idade que torna o lock elegível a reclaim (ms). Default `staleMs=timeoutMs`. */
  staleMs?: number;
  /** Intervalo entre tentativas (ms). Default `DEFAULT_RETRY_MS`. */
  retryMs?: number;
  /** Relógio injetável (default `Date.now`). */
  now?: () => number;
  /** Dormir injetável (default `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
}

/** `true` quando o código do erro é EEXIST (lock já existe). */
function isEexist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "EEXIST";
}

/** `mtimeMs` do arquivo, ou `null` se ausente (corrida) — nunca lança. */
function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** `pid` gravado no lockfile, ou `null`. */
export function readLockPid(path: string): number | null {
  try {
    const n = Number(readFileSync(path, "utf-8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * `true` quando o processo `pid` está vivo (`kill(pid, 0)`). `ESRCH` ⇒ morto;
 * `EPERM` ⇒ vivo mas de outro usuário (conta como vivo — não roubamos o lock de
 * um dono alheio). É a detecção **primária** de órfão: um full vive um `pid`
 * real, então a idade do lock não o condena enquanto o processo existir.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Adquire a trava cross-process. Devolve um `LockHandle` (chamador **sempre**
 * libera) ou `null` se desistiu por timeout. `path` vazio ⇒ handle no-op (não há
 * onde travar; o chamador segue).
 */
export async function acquireLock(
  opts: AcquireLockOptions,
): Promise<LockHandle | null> {
  const path = opts.path;
  if (!path) return { release: () => {} };

  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const pid = process.pid;
  const deadline = now() + timeoutMs;

  const makeHandle = (): LockHandle => {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        // Só remove se ainda for o nosso lock (pid). Se foi reclaimado por
        // outro processo, não apaga o lock alheio.
        if (readLockPid(path) === pid) {
          try {
            unlinkSync(path);
          } catch {
            // Já removido (reclaim/limpeza): no-op.
          }
        }
      },
    };
  };

  /**
   * Tenta criar o lock. Devolve `true` (criado), `false` (EEXIST — ocupado) ou
   * lança em erro **não-recuperável** (EACCES/EROFS/…) — o chamador decide
   * desistir na hora em vez de insistir até o timeout.
   */
  const createOnce = (): boolean => {
    const fd = openSync(path, "wx"); // O_CREAT | O_EXCL | O_WRONLY
    try {
      writeSync(fd, String(pid));
    } finally {
      closeSync(fd);
    }
    return true;
  };

  // Cria o diretório antes da primeira tentativa (ENOENT é o caso comum de repo
  // sem `.kilo/`).
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    // EEXIST (corrida de mkdir) é inofensivo; qualquer outro erro de fs é fatal
    // para a trava — desiste já (não fica martelando).
    if (code !== "EEXIST" && code !== "ENOENT") {
      log(
        `collect lock: não criou o diretório (${code ?? "?"}); abortado`,
      );
      return null;
    }
  }

  for (;;) {
    try {
      createOnce();
      return makeHandle();
    } catch (err) {
      if (!isEexist(err)) {
        // Erro de fs NÃO-EEXIST (EACCES/EROFS/ENOTDIR/…): sem trava utilizável.
        // Insistir até o timeout só gastaria 30s por commit — desiste já.
        log(
          `collect lock: erro de fs (${(err as NodeJS.ErrnoException | null)?.code ?? "?"}); ` +
            `abortado`,
        );
        return null;
      }
    }

    // Lock ocupado. Órfão? Processo dono morto ⇒ remove e retoma. Se o pid não
    // for legível, cai no mtime (fallback) contra um teto folgado (`staleMs`).
    const owner = readLockPid(path);
    if (owner !== null) {
      if (!isPidAlive(owner)) {
        log(`collect lock: órfão (pid ${owner} morto); removendo e retomando`);
        try {
          unlinkSync(path);
        } catch {
          // Outro processo o removeu primeiro: a próxima iteração tenta criar.
        }
        continue;
      }
    } else {
      const m = mtimeMs(path);
      if (m !== null && now() - m >= staleMs) {
        log(`collect lock: stale (mtime > ${staleMs}ms); removendo e retomando`);
        try {
          unlinkSync(path);
        } catch {
          // Reclaim concorrente: a próxima iteração tenta criar.
        }
        continue;
      }
    }

    if (now() >= deadline) {
      log(`collect lock: timeout (${timeoutMs}ms); desistindo`);
      return null;
    }
    await sleep(retryMs);
  }
}

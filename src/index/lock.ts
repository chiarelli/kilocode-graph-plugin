/**
 * `lock.ts` — trava cross-process do coletor (E3a-S6a, §3b).
 *
 * Boot e post-commit são **processos SO distintos** (o plugin spawna o CLI; o
 * git spawna o CLI). A serialização real é uma **trava cross-process** em torno
 * de *load manifest → index → sync → save*.
 *
 * ## Dois mecanismos
 *
 * 1. **`flock(2)` (primário, sob Bun)** — o CLI de produção roda no extension
 *    host do Kilo, que é um executável **Bun** (`process.versions.bun`); ali
 *    `bun:ffi` expõe `flock` da libc. A vantagem decisiva: o **kernel libera a
 *    trava quando o processo morre** — inclusive em `SIGKILL`, que pula todo
 *    `finally`. Com `flock` não existe lock órfão: um crash deixa de bloquear a
 *    próxima coleta (o defeito medido com o lockfile-`O_EXCL`).
 * 2. **Lockfile `O_EXCL` (fallback, sob Node)** — Node não tem `bun:ffi`, então
 *    onde `flock` não está disponível mantém-se o lockfile com `pid` + detecção
 *    de órfão por liveness/mtime. É o caminho exercido pela suíte (`node --test`).
 *
 * Sob `flock`, o arquivo **nunca é removido**: `unlink` + `flock` é uma corrida
 * clássica (dois processos acabam travando inodes diferentes e a exclusão mútua
 * cai). O arquivo vira um token de mutex persistente; a exclusão é do kernel.
 *
 * Robustez (ambos): **timeout finito** (ao estourar, desiste com log — nunca
 * espera para sempre). No fallback, adicionalmente: **stale** por `mtime` quando
 * o `pid` não é legível. Módulo com I/O; `now`/`sleep` são injetáveis para o
 * teste não depender de relógio real. Nunca lança: erro de fs degrada para `null`.
 */

import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import { log } from "../logger.ts";
import { isBunHost } from "../runtime.ts";

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

/** Handle da trava; `release()` remove a trava (idempotente). */
export interface LockHandle {
  release(): void;
}

/**
 * Primitiva de trava por arquivo (o `flock` real, ou um fake no teste). A trava
 * é por **inode** (como o `flock(2)`): dois `fd` para o mesmo arquivo contendem.
 * Abstrair assim permite testar o caminho `flock` sob Node (que não tem
 * `bun:ffi`), injetando um fake que rastreia `(dev, ino)`.
 */
export interface FileLockOps {
  /** Tenta travar `fd` (não-bloqueante). `true` = adquiriu. */
  tryLock(fd: number): boolean;
  /** Libera a trava de `fd` (idempotente). */
  unlock(fd: number): void;
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
  /**
   * Primitiva de trava injetável. Ausente ⇒ auto-detecta (`flock` sob Bun,
   * senão `O_EXCL`). `null` ⇒ força o fallback `O_EXCL` (teste). Um `FileLockOps`
   * ⇒ usa-o (teste do caminho `flock` sob Node).
   */
  lockOps?: FileLockOps | null;
}

/* -------------------------------------------------------------------------- */
/* flock(2) via bun:ffi (primário sob Bun)                                     */
/* -------------------------------------------------------------------------- */

/** Operações do `flock(2)` (Linux/macOS). */
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

/** Assinatura de `flock(int fd, int operation) -> int` (0 ok, -1 erro). */
type FlockFn = (fd: number, operation: number) => number;

/** Cache das `FileLockOps` do flock; `undefined` = ainda não sondado. */
let flockOps: FileLockOps | null | undefined;

/** Envolve o `flock` da libc como `FileLockOps` (trava por inode). */
function flockToOps(flock: FlockFn): FileLockOps {
  return {
    tryLock: (fd) => flock(fd, LOCK_EX | LOCK_NB) === 0,
    unlock: (fd) => {
      flock(fd, LOCK_UN);
    },
  };
}

/**
 * Resolve `flock` da libc via `bun:ffi`. Sob Node (ou sem `bun:ffi`) devolve
 * `null` — o chamador cai no lockfile `O_EXCL`. Sondado **uma vez** e cacheado.
 * Nunca lança.
 */
async function loadFlock(): Promise<FileLockOps | null> {
  if (flockOps !== undefined) return flockOps;
  flockOps = null;
  if (!isBunHost()) return null;
  try {
    // Especificador não-literal: evita a resolução estática do TS (o módulo só
    // existe sob Bun; sob Node este ramo nem é alcançado).
    const specifier = "bun:ffi";
    const ffi = (await import(specifier)) as {
      dlopen: (
        lib: string,
        symbols: Record<string, unknown>,
      ) => { symbols: Record<string, unknown> };
      FFIType: { i32: number };
    };
    const candidates = ["libc.so.6", "libc.so", "libSystem.B.dylib"];
    for (const lib of candidates) {
      try {
        const { symbols } = ffi.dlopen(lib, {
          flock: { args: [ffi.FFIType.i32, ffi.FFIType.i32], returns: ffi.FFIType.i32 },
        });
        if (typeof symbols.flock === "function") {
          flockOps = flockToOps(symbols.flock as FlockFn);
          return flockOps;
        }
      } catch {
        // Biblioteca ausente: tenta a próxima.
      }
    }
  } catch {
    // `bun:ffi` indisponível: fallback O_EXCL.
  }
  return null;
}

/** Cria o diretório pai do lockfile (best-effort; ENOENT/EEXIST são ok). */
function ensureParent(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // EEXIST (corrida) é inofensivo; outros erros aparecem no `open` abaixo.
  }
}

/** `release()` do flock: `unlock` + `close` (o close já libera; idempotente). */
function flockHandle(fd: number, ops: FileLockOps): LockHandle {
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try {
        ops.unlock(fd);
      } catch {
        // fd já inválido: o close abaixo resolve.
      }
      try {
        closeSync(fd);
      } catch {
        // Já fechado.
      }
      // NÃO remove o arquivo: `unlink` + `flock` é uma corrida (ver cabeçalho).
    },
  };
}

/**
 * Adquire via `flock` (não-bloqueante com retry até o timeout). O arquivo é
 * aberto (criado se ausente) e mantido aberto pela vida do handle — o kernel
 * libera a trava no `close` ou na morte do processo.
 */
async function acquireViaFlock(
  path: string,
  opts: AcquireLockOptions,
  ops: FileLockOps,
): Promise<LockHandle | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const deadline = now() + timeoutMs;

  ensureParent(path);
  let fd: number;
  try {
    fd = openSync(path, "a+"); // cria se ausente; não trunca.
  } catch (err) {
    log(
      `collect lock: não abriu o lockfile (${(err as NodeJS.ErrnoException | null)?.code ?? "?"}); ` +
        `abortado`,
    );
    return null;
  }

  for (;;) {
    if (ops.tryLock(fd)) {
      // Diagnóstico best-effort (o arquivo é um token; o conteúdo não trava).
      try {
        ftruncateSync(fd, 0);
        writeSync(fd, String(process.pid));
      } catch {
        // Sem escrita: irrelevante para a exclusão (que é do kernel).
      }
      return flockHandle(fd, ops);
    }
    if (now() >= deadline) {
      try {
        closeSync(fd);
      } catch {
        // Já fechado.
      }
      log(`collect lock: timeout (${timeoutMs}ms); desistindo`);
      return null;
    }
    await sleep(retryMs);
  }
}

/* -------------------------------------------------------------------------- */
/* Lockfile O_EXCL (fallback sob Node)                                         */
/* -------------------------------------------------------------------------- */

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
 * Adquire via lockfile `O_EXCL` com reclaim de órfão (fallback sem `flock`).
 * Mantém o comportamento histórico: `pid` + liveness, `mtime` como fallback.
 */
async function acquireViaExcl(
  path: string,
  opts: AcquireLockOptions,
): Promise<LockHandle | null> {
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
      log(`collect lock: não criou o diretório (${code ?? "?"}); abortado`);
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

/* -------------------------------------------------------------------------- */
/* Entrada                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Adquire a trava cross-process. Devolve um `LockHandle` (chamador **sempre**
 * libera) ou `null` se desistiu por timeout. `path` vazio ⇒ handle no-op.
 *
 * Usa `flock` quando disponível (Bun) — o kernel libera na morte do processo,
 * sem lock órfão — e cai no lockfile `O_EXCL` sob Node. `opts.lockOps` força o
 * mecanismo (teste): `null` ⇒ `O_EXCL`; um `FileLockOps` ⇒ trava por arquivo.
 */
export async function acquireLock(
  opts: AcquireLockOptions,
): Promise<LockHandle | null> {
  const path = opts.path;
  if (!path) return { release: () => {} };

  // `lockOps` explícito vence a auto-detecção (`null` força o fallback O_EXCL).
  const ops = opts.lockOps !== undefined ? opts.lockOps : await loadFlock();
  if (ops) return acquireViaFlock(path, opts, ops);
  return acquireViaExcl(path, opts);
}

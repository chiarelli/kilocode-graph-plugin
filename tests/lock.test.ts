/**
 * E3a-S6a — `index/lock.ts`: trava cross-process, timeout finito, reclaim de
 * lock órfão. Dois mecanismos: `flock(2)` (primário sob Bun; liberado pelo
 * kernel na morte do processo) e lockfile `O_EXCL` (fallback sob Node). Sem
 * relógio real (`now`/`sleep` injetados); os arquivos usam um diretório
 * temporário real (o comportamento sob teste é o de fs/OS).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { acquireLock, readLockPid, type FileLockOps } from "../src/index/lock.ts";

const dirs: string[] = [];
function tmpLock(): string {
  const d = mkdtempSync(join(tmpdir(), "graph-lock-test-"));
  dirs.push(d);
  return join(d, "graph.lock");
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * `FileLockOps` fake que modela o `flock(2)`: a trava é por **inode**
 * (`dev:ino`), então dois `fd` para o MESMO arquivo contendem, e `unlock`/close
 * liberam. Permite exercitar o caminho flock sob Node (sem `bun:ffi`).
 */
function fakeLockOps(): FileLockOps & { locked: Set<string> } {
  const locked = new Set<string>();
  const keyOf = (fd: number): string => {
    const st = statSync(`/proc/self/fd/${fd}`);
    return `${st.dev}:${st.ino}`;
  };
  return {
    locked,
    tryLock: (fd) => {
      const k = keyOf(fd);
      if (locked.has(k)) return false;
      locked.add(k);
      return true;
    },
    unlock: (fd) => {
      locked.delete(keyOf(fd));
    },
  };
}

/* --------------------------- fallback O_EXCL ------------------------------ */
// Estes testes pinam `lockOps: null` (fallback `O_EXCL`) para serem
// determinísticos em QUALQUER runtime: sem o pin, sob Bun a auto-detecção
// escolheria o `flock`, que não lê o conteúdo nem remove o arquivo.

test("lock_acquire_release: cria o lockfile com o pid; release remove", async () => {
  const path = tmpLock();
  const lock = await acquireLock({ path, lockOps: null, timeoutMs: 1000, retryMs: 1 });
  assert.ok(lock);
  assert.equal(readLockPid(path), process.pid);
  lock!.release();
  assert.equal(readLockPid(path), null, "release remove o lockfile");
  // release é idempotente.
  assert.doesNotThrow(() => lock!.release());
});

test("lock_empty_path_noop: path vazio ⇒ handle no-op (sem travar)", async () => {
  const lock = await acquireLock({ path: "" });
  assert.ok(lock);
  assert.doesNotThrow(() => lock!.release());
});

test("lock_timeout_gives_up: lock ocupado por processo VIVO ⇒ desiste com null", async () => {
  const path = tmpLock();
  // O pid gravado é o NOSSO (processo vivo) — o lock não pode ser considerado
  // órfão, então o segundo acquire desiste no timeout (o full pode levar
  // minutos; a liveness por pid impede o roubo).
  writeFileSync(path, String(process.pid));
  const t0 = Date.now();
  const lock = await acquireLock({ path, lockOps: null, timeoutMs: 60, retryMs: 10 });
  assert.equal(lock, null, "não deve roubar o lock de um processo vivo");
  assert.ok(Date.now() - t0 < 5000, "desiste dentro do timeout (não espera para sempre)");
});

test("lock_stale_reclaimed: lock com mtime antigo e SEM pid legível ⇒ retomado", async () => {
  const path = tmpLock();
  writeFileSync(path, ""); // sem pid legível ⇒ cai no mtime (fallback)
  // Envelhece o mtime para além do staleMs.
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(path, old, old);

  const lock = await acquireLock({
    path,
    lockOps: null,
    timeoutMs: 1000,
    staleMs: 30_000,
    retryMs: 1,
  });
  assert.ok(lock, "lock stale (sem pid) deve ser reclaimado");
  assert.equal(readLockPid(path), process.pid, "nosso pid agora");
  lock!.release();
});

test("lock_dead_pid_reclaimed: pid morto ⇒ órfão reclamado mesmo com mtime fresco", async () => {
  const path = tmpLock();
  // Pid altíssimo, quase certamente inexistente (a detecção primária é liveness,
  // não mtime — um full vive minutos com o lock "fresco" e não pode ser roubado).
  writeFileSync(path, "2147483646");
  const lock = await acquireLock({ path, lockOps: null, timeoutMs: 1000, retryMs: 1 });
  assert.ok(lock, "pid morto ⇒ órfão, retoma");
  assert.equal(readLockPid(path), process.pid);
  lock!.release();
});

test("lock_release_never_removes_foreign: se outro reclaimou, não apaga o alheio", async () => {
  const path = tmpLock();
  const lock = await acquireLock({ path, lockOps: null, timeoutMs: 1000, retryMs: 1 });
  assert.ok(lock);
  // Outro processo toma o lock (simulado: reescreve o pid).
  writeFileSync(path, "123456");
  lock!.release();
  assert.equal(readLockPid(path), 123456, "não apaga o lock de outro dono");
});

test("lock_creates_parent_dir: diretório pai ausente ⇒ cria e cria o lock", async () => {
  const base = mkdtempSync(join(tmpdir(), "graph-lock-parent-"));
  dirs.push(base);
  const path = join(base, "sub", "graph.lock");
  const lock = await acquireLock({ path, lockOps: null, timeoutMs: 1000, retryMs: 1 });
  assert.ok(lock);
  assert.equal(statSync(path).isFile(), true);
  lock!.release();
});

/* ------------------------- caminho flock (FileLockOps) -------------------- */

test("flock_acquire_release: trava por arquivo; release libera", async () => {
  const path = tmpLock();
  const ops = fakeLockOps();
  const lock = await acquireLock({ path, lockOps: ops, timeoutMs: 1000, retryMs: 1 });
  assert.ok(lock);
  assert.equal(ops.locked.size, 1, "um inode travado");
  lock!.release();
  assert.equal(ops.locked.size, 0, "release libera a trava");
  // Idempotente.
  assert.doesNotThrow(() => lock!.release());
});

test("flock_second_acquire_contends: mesma trava ⇒ segundo desiste no timeout", async () => {
  const path = tmpLock();
  const ops = fakeLockOps();
  const first = await acquireLock({ path, lockOps: ops, timeoutMs: 1000, retryMs: 1 });
  assert.ok(first);
  const second = await acquireLock({ path, lockOps: ops, timeoutMs: 60, retryMs: 10 });
  assert.equal(second, null, "contende a mesma trava ⇒ desiste");
  first!.release();
  // Depois do release, adquire.
  const third = await acquireLock({ path, lockOps: ops, timeoutMs: 1000, retryMs: 1 });
  assert.ok(third, "após release, adquire");
  third!.release();
});

test("flock_file_persists: NÃO remove o lockfile (unlink+flock é corrida)", async () => {
  const path = tmpLock();
  const ops = fakeLockOps();
  const lock = await acquireLock({ path, lockOps: ops, timeoutMs: 1000, retryMs: 1 });
  assert.ok(lock);
  lock!.release();
  // O arquivo permanece como token de mutex; a exclusão é do kernel, não do fs.
  assert.equal(statSync(path).isFile(), true, "arquivo-token permanece");
});

test("flock_death_releases: close do fd libera a trava (kernel na morte)", async () => {
  // Modela o comportamento do SO: a trava some quando o fd é fechado, mesmo sem
  // `unlock` explícito — é o que o kernel faz na morte do processo (SIGKILL).
  const path = tmpLock();
  const ops = fakeLockOps();
  const lock = await acquireLock({ path, lockOps: ops, timeoutMs: 1000, retryMs: 1 });
  assert.ok(lock);
  // Simula "processo morreu": zera o conjunto de travas sem chamar release.
  ops.locked.clear();
  const next = await acquireLock({ path, lockOps: ops, timeoutMs: 60, retryMs: 10 });
  assert.ok(next, "trava liberada pela morte ⇒ próximo adquire sem lock órfão");
  next!.release();
});

/* ------------------------- auto-detecção (sem lockOps) -------------------- */

test("lock_autodetect_acquire_release: sem `lockOps`, adquire e libera", async () => {
  // Sem `lockOps`, o módulo auto-detecta: `flock` sob Bun, `O_EXCL` sob Node.
  // Qualquer que seja o mecanismo, adquirir e liberar deve funcionar.
  const path = tmpLock();
  const lock = await acquireLock({ path, timeoutMs: 1000, retryMs: 1 });
  assert.ok(lock, "auto-detecção deve adquirir a trava");
  assert.doesNotThrow(() => lock!.release());
  // Idempotente.
  assert.doesNotThrow(() => lock!.release());
});

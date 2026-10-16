/**
 * E3a-S6a — `index/lock.ts`: trava cross-process (`O_EXCL`), timeout finito,
 * reclaim de lock órfão. Sem relógio real (`now`/`sleep` injetados); o lockfile
 * usa um diretório temporário real (o `O_EXCL` é o comportamento sob teste).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { acquireLock, readLockPid } from "../src/index/lock.ts";

const dirs: string[] = [];
function tmpLock(): string {
  const d = mkdtempSync(join(tmpdir(), "graph-lock-test-"));
  dirs.push(d);
  return join(d, "graph.lock");
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("lock_acquire_release: cria o lockfile com o pid; release remove", async () => {
  const path = tmpLock();
  const lock = await acquireLock({ path, timeoutMs: 1000, retryMs: 1 });
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
  const lock = await acquireLock({ path, timeoutMs: 60, retryMs: 10 });
  assert.equal(lock, null, "não deve roubar o lock de um processo vivo");
  assert.ok(Date.now() - t0 < 5000, "desiste dentro do timeout (não espera para sempre)");
});

test("lock_stale_reclaimed: lock com mtime antigo e SEM pid legível ⇒ retomado", async () => {
  const path = tmpLock();
  writeFileSync(path, ""); // sem pid legível ⇒ cai no mtime (fallback)
  // Envelhece o mtime para além do staleMs.
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(path, old, old);

  const lock = await acquireLock({ path, timeoutMs: 1000, staleMs: 30_000, retryMs: 1 });
  assert.ok(lock, "lock stale (sem pid) deve ser reclaimado");
  assert.equal(readLockPid(path), process.pid, "nosso pid agora");
  lock!.release();
});

test("lock_dead_pid_reclaimed: pid morto ⇒ órfão reclamado mesmo com mtime fresco", async () => {
  const path = tmpLock();
  // Pid altíssimo, quase certamente inexistente (a detecção primária é liveness,
  // não mtime — um full vive minutos com o lock "fresco" e não pode ser roubado).
  writeFileSync(path, "2147483646");
  const lock = await acquireLock({ path, timeoutMs: 1000, retryMs: 1 });
  assert.ok(lock, "pid morto ⇒ órfão, retoma");
  assert.equal(readLockPid(path), process.pid);
  lock!.release();
});

test("lock_release_never_removes_foreign: se outro reclaimou, não apaga o alheio", async () => {
  const path = tmpLock();
  const lock = await acquireLock({ path, timeoutMs: 1000, retryMs: 1 });
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
  const lock = await acquireLock({ path, timeoutMs: 1000, retryMs: 1 });
  assert.ok(lock);
  assert.equal(statSync(path).isFile(), true);
  lock!.release();
});

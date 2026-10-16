/**
 * `git.ts` — porta de git do delta em runtime (E3a-S6a).
 *
 * Encapsula as consultas ao git que o CLI precisa para decidir o modo
 * (`full`/`incremental`) e os removidos, **sem** acoplar o resto do código ao
 * `child_process`. A execução é injetável (`GitExec`) para os testes unitários
 * usarem um fake — só o teste `cli_lock_serializes_two_procs` spawna processo
 * real.
 *
 * Fatos de ambiente (verificados 2026-10-16): git 2.34.1;
 * `git rev-parse --git-path hooks` devolve caminho **relativo ao worktree**
 * (ex.: `.husky`) — por isso o resolver contra a raiz do repo antes de usar.
 */

import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

/** Resultado cru de uma invocação do git. */
export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Executor injetável: roda `git -C <repoRoot> <args>`. */
export type GitExec = (repoRoot: string, args: string[]) => GitResult;

/** Consultas de git usadas pelo CLI/hooks. Implementável por um fake em teste. */
export interface GitPort {
  /** `true` quando `repoRoot` está dentro de uma árvore de trabalho git. */
  isRepo(repoRoot: string): boolean;
  /** SHA do HEAD atual; `null` fora de um repo ou sem commits. */
  head(repoRoot: string): string | null;
  /**
   * `git merge-base --is-ancestor <ancestor> <descendant>`. Status 0 ⇒ `true`;
   * qualquer outro (1 = não-ancestral, 128 = ref inválida) ⇒ `false` (o
   * chamador cai em `full` — nunca roda incremental com range inválido).
   */
  isAncestor(repoRoot: string, ancestor: string, descendant: string): boolean;
  /**
   * Arquivos removidos no range: deleções (`D`) **e** a origem de renomeações
   * (`R`, via `--no-renames` — um rename é uma remoção do caminho antigo). Sem
   * incluir os renomeados, o nó do caminho antigo vira fantasma (nunca tombstoned).
   */
  deletedFiles(repoRoot: string, from: string, to: string): string[];
  /**
   * Diretório de hooks resolvido por `git rev-parse --git-path hooks`, já
   * resolvido contra `repoRoot` (o comando pode devolver caminho relativo).
   * `null` fora de um repo.
   */
  hooksDir(repoRoot: string): string | null;
}

/** Executor real: `git -C <repoRoot> <args>` via `spawnSync` (sem shell). */
export function spawnGit(repoRoot: string, args: string[]): GitResult {
  const r = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf-8",
    windowsHide: true,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/** Monta a porta de git sobre um executor (default: processo real). */
export function createGitPort(exec: GitExec = spawnGit): GitPort {
  return {
    isRepo(repoRoot: string): boolean {
      const r = exec(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
      return r.status === 0 && r.stdout.trim() === "true";
    },
    head(repoRoot: string): string | null {
      const r = exec(repoRoot, ["rev-parse", "HEAD"]);
      if (r.status !== 0) return null;
      const sha = r.stdout.trim();
      return sha || null;
    },
    isAncestor(repoRoot: string, ancestor: string, descendant: string): boolean {
      if (!ancestor || !descendant) return false;
      const r = exec(repoRoot, [
        "merge-base",
        "--is-ancestor",
        ancestor,
        descendant,
      ]);
      return r.status === 0;
    },
    deletedFiles(repoRoot: string, from: string, to: string): string[] {
      if (!from || !to) return [];
      // `--no-renames`: o git detecta rename como `R` (não `D`); como o grafo não
      // tem aresta de rename, a origem some do caminho antigo ⇒ tratamos como
      // remoção. Sem isso o nó antigo vira fantasma e nunca é tombstoned.
      const r = exec(repoRoot, [
        "diff",
        "--name-only",
        "--no-renames",
        "--diff-filter=D",
        from,
        to,
      ]);
      if (r.status !== 0) return [];
      return r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "");
    },
    hooksDir(repoRoot: string): string | null {
      const r = exec(repoRoot, ["rev-parse", "--git-path", "hooks"]);
      if (r.status !== 0) return null;
      const raw = r.stdout.trim();
      if (!raw) return null;
      // `--git-path` pode devolver caminho relativo ao worktree (ex.: `.husky`).
      return isAbsolute(raw) ? raw : resolve(repoRoot, raw);
    },
  };
}

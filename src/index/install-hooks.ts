/**
 * `install-hooks.ts` — instala os hooks git do delta em runtime (E3a-S6a, §1).
 *
 * Gera scripts em `git rev-parse --git-path hooks` (honra `core.hooksPath` e
 * worktrees, resolvendo o caminho **relativo** contra a raiz do repo). Hooks:
 * `post-commit`, `post-checkout`, `post-merge`, `post-rewrite`.
 *
 * Regras rígidas:
 *   - **Nunca** setar/alterar `core.hooksPath` (é excludente — quebra setup do
 *     usuário).
 *   - **Criar só se ausente.** Se já existe (de outro dono), **não** toca: loga e
 *     segue, preservando o conteúdo.
 *   - O script carrega a **linha-marcadora** `# kilocode-graph` para se
 *     reconhecer; um script nosso já presente é idempotente (não regenera).
 *
 * Execução do script: (a) o **caminho do `node` é embutido absoluto** no momento
 * da geração (não confia no `PATH` do git); (b) o processo é **destacado**
 * (`>/dev/null 2>&1 &` + `disown`) para o git **não** esperar o CLI — sem isso o
 * commit travaria até o fim da indexação.
 *
 * Módulo com I/O de arquivo, mas o `GitPort` e o `writeFile` são injetáveis: os
 * testes unitários rodam sem git nem disco real.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { debug, log } from "../logger.ts";
import { resolveNodeRuntime } from "../runtime.ts";
import type { GitPort } from "./git.ts";

/** Linha-marcadora que identifica um hook escrito por este plugin. */
export const HOOK_MARKER = "# kilocode-graph";

/** Hooks instalados (o git chama cada um em eventos distintos). */
export const HOOK_NAMES = [
  "post-commit",
  "post-checkout",
  "post-merge",
  "post-rewrite",
] as const;

/** Nome de um hook instalável. */
export type HookName = (typeof HOOK_NAMES)[number];

export interface InstallHooksOptions {
  /** Raiz do repo (worktree). */
  repoRoot: string;
  /** Caminho absoluto do `node` a embutir no script (default `process.execPath`). */
  nodeBin?: string;
  /** `true` força o host como Bun (teste); default detecta em runtime. */
  hostIsBun?: boolean;
  /** Caminho absoluto do CLI (`src/cli.ts`) a embutir. */
  cliPath: string;
  /** Porta de git (default `createGitPort()`); injetável em teste. */
  git: GitPort;
  /** IO injetável (teste sem disco). */
  io?: {
    exists?: (p: string) => boolean;
    readFile?: (p: string) => string;
    writeFile?: (p: string, data: string) => void;
    mkdir?: (p: string) => void;
    chmod?: (p: string, mode: number) => void;
  };
}

/** Resultado da instalação (observabilidade/teste). */
export interface InstallHooksResult {
  /** Hooks gravados nesta chamada. */
  installed: HookName[];
  /** Hooks já existentes (nosso, idempotente) — não regravados. */
  skippedOwn: HookName[];
  /** Hooks do usuário (sem o marcador) — **intocados**. */
  skippedForeign: HookName[];
  /** `true` quando não há git / não é repo (no-op). */
  notGit: boolean;
  /** Diretório de hooks resolvido (ou `null`). */
  hooksDir: string | null;
}

/**
 * Escapa um valor para uso como um único argumento POSIX sob `sh` (single-quote,
 * com o idioma `'\''` para aspas embutidas). Sem isso, um caminho com espaço ou
 * aspa (`$`, `` ` ``, `"`) quebraria o script — ou permitiria injeção via nome de
 * diretório. Os caminhos (`nodeBin`/`cliPath`/`workspace`) vêm do ambiente, mas
 * tratá-los como opacos é obrigatório.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Corpo do hook. Recebe o `source` (nome do hook) para a observabilidade da S6c.
 * O `--source` distingue post-commit/post-checkout/etc. no log do CLI.
 *
 * **O `--workspace` é obrigatório**: o CLI exige o repo root explícito (§2) e o
 * argv do git (um hook roda sem argumentos úteis para nós) nunca o fornece —
 * omiti-lo fazia todo hook sair com exit 2 e não sincronizar nada.
 *
 * **Worktree (S6b):** o `--workspace` é resolvido em RUNTIME por
 * `git rev-parse --show-toplevel` (o hook roda com cwd = raiz do worktree atual),
 * com o `workspace` embutido como **fallback** (quando o git não está no PATH do
 * hook). Isso é essencial: um repo com worktrees tem os hooks no diretório
 * **comum** (`.git/hooks`, compartilhado por todos os worktrees —
 * `git rev-parse --git-path hooks` o devolve em qualquer worktree), então um
 * caminho estático indexaria o worktree errado.
 */
export function hookScript(
  nodeBin: string,
  cliPath: string,
  workspace: string,
  source: HookName,
  envPrefix = "",
): string {
  return (
    `#!/bin/sh\n` +
    `${HOOK_MARKER}\n` +
    `# Instalado pelo kilocode-graph-plugin (E3a-S6). Não edite: regenerado no boot.\n` +
    `# Fire-and-forget: destacado para o git NÃO esperar a indexação.\n` +
    `# Workspace = raiz do worktree ATUAL (fallback: o embutido no install).\n` +
    `root=$(git rev-parse --show-toplevel 2>/dev/null)\n` +
    `[ -n "$root" ] || root=${shellQuote(workspace)}\n` +
    `${envPrefix}${shellQuote(nodeBin)} ${shellQuote(cliPath)} --workspace "$root" ` +
    `--mode auto --source ${source} ` +
    `</dev/null >/dev/null 2>&1 &\n` +
    `disown 2>/dev/null || true\n` +
    `exit 0\n`
  );
}

/** `true` quando o conteúdo de um hook é do plugin (tem a linha-marcadora). */
export function isOwnHook(content: string): boolean {
  return content.split("\n").some((l) => l.trim() === HOOK_MARKER);
}

/**
 * Instala os 4 hooks. **Nunca lança**: falha de fs é logada e o resultado marca
 * o hook como não-instalado. Fora de repo git / sem diretório de hooks ⇒ no-op.
 */
export function installHooks(opts: InstallHooksOptions): InstallHooksResult {
  const io = opts.io ?? {};
  const exists = io.exists ?? existsSync;
  const readFile = io.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const writeFile =
    io.writeFile ?? ((p: string, d: string) => writeFileSync(p, d, "utf-8"));
  const mkdir = io.mkdir ?? ((p: string) => void mkdirSync(p, { recursive: true }));
  const chmod = io.chmod ?? ((p: string, mode: number) => chmodSync(p, mode));

  const result: InstallHooksResult = {
    installed: [],
    skippedOwn: [],
    skippedForeign: [],
    notGit: false,
    hooksDir: null,
  };

  if (!opts.git.isRepo(opts.repoRoot)) {
    debug("install-hooks: não é repo git; ignorado");
    result.notGit = true;
    return result;
  }
  const hooksDir = opts.git.hooksDir(opts.repoRoot);
  if (!hooksDir) {
    debug("install-hooks: diretório de hooks não resolvido; ignorado");
    result.notGit = true;
    return result;
  }
  result.hooksDir = hooksDir;

  const runtime = resolveNodeRuntime(
    opts.nodeBin,
    opts.hostIsBun ?? undefined,
  );
  try {
    mkdir(hooksDir);
  } catch {
    // best-effort: a escrita abaixo reporta o erro real.
  }

  for (const name of HOOK_NAMES) {
    const path = join(hooksDir, name);
    const desired = hookScript(
      runtime.bin,
      opts.cliPath,
      opts.repoRoot,
      name,
      runtime.shellEnvPrefix,
    );
    if (exists(path)) {
      let current = "";
      try {
        current = readFile(path);
      } catch {
        // Ilegível: trata como do usuário (não toca) — nunca sobrescrever.
        current = "";
      }
      if (!isOwnHook(current)) {
        result.skippedForeign.push(name);
        log(`install-hooks: ${name} existente (do usuário); preservado`);
        continue;
      }
      // Hook PRÓPRIO: idempotente se o conteúdo casa; REGENERA se diverge. O
      // script embute caminhos absolutos (node/CLI/workspace) — um deles muda
      // (plugin movido/atualizado, node trocado) e o hook antigo apontaria para
      // um caminho morto, falhando em silêncio (o stdout/stderr vão p/ /dev/null).
      if (current === desired) {
        result.skippedOwn.push(name);
        continue;
      }
      log(`install-hooks: ${name} desatualizado (caminhos mudaram); regenerando`);
    }
    try {
      writeFile(path, desired);
      try {
        chmod(path, 0o755);
      } catch {
        // Plataforma sem POSIX: o git ainda invoca via `sh`.
      }
      result.installed.push(name);
    } catch (err) {
      log(
        `install-hooks: falha ao gravar ${name} ` +
          `(${err instanceof Error ? err.message : err})`,
      );
    }
  }
  return result;
}

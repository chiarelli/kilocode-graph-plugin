/**
 * Resolução de diretório e nome lógico do workspace (E1-S1, decisão 4).
 *
 * Reuso de `resolvePluginWorkspace` do antecessor
 * (`openviking-memory.js:27`): `ctx.worktree` > `ctx.directory` > `process.cwd()`,
 * descartando `"/"`.
 *
 * O **nome lógico** precisa casar o charset da borda
 * (`^[a-z0-9][a-z0-9_-]{0,63}$`, sem `--` — `graphiti-daemon config.py:129`).
 * O mesmo diretório ⇒ o mesmo nome (determinístico).
 */

import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

import type { PluginCtx } from "./types.ts";

/** Charset aceito pela borda para o nome lógico do workspace. */
const WORKSPACE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Nomes reservados pela borda (não podem ser usados como workspace). */
const RESERVED_NAMES = new Set(["_iam"]);

const MAX_LEN = 64;

function isUsable(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "" && value !== "/";
}

/**
 * Diretório do workspace do plugin. Prioridade `worktree` > `directory` >
 * `process.cwd()`. Nunca retorna `""` nem `"/"`.
 */
export function resolveWorkspaceDir(ctx: PluginCtx): string {
  const worktree = ctx.worktree?.trim();
  if (isUsable(worktree)) return worktree;
  const directory = ctx.directory?.trim();
  if (isUsable(directory)) return directory;
  return process.cwd();
}

/**
 * Normaliza um candidato bruto ao charset da borda: lowercase, não-`[a-z0-9_-]`
 * vira `-`, colapso de `-`, trim de `-` nas pontas, truncamento a 64.
 * Retorna `""` se o resultado for inválido (ex.: começa com não-alfanumérico).
 */
function sanitize(raw: string): string {
  const collapsed = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  const truncated = collapsed.slice(0, MAX_LEN).replace(/-+$/g, "");
  return WORKSPACE_NAME_RE.test(truncated) ? truncated : "";
}

/** Hash curto e determinístico de um caminho (sha1 hex, 8 chars). */
function shortHash(dir: string): string {
  return createHash("sha1").update(dir).digest("hex").slice(0, 8);
}

/**
 * Nome lógico do workspace derivado do diretório. Vazio ou reservado ⇒ fallback
 * estável `ws-<sha1 curto do caminho>`. O mesmo caminho sempre gera o mesmo nome.
 */
export function workspaceName(dir: string): string {
  const fallback = `ws-${shortHash(dir)}`;
  const base = basename(resolve(dir));
  const sanitized = sanitize(base);
  if (sanitized === "" || RESERVED_NAMES.has(sanitized)) return fallback;
  return sanitized;
}

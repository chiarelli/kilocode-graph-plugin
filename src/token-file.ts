/**
 * Resolução/confinamento do `token_file` ao workspace (extraído de `index.ts`
 * na E3a-S6a para o CLI standalone reutilizar a MESMA regra — §2: "reusa
 * `resolveTokenFile`, não reimplementa regra").
 *
 * Um caminho absoluto só é honrado se estiver contido no `dir`; qualquer caminho
 * que escape (absoluto fora do workspace, ou `../..`) é **recusado** e cai no
 * default do workspace. Sem esse confinamento o provisionamento escreveria
 * (destrutivamente) onde o caminho apontasse.
 */

import { isAbsolute, join, relative } from "node:path";

import { DEFAULTS } from "./config.ts";
import { log } from "./logger.ts";

/**
 * `token_file` resolvido **dentro** do workspace (`daemon.token_file` default
 * `.kilo/graph-key.json`). Vazio cai no default; caminho que escapa é recusado.
 */
export function resolveTokenFile(dir: string, tokenFile: string): string {
  const fallback = join(dir, DEFAULTS.daemon.token_file);
  if (!tokenFile) return fallback;
  const resolved = isAbsolute(tokenFile) ? tokenFile : join(dir, tokenFile);
  if (!isInsideDir(dir, resolved)) {
    log(
      `token_file fora do workspace (${tokenFile}); usando ${DEFAULTS.daemon.token_file}`,
    );
    return fallback;
  }
  return resolved;
}

/** `true` quando `child` está contido em `parent` (ou é o próprio). */
export function isInsideDir(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

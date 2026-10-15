/**
 * Leitura do `kilo.jsonc` para idempotência do registro MCP (E3b-S2).
 *
 * Reuso de `getKiloMcpOverride` do antecessor
 * (`~/.config/kilo/vendor/openviking-memory.js:1748`): se o `kilo.jsonc` do
 * workspace (ou raiz) já define `mcp.<name>`, o plugin **não** registra por
 * cima — o usuário mandou ali, o plugin respeita (FR-602).
 *
 * O Kilo aceita JSONC (comentários), então o parse precisa remover comentários
 * antes do `JSON.parse`. O stripper é um autômato que ignora comentários dentro
 * de strings — é lógica crítica e por isso é uma unidade própria, testável
 * isolada.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Arquivos de config do Kilo procurados, em ordem (o 1º existente vence). */
export const KILO_CONFIG_FILES = [
  ".kilo/kilo.jsonc",
  ".kilo/kilo.json",
  ".kilo/opencode.jsonc",
  "kilo.jsonc",
  "kilo.json",
] as const;

/**
 * Remove vírgula final (*trailing comma*) de arrays/objetos JSONC, preservando o
 * conteúdo dentro de strings. `[1,2,]` → `[1,2]`; `{"a":1,}` → `{"a":1}`.
 * Vírgula final é JSONC válido e comum — sem isto o `JSON.parse` lança e o
 * override do usuário é silenciosamente ignorado (defeito D-3).
 *
 * Deve rodar **depois** de `stripJsoncComments`: um comentário entre a vírgula e
 * o fechamento (`{"a":1, /* c *\/ }`) precisa sumir antes do lookahead.
 */
export function stripTrailingCommas(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      const start = i++;
      while (i < raw.length) {
        if (raw[i] === "\\") {
          i += 2;
          continue;
        }
        if (raw[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      out += raw.slice(start, i);
      continue;
    }
    if (ch === ",") {
      // Se o próximo caractere não-branco é `}` ou `]`, a vírgula é final.
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j] as string)) j++;
      if (raw[j] === "}" || raw[j] === "]") {
        i++;
        continue;
      }
    }
    out += raw[i++];
  }
  return out;
}

/**
 * Remove comentários `//` e `/* *\/` de um JSONC, **preservando** o conteúdo
 * dentro de strings (um `//` dentro de uma URL não é comentário). Não valida o
 * JSON — só entrega texto parseável.
 */
export function stripJsoncComments(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '"') {
      const start = i++;
      while (i < raw.length) {
        if (raw[i] === "\\") {
          i += 2;
          continue;
        }
        if (raw[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      out += raw.slice(start, i);
      continue;
    }
    if (raw[i] === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }
    if (raw[i] === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += raw[i++];
  }
  return out;
}

/**
 * Lê e faz o parse de um `kilo.jsonc` (JSONC: comentários + vírgula final).
 * Devolve `null` se o arquivo não existe ou não parseia — nunca lança.
 */
function parseKiloFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const text = stripTrailingCommas(stripJsoncComments(readFileSync(path, "utf-8")));
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Arquivo inválido: ignora este; sem config ⇒ registra (default).
  }
  return null;
}

/**
 * `true` se **algum** arquivo de config do Kilo definir a chave `mcp.<name>`,
 * com qualquer valor. O usuário desliga o servidor implicitamente escrevendo
 * `"memtier": false` (ou `null`, `[]`) — todos contam como "definido", então o
 * plugin **não** registra por cima (FR-602).
 *
 * Procura em **todos** os arquivos (não só no primeiro existente): um
 * `.kilo/kilo.jsonc` sem `mcp` não pode sombrear um `kilo.jsonc` que o define
 * (defeito D-4). Um arquivo que não parseia é ignorado sem derrubar os demais.
 */
export function isMcpDefinedInKiloConfig(directory: string, name: string): boolean {
  for (const rel of KILO_CONFIG_FILES) {
    const parsed = parseKiloFile(join(directory, rel));
    if (!parsed) continue;
    const mcp = parsed.mcp;
    if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) continue;
    if (Object.prototype.hasOwnProperty.call(mcp, name)) return true;
  }
  return false;
}

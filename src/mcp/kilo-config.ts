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
 * Lê o 1º arquivo de config existente em `directory`. Devolve `null` se nenhum
 * existe ou se todos são inválidos — nunca lança (config quebrada não derruba o
 * plugin).
 */
export function readKiloConfig(directory: string): Record<string, unknown> | null {
  for (const rel of KILO_CONFIG_FILES) {
    const path = join(directory, rel);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(stripJsoncComments(readFileSync(path, "utf-8"))) as unknown;
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Arquivo inválido: tenta o próximo; sem config ⇒ registra (default).
    }
  }
  return null;
}

/**
 * Entrada de `mcp.<name>` no `kilo.jsonc`, se houver. `undefined` ⇒ o plugin é
 * quem registra (registro implícito). Um objeto ⇒ o usuário já definiu: não
 * mexer.
 */
export function getKiloMcpOverride(
  directory: string,
  name: string,
): Record<string, unknown> | undefined {
  const config = readKiloConfig(directory);
  const mcp = config?.mcp;
  if (!mcp || typeof mcp !== "object") return undefined;
  const entry = (mcp as Record<string, unknown>)[name];
  if (!entry || typeof entry !== "object") return undefined;
  return entry as Record<string, unknown>;
}

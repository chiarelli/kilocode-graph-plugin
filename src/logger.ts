/**
 * Logger do plugin — reuso direto do padrão do antecessor
 * (`~/.config/kilo/vendor/openviking-memory.js` src/log.ts).
 *
 * Escreve append-only num arquivo de log em `/tmp` (nunca derruba o plugin se a
 * escrita falhar). **Nunca** logar token: `formatToken` só expõe `SET(len=N)`.
 */

import { appendFileSync } from "node:fs";

const LOG_PATH = "/tmp/kilocode-graph-plugin.log";
const PREFIX = "[graph]";

let debugEnabled = false;

/** Liga/desliga o log verboso (chamado no boot com `config.debug`). */
export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

/** Log incondicional (boot, degradação, erro). */
export function log(msg: string): void {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${PREFIX} ${msg}\n`);
  } catch {
    // Log nunca derruba o plugin.
  }
}

/** Log só quando `debug` está ligado. */
export function debug(msg: string): void {
  if (debugEnabled) log(msg);
}

/**
 * Log de erro com escopo. Não lança — o chamador decide se degrada ou para.
 * Usa `console.error` além do arquivo, para o erro ser visível na UI.
 */
export function logFatal(scope: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const detail = error instanceof Error && error.stack ? `\n${error.stack}` : "";
  const line = `FATAL ${scope}: ${message}${detail}`;
  log(line);
  try {
    console.error(`${PREFIX} ${line}`);
  } catch {
    // console pode não existir em ambientes embarcados.
  }
}

/**
 * Formata um segredo para log **sem vazá-lo** — só o tamanho, como o antecessor.
 * Nunca retorna o valor do token.
 */
export function formatToken(token: string | undefined | null): string {
  if (!token) return "EMPTY";
  return `SET(len=${token.length})`;
}

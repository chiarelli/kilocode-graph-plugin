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

/**
 * Teto do que `logFatal` serializa por linha. Um erro HTTP pode embutir o body
 * inteiro (o memtier ecoa o `input` no detalhe do 422 → vários MB); emitir isso
 * na UI/console trava o editor. Acima do teto, a linha é truncada com um sufixo
 * explícito.
 */
const MAX_LOG_LINE_CHARS = 8_192;

let debugEnabled = false;

/**
 * Sink de log injetável (teste). `null` ⇒ escreve no arquivo (produção). Não é
 * API de produção — existe para os testes afirmarem a **emissão** da linha
 * (L-1/L-3) sem tocar no `/tmp` nem fazer parsing de arquivo.
 */
let testSink: ((line: string) => void) | null = null;

/** Instala (ou remove, com `null`) um sink de teste. Só em teste. */
export function __setLogSink(sink: ((line: string) => void) | null): void {
  testSink = sink;
}

/** Liga/desliga o log verboso (chamado no boot com `config.debug`). */
export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

/** Log incondicional (boot, degradação, erro). */
export function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${PREFIX} ${msg}`;
  if (testSink) {
    try {
      testSink(line);
    } catch {
      // Sink de teste nunca derruba o plugin.
    }
    return;
  }
  try {
    appendFileSync(LOG_PATH, `${line}\n`);
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
 *
 * A linha é **limitada** a `MAX_LOG_LINE_CHARS`: um erro cujo `message`/`stack`
 * carrega um body HTTP inteiro (o caso do 422 com o `input` ecoado) não pode
 * despejar megabytes no console — isso bloqueia a UI do editor.
 */
export function logFatal(scope: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const detail = error instanceof Error && error.stack ? `\n${error.stack}` : "";
  let line = `FATAL ${scope}: ${message}${detail}`;
  if (line.length > MAX_LOG_LINE_CHARS) {
    const omitted = line.length - MAX_LOG_LINE_CHARS;
    line = `${line.slice(0, MAX_LOG_LINE_CHARS)}… [truncated ${omitted} chars]`;
  }
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

/** Campos da linha de boot (o token entra só como tamanho, via `formatToken`). */
export interface BootLineFields {
  workspace: string;
  url: string;
  program: string;
  token: string;
  debug: boolean;
}

/**
 * Monta a linha de boot do log. **Ponto único** onde o token é serializado —
 * sempre por `formatToken` (nunca o valor cru). Pura e testável: prova que o
 * valor do token não aparece no log sem abrir socket.
 */
export function formatBootLine(fields: BootLineFields): string {
  return (
    `boot workspace=${fields.workspace} url=${fields.url} ` +
    `program=${fields.program} token=${formatToken(fields.token)} ` +
    `debug=${fields.debug}`
  );
}


/**
 * Logger do plugin — reuso direto do padrão do antecessor
 * (`~/.config/kilo/vendor/openviking-memory.js` src/log.ts).
 *
 * Escreve append-only num arquivo de log em `/tmp` (nunca derruba o plugin se a
 * escrita falhar). **Nunca** logar token: `formatToken` só expõe `SET(len=N)`.
 */

import { appendFileSync, writeFileSync } from "node:fs";

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
 * Arquivo do **raw** injetado (RAG de memória + código), quando `debug` está
 * ligado. Diferente do `LOG_PATH` (append-only, histórico): este reflete apenas
 * o ÚLTIMO turno observado — cada escrita **trunca** o arquivo, então abrí-lo
 * dá, em tempo real, exatamente o que foi injetado na última passada do
 * `experimental.chat.messages.transform`.
 */
export const INJECT_RAW_PATH = "/tmp/kilocode-graph-plugin-inject.log";

/** Uma seção do dump de injeção (uma família: memória ou código). */
export interface InjectRawSection {
  /** Rótulo humano da seção (ex.: `MEMÓRIA`, `CÓDIGO`). */
  title: string;
  /** Bloco cru, exatamente como anexado ao turno (sentinela incluída). */
  block?: string | null;
  /** Nº de itens injetados (fatos/chunks), quando conhecido. */
  count?: number;
}

/**
 * Grava o raw do que foi injetado no turno (só com `debug` ligado). Sobrescreve
 * (trunca) o arquivo a cada chamada — é um "espelho" do último turno, não um
 * histórico. Nunca lança (NFR-03): falha de escrita não pode afetar o turno.
 */
export function writeInjectRaw(sections: InjectRawSection[]): void {
  if (!debugEnabled) return;
  if (testSink) {
    // Em teste, o sink recebe o dump em vez do arquivo (mesma semântica do log).
    try {
      testSink(formatInjectRaw(sections));
    } catch {
      // Sink de teste nunca derruba o plugin.
    }
    return;
  }
  try {
    writeFileSync(INJECT_RAW_PATH, formatInjectRaw(sections));
  } catch {
    // Escrita do dump nunca derruba o plugin.
  }
}

/** Largura das réguas do dump (só estética — não afeta o conteúdo cru). */
const RULE = "─".repeat(64);

/**
 * Monta o dump legível do que foi injetado: cabeçalho com data/hora e um bloco
 * por família, com título, resumo (`N itens · M chars`) e o **texto cru** logo
 * abaixo (só as quebras de linha de borda são aparadas para o layout).
 * Puro e testável.
 */
export function formatInjectRaw(
  sections: InjectRawSection[],
  now: Date = new Date(),
): string {
  const out: string[] = [
    RULE,
    "  KILOCODE GRAPH · contexto injetado (raw)",
    `  ${now.toISOString()}`,
    RULE,
  ];
  for (const s of sections) {
    const raw = s.block?.replace(/^\n+/, "").replace(/\s+$/, "") ?? "";
    const meta: string[] = [];
    if (typeof s.count === "number") meta.push(`${s.count} ${s.count === 1 ? "item" : "itens"}`);
    meta.push(`${raw.length} chars`);
    out.push("");
    out.push(`▌ ${s.title}  (${meta.join(" · ")})`);
    if (raw) {
      out.push(RULE);
      out.push(raw);
      out.push(RULE);
    } else {
      out.push("  (nada injetado)");
    }
  }
  return `${out.join("\n")}\n`;
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


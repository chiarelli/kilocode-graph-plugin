/**
 * Hook de injeção de memória: `experimental.chat.messages.transform`
 * (E2-S1 tracer; endurecido na E2-S2).
 *
 * Thin por design (decisão 6 da spec): só liga o transform do Kilo ao
 * `MemoryInjector` de `inject/memory.ts`. Reusa a forma dos helpers do
 * antecessor (`lastUserMessageIndex`/`extractUserText`/`appendContextPart`,
 * `openviking-memory.js:388`): o bloco vira um **novo part** no último turno do
 * usuário, sem alterar mensagens anteriores.
 *
 * Degradação (NFR-03) — o hook **nunca lança**:
 *   - `enabled=false` → retorna imediato (default);
 *   - sem turno de usuário / texto vazio → retorna;
 *   - health gate reprovado (degradado/503) → retorna sem injetar, log discreto;
 *   - timeout do recall → aborta, retorna (log `debug`, não é erro do usuário);
 *   - `401`/`403` → log **visível** (`logFatal`), sem retry;
 *   - resposta vazia / nada novo no turno → não injeta (sem bloco vazio).
 *
 * O estado de dedup por turno vive no `MemoryInjector` (uma instância por boot
 * do plugin) — por isso o hook é montado uma vez em `index.ts`.
 */

import { AuthError, InfraError } from "../client.ts";
import { debug, log, logFatal } from "../logger.ts";
import {
  MemoryInjector,
  type RecallClient,
  type RecallConfig,
} from "../inject/memory.ts";

/** Um `Part` do turno, na forma mínima que a injeção consome. */
export interface TransformPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** Uma mensagem do turno (`{ info, parts }`), como o transform do Kilo entrega. */
export interface TransformMessage {
  info: { role?: string; id?: string };
  parts: TransformPart[];
}

/** Dependências do hook, injetáveis para teste (sem rede real). */
export interface InjectRuntime {
  enabled: boolean;
  cfg: RecallConfig;
  client: RecallClient;
}

/** Índice da última mensagem do usuário, ou `-1` se não houver (forma do antecessor). */
export function lastUserMessageIndex(messages: TransformMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.info.role === "user") return i;
  }
  return -1;
}

/** Concatena só os parts `text` (ignora tool/step parts). Forma do antecessor. */
export function extractUserText(parts: TransformPart[]): string {
  return parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join(" ");
}

/**
 * Anexa o bloco de contexto como um **novo part de texto** (não altera os
 * existentes) — mesma forma do `appendContextPart` do antecessor. O bloco já
 * traz a sentinela (`<context graph-memory="true">`) e os separadores, montados
 * por `formatMemoryBlock` (spec §2); aqui só entra o part.
 */
export function appendContextPart(parts: TransformPart[], block: string): void {
  parts.push({ type: "text", text: block });
}

/** Um timeout/abort do recall (`AbortSignal.timeout`) — não é erro do usuário. */
function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/**
 * Classifica a falha do recall para o log correto. Nunca propaga — só decide a
 * visibilidade:
 *   - timeout/abort: esperado, log discreto (`debug`);
 *   - `401`/`403`: erro de configuração, log **visível** (precisa de ação);
 *   - `503`: memtier degradado, log discreto (a rota de dados já degrada);
 *   - o resto: FATAL (erro inesperado, visível).
 */
function logRecallFailure(err: unknown): void {
  if (isAbort(err)) {
    debug(`recall abortado por timeout: ${err instanceof Error ? err.message : err}`);
    return;
  }
  if (err instanceof AuthError) {
    // Token ausente/revogado/sem capability — precisa de ação humana.
    logFatal(`recall auth (${err.status})`, err);
    return;
  }
  if (err instanceof InfraError) {
    log(`recall: memtier indisponível (${err.status}); seguindo sem memória`);
    return;
  }
  logFatal("recall", err);
}

/**
 * Corpo do transform: extrai o texto do último turno do usuário, checa o health
 * gate, chama o injector e injeta o bloco. **Nunca lança** — qualquer falha vira
 * "segue sem memória".
 */
export async function injectMemoryIntoMessages(
  messages: TransformMessage[],
  enabled: boolean,
  injector: MemoryInjector,
): Promise<void> {
  if (!enabled) return;

  const lastUserIdx = lastUserMessageIndex(messages);
  if (lastUserIdx === -1) return;

  const parts = messages[lastUserIdx]?.parts;
  if (!parts) return;

  const text = extractUserText(parts);
  if (!text.trim()) return;

  // Identidade do turno: o `id` da UserMessage (estável, único por turno). O
  // TEXTO não serve — duas mensagens diferentes com o mesmo texto colapsariam
  // no mesmo turno e a segunda ficaria sem memória. Fallback pelo índice da
  // última mensagem quando o host não fornecer `id` (transform degradado).
  const turnoId = messages[lastUserIdx]?.info.id ?? `idx:${lastUserIdx}`;

  // Health gate (opcional): degradado/503 ⇒ segue sem memória, sem recall.
  if (!(await injector.ready())) {
    log("recall: health gate reprovado; seguindo sem memória");
    return;
  }

  let injection: { block: string } | null;
  try {
    injection = await injector.inject(turnoId, text);
  } catch (err) {
    logRecallFailure(err);
    return;
  }
  if (!injection) return;

  debug("messages.transform: injetando contexto de memória");
  appendContextPart(parts, injection.block);
}

/**
 * Registra o hook no formato do Kilo (`{ "hook.name": fn }`). Monta o
 * `MemoryInjector` (estado de dedup por turno) uma única vez — o hook é
 * registrado no boot e reutilizado em todos os turnos.
 */
export function messagesHook(rt: InjectRuntime) {
  const injector = new MemoryInjector(rt.client, rt.cfg);
  return {
    "experimental.chat.messages.transform": async (
      _input: Record<string, unknown>,
      output: { messages: TransformMessage[] },
    ): Promise<void> => {
      await injectMemoryIntoMessages(output.messages, rt.enabled, injector);
    },
  };
}

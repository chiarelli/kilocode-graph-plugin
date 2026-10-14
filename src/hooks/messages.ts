/**
 * Hook de injeção de memória: `experimental.chat.messages.transform` (E2-S1).
 *
 * Thin por design (decisão 6 da spec): só liga o transform do Kilo ao
 * `recallAndFormat` de `inject/memory.ts`. Reusa a forma dos helpers do
 * antecessor (`lastUserMessageIndex`/`extractUserText`/`appendContextPart`,
 * `openviking-memory.js:388`): o bloco vira um **novo part** no último turno do
 * usuário, sem alterar mensagens anteriores.
 *
 * Degradação (NFR-03): o hook **nunca lança** — `enabled=false`, sem turno de
 * usuário, texto vazio, recall vazio ou falha de recall ⇒ retorna sem injetar.
 * O log de erro é visível (`logFatal`) quando o recall falha.
 *
 * Endurecer (E2-S2): dedup por turno, `maxChars`/`max_tokens`, health gate e
 * classificação de erro (401/403 visível, timeout silencioso).
 */

import { logFatal } from "../logger.ts";
import { recallAndFormat, type RecallClient, type RecallConfig } from "../inject/memory.ts";

/** Um `Part` do turno, na forma mínima que a injeção consome. */
export interface TransformPart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** Uma mensagem do turno (`{ info, parts }`), como o transform do Kilo entrega. */
export interface TransformMessage {
  info: { role?: string };
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

/**
 * Corpo do transform: extrai o texto do último turno do usuário, chama o recall
 * e injeta o bloco. **Nunca lança** — qualquer falha vira "segue sem memória".
 */
export async function injectMemoryIntoMessages(
  messages: TransformMessage[],
  rt: InjectRuntime,
): Promise<void> {
  if (!rt.enabled) return;

  const lastUserIdx = lastUserMessageIndex(messages);
  if (lastUserIdx === -1) return;

  const parts = messages[lastUserIdx]?.parts;
  if (!parts) return;

  const text = extractUserText(parts);
  if (!text.trim()) return;

  let block: string | null;
  try {
    block = await recallAndFormat(rt.client, rt.cfg, text);
  } catch (err) {
    // TODO(tracer-bullet): classificar o erro (401/403 visível, timeout
    // silencioso, health gate) — E2-S2. Aqui todo erro vira um FATAL.
    // Recall falhou (rede/timeout/HTTP). O turno segue sem memória (NFR-03).
    logFatal("recall", err);
    return;
  }
  if (!block) return;

  appendContextPart(parts, block);
}

/** Registra o hook no formato do Kilo (`{ "hook.name": fn }`). */
export function messagesHook(rt: InjectRuntime) {
  return {
    "experimental.chat.messages.transform": async (
      _input: Record<string, unknown>,
      output: { messages: TransformMessage[] },
    ): Promise<void> => {
      await injectMemoryIntoMessages(output.messages, rt);
    },
  };
}

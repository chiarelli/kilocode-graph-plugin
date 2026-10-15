/**
 * `ingest/batch.ts` — montagem do lote que vai para `/v1/ingest` (E4-S1).
 *
 * Um lote é `{ role, content }[]` lido do banco. Daqui saem:
 *   - `renderBody` — o texto do episódio (o memtier ingere **uma** string);
 *   - `batchHash` — djb2 sobre `role\0content` (prova de idempotência, ADR-008);
 *   - `latestReferenceTime` — a data da mensagem **mais atual** do lote
 *     (decisão do dono; a fila atrasa e a data do envio quebraria a supersessão).
 *
 * Puro (sem I/O): tudo testável isoladamente.
 */

import type { IngestMessage } from "./db.ts";

/** Separador interno do hash (o mesmo do antecessor: `role\0content`). */
export const HASH_SEP = "\u0000";

/** Lote pronto para envio. */
export interface Batch {
  body: string;
  hash: string;
  /** ISO-8601 da mensagem mais atual do lote. */
  referenceTime: string;
}

/**
 * Hash determinístico do lote (djb2 sobre `role\0content`, `openviking-memory.js:1195`).
 * Devolve a representação decimal do inteiro **sem sinal** (uint32) — estável
 * entre execuções e independente do backend SQLite.
 */
export function batchHash(messages: IngestMessage[]): string {
  const combined = messages.map((m) => `${m.role}${HASH_SEP}${m.content}`).join(HASH_SEP);
  let hash = 5381;
  for (let i = 0; i < combined.length; i++) {
    hash = ((hash << 5) + hash + combined.charCodeAt(i)) | 0;
  }
  return String(hash >>> 0);
}

/**
 * Texto do episódio: cada mensagem vira `role: content`, separadas por linha em
 * branco. O `role` dá contexto ao extrator do memtier (a conversa tem dois lados).
 */
export function renderBody(messages: IngestMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
}

/**
 * Timestamp de referência = **mensagem mais atual** do lote (ISO-8601). Lote
 * vazio lança — o chamador nunca deve montar um lote vazio (`body` tem
 * `min_length=1` no memtier).
 */
export function latestReferenceTime(messages: IngestMessage[]): string {
  let max = Number.NEGATIVE_INFINITY;
  for (const m of messages) {
    if (Number.isFinite(m.time_created) && m.time_created > max) max = m.time_created;
  }
  if (max === Number.NEGATIVE_INFINITY) {
    throw new Error("lote sem time_created válido");
  }
  return new Date(max).toISOString();
}

/** Monta o lote a partir das mensagens já lidas. */
export function buildBatch(messages: IngestMessage[]): Batch {
  return {
    body: renderBody(messages),
    hash: batchHash(messages),
    referenceTime: latestReferenceTime(messages),
  };
}

/**
 * Limiar do gatilho `message.updated`: só envia quando o banco tem lote **cheio**
 * (`rows >= batchSize`). Abaixo do limiar, nada é enviado — o resto é drenado no
 * `session.idle` (E4-S3). `rows` é o nº de LINHAS lidas, não de mensagens com
 * texto (senão uma janela de mensagens sem texto travaria o gatilho).
 *
 * TODO(tracer-bullet): o `batch_size` do dono é "**20 mensagens**", mas medido no
 * banco real uma janela de 20 LINHAS traz só ~2 com texto (assistant:user ≈ 18:1,
 * 7.998/16.728 com `text`) ⇒ o lote enviado sai bem menor que 20. Decidir se o
 * limiar conta linhas (avança) ou mensagens com texto (acumula até 20) é o
 * endurecimento da E4-S2 — o `readBatch` da S2 precisa ler adiante.
 */
export function shouldSend(rows: number, batchSize: number): boolean {
  return batchSize > 0 && rows >= batchSize;
}

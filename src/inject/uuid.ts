/**
 * Identidade no bloco injetado (E8-S1) — validação de uuid.
 *
 * O memtier v1.1.0 emite uuids canônicos (`8-4-4-4-12`, minúsculo). As tools MCP
 * exigem o uuid **exato**: um id truncado devolve `[]` em silêncio, sem erro
 * visível. Por isso o bloco valida a FORMA antes de escrever o marcador — não
 * sanitiza (o formato não admite `<`, `>`, espaço nem quebra de linha).
 *
 * Módulo próprio (sem dependência de `client.ts`) para os DOIS injetores
 * importarem a MESMA regra: memória (`[id=]`/`[ep=]`) e código (`[id=]`).
 */

/**
 * `8-4-4-4-12` minúsculo. O memtier emite assim (uuid5/uuid4 canônicos).
 *
 * Maiúsculas são rejeitadas de propósito: nenhuma rota do memtier as emite e
 * afrouxar a regra só aumenta a chance de passar um id que a tool rejeita.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `true` quando `value` é um uuid na forma canônica. Qualquer outra coisa
 * (`null`, `undefined`, `""`, 35 chars, sem hífens, maiúsculo) ⇒ `false`.
 */
export function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_SHAPE.test(value);
}

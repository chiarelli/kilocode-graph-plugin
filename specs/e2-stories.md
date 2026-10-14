# E2 — Injeção de memória: plano de stories (decomposição, não implementação)

**Data:** 2026-10-14

**Fonte:** `BACKLOG.md § E2` · `docs/ARCHITECTURE.md` §1 (fluxo), §2 (`/v1/recall`),
§3 (`inject/`), §4 (fluxo do turno), §5 (formato do contexto), §6 (config), §8
(degração) · `docs/PRD.md` FR-101/103/104/105/106/107, NFR-01/02/03 · `docs/adr/001`
(hooks), `004` (orçamento de injeção), `006` (push vs pull) · `src/README.md`
(`inject/memory.ts`, `inject/budget.ts`) · antecessor
`~/.config/kilo/vendor/openviking-memory.js` (`experimental.chat.messages.transform`,
`appendContextPart`, `lastUserMessageIndex`, `extractUserText`, `prefetch`) ·
memtier `src/memtier/main.py` (`RecallBody`, `execute_recall`, envelope A1).

**Protocolo:** tracer bullet — E2-S1 é a fatia vertical mínima: um `recall` real
vira bloco injetado no último turno do usuário. S2/S3 **endurecem a mesma base,
sem rewrite**; gaps mínimos marcados com `TODO(tracer-bullet):`. Fecha quando
`rg "TODO\(tracer-bullet\)" src/` = 0.

**Ordem de execução:** E2-S1 → E2-S2 → E2-S3.

**Depende de:** E1 (client, config, workspace, logger).

**Ambiente de dev:** `bun run typecheck` · `node --test "tests/**/*.test.ts"` · E2E gated
`E2E=1` com o memtier de pé.

---

## Decisões de design fixadas nesta decomposição

### 1. Hook de injeção: `experimental.chat.messages.transform` (do antecessor)

Padrão do antecessor (`openviking-memory.js:2051`):

```ts
"experimental.chat.messages.transform": async (_input, output) => {
  if (!config.inject.enabled) return;
  const messages = output.messages;
  const lastUserIdx = lastUserMessageIndex(messages);
  if (lastUserIdx === -1) return;
  const parts = messages[lastUserIdx].parts;
  const text = extractUserText(parts);        // só parts type:"text"
  if (!text.trim()) return;
  const context = await recallAndFormat(text); // E2
  if (!context) return;
  appendContextPart(parts, context);          // push de um part {type:"text", text}
}
```

- **Reuso literal** de `lastUserMessageIndex`, `extractUserText`, `appendContextPart`
  (formas do antecessor). Não reinventar o formato do part injetado.
- O bloco injetado vai como **novo part** no último turno do usuário — não altera
  mensagens anteriores (FR-104: não reinjeta no mesmo turno, pois o transform roda
  uma vez por turno).

### 2. Formato do bloco injetado (procedência — FR-105)

Segue o ARCH §5, com sentinela próprio (não `ov-memory`, para não colidir com o
plugin antecessor se ambos estiverem ativos):

```
<context graph-memory="true">
[CONTEXTO DE MEMÓRIA]
- <fact 1> (válido desde <valid_at>)
- <fact 2>

</context>
```

- **Bloco de código** (E3c) usará sentinela irmão (`graph-code`), com cabeçalho
  próprio — a E2 injeta **só memória**.
- Um fato sem `valid_at` não mostra a data. `invalid_at` não aparece (o recall só
  devolve vigentes, salvo `include_invalid` — que a E2 **não** usa).

### 3. Orçamento: `maxMemories` / `maxChars` / `timeout_ms` + `max_tokens` (A1)

`budget.ts` aplica **duas camadas** de corte, nesta ordem:

1. **Servidor (A1):** o request manda `max_tokens` (estimativa `chars/4`). O
   servidor corta por **fato inteiro** e devolve `{tokens_estimated, truncated}`.
2. **Cliente:** `maxMemories` (nº de fatos) e `maxChars` (teto de chars do bloco
   final). Se o bloco passar de `maxChars`, corta fatos **inteiros** do fim (nunca
   um fato pela metade) — mesma filosofia do A1.

- `limit` do request = `maxMemories` (o servidor já limita; o cliente reafirma).
- `timeout_ms` governa o `AbortSignal` da chamada — **não** o orçamento de 4s do
  hook como um todo (esse é o teto; `timeout_ms` é o teto da chamada de recall).
- Config: `max_memories` (default 5), `max_chars` (default **3000**, env
  `KILOCODE_GRAPH_INJECT_MAX_CHARS`) e `max_tokens` (default 2000) já são
  **declarados pela E1** (tabela de chaves, decisão 2); a E2 apenas os **lê**.
  Não há churn de config entre epics (decisão do dono, 2026-10-14).

> Defaults conservadores (ADR-004): 5 fatos / 3000 chars / 2000 tokens. O
> antecessor usava `recallMaxChars=3000` — coerente.

### 4. Client: adicionar `recall` (a epic dona estende o client da E1)

```ts
interface RecallOpts { limit?: number; maxTokens?: number; signal?: AbortSignal }
interface Fact { fact: string; valid_at: string | null; invalid_at: string | null;
                 score: number; source?: string }
interface RecallResult { facts: Fact[]; tokensEstimated?: number; truncated?: boolean }

// em MemtierClient:
recall(query: string, opts?: RecallOpts): Promise<RecallResult>
```

Body (`main.py:1065`): `{ workspace, program, query, limit, max_tokens }`.
Resposta 200: `{ facts: [...] }` (+ `tokens_estimated`/`truncated` quando
`max_tokens` foi enviado).

- `query` é o texto do usuário — **sem `max_length`** (o servidor trunca; o hook
  nunca deve falhar por tamanho).
- `include_invalid` **não** é usado (E2 injeta só o vigente).

### 5. Degradação (NFR-03) — nunca quebra o turno

> A `FR-305` citada no BACKLOG pendência #3 é requisito do **memtier**, não
> deste PRD. O requisito local de degradação é **NFR-03** (obrigação de
> comportamento) sobre a `FR-305 do daemon` (fonte). Corrigido aqui (epic dona).

| Situação | Comportamento |
|---|---|
| `inject.enabled=false` | hook retorna imediato (default) |
| health degradado / 503 | hook retorna sem injetar; log discreto |
| recall estoura `timeout_ms` | aborta; hook retorna sem injetar |
| 401/403 | log de erro visível (não silencioso); sem retry |
| resposta vazia | não injeta (sem bloco vazio) |

O hook **nunca lança** — qualquer erro vira "segue sem memória".

### 6. Módulos

```
src/inject/
├── memory.ts    # recallAndFormat(client, cfg, query): Promise<string | null>
│                #  - chama client.recall, formata o bloco, aplica budget
└── budget.ts    # applyBudget(facts, cfg): Fact[]  (corte por fato inteiro)
src/hooks/
└── messages.ts  # registra o hook messages.transform (thin: orquestra memory.ts)
```

- `memory.ts` e `budget.ts` são **puros/testáveis** (recebem client e cfg).
- `hooks/messages.ts` é thin: só liga o hook às funções.

---

## E2-S1 — Tracer bullet: injetar memória de 1 recall real

**Objetivo:** a fatia vertical mínima — texto do usuário → `recall` → bloco
injetado no último turno.

**Entregável:**
- `client.ts`: `recall()`.
- `inject/memory.ts`: `recallAndFormat` (formatar bloco, sem budget ainda).
- `inject/budget.ts`: `applyBudget` minimal (só `maxMemories`).
- `hooks/messages.ts`: registra `experimental.chat.messages.transform`; reusa
  `lastUserMessageIndex`/`extractUserText`/`appendContextPart`.
- `index.ts`: registra o hook no boot.

**Minimal (`TODO(tracer-bullet)`):** `maxChars`/`max_tokens`; dedup; degradação
detalhada; health gate.

**Testes (unit):**

| Teste | Caso | Esperado |
|---|---|---|
| `recall_body_shape` | `recall("q", {limit:5,maxTokens:2000})` | body tem `workspace/program/query/limit/max_tokens` |
| `recall_parses_facts` | 200 com 2 fatos | `facts.length==2` |
| `recall_401_typed` | 401 | erro tipado (não cru) |
| `format_block_provenance` | 2 fatos | bloco com sentinela `graph-memory` e cabeçalho |
| `format_block_empty` | 0 fatos | retorna `null` (não injeta) |
| `apply_budget_maxmemories` | 8 fatos, max 5 | 5 fatos |
| `transform_injects` | messages com 1 user | part novo adicionado ao último user |
| `transform_disabled` | `inject.enabled=false` | nenhum part adicionado |
| `transform_no_user` | só assistant | não injeta |
| `transform_recall_fails` | recall lança | hook não lança; sem part |

**Critérios de aceite:** typecheck limpo; testes verdes; com `inject.enabled=true`
o bloco aparece no turno.

---

## E2-S2 — Endurecer: orçamento, `max_tokens`, dedup, degradação

**Objetivo:** sobre o **mesmo código**, completar o orçamento e a robustez.

**Entregável:**
- `budget.ts`: `maxChars` (corte por fato inteiro), `max_tokens` no request.
- `memory.ts`: respeita `tokens_estimated`/`truncated` (log quando truncado);
  dedup por sessão (não reinjeta os mesmos fatos no mesmo turno).
- Degradação completa: health gate opcional, 401/403 com log visível.

**Testes (unit) — adicionais:**

| Teste | Caso | Esperado |
|---|---|---|
| `budget_maxchars_whole_facts` | 5 fatos longos, max 100 chars | corta fatos inteiros, ≤100 |
| `budget_sends_max_tokens` | config | request tem `max_tokens` |
| `budget_respects_truncated` | resposta `truncated:true` | log; bloco usa o que veio |
| `dedup_same_turn` | transform 2× mesmo turno | injeta 1× |
| `auth_error_logged` | 401 | log visível (não silencioso) |
| `timeout_no_inject` | recall pendura | aborta; sem injeção; turno segue |

**Critérios de aceite:** testes de S1 verdes; novos verdes; bloco nunca excede
`maxChars`; nenhum turno quebra por falha de recall.

---

## E2-S3 — Fechamento da epic

**Objetivo:** E2E real + zero marcadores.

**Entregável:**
- `tests/e2e/test_e2e_recall_inject.test.ts` (**novo**, gated `E2E=1`; sufixo
  `.test.ts` para casar o glob da spec — mesma convenção do E1-S3): com o memtier
  de pé e um workspace com fatos, o plugin injeta ≥1 fato no turno.
- Log de observabilidade do turno (base do E7): `{recall_ms, facts, injected_chars}`.
- Remover todos os `TODO(tracer-bullet)`.

**Critérios de aceite:**
1. typecheck limpo; unit verde; `E2E=1` verde.
2. `rg "TODO\(tracer-bullet\)" src/` → zero.
3. Latência medida ≤4s (NFR-01), mediana próxima de 0,85s (NFR-02).

**Comandos:**
```bash
bun run typecheck && node --test "tests/**/*.test.ts"
E2E=1 node --test "tests/e2e/**/*.test.ts"
```

---

## Fora de escopo da E2

- Injeção de código (E3c) — o bloco de código é a epic irmã.
- Ingestão/enfileiramento (E4).
- `as_of` / point-in-time (o hook injeta o vigente; `as_of` é uso do modelo via MCP).
- Curadoria/supersessão (é do memtier).

## Histórico de revisão

- **2026-10-14** — criada a partir do PRD/ARCH v0.2 e do BACKLOG § E2.

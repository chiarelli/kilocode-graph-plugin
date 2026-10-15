# E3c — Injeção de código: plano de stories (decomposição, não implementação)

**Data:** 2026-10-15

**Fonte:** `BACKLOG.md § E3c` · `docs/ARCHITECTURE.md` §2 (contrato `/v1/code/search`),
§4 (fluxo do turno), §5 (blocos distintos), §6 (config) · `docs/PRD.md`
FR-102/105/106/107 · `docs/adr/004` (orçamento; código tem prioridade sobre
memória) · `specs/e2-stories.md` (o hook, o orçamento e o dedup que a E3c
estende) · memtier `src/memtier/main.py` (`CodeSearchBody`, L899) e
`src/memtier/code.py` (limites, L131-133).

**Protocolo:** tracer bullet — E3c-S1 é a fatia vertical mínima:
`code_search` real → bloco de código injetado como part **separado** no último
turno do usuário. S2/S3 endurecem a mesma base, sem rewrite; gaps mínimos
marcados `TODO(tracer-bullet):`. Fecha quando
`rg "TODO\(tracer-bullet\)" src/` = 0 **e** os critérios de aceite do BACKLOG
estão marcados.

**Ordem de execução:** E3c-S1 → E3c-S2 → E3c-S3 (cadeia linear).

**Depende de:** E1 (config/logger/cliente) · **E2** (o hook `messages.transform`
e o `MemoryInjector` — a E3c injeta no MESMO ponto, não cria um segundo hook) ·
E3a (sem coletor não há código indexado; FR-102 declara essa dependência).

**Ambiente de dev:** `bun run typecheck` · `npm test`
(`node --test "tests/**/*.test.ts"`) · E2E gated: `E2E=1` com **dois tokens**
(`E2E_TOKEN`, `E2E_CODE_TOKEN`) e a stack do memtier de pé em `127.0.0.1:8400`.

---

## Decisões de design fixadas nesta decomposição

Estas decisões são **contrato das stories**; mudá-las exige registrar o porquê no
commit.

### 1. Mesmo hook, part separado (não um segundo `transform`)

A E2 já ocupa `experimental.chat.messages.transform`. A E3c **não** cria um
segundo hook: o bloco de código é **outro part** no mesmo turno.

- `src/inject/code.ts` (novo) monta o bloco; `hooks/messages.ts` chama os dois
  injetores e anexa dois parts.
- FR-105: blocos **visualmente distintos**. Sentinela própria por bloco:
  - memória: `<context graph-memory="true">` (já existe; **não mudar**);
  - código: `<context graph-code="true">`.
- Cabeçalho do bloco de código com procedência por chunk (`ARCHITECTURE.md` §5):
  `[CÓDIGO RELEVANTE — internal/billing/store.go:42-55]`.

### 2. Recall e `code/search` em PARALELO — é o que preserva o orçamento

O teto do hook é **4s** (`inject.timeout_ms`). Rodar recall e busca em **série**
soma as latências (0,85s + busca) e corre o risco de estourar. Decisão:

- as duas chamadas partem **em paralelo**, cada uma com seu `AbortSignal`;
- `inject.timeout_ms` vale para **cada** chamada (não para a soma);
- o teto de 4s do hook é garantido pelo paralelismo, não por soma de timeouts;
- usar `Promise.allSettled`: a falha de uma **não** cancela a outra.

> Sem isso, o orçamento do ADR-004 vira ficção: quem somar as duas latências
> vai ver o turno passar de 4s em máquina carregada.

### 3. `maxChars` é o teto do TOTAL; código tem prioridade no corte

`ARCHITECTURE.md` §6 lista `maxChars` uma vez, para os dois blocos. E a ADR-004
já fixou a ordem do corte: **código tem prioridade sobre memória** (código
truncado não compila — é o mesmo motivo do corte por chunk inteiro no servidor).

Ordem do orçamento:
1. `maxMemories` fatos e `maxCodeChunks` chunks (cortes independentes);
2. se o **total** (memória + código) passa de `maxChars`, corta **fatos inteiros
   de memória** primeiro, do fim para o começo;
3. só se ainda estourar, corta **chunks inteiros** de código (do fim).

Um chunk nunca é cortado pela metade (a mesma regra do servidor: `code` truncado
não compila).

### 4. Sanitização do bloco de código (a lição do D-3 da revisão do E2)

O `code` vem do **repositório** — é conteúdo externo, como o `fact` da memória.
Um arquivo contendo `</context>` fecha a sentinela e injeta texto fora do
envelope. A E2 já corrigiu isso para a memória (`sanitizeFactText`); a E3c
**tem de fazer o mesmo**.

Diferença crítica: **código tem quebras de linha e elas são o conteúdo**. Não se
pode achatá-las como no fato. Decisão:

- neutralizar `<`/`>` do `code` e do `path` (`&lt;`/`&gt;`);
- **preservar** as quebras de linha e a indentação;
- o wrapper (`<context graph-code="true">` … `</context>`) é nosso e fica
  intacto: depois da neutralização, nenhuma tag pode ser aberta ou fechada pelo
  conteúdo vindo do repo.

### 5. Config: a E3c adiciona o que não existia (exceção consciente)

A convenção do BACKLOG é o E1 declarar todas as chaves para não haver churn entre
epics. O E3c **não estava specado** quando o E1 fechou (a segunda onda era "spec
sob demanda"), então duas chaves ficam para a epic dona:

| Chave config | Env var | Default | Uso |
|---|---|---|---|
| `inject.code_enabled` | `KILOCODE_GRAPH_INJECT_CODE_ENABLED` | `false` | desligado por padrão |
| `inject.max_code_chunks` | `KILOCODE_GRAPH_INJECT_MAX_CODE_CHUNKS` | `3` | nº de chunks |

O E3c **lê** (não redeclara) `inject.enabled`, `inject.timeout_ms`,
`inject.max_chars` e `daemon.*`. Registrar a exceção no histórico do BACKLOG no
fechamento — o E1 já fechou e as duas chaves novas são justificadas.

### 6. Dedup: estende o do E2 (mesmo turno, agora com duas famílias)

O E2 fixou: identidade do turno = `id` da `UserMessage`; **um bloco por turno**
(FR-104). A E3c estende, sem reimplementar:

- o **mesmo** `turnoId` governa as duas famílias;
- identidade do chunk = `path:start_line-end_line` (o `/v1/code/search` devolve
  `score`/`match`/`symbol`, não `chunk_md5`);
- um turno injeta **no máximo um bloco de cada família** (um de memória, um de
  código) — rodar o `transform` 2× no mesmo turno não acumula.

### 7. Sem reordenação no cliente

O `/v1/code/search` já devolve na ordem de relevância (o memtier usa RRF para
mesclar as pernas vetorial e fulltext). O plugin **não** reordena nem re-pontua:
pega os `maxCodeChunks` primeiros. Reordenar aqui duplicaria a lógica do servidor
e divergiria dela.

### 8. Rota é read-only e o servidor tem tetos próprios

Do contrato real (`src/memtier/main.py`, `code.py`):
`limit` ≤ `MAX_SEARCH_LIMIT` (**50**); `query` ≤ `MAX_QUERY_LENGTH` (**512**);
`labels` ≤ 16 e **lista vazia é 422** (`min_length=1` — omitir é a forma de pedir
o default); `max_tokens` acima do teto interno → **422**. O cliente nunca manda
`labels: []` e nunca passa de 50 no `limit`.

---

## Stories

### E3c-S1 — Tracer bullet: `code_search` → bloco de código no turno

**Entrega:** `src/inject/code.ts` (`formatCodeBlock`, sanitização, corte por
chunk inteiro) + o `code_search` no cliente + a fiação em `hooks/messages.ts`
(segundo part) e `config.ts` (`code_enabled`, `max_code_chunks`).

**Fatia vertical:** 1 busca real contra o memtier → 1 chunk → 1 bloco injetado
como **part novo**, ao lado do bloco de memória.

**Testes (mesma tabela da E2: happy + unhappy por módulo público):**

| Teste | Cenário | Esperado |
|---|---|---|
| `code_block_provenance` | 1 chunk | cabeçalho `[CÓDIGO RELEVANTE — path:inicio-fim]` + sentinela `graph-code="true"` |
| `code_block_empty` | 0 chunks | `null` — nunca injeta bloco vazio |
| `code_block_sanitized` | `code` com `</context>` | sentinela abre 1× e fecha 1×; conteúdo neutralizado |
| `code_block_keeps_newlines` | `code` multilinha | quebras e indentação **preservadas** |
| `code_search_body_shape` | 1 busca | body tem `workspace`/`program`/`query`/`limit`; **sem** `labels: []` |
| `code_search_401_typed` | 401 | erro tipado (`AuthError`), nunca cru |
| `code_search_timeout` | pendura | aborta no timeout; turno segue |
| `two_blocks_distinct` | recall + busca | **2 parts** no turno, sentinelas diferentes, memória antes de código |

### E3c-S2 — Endurecer: paralelismo, orçamento do total e dedup

**Entrega:** `Promise.allSettled` das duas chamadas; o orçamento do total
(decisão 3); o dedup por `turnoId` estendido ao chunk (decisão 6); degradação
parcial (só um dos blocos).

**Testes:**

| Teste | Cenário | Esperado |
|---|---|---|
| `parallel_not_serial` | recall 200ms + busca 200ms | turno termina < ~400ms (não a soma sequencial) |
| `partial_failure_memory_only` | busca 503 | bloco de memória sai; sem bloco de código; sem lançar |
| `partial_failure_code_only` | recall 503 | bloco de código sai; sem bloco de memória |
| `budget_total_chars` | total > `maxChars` | corta fatos de memória **antes** de qualquer chunk |
| `budget_code_priority` | ainda acima após cortar memória | só então corta chunks, do fim |
| `chunk_never_half` | 1 chunk maior que o teto restante | chunk descartado inteiro, nunca pela metade |
| `dedup_same_turn_code` | `transform` 2× no mesmo turno | injeta **1** bloco de código |
| `dedup_chunk_identity` | mesmo chunk em 2 buscas | não repete o chunk |
| `dedup_new_turn_code` | turno novo | injeta de novo |

### E3c-S3 — Fechamento: E2E real, docs, zero marcadores

**Entrega:** E2E contra a stack real; `docs/ARCHITECTURE.md` (§5 com o bloco de
código real, §6 com as duas chaves novas) e `src/README.md` alinhados;
`BACKLOG.md` com os checkboxes e o histórico; zero `TODO(tracer-bullet)`.

**E2E (exige o coletor já ter populado o grafo — E3a):** indexar um arquivo de
teste com um símbolo de nome único → esperar o sync → `code_search` por esse
símbolo → bloco de código aparece no turno com o caminho real. O E2E **não** pode
passar por acidente: sem `E2E_CODE_TOKEN` (token do workspace de código) o teste
tem de falhar, não pular silenciosamente.

---

## Critérios de aceite (do BACKLOG — só o dono marca)

- [ ] **E3c-S1** — Tracer bullet: `code_search` → bloco de código no `messages.transform`
- [ ] **E3c-S2** — Endurecer: paralelismo com o recall, orçamento do total, dedup do chunk
- [ ] **E3c-S3** — Fechamento: E2E real contra o memtier, docs, zero marcadores

**Fora de escopo:** navegação por código vizinho (`/v1/code/neighbors` — bloqueada
até o memtier expor a tool MCP); watch mode (o indexer não tem); ingestão (E4);
injeção de código via MCP (isso é pull, já coberto pela E3b).

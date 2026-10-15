# Injeção — limites por endpoint (tokens) e piso de confiança da memória: plano de stories

**Data:** 2026-10-15

**Fonte:** `docs/adr/009` (a decisão — **supera** o ADR-004) · `docs/adr/004`
(orçamento original) · `specs/e2-stories.md` (hook, orçamento, dedup) ·
`specs/e3c-stories.md` (bloco de código, orçamento conjunto) · `src/config.ts`
(`inject.*`) · `src/client.ts` (`RecallBody`/`CodeSearchBody`, `RecallOpts`/
`SearchCodeOpts`) · `src/inject/budget.ts` (`applyBudget`/`applyJointBudget`) ·
`src/inject/memory.ts` · `src/inject/code.ts` · `src/hooks/messages.ts`
(`injectContextIntoMessages`) · memtier `src/memtier/main.py` (`RecallBody:1065`,
`CodeSearchBody:899`, `max_tokens` A1) · `src/memtier/budget.py`
(`CHARS_PER_TOKEN=4`, `MAX_RESPONSE_TOKENS=16000`).

**Natureza:** mudança de comportamento sobre código **em produção** (E2 e E3c
implementados) — **não** é tracer bullet. É **refactor + contrato aditivo**, na
mesma base, sem rewrite. As duas fatias verticais continuam válidas; aqui só se
troca o **modelo de limites** e se acrescenta um **piso de qualidade**.

**Depende de:** E2 (hook + `MemoryInjector`) · E3c (`CodeInjector` + orçamento
conjunto) · **memtier**: campo aditivo `min_score` no `RecallBody` (é mudança no
repo `chiarelli/memtier`, não neste) — **só a S3 depende dela**.

**Ambiente de dev:** `bun run typecheck` · `npm test`
(`node --test "tests/**/*.test.ts"`) · E2E gated `E2E=1` com a stack do memtier de
pé em `127.0.0.1:8400`.

**Ordem de execução e bloqueio (revisado 2026-10-15):**

### Bloco A — **padronização de tokens** (desbloqueado, pode ir já)

`S1 → S2`. Ambos são **plug-in-only**: usam o campo `max_tokens`, que **já
existe** por body nos dois endpoints do memtier. Não tocam o `chiarelli/memtier`.

### Bloco B — **piso de confiança** (bloqueado pelo memtier)

`S3`, dependente do campo aditivo `min_score` no `/v1/recall`. **Não iniciar
antes** de o memtier honrar o campo: a metade plugin (enviar `min_score`) é
trivialmente implementável, mas **não é verificável** contra um servidor que
ignora o campo — fechá-la sem prova violaria a regra de "só fechar com teste".

> Os dois blocos são independentes: o Bloco A pode ser implementado, testado e
> fechado enquanto o Bloco B aguarda o memtier.

---

## Decisões de design fixadas nesta decomposição

Estas decisões são **contrato das stories**; mudá-las exige registrar o porquê no
commit.

### 1. Unidade única: **tokens** (`chars/4`) — o tipo do memtier

`max_chars` (cliente, conjunto) e o `max_tokens` **compartilhado** (servidor)
**morrem**. Resta uma unidade só, a mesma que o memtier usa
(`budget.py:56` — `chars/4`). O teto interno do servidor continua valendo:
`max_tokens > MAX_RESPONSE_TOKENS (16000)` → **422** (`main.py:888`); o cliente
nunca envia acima disso.

### 2. Um `max_tokens` **por endpoint** — o campo já existe por body

O memtier já tem `max_tokens` **em cada body** (`RecallBody` e `CodeSearchBody`).
A mudança é só no plugin: cada injector manda o SEU teto.

| chave config | env var | default | vai no body de |
|---|---|---|---|
| `inject.memory_max_tokens` | `KILOCODE_GRAPH_INJECT_MEMORY_MAX_TOKENS` | 2000 | `POST /v1/recall` |
| `inject.code_max_tokens` | `KILOCODE_GRAPH_INJECT_CODE_MAX_TOKENS` | 2000 | `POST /v1/code/search` |

`inject.max_memories` / `inject.max_code_chunks` **permanecem** como cortes de
**contagem** (independentes do teto de volume).

**Removidas:** `inject.max_chars` (`KILOCODE_GRAPH_INJECT_MAX_CHARS`) e
`inject.max_tokens` (`KILOCODE_GRAPH_INJECT_MAX_TOKENS`).

### 3. `applyBudget` / `applyJointBudget` ficam só com **corte de contagem**

Sem `maxChars`, o corte por caracteres do cliente desaparece — a função de
orçamento vira só `slice` de contagem. Mantém-se **um** ponto de composição
(`applyJointBudget`) para não espalhar a lógica; `renderForBudget`/`renderTotal`
e o parâmetro `RenderFacts`/`RenderTotal` saem (não há mais o que medir em
chars). O corte continua **por fato/chunk inteiro** (nunca pela metade).

> Não se introduz um teto de tokens **conjunto** no cliente: a decisão do dono é
> per-endpoint. O servidor já limita cada resposta; o hook não recompõe um teto
> total.

### 4. Piso de confiança: `min_score` **cru**, no **servidor**, só **memória**

| chave config | env var | default | body |
|---|---|---|---|
| `inject.memory_min_score` | `KILOCODE_GRAPH_INJECT_MEMORY_MIN_SCORE` | 0.35 (a calibrar) | `POST /v1/recall`, campo aditivo `min_score` |

- O plugin **envia** o piso; **não** re-filtra (só vê score **normalizado pelo
  top-1**, `memory.py:412-423` — não serve para julgar confiança).
- O memtier aplica na **escala crua das pernas** (RRF; `sim_min_score`/
  `reranker_min_score`), ANTES de normalizar — é o que economiza retrieval.
- **Código nunca** recebe `min_score` (mantém o `VEC_MIN_SCORE` interno dele).
- O `0.35` é **palpite inicial**; a calibração por medição (verdadeiros vs ruído,
  como no `e6`/`VEC_MIN_SCORE`) é requisito da S3, não um número final.

### 5. Migração de config: envs legadas → **aviso**, nunca silêncio

`KILOCODE_GRAPH_INJECT_MAX_CHARS`/`..._MAX_TOKENS` deixam de ser lidas. Se
estiverem setadas no ambiente, o boot emite **um** log de aviso (depreciação +
chave substituta) — quem calibrou não perde o ajuste em silêncio. As chaves
novas têm precedência normal (env > arquivo > default).

### 6. Degradação: servidor antigo **ignora** `min_score` em silêncio

Pydantic v2 ignora campos extras por default; um memtier sem o campo aditivo
**não dá 422 — ignora** o `min_score`. O plugin **não** assume que o piso valeu:
a S2 registra o envio e a resposta, e a S3 confirma por medição no E2E (fato
abaixo do piso não volta) — não basta o request "ter saído".

---

## Stories

### S1 — Padronizar: `max_tokens` por endpoint, fim do `max_chars`

**Entrega:** `config.ts` (novas chaves + remoção das antigas + aviso de
depreciação) · `types.ts` (`Config.inject`) · `inject/memory.ts` e `inject/code.ts`
(cada um manda o SEU `max_tokens`) · `inject/budget.ts` (só contagem; remover
`maxChars` e os callbacks de render) · `hooks/messages.ts`
(`applyJointBudget` sem `maxChars`) · `index.ts` (fiação das duas chaves).
**Plug-in-only — não toca o memtier.**

**Fatia vertical:** com `inject.enabled=true` e código ligado, o recall carrega
`memory_max_tokens` e a busca carrega `code_max_tokens`, cada um no seu body.

**Testes (unit — happy + unhappy por módulo público):**

| Teste | Cenário | Esperado |
|---|---|---|
| `config_memory_max_tokens_env` | `KILOCODE_GRAPH_INJECT_MEMORY_MAX_TOKENS=1500` | `cfg.inject.memory_max_tokens==1500` |
| `config_code_max_tokens_env` | `KILOCODE_GRAPH_INJECT_CODE_MAX_TOKENS=500` | `cfg.inject.code_max_tokens==500` |
| `config_tokens_defaults` | sem env/arquivo | ambos `2000` |
| `config_legacy_max_chars_warns` | `..._MAX_CHARS` setada | **1** log de aviso; valor ignorado |
| `config_legacy_max_tokens_warns` | `..._MAX_TOKENS` setada | **1** log de aviso; valor ignorado |
| `recall_body_uses_memory_tokens` | memória 1500, código 4000 | body de recall `max_tokens==1500` |
| `code_body_uses_code_tokens` | memória 1500, código 4000 | body de code `max_tokens==4000` |
| `endpoints_independent` | idem | os dois tetos **não** se misturam |
| `budget_counts_only` | 8 fatos, `maxMemories=5` | 5 fatos (corte por contagem) |
| `joint_budget_counts_only` | fatos+código, sem `maxChars` | slices independentes; **nenhum** corte por char |
| `budget_whole_items` | 1 fato grande | nunca fatia um fato pela metade |

**Critérios de aceite:** typecheck limpo; testes de S1 verdes; nenhuma referência
a `max_chars`/`maxChars` permanece em `src/` (`rg`); o boot avisa as envs legadas.

---

### S2 — Fechamento do Bloco A: E2E dos tetos, docs, zero referências legadas

**Desbloqueada** (depende só de S1). Fecha a padronização sem tocar o memtier.

**Entrega:**
- **E2E** (gated `E2E=1`): `memory_max_tokens` e `code_max_tokens` limitam cada
  bloco **de forma independente** contra a stack real.
- **Docs:** `docs/ARCHITECTURE.md` §6 (tabela de config: saem `max_chars`/
  `max_tokens`, entram `memory_max_tokens`/`code_max_tokens`; envs em 439-446) ·
  `src/README.md` (tabela de envs) · `docs/adr/004-orcamento-de-injecao.md` já
  marcado como superado · `BACKLOG.md` (registrar a exceção: chaves que o E2/E3c
  declararam e a S1 reescreve).
- Remover os `TODO(tracer-bullet)` que a S1 introduzir, se houver.

**Testes (E2E):**

| Teste | Cenário | Esperado |
|---|---|---|
| `e2e_memory_tokens_limits_block` | `memory_max_tokens` pequeno | bloco de memória cortado ao teto; código intacto |
| `e2e_code_tokens_limits_block` | `code_max_tokens` pequeno | bloco de código cortado ao teto; memória intacta |
| `e2e_endpoints_independent` | ambos pequenos e distintos | cada bloco obedece só ao SEU teto |

**Critérios de aceite:** typecheck limpo; unit verde; `E2E=1` verde;
`rg "max_char|maxChars|INJECT_MAX_CHARS|INJECT_MAX_TOKENS" src/` → **zero**; docs e
BACKLOG alinhados.

---

### S3 — Piso de confiança da memória (**bloqueada pelo memtier**)

> **BLOQUEIO — não iniciar.** Requer o memtier honrar o campo (a S3 só o
> consome; a implementação é do repo `chiarelli/memtier`). A metade plugin é
> implementável já, mas **não verificável** contra um servidor que ignora o
> campo — não fechar sem a prova abaixo.

**Pré-requisito (outro repo):** `/v1/recall` aceitar o campo **aditivo**
`min_score: float | None = None` no `RecallBody`, aplicado na escala crua das
pernas. Sem ele, o plugin envia e o servidor ignora **em silêncio** (pydantic v2,
extra ignorado — decisão 6).

**Entrega (plugin):** `client.ts` (`RecallOpts.minScore` → `body.min_score`;
**nunca** no body de código) · `config.ts`/`types.ts` (`inject.memory_min_score`) ·
`inject/memory.ts` (`recallOpts` inclui o piso) · `index.ts` (fiação) · log de
observabilidade do valor **enviado** no turno.

**Entrega (medição/fechamento):**
- **Calibração do `min_score`** contra a stack real: queries com **verdadeiros**
  (fato esperado) e **ruído**, varrendo o piso → escolher o valor que corta ruído
  preservando verdadeiros (método do `e6`/`VEC_MIN_SCORE`,
  `specs/e6-stories.md:116`). O default vira o valor **medido**.
- **E2E** do piso: fato **abaixo** do piso **não** é injetado; **acima** é.
- **Docs:** `ARCHITECTURE.md` §6 e `src/README.md` ganham `memory_min_score`.

**Testes (unit):**

| Teste | Cenário | Esperado |
|---|---|---|
| `config_memory_min_score_env` | env `0.42` | `cfg.inject.memory_min_score==0.42` |
| `config_memory_min_score_default` | sem env | `0.35` |
| `recall_body_includes_min_score` | cfg `0.35` | `body.min_score==0.35` |
| `recall_body_omits_when_unset` | `undefined` | body **sem** `min_score` (legado) |
| `code_body_never_min_score` | cfg presente | body de code **sem** `min_score` |
| `min_score_not_reapplied_client_side` | resposta com scores | cliente **não** descarta por score |
| `old_server_ignored_is_visible` | servidor devolve fato baixo | log de aviso; nada é assumido em silêncio |

**Testes (E2E):**

| Teste | Cenário | Esperado |
|---|---|---|
| `e2e_min_score_excludes_low` | fato abaixo do piso | **não** injetado |
| `e2e_min_score_includes_high` | fato acima do piso | injetado |

**Critérios de aceite:** typecheck limpo; unit verde; `E2E=1` verde com o piso
exercendo efeito real (não só "request saiu"); o piso **só** no body de recall; o
valor default é o **medido**, não o palpite 0.35.

---

## Critérios de aceite (da mudança — só o dono marca)

**Bloco A — padronização (desbloqueado):**

- [ ] **S1** — `max_tokens` por endpoint; `max_chars`/`max_tokens` compartilhado removidos; aviso de depreciação
- [ ] **S2** — E2E dos tetos independentes, docs, zero referências legadas

**Bloco B — piso (bloqueado pelo memtier):**

- [ ] **S3** — campo aditivo `min_score` honrado no memtier; piso enviado só no recall; calibração medida; E2E do piso; docs

## Fora de escopo

- **Piso para código** — decisão do dono: só memória (código mantém `VEC_MIN_SCORE`).
- **Teto conjunto de tokens** no cliente — a decisão é per-endpoint.
- **Implementação do `min_score` no memtier** — pertence ao repo `chiarelli/memtier`
  (a S3 só o consome).
- `as_of` / point-in-time, curadoria/supersessão (memtier).

## Histórico de revisão

- **2026-10-15** — criada a partir do `ADR-009` e das três decisões do dono
  (escala crua nas pernas de busca; só memória; troca total por per-endpoint em
  tokens).
- **2026-10-15** — reestruturada em dois blocos de bloqueio: **Bloco A**
  (`S1→S2`, padronização de tokens, desbloqueado — não toca o memtier) e
  **Bloco B** (`S3`, piso de confiança, bloqueado pelo campo `min_score` no
  memtier). A antiga S3, que misturava os dois, foi dividida.
- **2026-10-15 — `S1` IMPLEMENTADA.** Refactor na mesma base, sem rewrite.
  `config.ts` (novas chaves `inject.memory_max_tokens`/`inject.code_max_tokens` +
  aviso de depreciação das envs legadas — **um** log, nunca silêncio),
  `types.ts` (`Config.inject`), `inject/budget.ts` (só contagem; removidos
  `maxChars` e os callbacks `RenderFacts`/`RenderTotal`), `inject/memory.ts` e
  `inject/code.ts` (cada injector manda o SEU `max_tokens` no body do seu
  endpoint), `hooks/messages.ts` (`applyJointBudget` sem `maxChars`) e `index.ts`
  (fiação das duas chaves). `client.ts` **não** mudou (o campo `max_tokens` já
  existia por body). Testes: `tests/config.test.ts` (novas chaves, defaults,
  aviso das legadas, clamp `[1,16000]`), `tests/inject.test.ts`
  (`recall_body_uses_memory_tokens`, orçamento só-contagem) e
  `tests/code_s2.test.ts` (`code_body_uses_code_tokens`, `endpoints_independent`,
  `joint_budget_counts_only`). Verificação: `bun run typecheck` limpo;
  `npm test` **336 pass · 0 fail · 16 skip**; `rg
  "max_char|maxChars|INJECT_MAX_CHARS|INJECT_MAX_TOKENS" src/` → **zero**.
  Revisão adversarial (3 perfis, agentes nomeados) — achados materiais
  corrigidos na mesma base: testes de `code_body_uses_code_tokens`/
  `endpoints_independent` ausentes (adicionados); prosa obsoleta do orçamento
  conjunto em `src/README.md`/`hooks/messages.ts` (corrigida); `max_tokens`
  fora de `[1,16000]` era enviado cru (422 garantido) — novo `resolveTokenCap`
  degrada ao default. **Não** toquei `min_score` (Bloco B / `S3`).
- **2026-10-15 — `S2` IMPLEMENTADA (Bloco A FECHADO).** E2E dos tetos
  independentes + docs + zero referências legadas. Novo
  `tests/e2e/test_e2e_inject_limits.test.ts` (gated `E2E=1`, workspace `alfa`,
  token `e2e-tok-a`), 3 casos: `e2e_memory_tokens_limits_block`,
  `e2e_code_tokens_limits_block` e `e2e_endpoints_independent` — a evidência é o
  **bloco injetado** (fatos/chunks contados nos parts), nunca o retorno da
  chamada; o servidor devolve um **prefixo** quando `max_tokens` trunca (medido).
  E2E existentes (`recall_inject`, `inject_code`) deixaram de passar as chaves
  legadas mortas (`max_chars`/`max_tokens`) e passam as novas. Docs:
  `ARCHITECTURE.md` §6 (config + envs + orçamento), `src/README.md` (envs +
  tabela de verificação), `RUNBOOK-E2E.md` (suíte nova; glob **19/19**).
  `BACKLOG.md`: entrada nova registrando a **exceção** (chaves `inject.max_chars`/
  `inject.max_tokens` declaradas pelo E2/E3c e reescritas pela S1). Verificação:
  `bun run typecheck` limpo; `npm test` **336 pass · 0 fail · 16 skip**;
  `E2E=1` (glob, quatro tokens) **19 pass · 0 fail · 0 skip**;
  `rg "max_char|maxChars|INJECT_MAX_CHARS|INJECT_MAX_TOKENS" src/` → **zero**.
  Revisão adversarial (VERIFICATION-GAP nas E2E): sem gap material. **Bloco A
  fechado. `S3` (Bloco B) permanece bloqueada pelo memtier — não iniciada.**

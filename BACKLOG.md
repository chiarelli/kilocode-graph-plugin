## 2026-10-20 — corte da query: 25/75 ancorado na pergunta

O `slice(0, 512)` do fix anterior parava o 422, mas descartava a pergunta: no
`kilo.db` real (779 mensagens >512 chars, 281 com `?`), a `?` sobrevivia em
apenas **31,7%** dos casos — ela está no último terço em 65% das mensagens
(mediana da posição relativa: 0,84).

`clampQuery` agora corta em 25% cabeça + 75% cauda e, quando o último `?`
cairia fora da janela final, recua a cauda até incluí-lo. Resultado medido no
mesmo corpus: **281/281 (100%)** das perguntas preservadas; identificadores
retidos 26,1% (vs. 26,5% do `head`), ou seja, sem custo relevante de recall
léxico.

Holdout honesto (40 mensagens longas reais, sem `<system-reminder>`, âncoras =
identificadores do próprio texto): **1 ganho, 2 perdas, 37 empates** no top-10.
As perdas são mensagens cujo assunto existe só nos primeiros 128 chars (ex.:
dump de log com pergunta genérica no fim: "O que é um SaaS?"). O ganho é o
caso-alvo: pergunta no fim com o texto dominado por ruído anterior.

Também verificado em cenário sintético controlado (intenção no início/meio/fim
de 1400 chars): `head` achava 5/9, `clampQuery` achou 9/9. O sintético
superestima porque usa ruído repetitivo; os números que valem para decisão são
os do holdout real.

Desvio consciente: não é "25/75 puro" quando há pergunta fora da janela — a
âncora move a cauda. Sem `?`, é 25/75 puro.

## 2026-10-20 — query longa derrubava a injeção de código (422)

Validado ao vivo contra a stack (`memtier.tail7d66cf.ts.net:8400`): o turno em
que o texto do usuário passou de 512 chars devolveu
`422 {"type":"string_too_long","loc":["body","query"]}` e o hook caiu em
`FATAL code_search`, sem bloco de código.

Causa: `MAX_QUERY_LENGTH = 512` é validado com `max_length` no body de
`/v1/code/search` (→ 422), enquanto `POST /v1/recall` **trunca** no servidor
(D2). O plugin mandava o texto do usuário inteiro nas duas rotas; o texto do
host (mensagem + `<system-reminder>`) sozinho já passa de 512.

Correção (commit `a6f9831`): `searchCode` trunca em 512, mesmo padrão do clamp
de `limit`, com `code_search_query_clamped` e
`code_search_query_short_untouched`. Verificado contra a stack real: 1080
chars → 200 com 30 chunks; texto só de stopwords → 0 chunks (sem injeção).

# BACKLOG — kilocode-graph-plugin

> Priorização: o que desbloqueia valor primeiro. Base: `docs/PRD.md §5–§7`,
> `docs/ARCHITECTURE.md`, `docs/SPIKE-FINDINGS.md`, `docs/adr/`, `src/README.md`.
> Espelho da convenção do [`../graphiti-daemon/BACKLOG.md`](../graphiti-daemon/BACKLOG.md).

**Ordem de implementação (primeira onda):** E1 → E2 → E3a → E3b → E3c.
**Ordem de implementação (segunda onda):** E4 → E5 → E6 → E7.
**Primeira onda especificada agora:** E1, E2, E3a, E3b (este backlog + `specs/`).
**Segunda onda:** E4, E5, E6, E7 (spec sob demanda).

E1 antes de tudo: é a fundação (config, cliente HTTP, workspace, health). E2
depende de E1; E3a é independente de E2 mas depende de E1 (cliente) e do binário
do indexer; E3b é independente de E2/E3a (só precisa do memtier MCP de pé).

**Contexto de dependência (externo a este repo):**
- **memtier** (`../graphiti-daemon/`) — **implementado**: E1–E7/E11 + A1/A2/E12.
  Fornece `/v1/recall`, `/v1/code/search`, `/v1/code/sync`, `/v1/ingest`,
  `/v1/code/neighbors` (HTTP-only) e `/v1/mcp` (tools `recall`/`ingest`/
  `code_search`/`code_sync`).
- **rust-ast-indexer** (`../rust-ast-indexer/`) — **dependência de runtime do
  cliente**: binário externo, caminho configurável (ADR-005). **Não tem watch
  mode** (verificado 2026-10-14).

Convenções válidas para todas as epics:
- **Workspace lógico**, nunca `group_id` — a borda resolve `{programa}--{workspace}` (ADR-011). Charset: `^[a-z0-9][a-z0-9_-]{0,63}$`, sem `--`, não-reservado.
- **`program`** é campo aditivo de toda rota (E11, default `"default"`).
- **Token** em `Authorization: Bearer <token>`; `401` sem token/revogado, `403` sem capability, `503` IAM down (fail-closed). Nunca logar token.
- **`reference_time`** = data da **mensagem**, não do envio (quebra supersessão).
- **Injeção tem orçamento de 4s** (timeout do hook). Recall mediano = 0,85s.
- **Coleta de código é fora do turno** (nunca `await` no hook).
- **Nenhum valor hardcoded** — `plugin.yaml` + env (PRD FR-303).
- **Defaults desligados** para indexação e injeção (preferência do dono).
- **O plugin é fino** — o peso (parsing, fila, grafo) fica no binário e no memtier.

---

## Checklist de implementação

> Estado vivo do ciclo. Marcado pelo agente que implementa, conferido pelo
> revisor adversarial. Não substitui os critérios de aceite das epics — é o
> índice de navegação. `[ ]` pendente · `[~]` em andamento · `[x]` concluído ·
> `[!]` bloqueado · `[-]` descartado.
>
> **Uma sessão por epic.** O epic corrente é conduzido pelo dono na UI; ao
> fechar, valida-se e assume-se o próximo numa sessão nova, na ordem declarada.

### E1 — Fundação (cliente do memtier)
- [x] **E1-S1** — Tracer bullet: skeleton do plugin + config + client + `GET /v1/health` atravessando até o memtier
- [x] **E1-S2** — Endurecer: timeout, retry/degradação, workspace + `program`, `token_file`, erros tipados
- [x] **E1-S3** — Fechamento: typecheck + testes verdes, docs, zero marcadores

### E2 — Injeção de memória
- [x] **E2-S1** — Tracer bullet: `messages.transform` injeta o bloco de memória via `/v1/recall`
- [x] **E2-S2** — Endurecer: orçamento (`maxMemories`/`maxChars`/`timeout_ms`), `max_tokens`, dedup no turno, blocos com procedência
- [x] **E2-S3** — Fechamento: E2E real contra o memtier, docs, zero marcadores

### E3a — Coletor de código
- [x] **E3a-S1** — Tracer bullet: spawn do indexer → `chunk_emitted` → `POST /v1/code/sync` (1 arquivo)
- [x] **E3a-S2** — Arestas: `import_edge`/`call_edge` → `edges[]` (resolver alvo; descartar órfã)
- [x] **E3a-S3** — Ciclo de vida: manifest por workspace → removidos com `chunks: []`; idempotência por `chunk_md5`
- [x] **E3a-S4** — Trigger híbrido + backpressure (`pause`/`resume`) + paginação do sync
- [x] **E3a-S5** — Fechamento: E2E do ciclo de vida real, docs, zero marcadores
- [x] **E3a-S6** — **Sync de delta em runtime** (decisão: [ADR-011](docs/adr/011-gatilho-do-delta-em-runtime.md) · spec: [`specs/e3a-s6-stories.md`](specs/e3a-s6-stories.md) · achado: [RFC-002](docs/rfc/002-sync-de-delta-em-runtime.md)):
      o gatilho por **hook git pós-commit** (`post-commit`/`post-checkout`/
      `post-merge`/`post-rewrite`, instalados no boot de forma **idempotente**,
      **sem** `core.hooksPath`) → **CLI standalone** (`src/cli.ts`,
      fire-and-forget) → incremental; **sentinela** `.kilo/graph-ready`;
      **guarda de ancestralidade** (`merge-base --is-ancestor`); **removidos no
      incremental** (`--diff-filter=D`). Delta **por commit** (não-commitado fica
      fora — FR-507). O **CLI é o único escritor** (o plugin não coleta; o boot
      invoca em `auto` e instala hooks). Stories S6a–S6d na spec.
      - [x] **E3a-S6a** — tracer: hook git + CLI `src/cli.ts` +
        `install-hooks.ts` + trava cross-process (`O_EXCL`) + sentinela +
        ancestralidade + removidos no incremental + config persistida (§7);
        boot **invoca o CLI em `auto`** (híbrido) e instala hooks — **não** coleta
        direto. Revisão adversarial (3 lentes) aplicada ao mesmo base.
      - [x] **E3a-S6b** — endurecer instalação/robustez: `--workspace` resolvido
        em runtime (`--show-toplevel`) para worktrees; degradações (não-git,
        indexer vazio, manifest corrompido→full, working tree fora, trava
        CLI×CLI)
      - [x] **E3a-S6c** — observabilidade do delta: `formatCollectLine` com
        `source`/`mode`/`trigger`/`indexer_ms`/`files`/`edges`/`removed`/`sync`
        (base do E7)
      - [x] **E3a-S6d** — fechamento: E2E gated (`test_e2e_runtime_delta` —
        commit real → delta no grafo; `git rm` → sai com `chunks: []`), docs e
        zero marcadores `TODO(tracer-bullet)`

### E3b — Registro do MCP do memtier
- [x] **E3b-S1** — Tracer bullet: registrar o MCP remoto no boot (`status`→`add`→`connect`)
- [x] **E3b-S2** — Endurecer: idempotência (não duplicar se já definido), degradação não-fatal
- [x] **E3b-S3** — Fechamento: prova de tools listáveis/chamáveis, docs, zero marcadores
- [x] **E3b-S4** — **Corrigir os defeitos da revisão adversarial postergada** (D-1..D-10): vírgula final no JSONC derruba o override (D-3); precedência de `kilo.jsonc` sombreia o override (D-4); MCP fica morto e mudo em `disabled`/`connecting`/`disconnected`/`error` — regressão face ao antecessor (D-6); `409` de concorrência vira FATAL sem retry (D-7); `mcp.name` cru nos path params (D-8); token só-espaços vira header (D-9); `memtier: false` não bloqueia (D-10); junção ingênua de URL corrompe base com query/fragment (D-5)
- [x] **E3b-S5** — **Fechamento do E3b-S4**: comando E2E documentado tem de ser verde com o token certo (D-1/D-2 — `e2e-tok-a` é escopo `alfa`, não o workspace do teste); cobrir `scheduleMcpRegistration` (D-11), o caso negativo "já definido ⇒ não registra" ponta-a-ponta (D-12) e o `timeout`/`enabled` do `add` (D-13)

### E3c — Injeção de código
- [x] **E3c-S1** — Tracer bullet: `code_search` → bloco de código no `messages.transform` (part separado)
- [x] **E3c-S2** — Endurecer: paralelismo com o recall, orçamento do total (`maxChars`), dedup do chunk
- [x] **E3c-S3** — Fechamento: E2E real contra o memtier, docs, zero marcadores

### E4 — Ingestão assíncrona
> **Decisão de produto resolvida** (2026-10-15): gatilho, rotina, cursor e
> idempotência estão em **`docs/adr/007`** e **`docs/adr/008`**; a decomposição
> em **`specs/e4-stories.md`**. O memtier **não muda**.
- [x] **E4-S1** — Tracer bullet: ler o `kilo.db` (user+assistant) → 1 lote real → `/v1/ingest`
- [x] **E4-S2** — Endurecer: cursor por `(time_created, id)` + `sentBatchHashes` (idempotência)
- [x] **E4-S3** — `session.idle` drena tudo + o resto (mesma rotina; trava por sessão)
- [x] **E4-S4** — Limitações L-1/L-2/L-3 como critério de aceite (decisão do dono)
- [x] **E4-S5** — Fechamento: E2E real, docs coerentes, zero marcadores

      **DECIDIDO (2026-10-15):** batch por **VALOR de config** (não por mensagem);
      `reference_time` = **mensagem mais atual do batch**.
      **MEDIDO:** batch=20 custa **10 s** vs **1.405 s** do batch=1 para qualidade
      equivalente (cobertura 15/16 × 16/16, 0 espúrias, 0 duplicatas). O 20-por-job
      é **~140× mais barato**. O memtier forma as relações corretamente
      **independente do tamanho do batch** (prova em
      `docs/DECISOES-segunda-onda.md`).
      **GARGALO observado:** o worker consome **1 job por ciclo** (serial) ⇒ ~70 s
      por episódio, ~23 min para 20. **Decisão de concorrência do MEMTIER**, não
      deste plugin.
      ⚠️ **Trigger RESOLVIDO (2026-10-15):** `chat.message` disparava por mensagem
      do **USUÁRIO** (o lado do assistente nunca entrava; e a fila ficava presa).
      Agora: **`message.updated` + `session.idle` acordam a MESMA rotina** — o
      evento não ingere, só acorda; o conteúdo vem do **banco**. Medições e
      decisões em `docs/TRIGGER-INGESTAO.md`, `docs/adr/007`, `docs/adr/008`.

### E5 — Degradação
- [ ] **E5** — Degradação (memtier/indexer fora do ar ⇒ turno segue)

### E6 — Multi-CLI
- [!] **E6** — Multi-CLI — **BLOQUEADA: só Kilocode é suficiente hoje**
      (decisão do dono, 2026-10-15). OpenCode e Claude Code **não estão
      instaladas** nesta máquina (SPIKE-FINDINGS: "não dá para validar sem
      instalar") e o Claude Code usa **outro mecanismo** (`UserPromptSubmit` →
      `additionalContext`). Não é "pendente de spec" — é **sem consumidor hoje**.

### E7 — Observabilidade
- [ ] **E7** — Observabilidade (log de recall/coleta, flag de debug)

### E8 — Identidade no bloco injetado e instrução de uso do memtier
- [ ] **E8-S1** — Identidade: `uuid`/`episodes` em `Fact`, `uuid` em `CodeChunkHit`, `[id=<uuid>]`/`[ep=<uuid> +N]`, dedup por uuid
- [ ] **E8-S2** — Instrução de sistema: `system.transform` derivado da config efetiva (`mcp.enabled`; código por `code_index.enabled`, não `inject.code_enabled` — pull ≠ push)
- [ ] **E8-S3** — Fechamento: E2E de ida-e-volta (id → tool), `chunkUuid` eliminado, docs

---

## Protocolo tracer bullet (obrigatório onde indicado)

Onde a epic marca **Tracer bullet**, a implementação segue este protocolo:

1. **Fatia fina end-to-end primeiro** — o caminho mais estreito cruzando TODAS as
   camadas da epic (hook do Kilo → plugin → HTTP → memtier; ou spawn do indexer →
   collector → sync), com interface real de consumo (hook chamado de verdade, não
   mock).
2. **Código de produção desde a primeira fatia** — sem protótipo descartável;
   mesmos padrões de qualidade, nomenclatura e organização do resto do codebase.
3. **Endurecer sobre o mesmo código** — validação, error handling, edge cases e
   critérios de aceite restantes na mesma base, nunca rewrite.
4. **Checklist de maturidade no código** — tudo que ficar minimal na primeira
   fatia é marcado no ponto exato com `TODO(tracer-bullet): <o que falta>`. A epic
   só fecha quando `rg "TODO\(tracer-bullet\)" src/` retorna zero.

---

## Padrão de testes (obrigatório em todas as epics)

Todo **módulo público** (toda função exportada e todo hook) tem **teste de
unidade com happy path e unhappy path**:

- **Happy path:** entrada válida → comportamento esperado.
- **Unhappy path:** entrada inválida / dependência fora do ar / timeout →
  erro mapeado corretamente (sem exceção não tratada, sem escrita parcial).
- Testes em `tests/`, `node --test` (runner nativo do Node ≥ 22, com type
  stripping — roda `.ts` sem build; `package.json` aponta
  `node --test "tests/**/*.test.ts"`). **Não** usar `node --test tests/`: o Node
  ≥ 22 trata o argumento como módulo (`MODULE_NOT_FOUND`).
- Privados são exercitados via interface pública; lógica crítica isolada vira
  unidade própria testável (ex.: `buildSyncBody`, `resolveEdges`).
- **Nada de rede real em teste unitário** — o cliente HTTP é injetado/stubado.

**E2E ao final da epic (quando aplicável):**

- Onde a epic marca **E2E: SIM**, o fechamento exige 1 teste E2E contra a stack
  real (memtier de pé em `127.0.0.1:8400`; binário do indexer buildado), sem mock
  de infra, comprovando o efeito ponta a ponta.

---

## Tabela de epics

| Epic | Tracer bullet | E2E | Depende de |
|---|---|---|---|
| **E1 — Fundação (cliente do memtier)** | **SIM** — `GET /v1/health` atravessando config → workspace → client → memtier real | **SIM** — health real + workspace resolvido do dir | memtier ✅ |
| **E2 — Injeção de memória** | **SIM** — `messages.transform` injeta bloco de memória de 1 recall real | **SIM** — recall real injetado no turno | E1 |
| **E3a — Coletor de código** | **SIM** — spawn do indexer → `chunk_emitted` → `/v1/code/sync` (1 arquivo) | **SIM** — ciclo de vida real (cresce/encolhe/deleta) | E1, rust-ast-indexer |
| **E3b — Registro do MCP do memtier** | **SIM** — `status`→`add`→`connect` do MCP remoto no boot | **SIM** — tools listáveis/chamáveis via cliente MCP | memtier MCP ✅ |
| **E8 — Identidade no bloco e instrução de uso** | **SIM, na S2** — `system.transform` nunca atravessou camada nenhuma; a S1 é aditiva | **SIM** — id injetado → `memory_episodes`/`code_neighbors` devolve conteúdo | E2, E3c, E3b, memtier v1.1.0 ✅ |

---

## E1 — Fundação (cliente do memtier)

> **Objetivo:** o esqueleto real do plugin — carregamento, config, resolução de
> workspace e um cliente HTTP que fala com o memtier. É a base de todas as
> outras epics; sem ela nada roda.

**Entrega:** `src/index.ts` (registro de hooks vazio + boot), `src/config.ts`
(`plugin.yaml` + env, nada hardcoded), `src/workspace.ts` (dir → nome lógico),
`src/client.ts` (HTTP client: auth, timeout, erros tipados, `health`).

**Tracer bullet:** SIM — a primeira fatia é `GET /v1/health` atravessando
config → workspace → client → memtier de verdade.

**Critérios de aceite:**
- O plugin carrega no Kilo sem erro e loga o workspace resolvido.
- `health()` distingue ok/degradado sem lançar.
- Config: env > `plugin.yaml` > default (padrão do antecessor).
- `typecheck` limpo, testes verdes.

**Fora de escopo:** qualquer hook de injeção/ingestão (E2/E4), qualquer coleta
(E3a), qualquer MCP (E3b).

## E2 — Injeção de memória

> **Objetivo:** injetar memória curada no turno, dentro do orçamento de 4s.

**Entrega:** `src/inject/memory.ts` (bloco formatado), `src/inject/budget.ts`
(limites), hook `experimental.chat.messages.transform` chamando `/v1/recall`.

**Tracer bullet:** SIM — um recall real vira bloco injetado no último turno do
usuário.

**Critérios de aceite:**
- Bloco de memória aparece no turno com procedência (FR-105).
- Respeita `maxMemories`/`maxChars`/`timeout_ms` e `max_tokens` (A1).
- Timeout do hook não estoura (≤4s); degrada sem quebrar o turno.
- Não reinjeta a mesma memória no mesmo turno (FR-104).

**Fora de escopo:** injeção de código (E3c), ingestão (E4).

## E3a — Coletor de código

> **Objetivo:** popular o grafo de código. Spawna o binário do `rust-ast-indexer`
> (caminho configurável), traduz os eventos JSONL e chama `/v1/code/sync`.

**Entrega:** `src/index/runner.ts`, `collector.ts`, `edges.ts`, `manifest.ts`,
`trigger.ts`; hook de boot/sessão que dispara a coleta **fora do turno**.

**Tracer bullet:** SIM — 1 arquivo Rust → `chunk_emitted` → body → sync 202.

**Critérios de aceite:**
- Um repo sincroniza: chunks aparecem na busca (`/v1/code/search`).
- Arestas resolvidas gravam; aresta órfã é descartada (sem 422).
- Ciclo de vida: cresce sem órfão; encolhe deleta órfãos; arquivo removido →
  `chunks: []` (0 chunks no grafo).
- Reenvio idêntico ⇒ `upserted=0, deleted=0`.
- Coleta nunca bloqueia o turno.

**Fora de escopo:** watch mode (o indexer não tem); mudanças não-commitadas;
navegação `neighbors` (bloqueada até o memtier expor tool MCP).

## E3b — Registro do MCP do memtier

> **Objetivo:** registrar o MCP remoto do memtier no Kilo, implicitamente, para
> o modelo usar as tools sob demanda.

**Entrega:** `src/mcp/register.ts` (reuso de `registerOpenVikingMcp` →
`type:"remote"`), chamado no boot.

**Tracer bullet:** SIM — `status`→`add`→`connect` de 1 MCP remoto real.

**Critérios de aceite:**
- As tools do servidor ficam disponíveis (**7** no memtier v1.1.0:
  `recall`/`ingest`/`code_search`/`code_sync`/`code_neighbors`/`memory_episodes`/
  `memory_neighbors`).
- Registro é implícito (o usuário não define nada em `kilo.jsonc`).
- Se já definido lá, o plugin não registra por cima.
- Falha de registro é logada, nunca fatal.

**Fora de escopo:** o plugin escolher **quais** tools aparecem — o registro é
**por servidor**, não por tool.

---

## E8 — Identidade no bloco injetado e instrução de uso do memtier

> **Objetivo:** o bloco injetado passa a carregar o `uuid` do fato/chunk e o do
> primeiro episódio, e o system prompt passa a explicar como expandir por esses
> ids com as tools MCP. Fecha os achados 3, 4 e 6 da
> [RFC-001](docs/rfc/001-navegacao-e-integridade-do-grafo-de-codigo.md); spec:
> [`specs/e8-stories.md`](specs/e8-stories.md).

**Entrega:** `uuid`/`episodes` em `Fact` e `uuid` em `CodeChunkHit`
(`src/client.ts`); marcadores `[id=<uuid completo>]` e `[ep=<uuid> +N]` em
`formatFact`/`chunkHeader`; `factKey` (dedup por uuid, com fallback para o
texto); `src/hooks/system.ts` com `experimental.chat.system.transform` derivado
do estado real; chave `inject.instruction_enabled`.

**Tracer bullet:** **SIM, na S2** — `experimental.chat.system.transform` nunca
atravessou camada nenhuma deste plugin, então a S2 começa por uma fatia vertical
mínima (texto fixo empurrado num turno real, provado no E2E). A **S1** é contrato
aditivo puro sobre E2/E3c e não usa a fatia. Marcadores `TODO(tracer-bullet):`
aparecem **só na S2**; a epic fecha com `rg` = 0.

**Critérios de aceite:**
- Cada item injetado traz id **completo** (36 chars) — é a entrada que a tool
  exige; id truncado devolve `[]` em silêncio.
- O bloco **não** contém `score` (decisão da RFC-001 §3).
- `[ep=…]` do bloco → `memory_episodes` devolve o `content` original.
- A instrução cita **apenas** tools que a config efetiva habilita (`mcp.enabled`;
  código por `code_index.enabled`); nunca `ingest` nem `code_sync` (escrita).
- O hook de sistema **nunca lança** e **acrescenta** ao `output.system`, sem
  substituir o prompt do host.

**Fora de escopo:** `score` no bloco · `depth` no plugin · multi-hop de código ·
injetar o `content` do episódio · duplicar navegação por HTTP · trocar o dedup de
código para `uuid`.

---

## Pendências conhecidas de contrato (medidas 2026-10-14, antes da primeira onda)

Não bloqueiam a E1; **bloqueiam a E3a**. Ficam registradas para não serem
redescobertas no meio do loop.

1. **[DECIDIDO 2026-10-15 — saída (a): aceitar e documentar]** ~~Decidir: aceitar a
   limitação e documentar, ou pedir campo aditivo ao memtier~~
   **"Todos os arquivos removidos" não é representável, e aceita-se a limitação.**
   `CodeSyncBody.files` tem `min_length=1` (`graphiti-daemon/src/memtier/main.py:710`),
   então o coletor não consegue zerar o grafo de um repo esvaziado. O caso coberto pela
   E3a-S3 é a remoção **individual** (`chunks: []` por arquivo — o campo `chunks`
   **não** tem mínimo: `main.py:656`).

   **Prova medida (2026-10-15, contra o memtier vivo):**
   - `files: []` → **HTTP 422**, `{"type":"too_short","loc":["body","files"],
     "msg":"List should have at least 1 item after validation, not 0"}`.
   - Removido **por ausência** (mando outro arquivo, sem o removido) → **202** com
     `deleted:0` — o arquivo ausente **não** é detectado. O sync é incremental
     ("estes mudaram"), nunca "o repo é este".
   - Removido **declarado** (`chunks: []` explícito) → **202**, mecanismo válido.

   **Consequência aceita:** esvaziar um repo **não** limpa o grafo; ficam chunks
   órfãos, servidos como código atual (o delete é físico — não há `invalid_at` em
   código). A limpeza é feita declarando `chunks: []` por caminho conhecido.

   **Decisão do memtier que cobre o resto** (já registrada lá, não commitada):
   o cliente é o **dono da detecção** — invariante "órfão declarado"
   (`graphiti-daemon/specs/delecao-arquivo-removido-decisao.md` + adendo no
   ADR-007). O plugin **já cumpre**: `manifest.files − atual` ⇒ `removed` ⇒
   `chunks: []` (`src/index/collector.ts:204,233`), provado no E2E de ciclo de
   vida (`tests/e2e/test_e2e_lifecycle.test.ts`, caso F3).

   **Aberto (não é ação do plugin):** o `rust-ast-indexer` **não emite** evento de
   remoção (segue válido). **CORRIGIDO 2026-10-16 (RFC-002):** a alegação anterior
   de que `incremental_index` **aliasa para `index_path`** (sem rodar `git diff`)
   é **falsa** na versão atual — ele **roda `git diff --name-only <from> <to>`**
   (`cli/mod.rs:384` → `infra/git.rs:66`), e o `explicit_files` resultante é
   honrado por `index_path_parallel` (`application/indexer.rs:128`). Provado com o
   binário real: commit alterando 1 de 2 arquivos → `file_listed`/`chunk_emitted`
   só do arquivo alterado. O delta incremental **existe e funciona**; o que falta
   é **dispará-lo em runtime** (ver `E3a-S6` / [RFC-002](docs/rfc/002-sync-de-delta-em-runtime.md)).
2. **Arestas sem teto de paginação.** A E3a-S4 fatia em lotes de ≤100 arquivos
   (`MAX_FILES_PER_REQUEST`, `code.py:112`), mas
   `MAX_EDGES_PER_REQUEST = 5_000` (`code.py:99`). 100 arquivos produzem
   facilmente >5.000 arestas → **422 no lote inteiro**. Nenhuma story limita as
   arestas. Corrigir na E3a-S4 (fatiar arestas também, não só arquivos).
3. **`FR-305` não existe neste PRD** — é requisito do **memtier**. Citado como
   se fosse local em `docs/adr/005:72`, `specs/e1-stories.md:98` e
   `specs/e2-stories.md:113`. Aqui o requisito de degradação é **NFR-03**. Trocar
   a citação (a epic dona corrige; não muda comportamento).
4. **Pré-requisito não listado do E2E da E1:** não existe `.kilo/graph-key.json`
   (bearer show-once) em nenhum workspace desta máquina. As specs citam o
   caminho mas não a origem do token. Sem ele, o E2E da E1 fica pendente.

   **Resolvido na E1-S3 (medido 2026-10-14):** o E2E da E1 **não** depende do
   bearer. `GET /v1/health` é **aberto** (FR-305 do memtier) — responde 200 com
   ou sem token. O E2E de health da E1 roda real contra a stack e prova o efeito
   (health `ok:true` + workspace resolvido). O bearer por workspace segue
   necessário para as rotas protegidas (`/v1/recall`, `/v1/code/sync`) — é
   pré-requisito do **E2E da E2**, não da E1. O `token_file` já é exercitado com
   um arquivo real (o client o lê lazy); o valor só é exigido por rota protegida.

## Histórico de revisão

> Registro append-only das decisões de escopo. Não editar entradas antigas.

- **2026-10-14 — decisões do dono sobre config e ambiente (pós-revisão das specs):**
  1. `inject.enabled` default = **`false`** (desligado). O `true` que aparecia em
     `docs/ARCHITECTURE.md` §6 e `docs/adr/004` era erro — o texto ao redor já
     dizia "desligado por padrão"; o default alinha com FR-304 e com a
     preferência do dono.
  2. `max_chars` default = **`3000`**, configurável por env var
     `KILOCODE_GRAPH_INJECT_MAX_CHARS`. O `4000` do ARCH/ADR-004 era erro; o
     **3000** da E2 e do antecessor (`recallMaxChars=3000`) é o valor correto.
  3. Chaves `inject.max_memories`/`max_chars`/`max_tokens` passam a ser
     **declaradas pela E1** (tabela de chaves) — a E2 só as lê. Fecha o churn de
     config entre epics (ver §"conflito #3" da revisão).
  4. Ambiente: `node --test tests/` **não funciona** no Node ≥ 22
     (`MODULE_NOT_FOUND` — o argumento é tratado como módulo). Comando correto:
     `node --test "tests/**/*.test.ts"` (é o que o `package.json` aponta). As
     quatro specs citavam a forma quebrada; corrigidas.
  5. Dependências instaladas e travadas em `bun.lock`. **Kilo pinado em
     `7.8.3`** — o runtime real da máquina é o binário `~/.kilo/bin/kilo`
     (`--version` → 7.8.3); a extensão VSCode de 7.8.8 é outro runtime e não é o
     que carrega o plugin. `typescript@5.9.3`, `@types/node@22.20.5`,
     `@kilocode/sdk@7.8.3` (dev) e `@kilocode/plugin@7.8.3` (peer pinado — era
     `*`). `tsconfig.json` criado (não existia).
  6. Dependência de runtime validada: `rust_indexer` buildado em
     `../rust-ast-indexer/rust_indexer/target/release/rust_indexer`
     (`cargo build --release --features parsing`, 53,85s) e responde com o
     evento `capabilities` (`jsonl`, `incremental_index`, `git_diff`,
     `pause_resume`, `mcp_compatible`; 6 linguagens). O default
     `code_index.indexer_bin: ""` (FR-306) passa a ter valor a apontar.

- **2026-10-14 — primeira onda especificada (E1, E2, E3a, E3b):** o memtier está
  implementado e o PRD/ARCH foram revisados para v0.2 (o plugin é o coletor).
  Segunda onda (E4, E5, E6, E7) fica com spec sob demanda.
  *Correção (2026-10-15):* o **E3c entrou na primeira onda** (a ordem declarada na
  linha 7 é `E1 → E2 → E3a → E3b → E3c`); foi especado e implementado em 15/10.
  A menção original a "E3c" como segunda onda estava errada e foi corrigida.

- **2026-10-14 — E2 fechada (S1/S2/S3):** injeção de memória entregue sobre a
  base tracer-bullet (S1 → S2, sem rewrite). E2-S3 fecha com:
  1. `tests/e2e/test_e2e_recall_inject.test.ts` (**novo**, gated `E2E=1`): recall
     real contra o memtier (`127.0.0.1:8400`) devolve ≥1 fato e o plugin bootado
     injeta o bloco `<context graph-memory="true">` no último turno. Medido com
     o bearer escopado ao workspace com fatos: 4/4 E2E verdes (recall 1,46s;
     injeção 0,55s).
  2. **Defeito de fechamento corrigido:** o arquivo nasceu como
     `test_e2e_recall_inject.ts` (sem `.test.ts`), então **não casava** o glob da
     spec (`tests/e2e/**/*.test.ts`) e rodava **0 testes** — falso-verde. Renomeado
     para `.test.ts` (mesma convenção do E1-S3) e a spec alinhada. O glob agora
     coleta os 4 E2E.
  3. Observabilidade do turno (base do E7): `MemoryInjector.inject` devolve
     `InjectionResult { block, facts, chars, recallMs }` e loga
     `inject recall_ms=<n> facts=<n> injected_chars=<n>`.
  4. Latência medida (n=5, workspace real): mediana **496ms**, máx 1518ms — dentro
     de NFR-01 (≤4s) e coerente com NFR-02 (~0,85s, folga).
  5. `rg "TODO\(tracer-bullet\)" src/` → **zero**. Unit 62 verdes, 4 E2E gated
     (skip). `tsc --noEmit` limpo.
   - Pendência #4 do BACKLOG (bearer do E2E da E2) **resolvida**: existe
     `.kilo/graph-key.json` no workspace (bearer show-once, workspace
     `kilocode-graph-plugin`/`graphplugin`); para um workspace **com fatos** o E2E
     usa `E2E_TOKEN`/`E2E_WS` (o token legado `e2e-tok-a`→`alfa` tem fatos reais).

- **2026-10-14 — E3a fechada (S1–S5):** coletor de código entregue sobre a base
  tracer-bullet (S1 → S2 → S3 → S4 → S5, sem rewrite). Entrega:
  1. `src/index/{runner,collector,edges,manifest,trigger}.ts` + `hooks/collect.ts`;
     `client.syncCode` (paginação ≤100 arquivos / ≤5000 arestas, fallback 422).
  2. Prova real da cadeia (stack viva, sem mock de infra):
     `tests/e2e/test_e2e_collector.test.ts` (indexer→sync→search→neighbors;
     OUT/IN call navegam) e `tests/e2e/test_e2e_lifecycle.test.ts`
     (cresce/encolhe/deleta/idempotência). Ambos gated `E2E=1`. **Cada suíte consome um token de escopo diferente** —
     o comando correto por arquivo está em `docs/RUNBOOK-E2E.md` (⚠️ passar os dois
     tokens no glob **reprova**; medido 8 pass / 1 fail em 2026-10-15).
  3. **Defeitos medidos e corrigidos** no endurecimento real:
     - import_edge é nível de arquivo ⇒ origem `{file}:FullFile` precisa existir
       (ADR-012 D3); sem o `FullFile` sintético o lote inteiro tomava 422. O
       `resolveEdges` descarta a aresta até o nó existir (nunca 422).
     - `saveManifest` não criava `.kilo/` ⇒ escrita falhava em silêncio e o
       manifest nunca persistia (full eterno).
     - no incremental, `present` só traz os alterados; usá-lo para o diff de
       removidos apagaria o grafo. Removidos só são calculados no FULL.
     - `timeout_ms=2000` estourava o sync de 100 arquivos (embedding lento) ⇒
       `code_index.sync_timeout_ms` (default 120000).
  4. Coleta nunca no turno (FR-510), verificado: boot retornou em **41ms** e a
     coleta de 50 arquivos terminou **12,7s depois** (`collect indexer_ms=62
     files=50 sync={upserted:100…}`).
  5. `rg "TODO\(tracer-bullet\)" src/` → **zero**. Unit 138 verdes, 6 E2E gated
     (skip sem `E2E=1`). `tsc --noEmit` limpo.
  6. Pendências de contrato do BACKLOG: **#2 (teto de arestas) resolvida** na
     S4 (fatia as arestas em ≤5.000/request); **#1 (repo esvaziado)** permanece —
     `CodeSyncBody.files` tem `min_length=1`, então "todos os removidos" não é
     representável; o caso coberto é a remoção individual (`chunks: []`), que a
     S3 prova.

- **2026-10-14 — E3b fechada (S1/S2/S3):** registro do MCP remoto do memtier
  entregue sobre a base tracer-bullet (S1 → S2 → S3, sem rewrite). Entrega:
  1. `src/mcp/register.ts` (`buildMcpConfig` puro, `registerMemtierMcp` com
     `client.mcp` injetado, `scheduleMcpRegistration` em background) +
     `src/mcp/kilo-config.ts` (leitura do `kilo.jsonc` JSONC e override para
     idempotência); `src/index.ts` dispara o registro no boot; `client.resolveToken()`
     expõe o bearer (nunca logado).
  2. Fluxo real medido contra o memtier (`/v1/mcp`, rota protegida — 401 sem
     bearer): `initialize` → `tools/list` devolve as **4 tools**
     (`recall`/`ingest`/`code_search`/`code_sync`); `recall` e `code_search`
     respondem `isError:false`. O E2E `tests/e2e/test_e2e_mcp.test.ts` (gated
     `E2E=1`) prova o **registro implícito** (espião do `client.mcp` captura o
     `McpRemoteConfig` e o config real conecta no MCP), 2/2 verdes.
  3. **Escopo do bearer medido:** o `graph-key.json` real é escopado ao programa
     `graphplugin` (não `default`); chamar `recall` com `program:"default"` devolve
     `isError:true` ("gestor … não owns o programa 'default'"). O E2E lê o
     programa do próprio key file — nunca fabrica.
  4. Idempotência (FR-602) e degradação (FR-604) provadas em unit: override do
     `kilo.jsonc` pula o registro; `status failed`/`ENOENT` ⇒ `disconnect`+`add`;
     `client.mcp` ausente (SDK antigo) ⇒ log, nunca lança.
  5. `rg "TODO\(tracer-bullet\)" src/` → **zero**. `tsc --noEmit` limpo;
     `tests/mcp.test.ts` 24/24. (O `npm test` global teve 1 falha em
     `tests/inject.test.ts` de mudanças **alheias** não-commitadas em `src/inject/*`
     — fora do escopo da E3b.)
  6. Bloqueio registrado mantido: `neighbors` **não** é tool MCP — a E3b não
     promete navegação (README/ADR-006).

- **2026-10-15 — E3c fechada (S1/S2/S3):** injeção de código entregue sobre a
  base tracer-bullet (S1 → S2 → S3, sem rewrite). Entrega:
  1. `src/inject/code.ts` (`formatCodeBlock`/`chunkIdentity`, `CodeInjector`
     com dedup por turno), `client.searchCode`, `config` (`inject.code_enabled`,
     `inject.max_code_chunks`) e `hooks/messages.ts` (`injectContextIntoMessages`
     orquestra as duas famílias). O bloco de código é um **segundo part** no
     MESMO `messages.transform` (não um segundo hook), com sentinela própria
     `graph-code` e procedência por chunk `[CÓDIGO RELEVANTE — path:ini-fim]`.
  2. **Paralelismo:** recall e `code/search` partem com `Promise.allSettled`,
     cada um com seu `AbortSignal` — `inject.timeout_ms` vale para **cada**
     chamada. É o que sustenta o teto de 4s do hook (sem somar latências).
  3. **Orçamento do TOTAL** (`applyJointBudget`): `maxChars` é o teto de
     memória+código; corta fatos inteiros de memória **primeiro** (do fim), só
     então chunks inteiros de código — código prioritário; chunk nunca pela
     metade (ADR-004).
  4. **Dedup por turno compartilhado:** memória e código usam o MESMO `turnoId`
     (`id` da `UserMessage`); identidade do chunk = `path:start_line-end_line`
     (a rota não devolve `chunk_md5`). Um turno injeta no máximo um bloco de cada
     família; `transform` 2× não acumula.
  5. **Sanitização** do `code`/`path` (`<`/`>` → `&lt;`/`&gt;`) **preservando**
     quebras de linha e indentação (a lição D-3 do E2, adaptada: código não pode
     ser achatado como o fato).
  6. **E2E real** `tests/e2e/test_e2e_inject_code.test.ts` (gated `E2E=1`):
     indexer → sync → `code_search` acha o símbolo único → o plugin bootado
     injeta `<context graph-code="true">` com o caminho REAL. Exige
     `E2E_CODE_TOKEN` (em `E2E=1` sem token, **falha** — nunca skip silencioso);
     medido 1/1 verde contra o memtier (`alfa`, ~1,6s).
  7. **Config — exceção consciente:** as duas chaves novas
     (`inject.code_enabled`, `inject.max_code_chunks`) foram declaradas pela E3c
     porque o E1 fechou antes da E3c ser especada (a segunda onda era "spec sob
     demanda"). Sem churn: a E3c **lê** (não redeclara) `inject.enabled`,
     `inject.timeout_ms`, `inject.max_chars` e `daemon.*`.
  8. `rg "TODO\(tracer-bullet\)" src/` → **zero**. Unit 195 verdes; E2E gated
     (9 casos skip sem `E2E=1`). `tsc --noEmit` limpo.

- **2026-10-15 — E3c VALIDADA (prova medida do supervisor):** `046600b`, árvore
  limpa. `bun run typecheck` limpo; unit **204 testes · 195 pass · 0 fail · 9 skip**;
  `rg "TODO\(tracer-bullet\)" src/` → **zero**; E2E **9/9 pass · 0 fail** com o
  token por suíte (`docs/RUNBOOK-E2E.md`) — incluindo o caso do E3c
  (`inject_code`, workspace `beta`). Arquivos: 14 · +1559/−51
  (`src/inject/code.ts` 255L, `tests/code.test.ts` + `tests/code_s2.test.ts`).
  **Correção de rota do supervisor:** o primeiro E2E rodado pelo supervisor deu
  `fail 1` por **erro de token dele** (`E2E_TOKEN=e2e-tok-a`, escopo `alfa`, na
  suíte do MCP) — não era defeito do épico. Medido: cada suíte consome um token
  distinto; o comando com os dois tokens no glob **reprova**.

- **2026-10-15 — REVISÃO ADVERSARIAL POSTERGADA DO E3b → o épico REABRE.**
  Review completo em `docs/reviews/REVIEW-E3b-adversarial.md` (16 KB, 2026-10-15).
  Método: 3 perfis adversariais em paralelo (BLIND-HUNTER, EDGE-CASE-HUNTER,
  VERIFICATION-GAP) em worktree destacado no `724250d`; **toda** alegação
  re-executada pela sessão-mãe antes de entrar em DEFEITOS.
  **10 defeitos CONFIRMADOS (D-1..D-10) + 3 de cobertura (D-11..D-13)**, 5 riscos,
  4 não-provados. O veredito do review: *"o 'verde' declarado no fechamento não se
  sustenta: o épico precisa reabrir"*.
  Os que atingem contrato:
  - **D-3** — vírgula final é JSONC válido; `stripJsoncComments` não trata, o
    `JSON.parse` lança e o `catch` devolve `null` ⇒ override do usuário ignorado e
    o plugin registra por cima (**FR-602 violado**).
  - **D-4** — precedência de `kilo.jsonc`: se só um dos arquivos tem `mcp`, o
    override é sombreado (**FR-602 violado**).
  - **D-6** — `status` ∈ {`disabled`,`connecting`,`disconnected`,`error`} ⇒ plugin
    **não faz nada**: MCP morto, zero tools, nenhum erro (regressão face ao
    antecessor, que desconectava em qualquer não-conectado).
  - **D-7** — `409` de concorrência (dois boots) vira FATAL, sem retry/reparo.
  - **D-1/D-2** — o comando E2E prescrito pela epic é vermelho, e a suíte do MCP
    ignora `E2E_CODE_TOKEN` caindo em fallback silencioso para o `graph-key.json`
    (é o que produzia um "verde" falso). **Corrigido o runbook**:
    `docs/RUNBOOK-E2E.md` (por arquivo, medido 9/9).
  - **D-5** junção ingênua de URL; **D-8** `mcp.name` cru nos path params;
    **D-9** token só-espaços vira header; **D-10** `memtier: false` não bloqueia.
  Escopo aberto: **`E3b-S4`** (corrigir D-1..D-10) e **`E3b-S5`** (fechamento:
  comando E2E verde com o token certo + cobrir D-11/D-12/D-13).

- **2026-10-15 — E3b-S4 (correção dos defeitos D-3..D-10).** Correções sobre a
  mesma base do E3b, sem rewrite. D-1/D-2 (E2E) e D-11/D-12/D-13 (cobertura)
  ficam para a **E3b-S5** — a S4 corrige os **8 defeitos de código**:
  1. **D-3** (`kilo-config.ts`): novo `stripTrailingCommas` (respeita strings e
     escapes), aplicado **depois** de `stripJsoncComments`; vírgula final de JSONC
     não derruba mais o override (FR-602).
  2. **D-4**: `isMcpDefinedInKiloConfig` varre **todos** os arquivos de config —
     um `.kilo/kilo.jsonc` sem `mcp` (ou que não parseia) não sombreia mais um
     `kilo.jsonc` da raiz que o define.
  3. **D-10**: `mcp.<name>` definido com **qualquer** valor (`false`/`null`/`[]`)
     bloqueia o registro via `hasOwnProperty` — antes só `object` contava.
  4. **D-5** (`register.ts`): URL unida com `URL` nativo (`new URL("v1/mcp",
     base/)`) — base com `?query`/`#fragment`/subpath deixa de corromper; base
     vazia lança e o chamador degrada (FR-604).
  5. **D-6**: `shouldRefreshMcpRegistration` agora é `status !== "connected"`
     (preservando `ENOENT` sobre `connected`); o fluxo desconecta e re-registra
     qualquer estado não-conectado — o MCP não fica mais morto e mudo.
  6. **D-7**: `409`/`already exists` do `add` é tratado como não-fatal e **segue
     para o `connect`**; só erro real vira FATAL.
  7. **D-8**: `isValidMcpName` rejeita nome vazio, com `/`, `\`, `..` ou espaço
     antes de usá-lo nos path params do SDK.
  8. **D-9**: token é `trim()`ado; só-espaços vira sem-header (não `Bearer    `).
  `getKiloMcpOverride`/`readKiloConfig` foram substituídos por
  `isMcpDefinedInKiloConfig` (a API retornava `object|undefined`, incapaz de
  expressar `false`/`null` — era a raiz de D-10). Testes: `tests/mcp.test.ts`
  45/45 (14 casos novos cobrindo D-3..D-10 + D-13). Unit **225 · 216 pass ·
  0 fail · 9 skip**; `tsc --noEmit` limpo; E2E do MCP 2/2. Revisão adversarial
  por subagente não rodou (infra `litellm:4000` fora do ar) — revisão inline com
  sondagem de bordas (strings com `,]`, aspas escapadas, `?query`/`#fragment`,
  `ENOENT` sobre `connected`).

- **2026-10-15 — E3b-S5 (fechamento do E3b-S4).** Resolve os defeitos de E2E e
  de cobertura (D-1/D-2/D-11/D-12/D-13):
  1. **D-1/D-2** (`tests/e2e/test_e2e_mcp.test.ts`): a suíte do MCP passa a usar
     um token **dedicado** `E2E_MCP_TOKEN` (ou `KILOCODE_GRAPH_TOKEN`) e **ignora**
     `E2E_TOKEN` (escopado a `alfa` — era a causa do vermelho). O fallback
     silencioso para `.kilo/graph-key.json` foi **removido**: em `E2E=1` sem
     token, o teste **falha** (não skippa, não lê arquivo) — fim do verde falso.
  2. **Comando canônico verde**: o glob com os **três** tokens passa
     (medido `E2E=1 E2E_TOKEN=e2e-tok-a E2E_CODE_TOKEN=e2e-tok-b
     E2E_MCP_TOKEN=<bearer> node --test "tests/e2e/**/*.test.ts"` → **10/10**).
     `docs/RUNBOOK-E2E.md` reescrito com o comando medido e a tabela dos três
     tokens.
  3. **D-11**: `scheduleMcpRegistration` coberto por unit (retorna imediato —
     não bloqueia o boot; registra em background; não lança sem `client.mcp`).
  4. **D-12**: novo E2E negativo — com `mcp.memtier` no `kilo.jsonc` do
     workspace, o plugin bootado **não** registra (FR-602 ponta a ponta).
  5. **D-13**: `timeout`/`enabled` do corpo do `add` agora assertados (unit
     `register_add_body_has_timeout_enabled` + E2E do MCP).
  `src/README.md` alinhado à API nova. Unit **228 · 219 pass · 0 fail · 9 skip**;
  E2E **10/10** com os três tokens; `tsc --noEmit` limpo. Revisão adversarial por
  subagente não rodou (infra `litellm:4000` fora do ar) — revisão inline.
  **E3b FECHADO**: os 5 checkboxes marcados e D-1..D-13 resolvidos.

- **2026-10-15 — E4-S1 (tracer bullet).** Fatia vertical mínima da ingestão
  assíncrona; a base sobre a qual S2..S5 endurecem (sem rewrite). Entrega:
  1. `src/ingest/{db,batch,state,routine}.ts` + `src/hooks/ingest.ts` +
     `client.ingest` + `config.ingest.*` + wiring em `src/index.ts`.
  2. **Fonte = banco, nunca o evento** (ADR-007): o hook `message.updated` só
     **acorda** a rotina (`void runIngest`); o conteúdo vem do `kilo.db`
     (user+assistant, remontado de `part.text`). Cursor por identidade
     `(time_created, id)`, **sem `OFFSET`** (ADR-008).
  3. **Fatos medidos contra o `kilo.db` real** (`~/.local/share/kilo/kilo.db`,
     16.724 msgs): `time_created` é **epoch ms** (confirma `referenceTime`); 40
     linhas `compaction`; `assistant:user ≈ 18:1`; só **7.998/16.728** com `text`
     (uma janela de 20 **linhas** traz ~2 com texto).
  4. **E2E real** `tests/e2e/test_e2e_ingest.test.ts` (gated `E2E=1`, token
     `E2E_INGEST_TOKEN`/`E2E_TOKEN` escopo `alfa`): `kilo.db` real → hook →
     `/v1/ingest` **202** e o efeito do outro lado (o fato aparece no
     `/v1/recall` real). Medido **2/2** verde (~65 s pelo worker serial).
  5. **Unit** `tests/ingest.test.ts` (33 casos): hash determinístico, limiar,
     localização do banco, cursor por tupla, degradação do estado, trava por
     sessão, `client.ingest` (202/401/503). Unit **264 · 252 pass · 0 fail ·
     12 skip**; `tsc --noEmit` limpo.
  6. **Revisão adversarial** (agente nomeado `adversarial`, não inline) em
     `ce5b219`: 12 achados + 2 não-achados. Triagem: o SUSPECT "unidade de
     `time_created`" foi **medido e refutado** (é ms). Gap real **material**:
     o limiar conta **linhas**, não mensagens com texto — o lote enviado sai bem
     menor que o `batch_size` configurado (~2/20 medido). Os demais achados
     (falha transitória do `part` avançar o cursor; backend cacheado sem retry
     nem `close()`; linha veneno silenciosa; `max_hashes` não aplicado; reset do
     L-3 sem log) ficam como **`TODO(tracer-bullet)`** para S2/S4 — a fatia 1 é
     mínima por desenho.
  7. `rg "TODO\(tracer-bullet\)" src/` → **6** marcadores (todos da E4, cada um
     mapeado à story que o resolve). O épico só fecha quando zerar.

- **2026-10-15 — E4-S2 (endurecer cursor + idempotência).** Sobre a base da S1,
  sem rewrite.
  1. **Discriminação do `OFFSET`** (padrão E3a/E3b): dois testes provam que o
     cursor por `(time_created, id)` não pula. O de banco **falso** reproduz o
     defeito medido (remover 20 linhas antes do cursor ⇒ o `OFFSET` numérico
     retoma 20 posições adiante; o cursor por tupla retoma na linha seguinte). O
     de **SQLite real** (`node:sqlite`) reproduz a prova do ADR-008: 40 linhas
     removidas antes do cursor ⇒ `PULADAS = 0`.
  2. **Falha de leitura transitória** (defeito da revisão adversarial da S1):
     `readBatch` agora **lança** `IngestReadError` quando a query de `message`
     ou de `part` falha (SQLITE_BUSY/WAL), em vez de tratar como "sem texto" e
     avançar o cursor — a mensagem é relida no próximo gatilho. A rotina degrada
     em log (nunca fatal) e **não envia** lote incompleto.
  3. **Linha veneno** (`data` não-JSON): avança (é irrecuperável) mas é
     **registrada** (`ingest: linha ilegível ignorada id=…`), nunca silenciosa.
  4. **Backend retentável + `close()`**: `createBackendProvider` não cacheia
     falha de abertura (o próximo evento tenta de novo — antes ficava inutilizado
     até um restart) e o `dispose` do plugin fecha o handle. (Defeitos F6/F10 da
     revisão.)
  5. **Semântica do limiar** (`rows`, não mensagens com texto) **pinada por
     teste** e documentada como sanção do ADR-007 §4.4 (idêntica ao antecessor).
  6. **E2E real** (gated `E2E=1`): novo caso "reprocessar o mesmo lote NÃO
     duplica o grafo" — força o cenário do L-3 (cursor ao início, hash preservado)
     e prova, pelo conjunto de **UUIDs de episódio** do `/v1/recall`, que o grafo
     não cresce. Mesma suíte: 3/3 verdes contra o memtier vivo.
  7. Unit **277 · 264 pass · 0 fail · 13 skip**; `tsc --noEmit` limpo.
     `rg "TODO\(tracer-bullet\)" src/` → **1** (o reset do L-3, que é da S4).

- **2026-10-15 — E4-S3 (`session.idle` drena tudo, inclusive o resto).** Sobre a
  base das S1/S2, sem rewrite.
  1. **Uma rotina, um parâmetro** (ADR-007): `ingestOnce`/`runIngest` ganham
     `drainAll`. `message.updated` ⇒ `false` (respeita o limiar); `session.idle`
     ⇒ `true` (o limiar **não** barra; o resto < lote é enviado). O hook resolve
     o `drainAll` pelo `event.type` — não há duas implementações.
  2. **Laço de dreno**: com `drainAll`, repete passadas até `pendentes == 0`
     (decisão 4: "concluído" é nada pendente). Terminação garantida pelo avanço
     do cursor; um passo sem progresso encerra o laço, e há teto (10.000) de
     segurança. Corrige o defeito do antecessor (`caughtUp` com resto ⇒ mensagens
     presas para sempre).
  3. **Trava por sessão** cobre o dreno concorrente (`session.idle` pode repetir):
     a trava serializa as passadas e o cursor não avança duas vezes.
  4. **Unit**: exemplo do dono (`63 = 3×20 + 3`), `5 ⇒ 1 lote de 5`, `0 ⇒ não
     dispara`, a **diferença dos gatilhos** (abaixo do limiar: `message.updated`
     não envia / `session.idle` envia) e o dreno concorrente sem corrupção.
  5. **E2E real** (gated): novo caso `session.idle` drena o **resto** — 23 msgs
     com `batch_size=20` ⇒ 1 lote de 20 + 1 de 3, cursor cobre as 23
     (`pendentes == 0`), e o marcador do **resto** (na última mensagem) aparece no
     grafo. Medido **4/4** verdes contra o memtier vivo.
     **Defeito de ambiente medido e contornado:** o worker do memtier é **serial
     e compartilhado** (`add_episode` ~70–115 s/job) e o workspace `alfa` acumula
     execuções; fatos de mesmo sentido **contradizem** e a supersessão os esconde
     do recall. Correção no teste (não no produto): cada execução usa um projeto
     **único** no marcador (sem contradição) e o teto de espera do worker subiu.
  6. Unit **283 · 269 pass · 0 fail · 14 skip**; `tsc --noEmit` limpo.
     `rg "TODO\(tracer-bullet\)" src/` → **1** (o reset do L-3, que é da S4).

- **2026-10-15 — E4-S4 (limitações L-1/L-2/L-3 como critério de aceite).**
  Endereçadas na implementação (não só documentadas), sobre a mesma base.
  1. **L-1 — incerteza auditável.** O estado passa a guardar `sentBatches`:
     `{ hash, job_id, reference_time, accepted_at, confirmed:false }`. O `202`
     confirma o **aceite**, não o processamento; `confirmed:false` **é** o
     registro da incerteza; o log do envio traz `accepted_not_confirmed=true`.
     **Nenhum** mecanismo de reenvio ou de espera por confirmação foi criado
     (decisão do dono). Teste: um lote cujo worker "morre" **não** é reenviado,
     e a auditoria permite identificá-lo.
  2. **L-2 — teto por workspace.** `markBatchSent`/`markBatchAccepted` aplicam
     teto **FIFO** (`DEFAULT_MAX_HASHES = 5000`, configurável por
     `ingest.max_hashes`; `<=0` = ilimitado). Teste prova que o número de hashes
     **não cresce indefinidamente** (ultrapassar evicta os mais antigos). Por que
     teto e não TTL: determinístico e testável (decisão do ADR-008).
  3. **L-3 — degradação explícita.** `loadState` ganha `onReset`; a rotina
     **registra** o reset (arquivo ausente **ou** JSON corrompido), com dedup por
     (caminho, classe) para não repetir a linha a cada gatilho. Teste cobre os
     dois casos (degradam sem lançar, registram o reset) e o comportamento
     definido (estado perdido ⇒ reenvio, consequência documentada — não defeito).
  4. Unit **290 · 276 pass · 0 fail · 14 skip**; `tsc --noEmit` limpo.
     `rg "TODO\(tracer-bullet\)" src/` → **zero**.

- **2026-10-15 — E4-S5 (fechamento: prova viva + docs + revisão adversarial).**
  1. **Revisão adversarial (3 perfis paralelos, agentes nomeados):** BLIND-HUNTER,
     EDGE-CASE-HUNTER e VERIFICATION-GAP. Achados materiais **corrigidos na
     mesma base** (sem rewrite), cada um com teste de discriminação:
     - `part.data`/`message.data` = `null`/JSON escalar lançava `TypeError` →
       virava `IngestReadError` ("transitório") ⇒ **cursor travado para sempre**.
       Agora não-objeto é linha veneno: pula, avança e reporta.
     - `time_created` `NULL` virava epoch **0** (`Number(null)`) ⇒ `reference_time`
       de 1970. Agora só número/string numérica; `NULL` é pulado.
     - `batch_size` `<=0` passava na config (`LIMIT 0`/`LIMIT -n` = varredura/trava).
       Novo `resolvePositiveInt`: `<=0`/inválido cai no default.
     - `session.idle` chegando **durante** uma passada de `message.updated` era
       **descartado** (trava por sessão) ⇒ resto preso (fere a decisão 4). Agora o
       dreno é **consolidado** (`pendingDrain`) e absorvido por quem tem a trava.
     - Corrida de estado entre **sessões diferentes** (trava só por sessão;
       `loadState`→`saveState` não atômico entre elas) perdia cursor/hash. Novo
       **mutex por workspace** serializa a transação ler-modificar-gravar.
     - `loadState` com JSON válido de shape errado (`[]`, `123`, `"x"`) resetava
       **em silêncio** (fere o L-3). Agora reporta `shape inválido`.
     - **Discriminação do `OFFSET`**: o teste antigo não reprovava (o fake ignorava
       `OFFSET`). O teste real-sqlite agora deleta **estritamente antes** do cursor
       + guarda de **shape do SQL** (falha se `readBatch` emitir `OFFSET`).
  2. **Lacunas de verificação fechadas com teste:** emissão do log L-1
     (`accepted_not_confirmed=true`) e do L-3 (linha de reset, com dedup);
     encanamento `config→ingestOnce` do `max_hashes` (FIFO medido pela rotina);
     `ingest.*` na `config.test.ts` (defaults, env, clamp). Novo sink de log
     injetável (`__setLogSink`) só para teste — produção segue escrevendo no `/tmp`.
  3. **Aceito e documentado (não reabre ADR):** dedup por conteúdo é
     **global por workspace** (hash = djb2 `role\0content`, ADR-008 §3) — dois
     lotes de conteúdo idêntico em sessões distintas são deduplicados (sanção, não
     defeito); a janela entre o `202` e o `saveState` pode duplicar num crash
     (sem idempotência no servidor — ADR-008 rejeitou `idempotency_key`).
  4. **Docs coerentes:** `ARCHITECTURE.md` (§1 diagrama, §2 corpo do `/v1/ingest`,
     §3 árvore, §4 fluxo, §6 envs, §7 adaptador, §8 degradação, §9 log),
     `src/README.md` e o **README raiz**/**PRD** deixaram de descrever
     `chat.message`+debounce. `RUNBOOK-E2E.md`: token da suíte `ingest`, nota do
     worker serial e contagem **14/14** (medida).
  5. **Prova viva:** E2E canônico do RUNBOOK **14/14** contra a stack real
     (memtier vivo + worker): lote real ⇒ grafo; `message.updated` abaixo do
     limiar não reenvia; `session.idle` drena o resto; reprocessar não cria
     episódio novo.
  6. Unit **304 · 290 pass · 0 fail · 14 skip**; `tsc --noEmit` limpo;
     `rg "TODO\(tracer-bullet\)" src/` → **zero**. **Épico E4 FECHADO.**

- **2026-10-15 — Provisionamento do workspace 1:1 + escopo por workspace (sem
  número de epic).** Capacidade nova, fora da taxonomia E1–E7 (o **E5** deste
  backlog é **Degradação**; os comentários chegaram a rotular o provisionamento
  como "E5" — rótulo removido). Entrega:
  1. `src/provision.ts`: com `KILOCODE_GRAPH_MANAGER_TOKEN` (env) e a chave do
     workspace ausente, roda o plano de controle do memtier no boot
     (program→workspace→invite→claim-user→**rotate**) e grava
     `<workspace>/.kilo/graph-key.json` (`0600`). **A rotação é obrigatória**
     (bearer de claim ⇒ 403 `rotation_required` no plano de dados).
  2. **Escopo por workspace:** `loadConfig(options, dir)` lê o
     `<dir>/.kilo/graph-plugin.json` do diretório resolvido no runtime
     (`ctx.worktree` > `ctx.directory` > cwd) — nunca `process.cwd()`; merge
     **profundo** global↔workspace; `token_file` **confinado** ao workspace; o
     `kilo.db` vem da **regra do runtime** (`Path.data` = `XDG_DATA_HOME ??
     ~/.local/share` + `/kilo`, com `KILO_DB`; [ADR-010](docs/adr/010-fonte-do-kilo-db.md)),
     não de env var (removida `KILOCODE_GRAPH_INGEST_DB_PATH`).
  3. **Revisão adversarial (3 perfis) + correções.** Achados materiais corrigidos
     na mesma base, cada um com teste de discriminação: **estrutural** —
     `workspaceName` colidia em saneamento/truncamento (novo sufixo de hash do
     caminho ⇒ injetividade dir→workspace nas fronteiras lossy); cache de token
     fixava `""` (não relia chave que aparecesse depois); `token_file` absoluto
     escapava do workspace; `env` só-espaços (`URL`/`PROGRAM`/`TOKEN`) era
     honrada; `manager_token` desligado só-espaços; `.tmp` de provisionamento
     colidia entre boots + modo não reaplicado + `.tmp` órfão; `keyFile` vazio
     queimava um bearer; `rotate` que ecoasse o claim seria persistido.
     **Refutados por medição** (não eram defeitos): `POST /v1/mgmt/workspaces`
     duplicado devolve **200** idempotente (não 409); `rotate` do memtier real
     **sempre** emite token novo (`iam.py:1334`, burn-and-replace).
  4. **Cobertura:** `tests/provision.test.ts` (16 casos, `fetch` fake: 5 passos,
     bearer por rota, 409/200, cada falha, concorrência, `hasUsableKey`,
     `writeKeyFile`), `tests/token-file.test.ts` (confinamento),
     `tests/config.test.ts` (discriminação `dir` vs cwd + merge profundo),
     `tests/client.test.ts` (token que aparece depois). **E2E real**
     `tests/e2e/test_e2e_provision.test.ts` (gated `E2E=1` + `E2E_MANAGER_TOKEN`):
     boot → cria → grava `0600` → a chave **autentica** em `/v1/recall` (200 ⇒
     rotacionada) → 2º boot não reescreve; sem gestor ⇒ nenhuma chave. Medido
     **2/2** contra o memtier vivo (gestor emitido pelo admin e rotacionado).
  5. Unit **343 · 327 pass · 0 fail · 16 skip**; `tsc --noEmit` limpo. Tabela de
     verificação por afirmação em `src/README.md`.

- **2026-10-15 — `workspaceName` = `<stem>-<sha1 8>` (sempre) + override de
  identidade.** Decisão do dono: anexar **sempre** o `sha1` curto do caminho ao
  nome do workspace memtier (`kilocode-graph-plugin-<sha1 8>`), para minimizar
  colisões — substitui o desenho anterior (hash só como fallback/sufixo de
  saneamento) e elimina a limitação de colisão de basename puro.
  1. `src/workspace.ts`: `workspaceName(dir)` = `<stem>-<sha1 8 do caminho
     resolvido>`, sempre. `stem` = basename saneado (charset da borda); vazio ou
     reservado ⇒ `ws`. Teto de 64 (o `stem` trunca para caber o sufixo).
     Injetivo em todas as fronteiras (basename idêntico, saneamento, truncamento).
  2. **Override `daemon.workspace`** (env `KILOCODE_GRAPH_WORKSPACE`, default
     vazio): setado, é a identidade usada **como veio** (sem hash) e vence o
     derivado. Necessário porque o memtier escopa o bearer ao nome **exato**
     (medido: `alfa` ⇒ 200; `alfa-1a2b3c4d` ⇒ **403**) — tokens pré-escopados
     (E2E legado, migração) pinam o nome.
  3. **Testes:** `tests/workspace.test.ts` reescrito para o contrato sempre-hash
     (`..._always_hashed`, `..._basename_collision` — o antigo
     `KNOWN_LIMITATION` virou `notEqual`); `config_workspace_override` no
     `config.test.ts`. E2E que usam token pré-escopado (`recall_inject`, `ingest`,
     `mcp`, `inject_code`) passam a pinar via `daemon.workspace` e assertam o
     derivado `<WS>-<sha1 8>`; `provision` passou a usar programa **único por
     execução** (um programa só é owned pelo gestor que o criou).
  4. **Prova viva (medida 2026-10-15):** provision **2/2**, health+recall_inject+
     inject_code **7/7** (1 falha transitória do provision por programa fixo já
     owned — corrigida para programa único), mcp+lifecycle+collector **5/5**.
     Unit **344 · 328 pass · 0 fail · 16 skip**; `tsc --noEmit` limpo.

- **2026-10-15 — Injeção: limites por endpoint (tokens) + fim do `max_chars` —
  `ADR-009` Bloco A (`S1`+`S2`).** Mudança de **arquitetura** sobre código em
  produção (E2/E3c implementados), não feature nova: refactor + contrato aditivo
  na **mesma base**, sem rewrite. Nenhuma mudança no memtier (plug-in-only).
  1. **Unidade única = tokens** (`chars/4`, o tipo do memtier). Morreram o
     `max_chars` (cliente, teto de chars do bloco conjunto) e o `max_tokens`
     **compartilhado** (servidor); o `ADR-004` fica marcado como **superado**.
  2. **Um teto por endpoint** (o campo `max_tokens` já existe por body): saem
     `inject.max_chars`/`inject.max_tokens`, entram `inject.memory_max_tokens`
     (`KILOCODE_GRAPH_INJECT_MEMORY_MAX_TOKENS` → `/v1/recall`) e
     `inject.code_max_tokens` (`KILOCODE_GRAPH_INJECT_CODE_MAX_TOKENS` →
     `/v1/code/search`), default `2000` cada. `max_memories`/`max_code_chunks`
     **permanecem** como cortes de contagem.
  3. **`applyBudget`/`applyJointBudget` só contagem:** removidos `maxChars` e os
     callbacks `render`/`RenderFacts`/`RenderTotal`. Sem teto conjunto no cliente
     (a decisão do dono é per-endpoint); corte sempre por fato/chunk inteiro.
  4. **Migração de config — exceção registrada:** as chaves `inject.max_chars`/
     `inject.max_tokens` (declaradas pelo **E2/E3c**, ver entradas acima) são
     **reescritas** pela `S1`. Envs legadas setadas ⇒ **um** log de aviso de
     depreciação (depreciação + chave substituta), nunca silêncio. Chaves antigas
     em `options`/arquivo são ignoradas (env/arquivo/options só leem as novas).
  5. **Robustez:** `resolveTokenCap` clampa o teto a `[1, 16000]` (`<=0` e
     `>MAX_RESPONSE_TOKENS` são **422** no servidor) — o cliente nunca envia
     acima do teto interno.
  6. **Testes (S1 unit):** `config` (novas chaves, defaults, aviso das legadas,
     clamp), `inject` (`recall_body_uses_memory_tokens`, orçamento só-contagem),
     `code_s2` (`code_body_uses_code_tokens`, `endpoints_independent`,
     `joint_budget_counts_only`, `hook_joint_budget`). **E2E (S2):**
     `tests/e2e/test_e2e_inject_limits.test.ts` (gated `E2E=1`, workspace `alfa`):
     teto de memória corta só a memória, teto de código corta só o código, e os
     dois tetos não se misturam — evidência é o **bloco injetado**, não o retorno
     da chamada.
  7. **Docs:** `ARCHITECTURE.md` §6 (tabela de config + envs), `src/README.md`
     (envs + tabela de verificação), `docs/RUNBOOK-E2E.md` (suíte nova, glob
     **19/19**).
  8. **Prova viva (medida 2026-10-15):** `bun run typecheck` limpo; unit
     **336 · 0 fail · 16 skip**; `E2E=1` (glob, quatro tokens)
     **19 · 19 pass · 0 fail · 0 skip**; `rg
     "max_char|maxChars|INJECT_MAX_CHARS|INJECT_MAX_TOKENS" src/` → **zero**.
      Revisão adversarial (BLIND-HUNTER/EDGE-CASE-HUNTER/VERIFICATION-GAP em
      paralelo, agentes nomeados): achados materiais corrigidos na mesma base
      (testes de body por endpoint ausentes; prosa obsoleta do orçamento conjunto;
      ausência de clamp do teto). **`S3` (piso `min_score`) fora de escopo —
      Bloco B, bloqueado pelo memtier.**

- **2026-10-16 — Correções da branch `feature/load-ignores` (loop de verificação
  adversarial).** Seis commits de fix/feat (`38b12dc`, `9a4705d`, `18e60b1`,
  `b095893`, `066238d`, `e74a464`) passaram por 3 revisores adversariais
  independentes (ingest/db, logging/client, code-index/debug) + auditoria
  doc/ADR/spec. Achados materiais corrigidos na **mesma base** (sem rewrite):
  1. **HIGH — `GIT_UNAVAILABLE` apagava o grafo.** Com `load_ignores=true` num
     diretório sem git, o indexer aborta com `error code=GIT_UNAVAILABLE` e 0
     chunks; o coletor tratava o stream como "full vazio" e marcava TODO o
     manifest como removido (`chunks:[]`) — limpava o workspace no memtier.
     Correção: `runner.ts` captura o evento `error` não-recuperável
     (`jobErrorFromEvent`, `recoverable` só quando **explícito**) e `collect.ts`
     **aborta sem sincronizar** quando há `result.error` (grafo preservado).
     Testes: `jobErrorFromEvent_*` (4) + `collect_job_error_aborts`/
     `collect_job_error_skips_removed`.
  2. **HIGH — `typecheck` vermelho.** `types.ts` `Config.code_index` sem
     `load_ignores`; `hooks/messages.ts` anotava `injection` como `{block}` e
     perdia `facts`; `index.ts` passava resolver síncrono onde `DbPathSource`
     exigia `Promise`. Correções: `load_ignores: boolean` no tipo; `injection:
     InjectionResult`; `DbPathSource = string | (() => string | Promise<string>)`
     (resolução síncrona in-process não paga o custo de virar Promise). `tsc`
     exit 0. Teste: `debug_dump_counts_facts` (a contagem volta ao dump).
  3. **HIGH — `provision.ts` bypassava o teto de erro HTTP.** 5 call sites
     passavam `res.text()` cru a `httpError` (medido: `message` de 4 MB). O cap
     subiu para **dentro de `httpError`** (defesa em profundidade) e
     `extractHttpDetail` agora mantém a marca de corte **dentro** do teto (antes
     a estourava em ~27 chars; a lista de `msg` cortava **sem** marca). Testes:
     `httpError_caps_detail`, `extractHttpDetail_never_exceeds_cap`.
  4. **MED — teto de texto do chunk.** `capChunkText` (marca dentro do teto)
     aplicado **também ao `Symbol`** (um símbolo >100k derrubava o lote); md5
     recalculado só quando houve corte (idempotência preservada sem corte); o
     `FullFile` sintético usa `end_line` do texto **enviado**. Testes:
     `capChunkText_*`, `fullfile_truncation`, `symbol_truncation`,
     `symbol_no_truncation_keeps_indexer_md5`.
  5. **MED — `log()`/`debug()` sem teto.** O cap existia só em `logFatal`; agora
     `log()` trunca com marca dentro do teto (timestamp/prefixo entram na conta).
     Testes: `logFatal_respects_cap_exactly`, `log_caps_direct_giant`.
  6. **MED — regra do db.** `XDG_DATA_HOME` relativo agora é **ignorado**
     (resolveria contra o cwd). Teste: `db_runtime_path_xdg_relative_ignored`.
     Comentários stale (deadlock via `client.path.get`, canal `KILO_DISABLE_CHANNEL_DB`
     não implementado) corrigidos. Fonte documentada em **ADR-010**.
  7. **Binário do indexer.** `rust-ast-indexer` `master` (`77f5b10`, via
     `feature/load-ignores`) reconstruído: `cargo build --release --bins` ⇒ binário
     com `load_ignores` + `GIT_UNAVAILABLE` (sem ele, `load_ignores` é no-op no
     plugin — o CLI não parseava o campo).
  8. **Docs.** `README.md`/`ARCHITECTURE.md`/`BACKLOG.md`: fonte do `kilo.db`
     corrigida (`Path.state` → `Path.data`, ADR-010); `code_index.load_ignores`
     nas 3 tabelas (env/JSON/`specs/e1`); `specs/e4` e o fake do E2E alinhados à
     regra (`KILO_DB`); path do binário no RFC-002 corrigido.

- **2026-10-16 — Segunda rodada adversarial (BLIND-HUNTER / EDGE-CASE-HUNTER /
  VERIFICATION-GAP) sobre as correções acima.** Achados novos, corrigidos na
  mesma base (sem rewrite), cada um com teste:
  1. **HIGH — o erro fatal se perdia no timeout.** `runner.ts` só carregava o
     `jobError` em `close`/`job_completed`; `INVALID_PAYLOAD`/`INVALID_COMMAND`
     fazem **early-return sem `job_completed`** e deixam o processo vivo até o
     timeout — que descartava o erro e reintroduzia o wipe do grafo. Agora o
     timeout, o `exit!=0` e o `close` limpo propagam o erro corrente, e um erro
     fatal **encerra o job na hora** (não espera `job_completed`). Testes:
     `runIndexer_error_event`, `runIndexer_error_no_completed`,
     `runIndexer_recoverable_error`.
  2. **HIGH — `console.error` de `logFatal` estourava o teto.** A perna do
     console imprimia a linha PRÉ-corte (~8219 > 8192) — o vetor que travou a UI.
     Agora passa por `truncateLine`; a dupla truncagem `logFatal`→`log` deixou de
     subnotificar o total descartado. Teste: `logFatal_console_leg_bounded`.
  3. **MED — `capChunkText` partia par substituto.** Corte em UTF-16 deixava
     surrogate solto (Unicode inválido) com emoji na fronteira. Novo
     `sliceWholeChars` recua 1 unidade. Teste: `capChunkText_never_splits_surrogate_pair`.
  4. **MED — `end_line` stale após corte.** `toChunk` mantinha o `end_line` do
     indexer mesmo cortando o texto (60.000 linhas → 44.995 enviadas). Agora
     reflete o texto emitido. Testes: `symbol_truncation_end_line`,
     `fullfile_truncation` (fixture multilinha + limite inferior).
  5. **MED — md5 dessincronizado com `text` ausente.** `toChunk({text:undefined})`
     virava `""` mas conservava o md5 do indexer. Agora recalcula quando o texto
     enviado difere do original. Teste: `toChunk_non_string_text_recomputes_md5`.
  6. **LOW — `jobErrorFromEvent(payload=[])`.** Array passava no `typeof object` e
     virava falso-fatal `UNKNOWN`; agora rejeitado. Teste:
     `jobErrorFromEvent_array_payload`.
  7. **Robustez — EPIPE assíncrono no stdin.** `child.stdin.write` podia emitir
     `error` depois do retorno (processo já morto) e virar `uncaughtException`;
     handler de `error` no stdin adicionado (exposto pelos novos testes de spawn).
  8. **Prova end-to-end do cap no `provision`.** O cap central de `httpError`
     cobre os 5 call sites; teste com body de 4 MB prova que `logFatal("provision")`
     fica ≤8192 e preserva a msg útil. Teste: `provision_error_body_bounded`.
  9. **Docs/testes refinados:** asserção auto-referente de `end_line` corrigida;
     `debug_dump_counts_facts` agora exige a contagem exata (`2 itens`);
     `KILO_DB` vazio/whitespace/subpath e `XDG_DATA_HOME` com espaços cobertos;
     fake do E2E alinhado ao shape real do SDK (`{state,config,worktree,directory}`).
  `KILO_DB` relativo com `..` **mantido sem sanitização** de propósito (espelha a
  regra do runtime — divergir apontaria para outro banco) e documentado.
  Unit **403 · 384 pass · 0 fail · 19 skip**; `tsc --noEmit` limpo.

- **2026-10-20 — Relevância do RAG de código: `labels`, piso `min_score` e
  clamp do teto (D5–D8).** Fecha a lacuna medida no uso real: (a) a busca
  injetava arquivo inteiro em vez do trecho, (b) `16384` de
  `KILOCODE_GRAPH_INJECT_CODE_MAX_TOKENS` no `.bashrc` virava 2000 em silêncio,
  e (c) não havia como cortar resultado irrelevante.
  1. **`inject.code_labels`** (default `["CodeSymbol"]`, CSV/JSON array na env
     `KILOCODE_GRAPH_INJECT_CODE_LABELS`) vai no body de `/v1/code/search`. O
     default do **servidor** não muda (`CodeChunk`); a tool MCP segue igual.
     Lista vazia/inválida ⇒ default (`labels: []` é 422).
  2. **`inject.code_min_score`** (default **ausente** = desligado;
     `KILOCODE_GRAPH_INJECT_CODE_MIN_SCORE`) envia `min_score` aditivo ao
     `/v1/code/search`. O servidor filtra por `raw_score` (magnitude) antes do
     `limit` — o cliente **não** re-filtra por score (D6). Calibração no corpus
     real fica para a próxima entrega; só depois o default vira um valor medido.
  3. **Clamp do teto (D8):** `resolveTokenCap` clampa `>16000` para `16000`
     **com log**, em vez de cair no default; `<1`/inválido ⇒ default com log;
     string vazia ⇒ "não configurado", sem log. Corrige a perda silenciosa
     acima. Nota de operação (fora do repo): trocar o `16384` do `.bashrc` por
     `16000` — o valor explícito documenta a intenção e dispensa o clamp.
  4. **Degradação visível do piso:** servidor anterior ao campo ignora
     `min_score` em silêncio; quando algum chunk volta sem `raw_score`, a
     injeção loga **uma vez por turno** (uma por chamada no caminho avulso
     `searchAndFormat`) que aqueles chunks seguiram sem filtro
     (`code_search: min_score=… NÃO honrou o piso`). Piso honrado ⇒ nenhum log.
  5. **Contrato do chunk:** `CodeChunkHit.raw_score?` (opcional — servidor
     antigo não manda). `score` continua a ordem (RRF normalizado).
  6. **Hermeticidade dos testes:** em `tests/config.test.ts`, `clearEnv()` passa
     a limpar todo `KILOCODE_GRAPH_*` por prefixo (a lista fixa deixava o env do
     `.bashrc` vazar e dois testes falhavam sem defeito de runtime).
  7. **Desvio consciente do texto do plano:** o plano pede aviso quando
     **nenhum** chunk traz `raw_score`; a implementação avisa quando **algum**
     chunk não traz. Motivo: um servidor parcialmente compatível (ou um proxy
     que remova o campo em parte da resposta) degradaria em silêncio
     justamente nos chunks que ficaram sem o campo. Teste:
     `code_floor_partial_raw_score_still_warns`.
  8. **Verificação:** `tsc --noEmit` limpo; `npm test` **527 · 507 pass · 0 fail ·
     20 skip** (os 20 skip são E2E gated `E2E=1`). E2E do piso contra stack real
     fica para a entrega de calibração (o piso está desligado por default).

- **2026-10-30 — E8 especificada a partir da RFC-001 rev. 5:**
  O memtier v1.1.0 fechou os achados 1/2/5 no servidor; o que resta é plugin.
  A spec [`specs/e8-stories.md`](specs/e8-stories.md) cobre os itens 3a, 3b, 4a,
  6, 8 e 9 do Encaminhamento da RFC.
  1. **`score` não é injetado** (achado 3c, descartado). Medido em 3 consultas
     reais: o top-1 é `1.0` **por construção** (RRF normalizado pelo top-1 da
     própria consulta). O valor não é comparável entre itens nem entre consultas;
     a ordem já transmite o ranking. O aceite testa a **ausência**.
  2. **Marcador único `[id=<uuid completo>]`** nos dois blocos (memória e
     código) e `[ep=<uuid> +N]` para o primeiro episódio. O uuid vai com **36
     chars**: é a entrada exata que as tools exigem, e um id truncado devolve
     `[]` **em silêncio** (o pior modo de falha — o modelo não vê erro).
  3. **`episodes`: primeiro + `+N`.** 100% dos fatos amostrados (15, em 3
     consultas) têm exatamente 1 episódio; injetar todos custaria ~36 chars cada
     sem ganho.
  4. **`depth` no plugin descartado** (achado 5a). Navegação é **pull**; `depth>1`
     no push troca precisão por recall no caminho crítico, e a medição do
     RFC-004 D6 mostra que o ganho é de volume (4,3 → 19,6 vizinhos), não de
     alcance.
  5. **Dedup do turno passa a usar o `uuid`**, com fallback para o texto
     (`factKey`). Hoje a chave é `f.fact`, que colapsa fatos distintos de mesmo
     texto. O dedup de **código não muda** (`path:start-end`): é guarda local do
     turno, e depender de `uuid` deixaria de deduplicar com servidor antigo.
  6. **Instrução em `system.transform` derivada do estado real**: o MCP é
     registrado **por servidor**, não por tool, então a derivação só alcança
     `mcp.enabled` e `code_index.enabled` (o conteúdo; `inject.code_enabled` é
     push e não governa a tool). `ingest`/`code_sync` **nunca** são
     anunciadas (são escrita). Chave nova `inject.instruction_enabled`
     (default `true`, efetiva só com `inject.enabled=true`).
  7. **E8 é tracer bullet na S2**: `system.transform` é superfície nova, nunca
     exercitada neste plugin; a S1 é aditiva e não usa a fatia. Registrar assim,
     como manda o protocolo do BACKLOG.
  8. **Pré-requisito de documentação:** as correções do item 7 da RFC-001
     (README, ADR-006, ARCHITECTURE, PRD e o E2E do MCP) estão em **stash**, não
     aplicadas — e a RFC ainda as declarava "feitas". Item 7 des-riscado.
     Aplicar **antes do fechamento (S3)**; não bloqueia S1/S2.

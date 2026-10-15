# BACKLOG — kilocode-graph-plugin

> Priorização: o que desbloqueia valor primeiro. Base: `docs/PRD.md §5–§7`,
> `docs/ARCHITECTURE.md`, `docs/SPIKE-FINDINGS.md`, `docs/adr/`, `src/README.md`.
> Espelho da convenção do [`../graphiti-daemon/BACKLOG.md`](../graphiti-daemon/BACKLOG.md).

**Ordem de implementação (primeira onda):** E1 → E2 → E3a → E3b → E3c.
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

### E3b — Registro do MCP do memtier
- [x] **E3b-S1** — Tracer bullet: registrar o MCP remoto no boot (`status`→`add`→`connect`)
- [x] **E3b-S2** — Endurecer: idempotência (não duplicar se já definido), degradação não-fatal
- [x] **E3b-S3** — Fechamento: prova de tools listáveis/chamáveis, docs, zero marcadores
- [ ] **E3b-S4** — **Corrigir os defeitos da revisão adversarial postergada** (D-1..D-10): vírgula final no JSONC derruba o override (D-3); precedência de `kilo.jsonc` sombreia o override (D-4); MCP fica morto e mudo em `disabled`/`connecting`/`disconnected`/`error` — regressão face ao antecessor (D-6); `409` de concorrência vira FATAL sem retry (D-7); `mcp.name` cru nos path params (D-8); token só-espaços vira header (D-9); `memtier: false` não bloqueia (D-10); junção ingênua de URL corrompe base com query/fragment (D-5)
- [ ] **E3b-S5** — **Fechamento do E3b-S4**: comando E2E documentado tem de ser verde com o token certo (D-1/D-2 — `e2e-tok-a` é escopo `alfa`, não o workspace do teste); cobrir `scheduleMcpRegistration` (D-11), o caso negativo "já definido ⇒ não registra" ponta-a-ponta (D-12) e o `timeout`/`enabled` do `add` (D-13)

### E3c — Injeção de código
- [x] **E3c-S1** — Tracer bullet: `code_search` → bloco de código no `messages.transform` (part separado)
- [x] **E3c-S2** — Endurecer: paralelismo com o recall, orçamento do total (`maxChars`), dedup do chunk
- [x] **E3c-S3** — Fechamento: E2E real contra o memtier, docs, zero marcadores

### Segunda onda (spec sob demanda)
- [ ] **E4** — Ingestão assíncrona (fila por sessão, debounce)
- [ ] **E5** — Degradação (memtier/indexer fora do ar ⇒ turno segue)
- [ ] **E6** — Multi-CLI (adaptador OpenCode; Claude Code)
- [ ] **E7** — Observabilidade (log de recall/coleta, flag de debug)

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
- As 4 tools (`recall`/`ingest`/`code_search`/`code_sync`) ficam disponíveis.
- Registro é implícito (o usuário não define nada em `kilo.jsonc`).
- Se já definido lá, o plugin não registra por cima.
- Falha de registro é logada, nunca fatal.

**Fora de escopo:** navegação `neighbors` (não é tool MCP no memtier).

---

## Pendências conhecidas de contrato (medidas 2026-10-14, antes da primeira onda)

Não bloqueiam a E1; **bloqueiam a E3a**. Ficam registradas para não serem
redescobertas no meio do loop.

1. **"Todos os arquivos removidos" não é representável.** `CodeSyncBody.files`
   tem `min_length=1` (`graphiti-daemon/src/memtier/main.py:710`), então o
   coletor não consegue zerar o grafo de um repo esvaziado. O caso coberto pela
   E3a-S3 é a remoção **individual** (`chunks: []` por arquivo — o campo `chunks`
   não tem mínimo). Decidir: aceitar a limitação e documentar, ou pedir campo
   aditivo ao memtier.
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
  Segunda onda (E3c, E4, E5, E6, E7) fica com spec sob demanda.

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

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
- [ ] **E2-S3** — Fechamento: E2E real contra o memtier, docs, zero marcadores

### E3a — Coletor de código
- [ ] **E3a-S1** — Tracer bullet: spawn do indexer → `chunk_emitted` → `POST /v1/code/sync` (1 arquivo)
- [ ] **E3a-S2** — Arestas: `import_edge`/`call_edge` → `edges[]` (resolver alvo; descartar órfã)
- [ ] **E3a-S3** — Ciclo de vida: manifest por workspace → removidos com `chunks: []`; idempotência por `chunk_md5`
- [ ] **E3a-S4** — Trigger híbrido + backpressure (`pause`/`resume`) + paginação do sync
- [ ] **E3a-S5** — Fechamento: E2E do ciclo de vida real, docs, zero marcadores

### E3b — Registro do MCP do memtier
- [ ] **E3b-S1** — Tracer bullet: registrar o MCP remoto no boot (`status`→`add`→`connect`)
- [ ] **E3b-S2** — Endurecer: idempotência (não duplicar se já definido), degradação não-fatal
- [ ] **E3b-S3** — Fechamento: prova de tools listáveis/chamáveis, docs, zero marcadores

### Segunda onda (spec sob demanda)
- [ ] **E3c** — Injeção de código (`code_search` no `messages.transform`)
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

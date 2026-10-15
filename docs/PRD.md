# PRD — kilocode-graph-plugin (draft)

**Versão:** 0.2 (draft)
**Base empírica:** `~/spikes/007-graphiti-memory-migration/REPORT.md`
**Dependências:**
- `../graphiti-daemon/` (**memtier** — E1–E7/E11 + A1/A2/E12 implementados)
- `../rust-ast-indexer/` (**dependência de runtime do cliente** — binário externo)

**Antecessor:** [`chiarelli/kilo-openviking-plugin`](https://github.com/chiarelli/kilo-openviking-plugin)

> **Delta 0.2 (2026-10-14) — o plugin é o COLETOR de código.**
> O PRD 0.1 dizia "Indexar o repositório (é do `rust-ast-indexer`)" — verdadeiro,
> mas incompleto. O `rust-ast-indexer` **extrai** símbolos/chunks/arestas; o
> **memtier armazena e busca**; e **ninguém** descrevia quem faz a ponte. Essa
> ponte é do plugin: **rodar o indexer, agrupar `chunk_emitted` por arquivo,
> resolver as arestas e chamar `POST /v1/code/sync`**. O memtier tirou isso do
> escopo em 2026-10-07 (`BACKLOG.md` § "Fora do escopo do daemon", E8) e o
> spike 010 confirmou que o coletor **não existe** (`010-navegabilidade-codigo/README.md`).
> Sem ele, o E3 (injeção de código) não tem dados. Este delta adiciona o épico
> **E3a — Coletor de código**, o épico **E3b — Registro do MCP do memtier** e
> alinha o contrato com o estado real do memtier.

---

## 1. Problema

O `kilo-openviking-plugin` funciona, mas tem três limitações herdadas do provider:

1. **Memória sem curadoria** — o OpenViking não invalida fatos antigos. O spike
   mediu 49 pares do mesmo assunto, 0 idênticos, 183 clusters, 3 identidades
   conflitantes no corpus real.
2. **Sem RAG de código** — o plugin injeta memória de conversa, não o código do
   repositório. O agente re-lê arquivos que poderia receber prontos.
3. **Preso a uma CLI** — a lógica de memória vive dentro do plugin. OpenCode e
   Claude Code não se beneficiam.

## 2. Objetivos

1. **Injetar memória curada** no turno, dentro do orçamento de latência do hook.
2. **Injetar código do repositório** relevante ao prompt, via busca híbrida.
3. **Coletar e sincronizar o grafo de código** — executar o `rust-ast-indexer`
   (dependência do plugin), agrupar os eventos por arquivo e chamar o
   `/v1/code/sync` do memtier. É o que **popula** o objetivo 2.
4. **Expor o MCP do memtier ao Kilo** — registrar o servidor MCP remoto do
   memtier, para que o modelo use as ferramentas (`recall`, `code_search`,
   `code_sync`, `ingest`) sob demanda.
5. **Nunca bloquear o turno** — recall é síncrono; ingestão e indexação são
   assíncronas.
6. **Escopo por workspace** — a memória do projeto A nunca aparece no B.
7. **Degradar com elegância** — daemon (ou indexer) fora do ar ⇒ CLI segue sem
   memória/código.

## 3. Não-objetivos

- Implementar o servidor de memória (é do **memtier**).
- **Implementar o parser/chunker** — é do `rust-ast-indexer`, que é uma
  **dependência de runtime do cliente**. O plugin **não** reimplementa parsing:
  ele **executa o binário** e é o **coletor** dos eventos (agrupar por arquivo,
  resolver arestas, chamar `/v1/code/sync`). O binário é externo e configurável
  (não empacotado).
- **Reimplementar navegação de código** — `/v1/code/neighbors` é rota do
  memtier. O plugin consome via HTTP/MCP; não constrói grafo de arestas próprio.
- Substituir funcionalidades do Kilo (subagentes, sessões, permissões).

## 4. Personas

| Persona | Necessidade |
|---|---|
| **Dev no Kilo** | Retomar contexto sem reexplicar; receber o código certo sem buscar |
| **Dev alternando projetos** | Cada repo com sua memória isolada |
| **Dono do projeto** | Memória que não apodrece com o tempo; código indexado sem passo manual |
| **Operador** | Provar que o coletor não deixa chunk órfão ao crescer/encolher/deletar arquivo |

## 5. Requisitos funcionais

### Injeção

| ID | Requisito | Critério de aceite |
|---|---|---|
| FR-101 | Injetar memória relevante ao prompt no turno | Contexto aparece em `messages.transform` |
| FR-102 | Injetar chunks de código relevantes | Busca híbrida (`POST /v1/code/search`); top-N por relevância. **Depende de FR-501** (sem coletor, não há código indexado) |
| FR-103 | Respeitar orçamento de latência | recall < 4s (timeout do hook); medido 0,85s |
| FR-104 | Marcar memória como já consumida | Evita re-injeção no mesmo turno |
| FR-105 | Separar visualmente código de memória | Blocos distintos no contexto injetado |
| FR-106 | Controlar o volume injetado | Config: `maxMemories`, `maxCodeChunks`, `maxChars` |
| FR-107 | Orçar a resposta no servidor | Passar `max_tokens` (A1) às buscas; respeitar `tokens_estimated`/`truncated` |
| FR-108 | Endereçar o par (programa, workspace) | Campo `program` aditivo (E11; default `"default"`) em toda rota |

### Ingestão

| ID | Requisito | Critério de aceite |
|---|---|---|
| FR-201 | Capturar a mensagem do usuário | O conteúdo vem do **`kilo.db`** pelo gatilho `message.updated` (o payload do evento não é fonte — ADR-007) |
| FR-202 | Enviar para a fila do daemon | `POST /v1/ingest` retorna 202 |
| FR-203 | **Nunca** bloquear o turno | Latência do hook não cresce com o tamanho do lote |
| FR-204 | Agrupar por sessão (limiar por lote, sem debounce por tempo) | Envia a cada `batch_size` linhas; o resto é drenado no `session.idle` (ADR-007) |
| FR-205 | Preservar contexto na compactação | Hook `compacting` sobrevive à summarização |

### Coleta e sincronização de código (o coletor) — **novo no delta 0.2**

| ID | Requisito | Critério de aceite |
|---|---|---|
| FR-501 | Executar o `rust-ast-indexer` | Binário **externo, caminho configurável** (`plugin.yaml`); o plugin nunca empacota o binário |
| FR-502 | Agrupar eventos por arquivo (estado completo) | `chunk_emitted` → `files[{file_path, language, chunks[]}]`; ≤1 `FullFile`/`Contextual` por arquivo (senão o sync responde 422) |
| FR-503 | Sincronizar o grafo | `POST /v1/code/sync` retorna 202 |
| FR-504 | **Detectar arquivo removido** e mandar `chunks: []` | O contrato do memtier **não** auto-deleta arquivo ausente do payload (spike 010, A1); o coletor mantém um **manifest por workspace** e envia `chunks: []` para o que sumiu |
| FR-505 | Resolver arestas `import`/`call` | `import_edge`/`call_edge` → `edges[{from_file, to_file, edge_kind, from_symbol_id?, to_symbol_id?}]`; **o alvo tem que existir** como `CodeChunk` (ADR-012 D3: alvo ausente → 422) |
| FR-506 | Idempotência por `chunk_md5` | Reenvio idêntico ⇒ `upserted=0`, `deleted=0`; sem duplicação |
| FR-507 | Trigger híbrido | **Full** (`index_path`) no 1º uso do workspace; **incremental** (`incremental_index` com `git_range`) depois. ⚠️ O indexer **não tem watch mode** — a detecção de mudança é do plugin (ver §10) |
| FR-508 | Tratar backpressure do indexer | Consumir `pause` → `resume`; nunca deixar o job travado (protocolo é two-way) |
| FR-509 | Ciclo de vida do arquivo | Cresce ⇒ sem órfão; encolhe ⇒ órfãos deletados; deleta ⇒ 0 chunks (medido no spike 010/F16) |
| FR-510 | Indexação fora do caminho crítico | Nunca `await` no turno; roda em background/start de sessão |

### MCP do memtier — **novo no delta 0.2**

| ID | Requisito | Critério de aceite |
|---|---|---|
| FR-601 | Registrar o MCP remoto do memtier **implicitamente** | `client.mcp.add` (`type:"remote"`, URL `…/v1/mcp`, header `Authorization: Bearer`) + `connect`, no boot do plugin; reuso de `registerOpenVikingMcp`. **O usuário não precisa definir nada em `kilo.jsonc`** |
| FR-602 | Não duplicar registro | Se `kilo.jsonc` já define o MCP do memtier, o plugin **não** registra por cima (idempotência); registro implícito é o caminho padrão |
| FR-603 | Ferramentas disponíveis ao modelo | `recall`, `ingest`, `code_search`, `code_sync` listáveis e chamáveis pelo agente |
| FR-604 | Degradação | MCP indisponível ⇒ turno segue; falha de registro é logada, nunca fatal |

> **Bloqueio cross-projeto (navegação):** `/v1/code/neighbors` (E12) **não é tool
> MCP** no memtier — existe só como rota HTTP (`src/memtier/tools/__init__.py`
> registra apenas `recall`, `ingest`, `code_search`, `code_sync`). **Navegação
> por código vizinho fica travada no plugin até o memtier expor a tool MCP.**
> Não é lacuna do plugin: é dependência do memtier. Enquanto isso, o plugin
> **não** promete navegação (nem a reimplementa).

### Escopo e configuração

| ID | Requisito | Critério de aceite |
|---|---|---|
| FR-301 | Workspace derivado do diretório do projeto | Hash/dir do projeto → nome lógico |
| FR-302 | Nenhum vazamento entre workspaces | Teste dedicado |
| FR-303 | Config por `plugin.yaml` + env vars | Nenhum valor hardcoded no script |
| FR-304 | Ativação/desativação por flag | Indexação e injeção desligadas por padrão |
| FR-306 | Caminho do binário do indexer configurável | `code_index.indexer_bin` no `plugin.yaml`; ausente ⇒ coletor desligado (não é erro fatal) |

### Multi-CLI (adaptadores)

| ID | Requisito | Critério de aceite |
|---|---|---|
| FR-401 | Kilo Code (referência) | Hooks JS — caminho de produção |
| FR-402 | OpenCode | Mesmo mecanismo de hooks |
| FR-403 | Claude Code | Hook `UserPromptSubmit` + `additionalContext` |

## 6. Requisitos não-funcionais

| ID | Requisito | Alvo | Origem |
|---|---|---|---|
| NFR-01 | Latência do hook (recall) | < 4s total | timeout do plugin atual |
| NFR-02 | Latência mediana de recall | ~0,85s | medido no grafo real |
| NFR-03 | Falha do daemon não quebra o turno | sempre | FR-305 do daemon |
| NFR-04 | Nenhuma credencial no código | — | `*-key.json` por workspace, `.gitignore` |
| NFR-05 | Node | ≥ 22 (v22.23.3 disponível) | ambiente |
| NFR-06 | Sem dependências pesadas no plugin | — | o plugin é fino; o peso está no memtier **e no binário do indexer** |
| NFR-07 | Coleta fora do caminho crítico | nunca no turno | FR-510; indexação é background |
| NFR-08 | Custo de sync por arquivo | < 50ms/chunk no servidor | medido: 32,6ms/chunk (memtier NFR-02) |
| NFR-09 | **Write path** (`code/sync`) | ≤ 100 arquivos/request, ≤ 5.000 chunks/arquivo | contrato do memtier (ARCH §2) — o coletor pagina o **envio** se exceder |
| NFR-10 | **Read path** (busca/recall) | já limitado por `max_tokens` (A1) | não há paginação de resultados: o teto de tokens é o limite (decisão do dono) |

## 7. Épicos

| # | Épico | Entrega | Depende de |
|---|---|---|---|
| **E1** | **Cliente do memtier** | HTTP client, auth por token, workspace por dir, `program`/`max_tokens`, health check | memtier ✅ |
| **E2** | **Injeção de memória** | `messages.transform` com recall; orçamento de latência | E1 |
| **E3a** | **Coletor de código** | Binário externo configurável; trigger híbrido (full→incremental); `chunk_emitted`→`files[]`; `import_edge`/`call_edge`→`edges[]`; **detecção de removido → `chunks: []`**; manifest por workspace; backpressure | `rust-ast-indexer` |
| **E3b** | **Registro do MCP do memtier** | MCP remoto no Kilo (reuso de `registerOpenVikingMcp`); registro **implícito**; degradação | memtier MCP ✅ |
| **E3c** | **Injeção de código** | `code_search` no `messages.transform`; bloco separado de memória | E1, E3a, memtier E6 |
| **E4** | **Ingestão assíncrona** | Gatilhos `message.updated`/`session.idle` sobre o `kilo.db` (cursor por identidade, idempotência no plugin); zero bloqueio (ADR-007/008) | E1, memtier E4 |
| **E5** | **Degradação** | memtier ou indexer fora do ar ⇒ turno segue, com aviso discreto | E2, E3a |
| **E6** | **Multi-CLI** | Adaptador OpenCode; adaptador Claude Code | E2, E3c |
| **E7** | **Observabilidade** | Log de recall/coleta (acertos, latência, upserted/deleted/changed/skipped), flag de debug | E2, E3a |

### Dependências externas

- **E1 depende do memtier** (borda autenticada) — **satisfeita**: E1–E7/E11 + A1/A2/E12 estão implementados. O desenvolvimento não precisa mais de mock do daemon.
- **E3c depende do memtier E6** (busca híbrida em código) — **satisfeita**.
- **E3a depende do `rust-ast-indexer`** (binário + protocolo JSONL) — o binário é
  **externo ao plugin**; build via `make build` no repo do indexer.
- **Navegação (`neighbors`) — BLOQUEADA:** depende de o memtier expor a tool MCP
  (hoje só `recall`/`ingest`/`code_search`/`code_sync`). Ver §5.
- Ordem natural: E1→E2 (memória) e E3a→E3b→E3c (código) em paralelo; E5 por
  último a fechar as duas pernas.

## 8. Métricas de sucesso

| Métrica | Baseline (plugin OV) | Alvo |
|---|---|---|
| Fatos contraditórios injetados | sim | **0** |
| Latência adicionada ao turno | ~0,7s | < 1s |
| Contexto de código injetado | nenhum | ≥ 1 chunk relevante por prompt técnico |
| Código indexado (população do grafo) | 0 (nenhum coletor) | ≥ 1 workspace sincronizado com ciclo de vida correto |
| Chunks órfãos após crescer/encolher/deletar | n/a | **0** (medido no spike 010/F16) |
| Bloqueio por ingestão/indexação | sim (síncrona) | **zero** |
| Vazamento entre workspaces | não testado | **0** |
| Ferramentas MCP disponíveis ao modelo | 0 | 4 (`recall`/`ingest`/`code_search`/`code_sync`) |

## 9. Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| **Coletor não detecta arquivo removido** | chunks órfãos/fantasmas na busca | Manifest por workspace + `chunks: []` (FR-504); teste de ciclo de vida (FR-509) |
| **Aresta aponta para alvo inexistente** | sync responde 422 e o lote inteiro falha | Resolver alvo antes de enviar; descartar aresta não-resolvível (ADR-012 D3) |
| **Backpressure do indexer mal tratado** | job travado em `pause` | Consumir `pause`→`resume` (FR-508) |
| **Binário do indexer ausente/incompatível** | coletor não roda | `indexer_bin` configurável; ausente ⇒ coletor desligado, não erro fatal (FR-306) |
| **Navegação prometida sem tool MCP** | feature fantasma | Bloqueio explícito no PRD (§5); não prometer E12 no plugin até o memtier expor |
| Injeção polui o prompt | piora a resposta em vez de melhorar | Limites de volume (FR-106) + flag de debug |
| Recall traz ruído | contexto irrelevante | Score mínimo; log de acertos para calibrar |
| Mecanismo de hooks do OpenCode não confirmado | adaptador E6 falha | Validar antes de prometer (ver SPIKE-FINDINGS) |
| Overhead de rede no turno | latência perceptível | Timeout curto + cache por sessão |

## 10. Lacunas a fechar antes de implementar

1. **Validar hooks do OpenCode** — o spike confirmou por documentação que o Kilo
   é fork do OpenCode, mas **não testou** (nenhuma das duas CLIs está instalada).
2. **Limiares de injeção** — quanto cabe no prompt sem degradar a resposta?
   Requer experimento.
3. **Detecção de mudança sem watch mode** — o `rust_indexer` **não tem watch**
   (verificado: sem crate de watch no `Cargo.toml`; 9 comandos, nenhum `watch`; o
   único incremental é `incremental_index` com `use_git`/`git_range`). Portanto:
   - **Full** (`index_path`) no 1º uso do workspace; **incremental**
     (`incremental_index` + `git_range`) depois.
   - **Decidir o `git_range`**: qual ref é a baseline do último sync
     (registrar o `HEAD` no manifest? `HEAD~1`?) e como **mudanças
     não-commitadas** entram (o modo git não as pega — exigiria uma passada por
     arquivo ou um watcher próprio do plugin, fora do MVP).
4. **Formato do manifest** — o que persistir por workspace para (a) detectar
   removidos (FR-504) e (b) saber se é o 1º sync (full vs incremental).

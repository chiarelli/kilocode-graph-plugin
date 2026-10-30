# ARCHITECTURE — kilocode-graph-plugin (draft)

**Versão:** 0.2 (draft)
**Base empírica:** `~/spikes/007-graphiti-memory-migration/REPORT.md`
**PRD:** [`PRD.md`](PRD.md)
**Dependências:**
- [`../../graphiti-daemon/`](../../graphiti-daemon/) — **memtier** (E1–E7/E11 + A1/A2/E12 implementados)
- [`../../rust-ast-indexer/`](../../rust-ast-indexer/) — **dependência de runtime do cliente** (binário externo)

> **Delta 0.2 (2026-10-14).** O PRD 0.1 dizia "indexar é do `rust-ast-indexer`".
> O delta 0.2 corrige: o indexer **extrai**, o memtier **armazena/busca**, e o
> **plugin é o coletor** — executa o indexer, agrupa `chunk_emitted` por arquivo,
> resolve arestas e chama `/v1/code/sync`. Também alinha o contrato com o estado
> real do memtier (`sync`, `neighbors`, `program`, `max_tokens`, `/v1/mcp`).
> Ver ADR-005 (coletor) e ADR-006 (push vs pull).
>
> **Delta 0.3 (E3a-S6).** O **gatilho** sai do plugin: o **CLI standalone** vira o
> **único escritor** e o delta roda por **hook git pós-commit** (ver §"Gatilho em
> runtime" abaixo e [ADR-011](adr/011-gatilho-do-delta-em-runtime.md)). O plugin
> segue dono da **tradução** (agrupar/arestas/sync) — ela agora vive no CLI, que
> chama `collectCode`.

---

## 1. Visão geral

```
┌──────────────────────────────────────────────────────────────┐
│  KILO CODE                                                    │
│                                                               │
│  message.updated / session.idle ──▶ ACORDAM a rotina          │
│                    (o conteúdo vem do kilo.db — não do evento)│
│                              │                                │
│  experimental.chat.messages.transform ◀── INJEÇÃO (push)      │
│                              │                                │
│  experimental.chat.system.transform  ◀── instrução de uso MCP │
│  experimental.session.compacting     ◀── preserva memória     │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ PLUGIN = núcleo + coletor + registro MCP                │ │
│  │                                                          │ │
│  │  src/index/  ──spawn──▶ rust_indexer (binário externo)   │ │
│  │      │  JSONL chunk_emitted / import_edge / call_edge    │ │
│  │      └─ agrupa por arquivo, resolve arestas, manifest    │ │
│  │                                                          │ │
│  │  src/mcp/  ──registra──▶ MCP remoto do memtier (/v1/mcp) │ │
│  │                          (o MODELO chama as tools — pull)│ │
│  └─────────────────────────────────────────────────────────┘ │
└───────────────┬───────────────────────────────────────────────┘
                │  HTTP + token (e MCP sobre a borda)
                ▼
┌──────────────────────────────────────────────────────────────┐
│  MEMTIER                                                      │
│  recall (síncrono) · ingest (fila) · code/search · code/sync  │
│  code/neighbors (HTTP — ainda SEM tool MCP)                   │
└──────────────────────────────────────────────────────────────┘
```

### Dois modos de consumo (ver ADR-006)

| Modo | Direção | O que | Quando |
|---|---|---|---|
| **Push** | plugin → turno | memória + `code/search` injetados | automático, todo turno |
| **Pull** | modelo → MCP | 7 tools (`recall`, `ingest`, `code_search`, `code_sync`, `code_neighbors`, `memory_episodes`, `memory_neighbors`) | sob demanda do agente |

O RAG automático (valor central) é **push**. As ferramentas MCP são **pull** — o
modelo decide. Não se injeta o mesmo que já se oferece como tool.

### Princípio central

**Recall é síncrono. Ingestão é assíncrona.** O usuário nunca espera uma extração
por LLM (38–110s). Ver o ADR-003 do daemon — a fila existe por custo e
determinismo, e porque o plugin pode morrer antes de terminar a escrita.

Orçamento do hook (medido, não suposto):

| Operação | Medido | Timeout do hook |
|---|---|---|
| recall de memória | 0,62–2,08s (mediana 0,85s) | 4000ms |
| busca de código | ~0,25–0,44s | idem (compartilhado) |

## 2. Contrato com o memtier

O plugin **não** conhece FalkorDB nem graphiti. Ele só fala HTTP (e registra o
MCP). Todas as rotas de dados aceitam `program` (aditivo, default `"default"` —
E11) além de `workspace`.

### `POST /v1/recall`

```json
// request
{ "workspace": "waweb", "program": "default", "query": "<texto do usuário>",
  "depth": 1, "limit": 10, "max_tokens": 2000 }

// response
{ "facts": [ { "fact": "...", "valid_at": "...", "invalid_at": null,
               "score": 0.83, "source": "memory",
               "uuid": "<fact uuid>", "episodes": ["<episode uuid>"] } ],
  "tokens_estimated": 1850, "truncated": false }
```

> `max_tokens` (A1) é opcional: sem ele o payload é o legado exato. O corte é por
> **fato inteiro**, sem reordenar o ranking. Estouro do teto interno (16k) → 422.
> `uuid` e `episodes` chegam no fio desde o memtier v1.1.0 e o plugin os consome
> desde a E8: o bloco injeta `[id=<uuid>]` do fato e `[ep=<uuid> +N]` do primeiro
> episódio (ver §5). Um uuid truncado ou malformado devolve `[]` em silêncio nas
> tools — por isso o marcador só sai com a forma `8-4-4-4-12` completa.

#### O que `depth` faz — BFS enraizada na query

`depth` liga a perna BFS do graphiti (`EdgeSearchMethod.bfs`). O memtier não
passa `bfs_origin_node_uuids` (`memory.py:170`), então a lib deriva as origens
das arestas casadas por BM25/vetor:

```python
source_node_uuids = [
    edge.source_node_uuid for result in search_results for edge in result
]
```

A expansão é `*1..depth` sobre `[:RELATES_TO|MENTIONS]`, com orçamento de
`2 × limit`, e percorre **só arestas de saída** (`search_utils.py:544`). Como
parte do **nó de origem** e não da aresta casada, `depth=1` já reencontra a
aresta casada **e adiciona as irmãs** daquele nó (`memory.py:172-175`).

Consequências: `depth>1` troca precisão por recall (o RRF joga os fracos para o
fim; o corte por `maxMemories` normalmente os elimina); e **não há âncora** —
não existe `uuid` no body, então não dá para "expandir este fato". Ver
[RFC-001 §5](rfc/001-navegacao-e-integridade-do-grafo-de-codigo.md) para o
achado e as propostas.

### `POST /v1/code/search`

```json
// request
{ "workspace": "waweb", "program": "default", "query": "...", "limit": 5,
  "labels": ["CodeSymbol"], "max_tokens": 2000, "min_score": 0.6 }

// response
{ "chunks": [ { "uuid": "39e6c181-...", "path": "internal/billing/store.go",
                "symbol": "SaveInvoice", "start_line": 42, "end_line": 55,
                "code": "...", "score": 0.79, "raw_score": 0.74,
                "match": "hybrid" } ] }
```

`labels=None` → `["CodeChunk"]` (default do servidor; o plugin manda
`["CodeSymbol"]`). `match ∈ vector|fulltext|hybrid`. `score` é a ORDEM (RRF
normalizado, top-1 = 1.0) e `raw_score` é a MAGNITUDE — é sobre ela que o
`min_score` (opcional, `[0,1]`) filtra, no servidor e antes do `limit`.
`query` é cortada pelo plugin em 512 chars (`MAX_QUERY_LENGTH`): a rota de
código responde **422** acima disso (só o `recall` trunca no servidor), e sem
o clamp um turno com texto longo perderia a injeção inteira.

O corte é `clampQuery` (25% cabeça + 75% cauda), com a cauda **ancorada na
pergunta**: se o último `?` ficaria fora da janela final, a cauda recua até
incluí-lo (o texto depois dele — tipicamente o `<system-reminder>` do host —
fica de fora). Motivo medido no `kilo.db` real: das 281 mensagens longas com
pergunta, o `slice(0,512)` preservava a `?` em 31,7%; o `clampQuery` preserva
em 100%, e o holdout de 40 mensagens reais mostrou 1 ganho, 2 perdas e 37
empates no top-10 (as perdas são mensagens cujo assunto está só na cabeça).
Escrita só existe via `/v1/code/sync` (abaixo) — a busca é read-only.

### `POST /v1/code/sync` — **o destino do coletor**

```json
// request
{ "workspace": "waweb", "program": "default",
  "files": [ { "file_path": "internal/billing/store.go", "language": "go",
               "chunks": [ { "chunk_id": "...", "chunk_kind": "Symbol",
                             "symbol_id": "SaveInvoice", "start_line": 42,
                             "end_line": 55, "chunk_md5": "...", "text": "..." } ] } ],
  "edges": [ { "from_file": "internal/billing/store.go",
               "to_file": "internal/db/db.go", "edge_kind": "call",
               "from_symbol_id": "SaveInvoice", "to_symbol_id": "Insert" } ] }

// response — 202
{ "workspace": "waweb", "upserted": 9, "deleted": 0, "changed": 9, "skipped": 0,
  "edges_upserted": 5, "edges_deleted": 0,
  "results": [ { "file_path": "...", "upserted": 9, "deleted": 0,
                 "changed": 9, "skipped": 0 } ] }
```

Regras do contrato (memtier ARCH §2):
- **Arquivo removido = `chunks: []`** — o servidor **não** auto-deleta arquivo
  ausente do payload (spike 010, A1). O coletor mantém um **manifest**.
  - **Limitação aceita (2026-10-15):** "todos os arquivos removidos" **não é
    representável** — `files` tem `min_length=1` (`main.py:710`), então um repo
    inteiramente esvaziado não pode ser declarado (`files: []` → **422**).
    Esvaziar um repo **não** limpa o grafo; a limpeza é declarando `chunks: []`
    por caminho conhecido.
  - **Só o modo FULL detecta removidos.** No incremental `removed = []` por
    desenho, e `decideTrigger` só volta a FULL no 1º uso (manifest vazio/sem
    `last_git_head`) — ver `RFC-001` em `graphiti-daemon/docs/rfc/`.
- ≤1 `FullFile`/`Contextual` por arquivo; `Symbol` exige `symbol_id`,
  `FullFile`/`Contextual` o proíbem.
- **Aresta cujo alvo não existe como `CodeChunk` → 422** (ADR-012 D3). Resolver
  antes de enviar.
- Limites: ≤100 arquivos/request, ≤5.000 chunks/arquivo, `text` ≤100KB.
- `changed`/`skipped` (A2) são aditivos; `upserted + skipped == total` quando o
  sync grava todos os chunks do payload.

### `POST /v1/code/neighbors`

```json
// request
{ "workspace": "waweb", "program": "default", "uuid": "<chunk uuid>",
  "direction": "out|in|both", "edge_kind": "import|call|all", "depth": 1, "limit": 20 }

// response
{ "neighbors": [ { "uuid": "...", "file_path": "...", "symbol": "...",
                   "chunk_kind": "Symbol", "start_line": 69, "end_line": 74,
                   "code": "...",
                   "edge": { "kind": "call", "direction": "in",
                             "from_uuid": "...", "to_uuid": "..." } } ],
  "total_neighbors": 2, "truncated": false }
```

> **Tool MCP:** `code_neighbors` (desde o memtier v1.1.0). O `uuid` de entrada é
> o 9º campo de `code_search` — não recalcular `uuid5` no cliente. `depth>1`
> continua 422: multi-hop de código foi adiado com medição (RFC-004 D6).

Não é BFS: é travessia de profundidade fixa 1, sem `*1..N` no Cypher
(`code.py:1526`). O campo `depth` existe no schema com teto 1
(`main.py:1158`, `ge=1, le=1`) — `depth=2` responde 422. Multi-hop só no
cliente, encadeando chamadas. Em compensação, é **ancorado no nó** (`uuid`) e
expressivo (direção + `edge_kind`), o oposto do `recall`. Comparação lado a
lado e propostas em
[RFC-001 §5](rfc/001-navegacao-e-integridade-do-grafo-de-codigo.md).

### `POST /v1/memory/episodes` — navegação **documental** (v1.1.0)

Troca uuid de episódio por **`content`** (o texto original). Lote de 1..5, sem
duplicata. Read-only, zero LLM.

```json
// request
{ "workspace": "waweb", "program": "default", "uuids": ["<uuid>"] }

// response
{ "episodes": [ { "uuid": "...", "name": "ep-0eec5ace", "source": "message",
                  "source_description": "cli-session",
                  "valid_at": "...", "created_at": "...", "content": "..." } ],
  "requested": 1, "resolved": 1 }
```

Uuid ausente no workspace é **omitido** (nunca 404 — omitir evita oráculo de
existência) e `resolved < requested` sinaliza a omissão. Estouro do teto de
16k tokens → **422**, nunca truncar. `entity_edges` e `group_id` nunca saem.

> Medido: `content` de 2.436 chars no caso amostrado (máx 47.058 no grafo
> `alfa`). Um episódio no teto de ingestão já estoura o orçamento sozinho — por
> isso o lote é pequeno.

### `POST /v1/memory/neighbors` — navegação **topológica** (v1.1.0)

Dado o **uuid do fato** (o que `recall` devolve em `fact.uuid`), devolve os
fatos vizinhos por aresta `RELATES_TO`, **não-dirigido** (as duas pontas),
**1 salto**, excluindo a própria âncora.

```json
// request
{ "workspace": "waweb", "program": "default", "uuid": "<uuid do fato>",
  "limit": 10, "include_invalid": false }

// response
{ "neighbors": [ { "uuid": "...", "fact": "...", "name": "CONTAINS",
                   "valid_at": "...", "invalid_at": null,
                   "source": "memory", "episodes": ["..."] } ],
  "total_neighbors": 7, "truncated": false }
```

`limit` 1..25 (default 10). Ordem: `valid_at` DESC com **nulos por último**,
depois `uuid` ASC. `include_invalid=false` (default) exclui supersedidos, mesma
semântica do `recall` (ADR-009). Uuid desconhecido → 200 com `[]`.

> A âncora é a **aresta**, não o nó: a BFS da lib segue só arestas de saída e
> perderia o outro lado do fato. `name` é a relação (`CONTAINS`,
> `PROVIDES_BASE_FOR`) — sem ele o cliente não sabe o que liga os dois fatos.

### `POST /v1/ingest`

```json
// request
{ "workspace": "waweb", "program": "default",
  "body": "user: ...\n\nassistant: ...", "reference_time": "2026-10-06T12:00:00Z" }

// response — 202, imediato
{ "job_id": "...", "workspace": "waweb", "status": "queued" }
```

> `reference_time` é a data da **mensagem mais atual do lote**, não a do envio.
> Sem isso a supersessão temporal grava a linha do tempo errada. O `202` confirma
> o **aceite**, não o processamento (L-1) — a incerteza é auditável.
> Contrato medido no `graphiti-daemon/src/memtier/main.py` (`IngestBody`).

### `GET /v1/health`

Usado pelo E5 (degradação) para decidir se injeta ou segue sem memória.

### MCP — `/v1/mcp` (mesma app/porta, E7)

Transporte **Streamable HTTP**, `stateless_http=True`. O plugin **registra** este
MCP remoto no Kilo (ver §3, `src/mcp/`); o bearer viaja no header
`Authorization`. Tools (7, desde o memtier v1.1.0): `recall`, `ingest`,
`code_search`, `code_sync`, `code_neighbors`, `memory_episodes`,
`memory_neighbors`. Auth é validada por middleware **antes** de qualquer tool
(sem token → 401; IAM down → 503 fail-closed).

## 3. Componentes

```
src/
├── index.ts              # registro dos hooks + INVOCA o CLI no boot + instala hooks git + registro MCP
├── cli.ts                # ⬅ NOVO (E3a-S6) — CLI standalone: único escritor do grafo
├── cli-spawn.ts          # ⬅ NOVO (E3a-S6) — spawn do CLI no boot (destacado)
├── token-file.ts         # ⬅ NOVO (E3a-S6) — resolve/confinamento do token_file
├── config.ts             # plugin.yaml + env vars + estado persistido (graph-config.json)
├── client.ts             # HTTP client do memtier (timeout, retry, auth)
├── workspace.ts          # diretório do projeto → nome lógico
├── inject/
│   ├── memory.ts         # formata o bloco de memória
│   ├── code.ts           # formata o bloco de código
│   └── budget.ts         # maxMemories / maxCodeChunks (corte de contagem)
├── ingest/               # (E4) — a INGESTÃO (o conteúdo vem do banco)
│   ├── db.ts             # localiza o kilo.db; lê message+part; cursor (ts,id)
│   ├── batch.ts          # monta o lote, hash djb2, reference_time, limiar
│   ├── state.ts          # .kilo/graph-ingest.json (sentBatchHashes + cursor)
│   └── routine.ts        # a rotina única: lê, decide, envia; trava por sessão
├── index/                # (E3a) — o COLETOR (chamado pelo CLI)
│   ├── runner.ts         # spawn do rust_indexer; consome JSONL; trata pause/resume
│   ├── collector.ts      # eventos → files[]/edges[] (agrupa por arquivo)
│   ├── edges.ts          # import_edge/call_edge → to_file/to_symbol_id (alvo existe?)
│   ├── manifest.ts       # estado por workspace → detecta removidos (chunks: []); tmp por PID
│   ├── trigger.ts        # híbrido + guarda de ancestralidade + gate do sentinela
│   ├── git.ts            # ⬅ NOVO (E3a-S6) — porta de git (HEAD/ancestry/removidos/hooks dir)
│   ├── lock.ts           # ⬅ NOVO (E3a-S6) — trava cross-process: flock(2) sob Bun + fallback O_EXCL sob Node
│   └── install-hooks.ts  # ⬅ NOVO (E3a-S6) — instala hooks git (idempotente, sem core.hooksPath)
├── mcp/                  # (E3b) — registro do MCP do memtier
│   └── register.ts       # client.mcp.add(type:remote) + connect; implícito
└── adapters/
    ├── kilo.ts           # referência (hooks JS)
    ├── opencode.ts       # mesmo mecanismo
    └── claude.ts         # UserPromptSubmit + additionalContext
```

### `workspace.ts` — escopo

Mesma abordagem do plugin atual: o workspace deriva do diretório do projeto
(hash do caminho, como hoje). O memtier recebe o **nome lógico** (+ `program`),
resolve o `group_id` e valida contra o escopo do token.

> O plugin **nunca** escolhe o grafo diretamente. Isso é o que garante FR-302.

### `index/` — o coletor (E3a)

O plugin **não** faz parsing. Ele **spawna** o binário do `rust-ast-indexer`
(caminho configurável, FR-501) e traduz o protocolo JSONL:

```
rust_indexer (JSONL stdio)
   ├─ chunk_emitted  ──▶ collector: agrupa por `file` → files[].chunks[]
   ├─ import_edge    ──┐
   ├─ call_edge      ──┴▶ edges.ts: resolve to_file/to_symbol_id; descarta se alvo ausente
   └─ pause/resume   ──▶ runner: ack com a contagem DRENADA; `resume` é notificação
```

O runner grava os eventos num **spool em disco** (`index/spool.ts`, por arquivo)
em vez de acumular o corpus em RAM; `index/sync-spool.ts` envia lotes de ≤100
arquivos. O `cpu-guard.ts` rebaixa a prioridade (`nice`) e pausa o processo com
`SIGSTOP` quando o SISTEMA passa de 85% (retomando em 75% ou no `max_pause_ms`) —
sem limitar núcleos.

O `manifest.ts` guarda, por workspace, o conjunto de arquivos já sincronizados —
para mandar `chunks: []` aos que sumiram (FR-504) e para saber se é o 1º sync. O
`trigger.ts` decide full (`index_path`) vs incremental (`incremental_index` +
`git_range`), agora com a **guarda de ancestralidade** (§4) e o **gate do
sentinela** (FR-507).

> ⚠️ **O `rust_indexer` não tem watch mode** (verificado 2026-10-14: sem crate de
> watch no `Cargo.toml`; 9 comandos, nenhum `watch`; `cli/args.rs` só aceita
> `--mcp`/`--quiet`). O indexer é **pull**: o CLI decide quando rodar. A detecção
> de mudança é por **commit** (hook git), e o modo incremental só cobre o que o
> **git** vê — **mudanças não-commitadas não entram** no MVP (FR-507).

**Gatilho em runtime (E3a-S6 — implementado).** O **CLI standalone**
(`src/cli.ts`) é o **único escritor** do grafo ([ADR-011](adr/011-gatilho-do-delta-em-runtime.md)).
No boot o plugin **não coleta**: **invoca o CLI em `auto`** (híbrido — `full` no
1º uso, `incremental` depois; **não** full fixo) em background e **instala os
hooks git** em `git rev-parse --git-path hooks` (resolvendo o caminho relativo;
**sem** `core.hooksPath`; idempotente; nunca sobrescreve hook do usuário; o script
resolve o `--workspace` por `--show-toplevel`, cobrindo worktrees). Hooks:
`post-commit`/`post-checkout`/`post-merge`/`post-rewrite` → CLI (destacado,
fire-and-forget) → incremental → `/v1/code/sync`:

- **Sentinela** `.kilo/graph-ready`: o incremental só roda depois do full inicial
  (que o cria) — fecha a corrida de um commit durante o full.
- **Guarda de ancestralidade**: `git merge-base --is-ancestor <last> HEAD`; não
  ancestral (checkout para trás/rebase) ⇒ `full`.
- **Removidos no incremental**: `git diff --no-renames --diff-filter=D` =
  `chunks: []`.
- **Trava cross-process** em `.kilo/graph.lock` (`flock(2)` sob Bun — o kernel
  libera na morte do processo, sem lock órfão; fallback `O_EXCL` sob Node) +
  **tmp por processo** no manifest: boot e commit são **processos SO distintos**.
- **Paridade de config (§7)**: no boot o plugin grava a `Config` efetiva (sem
  segredos) em `.kilo/graph-config.json`; o CLI a lê — o CLI standalone não vê o
  `options` inline do `kilo.jsonc` (o plugin é carregado pelo **runtime Kilo**,
  não pelo `kilo.jsonc` deste repo).

Referência: [`specs/e3a-s6-stories.md`](../specs/e3a-s6-stories.md) (S6a–S6d) e
[`docs/rfc/002`](rfc/002-sync-de-delta-em-runtime.md).

Referência validada (probe-grade, portar): `~/spikes/010-navegabilidade-codigo/probe_e2e_lifecycle.py`
(`montar_body`, resolução de módulo Rust, materialização de `FullFile`).

### `mcp/` — registro do MCP (E3b)

Reuso de `registerOpenVikingMcp` do antecessor (`openviking-memory.js:1781`):
`client.mcp.status` → `client.mcp.add` → `client.mcp.connect`. O registro é
**implícito**: o plugin o faz no boot, sem o usuário definir nada em `kilo.jsonc`.
Se o usuário **já** definiu o MCP lá, o plugin não registra por cima
(idempotência). A diferença do antecessor: `type:"remote"` (URL `/v1/mcp` +
header de auth) em vez de `type:"local"`.

### `inject/budget.ts` — orçamento (contagem)

Limites configuráveis, com defaults conservadores. A injeção é poluição em
potencial: se o recall trouxer ruído, a resposta piora. O orçamento é o freio.

```
maxMemories:   5
maxCodeChunks: 3
```

> **Só contagem** (ADR-009). O teto de **volume** é por endpoint, no **servidor**:
> cada injector manda o SEU `max_tokens` no body (`inject.memory_max_tokens` →
> `/v1/recall`; `inject.code_max_tokens` → `/v1/code/search`). O `max_chars`
> (cliente, conjunto) e o `max_tokens` compartilhado do ADR-004 **morreram** — a
> unidade única é tokens (`chars/4`, o tipo do memtier). O corte do cliente é por
> **fato/chunk inteiro** (nunca pela metade).

### `ingest/` — a rotina de ingestão (E4)

Os dois eventos (`message.updated`, `session.idle`) **acordam a MESMA rotina** e
o evento **nunca** é fonte de conteúdo (ADR-007) — a rotina lê o `kilo.db`. A
diferença entre os gatilhos é **um parâmetro** (`drainAll`):

| gatilho | `drainAll` | quantos lotes |
|---|---|---|
| `message.updated` | `false` | só com o lote cheio (`rows >= batch_size`) |
| `session.idle` | `true` | **todos + o resto** (até `pendentes == 0`) |

- **Cursor** por identidade `(time_created, id)` — **sem `OFFSET`** (ADR-008): o
  cursor aponta para uma mensagem, não para uma posição; remover linhas antes
  dele não pula nada.
- **Idempotência no plugin**: `sentBatchHashes` (djb2 sobre `role\0content`),
  persistido por workspace em `.kilo/graph-ingest.json` com escrita **atômica**.
  O memtier **não muda**.
- **`reference_time`** = mensagem mais atual do lote (a fila atrasa; a data do
  envio quebraria a supersessão).
- **Nunca bloqueia o turno**: o gatilho dispara a rotina em background
  (`void runIngest`); falha degrada, nunca lança (NFR-03).
- **Trava por sessão**: eventos repetidos (o `message.updated` dispara 2–3× por
  mensagem) não avançam o cursor duas vezes.

## 4. Fluxo de um turno

```
1. usuário envia o prompt
2. hook messages.transform  → [SÍNCRONO, orçamento 4s]
      ├── POST /v1/recall       (memória) ─┐
      └── POST /v1/code/search  (código) ─┴─ EM PARALELO (allSettled,
                                              AbortSignal por chamada)
      └── orçamento de contagem por família (maxMemories/maxCodeChunks; ADR-009)
      └── injeta 1 part por família (memória antes do código)
3. LLM responde (pode usar tools MCP — pull)
4. evento message.updated   → ACORDA a rotina (background; não bloqueia)
      └── lê o kilo.db pelo cursor; se o lote encheu → POST /v1/ingest (202)
5. evento session.idle      → ACORDA a MESMA rotina com drainAll
      └── envia todos os lotes + o RESTO (até pendentes == 0)
```

O evento **não** carrega conteúdo (medido: `parts` ausente / `len=0`); a fonte é
o **banco** (ADR-007). Por isso nenhum passo da ingestão toca o caminho crítico
do turno — só o passo 2 está nele.

**Só o passo 3 está no caminho crítico.** Se ele estourar o timeout, o turno
segue sem contexto (E5). As duas buscas rodam em **paralelo** justamente para não
somar as latências: `inject.timeout_ms` vale para **cada** chamada, não para a
soma.

### Fluxo de coleta de código (fora do turno)

```
start da sessão (ou gatilho)
   ├── 1º uso do workspace?  → index_path (full)      [trigger.ts]
   └── senão                 → incremental_index      [trigger.ts]
         │                       (git_range)
         ▼
   rust_indexer (spawn; JSONL)  ──pause/resume──▶ runner.ts
         │  chunk_emitted / import_edge / call_edge
         ▼
   collector.ts → files[] (agrupa por arquivo)
   edges.ts     → edges[]  (alvo existe? senão descarta)
   manifest.ts  → arquivos removidos ⇒ chunks: []
         ▼
   POST /v1/code/sync (202) → grafo populado
```

**Nunca no caminho do turno** (FR-510). Se o indexer demorar ou falhar, o turno
segue; a próxima busca simplesmente não acha o código novo ainda.

## 5. Formato do contexto injetado

Blocos distintos, com procedência (FR-105) — o modelo precisa saber o que é fato
de memória e o que é código do repo. Cada família vira um **part separado** no
mesmo turno (não há um segundo `transform`), com **sentinela própria**.

Memória (sentinela `graph-memory`). Os marcadores de identidade vêm **no fim**
da linha, com o uuid **completo** (36 chars): `[id=…]` é o uuid do fato, que
`memory_neighbors` recebe em `uuid`; `[ep=…]` é o uuid do **primeiro** episódio
(`+N` conta os demais), que `memory_episodes` recebe em `uuids`. Sem marcador
válido a linha fica byte-idêntica à do formato antigo.

```
<context graph-memory="true">
[CONTEXTO DE MEMÓRIA]
- O backend do Atlas roda em PostgreSQL 16 (válido desde 2026-04-22) [id=3f2504e0-4f89-11d3-9a0c-0305e82c3301] [ep=cdd38cb4-7eea-4b8f-9f13-3c1e6a2b9d47 +1]
- O timeout de conexão foi ajustado para 30s
</context>
```

Código (sentinela `graph-code`), com procedência **por chunk** — um cabeçalho
`[CÓDIGO RELEVANTE — path:inicio-fim]` antes de cada trecho, seguido de
`[id=<uuid do chunk>]` quando o servidor manda o 9º campo (é a entrada de
`code_neighbors`):

```
<context graph-code="true">
[CÓDIGO RELEVANTE — internal/billing/store.go:42-55] [id=39e6c181-6a0e-4d5c-8b2b-7b0e5f2c9a11]
func SaveInvoice(ctx context.Context, inv *Invoice) error {
    return db.Insert(ctx, "invoices", inv)
}
</context>
```

> **Sem `score`.** O bloco **não** carrega `score`/`raw_score` (RFC-001 §3): o
> `score` é normalizado pelo top-1 da própria consulta (o topo é sempre `1.0`),
> logo não é comparável entre itens nem entre consultas — a **ordem** já dá o
> ranking. O `raw_score` (magnitude) fica no cliente, para o `min_score` do
> servidor, e nunca entra no bloco.
>
> **Ausência degrada visivelmente.** Servidor anterior ao v1.1.0 não manda os
> campos: o marcador é omitido **sem** log (degradação esperada). Campo presente
> com forma inválida (`8-4-4-4-12` é a única aceita) é omitido **com um** aviso
> por turno por família — o mesmo padrão de `warnIfFloorNotHonored`. O valor
> inválido é **omitido**, nunca escapado: o formato não admite `<`, `>`, espaço
> nem quebra de linha, então `[ep=</context>]` não fura a sentinela.
>
> **Dedup.** A memória deduplica por `factKey` — uuid validado, com fallback para
> `text:<fato>` (servidor antigo). O código continua em `chunkIdentity`
> (`path:inicio-fim`): é guarda local do turno, não identidade de grafo.
>
> **Instrução de sistema.** O bloco carrega os ids e **nada mais**; o protocolo
> de como expandi-los vive no `system.transform` (§3), que só é efetivo com
> `inject.enabled` **e** `mcp.enabled`.

> **Ordem e orçamento.** A memória é injetada **antes** do código. O teto de
> **volume** é por endpoint, no servidor (`inject.memory_max_tokens` /
> `inject.code_max_tokens` → `max_tokens` no body de cada rota; ADR-009): cada
> bloco obedece só ao SEU teto. O cliente só corta por **contagem**
> (`maxMemories` / `maxCodeChunks`), por fato/chunk **inteiro** — um chunk nunca é
> cortado pela metade.
>
> **Sanitização.** Tanto o `fact` quanto o `code` vêm de fora (grafo/repo). O
> texto é neutralizado (`<`/`>` → `&lt;`/`&gt;`) para que nenhum conteúdo possa
> abrir ou fechar a sentinela. No código, as quebras de linha e a indentação são
> **preservadas** (são o conteúdo); no fato, viram espaço (um fato é uma linha).
>
> **Paralelismo.** Recall e `code/search` partem em **paralelo**
> (`Promise.allSettled`), cada um com seu `AbortSignal`: `inject.timeout_ms` vale
> para **cada** chamada, não para a soma — é o que sustenta o teto de 4s do hook.

## 6. Configuração

Nada hardcoded no script (FR-303). **JSON** + env vars, precedência:
`options` (do `kilo.jsonc`) > env var > arquivo JSON > default.

> **JSON, não YAML** (decisão fixada na E1-S3). O texto original dizia
> `plugin.yaml`, mas o ecossistema Kilo usa JSON no `.kilo/` e o antecessor
> (`openviking.json`) também — adotar YAML exigiria um parser extra sem ganho.
> Arquivos: `.kilo/graph-plugin.json` (por workspace) e
> `~/.config/kilo/graph-plugin.json` (global), mesclados (workspace vence).

```jsonc
// .kilo/graph-plugin.json  (ou ~/.config/kilo/graph-plugin.json)
{
  "daemon": {                             // memtier
    "url": "http://127.0.0.1:8400",
    "token_file": ".kilo/graph-key.json", // por workspace, no .gitignore
    "program": "default",                 // E11 (aditivo)
    "health_timeout_ms": 2000
  },
  "inject": {
    "enabled": false,                     // FR-304, preferência do dono
    "max_memories": 5,
    "memory_max_tokens": 2000,            // KILOCODE_GRAPH_INJECT_MEMORY_MAX_TOKENS
    "code_max_tokens": 2000,              // KILOCODE_GRAPH_INJECT_CODE_MAX_TOKENS
    "timeout_ms": 4000,                   // orçamento do hook (por chamada)
    "code_enabled": false,                // E3c — injeção de código (desligada)
    "max_code_chunks": 3,                 // E3c — nº de chunks de código
    "code_labels": ["CodeSymbol"],        // D5 — labels da busca (CSV/JSON na env)
    // "code_min_score": 0.6,             // D7 — piso de relevância (AUSENTE = desligado)
    "instruction_enabled": true,          // E8 — instrução de uso do memtier no system prompt
  },
  "code_index": {                         // E3a — o coletor
    "enabled": false,                     // ativado por flag, como hoje
    "indexer_bin": "",                    // caminho do rust_indexer (FR-306)
    "sync_timeout_ms": 120000,            // KILOCODE_GRAPH_INDEX_SYNC_TIMEOUT_MS
    "load_ignores": false,                // git ls-files --exclude-standard
    "backpressure": {                     // KILOCODE_GRAPH_INDEX_BACKPRESSURE (JSON)
      "max_queue_size": 500,              // fila que dispara `pause` (mín. 10)
      "threshold_percent": 90,            // resume abaixo deste % (80–99)
      "ack_required": false,
      "pause_timeout_secs": 60            // anti-travamento do produtor
    },
    "cpu_guard": {                        // KILOCODE_GRAPH_INDEX_CPU_GUARD (JSON)
      "enabled": true,
      "threshold_percent": 85,            // pausa (SIGSTOP) quando o SISTEMA passa
      "resume_percent": 75,               // retoma (SIGCONT) quando normaliza
      "sample_ms": 1000,
      "max_pause_ms": 30000,              // nunca deixa o job travado
      "nice": 10                          // prioridade menor; não limita núcleos
    }
  },
  "mcp": {                                // E3b — registro do MCP do memtier
    "enabled": true,
    "name": "memtier"
  },
  "debug": false
}
```

> **Envs** (todas `KILOCODE_GRAPH_*`): `URL`, `TOKEN`, `TOKEN_FILE`, `PROGRAM`,
> `INJECT_ENABLED`, `INJECT_MAX_MEMORIES`, `INJECT_MEMORY_MAX_TOKENS`,
> `INJECT_CODE_MAX_TOKENS`, `INJECT_TIMEOUT_MS`, `INJECT_CODE_ENABLED`,
> `INJECT_MAX_CODE_CHUNKS`, `INJECT_CODE_LABELS`, `INJECT_CODE_MIN_SCORE`,
> `INJECT_INSTRUCTION_ENABLED`, `INDEX_ENABLED`, `INDEXER_BIN`,
> `INDEX_SYNC_TIMEOUT_MS`, `INDEX_LOAD_IGNORES`, `MCP_ENABLED`, `MCP_NAME`, `DEBUG`,
> `INGEST_ENABLED`, `INGEST_BATCH_SIZE`, `INGEST_MAX_HASHES`, `INGEST_TIMEOUT_MS`,
> `MANAGER_TOKEN`, `WORKSPACE`. O prefixo da env de config é `KILOCODE_GRAPH_` (o
> `openviking` do antecessor mudou).
>
> **Envs de limite legadas (ADR-009).** `INJECT_MAX_CHARS` e `INJECT_MAX_TOKENS`
> deixaram de ser lidas; se setadas no ambiente, o boot emite **um** log de
> depreciação e as ignora (quem calibrou não perde o ajuste em silêncio) — as
> substitutas são `INJECT_MEMORY_MAX_TOKENS`/`INJECT_CODE_MAX_TOKENS`.
>
> **`inject.instruction_enabled` (E8).** Env
> `KILOCODE_GRAPH_INJECT_INSTRUCTION_ENABLED`, default **`true`** — o único
> booleano de `inject.*` com default ligado, e o comportamento global não muda:
> com `inject.enabled=false` (o default) nada é injetado nem instruído. Governa o
> TEXTO, não o bloco: desligar mantém os `[id=…]`/`[ep=…]` (ainda servem para
> citar). Efetiva só com `inject.enabled=true` **e** `mcp.enabled=true`; não é
> persistida em `.kilo/graph-config.json` (o CLI não lê flags de injeção).
>
> **Custo da instrução.** Reenviada a cada turno: o teto é contrato de teste
> (`≤ 1000` chars, unidade `chars/4` do ADR-009; a redação final mede 707 com
> código e 555 só com memória).
>
> **Clamp do `max_tokens` (D8) — vale para os DOIS tetos.** Um valor acima do teto interno do servidor
> (16000, `MAX_RESPONSE_TOKENS` — acima dele o memtier responde **422**) é
> **clampado para 16000 com log**, não descartado: o default silencioso fazia
> `16384` virar 2000, ou seja, o operador pedia 8× mais orçamento e recebia
> menos que o default. Valor abaixo de 1 ou não-inteiro cai no default, também
> com log; string vazia é "não configurado" e não loga.
>
> **Relevância do bloco de código (D5/D6/D7).**
> `inject.code_labels` (default `["CodeSymbol"]`, aceita CSV ou JSON array na
> env; em `options`/arquivo, um array JSON é o formato previsto — um array JS
> nativo passa por `String()` e só funciona se nenhum label tiver vírgula) vai
> no body de `/v1/code/search`: restringe a busca a chunks de símbolo e
> deixa `FullFile`/`Contextual` de fora — é o que evita injetar arquivo inteiro
> no lugar do trecho. Lista vazia/inválida cai no default, porque `labels: []`
> explícito é **422** no servidor. O default do SERVIDOR não muda.
>
> `inject.code_min_score` é o piso de relevância (`min_score` no body),
> **desligado por default** (campo ausente). O piso é aplicado no servidor sobre
> o `raw_score` (magnitude), não sobre o `score` (ordem/RRF normalizada): o
> cliente **nunca** re-filtra por score. Calibração: o servidor já corta a perna
> vetorial com `VEC_MIN_SCORE = 0.65`, então um piso abaixo disso só afeta
> chunks fulltext-only. **Servidor antigo ignora o campo em silêncio** (pydantic
> descarta extra) e devolve chunks sem `raw_score`; quando isso acontece a
> injeção loga **uma vez por turno** que aqueles chunks seguiram sem filtro
> (`code_search: min_score=… NÃO honrou o piso`). O caminho avulso
> (`searchAndFormat`, sem estado de turno) loga uma vez por chamada; o hook, uma
> vez por turno. O valor default só será definido por medição no corpus real —
> esta entrega deixa o piso desligado.

> **Defaults desligados** para indexação e injeção — é a preferência registrada
> do dono no plugin atual.
>
> **Escopo das chaves:** este bloco lista a config fixada pela **E1** (a tabela
> de chaves da `specs/e1-stories.md` §2), `code_index.sync_timeout_ms` (E3a-S4) e
> `inject.code_enabled`/`inject.max_code_chunks` (E3c). Estas duas últimas são a
> **exceção consciente**: o E3c não estava specado quando o E1 fechou (a segunda
> onda era "spec sob demanda"), então a epic dona as declara e a exceção é
> registrada no histórico do BACKLOG. As chaves de `ingest.*` foram declaradas
> pela própria **E4** (`ingest.enabled`/`batch_size`/`max_hashes`/`timeout_ms`;
> default `enabled=false`). O caminho do `kilo.db` **não** é config: vem da
> **regra do runtime do Kilo** (`Path.data` = `XDG_DATA_HOME ?? ~/.local/share`
> + `/kilo`, com `KILO_DB`; ver [ADR-010](adr/010-fonte-do-kilo-db.md)) — a env
> `INGEST_DB_PATH` foi removida. `/path` expõe `state`/`config`/`worktree`/
> `directory`, mas **não** `data` (onde o banco vive) — então derivar de `state`
> apontava para um diretório sem `kilo.db`.
> banco.


## 7. Adaptadores multi-CLI

| CLI | Mecanismo | Status |
|---|---|---|
| **Kilo Code** | hooks JS (`event` (`message.updated`/`session.idle`), `messages.transform`, `system.transform`, `compacting`) | ✅ produção — arquitetura validada (ADR-007: a ingestão não usa `chat.message`) |
| **OpenCode** | mesmos hooks (Kilo é fork) | ⚠️ por documentação — **não testado** |
| **Claude Code** | hook `UserPromptSubmit` → `additionalContext` | ⚠️ por documentação — **não testado** |

O que realmente muda entre CLIs é **o ponto de captura e o ponto de injeção** —
o cliente do daemon, o orçamento e o formato dos blocos são compartilhados. Por
isso a separação em `adapters/`.

> **Ressalva honesta:** nenhuma das duas CLIs alternativas está instalada no
> ambiente de desenvolvimento. Os adaptadores são desenho, não código validado.
> Ver `SPIKE-FINDINGS.md`.

## 8. Degradação (E5)

| Situação | Comportamento |
|---|---|
| `/health` falha | turno segue sem injeção; log discreto |
| Recall estoura timeout | turno segue sem memória (code/search pode ter chegado) |
| `/ingest` falha | lote **não** é enviado nem marcado; o próximo gatilho relê (sem retry cego); nada bloqueia o turno |
| **`kilo.db` ausente/ocupado** | ingestão não roda; loga; o próximo gatilho tenta de novo (nunca silencioso) |
| **estado de ingestão perdido/corrompido** | degrada para vazio, **registra** o reset; o próximo `session.idle` reenvia (custo aceito, L-3) |
| Token rejeitado (401/403) | log de erro visível; sem retry infinito |
| **`indexer_bin` ausente** | coletor desligado (não é erro fatal); memória segue (FR-306) |
| **Indexer trava em `pause`** | runner responde `ack {count: drenados}`; o `pause_timeout_secs` do indexer é a rede de segurança; se persistir, aborta o job, turno segue |
| **Sistema saturado durante a indexação** | `cpu_guard` pausa o processo (`SIGSTOP`) em ≥85% e retoma em ≤75% (ou no `max_pause_ms`) |
| **`/v1/code/sync` 422** (aresta órfã) | loga o lote; descarta a aresta e reenvia (ADR-012 D3) |
| **MCP não registra** | loga; turno segue sem tools; nunca fatal (FR-604) |

O principio: **memória é um luxo, não um pré-requisito do turno** — e código
indexado também.

## 9. Observabilidade (E7)

Log estruturado por turno:

```json
{ "turn": "...", "recall_ms": 830, "facts": 5, "code_chunks": 2,
  "injected_chars": 3120 }
```

Log por lote de ingestão (E4) — fora do turno:

```json
{ "ingest": "sent", "session": "ses_...", "rows": 20, "msgs": 2,
  "hash": "1170267838", "job_id": "...", "reference_time": "...",
  "accepted_not_confirmed": true }
```

Log por ciclo de coleta (E3a; com o `source` do gatilho na E3a-S6c) — separa o
trabalho do turno:

```
collect source=post-commit mode=incremental trigger=auto indexer_ms=412
        files=12 edges=30 removed=2
        sync={upserted:9,deleted:2,changed:9,skipped:40}
```

O `source` (`boot`/`post-commit`/`post-checkout`/`post-merge`/`post-rewrite`)
distingue o delta de runtime da coleta de boot; quando não há sync, a linha traz
`sync=skipped reason=<…>` (sentinela, indexer vazio, erro fatal, trava).

Sem isso é impossível calibrar os limiares do §5 — e a suspeita de que a injeção
está piorando as respostas fica sem evidência.

## 10. Armadilhas herdadas do spike

Ver `../../graphiti-daemon/docs/ARCHITECTURE.md` §5. As relevantes aqui:

| # | Armadilha | Onde morde neste plugin |
|---|---|---|
| 1 | `driver.clone` obrigatório | invisível (o memtier encapsula) |
| 2 | Fulltext não cobre código | a busca de código depende do memtier ter `CodeSearchable` |
| 6 | `reference_time` errado | quebra a supersessão — enviar a data da mensagem |
| 7 | Daemon bloqueado por ingestão | **não acontece** (medido); não projetar em cima disso |
| — | **Arquivo removido não auto-deleta** (spike 010 A1) | o coletor **precisa** mandar `chunks: []`; manifest obrigatório |
| — | **Aresta com alvo inexistente → 422** (ADR-012 D3) | resolver o alvo antes de enviar; descartar se ausente |
| — | **`symbol_id` é o nome puro** | montar a chave `{file}:{symbol}` com o valor cru (não concatenar `file` de novo) |
| — | **Backpressure é two-way** | quem lê stdout sem `resume` deixa o job travado |
| — | **Arestas têm atributos achatados** | `e.edge_kind`, não `e.attributes[...]` (relevante se ler neighbors) |

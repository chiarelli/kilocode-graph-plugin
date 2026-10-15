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
│  experimental.chat.system.transform  ◀── contexto de sistema  │
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
| **Pull** | modelo → MCP | `recall`/`ingest`/`code_search`/`code_sync` | sob demanda do agente |

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
               "score": 0.83, "source": "memory" } ],
  "tokens_estimated": 1850, "truncated": false }
```

> `max_tokens` (A1) é opcional: sem ele o payload é o legado exato. O corte é por
> **fato inteiro**, sem reordenar o ranking. Estouro do teto interno (16k) → 422.

### `POST /v1/code/search`

```json
// request
{ "workspace": "waweb", "program": "default", "query": "...", "limit": 5,
  "labels": ["CodeSymbol", "CodeFullFile"], "max_tokens": 2000 }

// response
{ "chunks": [ { "path": "internal/billing/store.go", "symbol": "SaveInvoice",
                "start_line": 42, "end_line": 55, "code": "...",
                "score": 0.79, "match": "hybrid" } ] }
```

`labels=None` → `["CodeChunk"]` (default). `match ∈ vector|fulltext|hybrid`.
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

### `POST /v1/code/neighbors` — **HTTP-only (bloqueio MCP)**

```json
// request
{ "workspace": "waweb", "program": "default", "uuid": "<chunk uuid>",
  "direction": "out|in|both", "edge_kind": "import|call|all", "depth": 1, "limit": 20 }

// response
{ "neighbors": [ { "file_path": "...", "symbol": "...", "edge": { "kind": "call" } } ],
  "total_neighbors": 2, "truncated": false }
```

> ⚠️ **Bloqueio:** esta rota **não tem tool MCP** no memtier (só `recall`,
> `ingest`, `code_search`, `code_sync` são expostas). O plugin **não** promete
> navegação por vizinhos até o memtier expor a tool. `depth>1` → 422.

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
`Authorization`. Tools: `recall`, `ingest`, `code_search`, `code_sync`. Auth é
validada por middleware **antes** de qualquer tool (sem token → 401; IAM down →
503 fail-closed).

## 3. Componentes

```
src/
├── index.ts              # registro dos hooks + disparo do coletor + registro MCP
├── config.ts             # plugin.yaml + env vars (nada hardcoded)
├── client.ts             # HTTP client do memtier (timeout, retry, auth)
├── workspace.ts          # diretório do projeto → nome lógico
├── inject/
│   ├── memory.ts         # formata o bloco de memória
│   ├── code.ts           # formata o bloco de código
│   └── budget.ts         # maxChars / maxMemories / maxCodeChunks
├── ingest/               # ⬅ NOVO (E4) — a INGESTÃO (o conteúdo vem do banco)
│   ├── db.ts             # localiza o kilo.db; lê message+part; cursor (ts,id)
│   ├── batch.ts          # monta o lote, hash djb2, reference_time, limiar
│   ├── state.ts          # .kilo/graph-ingest.json (sentBatchHashes + cursor)
│   └── routine.ts        # a rotina única: lê, decide, envia; trava por sessão
├── index/                # ⬅ NOVO (E3a) — o COLETOR
│   ├── runner.ts         # spawn do rust_indexer; consome JSONL; trata pause/resume
│   ├── collector.ts      # eventos → files[]/edges[] (agrupa por arquivo)
│   ├── edges.ts          # import_edge/call_edge → to_file/to_symbol_id (alvo existe?)
│   ├── manifest.ts       # estado por workspace → detecta removidos (chunks: [])
│   └── trigger.ts        # híbrido: full no 1º uso; incremental_index depois
├── mcp/                  # ⬅ NOVO (E3b) — registro do MCP do memtier
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
   └─ pause/resume   ──▶ runner: consome backpressure (ack/resume), nunca trava
```

O `manifest.ts` guarda, por workspace, o conjunto de arquivos já sincronizados —
para mandar `chunks: []` aos que sumiram (FR-504) e para saber se é o 1º sync. O
`trigger.ts` decide full (`index_path`) vs incremental (`incremental_index` +
`git_range`) (FR-507).

> ⚠️ **O `rust_indexer` não tem watch mode** (verificado 2026-10-14: sem crate de
> watch no `Cargo.toml`; 9 comandos, nenhum `watch`; `cli/args.rs` só aceita
> `--mcp`/`--quiet`). O indexer é **pull**: o plugin decide quando rodar. A
> detecção de mudança é do plugin, e o modo incremental só cobre o que o **git**
> vê — **mudanças não-commitadas não entram** no MVP.

Referência validada (probe-grade, portar): `~/spikes/010-navegabilidade-codigo/probe_e2e_lifecycle.py`
(`montar_body`, resolução de módulo Rust, materialização de `FullFile`).

### `mcp/` — registro do MCP (E3b)

Reuso de `registerOpenVikingMcp` do antecessor (`openviking-memory.js:1781`):
`client.mcp.status` → `client.mcp.add` → `client.mcp.connect`. O registro é
**implícito**: o plugin o faz no boot, sem o usuário definir nada em `kilo.jsonc`.
Se o usuário **já** definiu o MCP lá, o plugin não registra por cima
(idempotência). A diferença do antecessor: `type:"remote"` (URL `/v1/mcp` +
header de auth) em vez de `type:"local"`.

### `inject/budget.ts` — orçamento

Limites configuráveis, com defaults conservadores. A injeção é poluição em
potencial: se o recall trouxer ruído, a resposta piora. O orçamento é o freio.

```
maxMemories:   5
maxCodeChunks: 3
maxChars:      3000
```

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
      └── orçamento do TOTAL (maxChars; código prioritário)
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

Memória (sentinela `graph-memory`):

```
<context graph-memory="true">
[CONTEXTO DE MEMÓRIA]
- O backend do Atlas roda em PostgreSQL 16 (válido desde 2026-04-22)
- O timeout de conexão foi ajustado para 30s
</context>
```

Código (sentinela `graph-code`), com procedência **por chunk** — um cabeçalho
`[CÓDIGO RELEVANTE — path:inicio-fim]` antes de cada trecho:

```
<context graph-code="true">
[CÓDIGO RELEVANTE — internal/billing/store.go:42-55]
func SaveInvoice(ctx context.Context, inv *Invoice) error {
    return db.Insert(ctx, "invoices", inv)
}
</context>
```

> **Ordem e orçamento.** A memória é injetada **antes** do código. `maxChars` é o
> teto do **total** (memória + código): quando estoura, corta fatos **inteiros**
> de memória primeiro (do fim); só então chunks **inteiros** de código — o código
> tem prioridade (chunk truncado não compila). Um chunk nunca é cortado pela
> metade.
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
    "max_chars": 3000,                    // KILOCODE_GRAPH_INJECT_MAX_CHARS
    "max_tokens": 2000,                   // A1 — orçamento de resposta no servidor
    "timeout_ms": 4000,                   // orçamento do hook (por chamada)
    "code_enabled": false,                // E3c — injeção de código (desligada)
    "max_code_chunks": 3                  // E3c — nº de chunks de código
  },
  "code_index": {                         // E3a — o coletor
    "enabled": false,                     // ativado por flag, como hoje
    "indexer_bin": "",                    // caminho do rust_indexer (FR-306)
    "sync_timeout_ms": 120000             // KILOCODE_GRAPH_INDEX_SYNC_TIMEOUT_MS
  },
  "mcp": {                                // E3b — registro do MCP do memtier
    "enabled": true,
    "name": "memtier"
  },
  "debug": false
}
```

> **Envs** (todas `KILOCODE_GRAPH_*`): `URL`, `TOKEN`, `TOKEN_FILE`, `PROGRAM`,
> `INJECT_ENABLED`, `INJECT_MAX_MEMORIES`, `INJECT_MAX_CHARS`,
> `INJECT_MAX_TOKENS`, `INJECT_TIMEOUT_MS`, `INJECT_CODE_ENABLED`,
> `INJECT_MAX_CODE_CHUNKS`, `INDEX_ENABLED`, `INDEXER_BIN`,
> `INDEX_SYNC_TIMEOUT_MS`, `MCP_ENABLED`, `MCP_NAME`, `DEBUG`,
> `INGEST_ENABLED`, `INGEST_BATCH_SIZE`, `INGEST_MAX_HASHES`, `INGEST_TIMEOUT_MS`,
> `MANAGER_TOKEN`. O prefixo da env de config é `KILOCODE_GRAPH_` (o
> `openviking` do antecessor mudou).

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
> default `enabled=false`). O caminho do `kilo.db` **não** é config: vem do
> **runtime do Kilo** (`client.path.get().state` → `<state>/kilo.db`) — a env
> `INGEST_DB_PATH` foi removida.


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
| **Indexer trava em `pause`** | runner consome backpressure (`resume`); se persistir, aborta o job, turno segue |
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

Log por ciclo de coleta (E3a) — separa o trabalho do turno:

```json
{ "collect": "incremental", "indexer_ms": 412, "files": 12, "edges": 30,
  "sync": { "upserted": 9, "deleted": 2, "changed": 9, "skipped": 40 },
  "removed": ["src/old.rs"] }
```

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

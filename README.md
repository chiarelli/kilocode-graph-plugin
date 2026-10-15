# kilocode-graph-plugin

Plugin do Kilo Code que injeta **memória curada** e **RAG de código do
repositório** em cada turno, usando o [`memtier`](../graphiti-daemon/) como
provider.

Substitui o `kilo-openviking-plugin` por baixo: os hooks do Kilo são os mesmos,
o provider muda.

> **Status:** esqueleto de projeto. PRD e arquitetura são drafts (v0.2).
> **Dependências:**
> - [`memtier`](../graphiti-daemon/) (ex-`graphiti-daemon`) — **implementado**
>   (E1–E7/E11 + A1/A2/E12). Fala-se HTTP/MCP; o plugin não conhece FalkorDB.
> - [`rust-ast-indexer`](../rust-ast-indexer/) — **dependência de runtime do
>   cliente**: o plugin **spawna** o binário (caminho configurável) e é o
>   **coletor** dos eventos de código.
> **Base empírica:** [`~/spikes/007-graphiti-memory-migration/REPORT.md`](../../spikes/007-graphiti-memory-migration/REPORT.md)
> **Antecessor:** [`chiarelli/kilo-openviking-plugin`](https://github.com/chiarelli/kilo-openviking-plugin)

## O que muda em relação ao plugin atual

| | OpenViking (hoje) | memtier (este plugin) |
|---|---|---|
| Curadoria temporal | ❌ reescrita duplicada | ✅ supersessão automática |
| RAG de código do repo | ❌ | ✅ busca híbrida |
| Coleta/indexação de código | ❌ | ✅ plugin spawna o `rust-indexer` e sincroniza o grafo |
| Ferramentas ao modelo | ❌ | ✅ MCP do memtier registrado no Kilo |
| Latência de recall | ~0,7s | ~0,85s (medido) |
| Ingestão | síncrona no turno | **assíncrona** (fila) |
| Multi-CLI | só Kilo | Kilo + adaptadores |

**O que NÃO muda:** a arquitetura de hooks. O plugin atual injeta em
`experimental.chat.messages.transform` — o spike confirmou que o mecanismo
continua válido (Q5). Troca-se o cliente.

## Arquitetura em uma linha

```
Kilo Code ──hooks──▶ plugin ──HTTP──▶ memtier ──▶ FalkorDB
                      │  ▲
                      │  └── registra MCP remoto (o modelo chama tools)
                      │
              injeta memória + código no turno
              spawna rust_indexer → /v1/code/sync (coletor)
              enfileira ingestão (nunca bloqueia)
```

## Documentos

| Arquivo | Conteúdo |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | Personas, requisitos, épicos (v0.2 — coletor de código) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Hooks, fluxo do turno, coletor, MCP, adaptadores (v0.2) |
| [`docs/SPIKE-FINDINGS.md`](docs/SPIKE-FINDINGS.md) | O que o spike provou sobre multi-CLI |
| [`docs/adr/`](docs/adr/README.md) | Decisões (ADR-005: coletor; ADR-006: push vs pull MCP) |

## Hooks do Kilo usados

O plugin usa **hooks de evento** (não captura por `chat.message`):

| Hook | Papel |
|---|---|
| `event` (`message.updated`) | **acorda** a rotina de ingestão (o conteúdo vem do `kilo.db`, ADR-007) |
| `event` (`session.idle`) | acorda a MESMA rotina com **dreno** (envia o resto — ADR-007) |
| `experimental.chat.messages.transform` | **injeção** no turno (memória + código) |
| `experimental.chat.system.transform` | contexto de sistema |
| `experimental.session.compacting` | preservar memória na compactação |

## Coleta de código (o coletor)

O plugin **não** faz parsing — ele **spawna** o binário do `rust-ast-indexer`
(caminho configurável) e traduz os eventos JSONL para o contrato do memtier:

```
rust_indexer (JSONL) ──▶ chunk_emitted / import_edge / call_edge
   └─▶ agrupa por arquivo, resolve arestas, detecta removidos (manifest)
       └─▶ POST /v1/code/sync (202)
```

Fora do caminho crítico do turno. Ver ADR-005 e `docs/ARCHITECTURE.md` §4.

## Não-objetivos

- Implementar o provider de memória (é do **memtier**).
- **Implementar o parser/chunker** — é do `rust-ast-indexer`, que é uma
  **dependência de runtime do cliente**. O plugin apenas o executa e **coleta** os
  eventos (agrupar por arquivo, resolver arestas, sincronizar).
- **Navegação por código vizinho** (`/v1/code/neighbors`) — **travada** até o
  memtier expor a tool MCP (hoje só `recall`/`ingest`/`code_search`/`code_sync`).
- Migrar as memórias antigas (cancelado no memtier).

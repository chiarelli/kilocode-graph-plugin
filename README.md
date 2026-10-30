# kilocode-graph-plugin

Plugin do Kilo Code que injeta **memória curada** e **RAG de código do
repositório** em cada turno, usando o [`memtier`](../graphiti-daemon/) como
provider.

Substitui o `kilo-openviking-plugin` por baixo: os hooks do Kilo são os mesmos,
o provider muda.

> **Status:** E1 (fundação), E2 (memória), E3a/E3b/E3c (código) e E4 (ingestão)
> implementados; PRD e arquitetura continuam drafts (v0.2). O boot também
> **provisiona o workspace memtier 1:1** e resolve config/banco por workspace (ver
> §Configuração). Segunda onda (E5–E7) é forma e contratos.
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
| [`docs/rfc/`](docs/rfc/README.md) | RFCs — problemas observados (RFC-001: navegação do grafo e identidade no RAG) |

## Hooks do Kilo usados

O plugin usa **hooks de evento** (não captura por `chat.message`):

| Hook | Papel |
|---|---|
| `event` (`message.updated`) | **acorda** a rotina de ingestão (o conteúdo vem do `kilo.db`, ADR-007) |
| `event` (`session.idle`) | acorda a MESMA rotina com **dreno** (envia o resto — ADR-007) |
| `experimental.chat.messages.transform` | **injeção** no turno (memória + código) |
| `experimental.chat.system.transform` | contexto de sistema |
| `experimental.session.compacting` | preservar memória na compactação |

## Configuração e provisionamento

O plugin roda **por escopo de workspace**, mesmo instalado globalmente. O
diretório do workspace vem do **runtime do Kilo** (`ctx.worktree` >
`ctx.directory` > cwd); é dele que saem o config e o banco — nunca de
`process.cwd()`.

| Item | Origem | Onde fica |
|---|---|---|
| Endpoint do memtier | env `KILOCODE_GRAPH_URL` (default `http://127.0.0.1:8400`) | — |
| Config do plugin | `<workspace>/.kilo/graph-plugin.json` > `~/.config/kilo/graph-plugin.json` | workspace/global |
| Nome do workspace | derivado do dir = `<stem>-<sha1 8>`; override `KILOCODE_GRAPH_WORKSPACE` | — |
| Bearer do workspace | arquivo `.kilo/graph-key.json` = `{ token, workspace, program }` (`0600`) | `./.kilo/` do workspace |
| Banco de sessões | `Path.data` do runtime (`XDG_DATA_HOME ?? ~/.local/share` + `/kilo`) + regra `KILO_DB` | runtime |
| Bearer do **gestor** | env `KILOCODE_GRAPH_MANAGER_TOKEN` (opcional) | — |

**Mapeamento 1:1.** Cada workspace Kilo corresponde a um workspace memtier. O
nome do workspace memtier é **`<stem>-<sha1 8 do caminho>`** (ex.:
`kilocode-graph-plugin-<sha1 8>`) — o sufixo de hash **sempre presente** minimiza
colisões entre diretórios distintos (mesmo basename, saneamento ou truncamento).
O vínculo é controlado pela chave do workspace em `./.kilo/`. Quem tem token
pré-escopado a um nome exato (o memtier escopa o bearer ao nome **exato**) pina a
identidade via `KILOCODE_GRAPH_WORKSPACE`.

**Provisionamento automático.** Com `KILOCODE_GRAPH_MANAGER_TOKEN` no ambiente e
a chave do workspace **ausente**, o plugin cria o workspace memtier no boot e
salva a chave — o usuário não faz onboarding manual:

```
gestor (env) ──▶ POST /v1/mgmt/programs → /v1/mgmt/workspaces → /v1/mgmt/invites
                 ──▶ POST /v1/auth/claim-user (show-once) ──▶ POST /v1/auth/rotate
                 ──▶ grava <workspace>/.kilo/graph-key.json  (token rotacionado, 0600)
```

Sem o bearer do gestor, a chave do workspace é pré-requisito manual (como antes).
A rotação é obrigatória (o bearer do claim tem `must_rotate=true`); o token
resultante é o persistido. O fluxo nunca lança nem sobrescreve uma chave
utilizável — falha degrada para o caminho `401` de sempre. Envs completas em
[`src/README.md`](src/README.md#variáveis-de-ambiente).

**Prova.** Unit: `tests/provision.test.ts` (5 passos, `exists` não sobrescreve,
degradação, concorrência). E2E real contra o memtier
(`tests/e2e/test_e2e_provision.test.ts`, gated `E2E=1` + `E2E_MANAGER_TOKEN`):
boot → cria o workspace → grava a chave → a chave autentica em `/v1/recall`
(prova que é o bearer rotacionado) → 2º boot não reescreve. Tabela completa de
verificação em [`src/README.md`](src/README.md#verificação-o-que-prova-cada-afirmação).

## Coleta de código (o coletor)

O plugin **não** faz parsing — ele **spawna** o binário do `rust-ast-indexer`
(caminho configurável) e traduz os eventos JSONL para o contrato do memtier:

```
rust_indexer (JSONL) ──▶ chunk_emitted / import_edge / call_edge
   └─▶ agrupa por arquivo, resolve arestas, detecta removidos (manifest)
       └─▶ POST /v1/code/sync (202)
```

Fora do caminho crítico do turno. Ver ADR-005 e `docs/ARCHITECTURE.md` §4.

**Gatilho (E3a-S6, [ADR-011](docs/adr/011-gatilho-do-delta-em-runtime.md)).** O
**CLI standalone** (`src/cli.ts`) é o **único escritor** do grafo. No boot, o
plugin **não coleta**: ele **invoca o CLI em `auto`** (background: `full` no 1º
uso, `incremental` depois) e instala **hooks git** (`post-commit`/`post-checkout`/
`post-merge`/`post-rewrite`, idempotentes, **sem** `core.hooksPath`). Um commit
com o Kilo aberto atualiza o grafo sem reiniciar: o hook dispara o CLI, que roda
o **incremental** — guardado por um **sentinela** (`.kilo/graph-ready`, só arma
após o full inicial), pela **guarda de ancestralidade** (`merge-base --is-ancestor`
→ senão `full`) e por uma **trava cross-process** (`O_EXCL`). Deleções entram no
incremental via `git diff --diff-filter=D` (`chunks: []`). Delta **por commit**;
mudanças não-commitadas ficam fora (FR-507). Ver
[`docs/rfc/002`](docs/rfc/002-sync-de-delta-em-runtime.md).

## Não-objetivos

- Implementar o provider de memória (é do **memtier**).
- **Implementar o parser/chunker** — é do `rust-ast-indexer`, que é uma
  **dependência de runtime do cliente**. O plugin apenas o executa e **coleta** os
  eventos (agrupar por arquivo, resolver arestas, sincronizar).
- **Navegação por código vizinho** (`/v1/code/neighbors`) — **travada** até o
  memtier expor a tool MCP (hoje só `recall`/`ingest`/`code_search`/`code_sync`).
  Ver [`docs/rfc/001`](docs/rfc/001-navegacao-e-integridade-do-grafo-de-codigo.md)
  (a rota HTTP também é inutilizável: falta o `uuid` de entrada).
- Migrar as memórias antigas (cancelado no memtier).

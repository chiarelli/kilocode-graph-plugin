# RFC-001 — Navegação do grafo de código e integridade do texto do chunk

**Status:** aberto · **Data:** 2026-10-16
**Autor:** verificação empírica em runtime (workspace `workspace-8af22c44`, programa `graphplugin`)
**Componentes afetados:** memtier (MCP + `/v1/code/*`), `rust-ast-indexer` (chunking), este plugin (contrato de coleta)
**Relacionados:** [ADR-006](../adr/006-push-vs-pull-mcp.md) (push vs pull; bloqueio de navegação), [ADR-005](../adr/005-plugin-e-o-coletor.md) (o plugin é o coletor)

## Resumo

Três achados, em ordem de severidade:

1. **A navegação do grafo de código não é exposta via MCP.** O memtier só publica
   `recall`, `ingest`, `code_search` e `code_sync`. Não há tool de traversal.
2. **`/v1/code/neighbors` está implementada no servidor, mas é inutilizável na
   prática.** A aresta é gravada, mas o endpoint não devolve vizinhos para nenhum
   identificador que o cliente consegue obter — `code_search` não expõe o `uuid`
   que `neighbors` exige. Contrato partido entre as duas pontas.
3. **Todo chunk de símbolo é prefixado com a string `import (`.** O chunker de
   contexto trata o abre-parênteses de um bloco Go `import ( ... )` como se fosse
   uma linha de import, injeta só `import (` e descarta os caminhos importados.
   Ruído sistemático em todo chunk — suja embeddings e não cumpre a intenção de
   dar contexto de imports.

Os itens 1 e 2 são **lacuna/contrato** (não há código errado no plugin — ele
apenas repassa o que existe). O item 3 é **bug** de chunking, no
`rust-ast-indexer`.

---

## 1. Navegação do grafo de código não é exposta via MCP

### Observação

`tools/list` no MCP do memtier (`POST /v1/mcp`, JSON-RPC `tools/list`) devolve
exatamente **4** tools:

```
recall       — Recall semântico de fatos de memória
ingest       — Ingere um episódio de memória
code_search  — Busca híbrida de código (semântica + BM25)
code_sync    — Sincroniza chunks de código de um arquivo
```

Não há `neighbors`, `code_neighbors`, `traverse` nem equivalente.

### Consequência

O agente não consegue **navegar** o grafo de código (seguir arestas de
import/chamada) por ferramenta. Só há **busca** pontual. Isso já está registrado
como bloqueio no [ADR-006](../adr/006-push-vs-pull-mcp.md#bloqueio-registrado-navegação)
e como não-objetivo no `README.md` (§Não-objetivos):

> **Navegação por código vizinho** (`/v1/code/neighbors`) — **travada** até o
> memtier expor a tool MCP (hoje só `recall`/`ingest`/`code_search`/`code_sync`).

### Proposta

Expor a tool MCP `code_neighbors` no memtier, com o mesmo contrato de
`/v1/code/neighbors` (`workspace`, `program`, `uuid`, `direction`, `edge_kind`,
`depth`, `limit`). Enquanto isso não acontecer, o plugin **não** promete
navegação nem a reimplementa por HTTP (ADR-006: não criar uma segunda superfície
para o mesmo dado, fora do modelo pull).

---

## 2. `/v1/code/neighbors` — implementada, mas inutilizável de ponta a ponta

### Observação

O endpoint existe no servidor (`POST /v1/code/neighbors`, schema
`CodeNeighborsBody`), mas **não tem tool MCP**. Testado com um caso controlado:

1. Sincronizados dois arquivos com uma aresta explícita:
   ```
   POST /v1/code/sync
   files: probe/nav_a.go (FullFile), probe/nav_b.go (FullFile)
   edges: [{ from_file: "probe/nav_a.go", to_file: "probe/nav_b.go", edge_kind: "call" }]
   → {"upserted":2, "edges_upserted":1, "edges_deleted":0}   ← aresta GRAVADA
   ```
2. Consultados vizinhos com **todos** os identificadores plausíveis:
   ```
   uuid="probe/nav_a.go:FullFile"        → {"neighbors":[],"total_neighbors":0}
   uuid="probe/nav_a.go"                 → {"neighbors":[],"total_neighbors":0}
   uuid="<chunk_md5>"                    → {"neighbors":[],"total_neighbors":0}
   uuid="full-probe/nav_a.go"            → {"neighbors":[],"total_neighbors":0}
   uuid="probe/nav_a.go:checkpointSummary" → {"neighbors":[],"total_neighbors":0}
   direction=both|out, edge_kind=all
   ```

### Diagnóstico: contrato partido

`neighbors` exige um **`uuid` de vértice**. Mas a resposta de `code_search` **não
inclui `uuid`** — os campos devolvidos são:

```
{ path, symbol, start_line, end_line, code, score, match }
```

E a resposta de `code_sync` também não devolve `uuid` (`{ workspace, upserted,
deleted, changed, skipped, results[] }`). Ou seja:

- **Não há como o cliente obter o `uuid`** que `neighbors` espera.
- Sem `uuid`, não existe encadeamento `code_search → neighbors` (o fluxo natural:
  achar o símbolo, então navegar suas arestas).
- A aresta é persistida (`edges_upserted: 1`), então o problema **não** é coleta
  nem gravação — é **descoberta do identificador** (contrato de saída incompleto).
- Também é possível que o `uuid` seja um id interno de vértice que o `edges`
  de arquivo→arquivo não alimenta do lado que o `neighbors` lê (aresta
  `from_file`/`to_file` **sem** `from_symbol_id`/`to_symbol_id` — o schema
  `CodeEdgeBody` permite símbolos nulos). Não foi possível distinguir as duas
  hipóteses de fora, porque não há endpoint de introspecção de vértices.

### Evidência de que o problema é de contrato, não de uso

O `README.md` (§Não-objetivos) já trata a navegação como travada, mas o motivo
registrado é só "não é tool MCP". Este RFC acrescenta que **mesmo pela rota HTTP
o endpoint é inutilizável de ponta a ponta**, porque o identificador de entrada
não é exposto por nenhuma saída.

### Propostas (alternativas, em ordem de preferência)

1. **`code_search` e `code_sync` devolvem o `uuid` do chunk/vértice.** Menor
   mudança; habilita o fluxo `search → neighbors` sem novo endpoint.
2. **`neighbors` aceita identificadores estáveis do cliente** em vez de `uuid`
   interno: `{ path, symbol_id }` ou `chunk_id`, resolvidos no servidor.
3. **Expor `code_neighbors` como tool MCP** (§1) já com a correção do
   identificador — resolve os dois itens de uma vez.

Critério de aceite (qualquer opção): sincronizar A→B, buscar B, encadear
`neighbors` e receber A (e vice-versa em `direction=both`).

---

## 3. Prefixo `import (` em todo chunk de símbolo (bug de chunking)

### Observação

**Todo** chunk de símbolo indexado começa com a string literal `import (`
seguida de uma linha em branco, antes do código real. Verificado no bloco
**efetivamente injetado** no turno (`/tmp/kilocode-graph-plugin-inject.log`) e
também na resposta da API `code_search`:

```
import (

// checkpointSummary renders the deterministic pair-checkpoint receipt ...
func checkpointSummary(r domain.PairCheckpointReceipt) string {
```

Reproduzido de forma idêntica em `internal/adapters/http/trace.go`,
`internal/adapters/http/relacao.go`, `internal/adapters/http/drogas.go`,
`internal/adapters/memory/consult_progress.go`, `internal/adapters/mcp/server.go`
— em **todos**, não em casos isolados.

### Causa raiz

No `rust-ast-indexer`, o chunker de injeção de contexto
(`rust_indexer/src/application/chunking/with_context.rs`) monta um prefixo com
os imports do topo do arquivo:

```rust
fn is_import_line(line: &str) -> bool {
    line.starts_with("use ") || line.starts_with("import ")
}
```

Em Go, um bloco de imports **multi-linha** é:

```go
import (
	"context"
	"sync"
)
```

A primeira linha, já `trim`, é `import (`. E `"import (".starts_with("import ")`
é `true` → a linha é classificada como import e empurrada para o prefixo. as
linhas seguintes (`"context"`, `"sync"`) **não** casam (`trimmed` não começa com
`import `/`use `), e como `seen_import` já é `true`, ocorre `break`. Resultado: o
bloco de contexto vira exatamente `"import (\n\n"` — só o abre-parênteses, sem
nenhum caminho importado. O teste `injects_import_prefix` do próprio arquivo usa
`use crate::foo;` (Rust), então o caso Go nunca foi coberto.

O comportamento está **ligado por default**: `ChunkingOptions::default()` tem
`include_context: true` (`strategy.rs:35`), e o decorator `ContextInjectionChunker`
está exportado em `chunking/mod.rs`.

### Impacto

- **Ruído sistemático** no texto de todo chunk de função (suja embeddings e o
  ranking híbrido; o prefixo pode deslocar a similaridade).
- **Não corrompe** o corpo da função — o código real vem íntegro, então o RAG
  ainda funciona. É degradação de qualidade, não perda de dado.
- **A intenção do recurso falha** para Go: o contexto de imports — que deveria
  ajudar o modelo — vira uma linha sem significado e **descarta** os caminhos
  importados.

### Propostas

1. **Reconhecer blocos de import multi-linha** (`import (`, `from x import (`,
   `use x::{`, etc.): ao ver o abre-parênteses/chaves, capturar as linhas internas
   até o fechamento e injetá-las (ou injetar o bloco completo, `import (\n\t"context"\n)`,
   em vez de só a linha de abertura).
2. **Não injetar a linha de abertura órfã.** No mínimo, se a única "linha de
   import" capturada for um delimitador (`import (`, `use x::{`), o prefixo deve
   ser descartado — melhor nada do que um `import (` sem corpo.
3. **Cobrir Go no teste.** Estender `injects_import_prefix` (e adicionar um caso
   de bloco multi-linha) para as linguagens alvo; hoje só Rust/`use` é testado.

### Aceite

Indexar um arquivo Go com bloco `import ( ... )` e verificar que o `text` do
chunk (a) **não** começa com `import (` órfão e (b) ou traz os caminhos
importados, ou não traz prefixo algum.

---

## Anexo — como os achados foram verificados

- **Tools MCP:** `POST /v1/mcp` com `tools/list` (JSON-RPC), autenticado com o
  bearer do workspace.
- **Busca de código:** tool MCP `code_search` (via chamada de ferramenta) e
  `POST /v1/code/search`; faixas `start_line`/`end_line` cruzadas com o arquivo
  em disco (`grep -n "^func ..."`).
- **Navegação:** aresta controlada via `POST /v1/code/sync` + `POST
  /v1/code/neighbors` com 5 formas de identificador.
- **Prefixo `import (`:** comparado no bloco injetado
  (`/tmp/kilocode-graph-plugin-inject.log`) e na resposta de `code_search`;
  causa raiz lida em `rust_indexer/src/application/chunking/with_context.rs`
  (`is_import_line`, `extract_leading_imports`, `build_context_block`) e no
  default `ChunkingOptions` (`strategy.rs`).

## Encaminhamento

| Item | Dono | Ação |
|---|---|---|
| 1. Tool MCP de navegação | memtier | expor `code_neighbors` (ADR-006 já prevê herdar sem código novo no plugin) |
| 2. Contrato `uuid` de `neighbors` | memtier | expor `uuid` em `code_search`/`code_sync` **ou** aceitar id estável do cliente |
| 3. Prefixo `import (` | `rust-ast-indexer` | corrigir `is_import_line`/contexto para blocos multi-linha + teste Go |

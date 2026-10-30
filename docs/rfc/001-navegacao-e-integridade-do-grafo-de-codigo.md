# RFC-001 — Navegação dos grafos (código e memória) e identidade no RAG injetado

**Status:** aberto · **Data:** 2026-10-16 (rev. 2: itens 4–7; rev. 3: correção da âncora da BFS; rev. 4: item 3 removido — bug do `rust-ast-indexer`; **rev. 5 (2026-10-30): auditoria contra o memtier v1.1.0** — achados 1, 2 e 5 fechados no servidor; decisões de `score`, episódios e `depth` tomadas; §7 = dívida documental)
**Autor:** verificação empírica em runtime (workspace `workspace-8af22c44`, programa `graphplugin`) + discussão de consumidor (rev. 2)
**Componentes afetados:** memtier (MCP + `/v1/code/*` + `/v1/recall`), este plugin (contrato de coleta **e** injeção/RAG)
**Relacionados:** [ADR-006](../adr/006-push-vs-pull-mcp.md) (push vs pull; bloqueio de navegação), [ADR-005](../adr/005-plugin-e-o-coletor.md) (o plugin é o coletor), [ADR-009](../adr/009-limites-por-endpoint-e-piso-de-confianca.md) (orçamento por endpoint), [RFC-004 do memtier](../../../graphiti-daemon/docs/rfc/004-navegacao-do-grafo-de-codigo-mcp-e-neighbors.md) (o que compete ao memtier entregar — M1–M6)

## Resumo

Seis achados, em ordem de severidade. **Estado em 2026-10-30 (rev. 5):** os
achados 1, 2 e 5 foram **fechados pelo memtier v1.1.0**; os achados 3, 4 e 6 são
trabalho do plugin e estão **desbloqueados**.

1. **A navegação do grafo de código não é exposta via MCP.** O memtier só publica
   `recall`, `ingest`, `code_search` e `code_sync`. Não há tool de traversal.
   → **fechado**: 7 tools, incluindo `code_neighbors` (§1).
2. **`/v1/code/neighbors` está implementada no servidor, mas é inutilizável na
   prática.** A aresta é gravada, mas o endpoint não devolve vizinhos para nenhum
   identificador que o cliente consegue obter — `code_search` não expõe o `uuid`
   que `neighbors` exige. Contrato partido entre as duas pontas.
   → **fechado**: `uuid` é o 9º campo de `code_search` (§2).
3. **O bloco de RAG injetado descarta a identidade e a relevância do que
   injetou.** O `uuid` existe no fio para memória (`memory.py`) e é descartado na
   formatação; `score` chega e também não é injetado. No código, o `uuid` **não
   chega** (a rota remove, §2) e o `score`/`raw_score` também não é injetado.
   Resultado: o modelo recebe texto anônimo — não pode citar, não pode pedir
   expansão, não pode calibrar confiança.
   → **pendente (plugin)**. Decidido: injetar `uuid` completo; **não** injetar
   `score` (§3). O `uuid` de código agora chega — só falta o plugin usá-lo.
4. **`episodes` é calculado no servidor e descartado pelo plugin.** Sem ele não há
   âncora do fato até o episódio de origem — logo não há expansão para o texto
   original que gerou a memória.
   → **pendente (plugin)**. A rota existe desde o v1.1.0. Decidido: primeiro
   episódio + marcador `+N` (§4).
5. **Não existe navegação de memória.** Só `neighbors` de *código*. O `recall`
   aceita BFS (`depth` 1–3), mas ela é **enraizada na query**, não em um nó: não
   há campo `uuid` no body, então não dá para pedir "expanda este item". O
   plugin também nunca envia `depth`. Nenhuma das duas pontas oferece âncora e
   multi-hop ao mesmo tempo (§5).
   → **fechado**: `memory_neighbors` (ancorada, 1 salto) e `memory_episodes`.
   `depth` no plugin foi **descartado** (§5).
6. **O plugin não instrui o modelo a usar o memtier.** O bloco de RAG entra no
   turno sem dizer ao modelo que existe um grafo consultável. O modelo trata o
   contexto como estático.
   → **pendente (plugin)**. O bloqueio "não anunciar tool inexistente" caiu (§6).

Os itens 1, 2 e 5 eram **lacuna/contrato** — resolvidos no memtier. Os itens 3, 4
e 6 são **trabalho do plugin** (consumir o que já chega no fio e instruir o
modelo), com custo baixo. O item 3 estava **bloqueado pela metade** para código
porque o `uuid` não chegava; **não está mais** (§2).

A **§7** registra a dívida documental que precisa cair junto: README, ADR-006,
`ARCHITECTURE.md` e um E2E ainda afirmam "4 tools" e "navegação travada".

---

## 1. Navegação do grafo de código não é exposta via MCP — **RESOLVIDO no memtier v1.1.0**

### Observação (estado original, 2026-10-16)

`tools/list` no MCP do memtier (`POST /v1/mcp`, JSON-RPC `tools/list`) devolvia
exatamente **4** tools:

```
recall       — Recall semântico de fatos de memória
ingest       — Ingere um episódio de memória
code_search  — Busca híbrida de código (semântica + BM25)
code_sync    — Sincroniza chunks de código de um arquivo
```

Não havia `neighbors`, `code_neighbors`, `traverse` nem equivalente.

### Consequência (na época)

O agente não conseguia **navegar** o grafo de código (seguir arestas de
import/chamada) por ferramenta. Só havia **busca** pontual. Isso estava
registrado como bloqueio no [ADR-006](../adr/006-push-vs-pull-mcp.md) e como
não-objetivo no `README.md` (§Não-objetivos).

### Estado em 2026-10-30 — fechado

O memtier **v1.1.0** publica **7** tools (verificado por `tools/list` contra
`memtier.tail7d66cf.ts.net:8400` com bearer de workspace):

```
recall  ingest  code_search  code_sync
code_neighbors  memory_episodes  memory_neighbors
```

`code_neighbors` é thin sobre `POST /v1/code/neighbors`, com o mesmo body
(`workspace`, `program`, `uuid`, `direction`, `edge_kind`, `depth`, `limit`) e
capability `read`. **O lado memtier desta RFC está fechado.**

**O que resta é trabalho do plugin:** o ADR-006 prevê que ele herde a tool sem
código novo (o registro do MCP é por servidor, não por tool), mas a documentação
que declara a navegação "travada" precisa cair — ver §7 (dívida documental) e o
encaminhamento.

---

## 2. `/v1/code/neighbors` — contrato partido — **RESOLVIDO no memtier v1.1.0**

### Observação (estado original, 2026-10-16)

O endpoint existia no servidor (`POST /v1/code/neighbors`, schema
`CodeNeighborsBody`), mas **não tinha tool MCP** e o identificador de entrada não
saía de nenhuma outra rota. Testado com um caso controlado:

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

### Evidência de que o problema era de contrato, não de uso

O `README.md` (§Não-objetivos) tratava a navegação como travada, mas o motivo
registrado era só "não é tool MCP". Este RFC acrescentou que **mesmo pela rota
HTTP o endpoint era inutilizável de ponta a ponta**, porque o identificador de
entrada não era exposto por nenhuma saída — diagnóstico que o v1.1.0 confirmou
ao corrigi-lo expondo o `uuid`.

### Propostas (alternativas, em ordem de preferência)

1. **`code_search` e `code_sync` devolvem o `uuid` do chunk/vértice.** Menor
   mudança; habilita o fluxo `search → neighbors` sem novo endpoint.
2. **`neighbors` aceita identificadores estáveis do cliente** em vez de `uuid`
   interno: `{ path, symbol_id }` ou `chunk_id`, resolvidos no servidor.
3. **Expor `code_neighbors` como tool MCP** (§1) já com a correção do
   identificador — resolve os dois itens de uma vez.

Critério de aceite (qualquer opção): sincronizar A→B, buscar B, encadear
`neighbors` e receber A (e vice-versa em `direction=both`).

### Estado em 2026-10-30 — fechado (opção 1 + 3, e não a 2)

O memtier **v1.1.0** entregou `uuid` como 9º campo de `code_search` (opção 1,
aditiva; `code_sync` ficou intocado) **e** a tool `code_neighbors` (opção 3).
Verificado no servidor real:

```json
{"uuid":"39e6c181-72f4-521c-8e60-3d8ea7a00b82","path":"src/inject/memory.ts",
 "symbol":null,"start_line":1,"end_line":299,"code":"…","score":1.0,
 "raw_score":0.814,"match":"hybrid"}
```

A **opção 2 foi recusada** (o memtier não aceita `{path, symbol_id}`): o `uuid` é
`uuid5` determinístico, então expô-lo resolve o encadeamento sem inventar uma
segunda forma de identidade.

O achado adicional abaixo **deixa de ser workaround**: com o `uuid` no fio, o
teste E2E pode parar de recalcular `uuid5` localmente (ver encaminhamento).

### Achado adicional (rev. 2) — o `uuid` é determinístico, mas o cliente não deveria recalculá-lo

`chunk_identifier` calcula `uuid5(CODE_NS, "<file>:<symbol>")` (`code.py:241`).
O E2E do plugin **já recalcula isso localmente** (`tests/e2e/test_e2e_collector.test.ts:42`,
`chunkUuid`) para conseguir chamar `neighbors` — e é exatamente o que permite
afirmar hoje que a navegação funciona quando o id é obtido por fora.

Isso **não** é uma solução de contrato, é uma duplicação:
`uuid5` viraria uma terceira cópia da fórmula de identidade (memtier, teste E2E
e, se promovido, o `src/`). Se o memtier mudar `CODE_NS` ou a chave
(`identity_key`), o cliente quebra em silêncio — e o teste E2E junto. O
encaminhamento continua o das propostas 1–3; recalcular no cliente é
**workaround de teste**, não caminho de produção.

Consideração operacional: o workaround por HTTP direto (obter o `uuid` via
Cypher e chamar `neighbors` com `curl`) exige o bearer do workspace e não é
ergonômico — e o ADR-006 proíbe uma segunda superfície de dados no plugin. O
caminho correto é o memtier expor a tool.

---

## 3. O bloco de RAG injetado não carrega identidade (`uuid`) nem relevância (`score`)

### Observação

Hoje o plugin formata os dois blocos com **texto anônimo**:

- **Memória** (`src/inject/memory.ts:70`, `formatFact`): emite
  `- <fato> (válido desde <data>)`. O `uuid` e o `score` existem no objeto
  `Fact` recebido do fio, mas **não são formatados**. O `Fact` do client
  (`src/client.ts:247`) sequer declara `uuid`/`episodes` — o comentário em
  `:245` diz literalmente que eles "existem no fio mas a E2 não os consome".
- **Código** (`src/inject/code.ts:67`, `chunkHeader`): emite
  `[CÓDIGO RELEVANTE — <path>:<ini>-<fim>]`. Não há `uuid` (ele **não chega**,
  §2) e `score`/`raw_score` existem em `CodeChunkHit` e não são formatados.

O que o servidor realmente entrega:

| Bloco | Campo no fio | Chega ao plugin? | Formatado? |
|---|---|---|---|
| memória | `uuid` | sim (`memory.py:268`) | **não** |
| memória | `score` (normalizado `[0,1]`) | sim (`memory.py:266` + `_normalize_scores`) | **não** |
| memória | `episodes` (lista de uuid de episódio) | sim (`memory.py:269`) | **não** |
| código | `uuid` | **não** — removido na rota (`code.py:1440`, `main.py:1029`) | — |
| código | `score` (ordem/RRF) e `raw_score` (magnitude) | sim | **não** |

### Consequência

O modelo recebe conteúdo sem âncora nem calibração:

- **Não pode citar** um item de forma estável ("o fato X", "o chunk Y") — só
  repete o texto.
- **Não pode pedir expansão** — não tem chave para passar a uma tool.
- **Não consegue avaliar confiança** — um `score` de 0,3 e um de 1,0 são
  apresentados de forma idêntica, então o modelo não sabe se vale reformular a
  consulta ou se já achou o que precisava.
- **Não consegue deduplicar mentalmente** — `chunkIdentity` é `path:start-end`
  no plugin (`code.ts:150`), que não é a identidade do vértice no grafo. O
  `uuid` é determinístico no servidor (`code.py:241`, `uuid5` sobre
  `file:symbol`), então essa divergência é gratuita.

### Propostas

1. **Injetar `uuid` no bloco de memória.** Custo baixo: um `[id=…]` por linha em
   `formatFact`. Declarar `uuid`/`episodes` no tipo `Fact` do client (hoje
   ausentes) e parar de descartá-los. Sem tool que consuma o id, o ganho
   imediato é citar/referenciar — mas é pré-requisito de §4 e §5.
2. **Injetar `score` nos dois blocos.** Mesmo arquivo, custo baixo. Ajuda o
   modelo a decidir se vale reformular. Exige decidir **formato** (número cru,
   bucket qualitativo, ou ambos) — ver decisão abaixo.
3. **Injetar o `uuid` de código.** O memtier v1.1.0 já o expõe como 9º campo de
   `code_search` (ver §7); falta só o plugin declarar e formatar o campo.
4. **Prefixar cada bloco com uma linha de uso** que explique a semântica do id —
   sem isso, `[id=…]` é um número sem significado para o modelo.

### Decisão — `score` não é injetado (resolvida em 2026-10-30)

O `score` de memória e o de código **não são a mesma grandeza**, e nenhum dos
dois é comparável entre consultas:

- memória: RRF normalizado pelo top-1 do próprio resultado (`memory.py:412`) —
  relativo à consulta, **top-1 sempre 1.0**;
- código: `score` é ordem/RRF (top-1 = 1.0) e `raw_score` é magnitude — no
  componente fulltext o `raw_score` também é relativo ao topo da MESMA consulta
  (`code.py:1296-1299`).

**Medido neste workspace (3 consultas reais):**

```
[1.0, 0.667, 0.5, 0.222, 0.222]
[1.0, 0.667, 0.556, 0.333, 0.267]
[1.0, 0.5, 0.333, 0.25, 0.2]
```

O primeiro item é `1.0` **por construção**, em toda consulta. Exibir `0.5` cru
ensina ao modelo uma falsa escala: metade do melhor *daquela* consulta não é
"50% de confiança". Bucket pela razão contra o top-1 informa o *gap*, que é o
único sinal que a ordem não dá — mas custa tokens em todo turno.

**Decisão: não injetar `score`.** A ordem da lista já transmite o ranking, e o
`score` não tem significado absoluto que justifique o custo. O `raw_score` de
código segue disponível ao cliente (campo opcional, `CodeChunkHit`), sem ir ao
bloco. Reabrir se houver evidência de que o modelo erra por falta de calibração.

### Aceite

Injetar um turno com memória e código e verificar que cada item traz um id
estável e **completo** (36 chars — o modelo precisa dele para chamar a tool), e
que o bloco não contém `score`.

---

## 4. `episodes` é calculado e descartado — sem âncora do fato até a origem

### Observação

O servidor devolve, por fato, a lista de `episodes` — os UUIDs dos episódios de
origem (`memory.py:256-269`, campo nativo do `EntityEdge`). O plugin:

- não declara o campo no tipo `Fact` (`src/client.ts:247-253`);
- não o formata (`formatFact`);
- portanto o episódio de origem é **inacessível** do lado do consumidor.

### Consequência

Expandir uma memória significa ir do fato atômico ao **texto original** que o
gerou — é a diferença entre "o usuário prefere X" e a mensagem concreta em que
ele disse isso, com o contexto todo. Sem `episodes`, essa expansão não tem
ponto de partida. A rota que busca o episódio **existe desde o v1.1.0**
(`POST /v1/memory/episodes`), mas o plugin ainda não declara nem formata
`episodes`, então o id nunca chega ao modelo.

A assimetria com o código importa: lá a expansão é **topológica** (arestas
import/call, `neighbors`); aqui é **documental** (fato → episódio → texto). São
duas navegações diferentes e a RFC não deve tratá-las como a mesma coisa.

### Propostas

1. **Plugin: declarar e formatar `episodes`** no bloco de memória, junto com o
   `uuid` do fato (§3). Custo baixo; sozinho, serve para citar a origem.
2. **Memtier: rota de leitura de episódio** por uuid (ou lote), atrás da
   capability `read`, no mesmo padrão read-only de `neighbors` (sem LLM, sem
   `ensure_graph`). É o que transforma o id em conteúdo. → **entregue no
   v1.1.0** (`POST /v1/memory/episodes` + tool `memory_episodes`).
3. **Avaliar o tamanho da lista.** Um fato pode ter vários episódios; injetar
   todos consome orçamento de tokens sem ganho proporcional.

### Decisão — primeiro episódio + sinal de "+N" (resolvida em 2026-10-30)

**Medido neste workspace:** 100% dos fatos amostrados (15, em 3 consultas) têm
**exatamente 1** episódio. O `content` do episódio varia: 2.436 chars no caso
amostrado, com máximo de 47.058 no grafo `alfa` (RFC-004 D4).

**Decisão:** injetar o uuid do **primeiro** episódio e, quando houver mais, um
marcador `+N` que sinaliza a existência sem gastar tokens com os demais. O
modelo chama `memory_episodes` para resolver o uuid em texto.

Justificativa do custo: 36 chars por fato por episódio. Com 5 fatos e 1 episódio
cada, são ~180 chars ≈ 45 tokens por turno. Injetar o `content` está fora de
questão — um único episódio de 2,4k chars consumiria o orçamento inteiro de
memória (`memory_max_tokens` default 2000 ≈ 8.000 chars).

### Aceite

`recall` → bloco injetado com o `uuid` do fato **e** do primeiro episódio →
`memory_episodes` com esse uuid devolve o texto original. Verificado contra o
servidor real: a rota responde `content` de 2.436 chars.

---

## 5. Navegação de memória não existia — a BFS do `recall` nunca foi navegação

### Observação (estado original, 2026-10-16)

O memtier tinha **uma** rota de navegação: `POST /v1/code/neighbors`. Para
memória não havia equivalente. Confirmação pela lista de rotas (`main.py`):
`/v1/health`, `/v1/workspaces/*`, `/v1/code/{sync,search,neighbors}`,
`/v1/recall`, `/v1/ingest`, e o plano de controle. Nada de
`/v1/memory/*`, `/v1/episodes/*`, `/v1/edges/*`.

Mas o `recall` **tem** uma perna BFS, e é preciso descrever exatamente o que
ela é — porque a diferença com o código é o cerne deste item.

### O que a BFS de memória faz

Caminho: `POST /v1/recall` → `memory.recall()` → `graphiti_core.search.search()`
→ `edge_bfs_search()`. O memtier **não** passa `bfs_origin_node_uuids`
(`memory.py:170`), então a lib deriva as origens sozinha:

```python
# graphiti_core/search/search.py:332
source_node_uuids = [
    edge.source_node_uuid for result in search_results for edge in result
]
```

Cada aresta casada por BM25/vetor contribui com o seu `source_node_uuid`; esses
nós viram as origens. A expansão é `*1..depth` sobre
`[:RELATES_TO|MENTIONS]` (`search_utils.py:544`), com orçamento próprio de
`2 × limit` (`search.py:348`). O que volta é **aresta** (`EntityEdge`), não nó —
serializada como fato.

| Parâmetro | Valor | Origem |
|---|---|---|
| `depth` | 1..3 | `MAX_DEPTH` em `memory.py:93` |
| `limit` | 1..25 | `MAX_LIMIT` em `memory.py:94` |
| Orçamento do BFS | `2 × limit` | `search.py:348` |
| Arestas percorridas | `RELATES_TO` + `MENTIONS` | `search_utils.py:544` |

Duas propriedades que mudam a leitura do recurso:

**a) Segue só arestas de saída.** O padrão é `(origin)-[...*1..N]->(:Entity)`.
Não é travessia bidirecional. Um fato que aponta **para** o nó de origem não é
alcançado.

**b) `depth=1` já traz irmãos.** A expansão parte do **nó de origem**, não da
aresta casada — então todas as arestas de saída desse nó entram. O docstring do
memtier registra isso (`memory.py:172-175`): `depth=1` reencontra a aresta
casada **e adiciona as IRMÃS** do nó; `depth≥2` alcança vizinhos encadeados.

Consequência: `depth>1` aumenta o recall e **piora a precisão** — arrasta
vizinhos sem relação com a query. O RRF reranqueia, então os fracos caem para o
fim e normalmente são cortados por `maxMemories`. Medido nesta sessão, mesma
query: `depth=1` → 5 fatos (scores 1.0 e 0.5); `depth=3` → os mesmos 5 mais 2
extras com 0.25 e 0.1667.

### O achado: a BFS é enraizada na QUERY, nunca em um nó

`RecallBody` **não tem campo `uuid`** (`main.py:1225-1242`: `workspace`,
`program`, `query`, `depth`, `limit`, `entity_types`, `node_labels`,
`include_invalid`, `as_of`). E o memtier nunca passa `bfs_origin_node_uuids`.

Logo, as origens do BFS são **sempre** derivadas de uma busca textual/vetorial.
Não existe "expanda o fato `X`" nem "expanda o nó `Y`": para chegar à
vizinhança de um item que o cliente já tem, é preciso **refazer a query** com
`depth` maior e torcer para que o item volte entre os resultados — e ele pode
não voltar, porque a perna BM25/vetor é a mesma e o `limit` é o mesmo.

Isso é o que separa **recall mais largo** de **navegação**:

- recall com `depth` = "traga mais coisas parecidas com a query, incluindo
  vizinhas das que casaram";
- navegação = "dado este item, traga os vizinhos dele", sem depender de a query
  casar de novo.

A segunda não existe para memória em nenhuma ponta. É por isso que injetar
`uuid` (§3) e `episodes` (§4) é pré-requisito: sem id estável não há como pedir
expansão de um item específico, nem hoje nem depois.

### A assimetria com o código

`/v1/code/neighbors` **não é BFS**. É travessia de profundidade fixa 1, e o
campo `depth` do request é decorativo:

```python
# main.py:1158 — o teto é 1, não 3
depth: StrictInt = Field(default=1, ge=1, le=1)
```

`depth=2` → **422** (`less_than_equal`, "Input should be less than or equal to
1"). E o Cypher (`code.py:1526-1546`) não tem `*1..N`: é `(c)-[e]->(v)` para
`out`, `(c)<-[e]-(v)` para `in`, `(c)-[e]-(v)` para `both`.

Mas o endpoint é **mais expressivo** que a BFS de memória em três pontos:
direção explícita, filtro de tipo de aresta (`import`/`call`/`all`) e payload
completo do vizinho (incluindo `uuid` e o objeto `edge` com `from_uuid`/
`to_uuid`). E — diferença decisiva — ele é **ancorado no nó**: recebe `uuid` e
devolve os vizinhos *daquele* vértice.

| Aspecto | Memória (`recall`) | Código (`neighbors`) |
|---|---|---|
| Onde o BFS roda | servidor (graphiti) | cliente (manual) |
| Profundidade | 1..3 numa chamada | fixa 1; N saltos = N chamadas |
| Direção | só saída (`->`) | `out` / `in` / `both` |
| Tipo de aresta | `RELATES_TO`, `MENTIONS` (fixo) | `import` / `call` / `all` |
| O que retorna | aresta → fato | nó chunk → código |
| Âncora | **nenhuma** (origens vêm da query) | `uuid` explícito |
| Multi-hop por tool MCP | sim (`recall` com `depth`) | não |

A inversão é o achado: **memória tem multi-hop no servidor, mas não tem âncora;
código tem âncora, mas não tem multi-hop.** Nenhuma das duas pontas oferece as
duas coisas ao mesmo tempo.

### Consequência para o plugin

- O plugin **nunca envia `depth`**: `RecallOpts` (`src/client.ts:256`) não tem o
  campo, e o comentário do `Fact` registra que a E2 não consome os campos
  aditivos. O agente só alcança a BFS se chamar a tool MCP por conta própria.
- Para código, 3 saltos exigem 3 rodadas de `uuid5` + HTTP, com o agente
  gerenciando fronteira, visitados e orçamento. Sem tool MCP, isso não acontece
  no ciclo normal do modelo (§1).

### Propostas (histórico) e o que o v1.1.0 decidiu

1. **Plugin: expor `depth` na config e no `RecallOpts`** (default 1, teto 3). —
   **DESCARTADA em 2026-10-30.** Ver "Decisão" abaixo.
2. **Plugin: instruir o modelo (§6)** a chamar `recall` com `depth`>1 quando
   quiser **mais recall**, não "navegar" — a distinção precisa estar na
   instrução, senão o modelo usa `depth` esperando alcançar um item específico e
   não alcança. — **mantida** (vai para a §6).
3. **Memtier: ancorar a expansão de memória.** ~~A menor forma é aceitar `uuid`
   no body de `recall` e repassar como `bfs_origin_node_uuids` — o parâmetro já
   existe na lib.~~ **Correção (rev. 3, ver RFC-004 do memtier §3.2):** o `uuid`
   que o cliente tem é o **da aresta** (`memory.py:240-270`,
   `edge.uuid`), e `bfs_origin_node_uuids` espera **uuid de nó**
   (`MATCH (origin:Entity {uuid: …})`, `search_utils.py:544`). Repassar direto
   devolveria `[]` em silêncio. A ponte — `EntityEdge.source_node_uuid` →
   `EntityEdge.get_by_uuid` — tem de ser feita **no servidor**. Além disso,
   ancorar exige **desligar** as pernas BM25/vetor (hoje fixas em
   `build_search_config`, `memory.py:156-193`), senão continua sendo busca. →
   **entregue por outro caminho** (ver Decisão).
4. **Memtier: definir a semântica restante** antes de qualquer rota nova. →
   **decidida** (RFC-004 D2): as duas semânticas, documental e topológica.
5. **Memtier: multi-hop de código.** → **adiada com medição** (RFC-004 D6).
6. **Se houver rota nova, tool MCP desde o início.** → **cumprido**: as três
   rotas novas nasceram com tool.

### Decisão — navegação de memória virou rota própria, não `depth` no `recall` (2026-10-30)

O memtier **v1.1.0** entregou duas rotas read-only, e **não** a proposta 3 como
escrita:

| | Proposta 3 desta RFC | v1.1.0 entregou |
|---|---|---|
| Forma | campo `uuid` no `/v1/recall` | rota nova `/v1/memory/neighbors` |
| Âncora | nó resolvido da aresta | **uuid da aresta**, direto |
| Direção | — | não-dirigida (**as duas pontas**) |
| Saltos | `depth` 1..3 | **fixo em 1** |
| Pernas de busca | desligadas por flag | rota separada, sem busca |

O desenho do servidor é **melhor** que a proposta: separar as rotas evita o modo
híbrido "busca + vizinhança" que a própria proposta 3 dizia precisar desligar. E
ancorar na **aresta** (não no nó) preserva o shape de 7 campos do fato, sem
expor `source_node_uuid`/`target_node_uuid` ao cliente.

**Consequência para o plugin:** não há `uuid` nem `depth` a acrescentar no
`RecallBody`. A navegação é **pull** (tool `memory_neighbors`), e o ADR-006 já
proíbe duplicar por HTTP o que o modelo pode pedir por tool.

**O item 5a (`depth` no plugin) fica DESCARTADO.** Razões:

1. `depth>1` no **push** troca precisão por recall no caminho crítico do turno —
   o oposto do que a injeção quer (5 fatos precisos valem mais que 12 vagos).
2. Navegação agora tem tool própria (`memory_neighbors`, `code_neighbors`); o
   push não precisa cobri-la.
3. Medido (RFC-004 D6): em memória, `depth=1` alcança média 4,3 / máx 109;
   `depth=2` média 19,6. O ganho é de **volume**, não de alcance de um item.

O que **permanece** no plugin é a proposta 2: instruir o modelo (§6) sobre
`depth` como "mais recall", nunca como "navegação" — a distinção existe porque
a BFS continua enraizada na query.

### Aceite

Provar, por tool MCP e com id vindo de uma saída que o cliente já recebe:

(a) `memory_neighbors` com o `uuid` de um fato do `recall` devolve os vizinhos
daquele fato, **sem** refazer a query — verificado no servidor real: 7 vizinhos,
não-dirigido, excluindo a âncora;

(b) `memory_episodes` com um uuid de `fact.episodes` devolve o texto original —
verificado: 2.436 chars;

(c) `code_neighbors` com o `uuid` do 9º campo de `code_search` devolve vizinhos
(tool listada entre as 7 do v1.1.0).

Multi-hop de 3 saltos **sai do aceite**: o memtier adiou por medição (RFC-004
D6). O cliente encadeia 2 chamadas quando precisar.

---

## 6. O plugin não instrui o modelo a usar o memtier

### Observação

O plugin injeta dois blocos de contexto, `graph-memory` e `graph-code`, como
**parts de texto** no último turno do usuário
(`hooks/messages.ts:88`, `appendContextPart`). Não há nenhuma instrução de
sistema: o único hook registrado é
`experimental.chat.messages.transform` (`hooks/messages.ts:301`), e o SDK expõe
`experimental.chat.system.transform` (`@kilocode/plugin/dist/index.d.ts:267`,
assinatura `(input, output: { system: string[] })`) **sem uso no plugin**.

Consequência direta: o modelo não sabe que:

- existe um memtier consultável, com MCP registrado (E3b) e **7** tools: `recall`,
  `ingest`, `code_search`, `code_sync`, `code_neighbors`, `memory_episodes`,
  `memory_neighbors` (as três últimas desde o v1.1.0);
- o bloco de RAG é uma **amostra** de um grafo maior, não o conjunto completo;
- os ids injetados (§3/§4) são a chave para expandir;
- `recall` aceita `depth` (§5) e filtros (`entity_types`, `node_labels`,
  `as_of`, `include_invalid`) — mas `depth` é **mais recall**, não navegação.

Então o modelo trata o contexto como estático e responde com o que veio — mesmo
quando a resposta correta exigiria navegar.

### Propostas

1. **Hook `experimental.chat.system.transform`** que acrescenta um parágrafo
   curto e estável ao system prompt: o que o memtier é, quais tools existem,
   quando usá-las (expandir quando o contexto for insuficiente; navegar por id
   quando houver). Injetar em **todo** turno, independentemente de haver bloco
   injetado — a capacidade existe mesmo quando o RAG veio vazio.
2. **Condicionar ao que está realmente disponível.** Se o MCP não estiver
   registrado (E3b degradado) ou `inject.code_enabled=false`, não anunciar
   `code_search`/`neighbors`: anunciar tool inexistente produz chamada falha e
   queima o turno. A lista de tools deve ser derivada do estado real, não
   hardcoded.
3. **Não duplicar o que o bloco já diz.** O system prompt deve dar o
   **protocolo** (quando e como expandir), e o bloco deve dar os **ids** (§3). Se
   o parágrafo repetir o conteúdo, gasta tokens em todo turno sem ganho.
4. **Configurar como tudo o mais.** Chave em `inject.*` (ex.: desligar a
   instrução sem desligar a injeção), com default a decidir.
5. **Custo por turno.** O system prompt é reenviado a cada turno; um parágrafo de
   ~100 tokens é barato, mas deve ser medido, não presumido.

### Decisão — o conjunto de tools deixou de ser um bloqueio (resolvida em 2026-10-30)

A dúvida era "anunciar tool que não existe". Ela **deixou de existir**: o
v1.1.0 publica as 7 tools, então as três de navegação podem ser anunciadas.

O que resta é a **derivação do estado real** (proposta 2): `code_search`/
`code_neighbors` só fazem sentido com `inject.code_enabled`; anunciar o que o
deploy não expõe continua sendo um tiro no pé. A instrução deve ser montada a
partir do estado efetivo, não de uma lista fixa.

Ponto de atenção medido: o **MCP é registrado por servidor**, não por tool
(`src/mcp/register.ts`). O plugin não escolhe quais tools aparecem — quem roda o
servidor escolhe. Logo, a derivação no plugin só alcança o que **ele** controla
(`code_enabled`, `inject.enabled`); as tools de memória vêm sempre.

### Aceite

Com `inject.enabled=true`, o system prompt do turno contém a instrução; com a
config desligada, não contém. A instrução cita **apenas** tools que o MCP
registrado realmente expõe.

---

## 7. A documentação do plugin contradiz o memtier v1.1.0

### Observação

Oito pontos afirmam o oposto do que o servidor faz hoje. Seis são
**documentação**; dois são **testes** — e um deles passa hoje por ser frouxo.

| Arquivo | Linha | Afirma | Realidade |
|---|---|---|---|
| `README.md` | 152 | navegação por código **travada** | destravada |
| `docs/adr/006-push-vs-pull-mcp.md` | 64 | `neighbors` não é tool MCP | é (`code_neighbors`) |
| `docs/adr/006-push-vs-pull-mcp.md` | 86 | **4 tools** | 7 |
| `docs/ARCHITECTURE.md` | 139 | resposta de `code_search` **sem `uuid`** | tem (9º campo) |
| `docs/ARCHITECTURE.md` | 213, 248 | 4 tools; navegação não prometida | 7 tools |
| `docs/PRD.md` | 120, 123, 183 | FR-603 lista 4 tools; "navegação BLOQUEADA" | 7 tools; desbloqueada |
| `tests/e2e/test_e2e_mcp.test.ts` | 120, 185 | título "4 tools"; assere **presença** de 4 nomes | 7 |
| `tests/e2e/test_e2e_collector.test.ts` | 42 | recalcula `uuid5` (`chunkUuid`) | use o `uuid` de `code_search` |

### Consequência

- O ADR-006 é **normativo**: enquanto ele disser "não herde a tool", a spec
  nasce em contradição com a decisão registrada.
- O `ARCHITECTURE.md` é o contrato que a implementação consulta. Uma resposta de
  `code_search` documentada sem `uuid` faz o implementador concluir que o campo
  não existe — exatamente o que a §2 mostrava.
- O E2E é o pior caso: ele **passa** hoje porque verifica que 4 nomes estão
  presentes, não que o conjunto é aquele. Um teste que passa por ser frouxo não
  protege nada, e a spec herdaria essa prova cega.

### Propostas

1. **Corrigir os documentos na mesma entrega** que toca o assunto — não numa
   "limpeza" separada que nunca acontece. *(Preparado na rev. 5 e **aplicado na
   E8-S3** em README, ADR-006, ARCHITECTURE, PRD e o E2E do MCP; verificado
   2026-10-30.)*
2. **Trocar a asserção do E2E por conjunto exato** (as 7, em ordem), ou por
   "contém as 7" se a ordem não for contrato. Hoje `includes()` de 4 nomes é
   satisfeito por qualquer superset.
3. **Não reescrever o histórico.** O `docs/rfc/004` do memtier descreve o estado
   **anterior** por desenho; o mesmo vale para as observações datadas da §1/§2/§5
   desta RFC, que ficam como registro.

### Aceite

`rg` pelos cinco pontos não devolve afirmação desatualizada, e o E2E falha se
uma das 7 tools sumir.

---

## Anexo — como os achados foram verificados

- **Tools MCP:** `POST /v1/mcp` com `tools/list` (JSON-RPC), autenticado com o
  bearer do workspace.
- **Busca de código:** tool MCP `code_search` (via chamada de ferramenta) e
  `POST /v1/code/search`; faixas `start_line`/`end_line` cruzadas com o arquivo
  em disco (`grep -n "^func ..."`).
- **Navegação:** aresta controlada via `POST /v1/code/sync` + `POST
  /v1/code/neighbors` com 5 formas de identificador.
- **Campos do RAG (§3, §4):** lido no servidor onde são produzidos (`uuid`,
  `score`, `episodes` em `memory.py:_fact_from_edge`; `uuid` em
  `code.py:search_code`) e no plugin onde são consumidos (`formatFact`,
  `chunkHeader`, tipos `Fact`/`CodeChunkHit`). O descarte do `uuid` de código é
  declarado em comentário (`main.py:1029`, `code.py:1440`) e pinado por teste
  (`tests/test_mcp_tools.py:446`).
- **Navegação de memória (§5):** lista de rotas de `main.py`; `depth` em
  `RecallBody`/`memory.MAX_DEPTH`; ausência de `uuid` em `RecallBody` e de
  `bfs_origin_node_uuids` em `memory.recall`; BFS lida em
  `graphiti_core/search/search.py:332-355` e `search_utils.py:450-560`;
  `depth` fixo em 1 no código (`main.py:1158`, `code.py:1526`). No plugin:
  ausência de `depth` em `RecallOpts`.
- **System prompt (§6):** `Hooks` de `@kilocode/plugin/dist/index.d.ts:267`
  (`experimental.chat.system.transform`) e o registro efetivo do plugin em
  `hooks/messages.ts:301` + `index.ts` (só `messages.transform`).
- **Estado do servidor em 2026-10-30 (rev. 5):** `tools/list` contra
  `memtier.tail7d66cf.ts.net:8400` (7 tools); `POST /v1/code/search` com bearer
  do workspace (9º campo `uuid`); `POST /v1/recall` (7 campos por fato);
  `POST /v1/memory/episodes` (`content` de 2.436 chars); `POST
  /v1/memory/neighbors` (7 vizinhos, não-dirigido). Scores medidos em 3
  consultas: top-1 sempre `1.0`.

## Encaminhamento

> **Todo o lado memtier está fechado no v1.1.0.** O que resta é plugin, exceto
> onde indicado. Itens riscados foram entregues ou descartados.
>
> **Especificado na E8:** [`specs/e8-stories.md`](../../specs/e8-stories.md)
> cobre os itens 3a, 3b, 4a, 6, 8 e 9 (identidade no bloco + instrução de
> sistema). A S1 é o item 3a/3b/4a/8; a S2 é o item 6; a S3 fecha com os E2E de
> ida-e-volta e o item 9.

| Item | Dono | Ação |
|---|---|---|
| ~~1. Tool MCP de navegação~~ | ~~memtier~~ | **feito** — `code_neighbors` no v1.1.0 |
| ~~2. Contrato `uuid` de `neighbors`~~ | ~~memtier~~ | **feito** — `uuid` como 9º campo de `code_search` |
| ~~3a. `uuid` de memória no bloco~~ | ~~plugin · E8~~ | **feito na E8-S1** — `uuid`/`episodes` em `Fact`; `[id=<uuid completo>]`/`[ep=<uuid> +N]` |
| ~~3b. `uuid` de código no bloco~~ | ~~plugin · E8~~ | **feito na E8-S1** — `uuid` em `CodeChunkHit`; `[id=]` em `chunkHeader` |
| 3c. `score` no bloco | — | **descartado** (§3): a ordem já transmite o ranking; o score é relativo ao top-1 |
| ~~4a. `episodes` no bloco~~ | ~~plugin · E8~~ | **feito na E8-S1** — primeiro episódio + `+N` |
| ~~4b. Leitura de episódio~~ | ~~memtier~~ | **feito** — `/v1/memory/episodes` + `memory_episodes` |
| ~~5a. `depth` no plugin~~ | ~~plugin~~ | **descartado** (§5): navegação é pull; `depth>1` no push troca precisão por recall |
| ~~5b. Âncora da BFS de memória~~ | ~~memtier~~ | **feito por outro caminho** — `/v1/memory/neighbors` (§5) |
| ~~5c. Semântica de navegação de memória~~ | ~~memtier~~ | **decidida** — RFC-004 D2: documental + topológica, ambas entregues |
| 5d. Multi-hop de código | memtier | **adiado com medição** (RFC-004 D6); cliente encadeia `code_neighbors` |
| ~~6. System prompt de uso do memtier~~ | ~~plugin · E8~~ | **feito na E8-S2** — hook `system.transform`; derivar do estado real, não de lista fixa (ver a correção push×pull na [E8](../../specs/e8-stories.md): é `code_index.enabled`, não `inject.code_enabled`) |
| ~~7. Dívida documental~~ | ~~plugin~~ | **feito na E8-S3** — README, ADR-006, ARCHITECTURE (§2/§3/§5/§6), PRD e o E2E do MCP corrigidos; `rg "travada\|4 tools"` = 0 |
| ~~8. Dedup do turno~~ | ~~plugin · E8~~ | **feito na E8-S1** — `factKey` usa uuid validado, fallback `text:` |
| ~~9. E2E `chunkUuid`~~ | ~~plugin · E8~~ | **feito na E8-S3** — uuid lido de `code_search`; fórmula `uuid5` apagada (`rg "chunkUuid" tests/` = 0) |

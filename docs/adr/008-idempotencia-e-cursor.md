# ADR-008 — Idempotência e cursor da ingestão: o plugin é o dono

**Status:** proposto
**Data:** 2026-10-15
**Origem:** investigação de 2026-10-15 (`docs/TRIGGER-INGESTAO.md`) · decisão do
dono: *"Vamos deixar a responsabilidade da idempotência do lado do plugin, não do
memtier"* · complementa o **ADR-007** (o gatilho) e o **ADR-002** (assincronia)

## Contexto

Com o gatilho definido (ADR-007), a rotina precisa responder duas perguntas
antes de cada envio: **o que já foi ingerido?** e **da onde continuar?**

### A idempotência não pode vir do servidor

O memtier já tem um marcador de idempotência — `ingest:done:{job_id}` — mas ele
**não é endereçável pelo cliente**:

- o `job_id` é **gerado no servidor** (`queue.py:178`, `uuid4`);
- o `IngestBody` **não aceita** `job_id` nem `idempotency_key`;
- o marcador é por **job**, não por **conteúdo**.

Logo, reenviar o mesmo lote = job novo, uuid novo, **sem marcador**.

**Medido — o grafo NÃO converge sozinho.** Mesmo lote de 6 mensagens ingerido 2×:

| métrica | rodada 1 | rodada 2 | |
|---|---|---|---|
| entidades | 9 | 9 | ✅ dedup de entidade |
| relações `RELATES_TO` | 9 | **11** | ❌ **duplicou** |
| episódios | 1 | 2 | sempre cresce |

Fato duplicado literal: *"O deploy do Meridiano roda em Kubernetes na AWS, decisão
do Bruno"* **[2×]**. O custo do reenvio é também de compute (re-extração por LLM,
~70 s no grafo pequeno).

### O cursor do antecessor tem defeito medido

O antecessor lê o banco com:

```sql
SELECT id, time_created, data FROM message
WHERE session_id = ? ORDER BY time_created ASC, id ASC LIMIT n OFFSET k
```

O `id` está no `ORDER BY` — mas ali ele é **tiebreak** (desempata `time_created`
iguais). O **avanço é `OFFSET` numérico**, isto é, **posição**. Rodando a query
**literal** na sessão real (1.366 mensagens), com 40 linhas removidas antes do
cursor:

```
OFFSET=100, sem remoção  → pos 100
OFFSET=100, após remover → pos 140   *** PULADAS PARA SEMPRE = 40 ***
CONTROLE: cursor por (time_created, id) → PULADAS = 0
```

Há evidência de que a remoção acontece neste banco: **40 mensagens com
`compaction`** no `data`, FK `message → session ON DELETE CASCADE`, e **47 buracos
no `rowid`** (prova de DELETE já ocorrido).

## Decisão

**1. A idempotência vive no plugin.** O memtier **não muda**; nenhum campo novo.

```
hash = batchHash(lote lido do banco)     // djb2 sobre `role\0content`
if (sentBatchHashes[hash]) → NÃO envia
else                       → envia; grava o hash
```

`sentBatchHashes` é persistido **por workspace** (`.kilo/`), com escrita
**atômica** (`write`+`rename`) — o padrão do antecessor, medido em
`<workspace>/.kilo/openviking-ingest.json`:
`{ sessions, status, sentBatchHashes }`.

**2. O cursor é por identidade, não por posição.**

```sql
WHERE session_id = ?
  AND (time_created > :last_ts
       OR (time_created = :last_ts AND id > :last_id))
ORDER BY time_created ASC, id ASC
LIMIT :n
```

Guarda-se o **par `(time_created, id)` do último lido**, não um número. Custo
idêntico (o `ORDER BY` já era esse) e **imune à remoção** de linhas antes do
cursor (medido: `PULADAS = 0`).

**3. O estado por sessão guarda:** `last_ts`, `last_id`, e o próprio
`sentBatchHashes` (global do workspace). Sem contador de posição.

## Alternativas consideradas

| Alternativa | Motivo da rejeição |
|---|---|
| `idempotency_key` aditivo no `/v1/ingest` | **descartado pelo dono** — a garantia fica no plugin. (Tecnicamente viável: seria aditivo com default `null`, técnica do ADR-012/013 do memtier; mas move a responsabilidade.) |
| Cursor por `OFFSET` numérico | **defeito medido**: pula permanentemente as mensagens que "descem" atrás do cursor quando há remoção |
| Cursor só por `time_created` | sem tiebreak, a ordem não é total — dois lotes podem repetir ou pular registros no empate (hoje são 0 empates em 16.411, mas o contrato não pode depender disso) |
| Cursor só por `id` | o `id` **não** é monotônico com a ordem de inserção (1.008 inversões em 1.366, medido) — não serve para ordenar |
| Dedup só por conteúdo no servidor | não existe hoje; e o grafo **não** deduplica arestas (provado acima) |

## Consequências

- **Positivo:** o memtier fica intacto; a garantia acompanha o desenho já aceito em
  `specs/delecao-arquivo-removido-decisao.md` (*"o CLIENTE é responsável por
  declarar"*) — a mesma invariante de **órfão declarado**, aplicada à ingestão.
- **Positivo:** reprocessar é seguro: o cursor por tupla não pula, e o hash barra
  o reenvio.
- **Positivo:** restart do plugin sobrevive (estado em disco, atômico).
- **Negativo (L-1):** a confirmação é **otimista** — o `202` diz que o **envio** foi
  aceito, não que o worker processou. Como o hash é gravado no envio, um
  `add_episode` que falhe por motivo transitório vira **perda silenciosa e
  definitiva**. Sem caminho hoje (o `job_id` do servidor não volta ao chamador).
  **Critério de aceite da spec** (decisão do dono), não resolvido aqui.
- **Negativo (L-2):** `sentBatchHashes` cresce **sem expiração** (medido: 181 + 109
  hashes em dois workspaces do antecessor). Precisa de política (TTL/limite).
  **Critério de aceite da spec.**
- **Negativo (L-3):** a prova vive no disco; se o arquivo for apagado, o próximo
  `session.idle` reenvia o já enviado. Custo aceito de manter a garantia no cliente.
  **Critério de aceite da spec.**
- **Requisito derivado:** a rotina precisa de **trava por sessão** — dois eventos
  (ou `session.idle` repetido) podem chamá-la em concorrência, e o cursor não pode
  avançar duas vezes para o mesmo lote.

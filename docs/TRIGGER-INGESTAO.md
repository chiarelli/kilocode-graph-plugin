# TRIGGER DE INGESTÃO — verificação do `[VERIFICAR]` (2026-10-15)

> **Status:** investigação **concluída**, com dois experimentos executados contra a
> stack viva. Achado **material**: o problema relatado é real, e há um **defeito de
> idempotência** que bloqueia o fallback proposto. Nada foi implementado.
>
> **Pergunta do dono:** o trigger do antecessor é mensagem do usuário; em sessão
> agêntica a razão user/assistant é discrepante e mensagens úteis ficariam **sem
> processamento para sempre**.

**Decisão do dono (2026-10-15):**

1. **`message.updated` NÃO é o gatilho de "ingira esta mensagem".** É o gatilho
   que responde *"o próximo batch já está pronto para envio?"* — isto é, ele
   **alimenta o acumulador** e o batch fecha por **valor de config** (a decisão do
   E4). A pergunta não é por mensagem; é pelo **estado do lote**.
2. **`session.idle` como fallback** — e *"para implementar `session.idle` é
   obrigatório guardar `sentBatchHashes` como prova para o mecanismo de
   idempotência"* (o guard local, não o marcador do servidor).

---

## 1. `[VERIFICAR]` — resposta

**Confirmado: o disparo é por mensagem do usuário.** Três fatos:

| # | fato | evidência |
|---|---|---|
| 1 | O antecessor alimenta a fila **só** com (a) o texto do usuário em `chat.message` e (b) um caso especial: a tool `viking_remember` (que não existe no memtier) | `openviking-memory.js:2041` e `:2080` |
| 2 | O **graph-plugin ainda não implementa ingestão** — o trigger está apenas especificado (FR-201/FR-204). `src/hooks/` tem só `collect.ts` + `messages.ts` | `src/index.ts` não registra `chat.message` |
| 3 | O dreno do antecessor só re-agenda se **sobrar** item após o batch (`processQueue`), e item novo só chega por `syncTurn` — isto é, por `chat.message` | `:642-670` |

**C-2 (fila presa) é real:** sessão agêntica que termina sem novo prompt do
usuário deixa o residual na fila **para sempre**. Não há flush por `session.idle`
(o antecessor só usa `compacting`).

## 2. Instrumentação — o que os hooks REALMENTE entregam

Sonda registrada no runtime real (`kilo run` com um plugin de log, 85 eventos
capturados em `/tmp/trigger_probe/probe.jsonl`). Config restaurado depois.

### 2.1 `chat.message` — **só o USUÁRIO**

```
chat.message  →  roleGuess = "user"        parts = [text len=40]
```

Disparou **1 vez** na sessão, com role `user`. **Não** entrega o assistente.
Isso **confirma o C-1** empiricamente: quem dependesse só de `chat.message`
nunca capturaria o lado assisante.

### 2.2 `message.updated` — **user E assistant** ✅

```
message.updated  role='user'       id=msg_13fc3a547001woVy9WU3CAwELY
message.updated  role='assistant'  id=msg_13fc3a5cf001xVadDOaZhxu4ro
message.updated  role='user'       id=msg_...   (mesma msg, 2ª vez)
message.updated  role='assistant'  id=msg_...   (mesma msg, 2ª vez)
message.updated  role='assistant'  id=msg_...   (mesma msg, 3ª vez)
```

**Entrega os dois roles** — resolve o C-1. ⚠️ **Mas o MESMO id aparece 2–3×**
(5 eventos para 2 mensagens). **`message.updated` não é um evento de borda: é
notificação de atualização, disparada múltiplas vezes por mensagem.**

**Como usar (papel correto, corrigido pelo dono):** `message.updated` **não**
significa "ingira esta mensagem". Ele é o **sinal de que o acumulador mudou** — a
pergunta que ele responde é *"o próximo batch já está pronto para envio?"*. Então:

- a repetição 2–3× do mesmo `id` **não é duplicação de ingestão**: é a mesma
  mensagem reanunciando o mesmo estado do lote;
- o **acumulador precisa deduplicar por `id`** (é o que torna a repetição
  inócua), e o **batch fecha por valor** (limiar de config), não por evento;
- quem decide enviar é o **estado do lote**, não a mensagem individual.

### 2.3 `experimental.chat.messages.transform` — viu **só** `['user']`

```
messages.transform  roles = ['user']   parts = [{type:'text', len:40}]
```

⚠️ **Contradiz a premissa de que o transform vê a conversa inteira.** Nesta
execução ele recebeu apenas a mensagem do usuário. **Não** serve como fonte de
captura do assistente. (Ressalva: execução única e curta — vale reconfirmar numa
sessão longa antes de descartar o hook.)

### 2.4 Eventos disponíveis (81 no total)

| evento | ocorrências | serve como trigger? |
|---|---|---|
| `message.part.delta` | 11 | streaming de partes (muito frequente) |
| `message.part.updated` | 7 | atualização de parte |
| **`message.updated`** | **5** | **sim — com dedup por `id`** |
| `session.status` | 4 | mudança de status |
| `session.updated` | 3 | |
| **`session.idle`** | **1** | **sim — fallback, 1× por ociosidade** |
| `session.drained` | 1 | também existe (payload: `sessionID`, `token`) |
| `plugin.added` | 44 | ruído de boot |

## 3. Idempotência — **PROVADA: o grafo NÃO converge sozinho**

Teste: o **mesmo** lote de 6 mensagens ingerido **2×** no mesmo workspace
(`rfcbatcha--idem-dup`), medido no grafo.

| métrica | rodada 1 | rodada 2 | veredito |
|---|---|---|---|
| entidades | 9 | **9** | ✅ convergiu |
| relações `RELATES_TO` | 9 | **11** | ❌ **+2 (duplicou)** |
| episódios | 1 | **2** | sempre cresce (registro novo) |
| fatos | 9 (8 únicos) | **11 (10 únicos)** | ❌ duplicação de fato |

**Fato duplicado confirmado, literal:**

```
[2x] "O deploy do Meridiano roda em Kubernetes na AWS, decisão do Bruno"
```

### 3.1 A causa-raiz (por que o cliente **não consegue** ser idempotente hoje)

O marcador do servidor **não é endereçável pelo cliente**:

```
queue.py:178   job_id = uuid.uuid4().hex      # GERADO NO SERVIDOR
queue.py:390   done_key(job_id)  →  "ingest:done:{job_id}"
IngestBody:    { workspace, program, body, reference_time, name, saga }
               # ^ NAO tem campo job_id/idempotency_key
```

- O `job_id` nasce **no servidor**; o corpo do `/v1/ingest` **não o aceita**.
- O marcador `ingest:done:{job_id}` é **por job**, não por **conteúdo**.
- Logo: reenviar o mesmo batch = job novo, uuid novo, **sem marcador** → a lib
  re-extrai (dedup de entidade parcial: 9→9; arestas sem dedup: 9→11).

**Como o antecessor resolve — e é o desenho ADOTADO** (§4.3): hash **local**, não
no servidor. A ausência do campo no `IngestBody` deixa de ser um gap a corrigir e
passa a ser o **contrato aceito**: o plugin é o dono da idempotência.

```js
batchHash(payload) { /* djb2 sobre role\0content */ }
...
if (!this.state.sentBatchHashes[hash]) { ...enviar...; this.state.sentBatchHashes[hash] = true; }
```

O guard vive no **estado do plugin** (`sentBatchHashes`), não no memtier.

### 3.2 Consequência para a decisão do dono

| | |
|---|---|
| **`message.updated` como default** | ✅ viável — entrega user+assistant. É o sinal de **"o batch está pronto?"**, não de "ingira esta mensagem". Exige **acumulador com dedup por `id`** (o evento repete 2–3×) — sem isso o mesmo conteúdo entra 2–3× no lote |
| **`session.idle` como fallback** | ⚠️ **só com guard local de hash** (como o antecessor). Sem ele, o fallback **duplica fatos** — provado |
| **Alternativa DESCARTADA** | mover a chave para o servidor (`idempotency_key` aditivo no `/v1/ingest`). Seria tecnicamente mais forte, mas foi **descartada pelo dono** (§4.3): a idempotência fica **no plugin**. Consequência: o `sentBatchHashes` deixa de ser "disciplina" e passa a ser **requisito funcional** |
| **Custo do fallback hoje** | cada reenvio re-extrai com LLM (~70 s no grafo pequeno) — o custo é de compute, não só de dado |

## 4. Desenho — decisões fixadas

### 4.1 `message.updated` é **sinal de lote**, não de mensagem

```
message.updated  →  acumulador (dedup por id)
                 →  "o próximo batch está pronto?"  (limiar de VALOR, E4)
                 →  nesse ponto, e só nesse, POST /v1/ingest
```

O evento **não** significa "ingira esta mensagem". Ele anuncia que o estado do
lote mudou. Quem decide enviar é o **limiar**, não o evento — e é isso que
preserva a decisão do E4 (batch por valor de config).

### 4.2 `session.idle` exige `sentBatchHashes` — **é obrigatório, não opcional**

Decisão do dono: *"para implementar `session.idle` é obrigatório guardar
`sentBatchHashes` como prova para o mecanismo de idempotência"*.

Concorda com a medição (§3): sem o guard, o fallback **duplica fatos**
(`relações 9 → 11`, fato do Bruno `[2x]`). O mecanismo:

```
hash = batchHash(itens do lote)          // djb2 sobre `role\0content` (padrão do antecessor)
if (sentBatchHashes[hash]) → NÃO envia   // prova de que ESTE lote já foi
else                       → envia e grava o hash
```

Por que o guard tem de ser **local**: o marcador do servidor
(`ingest:done:{job_id}`) é **por job**, e o `job_id` é gerado no servidor
(`queue.py:178`) — o `IngestBody` **não aceita** `job_id`/`idempotency_key`.
O cliente não tem como reusar a identidade do servidor. Logo, **a prova de
idempotência é do cliente**, e o `sentBatchHashes` é essa prova.

**Persistência — medido no antecessor** (a pergunta "grava em disco?" está fechada):

| | |
|---|---|
| arquivo | `<workspace>/.kilo/openviking-ingest.json` (`WORKSPACE_STATE_FILES.ingest`) |
| conteúdo | `{ sessions, status, sentBatchHashes }` |
| escrita | **atômica** — `writeFileSync(tmp)` + `renameSync(tmp, p)` (`:1134-1145`) |
| carga | `loadState()` no boot; JSON corrompido ⇒ estado vazio (degrada, não lança) |

⚠️ **Crescimento:** um hash por lote enviado, **sem expiração** — o arquivo cresce
indefinidamente. O antecessor **não** tem política de TTL/limite. Para o
graph-plugin isso precisa ser decidido (é dívida latente, não bloqueio).

### 4.3 Onde vive a idempotência — **DECIDIDO: no plugin**

Decisão do dono (2026-10-15): *"Vamos deixar a responsabilidade da idempotência do
lado do plugin, não do memtier."*

| | |
|---|---|
| **decidido** | a garantia é do **plugin** (`sentBatchHashes` por workspace, persistido) |
| **descartado** | `idempotency_key` aditivo no `/v1/ingest` (chegou a ser proposto nesta investigação) |
| **consequência** | o memtier **não muda**; nenhum contrato novo; o RFC-001 e este doc ficam como estão |
| **por que faz sentido** | a decisão acompanha o desenho já existente (`specs/delecao-arquivo-removido-decisao.md`: *"o CLIENTE é responsável por declarar"*) — a mesma invariante de **órfão declarado** aplicada à ingestão: quem conhece o que já mandou é o cliente |

## 5. Não medido (não afirmar)

- Se `messages.transform` recebe a conversa inteira em **sessão longa** — nesta
  execução curta ele viu só `['user']`. Reconfirma antes de descartar o hook.
- **Frequência real** de `session.idle` (se dispara por turno ou só com a sessão
  realmente ociosa) — 1 ocorrência nesta execução.
- Se o `message.updated` repetido traz **conteúdo** diferente a cada vez (se
  sim, o acumulador precisa guardar o **último estado** por `id`, não o primeiro).
- Política de expiração do `sentBatchHashes` — o antecessor **não tem** (cresce
  sem limite). Não medi o tamanho que atinge na prática.
- Taxa de travamento da fila em sessões reais — o defeito é **de desenho**; não
  instrumentei o antecessor em produção.

# TRIGGER DE INGESTÃO — verificação do `[VERIFICAR]` (2026-10-15)

> **Status:** investigação **concluída**, com dois experimentos executados contra a
> stack viva. Achado **material**: o problema relatado é real, e há um **defeito de
> idempotência** que bloqueia o fallback proposto. Nada foi implementado.
>
> **Pergunta do dono:** o trigger do antecessor é mensagem do usuário; em sessão
> agêntica a razão user/assistant é discrepante e mensagens úteis ficariam **sem
> processamento para sempre**.

**Decisão do dono (2026-10-15):**

1. **`message.updated` NÃO é o gatilho de "ingira esta mensagem".** É só o
   **sinal de que a sessão mudou**; o plugin então **lê o banco** (`kilo.db`) e
   verifica se o limiar de batch foi atingido. O batch fecha por **valor de
   config** (decisão do E4). Nem o evento nem o seu payload são fonte de
   conteúdo.
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
significa "ingira esta mensagem". É só o **sinal de que a sessão mudou** — o
plugin então **lê o banco** e decide se o limiar foi atingido. Então:

- a repetição 2–3× do mesmo `id` é **inócua**: como o conteúdo vem do DB e o
  avanço é por **offset**, repetir o sinal apenas reavalia o mesmo estado — não
  ingere duas vezes;
- **não há acumulador em memória** (ver §2.2-bis e §4.1);
- quem decide enviar é o **estado do lote medido no banco**, não a mensagem
  individual.

### 2.2-bis Onde mora o CONTEÚDO (sonda 2, com uso de ferramenta)

Segunda instrumentação, numa sessão **com ferramentas** (leitura de arquivo +
escrita), para responder a pergunta do desenho da ingestão.

**Achado 1 — `message.updated` é METADADO, não conteúdo.** Traz `info` com
`role`/`id`/`time` — mas **sem `parts`**.

⚠️ **Correção do desenho (dono, 2026-10-15):** isso **não** significa que o
conteúdo tenha de vir de outro evento (`message.part.updated`). **Nenhum dos dois
eventos carrega dado útil para a ingestão.** Ambos são **apenas sinal de que a
sessão mudou** — o plugin então **lê o banco** (`kilo.db`) e retira as próximas N
mensagens. É exatamente o que o antecessor faz:
`messagesFromDb(sessionId, offset, limit)` → `SELECT id, time_created, data FROM
message WHERE session_id = ? ORDER BY time_created ASC, id ASC LIMIT ? OFFSET ?`
(`openviking-memory.js:1159`), com um **offset processado por sessão**
(`processedMessages`).

**Achado 2 — o conteúdo é construído INCREMENTALMENTE (confirmado).** Mesmo `id`,
mesmo `part`, vários anúncios com texto crescente:

```
seq=31  id=msg_13fe1271b…  len=  0   sha=e3b0c44298fc  tail=''            ← parte vazia
seq=32  id=msg_13fe1271b…  len=130   sha=65db35698c53  tail='…/out.txt.'  ← texto final
```

O `sha` do vazio é `e3b0c44298fc` (= sha256 de `""`), então é **parte real, ainda
sem texto** — não uma parte ausente. O texto chega **depois**, no mesmo `id`.

⚠️ **Mas o acúmulo por delta NÃO veio por esse caminho.** Os 11
`message.part.delta` (frequentes, em streaming) **não** apareceram nesta sonda —
os eventos de texto chegaram **já concatenados** (0 chars → 130 chars), não
caractere a caractere. Ou seja: há duas granularidades (delta × part-updated) e
o teste exercitou a segunda. **Não medido:** se o delta também chega em sessões
mais longas/streaming contínuo.

**Consequência — NÃO há acumulador em memória.** A leitura do DB é a fonte de
verdade, e o **progresso é um offset por sessão** (`processedMessages`), não um
buffer de eventos. Consequência prática: o `len=0` acima é **irrelevante** para a
ingestão — quando o plugin lê o DB, a mensagem já está **persistida e completa**;
o parcial que existia no evento não é o que se lê.

**O que o offset resolve (e é o coração do desenho):**
- **Incremento sem duplicar**: `offset` avança só após o envio confirmado do lote.
- **Restart sobrevive**: o estado fica em `.kilo/` (por sessão), não na memória.
- **Idempotência reforçada**: se o offset não avançou, reprocessar lê **as mesmas**
  mensagens; o `batchHash` (§4.2) barra o reenvio.

### 2.3 `experimental.chat.messages.transform` — viu **só** `['user']`

```
messages.transform  roles = ['user']                          parts = [{type:'text', len:176}]
messages.transform  roles = ['user','assistant']              lens  = [176, 0]
messages.transform  roles = ['user','assistant','assistant']   lens  = [176, 0, 0]
```

⚠️ **Reconfirmado na sonda 2:** o transform **enxerga** as mensagens do assistant
(os roles aparecem) mas com **`len=0`**; nesta execução o texto do user veio (176),
o do assistant não. **Também irrelevante para a ingestão** — pela correção do dono
(§2.2-bis), nenhum hook é fonte de conteúdo; a fonte é o **banco**. E é bom que
seja: o transform roda **antes** de a mensagem do assistant existir de fato.

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
| **`message.updated` como default** | ✅ viável — é o **sinal** de "a sessão mudou"; o conteúdo vem do **DB** (offset). O evento repete 2–3× por mensagem, mas isso é **inócuo**: o avanço é por offset, não por evento |
| **`session.idle` como fallback** | ⚠️ **só com guard local de hash** (como o antecessor). Sem ele, o fallback **duplica fatos** — provado |
| **Alternativa DESCARTADA** | mover a chave para o servidor (`idempotency_key` aditivo no `/v1/ingest`). Seria tecnicamente mais forte, mas foi **descartada pelo dono** (§4.3): a idempotência fica **no plugin**. Consequência: o `sentBatchHashes` deixa de ser "disciplina" e passa a ser **requisito funcional** |
| **Custo do fallback hoje** | cada reenvio re-extrai com LLM (~70 s no grafo pequeno) — o custo é de compute, não só de dado |

## 4. Desenho — decisões fixadas

### 4.1 Os eventos são **só sinal**; o conteúdo vem do banco

```
message.updated / session.idle   →  SINAL: "a sessão mudou"
                                 →  plugin LÊ o kilo.db (offset processado)
                                 →  "o próximo batch está pronto?" (limiar de VALOR)
                                 →  POST /v1/ingest com as N mensagens lidas
```

**Nenhum dos dois eventos é fonte de dado.** O plugin **não** monta o lote a
partir do payload do evento (nem `parts` do `message.updated`, nem texto do
`message.part.updated`): ele **lê o banco de dados** — as próximas N mensagens
não processadas, pelo **offset por sessão**. É o desenho do antecessor
(`messagesFromDb(sessionId, offset, batchSize)`, `:1159`), e é o que
**dispensa o acumulador em memória**.

Vantagens do offset sobre buffer de eventos:

| | |
|---|---|
| **fonte completa** | o DB é a verdade — user **e** assistant, sem depender de hook nenhum entregar texto |
| **sem estado em memória** | o progresso é `processedMessages` por sessão (persistido em `.kilo/`) |
| **restart sobrevive** | reinício do plugin não perde o que já foi processado |
| **sem parcial** | ao ler o DB, a mensagem já está persistida e completa (§2.2-bis) |

E quem decide enviar continua sendo o **limiar de valor** (decisão do E4) — os
eventos não competem com isso.

⚠️ **Ponto a resolver no E4:** qual coluna/ordenação define "as próximas N". O
antecessor usa `ORDER BY time_created ASC, id ASC` com `OFFSET` — que **não** é o
mesmo esquema do `id` de sessão do graph-plugin. Precisa decidir o cursor (offset
numérico × `lastMessageId`) e o que acontece se mensagens chegarem fora de ordem.

### 4.2 `session.idle` exige `sentBatchHashes` — **é obrigatório, não opcional**

Decisão do dono: *"para implementar `session.idle` é obrigatório guardar
`sentBatchHashes` como prova para o mecanismo de idempotência"*.

Concorda com a medição (§3): sem o guard, o fallback **duplica fatos**
(`relações 9 → 11`, fato do Bruno `[2x]`). O mecanismo:

```
hash = batchHash(lote lido do DB)        // djb2 sobre `role\0content` (padrão do antecessor)
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

### 4.3-bis Diferença entre os dois gatilhos (regra fixada pelo dono)

Os dois gatilhos **não** fazem a mesma coisa:

| gatilho | condição | quantos jobs |
|---|---|---|
| **`message.updated`** (default) | dispara **só se** o limiar de batch foi atingido | 1 job por limiar cruzado |
| **`session.idle`** (fallback) | dispara **sempre** | **todos os batches necessários, inclusive o resto** |

**Exemplo do dono:** batch = 20, `session.idle` dispara com **63 mensagens** não
ingeridas ⇒ **3 lotes de 20 + 1 de 3** (o resto). O fallback **drena tudo**; não
deixa resíduo.

Note que "63 não ingeridas" é medido **no banco** (total de mensagens da sessão
menos o offset), não num buffer de eventos — é o que torna o cálculo possível
sem estado em memória.

Regra formal do fallback: `jobs = ceil(pendentes / batch)`, com o último job
levando o resto (`pendentes mod batch`, se ≠ 0). Se `pendentes == 0`, não dispara.

### 4.3 Onde vive a idempotência — **DECIDIDO: no plugin**

Decisão do dono (2026-10-15): *"Vamos deixar a responsabilidade da idempotência do
lado do plugin, não do memtier."*

| | |
|---|---|
| **decidido** | a garantia é do **plugin** (`sentBatchHashes` por workspace, persistido) |
| **descartado** | `idempotency_key` aditivo no `/v1/ingest` (chegou a ser proposto nesta investigação) |
| **consequência** | o memtier **não muda**; nenhum contrato novo; o RFC-001 e este doc ficam como estão |
| **por que faz sentido** | a decisão acompanha o desenho já existente (`specs/delecao-arquivo-removido-decisao.md`: *"o CLIENTE é responsável por declarar"*) — a mesma invariante de **órfão declarado** aplicada à ingestão: quem conhece o que já mandou é o cliente |

## 6. Limitações conhecidas desta escolha — **anotadas, NÃO serão resolvidas agora**

Decisão do dono (2026-10-15): registrar e deixar **sem resposta**.

### L-1 — A confirmação de processamento é **otimista**

A ingestão é **assíncrona** (`POST /v1/ingest` → 202 → fila → worker). O plugin
**não** recebe confirmação de que o memtier efetivamente processou o batch.

| | |
|---|---|
| **o que o plugin sabe** | que o **envio** foi aceito (202) e que ele gravou o hash em `sentBatchHashes` |
| **o que o plugin NÃO sabe** | se o worker consumiu, se o `add_episode` teve sucesso, se o job foi para a DLQ |
| **consequência** | o plugin pode considerar "processado" um batch que **falhou no servidor**. E como o hash já está gravado, ele **nunca reenviará** — a perda é **silenciosa e definitiva** |
| **onde isso morde** | um `add_episode` que falha por motivo transitório (LLM/embedder) vira perda permanente de memória, sem retry do cliente |

Caminhos possíveis (não decididos): consultar o `ingest:done:{job_id}` do servidor
— hoje **inviável**, porque o `job_id` é gerado no servidor e não volta ao
chamador; ou um endpoint de status por `idempotency_key` — hoje **descartado**
(§4.3). **Fica sem resposta.**

### L-2 — `sentBatchHashes` cresce sem expiração (herdado do antecessor)

Um hash por lote enviado, sem TTL. O antecessor grava em disco
(`.kilo/openviking-ingest.json`) e **não** tem política. Sem TTL/limite, o arquivo
cresce indefinidamente. **Não resolvido agora.**

### L-3 — O fallback depende do disco sobreviver

A prova de idempotência vive no plugin (decisão §4.3). Se o arquivo de estado
for apagado/corromper, `loadState()` degrada para vazio e o próximo
`session.idle` **reenvia** o que já estava lá. É o custo aceito de manter a
garantia no cliente.

## 5. Não medido (não afirmar)

- Se `messages.transform` recebe a conversa inteira em **sessão longa** — nesta
  execução curta ele viu só `['user']`. Reconfirma antes de descartar o hook.
- **Frequência real** de `session.idle` (se dispara por turno ou só com a sessão
  realmente ociosa) — 1 ocorrência nesta execução.
- ~~Se o `message.updated` repetido traz conteúdo diferente~~ — **MEDIDO (§2.2-bis)**:
  o `message.updated` não traz conteúdo nenhum; o texto cresce em
  `message.part.updated` (0 → 130 chars, mesmo `id`). Acumulador guarda o
  **último estado por `id`**.
- Política de expiração do `sentBatchHashes` — o antecessor **não tem** (cresce
  sem limite). Não medi o tamanho que atinge na prática.
- Taxa de travamento da fila em sessões reais — o defeito é **de desenho**; não
  instrumentei o antecessor em produção.

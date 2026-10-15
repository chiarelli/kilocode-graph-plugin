# E4 — Ingestão assíncrona: plano de stories (decomposição, não implementação)

**Data:** 2026-10-15

**Fonte:** `BACKLOG.md § E4` · `docs/adr/002` (assincronia), **`007`** (gatilho),
**`008`** (idempotência e cursor — contêm o contexto, as medições e as
alternativas rejeitadas) · `docs/TRIGGER-INGESTAO.md` (evidência crua) ·
`docs/PRD.md` FR-201..205, FR-203/NFR-03 · `docs/ARCHITECTURE.md` §4 (fluxo do
turno) · `specs/e1-stories.md` (config/cliente/logger).

**Protocolo:** tracer bullet — E4-S1 é a fatia vertical mínima (um lote real sai
do banco e chega ao memtier). S2..S5 endurecem a mesma base, **sem rewrite**;
gaps mínimos marcados `TODO(tracer-bullet):`. Fecha quando
`rg "TODO\(tracer-bullet\)" src/` = 0 **e** os critérios de aceite abaixo estão
marcados.

**Ordem de execução:** S1 → S2 → S3 → S4 → S5 (cadeia linear).

**Depende de:** E1 (config/logger/cliente) · E2 (o plugin já boota e resolve
workspace). **Não** depende de E3a/E3b/E3c.

**Ambiente de dev:** `bun run typecheck` · `npm test`
(`node --test "tests/**/*.test.ts"`) · E2E gated `E2E=1` com o token por suíte —
ver **`docs/RUNBOOK-E2E.md`** (o comando canônico; não use `jq`, não existe neste
host). A ingestão exige o worker do memtier de pé.

---

## Decisões de design fixadas nesta decomposição

Contrato das stories; mudá-las exige registrar o porquê no commit. **Todas vêm do
ADR-007 e do ADR-008** — aqui só se operacionaliza.

### 1. Dois gatilhos, UMA rotina (ADR-007)

```
message.updated ─┐
                 ├─▶ rotina de ingestão ─┬─ lê o banco (cursor)
session.idle ────┘                        ├─ limiar atingido? → envia
                                          └─ drainAll? → envia tudo + o resto
```

A diferença é **um parâmetro** (`drainAll`), não duas implementações. O evento
**nunca** é fonte de conteúdo — o payload não tem dado útil (medido: `parts`
ausente no `message.updated`; `len=0` para o assistant no `transform`).

### 2. Cursor por identidade (ADR-008)

`WHERE session_id = ? AND (time_created > :last_ts OR (time_created = :last_ts AND
id > :last_id)) ORDER BY time_created ASC, id ASC LIMIT :n` — **sem `OFFSET`**.
Estado por sessão: `{ last_ts, last_id }`. Nunca um contador de posição.

### 3. Idempotência no plugin (ADR-008)

`sentBatchHashes` (djb2 sobre `role\0content`) persistido por workspace em
`.kilo/`, escrita **atômica** (`write` + `rename`). O memtier **não muda**.

### 4. "Concluído" é `pendentes == 0` (corrige o D-3 do ADR-007)

Nenhum estado marca concluído com resto abaixo do limiar. É o defeito medido no
antecessor: 45 mensagens úteis presas nos dois workspaces analisados.

### 5. `reference_time` = mensagem mais atual do lote

Decisão do dono. Com a fila atrasando, a data do envio quebraria a ordem temporal
(e a supersessão — ADR-002 §Consequências).

### 6. Nunca bloquear o turno (ADR-002, mantido)

A rotina é disparada em background; falha degrada, nunca lança (NFR-03).

### 7. Trava por sessão

Os dois gatilhos (e `session.idle` repetido) podem chamar a rotina em
concorrência. Numa mesma sessão, uma execução por vez; o cursor não pode avançar
duas vezes para o mesmo lote.

---

## E4-S1 — Tracer bullet: um lote real do banco até o memtier

**Objetivo:** a fatia vertical mínima. Ler do banco e ingerir 1 lote, disparado
por **um** gatilho.

**Entregável:**
- `src/ingest/db.ts` (novo): localiza o `kilo.db` e lê `message` + `part`,
  remontando o texto (user e assistant). Cursor do ADR-008 (S2 refina).
- `src/ingest/batch.ts` (novo): monta o lote (`role\0content`), calcula o
  `batchHash`, aplica o limiar de config.
- `src/ingest/state.ts` (novo): `sentBatchHashes` + cursor por sessão, persistido
  em `.kilo/` com escrita atômica.
- `src/hooks/ingest.ts` (novo): registra **`message.updated`** e acorda a rotina.
- `client.ingest(body, referenceTime)` — se ainda não existe.

**Testes (unit):** montagem do lote e `batchHash` determinístico; limiar não
atingido ⇒ não envia; localização do `kilo.db` (caminhos do antecessor:
`.kilo/kilo.db` no projeto ou até 5 níveis acima, fallback `~/.local/share/kilo/`).

**E2E (gated):** 1 lote real chega ao memtier (202) e o episódio aparece no grafo.

**Critérios de aceite:**
- Um lote real sai do banco e é aceito pelo memtier (202).
- O hook não bloqueia o turno (medir o tempo do hook — FR-203).
- Zero `TODO(tracer-bullet):` novos fora dos marcados.

---

## E4-S2 — Endurecer: cursor por identidade + idempotência

**Objetivo:** o que torna o reprocessamento seguro (ADR-008).

**Entregável:**
- Cursor por `(time_created, id)` — **sem `OFFSET`** (o defeito medido).
- `sendMessageBatch` guarded por `sentBatchHashes`; hash gravado **só após** o
  envio aceito.
- Estado persistido com escrita atômica; `loadState()` no boot.

**Testes (unit):** cursor avança corretamente; **teste de regressão do `OFFSET`** —
reintroduzir posição numérica num worktree isolado tem de **reprovar** (a
discriminação, no padrão da E3a/E3b); hash repetido não reenvia; estado corrompido
degrada (não lança).

**Critérios de aceite:**
- Ingerir o mesmo lote 2× **não** aumenta as relações do grafo (prova do ADR-008:
  hoje duplica 9→11).
- Remover linhas antes do cursor **não** pula mensagem (prova: `PULADAS = 0`).
- Restart do plugin não reenvia o já enviado.

---

## E4-S3 — `session.idle`: drenar tudo, inclusive o resto

**Objetivo:** nada sobra (corrige o D-2/D-3).

**Entregável:**
- Registrar **`session.idle`** apontando para a **mesma rotina**, com
  `drainAll = true`.
- Laço: `jobs = ceil(pendentes / batch)`, último levando o resto.
- **Nunca** marcar concluído com pendência (decisão 4).
- Trava por sessão.

**Testes (unit):** `pendentes = 63, batch = 20` ⇒ **3 lotes de 20 + 1 de 3**
(exemplo do dono); `pendentes = 0` ⇒ não dispara; `pendentes = 5` ⇒ **1 lote de 5**
(não fica preso); `message.updated` com pendentes < limiar ⇒ **não** envia.

**E2E (gated):** sessão com resto no banco ⇒ `session.idle` ingere o resto;
`pendentes == 0` depois.

**Critérios de aceite:**
- O resto é sempre drenado no `session.idle` (nenhum resíduo abaixo do limiar).
- `message.updated` **não** envia abaixo do limiar (é a diferença dos gatilhos).
- Chamadas concorrentes não corrompem o cursor.

---

## E4-S4 — Limitações conhecidas (decisão do dono: **entram como critério de aceite**)

**Objetivo:** as três limitações do ADR-008 têm de estar **endereçadas na
implementação** — não só documentadas. Decisão do dono (2026-10-15): *"incluir as
limitações L-1/L-2/L-3 como critérios de aceite."*

### L-1 — Confirmação otimista ⟶ **DECIDIDO: registrar a incerteza auditável**

O `202` diz que o **envio** foi aceito, não que o worker processou.

**Decisão do dono (2026-10-15), verbatim:** *"registra a incerteza auditável:
enviou o lote para o endpoint async e ele confirmou que aceitou (não que
processou), aceitar como batch processado e assumir que batch pode ser perdido."*

| | |
|---|---|
| o lote é tratado como | **processado** (o cursor avança) |
| a incerteza é | **registrada** (estado/log: "enviado e aceito, **não confirmado**") |
| o que se aceita | o lote **pode ser perdido** — sem reenvio |
| o que **não** se faz | reenvio conservador (duplicaria arestas — medido) |

**Critério de aceite:**
- O estado/log do lote enviado registra explicitamente que a confirmação é de
  **aceite**, não de processamento (auditável).
- **Nenhum** mecanismo de reenvio ou de espera por confirmação é criado.
- Teste: um lote cujo `add_episode` falhe no worker **não** é reenviado, e o log
  permite ao operador identificar que aquele lote foi perdido.

### L-2 — `sentBatchHashes` cresce sem expiração ⟶ **teto por workspace**

Medido no antecessor: **181 + 109 hashes** em dois workspaces, sem TTL.

**Decisão do implementador** (o porquê vai no commit): teto por workspace com
**evicção FIFO** ao ultrapassar; limite **configurável** (`ingest.max_hashes` ou
equivalente), default generoso. **Por que teto e não TTL:** o hash só serve
enquanto houver chance de a mesma mensagem ser relida (janela do L-3); um teto por
contagem é determinístico e testável, enquanto TTL depende de relógio.

**Critério de aceite:** teste provando que o número de hashes **não cresce
indefinidamente** (ultrapassar o teto evicta os mais antigos); o arquivo de estado
fica limitado.

### L-3 — O fallback depende do disco ⟶ **degradação explícita**

Se o arquivo de estado for apagado/corromper, o cursor volta ao início e o próximo
`session.idle` **reenvia** (o grafo duplica arestas — custo medido e aceito).

**Decisão do implementador:** o reset é **logado**, nunca silencioso.

**Critério de aceite:** teste com estado ausente e com JSON corrompido ⇒ a rotina
**degrada sem lançar**, **registra** o reset, e o comportamento está definido
(não é surpresa). O reenvio é consequência documentada, não defeito.

---

## E4-S5 — Fechamento

**Objetivo:** prova viva + docs.

**Entregável:** `rg "TODO\(tracer-bullet\)" src/` = 0; README/ARCHITECTURE
atualizados (o `§4 fluxo do turno` ainda descreve `chat.message` — corrigir);
`BACKLOG.md` marcado; o comando E2E documentado **verde** (RUNBOOK).

**E2E (gated):** sessão real com user + assistant; os dois gatilhos exercitados;
o resto drenado; ingerir 2× não duplica no grafo.

**Critérios de aceite:**
- `bun run typecheck` limpo; unit verde; E2E verde com o comando do RUNBOOK.
- Zero marcadores.
- Docs coerentes com o que foi implementado (sem descrever o mecanismo antigo).

---

## Fora de escopo (explícito)

- **Alterar o contrato do memtier** (`idempotency_key`) — descartado pelo dono
  (ADR-008). O memtier não muda.
- **Mensagem atrasada** com `time_created` anterior ao cursor continua pulada
  mesmo com o cursor por tupla (medido). Mitigação possível: janela de
  revarredura dos últimos N — **não** entra neste épico.
- **E5/E6/E7** (degradação, multi-CLI, observabilidade). O E6 está **bloqueado**
  por decisão de produto (só Kilocode basta hoje).

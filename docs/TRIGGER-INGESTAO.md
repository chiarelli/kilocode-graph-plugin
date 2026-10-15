# TRIGGER DE INGESTÃO — verificação do `[VERIFICAR]` (2026-10-15)

> **Status:** investigação concluída. Achado **material**: o problema relatado é
> **real** e tem dois agravantes. Nada foi implementado — este documento é
> evidência + opções para decisão.
>
> **Pergunta do dono:** o plugin OpenViking faz ingestão por batch com trigger em
> mensagem do usuário, e o graph-plugin "usa o mesmo mecanismo de trigger"
> `[VERIFICAR]`. O problema: em sessão agêntica a razão user/assistant é
> discrepante; vários steps de LLM podem gerar mensagens sem nenhuma mensagem de
> usuário até o fim da sessão, e **várias mensagens úteis ficariam sem serem
> processadas para sempre**.

---

## 1. `[VERIFICAR]` — resposta

**Confirmado: o disparo é por mensagem do usuário.** Mas há **três** fatos, não um:

| # | fato | evidência |
|---|---|---|
| 1 | O antecessor (OpenViking) alimenta a fila **só** com (a) o texto do usuário, no hook `chat.message`, e (b) um caso especial: a tool `viking_remember` | `openviking-memory.js:2041` (`syncTurn("user", …)`) e `:2080` (`syncTurn("assistant", "[memory:…]")` dentro de `tool.execute.after`, **só** quando a tool é `viking_remember`) |
| 2 | O **graph-plugin ainda não implementa ingestão** — o trigger está apenas **especificado** | `src/hooks/` tem só `collect.ts` + `messages.ts`; `src/index.ts` não registra `chat.message`. O desenho está em `ARCHITECTURE.md:287,295` (FR-201/FR-204) |
| 3 | O hook `chat.message` é chamado **a cada mensagem recebida** (doc do SDK: *"Called when a new message is received"*), mas o antecessor só aproveita `out.parts` (texto do usuário) — o **assistente nunca entra por esse caminho** | `@kilocode/plugin/dist/index.d.ts:189`; `openviking-memory.js:2036-2043` |

**A premissa do dono está certa** — e é pior do que ele descreveu: não é que o
assistente "às vezes" não seja capturado; é que **o único caminho de captura do
assistente é a tool `viking_remember`**, que no memtier **não existe** (as tools
MCP são `recall`/`ingest`/`code_search`/`code_sync`).

## 2. As duas consequências (nomeadas)

### C-1 — Assimetria por desenho

Em sessão agêntica, a razão user/assistant é discrepante: **1 mensagem do usuário
→ N mensagens do assistente** (steps de LLM, chamadas de tool, raciocínio). Se só
o texto do usuário alimenta a fila:

- o volume ingerido é uma **fração pequena** da sessão;
- o **lado do assistente** (decisões, código escrito, resultados) fica **fora** —
  e é justamente onde vive a maior parte do valor de memória num fluxo de trabalho.

### C-2 — Fila que nunca drena (o caso que o dono descreveu)

O antecessor drena com `while (turnQueue.length > 0 && batch.length < batchSize)`
(`:642`) — ou seja, **só drena quando a fila tem itens**. O gatilho de chegada é
`syncTurn` (`:2041`), que é **chamado apenas no hook `chat.message`**.

Cadeia do defeito:

```
sessão agêntica: N steps do LLM
  → nenhuma mensagem nova do USUÁRIO
  → nenhum disparo de chat.message (por mensagem do usuário)
  → turnQueue fica com o que sobrou (< batchSize)
  → processQueue() já rodou e NÃO re-agenda (só re-agenda se length > 0 SOBRAR
     após o batch)
  → o resto espera um PRÓXIMO disparo, que só vem com um prompt novo do usuário
```

Se a sessão **termina** sem novo prompt: o residual fica na fila **para sempre**.
Não há flush por `session.idle` — o antecessor só tem `session.compacting`
(`:2086`), que roda na **compactação**, não no fim/de pausa da sessão.

## 3. O que o SDK oferece (as saídas existem)

Verificado nos tipos reais (`@kilocode/sdk/dist/gen/types.gen.d.ts`):

| hook/evento | payload | serve para |
|---|---|---|
| `chat.message` | `{ sessionID, agent?, model?, … }` + `out.parts` | captura atômica — **é o atual** |
| `experimental.chat.messages.transform` | `output.messages[]` (**com roles**) | já roda no graph-plugin (injeção) — **vê a conversa inteira** |
| `tool.execute.after` | `{ tool, sessionID, callID, args }` + `output.{title,output,metadata}` | captura por uso de ferramenta (é o que o OV usa p/ `remember`) |
| **`session.idle`** | `{ sessionID }` | **gatilho de flush no fim da atividade** — o OV **não usa** |
| `message.updated` | `{ info: Message }` | evento por mensagem (user **e** assistant) |
| `experimental.session.compacting` | `output.context/prompt` | drenar antes de perder contexto (o OV usa) |
| `event` (hook genérico) | `{ event: Event }` | acesso a **todos** os eventos acima |

**O ponto-chave:** o hook `event` é genérico e recebe `session.idle` e
`message.updated`. As duas lacunas (assimetria e fila presa) têm remédio **sem
mudar o contrato do memtier**.

## 4. Opções

### (a) Batch com **dois** gatilhos: contagem **OU** `session.idle`

Manter o batch por valor (decisão do dono) e adicionar um **flush** em
`session.idle`: ao ficar ociosa, enfileira o residual, mesmo abaixo do limiar.

| | |
|---|---|
| **Custo** | baixo — só no plugin; o contrato do memtier não muda (`/v1/ingest` já aceita qualquer tamanho de body) |
| **A favor** | mata a **C-2** (fila presa) com uma linha de conceito; preserva o batch de 20 no fluxo normal |
| **Contra** | o residual vira um job pequeno (1–19 msgs) — mas a medição mostra que **batch menor não degrada a qualidade** (15/16 × 16/16), só custa mais caro |
| **Risco** | `session.idle` dispara com frequência; precisa de guarda para não virar 1 job por ociosidade curta |

### (b) Capturar o **assistente** no `messages.transform` (ou em `message.updated`)

O transform já vê `messages[]` **com roles** e já está implementado (injeção).
Dava para aproveitar a passagem para observar as mensagens do assistente.

| | |
|---|---|
| **Custo** | baixo no plugin; **mas** o transform roda no **caminho crítico** (orçamento 4 s) — acumular ali é risco de latência |
| **A favor** | resolve a **C-1** (assimetria); usa um hook que já existe |
| **Contra** | mistura responsabilidades (injeção × ingestão) no mesmo hook quente; `message.updated` é mais limpo para isso |
| **Risco** | transformar o hook de 4 s em acumulador de estado |

### (c) Ingestão por `session.idle` com a **sessão inteira** (não por mensagem)

No fim da atividade, ler a sessão do `kilo.db` e ingerir o que mudou.

| | |
|---|---|
| **Custo** | médio — leitura do DB de sessões (o antecessor já lê: `findKiloDb`, `ingest.setDbPath`) |
| **A favor** | fonte **completa** e única (não depende de interceptar hook nenhum); captura user **e** assistant por construção |
| **Contra** | é um caminho paralelo ao batch — ou substitui, ou duplica. Perde a semântica de "batch de 20" |
| **Risco** | ler o DB por fora pode divergir do que o plugin acumulou |

### (d) Não mudar (status quo) + documentar a perda

| | |
|---|---|
| **A favor** | zero trabalho |
| **Contra** | a perda é **silenciosa** — mesma classe do `chunks: []` (RFC-001) |

## 5. Recomendação do autor

**(a) + (b) no mesmo épico (E4):** `session.idle` para o flush (mata C-2, que é o
defeito duro) e `message.updated` para a captura do assistente (mata C-1, que é a
perda de valor). Ambos são **só no plugin** — nenhum dos dois exige mudar o
memtier. O batch por valor (decisão do dono) fica **intacto**: o `session.idle` é
flush, não substituição.

## 6. Não medido (não afirmar)

- **Com que frequência** a fila residual fica presa na prática — não instrumentei
  o antecessor nem medi sessões reais. O defeito é **de desenho** (a fila só drena
  com novo disparo), não uma taxa observada.
- Se `chat.message` é chamado também para mensagens do assistente no runtime do
  Kilo 7.8.3 — o doc do SDK diz "a new message is received" (ambíguo) e o
  antecessor **descarta** o caso não-usuário. Precisa de instrumentação para
  responder com certeza.
- Frequência real de `session.idle` (se dispara a cada turno ou só com a sessão
  realmente ociosa) — não medido.
- O que o E2 atual já faz hoje com o assistant: nada (o graph-plugin **não tem**
  hook de ingestão).

# ADR-007 — Gatilho da ingestão: os eventos acordam a rotina

**Status:** proposto
**Data:** 2026-10-15
**Origem:** investigação do `[VERIFICAR]` do dono (2026-10-15) — ver
`docs/TRIGGER-INGESTAO.md` (evidência medida) · supersede o **mecanismo** do
ADR-002 (a decisão de assincronia permanece)
**Decisões do dono:** *"Ambos os eventos, `message.updated` e `session.idle`,
devem apontar para a MESMA rotina. Ela só vai acordar a rotina, e a rotina é que
vai fazer o processo de saber se vai fazer a ingestão ou não, quantas mensagens
vão ser enviadas, quantos lotes vão ser enviados. A única diferença entre os dois
triggers é que o `session.idle` vai processar todos os lotes E o resto."*

## Contexto

O ADR-002 fixou *que* a ingestão não pode bloquear o turno (decisão mantida).
Ficou em aberto **o que dispara** a ingestão. O mecanismo herdado do antecessor
tem dois defeitos medidos:

**D-1 — `chat.message` só entrega o USUÁRIO.** Instrumentado no runtime real
(`kilo run`, sonda de log): o hook disparou **1 vez** com `roleGuess: "user"`.
Numa sessão agêntica a razão user/assistant é discrepante (1 : N), então o lado
do assistente — decisões, código escrito, resultados — fica **fora da memória**.
No antecessor o assistente só entra por um caso especial (a tool `viking_remember`,
que **não existe** no memtier).

**D-2 — a fila fica presa.** O dreno do antecessor só re-agenda se sobrar item
após o lote (`processQueue`), e item novo só chega por `chat.message`. Uma sessão
agêntica que **termina sem novo prompt** deixa o residual (< lote) na fila
**para sempre** — não há flush no encerramento.

**D-3 — medido nos dados reais:** o antecessor marca `caughtUp = true` num lote
**parcial** (`msgs.length < batchSize && offset > 0`) e o loop passa a **pular a
sessão**. O único rearme exige `delta >= batchSize`. Resultado nos dois estados
reais analisados: **45 mensagens úteis, no banco, nunca ingeridas**
(`waweb`: 7 sessões com gap; `graphiti-daemon`: 4).

## Decisão

**Os dois eventos acordam a MESMA rotina. O evento não ingere nada.**

```
message.updated ─┐
                 ├─▶  rotina de ingestão (única)
session.idle ────┘         ├─ 1. lê o banco (cursor — ver ADR-008)
                           ├─ 2. decide SE ingere (limiar atingido?)
                           ├─ 3. decide QUANTOS lotes
                           └─ 4. envia; avança o cursor
```

A rotina é **idempotente e reentrante** — os eventos podem repetir (o
`message.updated` do mesmo `id` disparou **2–3×** na medição) sem efeito colateral.

| | `message.updated` | `session.idle` |
|---|---|---|
| acorda a rotina | ✅ | ✅ |
| quem decide se/quanto | a rotina | a rotina |
| lotes enviados | **só se** o limiar foi atingido (0 ou 1) | **todos + o resto** |
| semântica | "a sessão mudou" | "a sessão **encerrou**" |

**A diferença é um parâmetro**, não duas implementações: um booleano
(`drainAll`/equivalente) define o limite do laço. `session.idle` ⇒ drena até
`pendentes == 0`; `message.updated` ⇒ para no limiar.

**Regra derivada (corrige o D-3):** "concluído" é **`pendentes == 0`**, nunca
"não encheu um lote". Nenhum estado de sessão pode marcar concluído com resto
abaixo do limiar.

### Por que os eventos não são fonte de dado

O conteúdo **não** vem do payload do evento. Medido: o `message.updated` traz
`info` com `role`/`id`/`time` e **sem `parts`**; o `messages.transform` enxerga as
mensagens do assistant mas com **`len=0`**. A fonte é o **banco de sessões**
(`kilo.db`) — é o desenho do antecessor e o que **dispensa o acumulador em
memória**. Ver ADR-008 para o cursor.

## Alternativas consideradas

| Alternativa | Motivo da rejeição |
|---|---|
| Manter `chat.message` (status quo) | D-1 (assistente fora) + D-2 (fila presa) + D-3 (gap medido) |
| Montar o lote a partir do payload do evento | o evento não carrega conteúdo útil (`parts` ausente / `len=0`); e o parcial observado exigiria guardar o "último estado por `id`" — complexidade para um dado que o banco já tem íntegro |
| Só `session.idle` | a memória ficaria **eventualmente consistente por sessão inteira** — um turno longo não alimentaria nada até o fim |
| Só `message.updated` | D-2 permanece: o resto nunca é drenado numa sessão que encerra |
| Duas implementações (uma por gatilho) | duplica a lógica de decisão; a diferença real é só o limite do laço |

## Consequências

- **Positivo:** cobre user **e** assistant (o gatilho não filtra por role).
- **Positivo:** nada sobra — o `session.idle` drena o resto (corrige D-2/D-3).
- **Positivo:** os dois gatilhos convergem numa rotina testável isoladamente.
- **Positivo:** a rotina é idempotente por construção — repetição de evento é inócua
  (`message.updated` repete 2–3× por mensagem, medido).
- **Negativo:** `session.idle` pode disparar mais de uma vez; a rotina precisa
  tolerar chamadas concorrentes (proteção por trava de sessão + cursor — ADR-008).
- **Negativo:** a ingestão passa a depender da leitura do `kilo.db`; se o arquivo
  não for encontrado no diretório esperado, a ingestão não roda (precisa de
  degradação explícita, não silenciosa).
- **Requisito derivado (do ADR-002, mantido):** `reference_time` = data da
  **mensagem mais atual do lote**, não a do envio (o dono fixou; a fila atrasa).
- **Ponto aberto para a spec:** a frequência real do `session.idle` (1 ocorrência
  na medição) e se ele dispara por turno ou só com a sessão realmente ociosa.

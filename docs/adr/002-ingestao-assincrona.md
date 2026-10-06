# ADR-002 — Ingestão assíncrona: o turno nunca espera

**Status:** aceito
**Data:** 2026-10-06
**Origem:** spike 007, Q14 + PRD FR-203

## Contexto

O plugin atual ingere de forma síncrona no fluxo do turno. Isso é aceitável com o
OpenViking, onde a escrita é barata.

Com o Graphiti, a ingestão de conhecimento é `add_episode`: **38 a 110s**
(medido, dependendo do modelo). Se o plugin esperasse, cada turno travaria por
até dois minutos.

Medição relevante (Q14): o daemon **não bloqueia** durante a ingestão —
leituras concorrentes ficam em 0,83s (idêntico ao baseline de 0,85s), porque
`add_episode` é I/O-bound. Ou seja: o problema não é o servidor, é **o plugin
esperar**.

## Decisão

A ingestão **nunca** é `await` no caminho do turno:

```
hook chat.message → acumula na sessão
                  → debounce (N mensagens OU T segundos)
                  → POST /v1/ingest → 202 → segue
```

Nenhuma resposta do daemon é aguardada para o turno terminar.

## Alternativas consideradas

| Alternativa | Motivo da rejeição |
|---|---|
| Ingestão síncrona no hook | trava o turno por 38–110s |
| `await` sem bloquear a UI | ainda consome o orçamento de 4s do hook |
| Ingestão a cada mensagem (sem debounce) | 1 job por mensagem = N extrações concorrentes = rate-limit |

## Consequências

- **Positivo:** latência do turno independe do tamanho do lote ingerido.
- **Positivo:** sobrevive a fechamento do CLI (o job está na fila do daemon).
- **Negativo:** a memória fica **eventualmente consistente** — uma conversa
  recente pode não estar disponível no turno seguinte. Aceitável: a janela é de
  segundos, e o contexto recente ainda está no histórico do Kilo.
- **Requisito derivado:** `reference_time` precisa ser a data da **mensagem**
  original, não a do envio — senão, com o atraso da fila, a ordem temporal (e
  portanto a supersessão) sai errada.

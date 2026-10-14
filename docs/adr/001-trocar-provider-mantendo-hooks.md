# ADR-001 — Trocar o provider mantendo a arquitetura de hooks

**Status:** aceito
**Data:** 2026-10-06
**Origem:** spike 007, Q5

## Contexto

Existe um plugin em produção (`kilo-openviking-plugin`) que injeta memória do
OpenViking no Kilo Code, via 4 hooks JS. A pergunta é: reescrever ou substituir
por baixo?

O spike 007 mediu o que o plugin atual faz de certo:

| Peça | Situação |
|---|---|
| `experimental.chat.messages.transform` | ponto de injeção **validado em produção** |
| `chat.message` | captura de turno |
| `experimental.session.compacting` | sobrevive à sumarização |
| Diretório do projeto → workspace | já resolve escopo |
| Ingestão em batch com estado | já existe e funciona |

O que muda com o Graphiti é **de onde os dados vêm** — não *quando* nem *como* o
plugin se pendura no Kilo.

## Decisão

**Manter a arquitetura de hooks. Trocar o cliente.** O novo plugin reusa o
esqueleto do `openviking-memory.js` (2112 linhas) e substitui:

| Antes | Depois |
|---|---|
| `VikingClient` (OpenViking) | `DaemonClient` (HTTP → memtier) |
| injeta só memória | injeta memória **+ código do repo** |
| ingestão síncrona | ingestão enfileirada (202) |

## Consequências

- **Positivo:** o mecanismo de hooks já está provado; o risco se concentra no
  cliente HTTP e no formato da injeção.
- **Positivo:** dá para escrever o novo plugin **em paralelo** ao daemon, contra
  um mock que respeite o contrato de `ARCHITECTURE.md` §2.
- **Negativo:** herda decisões do antecessor que podem não se aplicar — em
  especial a ingestão síncrona, que **não** serve aqui (ver ADR-002).
- Reuso explícito: `resolvePluginWorkspace`, `loadConfig`, registro dos hooks,
  `appendContextPart`, estado de ingestão.

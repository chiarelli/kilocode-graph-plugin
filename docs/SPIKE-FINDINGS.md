# SPIKE-FINDINGS — o que o spike provou sobre este plugin

> **Ponteiro, não duplicata.** Evidência bruta, números e logs:
> **`~/spikes/007-graphiti-memory-migration/REPORT.md`** (seção *Q5 — RAG de
> memória para múltiplas CLIs*) e `artifacts/`.
>
> Os achados sobre o **daemon** (ingestão, código, fulltext, concorrência) estão
> em [`../../graphiti-daemon/docs/SPIKE-FINDINGS.md`](../../graphiti-daemon/docs/SPIKE-FINDINGS.md).

## O que sustenta este plugin

| Achado | Consequência aqui |
|---|---|
| Recall mediano de **0,85s** no grafo real (máx 2,08s) | cabe no timeout de 4s do hook com folga |
| Injeta via `experimental.chat.messages.transform` | mecanismo do plugin atual **continua válido** |
| Ingestão **não bloqueia** leitura (0,83s sob carga) | fila é por custo/determinismo, não por travamento |
| Ingestão de código sem LLM: 32,6ms/chunk | RAG de repo viável no mesmo turno |
| Busca híbrida funciona com label próprio | código recuperável por semântica **e** identificador |
| `group_id` isola workspaces de verdade | segregação por projeto é possível |

## O que NÃO foi validado

| Lacuna | Risco |
|---|---|
| **Hooks do OpenCode** — Kilo é fork, mas não foi testado | adaptador pode não funcionar |
| **Hooks do Claude Code** — mapeado por documentação | idem |
| **Nenhuma das duas CLIs está instalada** no ambiente | não dá para validar sem instalar |
| **Qualidade da injeção** — não medido se o contexto ajuda ou atrapalha | piora silenciosa da resposta |
| **Limiar ideal de volume** injetado | poluição do prompt |

## Mapeamento das CLIs (do spike, Q5)

### Kilo Code — validado (produção)

Hooks JS. É o que o plugin atual já usa:
- `chat.message`
- `experimental.chat.messages.transform` ← injeção
- `experimental.chat.system.transform`
- `experimental.session.compacting`

### OpenCode — viável (mesma arquitetura)

Kilo Code é um fork do OpenCode; a superfície de plugins é a mesma. **Não
verificado por execução.**

### Claude Code — viável (mecanismo diferente)

Não usa hooks JS. Usa hook `UserPromptSubmit`, que devolve texto para
`additionalContext`. Funciona, mas o adaptador é outro — daí a separação em
`src/adapters/`.

## Consequências de desenho

1. **O plugin é fino** — toda a complexidade (graphiti, fila, índice) fica no
   daemon. O plugin é um cliente HTTP com 4 hooks.
2. **O que muda entre CLIs é só o ponto de captura/injeção** — o resto é
   compartilhado. Daí `adapters/`.
3. **O orçamento de latência é o requisito mais duro** — 4s de timeout, 0,85s de
   mediana. Qualquer trabalho extra no hook precisa caber nisso.
4. **A injeção precisa ser mensurável** — sem log de latência e volume é
   impossível saber se está ajudando (E7).

## Antecessor reutilizável

Do plugin atual (`~/.config/kilo/vendor/openviking-memory.js`, 2112 linhas),
esta arquitetura **reaproveita**:

| Peça | Reuso |
|---|---|
| `resolvePluginWorkspace` | diretório do projeto → workspace |
| `loadConfig` (env > config > default) | padrão de configuração |
| Hook registration | estrutura dos 4 hooks |
| `appendContextPart` | forma de injetar no turno |
| Ingestão por batch + estado | padrão de agrupamento |

O que **troca**: o cliente (OpenViking → daemon Graphiti) e o que se injeta
(memória só → memória + código).

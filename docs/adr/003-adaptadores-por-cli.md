# ADR-003 — Adaptadores por CLI, núcleo compartilhado

**Status:** aceito
**Data:** 2026-10-06
**Origem:** spike 007, Q5

## Contexto

O objetivo declarado é um RAG de memória utilizável em **Claude Code**,
**Kilo Code** e **OpenCode** — não só no Kilo.

As CLIs diferem em exatamente dois pontos:

| CLI | Captura | Injeção | Mecanismo |
|---|---|---|---|
| Kilo Code | `chat.message` | `experimental.chat.messages.transform` | hooks JS |
| OpenCode | idem (Kilo é fork) | idem | hooks JS |
| Claude Code | — | `UserPromptSubmit` → `additionalContext` | hook de shell |

Todo o resto — cliente do daemon, workspace, orçamento, formato dos blocos,
debounce — é **idêntico**.

## Decisão

Separar o plugin em:

```
src/
├── client.ts, workspace.ts, inject/, ingest/   ← núcleo compartilhado
└── adapters/
    ├── kilo.ts       ← referência (validado em produção)
    ├── opencode.ts   ← não validado
    └── claude.ts     ← não validado
```

O adaptador só faz: **capturar o prompt** e **injetar o contexto** no formato da
CLI. Ele não sabe o que é memória, código, ou grafo.

## Alternativas consideradas

| Alternativa | Motivo da rejeição |
|---|---|
| Plugin separado por CLI | duplica cliente, orçamento e formato — três lugares para corrigir o mesmo bug |
| Só Kilo, adaptadores depois | perde a vantagem de desenhar o núcleo já agnóstico |

## Consequências

- **Positivo:** um bug no núcleo é corrigido uma vez.
- **Positivo:** dá para validar o núcleo no Kilo (CLI disponível) antes de tocar
  nos outros.
- **Negativo:** abstração prematura se os adaptadores nunca saírem. Mitigação: os
  adaptadores são finos; se morrerem, o custo foi pequeno.
- **Ressalva registrada:** os adaptadores OpenCode e Claude Code são **desenho,
  não código validado** — nenhuma das duas CLIs está instalada no ambiente. Não
  prometer E6 sem antes instalar e testar.

# ADR-006 — Push (injeção no turno) vs pull (ferramentas MCP)

**Status:** aceito · **implementado na E3b** (registro implícito do MCP remoto)
**Data:** 2026-10-14
**Origem:** decisão do dono (2026-10-14), PRD FR-601..604, memtier E7

## Contexto

O plugin tem duas formas de dar contexto ao agente:

1. **Push** — o plugin injeta contexto no turno automaticamente, via
   `experimental.chat.messages.transform` (o mecanismo herdado do antecessor).
2. **Pull** — o plugin registra o servidor MCP do memtier no Kilo, e o **modelo**
   chama as ferramentas quando quer.

O memtier expõe as **duas** superfícies com paridade de contrato: as rotas HTTP
(`/v1/recall`, `/v1/code/search`, `/v1/code/sync`, `/v1/ingest`,
`/v1/code/neighbors`, `/v1/memory/episodes`, `/v1/memory/neighbors`) e as tools
MCP correspondentes em `/v1/mcp` (E7; navegação desde o v1.1.0).

A decisão do dono (2026-10-14): *"o plugin registra o MCP do memtier no kilocode;
o modelo decide se usa, como qualquer MCP tool"*.

## Decisão

**Os dois modos coexistem, com fronteira clara:**

| Modo | Direção | O que | Quando |
|---|---|---|---|
| **Push** | plugin → turno | memória + `code/search` injetados | automático, todo turno |
| **Pull** | modelo → MCP | 7 tools: `recall`/`ingest`/`code_search`/`code_sync` + `code_neighbors`/`memory_episodes`/`memory_neighbors` | sob demanda do agente |

O **RAG automático** (valor central do produto) é push — o modelo não precisa
saber pedir. As **ferramentas MCP** são pull — poder extra que o modelo aciona.

**Regra de não-duplicação:** o que é injetado automaticamente (memória +
`code_search`) não é simultaneamente oferecido como tool, para não gastar o
orçamento do turno duas vezes com o mesmo conteúdo.

## Alternativas consideradas

| Alternativa | Motivo da rejeição |
|---|---|
| Só push (sem MCP) | perde consultas sob demanda que o agente sabe fazer melhor que um gatilho fixo |
| Só pull (sem injeção) | perde o RAG automático; o modelo teria que adivinhar quando buscar |
| Push de tudo + MCP de tudo | duplica custo de contexto; viola o orçamento de injeção (ADR-004) |

## Consequências

- **Positivo:** o agente ganha consultas ricas (`recall` com `as_of`, `code_search`
  com filtros) sem custo por turno.
- **Positivo:** o registro do MCP tem precedente reutilizável no antecessor
  (`registerOpenVikingMcp`, `openviking-memory.js:1781`).
- **Negativo:** o plugin passa a gerenciar dois caminhos para o memtier (HTTP no
  hook + MCP no registro), com configurações de timeout distintas.
- **Negativo:** a qualidade do uso das tools MCP depende do modelo; não é
  garantida.
- **Requisito derivado:** registro **implícito** do MCP no boot (o usuário não
  precisa definir nada em `kilo.jsonc`); se ele já definiu, o plugin não registra
  por cima (idempotência) — FR-601/FR-602.
- **Requisito derivado:** degradação — MCP indisponível nunca é fatal — FR-604.

## Bloqueio de navegação — **RESOLVIDO no memtier v1.1.0**

> **Estado anterior (2026-10-14 → 2026-10-29).** `/v1/code/neighbors` (E12) não
> era tool MCP — só `recall`, `ingest`, `code_search` e `code_sync` eram
> expostas — e o `uuid` de entrada não saía de nenhuma rota, então a navegação
> era impossível nas duas pontas (ver
> [`RFC-001`](../rfc/001-navegacao-e-integridade-do-grafo-de-codigo.md)).

**Resolvido em 2026-10-30 (memtier v1.1.0).** O servidor publica **7** tools —
`recall`, `ingest`, `code_search`, `code_sync`, `code_neighbors`,
`memory_episodes`, `memory_neighbors` — e `code_search` devolve o `uuid` do
chunk como 9º campo aditivo.

A decisão original **vale como escrita**: o plugin **não** reimplementa
navegação por HTTP; ele herda as tools pelo registro do MCP, que é **por
servidor**, não por tool. Nenhum código novo é necessário para expô-las ao
modelo.

## Implementação (E3b, 2026-10-14)

- `src/mcp/register.ts` — `status` → `add` (`type:"remote"`, `url:…/v1/mcp`,
  header `Authorization: Bearer <token>`) → `connect`; disparado no boot em
  background (`scheduleMcpRegistration`), nunca bloqueia nem derruba o plugin.
- `src/mcp/kilo-config.ts` — lê o `kilo.jsonc` (JSONC) e respeita um `mcp.<name>`
  já definido pelo usuário (idempotência, FR-602).
- E2E (`tests/e2e/test_e2e_mcp.test.ts`, gated `E2E=1`) prova o registro
  implícito e as **7 tools** listáveis/chamáveis via cliente MCP real.
- Navegação **é** prometida desde o v1.1.0: `code_neighbors`, `memory_episodes`
  e `memory_neighbors` são expostas ao modelo pelo MCP.

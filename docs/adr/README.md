# Índice de ADRs — kilocode-graph-plugin

> Achados do spike: `docs/SPIKE-FINDINGS.md` → `~/spikes/007-graphiti-memory-migration/REPORT.md`

| ADR | Decisão | Status |
|---|---|---|
| [001](001-trocar-provider-mantendo-hooks.md) | Trocar o provider mantendo a arquitetura de hooks | aceito |
| [002](002-ingestao-assincrona.md) | Ingestão assíncrona — o turno nunca espera | aceito |
| [003](003-adaptadores-por-cli.md) | Adaptadores por CLI; núcleo compartilhado | aceito |
| [004](004-orcamento-de-injecao.md) | Orçamento de injeção com defaults conservadores | superado por [009](009-limites-por-endpoint-e-piso-de-confianca.md) |
| [005](005-plugin-e-o-coletor.md) | O plugin é o coletor de código; o indexer é dependência do cliente | aceito |
| [006](006-push-vs-pull-mcp.md) | Push (injeção) vs pull (ferramentas MCP) | aceito |
| [007](007-gatilho-da-ingestao.md) | Gatilho da ingestão: os eventos (`message.updated` / `session.idle`) acordam a **mesma rotina**; o conteúdo vem do banco | **proposto** |
| [008](008-idempotencia-e-cursor.md) | Idempotência e cursor: a garantia é do **plugin** (`sentBatchHashes`); cursor por **`(time_created, id)`**, não `OFFSET` | **proposto** |
| [009](009-limites-por-endpoint-e-piso-de-confianca.md) | Limites de injeção **por endpoint em tokens** (o tipo do memtier) + **piso de confiança da memória** no servidor (score cru) | **proposto** |

## Ordem de leitura para a ingestão (E4)

**002** (assincronia — o turno nunca espera) → **007** (o que dispara: os dois
eventos acordam a mesma rotina) → **008** (idempotência no plugin + cursor por
identidade). O 007 e o 008 substituem, juntos, o mecanismo herdado do antecessor.

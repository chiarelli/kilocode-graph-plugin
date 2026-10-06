# kilocode-graph-plugin

Plugin do Kilo Code que injeta **memória curada** e **RAG de código do
repositório** em cada turno, usando o [`graphiti-daemon`](../graphiti-daemon/)
como provider.

Substitui o `kilo-openviking-plugin` por baixo: os hooks do Kilo são os mesmos,
o provider muda.

> **Status:** esqueleto de projeto. PRD e arquitetura são drafts.
> **Dependência:** [`graphiti-daemon`](../graphiti-daemon/) — **não implementado**.
> **Base empírica:** [`~/spikes/007-graphiti-memory-migration/REPORT.md`](../../spikes/007-graphiti-memory-migration/REPORT.md)
> **Antecessor:** [`chiarelli/kilo-openviking-plugin`](https://github.com/chiarelli/kilo-openviking-plugin)

## O que muda em relação ao plugin atual

| | OpenViking (hoje) | Graphiti (este plugin) |
|---|---|---|
| Curadoria temporal | ❌ reescrita duplicada | ✅ supersessão automática |
| RAG de código do repo | ❌ | ✅ busca híbrida |
| Latência de recall | ~0,7s | ~0,85s (medido) |
| Ingestão | síncrona no turno | **assíncrona** (fila) |
| Multi-CLI | só Kilo | Kilo + adaptadores |

**O que NÃO muda:** a arquitetura de hooks. O plugin atual injeta em
`experimental.chat.messages.transform` — o spike confirmou que o mecanismo
continua válido (Q5). Troca-se o cliente.

## Arquitetura em uma linha

```
Kilo Code ──hooks──▶ plugin ──HTTP──▶ graphiti-daemon ──▶ FalkorDB
                      │
              injeta memória + código no turno
              enfileira ingestão (nunca bloqueia)
```

## Documentos

| Arquivo | Conteúdo |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | Personas, requisitos, épicos |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Hooks, fluxo do turno, adaptadores |
| [`docs/SPIKE-FINDINGS.md`](docs/SPIKE-FINDINGS.md) | O que o spike provou sobre multi-CLI |

## Hooks do Kilo usados

Do plugin atual (a arquitetura se mantém):

| Hook | Papel |
|---|---|
| `chat.message` | captura a mensagem do usuário → decide o que injetar |
| `experimental.chat.messages.transform` | **injeção** no turno |
| `experimental.chat.system.transform` | contexto de sistema |
| `experimental.session.compacting` | preservar memória na compactação |

## Não-objetivos

- Implementar o provider de memória (é do `graphiti-daemon`).
- Indexar o repositório (é do `rust-ast-indexer`).
- Migrar as memórias antigas (épico do daemon).

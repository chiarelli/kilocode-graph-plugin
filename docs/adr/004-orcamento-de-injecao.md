# ADR-004 — Orçamento de injeção com defaults conservadores

**Status:** superado por [ADR-009](009-limites-por-endpoint-e-piso-de-confianca.md)
(o modelo `max_chars` conjunto + `max_tokens` compartilhado é substituído por
limites **por endpoint em tokens** e um piso de confiança da memória)
**Data:** 2026-10-06
**Origem:** PRD FR-106, E7

## Contexto

Injetar contexto no prompt é uma faca de dois gumes. Se o recall trouxer o fato
certo, a resposta melhora. Se trouxer ruído, **a resposta piora** — e o dano é
silencioso: o modelo usa o contexto errado com confiança.

O spike **não mediu** se a injeção ajuda ou atrapalha (é uma das lacunas
registradas em `SPIKE-FINDINGS.md`). O único dado duro é a latência:
recall mediano de 0,85s, teto de 4s no hook.

Sem um limite de volume, um recall generoso pode despejar 10 fatos e 10 chunks de
código em todo turno — poluindo mais do que ajudando.

## Decisão

Orçamento explícito, configurável, com **defaults conservadores**:

```yaml
inject:
  enabled: false         # default desligado (FR-304, preferência do dono)
  max_memories: 5
  max_code_chunks: 3
  max_chars: 3000        # KILOCODE_GRAPH_INJECT_MAX_CHARS
  timeout_ms: 4000
```

A aplicação do orçamento é uma função **pura** (`applyBudget`), testável sem
daemon:

```ts
function applyBudget(facts: Fact[], chunks: Chunk[], cfg: Budget): string
```

Regras de corte:
1. Ordenar por score.
2. Cortar por contagem (`maxMemories`, `maxCodeChunks`).
3. Cortar por caracteres (`maxChars`) — código tem prioridade sobre memória,
   porque é mais denso em informação.

## Consequências

- **Positivo:** teto previsível de poluição; testável isoladamente.
- **Positivo:** calibrável sem tocar em código (config).
- **Negativo:** os defaults são um **palpite**, não medição. Só o E7 (log de
  latência/acertos) permite calibrar.
- **Requisito derivado:** procedência no texto injetado (blocos separados de
  memória e código) — o modelo precisa saber a origem de cada informação.

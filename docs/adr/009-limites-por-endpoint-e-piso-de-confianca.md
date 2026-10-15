# ADR-009 — Limites de injeção por endpoint (em tokens) + piso de confiança da memória

**Status:** proposto
**Data:** 2026-10-15
**Origem:** decisão do dono (2026-10-15): *"Para cada endpoint de recuperação —
memórias e código — deve ter uma env var configurada com o limite. Outra coisa, é
padronizar; hoje usa chars e tokens, padronizar com o tipo do memtier. Também
definir o threshold mínimo de confiança das memórias que serão injetadas (e
também definir no param memtier, para economizar computação do lado servidor),
ex.: 0.35, somente itens iguais ou maiores que 0.35 são injetados."*
**Supera/emenda:** o **ADR-004** (orçamento de injeção) · **depende** do contrato
do memtier (`main.py` `RecallBody`/`CodeSearchBody`, `budget.py`).

## Contexto

O ADR-004 fixou o orçamento de injeção com três tetos, em **duas unidades**:

| teto | unidade | onde aplica | hoje |
|---|---|---|---|
| `max_chars` | chars | cliente, bloco **conjunto** (memória+código) | default 3000 |
| `max_tokens` | tokens (`chars/4`) | servidor, **compartilhado** pelos dois endpoints | default 2000 |
| `max_memories` / `max_code_chunks` | contagem | cliente, por família | 5 / 3 |

Dois defeitos medidos no código atual:

1. **Unidades misturadas.** `max_chars` (cliente) e `max_tokens` (servidor) medem
   a mesma coisa em escalas diferentes — o dev calibra uma e calibra a outra. O
   tipo do memtier é **`max_tokens` = `chars/4`** (`budget.py:56`), opt-in, teto
   interno `MAX_RESPONSE_TOKENS = 16_000` (`budget.py:61`), e `max_tokens` acima
   do teto → **422** (`main.py:888`).
2. **Um só `max_tokens` para dois endpoints distintos.** `/v1/recall` e
   `/v1/code/search` são buscas independentes, com densidades de conteúdo
   diferentes; um teto compartilhado deixa o pior caso de um limitar o outro.
   (`src/index.ts:194` e `:203` alimentam os dois com o MESMO
   `config.inject.max_tokens`.)

E falta um **piso de qualidade**. O recall devolve ruído em potencial:
`reranker_min_score=0` (`memory.py:192`) e `sim_min_score` pinado (`memory.py:187`)
— nada descarta candidato fraco. O próprio ADR-004 reconhecia o risco ("se
trouxer ruído, a resposta piora... o dano é silencioso").

O corte **no cliente** não resolve: o `score` que o plugin vê é **normalizado pelo
top-1** (`memory.py:412-423`) — o melhor hit é sempre `1.0`, então um piso sobre o
score normalizado nunca morde o top-1; não é um piso de confiança.

### Fatos do contrato do memtier

- `RecallBody` (`main.py:1065`) **não** tem campo de score mínimo; `CodeSearchBody`
  (`main.py:899`) também não.
- A escala **crua** do recall é o score RRF (com 2 pernas chega a **2.0**;
  medido no smoke de 2026-10-06 — `specs/e3-stories.md:31`). O `sim_min_score` da
  perna cosine usa `(2-cos)/2 ≡ (1+cos)/2`.
- O código tem piso **interno calibrado por medição**: `VEC_MIN_SCORE = 0.65`
  (`code.py:151`; medição em `specs/e6-stories.md:116`).

## Decisão

**1. Unidade única: tokens (`chars/4`) — o tipo do memtier.** `max_chars` e o
`max_tokens` compartilhado são **removidos**.

**2. Um limite por endpoint.** Cada endpoint carrega o SEU teto no próprio body:

| chave config | env var | default | vai no body de |
|---|---|---|---|
| `inject.memory_max_tokens` | `KILOCODE_GRAPH_INJECT_MEMORY_MAX_TOKENS` | 2000 | `POST /v1/recall` |
| `inject.code_max_tokens` | `KILOCODE_GRAPH_INJECT_CODE_MAX_TOKENS` | 2000 | `POST /v1/code/search` |

`max_memories` / `max_code_chunks` **permanecem** como cortes de **contagem** —
são independentes do teto de volume.

**3. Piso de confiança da memória, no SERVIDOR, sobre o score CRU.**

| chave config | env var | default | vai no body de |
|---|---|---|---|
| `inject.memory_min_score` | `KILOCODE_GRAPH_INJECT_MEMORY_MIN_SCORE` | 0.35 (a calibrar) | `POST /v1/recall`, campo aditivo `min_score` |

- O memtier aplica o `min_score` **na escala crua das pernas de busca**
  (`reranker_min_score`/`sim_min_score`), **antes** de normalizar e serializar — é
  o corte que de fato economiza computação de retrieval, como o `VEC_MIN_SCORE` do
  código.
- **O cliente NÃO re-filtra por score**: só vê score normalizado; o piso é
  responsabilidade do servidor.
- **Só memória.** Código mantém `VEC_MIN_SCORE` interno + o corte por quantidade.
- **O default 0.35 é palpite, não medição** — mesmo status do `VEC_MIN_SCORE`
  provisório (0.3) que foi recalibrado para 0.65. A calibração por medição é
  requisito da epic dona, não um número inventado aqui.

## Impacto no memtier (mudança aditiva)

`/v1/recall` ganha um campo **aditivo** `min_score: float | None = None` no
`RecallBody` — `None` preserva o comportamento legado exato (mesmo desenho do
`max_tokens`, `main.py:1095-1102`). Regra do próprio memtier: campos obrigatórios
nunca mudam; extensões são aditivas (`specs/e3-stories.md:192`).

**Degradação — servidor antigo ignora o campo.** Pydantic v2 ignora campos extras
por default; um `min_score` enviado a um memtier que não o implementa **não dá 422
— é ignorado em silêncio**. Consequência: o piso só vale onde o servidor o honra;
a spec deve tratar isso (log/detecção), nunca assumir.

## Alternativas consideradas

| Alternativa | Motivo da rejeição |
|---|---|
| Manter `max_chars` (conjunto) + um `max_tokens` | unidades misturadas; um teto para dois endpoints com densidades distintas |
| Piso sobre o score **normalizado** no cliente | o top-1 normalizado é sempre 1.0 — o corte nunca morde o melhor hit; não é um piso de qualidade |
| Piso **pós-retrieval** no servidor (filtrar a lista final) | enxuga o payload, mas **não economiza retrieval** — o gasto já aconteceu (é o objetivo do dono) |
| Piso também para código | o dono fixou **só memória**; código já tem `VEC_MIN_SCORE` |
| Manter `max_tokens` compartilhado | um endpoint de código denso consumiria o orçamento da memória |

## Consequências

- **Positivo:** uma unidade só (tokens), o tipo do memtier — config previsível.
- **Positivo:** cada endpoint calibrável sem tocar no outro.
- **Positivo:** o piso corta ruído na origem; menos dado trafegado e menos
  retrieval desperdiçado.
- **Negativo:** o default `0.35` é palpite; sem medição pode cortar fato legítimo
  ou deixar ruído. O `0.35` é **relativo à escala crua**, não "35% de confiança".
- **Negativo:** quebra de compat **de config** — `KILOCODE_GRAPH_INJECT_MAX_CHARS`
  e `..._MAX_TOKENS` morrem; quem os seta perde o efeito (a spec fixa aviso/log).
- **Negativo:** o piso depende de uma **mudança no memtier** (campo aditivo
  `min_score`); até ela, um servidor antigo ignora o campo em silêncio.
- **Requisito derivado:** a calibração do `min_score` (medição de verdadeiros vs
  ruído, como no `e6`/`VEC_MIN_SCORE`) é requisito da epic dona — não um default
  inventado.

## Histórico de revisão

- **2026-10-15** — criada a partir do pedido do dono e das respostas às três
  decisões (escala crua nas pernas de busca; só memória; troca total por
  per-endpoint em tokens).

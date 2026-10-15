# Decisões de produto da segunda onda (2026-10-15)

> **Para revisão do dono. NÃO commitado.** Registra as decisões que o dono tomou
> em 2026-10-15 e que ainda não viviam em nenhum artefato do repo. O objetivo é
> que a próxima sessão não redescubra (nem contrarie) o que já foi decidido.
>
> **Este arquivo é uma proposta.** Nada aqui foi escrito no BACKLOG/PRD/specs.

---

## 1. E6 — Multi-CLI: **BLOQUEADO por decisão de produto**

**Decisão do dono:** *"E6 fica bloqueada, pois somente kilocode hoje é suficiente."*

Estado verificado (2026-10-15):

| CLI | mecanismo | estado |
|---|---|---|
| **Kilo Code** | plugins JS — `chat.message`, `experimental.chat.messages.transform`, `experimental.chat.system.transform`, `experimental.session.compacting` | **validado em produção** (é o runtime da primeira onda) |
| **OpenCode** | mesma superfície (Kilo é fork) | **nunca executado**; CLI **não instalada** nesta máquina |
| **Claude Code** | mecanismo **diferente** — hook `UserPromptSubmit` → `additionalContext` | **nunca executado**; CLI **não instalada** |

Razão do bloqueio (do `SPIKE-FINDINGS.md`, literal): *"Nenhuma das duas CLIs está
instalada no ambiente — não dá para validar sem instalar"*.

**Consequência para o BACKLOG:** o E6 sai da fila de trabalho disponível e passa a
**bloqueado**, com a razão explícita. Não é "pendente de spec" — é "sem consumidor
hoje". Quando/se o dono usar outra CLI, o bloqueio cai.

**Sugestão de marcação** (a aplicar no BACKLOG, se aprovado):
`- [!] **E6** — Multi-CLI — **BLOQUEADA: só Kilocode é suficiente hoje (decisão do dono, 2026-10-15)**; as outras CLIs não estão instaladas e o Claude Code usa outro mecanismo.`

---

## 2. E4 — Ingestão: batch por **valor de configuração**, não por mensagem

**Decisão do dono (verbatim):**

> *"A memória deve ser formada pelo valor dos batch. Se for 20, sempre são
> ingeridas 20 em 20 mensagens da sessão em um único job. Se fosse ingerida uma
> mensagem por vez, não se formariam as relações corretas."*
>
> *"O plug-in kilocode openviking [faz] ingestão por batch por causa do seu próprio
> desenho de arquitetura. Se fosse por mensagem, não se formariam as relações.
> Porém o memtier é diferente, parece que as relações podem ser formadas
> independentemente do tamanho do batch, pois usa banco em grafos, mas tem [que]
> provar."*
>
> *"Reference time value é sempre da mensagem mais atual do batch."*

### 2.1 O que foi **provado** (medição de 2026-10-15)

Experimento: mesmo corpus de **20 mensagens** de uma sessão coerente (Meridiano,
Diana, Bruno, Carlos), com **16 relações plantadas** como verdade de base. Cada
ramo em **workspace próprio** (decisão do dono: *"dois Workspaces, cada um para um
ramo do teste"*), no programa `rfcbatcha`:

| métrica | ramo A (batch=20) | ramo B (batch=1) |
|---|---|---|
| jobs | 1 | 20 |
| workspace | `rfcbatcha/sess-b20` | `rfcbatcha/sess-b1` |
| **cobertura da verdade** | **15/16** | **16/16** |
| relações formadas | 24 | 34 |
| entidades | 13 | 17 |
| **espúrias (invenção)** | **0** | **0** |
| **duplicatas** | **0** | **0** |
| tempo total | **10 s** | **1.405 s** |
| recall (fatos/consulta) | 5, 5, 5 | 5, 5, 5 |

**Hipótese confirmada:** o memtier forma as relações corretas **independentemente
do tamanho do batch**.

**Causa** (não é o grafo em si): `ingest_episode` → `add_episode` roda um
**pipeline completo de LLM por episódio** — extrai entidades, deduplica contra o
grafo e extrai arestas. Cada episódio é uma **unidade de extração
autossuficiente**; o grafo é o destino do delta, não o mecanismo da relação. Por
isso o batch grande não "junta mais contexto" — ele só empacota mais mensagens
num prompt.

**O contraste com o OpenViking:** lá a relação depende do lote porque a extração
é sobre o batch inteiro. Aqui, a menor unidade de contexto que forma uma relação
é a **frase**.

### 2.2 Por que o batch=20 é a decisão certa (mesmo com a qualidade empatada)

Não é correção — é **custo**. Mesmo corpus, mesmo resultado de qualidade:

| batch | tempo | cobertura | custo relativo |
|---|---|---|---|
| 20 | 10 s | 15/16 | **1×** |
| 1 | 1.405 s | 16/16 | **~140×** |

### 2.3 Ressalvas honestas (não afirmar além do medido)

- **n=1 corpus.** A dispersão do LLM é real: `duration_s` por episódio variou de
  **5,6 s a 115 s** no mesmo pipeline. "Qualidade equivalente" é a leitura dos
  dados, não um resultado estatístico — repetir 3× e olhar a variância seria o
  rigor adequado.
- **Viés corrigido:** a primeira avaliação usou termos-alvo só em português e o
  ramo A saiu **em inglês** — penalizou o A por **idioma** (11/16 vs 15/16). Com
  critério bilíngue: **15/16 vs 16/16**. O placar justo é este.
- **Ingestão A dominou por 1 relação** (a frase 16). Com n=1 não se distingue
  "batch maior perde detalhe" de ruído de amostra.

### 2.4 A demora — causa medida (e de quem é a decisão)

O dono notou: *"caramba quanto tempo leva pra ingerir isso, hein? nossa"*.

| | |
|---|---|
| mediana por episódio | **~70 s** |
| faixa medida | 5,6 s – 115 s |
| 20 episódios seriais | **~23 min (1.405 s)** |
| latência do prompt | **160 ms** |
| razão ingestão/latência | **~7.300×** |

**Não é lentidão do LLM e não cresce com o grafo.** É estrutural
(`src/memtier/worker.py:411`):

```
"Backpressure = 1 GLOBAL: um job por ciclo, em qualquer workspace"
```

**1 job por ciclo, serial, com 1 worker.** São ~10–20 chamadas de LLM por
episódio (extração + dedup + arestas); o tempo total é a **soma**.

⚠️ **Esta é decisão de arquitetura do MEMTIER, não do plugin.** O consumidor (E4)
sofre o efeito, mas a alavanca (concorrência do worker / paralelismo por
workspace) está fora deste repo.

**O que isso implica para o E4:** a ingestão é **assíncrona** (202 + worker), então
o usuário nunca espera os 70 s — mas o **grafo fica defasado ~70 s por mensagem**.
Se isso for aceitável, o E4 não muda nada no worker; se não for, vira item do
BACKLOG do memtier.

**Sugestão de marcação** (a aplicar no BACKLOG, se aprovado):
```
- [ ] **E4** — Ingestão assíncrona (fila por sessão, debounce)
      DECIDIDO: batch por VALOR de config (não por mensagem);
      `reference_time` = mensagem MAIS ATUAL do batch.
      MEDIDO (2026-10-15): batch=20 custa 10 s vs 1.405 s do batch=1 para
      qualidade equivalente (15/16 × 16/16). O 20-por-job é ~140× mais barato.
      Gargalo observado: worker processa 1 job/ciclo (~70 s/episódio) — decisão
      de concorrência do memtier, não deste plugin.
```

Artefatos da medição:
- `~/.hermes/state/graph_plugin_supervisor/experimento_batch.json`
- `~/.hermes/state/graph_plugin_supervisor/avaliacao_relacoes.json`
- roteiro: `experimento_ingest_batch.py`, `avaliar_relacoes.py`

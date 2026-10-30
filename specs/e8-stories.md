# E8 — Identidade no bloco injetado e instrução de uso do memtier (plano de stories)

**Data:** 2026-10-30

**Fonte:** [RFC-001 rev. 5](../docs/rfc/001-navegacao-e-integridade-do-grafo-de-codigo.md)
§3 (`uuid`/`score`), §4 (`episodes`), §5 (navegação de memória), §6 (instrução de
sistema) e o **Encaminhamento** (itens 3a, 3b, 4a, 6, 8, 9) ·
[ADR-006](../docs/adr/006-push-vs-pull-mcp.md) (push × pull; não duplicar tool por
HTTP) · `docs/ARCHITECTURE.md` §2 (contrato com o memtier — inclui as duas rotas de
memória) e §5 (formato do contexto, com o aviso de "estado atual vs. alvo") ·
`src/client.ts` (`Fact:247`,
`CodeChunkHit:276`) · `src/inject/memory.ts` (`formatFact`, `MemoryInjector`) ·
`src/inject/code.ts` (`chunkHeader`, `chunkIdentity`) · `src/hooks/messages.ts`
(`messagesHook`, `injectContextIntoMessages`) · `src/index.ts` (fiação) ·
`src/config.ts` (`inject.*`, `mcp.enabled`).

**Natureza:** contrato **aditivo** sobre código **em produção** (E2 e E3c já
implementados) mais **uma superfície nova** (o hook `system.transform`, que hoje
não existe no plugin).

**Tracer bullet por story, não pela epic.** A S1 é contrato aditivo puro (um
campo a mais no bloco) — não justifica fatia vertical nova. A **S2** é a exceção
e é declarada: `system.transform` é uma superfície que **nunca** atravessou
nenhuma camada deste plugin, e a única prova de que o host **chama** o hook e
**acrescenta** o texto ao prompt está num turno real. Por isso a S2 **começa**
por uma fatia vertical mínima — texto fixo de uma linha empurrado por
`system.transform` num turno real, provado no E2E — e só depois recebe a
derivação de estado, o teto de custo e os testes de unidade. A fatia é **código
de produção** desde o início, sem protótipo descartável.

**Marcadores `TODO(tracer-bullet):`** — só na S2, e apenas nos pontos que a
fatia mínima deixa deliberadamente de fora (derivação de tools, teto de chars).
A epic só fecha com `rg "TODO\(tracer-bullet\)" src/` = 0, como manda o
BACKLOG. A S1 e a S3 **não** usam marcadores.

**Depende de:**

- **memtier v1.1.0** ✅ — `code_search` devolve `uuid` como 9º campo; `/v1/recall`
  devolve 7 campos por fato (`uuid`, `episodes` inclusos); `/v1/memory/episodes` e
  `/v1/memory/neighbors` existem. Verificado ao vivo em 2026-10-30 (Anexo da
  RFC-001).
- **E2** (bloco de memória, `MemoryInjector`, dedup por turno) ✅
- **E3c** (bloco de código, `CodeInjector`) ✅
- **E3b** (registro do MCP) ✅ — a instrução da S2 só faz sentido com o MCP de pé.
- **Item 7 da RFC-001 (dívida documental)** — **conflito de fontes a resolver
  antes da S3.** A RFC-001 declara o item 7 "**feito na rev. 5**"; o `main` diz o
  contrário, e verifiquei: `README.md:152` ainda diz "travada", `adr/006` ainda
  diz "4 tools / neighbors não é tool MCP", `ARCHITECTURE.md` §2 ainda não tem
  `uuid` nos exemplos nem as rotas de memória. As correções existem **em stash**,
  não no código.
  **Ação:** des-riscar o item 7 na RFC (ou anotar "declarado na rev. 5; `main`
  ainda contradiz — verificado 2026-10-30") e aplicar o stash **antes** da S3. A
  lista de docs da S3 (tabela por seção) passa a ser a **autoridade única** do que
  é "coerente".
  Não é bloqueador da S1/S2: nenhuma das duas depende de o doc estar corrigido.

**Ambiente de dev:** `bun run typecheck` · `npm test`
(`node --test "tests/**/*.test.ts"`) · E2E gated: `E2E=1` com a stack do memtier
de pé e bearer do workspace.

**Ordem de execução:** E8-S1 → E8-S2 → E8-S3 (cadeia linear). A S3 fecha; não
introduz comportamento.

---

## Problema

O bloco injetado entrega **conteúdo sem identidade**. O modelo recebe o texto do
fato e o trecho de código, mas não o `uuid` que as tools exigem como entrada —
então não pode citar de forma estável, nem expandir o que veio. E como o plugin
não usa `experimental.chat.system.transform`, o modelo também não sabe que existe
um grafo consultável atrás do bloco: trata o RAG como conjunto completo e
responde com ele, mesmo quando a resposta exigiria navegar.

Os dois defeitos se agravam mutuamente: **id sem protocolo** é um número sem
significado; **protocolo sem id** não tem como ser seguido. Daí S1 e S2 serem
uma única epic, com S1 primeiro (o id é o que a instrução manda usar).

---

## Decisões de design fixadas nesta decomposição

Estas decisões são **contrato das stories**; mudá-las exige registrar o porquê no
commit.

### 1. Marcador único `[id=<uuid completo>]`, nos dois blocos

Formato:

| Bloco | Linha |
|---|---|
| memória | `- <fato> (válido desde <data>) [id=<uuid>] [ep=<uuid> +N]` |
| código | `[CÓDIGO RELEVANTE — <path>:<ini>-<fim>] [id=<uuid>]` |

Regras:

- o literal é **`[id=`** nos dois blocos — o modelo aprende **um** token, não
  dois. `[ep=` segue a mesma gramática de colchete;
- o uuid vai **completo (36 chars)**. É o ponto inteiro do item: as tools exigem
  o uuid exato e um id truncado devolve `[]` **em silêncio** (RFC-001 §3);
- os marcadores vão **depois** do texto e da data, no fim da linha. O texto
  continua sendo a primeira coisa que se lê; nenhum teste existente que ancora em
  `- <fato> (válido desde …)` quebra, porque o casamento é por substring;
- `valid_at` ausente ⇒ nenhum parêntese (comportamento atual preservado).

### 2. Ausência e forma inválida degradam **visivelmente**, nunca em silêncio

O plugin fala com servidor que pode ser mais velho que o contrato. Regra única,
aplicada por uma função só:

| Situação | Bloco | Log |
|---|---|---|
| `uuid` ausente/`null` | marcador **omitido** | nenhum (servidor antigo, esperado) |
| `uuid` presente mas **fora** do formato `8-4-4-4-12` | marcador **omitido** | **um** aviso por turno/família (`log`) |
| `episodes` ausente/vazio | marcador `[ep=…]` omitido | nenhum |
| `episodes[0]` **malformado** | `[ep=…]` omitido (o `+N` cai junto) | **um** aviso por turno/família |
| `episodes.length > 1` | `[ep=<primeiro> +N]`, `N = len - 1` | nenhum |

**Os DOIS marcadores passam pela mesma validação.** `episodes[0]` é string
vinda do fio tanto quanto o `uuid` do fato — sem o gate, `[ep=</context>]` fura a
sentinela que o D-3 fechou. Não se sanitiza o uuid: **valida-se**, e é isso que
o torna seguro (o formato `8-4-4-4-12` não admite `<`, `>`, espaço nem quebra de
linha por construção). Um valor inválido é **omitido**, nunca escapado.

A validação de forma existe porque o modo de falha é **silencioso do outro lado**:
um id torto no bloco faz o modelo chamar a tool e receber lista vazia, sem erro
visível. É o mesmo padrão de `warnIfFloorNotHonored` (E3c): degradar é aceitável,
**degradar sem avisar** não.

**Onde mora o aviso.** `formatFact`/`formatMemoryBlock` são **puras** (é o que
permite testá-las sem I/O) e não têm noção de turno. Logo:

- a **pureza** só decide *omitir* o marcador — nunca loga;
- o **aviso** sai do injetor, que já tem o estado de turno.

**Política: um aviso por turno por família** — um booleano, exatamente como
`floorWarnedThisTurn` (`src/inject/code.ts:237,273-279`), **não** um `Set` por
uuid. Motivo: o aviso é para o **operador** saber que o servidor está fora do
contrato; repetir por uuid transformaria um deploy desalinhado em spam de log,
que é justamente o que a flag booleana da E3c evita. O contador do log leva o
número de itens afetados (`ids inválidos: 3`), então nenhuma informação se perde.

Nas duas famílias: `MemoryInjector` (memória) e `CodeInjector` (código) ganham a
mesma flag. **Código NÃO degrada em silêncio** — seria contradizer o princípio
desta mesma decisão.

### 3. `score` **não** é injetado (decisão da RFC-001 §3, não reabrir)

Medido em 3 consultas reais: o top-1 é `1.0` **por construção** (RRF normalizado
pelo top-1 da própria consulta). O valor não é comparável entre itens nem entre
consultas; a **ordem** já transmite o ranking. Qualquer `score=` no bloco é
regressão — o aceite da S1 testa a **ausência**.

### 4. Dedup do turno passa a usar o `uuid`, com fallback para o texto

Hoje a chave é `f.fact` (`src/inject/memory.ts:252` e `:267`). Isso **pode**
colapsar dois fatos distintos que compartilham o texto (o grafo admite fatos
iguais vindos de episódios diferentes) e **pode** deixar de deduplicar o mesmo
fato se ele voltar com texto reformatado pelo servidor. Os dois são casos
plausíveis, **não observados** nas amostras medidas (15 fatos, 3 consultas) — a
justificativa principal não depende deles: o `uuid` é a identidade que as tools
usam, e o dedup deve usar a mesma.

Contrato:

```ts
/** Identidade de um fato no dedup do turno. */
export function factKey(fact: Fact): string {
  return isValidUuid(fact.uuid) ? fact.uuid : `text:${fact.fact}`;
}
```

- **usa a MESMA validação do bloco.** `fact.uuid ?? fact.fact` estaria errado: um
  `uuid` malformado — ou `""`, que o `??` **não** protege — viraria chave de
  dedup enquanto o marcador correspondente é omitido. Dedup e display passariam a
  usar critérios divergentes, que é exatamente o defeito que esta decisão existe
  para eliminar;
- o prefixo `text:` separa os dois espaços de nome. Sem ele, um `fact.fact` que
  por acaso fosse um uuid colidiria com a chave de outro fato;
- uma função só, usada nos **dois** pontos (`prepare` e `commit`);
- sem uuid válido (servidor antigo) cai no texto — comportamento atual, sem
  regressão.

**O que a mudança conserta e o que ela NÃO conserta.** Com `uuid` válido, dois
fatos distintos de mesmo texto deixam de colapsar. **Sem** uuid (servidor
anterior ao v1.1.0), dois fatos de mesmo texto continuam colapsando — a chave é o
texto, por necessidade. Isto é declarado, não escondido: a epic corrige a
identidade onde o servidor a fornece.

**O dedup de código NÃO muda** (`chunkIdentity` = `path:start-end`). É guarda
**local do turno**, não identidade de grafo: se dependesse de `uuid`, um servidor
sem o campo deixaria de deduplicar por completo. Reabrir só com evidência de
chunk repetido no mesmo turno.

### 5. A instrução é do **sistema**, o id é do **bloco** — sem duplicação

`RFC-001 §6` proposta 3. Divisão fixada:

- o **bloco** carrega os ids e mais nada (sem legenda, sem instrução);
- o **system prompt** carrega o protocolo: o que o bloco é, e como expandir.

Consequência declarada e aceita: com `inject.instruction_enabled=false` os ids
continuam no bloco (ainda servem para citar) mas o protocolo desaparece. Não se
duplica a legenda no bloco para cobrir esse caso — duplicar custa tokens em
**todo** turno.

### 6. A lista de tools é **derivada**, nunca literal

O MCP é registrado **por servidor**, não por tool (`src/mcp/register.ts`): o
plugin não escolhe o conjunto exposto. Logo a derivação só alcança o que o plugin
**controla**:

| Tool | Só é anunciada quando | Por quê |
|---|---|---|
| `recall`, `memory_episodes`, `memory_neighbors` | `mcp.enabled` | a memória é populada pelo ingest; a tool responde sempre |
| `code_search`, `code_neighbors` | `mcp.enabled` **e** `code_index.enabled` | só há código no grafo se ele foi indexado |
| `ingest`, `code_sync` | **nunca** | são rotas de **escrita**, não do turno do agente |
| — (nenhuma) | `mcp.enabled=false` | sem MCP não existe tool: a instrução inteira é omitida |

> **Correção ao texto literal da RFC §6.** A RFC diz `code_search`/
> `code_neighbors` "só fazem sentido com `inject.code_enabled`". Isso **confunde
> push com pull** e a E8 corrige:
>
> - `inject.code_enabled` liga o **push** — o bloco `graph-code` que o hook
>   injeta (`src/hooks/messages.ts:209`);
> - `code_index.enabled` liga o **conteúdo** — se há chunks e arestas no grafo
>   (`src/index.ts:132`);
> - `mcp.enabled` liga o **pull** — o servidor cuja tool o modelo chama
>   (`src/index.ts:154`). O MCP registra as 7 tools **independentemente** das
>   flags de injeção.
>
> Consequência de manter o texto da RFC: com `code_index.enabled=true`,
> `inject.code_enabled=false` e `mcp.enabled=true` — combinação legítima de quem
> quer o grafo de código para o agente consultar **sob demanda**, sem gastar
> orçamento no todo turno — o plugin esconderia tools que **funcionam**. O
> modelo nunca navegaria o código, que é o oposto do objetivo.
>
> O **intuito** da RFC (não anunciar o que não existe) é preservado e fica
> **melhor** atendido: `code_index.enabled=false` ⇒ não há chunk no grafo ⇒
> `code_search` devolveria vazio para sempre, e omiti-la é correto.
>
> **Registro:** isto é um desvio do texto da RFC, alinhado ao seu intuito.
> Qualquer dúvida, a decisão é do dono — mas implementar a letra da RFC produz o
> defeito descrito acima.

Anunciar tool inexistente queima o turno (chamada falha + retry) — é o que a
derivação evita.

> **Refinamento declarado do aceite da RFC §6.** A RFC diz "com
> `inject.enabled=true` o system prompt contém a instrução". A E8 acrescenta
> `mcp.enabled` como segunda condição: sem MCP configurado não há tool a anunciar.
> Isso é a proposta 2 da própria §6 ("condicionar ao que está realmente
> disponível"), não um desvio — mas fica registrado porque muda o texto literal
> do aceite.
>
> **Limite honesto da derivação: é de CONFIG, não de disponibilidade ao vivo.**
> `scheduleMcpRegistration` é *fire-and-forget* (`src/index.ts:154`) e
> `registerMemtierMcp` pode logar e seguir em `status` falho, `409` ou URL
> inválida (`src/mcp/register.ts:232-283`, FR-604). Nesse estado a instrução
> anunciaria tools que não respondem. Consultar o MCP a cada turno custaria
> latência no caminho crítico, o que o ADR-004 proíbe. **Decisão: aceitar o
> resíduo e declará-lo.** O texto da instrução **não** promete "tools
> disponíveis", e sim "o workspace tem grafo consultável"; a instrução degrada
> como o resto do plugin (FR-604). Quem quiser o sinal exato usa `mcp.status` no
> boot e um log de divergência — fora do escopo da E8.

### 7. Config: uma chave nova, ligada por padrão, mas só com a injeção ligada

| Chave | Env var | Default | Efeito |
|---|---|---|---|
| `inject.instruction_enabled` | `KILOCODE_GRAPH_INJECT_INSTRUCTION_ENABLED` | `true` | liga o parágrafo de sistema |

Efetiva **só** quando `inject.enabled=true` **e** `mcp.enabled=true`.
`instruction_enabled` governa o **texto**, não o bloco: quem quer os ids sem a
prosa desliga só ele.

> **Exceção consciente à convenção de defaults (declarada, como na E3c).** A
> convenção do BACKLOG é "defaults desligados" para `inject.*`. Este é o
> **primeiro** booleano de `inject.*` com default `true`. A justificativa não é
> "está subordinado, logo não conta" — é que **o comportamento global não muda**:
> com `inject.enabled=false` (o default), nada é injetado nem instruído, então o
> `true` desta chave é inalcançável por default. Ligou a injeção, liga a instrução
> junto — que é o desejado: id no bloco sem protocolo é um número sem
> significado.
>
> **`configStateFrom` (`src/config.ts:850`)** tem allowlist de chaves persistidas
> em `.kilo/graph-config.json`. A chave nova **não** entra nela: nenhum consumidor
> do arquivo (o CLI) lê flags de injeção, e incluí-la criaria divergência entre o
> arquivo e a config efetiva de quem só usa o hook. Se um dia um consumidor
> precisar, ele entra com teste.

### 8. `system.transform` é hook **irmão**, não substituto

| Hook | Papel |
|---|---|
| `experimental.chat.messages.transform` | **push** — injeta os blocos no turno (E2/E3c, não muda) |
| `experimental.chat.system.transform` | **instrução** — acrescenta o protocolo ao system prompt (novo) |

Regras de implementação:

- assinatura do SDK: `(input: { sessionID?, model }, output: { system: string[] })`
  (`@kilocode/plugin/dist/index.d.ts:267`);
- **`output.system.push(texto)`** — acrescenta **um** elemento; nunca substitui os
  existentes nem reescreve o prompt do host;
- **nunca lança** (NFR-03): falha aqui não pode derrubar o turno;
- idempotente na prática: `output.system` é por chamada, mas o hook confere se o
  texto já está no array antes de empurrar (defesa contra reentrância do host);
- registrado no **mesmo** `messagesHook`? **Não.** Hook novo, `systemHook(rt)`, em
  módulo próprio (`src/hooks/system.ts`), porque tem ciclo de vida e config
  próprios; `src/index.ts` espalha os dois no objeto de retorno.

---

## Stories

### E8-S1 — Identidade no fio e no bloco (itens 3a, 3b, 4a, 8)

**Entrega:** campos nos tipos do client; `factKey`; marcadores no `formatFact` e
no `chunkHeader`; validação de forma com aviso; dedup por uuid.

Arquivos: `src/client.ts` (tipos do fio), `src/inject/memory.ts` (`formatFact`,
`factKey`, aviso por turno no `MemoryInjector`), `src/inject/code.ts`
(`chunkHeader` + a mesma flag de aviso no `CodeInjector`), `src/inject/uuid.ts`
(**novo**: `isValidUuid`, sem dependência de `client.ts` para os dois injetores
poderem importá-lo).

> `src/types.ts` **não** entra na S1: os tipos do fio vivem em `src/client.ts`.
> Na S2 ele entra obrigatoriamente — a interface `Config` mora ali
> (`src/types.ts:181`) e `src/config.ts` só a importa; mexer em `DEFAULTS` sem
> estender o tipo reprova o typecheck.

**Contrato de tipo:**

```ts
export interface Fact {
  fact: string;
  valid_at: string | null;
  invalid_at: string | null;
  score: number;
  source?: string;
  /** uuid do fato (`memory.py:_serialize_fact`). Ausente ⇒ servidor antigo. */
  uuid?: string;
  /** uuids dos episódios de origem; o bloco usa só o primeiro. */
  episodes?: string[];
}

export interface CodeChunkHit {
  // …campos atuais…
  /** uuid do vértice do chunk (9º campo aditivo do `code/search`, v1.1.0). */
  uuid?: string;
}
```

Opcionais de propósito: `raw_score?: number` já estabeleceu o precedente de campo
opcional com degradação visível. O E2E prova a **presença** contra o servidor
real.

**Função de validação — uma só, exportada para teste direto:**

```ts
/** `8-4-4-4-12` minúsculo. O memtier emite assim (uuid5/uuid4 canônicos). */
export function isValidUuid(value: unknown): value is string;
```

Exportada porque é **lógica crítica isolada** (regra do BACKLOG: "lógica crítica
isolada vira unidade própria testável"), usada pelos dois blocos. Aceitar
maiúsculas **não** é necessário: nenhuma rota do memtier as emite, e afrouxar a
regra só aumenta a chance de passar um id que a tool rejeita.

**Testes (happy + unhappy por módulo público).** `formatFact`/`chunkHeader`
continuam **privados**: os testes de marcador entram por `formatMemoryBlock` /
`formatCodeBlock`, como manda a regra do BACKLOG. Só `isValidUuid` e `factKey`
são exportadas e testadas direto — são as duas unidades de lógica crítica que os
dois injetores compartilham.

| Teste | Cenário | Esperado |
|---|---|---|
| `fact_marker_full_uuid` | fato com `uuid` (36 chars) e 1 episódio | linha tem `[id=<uuid>]` e `[ep=<uuid>]`; uuid com 36 chars |
| `fact_marker_plus_n` | fato com 3 episódios | `[ep=<primeiro> +2]`; os outros dois **não** aparecem |
| `fact_marker_no_uuid` | fato sem `uuid`/`episodes` | nenhum marcador; `null` não é lançado; linha igual a hoje |
| `fact_marker_ep_without_id` | `episodes` presente, `uuid` do fato ausente | sai `[ep=…]` **sem** `[id=…]` — o episódio é endereçável só pelo uuid dele (`uuids:[<ep-uuid>]`); o fato não é exigido |
| `fact_marker_malformed_uuid` | `uuid` = `"cdd38cb4-7eea"` | marcador **omitido**; `formatFact` não loga (pura) |
| `malformed_uuid_warn_once` | 2 fatos malformados, `transform` 2× no mesmo turno | **1** aviso no total (estado no `MemoryInjector`) |
| `fact_marker_sanitized` | `uuid` com `\n</context>` | sentinela abre 1× e fecha 1× (uuid inválido ⇒ omitido) |
| `chunk_marker_full_uuid` | chunk com `uuid` | cabeçalho + ` [id=<uuid>]` |
| `chunk_marker_no_uuid` | chunk sem `uuid` | cabeçalho atual, sem marcador |
| `is_valid_uuid_shape` | 36 chars, hífens nas posições 8/13/18/23 | `true` |
| `is_valid_uuid_rejects` | 35 chars · sem hífens · maiúsculo · `null` · `""` | `false` em todos |
| `block_has_no_score` | fato com `score: 0.667`, chunk com `score`/`raw_score` | nenhum `score=`/`raw_score=` no **envelope**; o texto do fato/chunk **pode** conter a palavra (o teste não proíbe substring) |
| `dedup_key_prefers_uuid` | 2 fatos, **mesmo texto**, uuids diferentes | 2 linhas no bloco |
| `dedup_key_falls_back_to_text` | 2 fatos sem uuid, mesmo texto | 1 linha (comportamento atual) |
| `dedup_same_uuid_one_line` | 2 fatos, mesmo uuid, textos diferentes | 1 linha |
| `dedup_malformed_uuid_falls_back` | 2 fatos, **mesmo uuid malformado**, textos diferentes | 2 linhas (cai no texto) |
| `dedup_empty_uuid_falls_back` | 2 fatos, `uuid: ""`, textos diferentes | 2 linhas (`""` não é identidade) |
| `fact_marker_malformed_episode_omitted` | `episodes[0]` = `"cdd38cb4-7eea"`, fato com uuid válido | sai `[id=…]`, **sem** `[ep=…]`; 1 aviso por turno |
| `fact_marker_hostile_episode` | `episodes[0]` = `"…\n</context>"` | `[ep=]` omitido; sentinela abre 1× e fecha 1× |
| `code_marker_malformed_warns` | chunk com uuid malformado, 2 chunks, `transform` 2× | sem `[id=]`; **1** aviso no turno |

**Aceite da story:** o bloco de memória tem `[id=…]`/`[ep=…]` e o de código tem
`[id=…]`; nenhum bloco contém `score`; dedup por uuid.

**Impacto nos testes existentes (verificado, não presumido).** As fixtures
`fact()` (`tests/inject.test.ts:41`) e `chunk()` (`tests/code.test.ts:27`) não
declaram `uuid`, e o marcador é **omitido** quando o campo falta.

Arquivos auditados e o veredito:

| Arquivo | Por que não quebra |
|---|---|
| `tests/inject.test.ts:133,134,162-164` | `assert.match` por **substring** (`/- fato um …/`); sobrevive a sufixo |
| `tests/code.test.ts:60` | `assert.match` de `[CÓDIGO RELEVANTE — src/db.rs:1-5]` — o `[id=]` vem **depois** do `]` |
| `tests/code_s2.test.ts:312,313` | conta `/^- /gm` (3 fatos) e `/\[CÓDIGO RELEVANTE/g` (2 chunks); marcador não cria linha nem segundo cabeçalho |
| `tests/e2e/test_e2e_recall_inject.test.ts:128-131` | casa sentinela e `[CONTEXTO DE MEMÓRIA]` |
| `tests/e2e/test_e2e_inject_code.test.ts:160-163` | casa `[CÓDIGO RELEVANTE — src/e3c_probe.rs:` (sem fechar o `]`) |
| `tests/e2e/test_e2e_inject_limits.test.ts:103` | localiza o part por `graph-memory`, não formata |
| `tests/logger.test.ts` | **não** toca nos blocos (é do `logger`); citado antes por engano |

**Condição explícita:** quando **ambos** os marcadores são omitidos, a linha de
memória é **byte-idêntica** à atual — **sem espaço residual**. O teste
`fact_marker_no_uuid` asserta igualdade exata da linha, não só ausência de
marcador; sem isso, um `\`${base} \`` com espaço sobrando passaria despercebido.

### E8-S2 — Instrução de sistema derivada do estado (item 6)

**Entrega:** `src/hooks/system.ts` (`systemHook`, texto derivado), chave
`inject.instruction_enabled` em `config.ts` (DEFAULTS, resolução, env, validação
booleana), fiação em `src/index.ts`.

**Texto — estrutura fixada** (a redação pode refinar; a **estrutura** é
contrato). Três parágrafos:


1. **O que é**: o workspace tem grafo consultável via MCP; o contexto injetado
   (`graph-memory` / `graph-code`) é **amostra**, não o conjunto.
2. **Como expandir**, com as tools **derivadas** (decisão 6) e a chave de entrada
   de cada uma:
   - `memory_neighbors` ← `[id=…]` do fato;
   - `memory_episodes` ← `[ep=…]` do episódio;
   - `recall` ← nova consulta (filtros: `as_of`, `depth`, `entity_types`);
   - `code_neighbors` ← `[id=…]` do chunk (`direction`, `edge_kind`);
   - `code_search` ← nova consulta.
3. **Vocabulário dos ids**: `[id=…]` = uuid do fato/chunk, `[ep=…]` = uuid do
   episódio de origem.

**Custo: medido, não presumido (RFC-001 §6, proposta 5).** O texto é reenviado a
**cada** turno, então o teto é contrato, não estimativa.

**Medição feita nesta revisão** — rascunho em português, com as 5 tools, os
filtros e o vocabulário dos ids, escrito na estrutura acima:

```
chars: 870   |   tokens (chars/4, ADR-009): 218
```

Isso já responde à proposta 5 da RFC ("deve ser medido, não presumido") e mostra
que a faixa "~100–150 tokens" que esta spec trazia antes estava **subestimada em
~45%**. Três parágrafos com 5 tools e 5 nomes de parâmetro **não cabem** em 150
tokens.

Contrato:

- teto assertado no teste: **≤ 1000 chars** (~250 tokens). Os 870 medidos deixam
  ~130 chars de folga para a redação final sem afrouxar o teto;
- o teste de unidade asserta `instruction.length <= 1000` e **falha** acima disso
  (não é aviso — um prompt de sistema que cresce sem controle é regressão
  silenciosa de custo por turno);
- a unidade de contagem é `chars/4` (a do ADR-009), para não introduzir uma
  terceira régua no projeto;
- a S3 registra o **valor final medido** no histórico do BACKLOG, substituindo a
  estimativa pelo número real.

**Testes:**

| Teste | Cenário | Esperado |
|---|---|---|
| `system_instruction_present` | `inject.enabled=true`, `mcp.enabled=true`, `code_index.enabled=true` | `output.system` ganha **1** elemento; cita as 5 tools |
| `system_instruction_pull_only` | `code_index.enabled=true`, `inject.code_enabled=false` | **cita** `code_search`/`code_neighbors` (pull independe do push) |
| `system_instruction_off` | `instruction_enabled=false` | array **intacto** (mesmo comprimento, mesmo conteúdo) |
| `system_instruction_inject_off` | `inject.enabled=false` | array intacto |
| `system_instruction_mcp_off` | `mcp.enabled=false`, resto ligado | array intacto; **nenhuma** tool citada |
| `system_instruction_no_code` | `code_index.enabled=false` | cita memória; **não** cita `code_search`/`code_neighbors` |
| `system_instruction_no_write_tools` | qualquer estado | **não** cita `ingest` nem `code_sync` |
| `system_appends_not_replaces` | `output.system` = `["prompt do host"]` | len 2; `[0]` **inalterado**; texto no `[1]` |
| `system_idempotent` | hook chamado 2× no mesmo `output` | **1** ocorrência do texto |
| `system_never_throws` | estado malformado (config `undefined`) | não lança; array inalterado |
| `system_hook_registered` | `plugin(ctx)` | o objeto devolvido tem as chaves dos **dois** hooks |
| `system_output_not_array` | `output.system` = `undefined`/string | não lança; nada é escrito |
| `config_instruction_default_true` | sem env/arquivo | `inject.instruction_enabled === true` |
| `config_instruction_env_false_wins` | env `=false` | `false` (env vence o default) |
| `config_instruction_options_win` | `options` = `false`, env `=true` | `false` (`options` vence env) |
| `config_instruction_garbage_falls_back` | env `="talvez"` | default `true`, sem lançar |

**Aceite da story:** com `inject.enabled=true` **e** `mcp.enabled=true` o turno
recebe a instrução; com qualquer um dos dois desligado, o array de sistema fica
**intacto**. A instrução cita **apenas** tools cuja config as habilita
(`mcp.enabled` para memória, `+ code_index.enabled` para código — decisão 6) e
nunca as de escrita. Teto de custo assertado (`≤ 1000 chars`, medido 870).

### E8-S3 — Fechamento: E2E de ida-e-volta, docs, zero pendências (item 9)

**Entrega:** E2E que prova o ciclo **id injetado → tool com esse id → conteúdo**
contra o servidor real; remoção do `uuid5` recalculado no E2E do coletor; docs
alinhados; `BACKLOG.md` com os checkboxes.

**E2E (gated `E2E=1`), quatro provas numa cadeia:**

1. `recall` real → bloco injetado tem `[id=<uuid 36>]` e `[ep=<uuid 36>]`;
2. esse `[ep=…]` → `POST /v1/memory/episodes` com body
   `{workspace, program, uuids: [<ep-uuid>]}` devolve `resolved: 1` e
   `episodes[0].content` **não vazio** (`episodes[0].uuid` = o injetado). Prova
   que o id é **utilizável**.
   **Contraprova obrigatória:** o mesmo request com o `[id=…]` do **fato** em
   `uuids` devolve `resolved: 0` — fixa que a chave do episódio é o uuid do
   **episódio**, não o do fato. (Verificado no servidor: `uuids` é o campo;
   `uuid` singular responde **422 missing**.)
3. `code_search` real → bloco de código tem `[id=<uuid 36>]`; esse uuid →
   `POST /v1/code/neighbors` responde 200 (mesmo que `[]`). Prova o contrato do
   9º campo;
4. `system.transform` real → contém as tools de memória e **não** contém
   `code_search`/`code_neighbors` quando `code_index.enabled=false`.

**Harness do item 4 (pinar, senão dois implementadores divergem):**

```ts
// Boot com o client MCP stubado (o real é background e não espera):
hook = plugin(ctx, { inject: { enabled: true }, mcp: { enabled: true },
                     code_index: { enabled: false } });
out  = { system: ["prompt do host"] };
await hooks["experimental.chat.system.transform"]({ model }, out);
```

- `input` = `{ sessionID?, model }`; o hook **não** lê `model` (assinatura do SDK,
  `index.d.ts:267`);
- `output.system` começa com **1** elemento; depois do hook tem **2**;
- `out.system[0]` inalterado — é o teste de não-substituição;
- o teste **não** exige `client.mcp` real: a derivação é de config (ver
  "Limite honesto" na decisão 6).

**Parâmetros citados x `tools/list` (verificado em 2026-10-30):**

| Tool | Parâmetros reais |
|---|---|
| `memory_neighbors` | `uuid`, `include_invalid`, `limit`, `workspace`, `program` |
| `memory_episodes` | **`uuids` (array)**, `workspace`, `program` |
| `code_neighbors` | `uuid`, `direction`, `edge_kind`, `depth`, `limit`, `workspace`, `program` |

A instrução cita `uuid` para `memory_neighbors`/`code_neighbors` e **`uuids`**
(plural, array) para `memory_episodes` — o nome errado ali viraria chamada 422.

**Item 9 — `chunkUuid` sai.** Em `tests/e2e/test_e2e_collector.test.ts:42-52` o
teste **recalcula** `uuid5(CODE_NS, "{file}:{symbol}")` para navegar. A partir do
v1.1.0 o uuid vem na própria resposta de `code_search`, então:

- apagar `chunkUuid` e o import de `node:crypto` (se ficar sem uso);
- nas duas navegações (`connect` e `validate`), tirar o uuid do chunk
  correspondente na resposta de `code_search` (por `path` + `symbol`), com
  `assert.ok(uuid, …)` — **falha**, não skip, se o campo sumir;
- o `limit: 8` da busca pode precisar subir para alcançar os dois símbolos; o
  ajuste é no teste, com o motivo no commit.

**Docs no fechamento** — lista fechada, por arquivo e seção (verificada no
`main` em 2026-10-30):

| Arquivo | O que corrigir |
|---|---|
| `docs/ARCHITECTURE.md` **§2** | exemplo de resposta do `recall` (ganha `uuid`/`episodes`); exemplo do `code/search` (ganha `uuid` como 9º campo); seção do `code/neighbors` ("HTTP-only / bloqueio MCP" → tool `code_neighbors`, v1.1.0); lista de tools MCP (4 → 7); **duas rotas de memória** (`/v1/memory/episodes`, `/v1/memory/neighbors`) — hoje ausentes do `main` |
| `docs/ARCHITECTURE.md` **§3** | tabela de hooks: `system.transform` sai de "contexto de sistema" genérico para "instrução de uso do memtier" |
| `docs/ARCHITECTURE.md` **§5** | "estado atual vs. alvo" → formato real, com `[id=]`/`[ep=]` |
| `docs/ARCHITECTURE.md` **§6** | `inject.instruction_enabled` (JSON + env + default) |
| `src/README.md` | `hooks/system.ts`, `inject/uuid.ts`, `factKey`, `isValidUuid`, marcadores |
| `README.md` | Não-objetivos (navegação) — **depende do item 7** |
| `docs/PRD.md` | FR-603 (7 tools) e a FR de hooks — **depende do item 7** |
| `BACKLOG.md` | marcar E8 + entrada de histórico já escrita |

> ⚠️ **A §7 da ARCHITECTURE é "Adaptadores multi-CLI", não rotas de memória.** O
> cabeçalho "Fonte" desta spec citava "§7 (rotas de memória)" — está errado e não
> deve ser propagado. As rotas vivem na **§2**, junto do resto do contrato.

**Aceite da story:** os 4 E2E passam contra o v1.1.0; `rg "chunkUuid"` = 0;
`rg "\[id="` acha o formato na doc e no código; `bun run typecheck` limpo;
`npm test` sem regressão.

---

## Critérios de aceite (da epic — só o dono marca)

- [ ] **E8-S1** — Identidade: `uuid`/`episodes` declarados e formatados como
      `[id=<uuid completo>]`/`[ep=<uuid> +N]`, com os dois marcadores validados;
      sem `score`; dedup por uuid com fallback para o texto
- [ ] **E8-S2** — Instrução: `system.transform` registrado, derivado do estado
      real, configurável, nunca lança
- [ ] **E8-S3** — Fechamento: E2E de ida-e-volta verde, `chunkUuid` eliminado,
      docs coerentes

**Aceite herdado da RFC-001** (verificado na S3, não presumido):

- cada item injetado traz id **estável e completo** (36 chars);
- o bloco **não** contém `score`;
- `recall` → bloco com uuid do fato **e** do primeiro episódio →
  `memory_episodes` devolve o texto original;
- a instrução cita apenas tools cuja **config** as habilita (`mcp.enabled`,
  `code_index.enabled`) — é derivação de config, com o resíduo declarado na
  decisão 6, não leitura de disponibilidade ao vivo.

---

## Fora de escopo (decidido — não reabrir sem evidência nova)

| Item | Por quê |
|---|---|
| **`score` no bloco** (RFC 3c) | relativo ao top-1 da própria consulta; a ordem já dá o ranking (§3 da RFC) |
| **`depth` no plugin** (RFC 5a) | navegação é **pull**; `depth>1` no push troca precisão por recall no caminho crítico |
| **Multi-hop de código** (RFC 5d) | adiado **com medição** no memtier (RFC-004 D6); o cliente encadeia `code_neighbors` |
| **Duplicar navegação por HTTP** | ADR-006: a tool já existe; o plugin não a reimplementa |
| **Injetar `content` do episódio** | um episódio medido tem 2.436 chars; consumiria o orçamento inteiro (`memory_max_tokens` 2000) |
| **Escolher quais tools o MCP expõe** | o registro é por **servidor**; o plugin não tem esse controle |
| **Trocar o dedup de código para `uuid`** | guarda local do turno; com servidor antigo deixaria de deduplicar |

---

## Histórico de revisão

- **2026-10-30** — criada a partir da RFC-001 rev. 5 (achados 1/2/5 fechados no
  memtier v1.1.0; resta plugin). Formato `[id=]`/`[ep=]` fixado; `score` e
  `depth` declarados fora de escopo; `instruction_enabled` com default `true`
  subordinado a `inject.enabled`; dedup por `uuid` com fallback para o texto.
- **2026-10-30 — revisão adversarial (1 BLOCKER×4, 8 MAJOR, 3 MINOR, 2 NIT).**
  Correções:
  1. **`/v1/memory/episodes` leva `uuids: []`, não `uuid`** — provado ao vivo: o
     campo singular responde **422 missing**. O E2E da S3 como estava era
     vermelho por construção; agora inclui contraprova (`resolved: 0` com o uuid
     do fato).
  2. **`factKey` valida, não usa `??`** — um uuid malformado (ou `""`, que o `??`
     não pega) virava chave de dedup enquanto o marcador era omitido: dedup e
     display divergiam, o defeito que a própria decisão 4 existe para eliminar.
  3. **`src/types.ts` entra na S2** — `Config` mora lá; mexer em `DEFAULTS` sem
     estender o tipo reprova o typecheck.
  4. **A §7 da ARCHITECTURE é "Adaptadores multi-CLI"**, não rotas de memória. A
     tabela de docs da S3 foi reescrita por seção, e o que estava omisso (as
     rotas de memória e os exemplos da §2) entrou.
  5. **Push ≠ pull.** O texto literal da RFC condiciona `code_search`/
     `code_neighbors` a `inject.code_enabled` (push), mas a tool é pull e o
     conteúdo depende de `code_index.enabled`. Manter a letra esconderia tools
     que funcionam de quem quer o grafo só sob demanda. Corrigido, com o desvio
     registrado.
  6. **Política de aviso: um por turno por família** (booleano, como
     `floorWarnedThisTurn`), substituindo o `Set` por uuid que contradizia a
     própria tabela; código **não** degrada em silêncio.
  7. **Custo do system prompt medido** — rascunho real dá **870 chars**
     (~218 tokens); a faixa "~100–150 tokens" desta spec estava subestimada em
     ~45%. Teto assertado em **≤ 1000 chars**.
  8. **`block_has_no_score` não proíbe a palavra no conteúdo** (o código do repo
     pode dizê-la); o teste olha o envelope.
  9. **`[ep=]` também é validado** — `episodes[0]` é string do fio; sem o gate,
     `[ep=</context>]` furava a sentinela que o D-3 fechou.
  10. **S2 é tracer bullet** — `system.transform` nunca atravessou camada
      nenhuma deste plugin; a epic não pode declarar "sem tracer bullet" e ao
      mesmo tempo estrear superfície.
  11. Testes de config (default/env/options/lixo) e de `output` malformado
      acrescentados; `factKey`/`isValidUuid` com unhappy path.
  12. Auditoria de impacto nos testes existentes refeita por arquivo, e a
      condição "byte-idêntico" passou a ser assertada, não argumentada.

- **2026-10-30 — E8-S1 implementada.** Contrato aditivo como especificado:
  `Fact.uuid?`/`Fact.episodes?` e `CodeChunkHit.uuid?` (`src/client.ts`),
  `src/inject/uuid.ts` (`isValidUuid`, `8-4-4-4-12` minúsculo), marcadores
  `[id=…]`/`[ep=… +N]` em `formatFact`/`chunkHeader`, `factKey` com fallback
  `text:`, dedup por uuid em `prepare`/`commit` e aviso booleano por turno por
  família em `MemoryInjector`/`CodeInjector`. `chunkIdentity` segue
  `path:start-end`. 29 testes novos em `tests/e8_s1.test.ts`; suíte 642
  (621 pass, 21 skip, 0 fail).

  **Revisão adversarial (3 perfis em paralelo) — achados corrigidos:**
  1. **Contador desonesto** — `invalidIdentityCount` somava por CAMPO; um fato
     com `uuid` e `episodes[0]` tortos logava "2 itens" para 1 item. Passou a
     contar o ITEM (fato), como a decisão 2 manda (`N item(ns)`).
  2. **`episodes` não-array degradava em silêncio** — campo presente fora da
     forma (string/objeto) omitia `[ep=]` sem aviso, contra a decisão 2. Agora
     conta como item afetado e emite o aviso.
  3. **Memória avulsa (`recallAndFormat`) não avisava** — só o caminho de turno
     e o código avulso avisavam; assimetria contra "degradar sem avisar não".
     Agora avisa por chamada (sem estado de turno), com teste dedicado.
  4. Cobertura reforçada: hífen fora de 8/13/18/23, `episodes` não-array,
     contagem por item, avulso (presente/ausente) e bloco vazio ⇒ `null`.
  5. Refutado com evidência: `dedupeByFactKey` (dedup intra-resposta) não é
     regressão — espelha `dedupeByIdentity` do código e é exigido por
     `dedup_key_falls_back_to_text`; `warnInvalidIds` em `prepare` cobre
     `inject`/hook, pois ambos passam por `prepare`.

- **2026-10-30 — E8-S2 implementada (tracer bullet).** Fatia mínima primeiro
  (hook registrado + texto fixo empurrado + prova num boot real), endurecida na
  mesma base: `buildInstruction` derivado da config, `appendInstruction`
  idempotente e never-throws, `systemRuntimeFrom` puro para a derivação,
  `inject.instruction_enabled` em `DEFAULTS`/`Config`/resolução/env (fora de
  `configStateFrom`). Texto final medido: **707 chars** com código / **555** sem
  (rascunho da spec: 870); teto assertado `≤ 1000`. Marcadores
  `TODO(tracer-bullet):` removidos (`rg` = 0). 22 testes de unidade em
  `tests/e8_s2.test.ts` + 3 E2E em `tests/e2e/test_e2e_system_instruction.test.ts`
  (gated `E2E=1`, verdes contra o stack local). Suíte 667 (643 pass, 24 skip,
  0 fail).

  **Revisão adversarial (3 perfis em paralelo) — achados resolvidos:**
  1. **`system_instruction_pull_only` era tautológico** — o unit testava o tipo
     `SystemRuntime`, que não tem `code_enabled`, então passava por construção.
     A derivação passou a ser uma função pura (`systemRuntimeFrom`) que lê a
     config CRUA (com `code_enabled: false`) e prova a independência de push sem
     bootar o plugin (boot com `code_index.enabled` spawna o indexer — efeito
     colateral fora de teste de unidade).
  2. **Comentário de custo defasado** — dizia "medido 870 no rascunho"; o texto
     final mede 707/555. Corrigido no código.
  3. Refutado com evidência: `push` em array congelado lança dentro do `try` e o
     turno segue (NFR-03); dedup por VALOR (`includes`) cobre dois boots no mesmo
     `output`; `inject.enabled=false` retorna `null` antes de montar parágrafos;
     parâmetros citados batem com `tools/list` (`memory_episodes` usa `uuids`).
  4. Nota para a S3: o valor final a registrar no histórico do BACKLOG é **707**
     (a spec citava 870 do rascunho). Nenhum overclaim novo: o texto diz "tem
     grafo consultável via MCP", não "tools disponíveis" (resíduo da decisão 6).

- **2026-10-30 — E8-S3 (fechamento) implementada.** E2E de ida-e-volta em
  `tests/e2e/test_e2e_e8_roundtrip.test.ts` (5 testes): `[ep=…]` injetado resolve
  `content` em `/v1/memory/episodes` (`uuids: []`), com contraprova
  `resolved: 0` para o uuid do **fato** e `422` para o campo singular; `[id=…]` do
  chunk navega em `/v1/code/neighbors` (200); `system.transform` sem tools de
  código com `code_index.enabled=false`. O E2E do coletor passou a ler o uuid de
  `code_search` (`symbolChunkId`), sem `uuid5` recalculado (`rg "chunkUuid"` = 0).

  `stash@{0}` (item 7 da RFC-001) aplicado e conferido: README, ADR-006,
  ARCHITECTURE §2 (exemplos de `recall`/`code/search` com `uuid`, `code_neighbors`
  como tool, 7 tools, rotas `/v1/memory/episodes` e `/v1/memory/neighbors`), §3
  (`system.transform` = instrução de uso), §5 (formato real com `[id=]`/`[ep=]`),
  §6 (`inject.instruction_enabled`), PRD FR-603 e E2E do MCP (conjunto exato de
  7 tools). RFC §7 e o Encaminhamento marcados como feitos. `rg
  "travada|4 tools"` = 0.

  **Valor final de custo da instrução: 707 chars** (com código) / 555 (só
  memória) — substitui a estimativa de 870 no histórico acima.

  **Revisão inline (S3 não é de vulto):** E2E com `dispose` no `finally`; URL do
  E2E do round-trip pinada em `E2E_MEMTIER_URL` (ou local) para não herdar um
  `KILOCODE_GRAPH_URL` remoto de dev — o teste é do stack local; `code_min_score`
  pinado em `""` no cenário de código para o piso do ambiente não filtrar o probe.
  Verificação: `tsc --noEmit` limpo; `npm test` 672 (643 pass, 29 skip, 0 fail).

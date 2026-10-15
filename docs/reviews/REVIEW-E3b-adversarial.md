# REVIEW-E3b — Revisão adversarial postergada do épico E3b (registro do MCP remoto do memtier)

- **Alvo:** `kilocode-graph-plugin`, commit `724250d` (worktree `wt-e3b`, HEAD destacado).
- **Épico:** E3b (S1→S3, commits `6226f3a` → `d89c9e6` → `5d2b9a4`).
- **Arquivos revisados:** `src/mcp/register.ts`, `src/mcp/kilo-config.ts`, `src/index.ts`,
  `src/config.ts`, `src/types.ts`, `tests/mcp.test.ts`, `tests/e2e/test_e2e_mcp.test.ts`.
- **Contexto:** o E3b foi o único épico que fechou sem adversariais (infra de subagente
  fora do ar, `litellm:4000`). Este é o review que faltou.
- **Método:** leitura do código real; execução de typecheck/unit/E2E; três perfis
  adversariais em paralelo (BLIND-HUNTER, EDGE-CASE-HUNTER, VERIFICATION-GAP); toda
  alegação abaixo foi re-executada pela sessão-mãe antes de entrar em DEFEITOS.
- **Ambiente medido:** Node `v22.23.3`, memtier vivo (`GET /v1/health` → `200 {"status":"ok"}`),
  bearer real em `.kilo/graph-key.json` (`workspace=kilocode-graph-plugin`, `program=graphplugin`).

**Baseline reproduzida:**
```
$ bun run typecheck        -> exit 0
$ npm test                 -> # tests 176 / pass 168 / fail 0 / skipped 8
$ node --test tests/mcp.test.ts -> # tests 24 / pass 24 / fail 0
```

---

## DEFEITOS

Todos os itens abaixo foram **CONFIRMADOS** (reproduzidos) pela sessão-mãe. Sem
reprodução, o item foi para RISCOS/NAO-PROVADO.

### D-1 — CONFIRMADO · O comando E2E prescrito pela epic FALHA
**Arquivo:** `tests/e2e/test_e2e_mcp.test.ts:38` (`WS` hardcoded) e `:44` (token).
**Efeito:** o comando documentado (`BACKLOG.md:312`, `specs/e3b-stories.md:181`) —
`E2E_TOKEN=e2e-tok-a E2E_CODE_TOKEN=e2e-tok-b` — é **vermelho**. `e2e-tok-a` é escopado
ao workspace `alfa`/program `default`; o teste hardcoda `WS="kilocode-graph-plugin"` e
`program="graphplugin"` e chama `recall` nesse workspace → o servidor responde
`"workspace 'kilocode-graph-plugin' fora do escopo do token"` com `isError:true`. O épico
declara "E2E verde" usando este comando; ele não é verde.

**Reprodução:**
```
$ E2E=1 E2E_TOKEN=e2e-tok-a E2E_CODE_TOKEN=e2e-tok-b node --test tests/e2e/test_e2e_mcp.test.ts
not ok 1 - e2e: registro implícito do MCP + 4 tools reais listáveis/chamáveis
  error: |-
    recall deve responder sem erro
    true !== false
# pass 1
# fail 1

# (mesmos tokens, glob completo da suite)
$ E2E=1 E2E_TOKEN=e2e-tok-a E2E_CODE_TOKEN=e2e-tok-b node --test "tests/e2e/**/*.test.ts"
not ok 5 - e2e: registro implícito do MCP + 4 tools reais listáveis/chamáveis
# tests 8 / pass 7 / fail 1
```
**Prova do escopo do token (mesmo token `e2e-tok-a`, dois workspaces):**
```
ws=kilocode-graph-plugin program=graphplugin -> isError:true "fora do escopo do token"
ws=alfa               program=default        -> isError:false (fatos reais)
```

### D-2 — CONFIRMADO · O E2E do MCP ignora `E2E_CODE_TOKEN` e passa por fallback silencioso
**Arquivo:** `tests/e2e/test_e2e_mcp.test.ts:44` (`E2E_TOKEN ?? KILOCODE_GRAPH_TOKEN`),
`:47-48` (fallback para `.kilo/graph-key.json`).
**Efeito:** o detalhe deliberado da epic ("o E2E **precisa de dois tokens distintos** —
`E2E_TOKEN` e `E2E_CODE_TOKEN`") **não é honrado** por este teste: `E2E_CODE_TOKEN` é
referenciado **0 vezes**. Pior: quando `E2E_TOKEN`/`KILOCODE_GRAPH_TOKEN` faltam, o teste
cai silenciosamente no `.kilo/graph-key.json` do worktree — então `E2E=1` **sem token
nenhum** passa. Isso mascara ausência de injeção de secret em CI e torna o verde
não-determinístico em relação ao ambiente.

**Reprodução:**
```
$ grep -c "E2E_CODE_TOKEN" tests/e2e/test_e2e_mcp.test.ts
0

$ E2E=1 E2E_CODE_TOKEN=totally-fake-xyz node --test tests/e2e/test_e2e_mcp.test.ts
# pass 2 / fail 0        <- token de lixo do código não afeta nada (fallback no graph-key)

$ E2E=1 node --test tests/e2e/test_e2e_mcp.test.ts
# pass 2 / fail 0        <- sem NENHUM token: passa lendo .kilo/graph-key.json

$ E2E=1 E2E_TOKEN=totally-fake-token-xyz node --test tests/e2e/test_e2e_mcp.test.ts
not ok 1 - MCP HTTP 401 em initialize   # só quando E2E_TOKEN é setado e é inválido
```

### D-3 — CONFIRMADO · `stripJsoncComments` não remove vírgula final ⇒ override do usuário é ignorado (FR-602 violado)
**Arquivo:** `src/mcp/kilo-config.ts:32-65` (stripper), `:77` (`JSON.parse`), `:72-86`
(`readKiloConfig` engole o erro e devolve `null`), `:93-102` (`getKiloMcpOverride` → `undefined`).
**Efeito:** `kilo.jsonc` é JSONC; vírgula final é JSONC válido e comum. O stripper só
remove comentários — não trata trailing comma. `JSON.parse` lança, o `catch` devolve
`null`, `getKiloMcpOverride` devolve `undefined`, e `registerMemtierMcp:143-147` **não vê
override** → registra por cima da definição do usuário. Silencioso, sem log. Fere o
contrato #3 (idempotência).

**Reprodução:**
```
$ node /tmp/kilo/final_confirm.ts
trailing-comma user override -> calls = ["status","add","connect"]   (esperado [] se FR-602 honrado)

# isolando o parse:
stripJsoncComments('{\n "mcp": {"memtier": {...},},\n}')  -> mantém a vírgula
JSON.parse(...)  -> throws "Expected double-quoted property name in JSON at position ..."
getKiloMcpOverride(dir,"memtier") -> undefined
```

### D-4 — CONFIRMADO · Precedência de arquivos de config sombreia o override (FR-602 violado)
**Arquivo:** `src/mcp/kilo-config.ts:19-25` (`KILO_CONFIG_FILES`) + `:74-75` (retorna no
1º arquivo **existente**, mesmo sem `mcp`).
**Efeito:** se o workspace tem `.kilo/kilo.jsonc` existente (ex.: `{ "foo": 1 }` ou
`{ "mcp": {} }`) **e** um `kilo.jsonc` na raiz que **define** `mcp.memtier`, o plugin lê
só o `.kilo/kilo.jsonc`, não acha o override e **registra por cima** do que o usuário
definiu. Fere o contrato #3.

**Reprodução:**
```
$ node -e '...'   # .kilo/kilo.jsonc = {"foo":1}; kilo.jsonc = {"mcp":{"memtier":{...}}}
readKiloConfig -> { foo: 1 }
getKiloMcpOverride(dir,"memtier") -> undefined
registerMemtierMcp(...) -> calls = ["status","add","connect"]   (sobrescreveu o usuário)
```

### D-5 — CONFIRMADO · `buildMcpConfig` faz junção ingênua de URL (corrompe base com path/query/fragment)
**Arquivo:** `src/mcp/register.ts:107-110` (`base = cfg.url.replace(/\/+$/,"")` + `${base}/v1/mcp`).
**Efeito:** só funciona para base nua `host:port`. Qualquer `daemon.url` com `?`, `#`, ou
que já contenha subpath produz URL inválida (`?query` ANTES do path). `url=""` vira
`/v1/mcp` (relativo). Nenhuma validação; falha só aparece como `fetch failed` no log de
`connect` (FR-604 esconde o defeito). Fere o contrato #5 ("`url: .../v1/mcp`").

**Reprodução:**
```
$ node -e "import{buildMcpConfig}from'./src/mcp/register.ts'; for(const u of ['http://127.0.0.1:8400?x=1','http://127.0.0.1:8400#frag','http://h:8400/api','']) console.log(u,'->',buildMcpConfig({url:u,token:'t',timeout_ms:15000}).url)"
http://127.0.0.1:8400?x=1  -> http://127.0.0.1:8400?x=1/v1/mcp
http://127.0.0.1:8400#frag -> http://127.0.0.1:8400#frag/v1/mcp
http://h:8400/api          -> http://h:8400/api/v1/mcp
(empty)                    -> /v1/mcp
```

### D-6 — CONFIRMADO · Máquina de estados deixa o MCP morto para `status` ∈ {disabled, connecting, disconnected, error}
**Arquivo:** `src/mcp/register.ts:157-179` (esp. `:174-178` `else if (existing) return`),
`:52-57` (`shouldRefreshMcpRegistration` só é `true` para `failed`/`ENOENT`).
**Efeito:** qualquer `existing` que não seja `connected` nem `failed`/`ENOENT` cai no
`return` sem `add` nem `connect`. O plugin nunca repara o registro: o modelo recebe **0
tools** e **nenhum erro**. Isto é uma **regressão** face ao antecessor
(`openviking-memory.js:1806-1817`), que fazia `disconnect` para **qualquer** existente
não-conectado. Um `connecting` preso ou um `disabled` vira falha permanente silenciosa.

**Reprodução:**
```
$ node /tmp/kilo/verify_edges.ts
status=disabled     -> calls=["status"]     # LEFT UNREGISTERED
status=connecting   -> calls=["status"]     # LEFT UNREGISTERED
status=disconnected -> calls=["status"]     # LEFT UNREGISTERED
status=error        -> calls=["status"]     # LEFT UNREGISTERED
```

### D-7 — CONFIRMADO · Concorrência (dois boots) → `409` fatal espúrio, sem reparo
**Arquivo:** `src/mcp/register.ts:149-184` (fluxo `status`→`add` não atômico, sem lock).
**Efeito:** dois registros simultâneos (ex.: dois reloads/boots no mesmo diretório) ambos
leem `status {}` vazio e ambos chamam `add`. O segundo recebe `409 already exists`, cai em
`logFatal("mcp add", ...)` e **retorna sem `connect`**. Estado final: um `connect`, um
`FATAL` de ruído no log, nenhum retry. Não lança (FR-604 ok), mas o log acusa erro que não
é erro real e o registro do perdedor fica incompleto.

**Reprodução:**
```
$ node /tmp/kilo/repro_register.ts
[graph] FATAL mcp add: {"status":409,"detail":"already exists"}
CONCURRENCY calls = ["status","status","add","add","connect"]   # só 1 connect
```

### D-8 — CONFIRMADO · `mcp.name` vai cru para os path params do SDK (sem validação/sanitização)
**Arquivo:** `src/config.ts:257` (`resolve("mcp.name", ...)` sem validação) → consumido em
`src/mcp/register.ts:65,68` e `:181,187`.
**Efeito:** `mcp.name` vazio (`""`), com barra (`"a/b"`), traversal (`"../evil"`) ou unicode
é passado literalmente a `client.mcp.add`/`connect`. Nome vazio cria registro sem nome;
`a/b` pode virar segmento de path. Sem erro de validação; no máximo um `FATAL` do `add`.

**Reprodução:**
```
$ node -e "import{registerMemtierMcp}from'./src/mcp/register.ts'; for(const name of ['a/b','','../evil']){...}"
"a/b"     -> ["status","add:\"a/b\"","connect:\"a/b\""]
""        -> ["status","add:\"\"","connect:\"\""]
"../evil" -> ["status","add:\"../evil\"","connect:\"../evil\""]
```

### D-9 — CONFIRMADO · Token com espaços gera header `Authorization: Bearer    ` (truthiness, sem trim)
**Arquivo:** `src/mcp/register.ts:114` (`if (cfg.token) config.headers = {...}`).
**Efeito:** `token: "   "` é truthy → gera `Authorization: Bearer    ` (com espaços). Um
token que é só whitespace deveria ser tratado como vazio (sem header), como `""`.

**Reprodução:**
```
$ node /tmp/kilo/verify_edges.ts
token '   ' -> {"Authorization":"Bearer    "}
token ''    -> undefined
```

### D-10 — CONFIRMADO · `mcp.memtier = false` (intenção de desligar) NÃO bloqueia o registro
**Arquivo:** `src/mcp/kilo-config.ts:101` (`if (!entry || typeof entry !== "object") return undefined`).
**Efeito:** a forma idiomática de o usuário desligar o servidor (`{"mcp":{"memtier":false}}`)
não é reconhecida como override (só `object` conta). O plugin **registra mesmo assim**.
Paradoxalmente, `"memtier": []` (array) bloqueia, mas `false` não — inconsistente.

**Reprodução:**
```
$ node -e "...getKiloMcpOverride..."
value false -> undefined    # plugin registrará
value null  -> undefined
value []    -> []           # bloqueia (inconsistente)
```

### Defeitos de verificação (cobertura) — CONFIRMADO

**D-11 · `scheduleMcpRegistration` (caminho background) sem teste.** `src/mcp/register.ts:206-213`
não é exercitado por nenhum teste:
```
$ grep -rn "scheduleMcpRegistration" tests/   -> exit 1 (0 hits)
```
O contrato FR-601/FR-604 "dispara em background, nunca bloqueia, nunca fatal" não tem prova.

**D-12 · Critério de aceite "registro implícito provado" sem caso negativo.** O E2E só cria
diretório **sem** `kilo.jsonc` (`tests/e2e/test_e2e_mcp.test.ts:128-167`); não existe E2E
provando que, **com** `mcp.memtier` no `kilo.jsonc`, o plugin **não** registra (FR-602
ponta-a-ponta). O unit cobre (`tests/mcp.test.ts:168/180/190`), o E2E não.

**D-13 · `timeout`/`enabled` nunca assertados no corpo do `add`.** `buildMcpConfig` seta
`timeout: cfg.timeout_ms` e `enabled: true` (`src/mcp/register.ts:111-112`), mas nenhum
teste asserta esses campos:
```
$ grep -n "assert.*timeout" tests/mcp.test.ts tests/e2e/test_e2e_mcp.test.ts -> 0
```
Trocar `timeout_ms` por um valor errado não quebra teste algum.

---

## RISCOS

Itens que podem dar errado mas que **não** consegui provar (ou cujo efeito depende de
comportamento de um Kilo real que não está nesta máquina).

- **R-1 (SUSPEITA) · `headers` de MCP remoto aceito pelo SDK mas não provado em runtime.**
  Confirmei que o tipo do SDK **aceita** headers (`node_modules/@kilocode/sdk/dist/gen/types.gen.d.ts:1000`,
  `McpRemoteConfig.headers?: { [k: string]: string }`) — o contrato #5 é tipicamente válido.
  Mas o E2E usa `spyMcp` (fake) + `fetch` cru ao `/v1/mcp`; nenhum teste exercita o
  `client.mcp.add` **real** do Kilo aceitando o header. Se um Kilo real ignorar/rejeitar
  `headers` em remote, o E2E continuaria verde e as tools responderiam 401 em produção.

- **R-2 (SUSPEITA) · O E2E não prova o wiring de `src/index.ts`.** O `spyMcp` é injetado
  direto; `src/index.ts:92` (`scheduleMcpRegistration(ctx.client, ...)`) não é validado
  ponta-a-ponta (nem o `directory`/`timeout_ms` que ele passa). Erro de fiação em
  `index.ts` não aparece no E2E — só um teste de integração do boot com um `client.mcp`
  espião capturaria. Não medi (exigiria alterar `index.ts`, fora do escopo read-only).

- **R-3 (SUSPEITA) · Comentário de bloco não terminado tem tratamento inconsistente.**
  `stripJsoncComments` (`src/mcp/kilo-config.ts:56-60`), quando `/*` não fecha:
  ```
  '{"mcp":{"memtier":{...}}} /* unterminated'  -> stripped OK, parse OK (override respeitado)
  '{"a":1, /* unterminated '                    -> parse falha (override perdido)
  ```
  Um arquivo mal-formado pode tanto mascarar quanto derrubar o override, dependendo do
  ponto. Baixa probabilidade, mas é comportamento indefinido.

- **R-4 (SUSPEITA) · `buildMcpConfig` duplica o sufixo se a base já for `…/v1/mcp`.**
  `base + "/v1/mcp"` → `…/v1/mcp/v1/mcp`. Não há dedup. Só ocorre se `daemon.url` já vier
  com o path do MCP (configuração atípica). Reproduzido isoladamente:
  `buildMcpConfig({url:"http://127.0.0.1:8400/v1/mcp",...}).url === "http://127.0.0.1:8400/v1/mcp/v1/mcp"`.

- **R-5 (SUSPEITA) · Host preservado sem normalização** (`http://EXAMPLE.COM:8400/v1/mcp`).
  Se a borda for case-sensitive na validação de origem/escopo do token, um host maiúsculo
  pode não casar. Não medi contra a borda (ela normalmente é case-insensitive).

---

## NAO-PROVADO

- **N-1 — Conexão MCP end-to-end por um Kilo REAL.** Não há um Kilo de verdade nesta
  máquina para provar que ele conecta um MCP remoto com header e expõe as 4 tools ao
  modelo. O que foi provado é: o `McpRemoteConfig` que o plugin produz conecta no
  `/v1/mcp` real (fetch JSON-RPC direto) e as 4 tools listam / `recall`+`code_search`
  respondem `isError:false`. Para medir de verdade faltaria: instância Kilo com o plugin
  carregado e `client.mcp.status` consultado por um cliente real.
- **N-2 — `scheduleMcpRegistration` não bloqueia o boot.** Não cronometrei o boot vs. o
  registro em background (o BACKLOG cita 41ms de boot na E3a, não na E3b). Para medir:
  instrumentar `pluginModule.server(...)` com timing do retorno e do `add`.
- **N-3 — Comportamento sob `KILOCODE_GRAPH_TOKEN` simultâneo a `E2E_TOKEN`.** Medi que o
  `client.resolveToken()` (env > arquivo) faz o header do MCP divergir do `E2E_TOKEN` do
  teste quando ambos estão setados (o E2E cai: `not ok 1`, `pass 1/fail 1`). Não consegui
  determinar qual é o comportamento *desejado* do contrato nesse cenário — apenas que a
  documentação do E2E não cobre essa interação.
- **N-4 — Cobertura de linha real vs. aparente.** Não rodei `c8`/`nyc`; a avaliação de
  cobertura é por inspeção (grep) e por experimentos de falsificação, não por métrica.
  Para medir: `node --test --experimental-test-coverage tests/mcp.test.ts`.

---

## VEREDITO

O E3b entrega o caminho feliz (registro `remote` das 4 tools num workspace bem-formado),
mas o **comando E2E documentado é vermelho** e a suíte de fechamento **não honra os dois
tokens** que a própria epic exige, passando por fallback silencioso. A idempotência
(FR-602, contrato #3) tem **duas brechas reproduzíveis** (vírgula final; precedência de
`kilo.jsonc`), e a máquina de estados deixa o MCP **morto e silencioso** em estados
comuns (`disabled`/`connecting`) — regressão face ao antecessor. Não é regressão de boot,
mas o "verde" declarado no fechamento não se sustenta: **o épico precisa reabrir** para
corrigir D-1..D-7 e cobrir D-11..D-13 antes de ser considerado fechado.

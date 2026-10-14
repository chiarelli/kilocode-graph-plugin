# E1 — Fundação (cliente do memtier): plano de stories (decomposição, não implementação)

**Data:** 2026-10-14

**Fonte:** `BACKLOG.md § E1` · `docs/ARCHITECTURE.md` §2 (contrato), §3
(componentes), §6 (config), §8 (degradação) · `docs/PRD.md` FR-301/302/303/306/107/108,
NFR-01/03/04/05/06 · `docs/adr/001` (trocar provider mantendo hooks), `005`
(plugin é o coletor), `006` (push vs pull) · `src/README.md` (contratos
`client.ts`, `workspace.ts`) · antecessor `~/.config/kilo/vendor/openviking-memory.js`
(`resolvePluginWorkspace`, `loadConfig`, registro de hooks, `VikingClient`) ·
memtier `src/memtier/main.py` (rotas e bodies reais) · `deploy/docker-compose.yml`.

**Protocolo:** tracer bullet — E1-S1 é a fatia vertical mínima: `GET /v1/health`
atravessando `plugin carrega → config carrega → workspace resolve → client
chama → memtier responde`, com código de produção desde a fatia 1. S2/S3
**endurecem a mesma base, sem rewrite**; todo gap deixado minimal é marcado com
`TODO(tracer-bullet): <o que falta>`. A epic só fecha quando
`rg "TODO\(tracer-bullet\)" src/` retorna zero matches.

**Ordem de execução:** E1-S1 → E1-S2 → E1-S3 (cadeia linear).

**Ambiente de dev:** `bun run typecheck` (`tsc --noEmit`) · `bun test` ou
`node --test tests/` · E2E gated: `E2E=1` (stack do memtier de pé em
`127.0.0.1:8400`).

---

## Decisões de design fixadas nesta decomposição

Estas decisões são **contrato das stories**; mudá-las exige registrar o porquê no
commit.

### 1. Forma do plugin: `server` com hooks (padrão do antecessor)

O antecessor exporta `export default { id, server: plugin }` onde `plugin` é
`async (ctx, options) => ({ "hook.name": async (...) => {...}, dispose })`
(`openviking-memory.js:1896` e `:2112`). **Adotar essa forma exatamente.** O
`ctx` traz `{ client, directory, worktree }`; `options` traz os overrides do
`kilo.jsonc` (`plugin: [[path, { ... }]]`).

```ts
// src/index.ts
export default { id: "kilocode-graph-plugin", server: plugin };
```

- **Não** inventar um segundo formato. O Kilo carrega o arquivo apontado em
  `plugin[]`; a superfície de hooks é a do antecessor (validada em produção).
- O `dispose` existe e deve ser implementado (drena/limpa estado) — na E1 é
  mínimo (log), marcado `TODO(tracer-bullet)`.

### 2. Config: `plugin.yaml` + env, com precedência env > arquivo > default

O PRD/ARCH dizem `plugin.yaml`, mas o antecessor usa **JSON** (`openviking.json`,
lido de `~/.config/kilo/` e `<cwd>/.kilo/` — `openviking-memory.js:79`). Decisão:

- **Nome do arquivo:** `.kilo/graph-plugin.json` (por workspace) e
  `~/.config/kilo/graph-plugin.json` (global). O ARCH diz "plugin.yaml"; na
  prática o ecossistema Kilo usa JSON no `.kilo/`. **Fixamos JSON** e ajustamos o
  ARCH no fechamento (S3) — ou o implementador adota `yaml` com dependência
  extra, mas o default é JSON para não puxar parser.
- **Precedência:** `options` (do `kilo.jsonc`) > env var > arquivo > default —
  idêntico ao `resolveOverride` do antecessor (`:93`).
- **Nada hardcoded** (FR-303): todo default vive em `DEFAULTS` no `config.ts`.

Chaves (todas com env `KILOCODE_GRAPH_*`):

| Chave config | Env var | Default | Uso |
|---|---|---|---|
| `daemon.url` | `KILOCODE_GRAPH_URL` | `http://127.0.0.1:8400` | base do memtier |
| `daemon.token_file` | `KILOCODE_GRAPH_TOKEN_FILE` | `.kilo/graph-key.json` | bearer por workspace |
| `daemon.program` | `KILOCODE_GRAPH_PROGRAM` | `default` | E11 |
| `inject.enabled` | `KILOCODE_GRAPH_INJECT_ENABLED` | `false` | desligado por padrão |
| `inject.timeout_ms` | `KILOCODE_GRAPH_INJECT_TIMEOUT_MS` | `4000` | orçamento do hook |
| `code_index.enabled` | `KILOCODE_GRAPH_INDEX_ENABLED` | `false` | desligado por padrão |
| `code_index.indexer_bin` | `KILOCODE_GRAPH_INDEXER_BIN` | `""` | caminho do binário (FR-306) |
| `mcp.enabled` | `KILOCODE_GRAPH_MCP_ENABLED` | `true` | E3b |
| `mcp.name` | `KILOCODE_GRAPH_MCP_NAME` | `memtier` | E3b |
| `debug` | `KILOCODE_GRAPH_DEBUG` | `false` | log verboso |

> E1 só **lê** as chaves de `daemon.*` e `debug`; as demais são declaradas com
> default e lidas pela epic dona (E2/E3a/E3b). Declarar todas evita churn de
> config entre epics.

### 3. `token_file` — formato e resolução

O antecessor grava `openviking-key.json` por workspace com
`{user_key, account, user, project_id}`. O memtier usa **bearer** (E11). Formato
fixado:

```jsonc
// .kilo/graph-key.json  (NUNCA commitado — .gitignore já cobre *-key.json)
{ "token": "<bearer show-once>", "workspace": "waweb", "program": "default" }
```

- **Precedência do token:** `KILOCODE_GRAPH_TOKEN` (env) > `token_file` >
  ausente (⇒ 401 do memtier; o plugin **não** inventa token).
- O arquivo é lido **na primeira necessidade** (lazy) e cacheado; ausente não é
  erro fatal — a borda responde 401 e o plugin degrada (FR-305/NFR-03).
- **Nunca** logar o token; em log, só `SET(len=N)` como o antecessor (`:1898`).

### 4. `workspace.ts` — dir → nome lógico

Reuso de `resolvePluginWorkspace` (`openviking-memory.js:27`): `ctx.worktree` >
`ctx.directory` > `process.cwd()`; descarta `"/"`.

O **nome lógico** do workspace deve casar com o charset da borda
(`^[a-z0-9][a-z0-9_-]{0,63}$`, sem `--` — `config.py:129`). Decisão:

- derivar de `basename(dir)` normalizado (lowercase, não-`[a-z0-9_-]` → `-`,
  colapso de `-`, trim) e **truncar a 64**;
- se o resultado for vazio ou reservado (`_iam`), usar fallback estável
  `ws-<hash curto do caminho>` (sha1 hex, 8 chars);
- **o mesmo dir ⇒ o mesmo nome** (determinístico); o mapeamento é logado no boot.

> Não usar o hash **cru** como nome (o antecessor usa `hashDir` para `project_id`,
> que é outro conceito). Aqui o nome precisa ser legível e válido na borda.

### 5. `client.ts` — contrato HTTP mínimo da E1

A E1 implementa só o necessário para o tracer + o que as próximas epics
consomem, **sem** adiantar recall/sync/ingest (esses entram na epic dona). O que
a E1 entrega:

```ts
interface MemtierClient {
  health(signal?: AbortSignal): Promise<HealthReport>   // GET /v1/health
}
```

- **Auth:** header `Authorization: Bearer <token>` quando houver token.
- **Timeout:** `AbortSignal.timeout(ms)` por request; default do health = 2000ms.
- **Erros tipados:** `HealthReport` é sempre retornado (ok ou degradado); falha
  de rede/timeout vira `HealthReport { ok: false, reason }` — **nunca** lança no
  caminho de degradação (NFR-03).
- `HealthReport` espelha o body do memtier (`main.py:1743`):
  `{ status, falkordb, indices, error }` + `ok: boolean` derivado de `status==="ok"`.
- **Injeção de dependência:** o client recebe um `fetch` (default `globalThis.fetch`)
  para permitir stub em teste unitário (nada de rede real em unit).

### 6. Módulos da E1 e fronteira

```
src/
├── index.ts        # export default { id, server }; registra hooks (E1: só boot+dispose)
├── config.ts       # DEFAULTS + loadConfig(options) + resolveOverride
├── workspace.ts    # resolveWorkspaceDir(ctx) + workspaceName(dir)
├── client.ts       # MemtierClient (health nesta fatia) + tipos
├── logger.ts       # log/logFatal com prefixo e flag debug (reuso do antecessor)
└── types.ts        # tipos compartilhados (HealthReport, PluginCtx, Config)
```

- `index.ts` **não** contém lógica: monta config, resolve workspace, cria client,
  registra hooks (na E1, nenhum hook de conteúdo — só o `dispose` e um log de
  boot). Os hooks de conteúdo chegam em E2/E3a/E3b.
- `logger.ts` é reuso direto do padrão do antecessor (`log`/`logFatal`).

### 7. Testes sem rede

- `client.ts` testado com `fetch` injetado (stub que devolve 200/503/timeout).
- `workspace.ts` testado com strings de caminho (puro).
- `config.ts` testado com `options`/env explícitos (puro; nunca ler env global no
  teste sem restaurar).
- Nenhum teste unitário abre socket. O E2E (S3) é o único que fala com o memtier.

---

## E1-S1 — Tracer bullet: `GET /v1/health` atravessando até o memtier

**Objetivo:** a fatia vertical mínima. O plugin carrega, resolve o workspace,
monta o client e faz um health check real contra o memtier.

**Entregável:**
- `src/index.ts` — `export default { id, server }`; no boot: carrega config,
  resolve workspace, cria client, loga `workspace=<nome> url=<url>` e chama
  `health()` (resultado no log; nunca lança).
- `src/config.ts` — `loadConfig(options)` + `resolveOverride` + `DEFAULTS`
  (só as chaves usadas na E1 ativas; as demais declaradas com default).
- `src/workspace.ts` — `resolveWorkspaceDir(ctx)` + `workspaceName(dir)`.
- `src/client.ts` — `MemtierClient` com `health()` (fetch injetável, timeout).
- `src/logger.ts`, `src/types.ts`.

**Minimal (marcar `TODO(tracer-bullet)`):** tratamento de erro detalhado do
health; retry; leitura de `token_file` (na S1 o token pode vir só de env); o
`dispose` de verdade.

**Testes (unit):**

| Teste | Caso | Esperado |
|---|---|---|
| `config_defaults` | sem env/options | url `127.0.0.1:8400`, timeout 4000, `inject.enabled=false` |
| `config_precedence` | env + options | options > env > default |
| `workspace_name_valid` | `/home/u/waweb` | `waweb` (casa o charset da borda) |
| `workspace_name_sanitized` | `My Project!` | `my-project` |
| `workspace_name_reserved` | dir que resolve `_iam` | fallback `ws-<hash>` |
| `workspace_dir_priority` | `ctx.worktree` setado | usa worktree, não directory |
| `health_ok` | fetch → 200 `{status:"ok"}` | `{ok:true, status:"ok"}` |
| `health_degraded` | fetch → 503 `{status:"degraded"}` | `{ok:false, status:"degraded"}` |
| `health_network_error` | fetch lança | `{ok:false, reason:...}`, **não lança** |
| `health_timeout` | fetch pendura | aborta no timeout, `{ok:false}` |

**Critérios de aceite:** `bun run typecheck` limpo; os 10 testes verdes; boot
loga workspace e resultado do health sem exceção.

---

## E1-S2 — Endurecer: timeout, degradação, token, `program`

**Objetivo:** transformar o tracer em fundação sólida, sobre o **mesmo código**.

**Entregável:**
- `client.ts`: `token_file` lido lazy + cacheado; `program` embutido nos bodies
  futuros (a E1 só expõe o helper `resolveIdentity()`); timeout configurável;
  mapeamento de erro HTTP → erro tipado (`401/403/503` reconhecíveis).
- `config.ts`: validação de tipos (número/booleano), defaults completos,
  `token_file` e `program`.
- `workspace.ts`: fallback por hash determinístico testado; colisão improvável
  documentada.

**Testes (unit) — adicionais:**

| Teste | Caso | Esperado |
|---|---|---|
| `token_from_env` | env setado | header `Authorization: Bearer ...` |
| `token_from_file` | `token_file` válido | header correto; arquivo cacheado (1 leitura) |
| `token_absent` | sem env nem arquivo | sem header; request sai (borda decide 401) |
| `token_never_logged` | log em debug | token **não** aparece no output |
| `http_401_typed` | fetch → 401 | erro tipado `AuthError`, não exceção crua |
| `http_503_typed` | fetch → 503 | erro tipado `InfraError` |
| `program_in_identity` | `program=custom` | `resolveIdentity()` devolve `{workspace, program}` |
| `invalid_config_type` | `timeout_ms:"abc"` | default aplicado (ou erro claro), nunca `NaN` silencioso |

**Critérios de aceite:** testes de S1 continuam verdes; novos verdes; nenhum
token em log (verificado por teste).

---

## E1-S3 — Fechamento da epic

**Objetivo:** fechar E1 com E2E real e zero marcadores.

**Entregável:**
- `tests/e2e/test_e2e_health.ts` (**novo**, gated `E2E=1`): plugin boota com um
  `token_file` real → `health()` contra o memtier de pé → `ok:true`.
- Ajustar `docs/ARCHITECTURE.md` §6 se a decisão de **JSON** vs YAML (decisão 2)
  divergir do texto atual.
- Remover todos os `TODO(tracer-bullet)`.

**Critérios de aceite:**
1. `bun run typecheck` limpo.
2. `node --test tests/` verde (unit).
3. `E2E=1` verde com a stack do memtier de pé.
4. `rg "TODO\(tracer-bullet\)" src/` → zero.
5. README/ARCH alinhados com a config real.

**Comandos de verificação:**
```bash
cd /home/hermes/Projetos/kilocode-graph-plugin
bun run typecheck
node --test tests/
# E2E (stack de pé):
E2E=1 node --test tests/e2e/
curl -s localhost:8400/v1/health   # sanidade da stack
```

---

## Fora de escopo da E1

- Qualquer hook de conteúdo (injeção E2, ingestão E4, coleta E3a, MCP E3b).
- `recall`/`code_search`/`sync`/`ingest` no client (cada epic dona adiciona).
- Retry sofisticado/backoff (a degradação é "segue sem contexto", não retry).
- Empacotamento/publicação (build `dist/`) — só quando houver hook de produção.

## Histórico de revisão

- **2026-10-14** — criada a partir do PRD/ARCH v0.2 e do BACKLOG § E1. Formato
  espelha `../graphiti-daemon/specs/e5-stories.md`.

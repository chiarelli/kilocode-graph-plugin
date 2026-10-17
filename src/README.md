# kilocode-graph-plugin — src

Estado: **E1 (fundação), E2 (injeção de memória), E3a (coletor de código), E3b
(registro do MCP), E3c (injeção de código) e E4 (ingestão assíncrona)
implementadas**. Além delas, o plugin ganhou duas capacidades novas (sem número
de epic): **provisionamento do workspace memtier 1:1** (`provision.ts`) e
**escopo por workspace no boot** (config e `kilo.db` lidos do workspace
resolvido no runtime, nunca de `process.cwd()`). A segunda onda (E5–E7) ainda é
forma e contratos. O que existe hoje em `src/` é `index.ts`, `config.ts`,
`provision.ts`, `client.ts`, `workspace.ts`, `logger.ts`, `types.ts`,
`hooks/{messages,collect,ingest}.ts`, `inject/{memory,code,budget}.ts`,
`index/{runner,collector,edges,manifest,trigger}.ts`,
`ingest/{db,batch,state,routine}.ts` e `mcp/{register,kilo-config}.ts`.

```
src/
├── index.ts              # registro dos hooks + INVOCA o CLI no boot (background) + instala hooks git + MCP + provisionamento
├── cli.ts                # ⬅ NOVO (E3a-S6) — CLI standalone: ÚNICO escritor do grafo (full+incremental)
├── cli-spawn.ts          # ⬅ NOVO (E3a-S6) — o boot spawna o CLI em `auto` (destacado, fire-and-forget)
├── token-file.ts         # ⬅ NOVO (E3a-S6) — resolve/confinamento do token_file (boot × CLI)
├── config.ts             # graph-plugin.json (do workspace) + env vars + estado persistido (graph-config.json)
├── provision.ts          # cria o workspace memtier 1:1 e grava .kilo/graph-key.json
├── client.ts             # HTTP client do memtier
├── workspace.ts          # diretório → nome lógico
├── inject/
│   ├── memory.ts
│   ├── code.ts
│   └── budget.ts
├── ingest/               # (E4) — a INGESTÃO (conteúdo vem do kilo.db)
│   ├── db.ts             # localiza o kilo.db; lê message+part; cursor (ts,id)
│   ├── batch.ts          # lote, hash djb2, reference_time, limiar
│   ├── state.ts          # .kilo/graph-ingest.json (hashes + cursor; atômico)
│   └── routine.ts        # a rotina única: lê, decide, envia; trava por sessão
├── index/                # (E3a) — o COLETOR (chamado pelo CLI)
│   ├── runner.ts         # spawn do rust_indexer; JSONL; pause/resume
│   ├── collector.ts      # eventos → files[]/edges[]
│   ├── edges.ts          # import/call → to_file/to_symbol_id (alvo existe?)
│   ├── manifest.ts       # estado por workspace → detecta removidos (chunks: []); tmp por processo
│   ├── trigger.ts        # híbrido: full no 1º uso; incremental depois + guarda de ancestralidade + sentinela
│   ├── git.ts            # ⬅ NOVO (E3a-S6) — porta de git (HEAD, ancestry, removidos, hooks dir)
│   ├── lock.ts           # ⬅ NOVO (E3a-S6) — trava cross-process: flock(2) sob Bun (kernel libera na morte) + fallback O_EXCL sob Node
│   └── install-hooks.ts  # ⬅ NOVO (E3a-S6) — instala os hooks git (idempotente, sem core.hooksPath)
├── mcp/                  # (E3b) — registro do MCP do memtier
│   ├── register.ts       # client.mcp.add(type:remote) + connect; implícito
│   └── kilo-config.ts    # lê kilo.jsonc (JSONC) → override (idempotência)
└── adapters/
    ├── kilo.ts           # referência
    ├── opencode.ts       # não validado
    └── claude.ts         # não validado
```

## Assinaturas esperadas

### `client.ts` (E1 + `recall` da E2 + `searchCode` da E3c + `syncCode` da E3a — implementado)
```ts
class MemtierClient {
  recall(query: string, opts?: { limit?; maxTokens?; signal? }): Promise<RecallResult>
  searchCode(query: string, opts?: { limit?; maxTokens?; signal? }): Promise<SearchCodeResult>  // ≤50; sem labels
  syncCode(files, edges?, signal?): Promise<SyncResult>  // pagina ≤100 arquivos, ≤5000 arestas
  health(signal?): Promise<HealthReport>   // nunca lança (NFR-03)
  // ingest entra com E4.
}
// identidade (`workspace`/`program`) vem do construtor; `max_tokens` é o
// orçamento A1 no servidor. Erros HTTP viram tipos (AuthError 401/403,
// InfraError 503) — o hook degrada, não propaga. `syncCode` faz fallback 422
// (reenvia sem arestas) e usa `sync_timeout_ms` (default 120000). `searchCode`
// fatia `limit` em 50 (MAX_SEARCH_LIMIT) e NUNCA envia `labels` (lista vazia é 422).
```

### `index/` (E3a — implementado; delta em runtime na E3a-S6)
```ts
runIndexer(opts): Promise<{ events; skipped; reason?; error? }>  // spawn + JSONL + ack/resume
buildSyncBody(events, identity, opts?): { workspace, program, files, edges }
resolveEdges(imports, calls, files): CodeEdge[]           // alvo E origem existem, senão descarta
loadManifest/saveManifest/removedFiles/mergeManifest      // estado por workspace (atômico); tmp por PID
decideTrigger(manifest, { isAncestor? }): { mode, gitRange? }  // full no 1º uso; incremental só se ancestral (§4)
shouldWaitForReady(decision, ready): boolean              // gate do sentinela `graph-ready` (§3)
createGitPort(exec?): GitPort   // HEAD/isAncestor/deletedFiles/hooksDir (injetável)
acquireLock({ path, … }): Promise<LockHandle|null>  // flock(2) sob Bun (kernel libera na morte; sem lock órfão) + fallback O_EXCL sob Node
installHooks({ repoRoot, cliPath, git, io? }): InstallHooksResult  // idempotente, sem core.hooksPath
// FullFile sintético quando o indexer só emitiu Symbol (habilita import_edge).
// Removidos: no FULL = manifest−present; no INCREMENTAL = git diff --no-renames --diff-filter=D.
// Config persistida (§7): `persistConfigState`/`loadConfigState` (sem segredos).
```

### `cli.ts` (E3a-S6 — implementado)
```ts
// node src/cli.ts --workspace <repo-root> --mode auto --source <boot|post-commit|…>
// CLI standalone: ÚNICO escritor do grafo. Resolve a MESMA config do boot (§7),
// guarda de sentinela + ancestralidade, trava cross-process; CHAMA `collectCode`.
// O boot o spawna em `auto` (destacado) — o plugin NÃO coleta (E3a-S6 §1b).
parseArgs(argv): CliArgs | { error }   // --workspace obrigatório
runCli(args, deps?): Promise<number>   // exit code; nunca lança
```

### `hooks/collect.ts` (E3a — implementado)
```ts
collectCode(rt): Promise<SyncResult|null>   // decide trigger, roda, monta body, sincroniza
// `rt.git` habilita guarda de ancestralidade + removidos no incremental; `rt.lockPath`
// serializa entre processos; `rt.ready` é o gate do sentinela; `rt.onFullComplete`
// arma o incremental. Nunca lança; degrada em indexer/sync fora do ar.
formatCollectLine({ source, mode, trigger, indexer_ms, files, edges, removed, sync? })
// Log de observabilidade (S6c): `collect source=… mode=… trigger=… indexer_ms=… files=…
// edges=… removed=… sync={upserted,deleted,changed,skipped}` (ou `sync=skipped reason=…`).
```

### `mcp/register.ts` + `mcp/kilo-config.ts` (E3b — implementado; endurecido no E3b-S4)
```ts
function buildMcpConfig(cfg): McpRemoteConfig   // puro: new URL("v1/mcp", base/) + header Bearer (token trim)
function isValidMcpName(name): boolean          // D-8: rejeita vazio, "/", "\", "..", espaço
async function registerMemtierMcp(client, cfg): Promise<void>  // status → (disconnect) → add → connect
function scheduleMcpRegistration(client, cfg): void            // background no boot (nunca bloqueia)
function isMcpDefinedInKiloConfig(dir, name): boolean          // FR-602: varre TODOS os arquivos; false/null/[] bloqueiam
function shouldRefreshMcpRegistration(existing): boolean       // D-6: refresh em QUALQUER estado != connected
function stripJsoncComments(raw): string                       // JSONC: remove comentários (respeita strings)
function stripTrailingCommas(raw): string                      // D-3: remove vírgula final (JSONC válido)
// Registro IMPLÍCITO no boot (o usuário não define nada em kilo.jsonc); se já
// definido lá — com qualquer valor, inclusive `false` — o plugin não registra
// por cima (idempotência) — FR-602.
// Degradação (FR-604): status/add/connect falhos viram log; o boot NUNCA quebra.
// `409`/already-exists do add é não-fatal (segue para o connect — D-7).
// Tool MCP `neighbors` NÃO existe no memtier (só recall/ingest/code_search/
// code_sync) — navegação não é prometida (ADR-006).
```

### `inject/budget.ts` (E2 + joint budget da E3c — implementado; ADR-009)
```ts
function applyBudget(facts: Fact[], cfg: Budget): Fact[]
// corta por fato INTEIRO: maxMemories (nº). O teto de VOLUME é do servidor
// (`max_tokens` por endpoint, ADR-009) — não há mais teto de chars no cliente.
function applyJointBudget(facts, chunks, cfg): { facts; chunks }
// E3c: aplica os tetos de CONTAGEM independentes por família (maxMemories /
// maxCodeChunks). O teto conjunto em chars morreu (ADR-009); corte por item
// inteiro, nunca pela metade.
```

### `inject/memory.ts` (E2 + prepare/commit da E3c — implementado)
```ts
function formatMemoryBlock(facts: Fact[]): string | null   // null ⇒ não injeta
async function recallAndFormat(client, cfg, query, signal?): Promise<string | null>
class MemoryInjector {                                    // dedup por turno (FR-104)
  inject(query): Promise<InjectionResult | null>          // { block, facts, chars, recallMs }
  prepare(turnoId, query): Promise<MemoryPrep | null>     // E3c: sem commit (paralelismo)
  commit(prep, facts): InjectionResult | null             // E3c: dedup + formatação
}
// observabilidade do turno (base E7): loga `inject recall_ms=… facts=… injected_chars=…`
```

### `inject/code.ts` (E3c — implementado)
```ts
function formatCodeBlock(chunks: CodeChunkHit[]): string | null  // null ⇒ não injeta
function chunkIdentity(chunk): string                     // `path:start-end` (sem chunk_md5)
async function searchAndFormat(client, cfg, query, signal?): Promise<string | null>
class CodeInjector {                                      // dedup por turno (mesmo turnoId da memória)
  prepare(turnoId, query): Promise<CodePrep | null>       // busca + dedup, sem commit
  commit(prep, chunks): CodeInjectionResult | null        // formata o bloco `graph-code`
}
// sentinela própria `graph-code` (distinta de `graph-memory`); procedência por
// chunk `[CÓDIGO RELEVANTE — path:ini-fim]`; sanitiza `<`/`>` preservando
// quebras de linha/indentação. Nunca busca com `limit:0` (422 no servidor).
```

### `hooks/messages.ts` (E2 + E3c — implementado)
```ts
function messagesHook(rt: InjectRuntime): { "experimental.chat.messages.transform": fn }
// thin: liga o transform do Kilo aos dois injetores; nunca lança (NFR-03).
async function injectContextIntoMessages(messages, rt): Promise<void>
// E3c: memória e código em PARALELO (Promise.allSettled, cada um com seu
// AbortSignal); orçamento de CONTAGEM por família (`applyJointBudget`:
// maxMemories/maxCodeChunks — ADR-009, sem teto conjunto em chars); memória
// ANTES do código; um bloco de cada família por turno. Código desligado
// ⇒ delega ao caminho E2.
```

### `ingest/` (E4 — implementado)
```ts
// db.ts — fonte de verdade (o evento NUNCA carrega conteúdo, ADR-007).
resolveRuntimeDbPath(env?): string  // <Path.data>/kilo.db do runtime (síncrono)
//   o caminho segue a REGRA DO RUNTIME: Path.data = XDG_DATA_HOME ?? ~/.local/share
//   + `/kilo`; regra `KILO_DB` (absoluto/`:memory:`/relativo). O plugin roda
//   in-process e herda `process.env`. NUNCA deriva de `Path.state` (o banco vive
//   em DATA, e `/path` só expõe `state`). Sem I/O: não bloqueia o boot.
readBatch(backend, sessionId, cursor, limit, onPoison?): ReadBatch
//   cursor = { last_ts, last_id } — (time_created, id), SEM OFFSET (ADR-008);
//   lança `IngestReadError` em falha transitória (não avança o cursor).

// batch.ts — puro.
buildBatch(messages): { body, hash, referenceTime }  // reference_time = msg + atual
batchHash(messages): string                          // djb2 role\0content
shouldSend(rows, batchSize): boolean                 // limiar por LINHAS

// state.ts — .kilo/graph-ingest.json (write+rename atômico).
loadState(path, readFile?, onReset?): IngestState     // L-3: reset é logado
markBatchSent(state, hash, maxHashes?)                // L-2: teto FIFO
markBatchAccepted(state, audit, maxHashes?)           // L-1: aceite ≠ confirmação

// routine.ts — a rotina única.
ingestOnce(rt, backend, sessionId, drainAll?): IngestOutcome
runIngest(rt, backend, sessionId, drainAll?)          // trava por sessão; nunca lança
//   `drainAll=false` (message.updated): respeita o limiar.
//   `drainAll=true`  (session.idle):    drena tudo + o resto (pendentes==0).

// hooks/ingest.ts
function ingestHook(rt): { event, dispose }
//   os dois eventos acordam a MESMA rotina (o hook resolve `drainAll`) em
//   background; `dispose` fecha o handle do SQLite. Nunca bloqueia o turno.
```

### `provision.ts` (provisionamento do workspace 1:1 — implementado)
```ts
function hasUsableKey(keyFile, io?): boolean                  // há `token` não-vazio no key file
async function ensureWorkspaceKey(opts): Promise<ProvisionOutcome>
//   { provisioned, reason } — reason: disabled | exists | provisioned | failed
function writeKeyFile(opts, key): void                        // tmp+rename atômico, modo 0600
// Quando KILOCODE_GRAPH_MANAGER_TOKEN existe E a chave do workspace está ausente,
// cria o workspace memtier 1:1 no plano de controle e grava a chave do usuário:
//   POST /v1/mgmt/programs    (409 = já existe ⇒ segue)
//   POST /v1/mgmt/workspaces  (1:1 com o workspace Kilo; 200 idempotente)
//   POST /v1/mgmt/invites     (kind:"user", escopado ao par programa/workspace)
//   POST /v1/auth/claim-user  (bearer show-once; must_rotate=true)
//   POST /v1/auth/rotate      (OBRIGATÓRIO: sem rotacionar, o plano de dados
//                              devolve 403 `rotation_required`)
//   ⇒ grava { token, workspace, program } em <workspace>/.kilo/graph-key.json
// `ensureWorkspaceKey` NUNCA lança (NFR-03): falha vira log e o boot segue (a
// borda responde 401, como quando a chave está ausente). Roda só quando a chave
// está ausente — o boot normal (chave presente) não paga latência. Um único
// `AbortSignal.timeout` cobre os 5 requests (orçamento de parede do fluxo).
//
// Guardas de contrato:
// - **Só cria, nunca sobrescreve chave utilizável**: `hasUsableKey` (token
//   não-vazio) ⇒ `reason:"exists"`, sem rede e sem tocar o arquivo.
// - **keyFile vazio** ⇒ `failed` ANTES de qualquer request (não queima um bearer
//   show-once sem onde persistir).
// - **Concorrência (mesmo processo)**: trava por `keyFile` — o 2º chamador reusa
//   o resultado do 1º (um só fluxo de 5 passos, uma só gravação).
// - **Rotate que ecoa o claim** ⇒ `failed` (não persiste um bearer `must_rotate`).
// - **`.tmp` único por pid + `chmod 0600` explícito + limpeza**: sem `.tmp` órfão
//   com bearer vivo e sem corrida de truncamento entre boots.
```

### Nome do workspace (identidade 1:1 — implementado)

`workspaceName(dir)` = **`<stem>-<sha1 8 do caminho resolvido>`** — sempre com o
sufixo de hash. Ex.: `/home/u/kilocode-graph-plugin` ⇒
`kilocode-graph-plugin-<sha1 8>`. O `stem` vem do basename saneado ao charset da
borda (`^[a-z0-9][a-z0-9_-]{0,63}$`); basename vazio/reservado ⇒ `stem = "ws"`.

O sufixo **sempre presente** garante injetividade dir→workspace: dois diretórios
distintos nunca colidem, mesmo com basename idêntico (`/a/foo` vs `/b/foo`), com
saneamento *lossy* (símbolos/espaços) ou truncamento (basename >64). Determinístico
(o mesmo caminho sempre gera o mesmo nome); teto de 64 chars.

> **Por que um override.** O memtier escopa o bearer ao nome **EXATO** do
> workspace (medido: `alfa` ⇒ 200; `alfa-1a2b3c4d` ⇒ **403**). Como o derivado
> carrega o hash do caminho, quem tem token **pré-escopado** (E2E com tokens
> legados, migração de um binding existente) precisa pinar o nome via
> **`daemon.workspace`** (env `KILOCODE_GRAPH_WORKSPACE`). Setado, ele é usado
> **como veio** (sem hash) e vence o derivado; vazio (default) ⇒ deriva do `dir`.

### Escopo por workspace no boot (implementado)

O diretório do workspace vem do **runtime do Kilo** (`ctx.worktree` >
`ctx.directory` > cwd) e é a fonte de escopo mesmo com o plugin instalado
globalmente:

- o `.kilo/graph-plugin.json` do workspace é lido **desse** diretório
  (`loadConfig(options, dir)`), nunca de `process.cwd()` — que num plugin global
  aponta para o processo do Kilo, não para o projeto. O merge global↔workspace é
  **profundo** (chaves aninhadas não se anulam);
- o `token_file` é **confinado** ao workspace: um caminho absoluto fora do `dir`
  (ou com `../..`) é recusado e cai no default `.kilo/graph-key.json` — o
  provisionamento nunca escreve fora do workspace;
- o caminho do `kilo.db` segue a **regra do runtime do Kilo** (`resolveRuntimeDbPath`):
  `Path.data` = `XDG_DATA_HOME ?? ~/.local/share` + `/kilo`, com a regra `KILO_DB`.
  O plugin roda in-process, então usa o próprio `process.env` — NUNCA `Path.state`
  (o banco vive em DATA; `/path` só expõe `state`, cujo `<state>/kilo.db` não existe).

## Variáveis de ambiente

Toda env var do plugin é prefixada com `KILOCODE_GRAPH_` e lida em `config.ts`.
Precedência: `options` (do `kilo.jsonc`) > env var > arquivo JSON
(`.kilo/graph-plugin.json` mesclado sobre `~/.config/kilo/graph-plugin.json`) >
default. Em `options`, o placeholder `{env:VAR}` resolve a env var citada
(`config.ts:resolveOverride`).

| Chave de config | Env var | Default |
|---|---|---|
| `daemon.url` | `KILOCODE_GRAPH_URL` | `http://127.0.0.1:8400` |
| `daemon.token_file` | `KILOCODE_GRAPH_TOKEN_FILE` | `.kilo/graph-key.json` |
| `daemon.token` | `KILOCODE_GRAPH_TOKEN` | `""` (vazio — env vence o `token_file`) |
| `daemon.manager_token` | `KILOCODE_GRAPH_MANAGER_TOKEN` | `""` (vazio — provisionamento desligado) |
| `daemon.program` | `KILOCODE_GRAPH_PROGRAM` | `default` |
| `daemon.workspace` | `KILOCODE_GRAPH_WORKSPACE` | `""` (vazio — deriva `<stem>-<sha1 8>` do dir) |
| `daemon.health_timeout_ms` | `KILOCODE_GRAPH_HEALTH_TIMEOUT_MS` | `2000` |
| `inject.enabled` | `KILOCODE_GRAPH_INJECT_ENABLED` | `false` |
| `inject.max_memories` | `KILOCODE_GRAPH_INJECT_MAX_MEMORIES` | `5` |
| `inject.memory_max_tokens` | `KILOCODE_GRAPH_INJECT_MEMORY_MAX_TOKENS` | `2000` |
| `inject.code_max_tokens` | `KILOCODE_GRAPH_INJECT_CODE_MAX_TOKENS` | `2000` |
| `inject.timeout_ms` | `KILOCODE_GRAPH_INJECT_TIMEOUT_MS` | `4000` |
| `inject.code_enabled` | `KILOCODE_GRAPH_INJECT_CODE_ENABLED` | `false` |
| `inject.max_code_chunks` | `KILOCODE_GRAPH_INJECT_MAX_CODE_CHUNKS` | `3` |
| `code_index.enabled` | `KILOCODE_GRAPH_INDEX_ENABLED` | `false` |
| `code_index.indexer_bin` | `KILOCODE_GRAPH_INDEXER_BIN` | `""` (vazio — sem coletor) |
| `code_index.sync_timeout_ms` | `KILOCODE_GRAPH_INDEX_SYNC_TIMEOUT_MS` | `120000` |
| `code_index.load_ignores` | `KILOCODE_GRAPH_INDEX_LOAD_IGNORES` | `false` |
| `ingest.enabled` | `KILOCODE_GRAPH_INGEST_ENABLED` | `false` |
| `ingest.batch_size` | `KILOCODE_GRAPH_INGEST_BATCH_SIZE` | `20` |
| `ingest.max_hashes` | `KILOCODE_GRAPH_INGEST_MAX_HASHES` | `5000` |
| `ingest.timeout_ms` | `KILOCODE_GRAPH_INGEST_TIMEOUT_MS` | `15000` |
| `mcp.enabled` | `KILOCODE_GRAPH_MCP_ENABLED` | `true` |
| `mcp.name` | `KILOCODE_GRAPH_MCP_NAME` | `memtier` |
| `mcp.timeout_ms` | `KILOCODE_GRAPH_MCP_TIMEOUT_MS` | `15000` |
| `debug` | `KILOCODE_GRAPH_DEBUG` | `false` |

> **Com `debug=true`, o plugin espelha o contexto injetado.**
> `/tmp/kilocode-graph-plugin.log` é append-only (histórico); já
> `/tmp/kilocode-graph-plugin-inject.log` é **truncado a cada escrita** e mostra,
> em tempo real e em formato legível, o **raw** do que foi injetado no último
> turno (blocos de memória `graph-memory` e de código `graph-code`, com contagem
> de fatos/chunks e chars). Sem `debug`, o arquivo não é escrito.

Env vars fora do prefixo:

| Env var | Uso | Default |
|---|---|---|
| `XDG_CONFIG_HOME` | Base do config global (`<XDG_CONFIG_HOME>/kilo/graph-plugin.json`); ausente ⇒ `~/.config/kilo` | — |

> **Booleans/ints estritos.** `resolveBool` aceita só `"true"`/`"false"`;
> `resolveInt`/`resolvePositiveInt` rejeitam `NaN`/`≤0` — qualquer outro valor cai
> no default (nunca um modo degenerado silencioso).

## Regras

1. **O passo de injeção tem orçamento de 4s.** Recall mediano = 0,85s. Não
   adicionar trabalho pesado aí.
2. **A coleta de código é fora do turno.** Spawn do indexer + sync nunca no
   caminho crítico (FR-510).
3. **`reference_time` = data da mensagem MAIS ATUAL do lote**, não do envio
   (quebra supersessão).
4. **Ingestão nunca é await no caminho do turno** — 202 e segue.
5. **Nenhum valor hardcoded** — config via `.kilo/graph-plugin.json`/env (PRD FR-303).
6. **Defaults desligados** para indexação, injeção e ingestão (preferência do dono).
7. **Arquivo removido exige `chunks: []`** — o memtier não auto-deleta (FR-504).
   - Só o **FULL** detecta removidos (`removed=[]` no incremental); o FULL só
     ocorre no 1º uso do workspace. "Repo esvaziado" não é representável
     (`files` `min_length=1`). Limitação **aceita** — ver `RFC-001`.
8. **Aresta com alvo ausente é descartada** — senão 422 no lote inteiro.
9. **Escopo é o workspace resolvido no runtime**, nunca `process.cwd()` — config
   (`loadConfigFile`), `token_file` (confinado ao `dir`) e caminho do banco
   (`resolveRuntimeDbPath`) saem do `dir` do workspace; o plugin roda por
   workspace mesmo instalado globalmente.
10. **Provisionamento só cria, nunca sobrescreve chave utilizável.** Roda apenas
    com `KILOCODE_GRAPH_MANAGER_TOKEN` definido **e** a chave do workspace
    ausente/inválida; a chave resultante é a **rotacionada** (nunca a show-once do
    claim). Segredos (bearer do gestor, token do workspace) **nunca** vão para o log.

## Verificação (o que prova cada afirmação)

| Afirmação | Teste |
|---|---|
| Config do workspace vem do `dir` resolvido, não do cwd | `tests/config.test.ts` — `config_workspace_dir`, `config_workspace_dir_ignores_cwd` |
| Merge global↔workspace é profundo | `tests/config.test.ts` — `config_deep_merge*` (via `XDG_CONFIG_HOME`) |
| `token_file` é confinado ao workspace | `tests/token-file.test.ts` — `token_file_escape_relative`, `..._absolute_outside` |
| Provisionamento: 5 passos, bearer por rota, chave rotacionada | `tests/provision.test.ts` — `provision_happy` |
| **Só cria, nunca sobrescreve chave utilizável** | `tests/provision.test.ts` — `provision_exists` (sem rede, arquivo intacto); E2E `test_e2e_provision.test.ts` (2º boot) |
| Provisionamento não queima bearer sem onde persistir | `tests/provision.test.ts` — `provision_empty_keyfile` |
| Concorrência (mesmo processo) ⇒ um só fluxo | `tests/provision.test.ts` — `provision_concurrent_same_process` |
| Degradação: falha em cada passo ⇒ `failed`, nunca lança | `tests/provision.test.ts` — `provision_fail_*`, `provision_fail_network` |
| Token que aparece depois é usado (cache não fixa `""`) | `tests/client.test.ts` — `token_appears_later` |
| **E2E real do provisionamento** (boot → cria → grava → chave autentica) | `tests/e2e/test_e2e_provision.test.ts` (gated `E2E=1` + `E2E_MANAGER_TOKEN`) |
| `workspaceName` = `<stem>-<sha1 8>` (sempre) e injetivo | `tests/workspace.test.ts` — `..._always_hashed`, `..._basename_collision`, `..._truncation_collision`, `..._sanitize_collision` |
| `daemon.workspace` pina a identidade (override do derivado) | `tests/config.test.ts` — `config_workspace_override`; E2E que pinam `alfa`/`beta`/`kilocode-graph-plugin` |
| **Teto de tokens por endpoint** (`memory_max_tokens`/`code_max_tokens`) corta cada bloco de forma independente | `tests/code_s2.test.ts` — `code_body_uses_code_tokens`, `endpoints_independent`; E2E `tests/e2e/test_e2e_inject_limits.test.ts` (gated `E2E=1`) |
| Envs de limite legadas ⇒ **um** aviso de depreciação (nunca silêncio) | `tests/config.test.ts` — casos `config_legacy_*_warns` e `config_no_legacy_no_warning` |
| Teto fora de `[1,16000]` (422 no servidor) cai no default | `tests/config.test.ts` — `config_token_cap_clamped` |
| Erro HTTP com body de MB não vira `message` gigante (UI) | `tests/client.test.ts` — `httpError_caps_detail`, `extractHttpDetail_never_exceeds_cap`; `tests/provision.test.ts` — `provision_error_body_bounded` |
| Linha de log nunca excede o teto (nem `log`/`debug`, nem o `console.error` do fatal) | `tests/logger.test.ts` — `logFatal_respects_cap_exactly`, `logFatal_console_leg_bounded`, `log_caps_direct_giant` |
| Chunk (`FullFile`/`Symbol`) acima do teto é truncado com marca | `tests/collector.test.ts` — `fullfile_truncation`, `symbol_truncation` |
| Erro fatal do indexer (`GIT_UNAVAILABLE`) **não** apaga o grafo | `tests/collect.test.ts` — `collect_job_error_aborts`, `collect_job_error_skips_removed`; `tests/runner.test.ts` — `jobErrorFromEvent_*`, `runIndexer_error_event`, `runIndexer_error_no_completed`, `runIndexer_recoverable_error` |
| `code_index.load_ignores` propaga ao indexer | `tests/runner.test.ts` — `build_command_load_ignores*`; `tests/collect.test.ts` — `collect_load_ignores*` |
| Fonte do `kilo.db` = regra do runtime (não `Path.state`) | `tests/ingest.test.ts` — `db_runtime_path*`, `db_runtime_path_xdg_relative_ignored` |

> **Limitação conhecida:** dois diretórios com o MESMO basename válido (ex.: dois
> checkouts chamados `foo`) mapeiam para o mesmo workspace memtier — desambiguar
> exigiria hash em todo nome, o que quebraria o binding já provisionado (o
> `graph-key.json` real usa o basename). Pinado em
> `tests/workspace.test.ts:workspace_name_basename_collision_KNOWN_LIMITATION`.

## Reuso do plugin OpenViking

Referência: `~/.config/kilo/vendor/openviking-memory.js` (2112 linhas).
Reaproveitar: `resolvePluginWorkspace`, `loadConfig`, registro de hooks,
`appendContextPart`, estado de ingestão por batch, **`registerOpenVikingMcp`**
(registro de MCP — vira `type:"remote"`).
Trocar: cliente (OV → memtier) e conteúdo injetado (memória → memória + código).

## Referência para o coletor

Probe validado (portar para `index/`): `~/spikes/010-navegabilidade-codigo/probe_e2e_lifecycle.py`
— `montar_body`, resolução de módulo Rust (`resolve_module`), materialização de
`FullFile` e o ciclo de vida (cresce/encolhe/deleta). É probe-grade, não produção.

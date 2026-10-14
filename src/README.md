# kilocode-graph-plugin — src

Estado: **E1 (fundação), E2 (injeção de memória), E3a (coletor de código) e E3b
(registro do MCP) implementadas**; a segunda onda ainda é forma e contratos. O
mapa abaixo é o alvo; o que existe hoje em `src/` é `index.ts`, `config.ts`,
`client.ts`, `workspace.ts`, `logger.ts`, `types.ts`, `hooks/{messages,collect}.ts`,
`inject/{memory,budget}.ts`, `index/{runner,collector,edges,manifest,trigger}.ts`
e `mcp/{register,kilo-config}.ts`.

```
src/
├── index.ts              # registro dos 4 hooks + disparo do coletor + registro MCP
├── config.ts             # graph-plugin.json + env vars
├── client.ts             # HTTP client do memtier
├── workspace.ts          # diretório → nome lógico
├── inject/
│   ├── memory.ts
│   ├── code.ts
│   └── budget.ts
├── ingest/
│   ├── capture.ts
│   └── debounce.ts
├── index/                # ⬅ NOVO (E3a) — o COLETOR
│   ├── runner.ts         # spawn do rust_indexer; JSONL; pause/resume
│   ├── collector.ts      # eventos → files[]/edges[]
│   ├── edges.ts          # import/call → to_file/to_symbol_id (alvo existe?)
│   ├── manifest.ts       # estado por workspace → detecta removidos (chunks: [])
│   └── trigger.ts        # híbrido: full no 1º uso; incremental depois
├── mcp/                  # ⬅ NOVO (E3b) — registro do MCP do memtier
│   ├── register.ts       # client.mcp.add(type:remote) + connect; implícito
│   └── kilo-config.ts    # lê kilo.jsonc (JSONC) → override (idempotência)
└── adapters/
    ├── kilo.ts           # referência
    ├── opencode.ts       # não validado
    └── claude.ts         # não validado
```

## Assinaturas esperadas

### `client.ts` (E1 + `recall` da E2 + `syncCode` da E3a — implementado)
```ts
class MemtierClient {
  recall(query: string, opts?: { limit?; maxTokens?; signal? }): Promise<RecallResult>
  syncCode(files, edges?, signal?): Promise<SyncResult>  // pagina ≤100 arquivos, ≤5000 arestas
  health(signal?): Promise<HealthReport>   // nunca lança (NFR-03)
  // searchCode/ingest entram com E3c/E4.
}
// identidade (`workspace`/`program`) vem do construtor; `max_tokens` é o
// orçamento A1 no servidor. Erros HTTP viram tipos (AuthError 401/403,
// InfraError 503) — o hook degrada, não propaga. `syncCode` faz fallback 422
// (reenvia sem arestas) e usa `sync_timeout_ms` (default 120000).
```

### `index/` (E3a — implementado)
```ts
runIndexer(opts): Promise<{ events; skipped; reason? }>  // spawn + JSONL + ack/resume
buildSyncBody(events, identity, opts?): { workspace, program, files, edges }
resolveEdges(imports, calls, files): CodeEdge[]           // alvo E origem existem, senão descarta
loadManifest/saveManifest/removedFiles/mergeManifest      // estado por workspace (atômico)
decideTrigger(manifest): { mode, gitRange? }              // full no 1º uso; incremental depois
// FullFile sintético quando o indexer só emitiu Symbol (habilita import_edge).
// Removidos (`chunks: []`) só no FULL (o incremental só traz os alterados).
```

### `hooks/collect.ts` (E3a — implementado)
```ts
collectHook(rt): { boot: Promise<void> }   // dispara no boot, fora do turno (FR-510)
// nunca lança; degrada em indexer/sync fora do ar. Log de observabilidade:
// `collect indexer_ms=… files=… edges=… removed=… sync={…}`.
```

### `mcp/register.ts` + `mcp/kilo-config.ts` (E3b — implementado)
```ts
function buildMcpConfig(cfg): McpRemoteConfig   // puro: url …/v1/mcp + header Bearer
async function registerMemtierMcp(client, cfg): Promise<void>  // status → add → connect
function scheduleMcpRegistration(client, cfg): void            // background no boot
function getKiloMcpOverride(dir, name): entry | undefined       // idempotência (FR-602)
function shouldRefreshMcpRegistration(existing): boolean        // failed/ENOENT ⇒ refresh
// Registro IMPLÍCITO no boot (o usuário não define nada em kilo.jsonc); se já
// definido lá, o plugin não registra por cima (idempotência) — FR-602.
// Degradação (FR-604): status/add/connect falhos viram log; o boot NUNCA quebra.
// Tool MCP `neighbors` NÃO existe no memtier (só recall/ingest/code_search/
// code_sync) — navegação não é prometida (ADR-006).
```

### `inject/budget.ts` (E2 — implementado)
```ts
function applyBudget(facts: Fact[], cfg: Budget, render?: (f: Fact[]) => string): Fact[]
// corta por fato INTEIRO: maxMemories (nº) e maxChars (teto do bloco renderizado).
// `render` é injetado por memory.ts só para medir (evita ciclo de import).
```

### `inject/memory.ts` (E2 — implementado)
```ts
function formatMemoryBlock(facts: Fact[]): string | null   // null ⇒ não injeta
async function recallAndFormat(client, cfg, query, signal?): Promise<string | null>
class MemoryInjector {                                    // dedup por turno (FR-104)
  inject(query): Promise<InjectionResult | null>          // { block, facts, chars, recallMs }
}
// observabilidade do turno (base E7): loga `inject recall_ms=… facts=… injected_chars=…`
```

### `hooks/messages.ts` (E2 — implementado)
```ts
function messagesHook(rt: InjectRuntime): { "experimental.chat.messages.transform": fn }
// thin: liga o transform do Kilo ao MemoryInjector; nunca lança (NFR-03).
```

### `ingest/debounce.ts`
```ts
function shouldFlush(sessionId: string, cfg: IngestCfg): boolean
```

## Regras

1. **O passo de injeção tem orçamento de 4s.** Recall mediano = 0,85s. Não
   adicionar trabalho pesado aí.
2. **A coleta de código é fora do turno.** Spawn do indexer + sync nunca no
   caminho crítico (FR-510).
3. **`reference_time` = data da mensagem**, não do envio (quebra supersessão).
4. **Ingestão nunca é await no caminho do turno** — 202 e segue.
5. **Nenhum valor hardcoded** — config via `.kilo/graph-plugin.json`/env (PRD FR-303).
6. **Defaults desligados** para indexação e injeção (preferência do dono).
7. **Arquivo removido exige `chunks: []`** — o memtier não auto-deleta (FR-504).
8. **Aresta com alvo ausente é descartada** — senão 422 no lote inteiro.

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

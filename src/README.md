# kilocode-graph-plugin — src

Esqueleto. Nada implementado — apenas a forma e os contratos.

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
│   └── register.ts       # client.mcp.add(type:remote) + connect; implícito
└── adapters/
    ├── kilo.ts           # referência
    ├── opencode.ts       # não validado
    └── claude.ts         # não validado
```

## Assinaturas esperadas

### `client.ts`
```ts
interface DaemonClient {
  recall(ws: string, query: string, opts?): Promise<Fact[]>
  searchCode(ws: string, query: string, opts?): Promise<Chunk[]>
  syncCode(ws: string, files: CodeFile[], edges: CodeEdge[]): Promise<SyncResult>
  ingest(ws: string, sessionId: string, msgs: Msg[]): Promise<{job_id: string}>
  health(): Promise<boolean>
}
// `program` e `max_tokens` são campos aditivos de opts (E11 / A1).
```

### `index/runner.ts` — spawn do indexer
```ts
interface IndexerRunner {
  run(mode: "full" | "incremental", opts?: { gitRange?: string }): AsyncIterable<IndexerEvent>
  // consome stdout linha a linha; trata `pause` → `resume` (backpressure two-way)
}
```

### `index/collector.ts` — eventos → body do sync
```ts
function buildSyncBody(
  events: IndexerEvent[], repoRoot: string, ws: string, manifest: Manifest
): { files: CodeFile[]; edges: CodeEdge[]; removed: string[] }
// agrupa chunk_emitted por `file`; ≤1 FullFile/Contextual por arquivo;
// `removed` (no manifest e ausentes agora) viram `chunks: []` (FR-504)
```

### `index/edges.ts` — resolução de arestas
```ts
function resolveEdges(imports: ImportEdge[], calls: CallEdge[], files: CodeFile[]): CodeEdge[]
// import_edge/call_edge → {from_file, to_file, edge_kind, from_symbol_id?, to_symbol_id?}
// alvo ausente como CodeChunk → DESCARTA (senão o sync responde 422; ADR-012 D3)
// `symbol_id` do indexer é o NOME puro; a chave é `{file}:{symbol}` (não reconcatena file)
```

### `index/trigger.ts` — híbrido
```ts
function decideTrigger(ws: string, manifest: Manifest): "full" | "incremental"
// 1º uso do workspace → full (index_path); depois → incremental (incremental_index)
// ⚠️ o indexer NÃO tem watch mode: a detecção de mudança é do plugin (git_range);
//    mudanças não-commitadas ficam fora do MVP.
```

### `mcp/register.ts` — registro do MCP remoto
```ts
async function registerMemtierMcp(client: KiloClient, cfg: McpCfg): Promise<void>
// status → add(type:"remote", url:…/v1/mcp, headers:{Authorization}) → connect
// registro IMPLÍCITO no boot (o usuário não define nada em kilo.jsonc);
// se já definido lá, não registra por cima (idempotência) — FR-602
```

### `inject/budget.ts`
```ts
function applyBudget(facts: Fact[], chunks: Chunk[], cfg: Budget): string
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

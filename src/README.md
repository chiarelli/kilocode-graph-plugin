# kilocode-graph-plugin — src

Esqueleto. Nada implementado — apenas a forma e os contratos.

```
src/
├── index.ts              # registro dos 4 hooks
├── config.ts             # plugin.yaml + env vars
├── client.ts             # HTTP client do daemon
├── workspace.ts          # diretório → nome lógico
├── inject/
│   ├── memory.ts
│   ├── code.ts
│   └── budget.ts
├── ingest/
│   ├── capture.ts
│   └── debounce.ts
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
  ingest(ws: string, sessionId: string, msgs: Msg[]): Promise<{job_id: string}>
  health(): Promise<boolean>
}
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
2. **`reference_time` = data da mensagem**, não do envio (quebra supersessão).
3. **Ingestão nunca é await no caminho do turno** — 202 e segue.
4. **Nenhum valor hardcoded** — config via `plugin.yaml`/env (PRD FR-303).
5. **Defaults desligados** para indexação e injeção (preferência do dono).

## Reuso do plugin OpenViking

Referência: `~/.config/kilo/vendor/openviking-memory.js` (2112 linhas).
Reaproveitar: `resolvePluginWorkspace`, `loadConfig`, registro de hooks,
`appendContextPart`, estado de ingestão por batch.
Trocar: cliente (OV → daemon) e conteúdo injetado (memória → memória + código).

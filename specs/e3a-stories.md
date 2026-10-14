# E3a — Coletor de código: plano de stories (decomposição, não implementação)

**Data:** 2026-10-14

**Fonte:** `BACKLOG.md § E3a` · `docs/ARCHITECTURE.md` §2 (`/v1/code/sync`), §3
(`index/`), §4 (fluxo de coleta), §8 (degradação), §10 (armadilhas) · `docs/PRD.md`
FR-501..510, NFR-06/07/08/09 · `docs/adr/005` (plugin é o coletor) · `src/README.md`
(`index/runner.ts`, `collector.ts`, `edges.ts`, `manifest.ts`, `trigger.ts`) ·
`../rust-ast-indexer/rust_indexer/doc/protocol.md` (JSONL: `chunk_emitted`,
`import_edge`, `call_edge`, `pause`/`resume`) · `../rust-ast-indexer/rust_indexer/doc/indexer_spec.md`
(`incremental_index`, `use_git`, `git_range`) · memtier `src/memtier/main.py`
(`CodeSyncBody`/`CodeFileBody`/`CodeChunkBody`/`CodeEdgeBody`, `execute_code_sync`) ·
memtier `docs/adr/012-arestas-de-codigo.md` (alvo tem de existir; atributos achatados) ·
**referência de algoritmo (probe-grade):** `~/spikes/010-navegabilidade-codigo/probe_e2e_lifecycle.py`
(`montar_body`, `resolve_module`, materialização de `FullFile`) e `F16-e2e-ciclo-de-vida.md`.

**Protocolo:** tracer bullet — E3a-S1 é a fatia vertical mínima: 1 arquivo Rust →
spawn do indexer → `chunk_emitted` → body → `POST /v1/code/sync` (202). S2–S5
**endurecem a mesma base, sem rewrite**; gaps mínimos marcados com
`TODO(tracer-bullet):`. Fecha quando `rg "TODO\(tracer-bullet\)" src/` = 0.

**Ordem de execução:** E3a-S1 → S2 → S3 → S4 → S5 (cadeia linear; S2 e S3 são
independentes entre si, mas ambas dependem de S1; S4 depende de S3).

**Depende de:** E1 (client/config/logger) · `rust-ast-indexer` (binário externo) ·
memtier (`/v1/code/sync`, implementado).

**Ambiente de dev:** `bun run typecheck` · `node --test tests/` · E2E gated
`E2E=1` (memtier de pé + binário buildado:
`cargo build --release --features parsing` em `../rust-ast-indexer/rust_indexer`).

---

## Decisões de design fixadas nesta decomposição

### 1. O indexer é PULL — o plugin decide quando rodar

**Não há watch mode** (verificado 2026-10-14: sem crate de watch no `Cargo.toml`;
9 comandos no protocolo, nenhum `watch`; `cli/args.rs` só aceita `--mcp`/`--quiet`).
O plugin **spawna** o binário por job e lê o JSONL do stdout.

- **Um processo por job** (não um daemon persistente): `spawn(bin, [], {stdio:[pipe,pipe,pipe]})`,
  escreve 1 comando (`index_path` ou `incremental_index`), lê até `job_completed`,
  encerra. Simples e sem estado de processo.
- **`indexer_bin` vazio ⇒ coletor desligado** (FR-306). Não é erro fatal: log e
  segue. Se o caminho não existe, idem.
- **Nunca no turno** (FR-510): a coleta é disparada no boot/`chat.message` de forma
  assíncrona (`void runCollection().catch(...)`), nunca `await` no hook de injeção.

### 2. `runner.ts` — spawn + leitura de JSONL + backpressure

Protocolo: cada linha do stdout é um JSON independente. O runner:

1. monta o comando (`{protocol_version:"1.0.0", type:"command", command, seq, job_id, payload}`),
2. escreve no stdin do processo + `\n`,
3. lê stdout linha a linha (`readline`), faz `JSON.parse` defensivo (linha inválida
   → ignora, como o probe),
4. **trata `error` com `code=BACKPRESSURE`** (o protocolo é two-way: quem lê sem
   responder deixa o job travado — `protocol.md:159`): ao receber
   `{event:"error", payload:{code:"BACKPRESSURE", detail:{pause_required:true}}}`,
   escreve `{command:"resume", job_id}` no stdin,
5. acumula os eventos relevantes e resolve ao ver `job_completed`.

> **Armadilha:** o runner **não pode** só consumir stdout e ignorar o stdin depois
> do comando inicial. Se a fila do indexer encher, ele pausa e espera `resume`.
> Um runner que só lê trava para sempre.

Comando (do probe, `probe_e2e_lifecycle.py:136`):

```jsonc
{ "protocol_version":"1.0.0", "type":"command", "command":"index_path", "seq":1,
  "job_id":"...", "payload":{ "path":"<repo>",
    "options":{ "extract_imports":true, "extract_calls":true } } }
```

### 3. `collector.ts` — eventos → body do sync (estado completo por arquivo)

Traduz os eventos (mesma lógica validada no probe, `montar_body`):

- `chunk_emitted` → agrupa por `file` em `files[]`:
  `{file_path, language, chunks:[{chunk_id, chunk_kind, symbol_id, start_line,
  end_line, chunk_md5, text}]}`.
- **`symbol_id` do indexer é o NOME PURO** (`protocol.md:105`): usar **cru**.
  Montar a chave de identidade `{file}:{symbol}` com o valor cru — **nunca**
  reconcatenar `file` (produziria `src/app.ts:src/app.ts:main`). O probe usa
  `raw_sym.rsplit(":", 1)[-1]` como cinto de segurança; manter.
- **≤1 `FullFile`/`Contextual` por arquivo** (contrato do emissor; duplicidade →
  422). Se o indexer não emitir um `FullFile` para um arquivo (o probe o
  **materializa** lendo o arquivo — `probe_e2e_lifecycle.py:205`), o collector faz
  o mesmo: insere um `FullFile` sintético (`chunk_id="full-<path>"`, `md5` do
  texto) quando não houver um. Necessário porque `import_edge` em nível de arquivo
  resolve para `{file}:FullFile` (ADR-012 D3).
- `import_edge`/`call_edge` → `edges[]` (ver `edges.ts`, decisão 4).
- **Arquivos removidos** → `chunks: []` (ver `manifest.ts`, decisão 5).

### 4. `edges.ts` — resolver arestas; alvo ausente é DESCARTADO (nunca 422)

Contrato do memtier (ADR-012): `EntityEdge` exige **os dois nós**; aresta cujo
alvo não existe como `CodeChunk` → **422** e derruba o lote inteiro. Portanto o
collector **resolve antes de enviar** e **descarta** o que não resolve:

- **`import_edge`:** `to_module` → arquivo. A resolução é **por linguagem**; o
  probe implementa a de Rust (`resolve_module`, `probe_e2e_lifecycle.py:232`):
  `crate::a::b` → `src/a/b.rs`|`src/a/b/mod.rs`; `self::`/`super::` relativos;
  `std/core/alloc` → descarta; só resolve se o arquivo está no conjunto indexado.
  - **Rust é o MVP.** TS/Go/Java/Python ficam com `TODO(tracer-bullet)` (a
    resolução `to_file` do TS estava no `/tmp/e2e_full.py`, não re-medida —
    `F16` "o que NÃO cobre"). Sem resolução, a aresta é **descartada** (não
    inventa alvo).
  - `imported_symbol` presente **e** `(to_file, symbol)` existe → `to_symbol_id`.
- **`call_edge`:** `caller_symbol_id` (nome puro) + `from_file` → origem; o
  `callee_name` (ex.: `Parser::parse`) tem o último segmento casado contra os
  símbolos conhecidos. Não casou → **descarta**.
- **`edge_kind`:** `"import"` | `"call"` (enum do contrato).
- **Aresta duplicada** no payload → dedup por `(edge_kind, from_key, to_key)`.

### 5. `manifest.ts` — estado por workspace (removidos + 1º sync)

O contrato do memtier **não auto-deleta** arquivo ausente do payload (spike 010,
A1): quem some do repo precisa ser enviado com `chunks: []`. O manifest guarda o
conjunto de arquivos já sincronizados.

```jsonc
// .kilo/graph-manifest.json  (por workspace — .gitignore já cobre? NÃO: adicionar)
{ "workspace":"waweb", "last_git_head":"<sha>", "files":["src/a.rs","src/b.rs"],
  "updated_at":"2026-10-14T..." }
```

- **Removidos** = `manifest.files − arquivos_do_payload_atual` → enviados como
  `{file_path, language:"rust", chunks:[]}`.
- **`last_git_head`** alimenta o `git_range` do incremental (decisão 6).
- **Escrita atômica** (tmp + rename); corrompido → trata como vazio (força full).
- **`.gitignore`:** adicionar `graph-manifest.json` (estado local, como
  `*-key.json`).

### 6. `trigger.ts` — híbrido (full 1º uso; incremental depois)

- **1º uso do workspace** (manifest ausente/vazio) → `index_path` (full).
- **Depois** → `incremental_index` com `use_git:true` e
  `git_range:{from: manifest.last_git_head, to:"HEAD"}`.
- **Mudanças não-commitadas ficam de fora do MVP** (o modo git não as pega —
  FR-507/§10). Documentar no log e no README.
- Ao concluir um sync, gravar o `HEAD` atual no manifest.

Comando incremental (`indexer_spec.md:103`):
```jsonc
{ "command":"incremental_index",
  "payload":{ "path":"<repo>", "use_git":true, "git_range":{"from":"<sha>","to":"HEAD"} } }
```

### 7. Client: adicionar `syncCode` (a epic dona estende o client da E1)

```ts
interface SyncResult { upserted: number; deleted: number; changed: number;
                       skipped: number; edges_upserted: number; edges_deleted: number;
                       results: Array<{file_path:string; upserted:number; deleted:number}> }
// em MemtierClient:
syncCode(files: CodeFile[], edges: CodeEdge[], signal?: AbortSignal): Promise<SyncResult>
```

Body (`main.py:700`): `{workspace, program, files:[...], edges:[...]}`. Resposta 202.

- **Paginação (NFR-09):** ≤100 arquivos/request, ≤5.000 chunks/arquivo. O
  `syncCode` (ou o collector) fatia `files` em lotes de ≤100 e faz N requests;
  agrega os `SyncResult`. Na S1 não pagina (1 arquivo); entra na S4.
- **422 por aresta órfã:** se mesmo assim ocorrer, logar o lote e **reenviar sem
  as arestas** (fallback), marcado `TODO(tracer-bullet)` na S1.

### 8. Módulos

```
src/index/
├── runner.ts     # spawn do indexer; JSONL; pause/resume; resolve eventos
├── collector.ts  # eventos → {files, edges, removed}  (buildSyncBody)
├── edges.ts      # import/call → CodeEdge[] (resolve alvo; descarta órfã)
├── manifest.ts   # load/save por workspace; removed = files − atual
└── trigger.ts    # decideTrigger(manifest) → "full"|"incremental" + git_range
src/hooks/
└── collect.ts    # dispara a coleta fora do turno (boot/session); thin
```

- `collector.ts`, `edges.ts`, `manifest.ts`, `trigger.ts` são **puros/testáveis**
  (recebem eventos/estado, devolvem estruturas) — sem I/O de rede.
- `runner.ts` é a única peça que faz I/O de processo.

---

## E3a-S1 — Tracer bullet: 1 arquivo → chunk_emitted → sync 202

**Objetivo:** a fatia vertical mínima — repo com 1 arquivo Rust → spawn → eventos
→ body → `POST /v1/code/sync` → 202.

**Entregável:**
- `runner.ts`: `runIndexer(mode, opts)` — spawn, 1 comando, ler JSONL, resolver
  eventos no `job_completed`. (`pause/resume` marcado minimal.)
- `collector.ts`: `buildSyncBody(events, repoRoot, ws)` — só `chunk_emitted` →
  `files[]` (sem `FullFile` sintético ainda, se o indexer emitir).
- `client.ts`: `syncCode()` (1 request, sem paginação).
- `hooks/collect.ts`: dispara em background; `index.ts` liga.

**Minimal (`TODO(tracer-bullet)`):** arestas; manifest/removidos; trigger híbrido;
paginação; backpressure; `FullFile` sintético.

**Testes (unit) — com fixture de eventos JSONL real (gravada do indexer):**

| Teste | Caso | Esperado |
|---|---|---|
| `build_body_groups_by_file` | 2 arquivos, 3 chunks | `files.length==2`, chunks agrupados |
| `build_body_symbol_bare` | `symbol_id:"main"` | usado cru (sem `file:` na frente) |
| `build_body_ignores_junk` | linha não-JSON | ignorada, sem lançar |
| `sync_body_shape` | 1 arquivo | body tem `workspace/program/files` |
| `sync_parses_result` | 202 | `upserted`/`deleted` lidos |
| `runner_no_bin` | `indexer_bin=""` | não spawna; log; sem lançar |
| `runner_bin_missing` | caminho inexistente | log; sem lançar |

**Critérios de aceite:** typecheck limpo; testes verdes; com stack de pé e
`code_index.enabled=true`, 1 arquivo aparece na busca.

---

## E3a-S2 — Arestas: import/call → edges[] (resolver alvo; descartar órfã)

**Objetivo:** popular as arestas sem derrubar o lote.

**Entregável:**
- `edges.ts`: `resolveEdges(imports, calls, files)` — resolução Rust
  (`resolve_module`); descarta não-resolvíveis; dedup; `to_symbol_id` quando o
  símbolo existe.
- `collector.ts`: inclui `edges` no body.

**Testes (unit) — fixture de `import_edge`/`call_edge` real:**

| Teste | Caso | Esperado |
|---|---|---|
| `resolve_rust_crate` | `crate::db` + `src/db.rs` existe | `to_file:"src/db.rs"` |
| `resolve_rust_std` | `std::collections` | descartada (sem alvo) |
| `resolve_rust_mod_rs` | `crate::a` + `src/a/mod.rs` | resolve para `mod.rs` |
| `resolve_missing_target` | alvo não indexado | **descartada** (nunca 422) |
| `call_last_segment` | `Parser::parse` + `parse` existe | `to_symbol_id` |
| `call_unknown_callee` | callee inexistente | descartada |
| `edge_dedup` | mesma aresta 2× | 1 aresta |
| `edge_kind_enum` | import/call | `edge_kind ∈ {"import","call"}` |

**Critérios de aceite:** navegação OUT/IN funciona via `/v1/code/neighbors`
(HTTP) para o fixture Rust; nenhum 422 por aresta órfã.

---

## E3a-S3 — Ciclo de vida: removidos + idempotência

**Objetivo:** sem chunks órfãos; reenvio idêntico não escreve.

**Entregável:**
- `manifest.ts`: load/save atômico; `removed = manifest.files − atual`.
- `collector.ts`: `FullFile` sintético quando ausente; inclui `removed` com
  `chunks: []`.
- Idempotência por `chunk_md5` (o servidor já faz; o collector não muda nada —
  mas o teste prova).

**Testes (unit):**

| Teste | Caso | Esperado |
|---|---|---|
| `manifest_removed` | arquivo saiu do payload | entra com `chunks:[]` |
| `manifest_atomic_write` | grava | tmp+rename; JSON válido |
| `manifest_corrupt` | JSON inválido | tratado como vazio (força full) |
| `fullfile_synthetic` | arquivo sem `FullFile` do indexer | 1 `FullFile` inserido |
| `no_dup_fullfile` | indexer já emitiu `FullFile` | não duplica |

**E2E (S3, gated):** o ciclo de vida real (cresce/encolhe/deleta) — adapta
`probe_e2e_lifecycle.py`:
- cresce (1→3 símbolos): `deleted=0`;
- encolhe (3→1): `deleted≥2`;
- deleta arquivo (`chunks: []`): `deleted≥1`, 0 chunks no grafo;
- reenvio idêntico: `upserted=0, deleted=0`.

**Critérios de aceite:** ciclo de vida verde; nenhum chunk órfão; idempotência
provada.

---

## E3a-S4 — Trigger híbrido + backpressure + paginação

**Objetivo:** o coletor é utilizável num repo real, sem travar e sem estourar o
teto do sync.

**Entregável:**
- `trigger.ts`: `decideTrigger(manifest)` + `git_range`; grava `HEAD` no manifest.
- `runner.ts`: backpressure (`pause` → `resume`); timeout do job.
- `client.ts`: paginação (lotes ≤100 arquivos); agrega resultados.
- Fallback 422 (reenvia sem arestas).

**Testes (unit):**

| Teste | Caso | Esperado |
|---|---|---|
| `trigger_first_use` | manifest vazio | `full` |
| `trigger_incremental` | manifest com head | `incremental` + `git_range` |
| `runner_resume_on_backpressure` | evento BACKPRESSURE | escreve `resume` |
| `sync_paginates_100` | 250 arquivos | 3 requests (100/100/50) |
| `sync_aggregates` | 3 respostas | `upserted` somado |
| `sync_422_fallback` | 422 com edges | reenvia sem edges |

**Critérios de aceite:** repo de ~200 arquivos sincroniza sem travar; incremental
após full é mais barato (`skipped` alto).

---

## E3a-S5 — Fechamento da epic

**Entregável:**
- `tests/e2e/test_e2e_collector.ts` (**novo**, gated): cadeia completa
  indexer→sync→search→neighbors contra a stack real.
- Log de observabilidade da coleta (base do E7): `{collect, indexer_ms, files,
  edges, sync:{upserted,deleted,changed,skipped}, removed}`.
- Docs: README/ARCH alinhados; remover todos os `TODO(tracer-bullet)`.

**Critérios de aceite:**
1. typecheck limpo; unit verde; `E2E=1` verde.
2. `rg "TODO\(tracer-bullet\)" src/` → zero.
3. Ciclo de vida medido (cresce/encolhe/deleta) verde.
4. Coleta nunca no caminho do turno (verificado por log de latência do hook).

**Comandos:**
```bash
cd /home/hermes/Projetos/kilocode-graph-plugin
bun run typecheck && node --test tests/
cd ../rust-ast-indexer/rust_indexer && cargo build --release --features parsing
cd /home/hermes/Projetos/kilocode-graph-plugin && E2E=1 node --test tests/e2e/
```

---

## Fora de escopo da E3a

- Watch mode (o indexer não tem; detecção é do plugin via git).
- Mudanças não-commitadas (modo git não as pega).
- Resolução de arestas fora de Rust (TS/Go/Java/Python — `TODO` até medir).
- Navegação `neighbors` **no plugin** (bloqueada até o memtier expor tool MCP —
  o dado é gravado, mas o consumo é HTTP-only e não é prometido aqui).
- Multi-hop / `depth>1`.

## Histórico de revisão

- **2026-10-14** — criada a partir do PRD/ARCH v0.2, do BACKLOG § E3a e da
  referência validada no spike 010 (`probe_e2e_lifecycle.py`, F16).

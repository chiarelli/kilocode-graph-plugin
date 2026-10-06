# ARCHITECTURE — kilocode-graph-plugin (draft)

**Versão:** 0.1 (draft)
**Base empírica:** `~/spikes/007-graphiti-memory-migration/REPORT.md`
**PRD:** [`PRD.md`](PRD.md)
**Dependência:** [`../../graphiti-daemon/`](../../graphiti-daemon/)

---

## 1. Visão geral

```
┌──────────────────────────────────────────────────────────────┐
│  KILO CODE                                                    │
│                                                               │
│  chat.message ──────────▶ captura o texto do usuário          │
│                              │                                │
│  experimental.chat.messages.transform ◀── INJEÇÃO             │
│                              │                                │
│  experimental.chat.system.transform  ◀── contexto de sistema  │
│  experimental.session.compacting     ◀── preserva memória     │
└───────────────┬───────────────────────────────────────────────┘
                │  HTTP + token
                ▼
┌──────────────────────────────────────────────────────────────┐
│  GRAPHITI DAEMON                                              │
│  recall (síncrono)  ·  ingest (fila)  ·  code/search          │
└──────────────────────────────────────────────────────────────┘
```

### Princípio central

**Recall é síncrono. Ingestão é assíncrona.** O usuário nunca espera uma extração
por LLM (38–110s). Ver o ADR-003 do daemon — a fila existe por custo e
determinismo, e porque o plugin pode morrer antes de terminar a escrita.

Orçamento do hook (medido, não suposto):

| Operação | Medido | Timeout do hook |
|---|---|---|
| recall de memória | 0,62–2,08s (mediana 0,85s) | 4000ms |
| busca de código | ~0,25–0,44s | idem (compartilhado) |

## 2. Contrato com o daemon

O plugin **não** conhece FalkorDB nem graphiti. Ele só fala HTTP.

### `POST /v1/recall`

```json
// request
{ "workspace": "waweb", "query": "<texto do usuário>", "depth": 1, "limit": 10 }

// response
{ "facts": [ { "fact": "...", "valid_at": "...", "invalid_at": null,
               "score": 0.83, "source": "memory" } ] }
```

### `POST /v1/code/search`

```json
// request
{ "workspace": "waweb", "query": "...", "limit": 5,
  "labels": ["CodeSymbol", "CodeFullFile"] }

// response
{ "chunks": [ { "path": "internal/billing/store.go", "symbol": "SaveInvoice",
                "start_line": 42, "end_line": 55, "code": "...",
                "score": 0.79, "match": "hybrid" } ] }
```

### `POST /v1/ingest`

```json
// request
{ "workspace": "waweb", "session_id": "ses_...", "messages": [...],
  "reference_time": "2026-10-06T12:00:00Z" }

// response — 202, imediato
{ "job_id": "...", "status": "queued" }
```

> `reference_time` é a data da **mensagem**, não a do envio. Sem isso a
> supersessão temporal grava a linha do tempo errada.

### `GET /v1/health`

Usado pelo E5 (degradação) para decidir se injeta ou segue sem memória.

## 3. Componentes

```
src/
├── index.ts              # registro dos hooks (entrada do plugin)
├── config.ts             # config.yaml + env vars (nada hardcoded)
├── client.ts             # HTTP client do daemon (timeout, retry, auth)
├── workspace.ts          # diretório do projeto → nome lógico
├── inject/
│   ├── memory.ts         # formata o bloco de memória
│   ├── code.ts           # formata o bloco de código
│   └── budget.ts         # maxChars / maxMemories / maxCodeChunks
├── ingest/
│   ├── capture.ts        # hook chat.message
│   └── debounce.ts       # agrupa por sessão antes de enfileirar
└── adapters/
    ├── kilo.ts           # referência (hooks JS)
    ├── opencode.ts       # mesmo mecanismo
    └── claude.ts         # UserPromptSubmit + additionalContext
```

### `workspace.ts` — escopo

Mesma abordagem do plugin atual: o workspace deriva do diretório do projeto
(hash do caminho, como hoje). O daemon recebe o **nome lógico**; ele resolve o
`group_id` e valida contra o escopo do token.

> O plugin **nunca** escolhe o grafo diretamente. Isso é o que garante FR-302.

### `inject/budget.ts` — orçamento

Limites configuráveis, com defaults conservadores. A injeção é poluição em
potencial: se o recall trouxer ruído, a resposta piora. O orçamento é o freio.

```
maxMemories:   5
maxCodeChunks: 3
maxChars:      4000
```

### `ingest/debounce.ts` — agrupamento

O plugin atual ingere por batch de ~20 mensagens. Mantém-se o padrão: acumula a
sessão e enfileira um job a cada N mensagens ou T segundos, o que vier primeiro.

## 4. Fluxo de um turno

```
1. usuário envia o prompt
2. hook chat.message        → guarda o texto (não bloqueia)
3. hook messages.transform  → [SÍNCRONO, orçamento 4s]
      ├── POST /v1/recall       (memória)
      └── POST /v1/code/search  (código)
      └── injeta bloco no turno
4. LLM responde
5. hook chat.message        → acumula para ingestão
6. debounce atinge o limiar → POST /v1/ingest (202)
```

**Só o passo 3 está no caminho crítico.** Se ele estourar o timeout, o turno
segue sem contexto (E5).

## 5. Formato do contexto injetado

Blocos distintos, com procedência (FR-105) — o modelo precisa saber o que é fato
de memória e o que é código do repo:

```
[CONTEXTO DE MEMÓRIA]
- O backend do Atlas roda em PostgreSQL 16 (válido desde 2026-04-22)
- O timeout de conexão foi ajustado para 30s

[CÓDIGO RELEVANTE — internal/billing/store.go:42-55]
func SaveInvoice(ctx context.Context, inv *Invoice) error {
    return db.Insert(ctx, "invoices", inv)
}
```

## 6. Configuração

Nada hardcoded no script (FR-303). `plugin.yaml` + env vars, precedência: env
var > arquivo de config > default.

```yaml
daemon:
  url: http://127.0.0.1:8400
  token_file: .kilo/graph-key.json     # por workspace, no .gitignore
inject:
  enabled: true
  max_memories: 5
  max_code_chunks: 3
  max_chars: 4000
  timeout_ms: 4000
ingest:
  enabled: true
  batch_size: 20
  debounce_seconds: 60
code_index:
  enabled: false                        # ativado por flag, como hoje
```

> **Defaults desligados** para indexação e injeção — é a preferência registrada
> do dono no plugin atual.

## 7. Adaptadores multi-CLI

| CLI | Mecanismo | Status |
|---|---|---|
| **Kilo Code** | hooks JS (`chat.message`, `messages.transform`, `compacting`) | ✅ produção — arquitetura validada |
| **OpenCode** | mesmos hooks (Kilo é fork) | ⚠️ por documentação — **não testado** |
| **Claude Code** | hook `UserPromptSubmit` → `additionalContext` | ⚠️ por documentação — **não testado** |

O que realmente muda entre CLIs é **o ponto de captura e o ponto de injeção** —
o cliente do daemon, o orçamento e o formato dos blocos são compartilhados. Por
isso a separação em `adapters/`.

> **Ressalva honesta:** nenhuma das duas CLIs alternativas está instalada no
> ambiente de desenvolvimento. Os adaptadores são desenho, não código validado.
> Ver `SPIKE-FINDINGS.md`.

## 8. Degradação (E5)

| Situação | Comportamento |
|---|---|
| `/health` falha | turno segue sem injeção; log discreto |
| Recall estoura timeout | turno segue sem memória (code/search pode ter chegado) |
| `/ingest` falha | job fica em retry local; nada bloqueia o turno |
| Token rejeitado (401/403) | log de erro visível; sem retry infinito |

O principio: **memória é um luxo, não um pré-requisito do turno.**

## 9. Observabilidade (E7)

Log estruturado por turno:

```json
{ "turn": "...", "recall_ms": 830, "facts": 5, "code_chunks": 2,
  "injected_chars": 3120, "ingest_queued": true }
```

Sem isso é impossível calibrar os limiares do §5 — e a suspeita de que a injeção
está piorando as respostas fica sem evidência.

## 10. Armadilhas herdadas do spike

Ver `../../graphiti-daemon/docs/ARCHITECTURE.md` §5. As relevantes aqui:

| # | Armadilha | Onde morde neste plugin |
|---|---|---|
| 1 | `driver.clone` obrigatório | invisível (o daemon encapsula) |
| 2 | Fulltext não cobre código | a busca de código depende do daemon ter `CodeSearchable` |
| 6 | `reference_time` errado | quebra a supersessão — enviar a data da mensagem |
| 7 | Daemon bloqueado por ingestão | **não acontece** (medido); não projetar em cima disso |

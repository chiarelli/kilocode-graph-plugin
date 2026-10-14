# E3b — Registro do MCP do memtier: plano de stories (decomposição, não implementação)

**Data:** 2026-10-14

**Fonte:** `BACKLOG.md § E3b` · `docs/ARCHITECTURE.md` §2 (`/v1/mcp`), §3 (`mcp/`),
§8 (degradação) · `docs/PRD.md` FR-601..604 · `docs/adr/006` (push vs pull MCP) ·
`src/README.md` (`mcp/register.ts`) · antecessor
`~/.config/kilo/vendor/openviking-memory.js` (`registerOpenVikingMcp`,
`buildOpenVikingMcpConfig`, `getKiloMcpOverride`, `scheduleOpenVikingMcpRegistration`) ·
memtier `docs/ARCHITECTURE.md` §2 (E7: `/v1/mcp`, Streamable HTTP, middleware de auth) ·
memtier `src/memtier/tools/__init__.py` (tools registradas).

**Protocolo:** tracer bullet — E3b-S1 é a fatia vertical mínima: `status` → `add`
(`type:"remote"`) → `connect` de 1 MCP real no boot. S2/S3 **endurecem a mesma
base, sem rewrite**; gaps mínimos marcados com `TODO(tracer-bullet):`. Fecha
quando `rg "TODO\(tracer-bullet\)" src/` = 0.

**Ordem de execução:** E3b-S1 → E3b-S2 → E3b-S3.

**Depende de:** E1 (config/logger) · memtier MCP (`/v1/mcp`, implementado).
**Independente de** E2/E3a (só precisa do MCP de pé).

**Ambiente de dev:** `bun run typecheck` · `node --test "tests/**/*.test.ts"` · E2E gated
`E2E=1` (memtier de pé).

---

## Decisões de design fixadas nesta decomposição

### 1. Reuso literal de `registerOpenVikingMcp` (do antecessor)

O antecessor já registra MCP programaticamente (`openviking-memory.js:1781`):

```ts
// fluxo do antecessor:
const status = await client.mcp.status({ query: { directory } });
const existing = status.data?.[name];
if (existing?.status === "connected") return;          // já conectado
if (existing) { await client.mcp.disconnect(...); }    // refresh se falho
await client.mcp.add({ body: { name, config }, query: { directory } });
await client.mcp.connect({ path: { name }, query: { directory } });
```

**Adotar o mesmo fluxo**, trocando o `config` de `type:"local"` para
`type:"remote"`:

```ts
// antecessor (local):
{ type:"local", command:[bin], enabled:true, timeout, environment:{...} }
// este plugin (remote):
{ type:"remote", url:"http://127.0.0.1:8400/v1/mcp", enabled:true, timeout,
  headers:{ Authorization:"Bearer <token>" } }
```

- O `client` do Kilo (`ctx.client`) é quem tem `.mcp.*` — recebido no boot.
- **`directory`** sempre no `query` (o MCP é por workspace/diretório).
- **Override respeitado** (`getKiloMcpOverride`, `:1748`): se o `kilo.jsonc` já
  define `mcp.<name>`, o plugin **não** registra (idempotência). Lê
  `.kilo/kilo.json(c)` e `kilo.json(c)` do diretório.

### 2. Registro IMPLÍCITO (decisão do dono, 2026-10-14)

O usuário **não** precisa definir o MCP em `kilo.jsonc`. O plugin o registra no
boot, em background (`scheduleOpenVikingMcpRegistration`, `:1776` — `void ...
.catch()`), **nunca** bloqueando o carregamento do plugin.

- **Nome do MCP:** `memtier` (config `mcp.name`, default). Não usar `openviking`.
- **URL:** derivada de `daemon.url` + `/v1/mcp` (não hardcoded).
- **Auth:** header `Authorization: Bearer <token>` (mesmo `token_file`/env da E1).
  ⚠️ **Ponto a validar** (§10 lacuna 3 do PRD): o antecessor só registrava
  `type:"local"`. Confirmar que o Kilo registra/conecta MCP **remote** com header
  de auth antes de prometer. Se `client.mcp.add` não aceitar `headers`, registrar
  como `local` apontando para um shim que injeta o header — decisão adiada para
  quando a S1 medir (marcar `TODO(tracer-bullet)` se ficar em aberto).

### 3. Degradação (FR-604) — nunca fatal

| Situação | Comportamento |
|---|---|
| `mcp.enabled=false` | não registra (log em debug) |
| `client.mcp.*` indisponível (SDK antigo) | log; segue; nunca lança |
| `status` falha | log; não registra (não tenta cegamente) |
| `add`/`connect` falham | `logFatal`-like mas **não** derruba o plugin |
| MCP do memtier fora do ar | registro falha; o turno segue sem tools |

O boot do plugin **jamais** depende do registro do MCP.

### 4. Bloqueio registrado: `neighbors` não é tool MCP

O memtier expõe **4** tools: `recall`, `ingest`, `code_search`, `code_sync`
(`tools/__init__.py:22`). **`neighbors` (E12) NÃO é tool MCP** — é HTTP-only.

Consequência: o E3b registra o que **existe**; **não** promete navegação. Quando o
memtier expuser `neighbors` como tool, o plugin a herda **sem código novo**
(mesmo mecanismo de registro). Documentado no README/ADR-006.

### 5. Módulo

```
src/mcp/
└── register.ts   # registerMemtierMcp(client, cfg): Promise<void>
                  #  - resolve override; builda config remote; status→add→connect
src/index.ts      # chama scheduleMcpRegistration(ctx.client, cfg) no boot
```

- `register.ts` recebe `client` (injetado) — testável com um fake de `client.mcp`.
- A construção do config (`buildMcpConfig`) é **pura** e testável isolada.

---

## E3b-S1 — Tracer bullet: registrar 1 MCP remoto no boot

**Objetivo:** a fatia vertical mínima — boot → `status` → `add` (`type:"remote"`)
→ `connect` → tools disponíveis.

**Entregável:**
- `mcp/register.ts`: `registerMemtierMcp` + `buildMcpConfig` (puro).
- `index.ts`: dispara em background no boot.

**Minimal (`TODO(tracer-bullet)`):** override do `kilo.jsonc`; refresh de registro
falho; tratamento de SDK antigo.

**Testes (unit) — com fake de `client.mcp`:**

| Teste | Caso | Esperado |
|---|---|---|
| `build_config_remote` | url base | `{type:"remote", url:".../v1/mcp"}` |
| `build_config_auth` | token presente | header `Authorization: Bearer ...` |
| `build_config_no_token` | sem token | sem header (borda decide) |
| `register_adds_and_connects` | fake ok | chamou `add` e `connect` |
| `register_skips_when_connected` | status `connected` | não chama `add` |
| `register_disabled` | `mcp.enabled=false` | não chama nada |
| `register_failure_not_fatal` | `add` lança | não lança; log |

**Critérios de aceite:** typecheck limpo; testes verdes; com o memtier de pé, o
MCP `memtier` aparece conectado e as 4 tools listáveis.

---

## E3b-S2 — Endurecer: override, refresh, SDK antigo

**Objetivo:** sobre o **mesmo código**, cobrir idempotência e degradação.

**Entregável:**
- `getKiloMcpOverride` (reuso): se `kilo.jsonc` define `mcp.memtier`, não registra.
- Refresh de registro falho (`status==="failed"` ou `ENOENT`) → `disconnect`+`add`.
- Guarda para `client.mcp` ausente (SDK antigo) → log, segue.

**Testes (unit) — adicionais:**

| Teste | Caso | Esperado |
|---|---|---|
| `override_skips` | `kilo.jsonc` com `mcp.memtier` | plugin não registra |
| `refresh_failed` | status `failed` | `disconnect`+`add`+`connect` |
| `sdk_without_mcp` | `client.mcp` undefined | log; não lança |
| `status_error` | `status` devolve erro | não registra; log |

**Critérios de aceite:** testes de S1 verdes; novos verdes; nenhum boot quebra por
MCP.

---

## E3b-S3 — Fechamento da epic

**Entregável:**
- `tests/e2e/test_e2e_mcp.ts` (**novo**, gated): com o memtier de pé, o registro
  implícito acontece e as 4 tools respondem (ao menos `recall` e `code_search`
  listáveis/chamáveis via cliente MCP).
- Docs: README/ADR-006 com o bloqueio do `neighbors` explícito; remover todos os
  `TODO(tracer-bullet)`.

**Critérios de aceite:**
1. typecheck limpo; unit verde; `E2E=1` verde.
2. `rg "TODO\(tracer-bullet\)" src/` → zero.
3. Registro implícito provado (sem `kilo.jsonc` definindo o MCP).
4. `neighbors` **não** prometido (documentado).

**Comandos:**
```bash
bun run typecheck && node --test "tests/**/*.test.ts"
E2E=1 node --test "tests/e2e/**/*.test.ts"
```

---

## Fora de escopo da E3b

- Navegação `neighbors` (não é tool MCP — bloqueio registrado).
- Migrar memórias via MCP (é do memtier).
- Configurar MCPs de terceiros (só o do memtier).
- Publicação do plugin.

## Histórico de revisão

- **2026-10-14** — criada a partir do PRD/ARCH v0.2 e do BACKLOG § E3b. Decisão de
  registro implícito (dono, 2026-10-14).

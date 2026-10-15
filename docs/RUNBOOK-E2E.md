# RUNBOOK — E2E do `kilocode-graph-plugin`

**Comandos verificados por medição** (2026-10-15, HEAD `046600b`). Não é suposição:
cada linha abaixo foi executada e o resultado está anotado.

## O problema

`E2E=1 node --test "tests/e2e/**/*.test.ts"` com **os dois tokens** era o comando
prescrito no BACKLOG — e ele é **vermelho**:

```
E2E=1 E2E_TOKEN=e2e-tok-a E2E_CODE_TOKEN=e2e-tok-b node --test "tests/e2e/**/*.test.ts"
  → # tests 9 / pass 8 / fail 1        (teste 4, o E2E do E3c)
```

**Causa:** cada suíte de E2E consome um token de escopo **diferente**, e passá-los
globalmente **atrapalha** as que não os consomem. `E2E_TOKEN=e2e-tok-a` é escopado
ao workspace `alfa`; o E2E do MCP usa o bearer real (`graphlocalhost`/`beta`), então
receber `e2e-tok-a` faz o `recall` responder erro de escopo.

## Os tokens (legacy do memtier, `MEMTIER_API_TOKENS`)

| token | workspace | quem consome |
|---|---|---|
| `e2e-tok-a` | `alfa` | `lifecycle`, `recall_inject` |
| `e2e-tok-b` | `beta` | `collector`, `inject_code` |
| (bearer real `.kilo/graph-key.json`) | `kilocode-graph-plugin` / program `graphplugin` | `mcp` |
| — | — | `health` (sem token) |

## Comandos corretos — por arquivo (isolado)

```bash
cd /home/hermes/Projetos/kilocode-graph-plugin
export PATH="$HOME/.bun/bin:$PATH"

# sem token
E2E=1 node --test tests/e2e/test_e2e_health.test.ts            # 2/2

# alfa
E2E=1 E2E_TOKEN=e2e-tok-a node --test tests/e2e/test_e2e_lifecycle.test.ts      # 1/1
E2E=1 E2E_TOKEN=e2e-tok-a node --test tests/e2e/test_e2e_recall_inject.test.ts  # 2/2

# beta
E2E=1 E2E_CODE_TOKEN=e2e-tok-b node --test tests/e2e/test_e2e_collector.test.ts   # 1/1
E2E=1 E2E_CODE_TOKEN=e2e-tok-b node --test tests/e2e/test_e2e_inject_code.test.ts # 1/1

# bearer real do graph-key.json
E2E=1 node --test tests/e2e/test_e2e_mcp.test.ts               # 2/2
```

**Total: 9/9, 0 fail, 0 skip.**

## ⚠️ O que NÃO fazer

| comando | resultado |
|---|---|
| glob + os dois tokens | 9 · 8 pass · **1 fail** |
| `E2E=1 E2E_TOKEN=e2e-tok-a` no glob | 9 · 6 pass · **2 fail** |
| `E2E=1` sem token nenhum | 9 · 4 pass · **1 fail** · 4 skip |

Nunca passe `E2E_TOKEN` para a suíte do MCP nem para a do E3c: elas usam bearer
real / `E2E_CODE_TOKEN`. E `E2E_CODE_TOKEN` não serve para `lifecycle`/`recall_inject`.

## Pré-requisitos

- memtier vivo: `GET /v1/health` → `200` (stack Docker `memtier`).
- binário do indexer: `rust_indexer/target/release/rust_indexer` (a suíte
  `collector` e `inject_code` o usam; `E2E_INDEXER` sobrescreve).
- `.kilo/graph-key.json` (mode 600) para a suíte do MCP. **Não** é pré-requisito
  das outras (a `health` roda sem bearer).

## Pendências ligadas a este runbook

- **D-1/D-2** do `docs/reviews/REVIEW-E3b-adversarial.md`: o E2E do MCP **ignora**
  `E2E_CODE_TOKEN` e cai num fallback silencioso para `.kilo/graph-key.json`
  (por isso `E2E=1` sem token nenhum *passa* nele — falso verde). Corrigir em `E3b-S5`.

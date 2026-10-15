# RUNBOOK — E2E do `kilocode-graph-plugin`

**Comandos verificados por medição** (2026-10-15, pós E3b-S5). Não é suposição:
cada linha abaixo foi executada e o resultado está anotado.

## Comando canônico (verde)

```bash
cd /home/hermes/Projetos/kilocode-graph-plugin
export PATH="$HOME/.bun/bin:$PATH"

E2E=1 \
  E2E_TOKEN=e2e-tok-a \
  E2E_CODE_TOKEN=e2e-tok-b \
  E2E_MCP_TOKEN="$(python3 -c 'import json;print(json.load(open(".kilo/graph-key.json"))["token"])')" \
  node --test "tests/e2e/**/*.test.ts"
# → # tests 10 / pass 10 / fail 0 / skipped 0
```

Cada suíte usa um token de escopo **distinto**; por isso há **três** variáveis
(antes havia dois tokens e o E2E do MCP caía em fallback silencioso — ver
D-1/D-2 abaixo).

## Os tokens (legacy do memtier, `MEMTIER_API_TOKENS`)

| variável | token | workspace/program | quem consome |
|---|---|---|---|
| `E2E_TOKEN` | `e2e-tok-a` | `alfa` / `default` | `lifecycle`, `recall_inject` |
| `E2E_CODE_TOKEN` | `e2e-tok-b` | `beta` / `default` | `collector`, `inject_code` |
| `E2E_MCP_TOKEN` | bearer de `.kilo/graph-key.json` | `kilocode-graph-plugin` / `graphplugin` | `mcp` |
| — | — | — | `health` (sem token) |

## Comandos por arquivo (isolado)

```bash
# sem token
E2E=1 node --test tests/e2e/test_e2e_health.test.ts            # 2/2

# alfa
E2E=1 E2E_TOKEN=e2e-tok-a node --test tests/e2e/test_e2e_lifecycle.test.ts      # 1/1
E2E=1 E2E_TOKEN=e2e-tok-a node --test tests/e2e/test_e2e_recall_inject.test.ts  # 2/2

# beta
E2E=1 E2E_CODE_TOKEN=e2e-tok-b node --test tests/e2e/test_e2e_collector.test.ts   # 1/1
E2E=1 E2E_CODE_TOKEN=e2e-tok-b node --test tests/e2e/test_e2e_inject_code.test.ts # 1/1

# bearer real do graph-key.json
E2E=1 E2E_MCP_TOKEN="$(python3 -c 'import json;print(json.load(open(".kilo/graph-key.json"))["token"])')" \
  node --test tests/e2e/test_e2e_mcp.test.ts  # 3/3
```

## ⚠️ O que NÃO fazer

| comando | resultado |
|---|---|
| glob com **só** `E2E_TOKEN=e2e-tok-a` | vermelho (MCP e código sem token) |
| `E2E=1` sem token nenhum | 6 pass · **3 fail** · 0 skip |
| `E2E=1` com `E2E_TOKEN=e2e-tok-a` **e** `E2E_CODE_TOKEN=e2e-tok-b` (sem `E2E_MCP_TOKEN`) | MCP **falha** (não há mais fallback) |

Nunca passe `E2E_TOKEN` para a suíte do MCP nem para a do E3c: elas usam bearer
real / `E2E_CODE_TOKEN`.

## Pré-requisitos

- memtier vivo: `GET /v1/health` → `200` (stack Docker `memtier`).
- binário do indexer: `rust_indexer/target/release/rust_indexer` (a suíte
  `collector` e `inject_code` o usam; `E2E_INDEXER` sobrescreve).
- `.kilo/graph-key.json` (mode 600) para a suíte do MCP, lido via `E2E_MCP_TOKEN`.

## Correções ligadas a este runbook (E3b-S5)

- **D-1**: `E2E_TOKEN` (escopo `alfa`) passado ao glob derrubava o teste do MCP.
  Resolvido: a suíte do MCP usa `E2E_MCP_TOKEN` **dedicado** e ignora `E2E_TOKEN`.
- **D-2**: a suíte do MCP caía em fallback silencioso para `.kilo/graph-key.json`
  quando faltava env — `E2E=1` sem token passava (verde falso). Resolvido: sem
  `E2E_MCP_TOKEN`/`KILOCODE_GRAPH_TOKEN`, em `E2E=1` o teste **falha** (não skippa,
  não lê o arquivo).

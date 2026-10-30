# Índice de RFCs — kilocode-graph-plugin

> RFCs descrevem **problemas observados e propostas** (findings, bugs, lacunas
> de contrato). Decisões aceitas viram [ADR](../adr/README.md).

| RFC | Tema | Status |
|---|---|---|
| [001](001-navegacao-e-integridade-do-grafo-de-codigo.md) | Navegação do grafo de código (MCP + `neighbors`), identidade no RAG injetado, navegação de memória e instrução de uso do memtier ao modelo | **aberto** (rev. 5) — achados 1/2/5 **fechados no memtier v1.1.0**; resta plugin (3/4/6) + dívida documental (§7) |
| [002](002-sync-de-delta-em-runtime.md) | O delta de código é coletado só no boot (sem sync incremental em runtime) | **decidido** (Opção A) — [ADR-011](../adr/011-gatilho-do-delta-em-runtime.md) · spec [`e3a-s6`](../../specs/e3a-s6-stories.md) · impl. pendente (`E3a-S6`) |

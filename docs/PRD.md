# PRD — kilocode-graph-plugin (draft)

**Versão:** 0.1 (draft)
**Base empírica:** `~/spikes/007-graphiti-memory-migration/REPORT.md`
**Dependência:** `../graphiti-daemon/` (não implementado)
**Antecessor:** [`chiarelli/kilo-openviking-plugin`](https://github.com/chiarelli/kilo-openviking-plugin)

---

## 1. Problema

O `kilo-openviking-plugin` funciona, mas tem três limitações herdadas do provider:

1. **Memória sem curadoria** — o OpenViking não invalida fatos antigos. O spike
   mediu 49 pares do mesmo assunto, 0 idênticos, 183 clusters, 3 identidades
   conflitantes no corpus real.
2. **Sem RAG de código** — o plugin injeta memória de conversa, não o código do
   repositório. O agente re-lê arquivos que poderia receber prontos.
3. **Preso a uma CLI** — a lógica de memória vive dentro do plugin. OpenCode e
   Claude Code não se beneficiam.

## 2. Objetivos

1. **Injetar memória curada** no turno, dentro do orçamento de latência do hook.
2. **Injetar código do repositório** relevante ao prompt, via busca híbrida.
3. **Nunca bloquear o turno** — recall é síncrono; ingestão é assíncrona.
4. **Escopo por workspace** — a memória do projeto A nunca aparece no B.
5. **Degradar com elegância** — daemon fora do ar ⇒ CLI segue sem memória.

## 3. Não-objetivos

- Implementar o servidor de memória (é do `graphiti-daemon`).
- Indexar o repositório (é do `rust-ast-indexer`).
- Substituir funcionalidades do Kilo (subagentes, sessões, permissões).

## 4. Personas

| Persona | Necessidade |
|---|---|
| **Dev no Kilo** | Retomar contexto sem reexplicar; receber o código certo sem buscar |
| **Dev alternando projetos** | Cada repo com sua memória isolada |
| **Dono do projeto** | Memória que não apodrece com o tempo |

## 5. Requisitos funcionais

### Injeção

| ID | Requisito | Critério de aceite |
|---|---|---|
| FR-101 | Injetar memória relevante ao prompt no turno | Contexto aparece em `messages.transform` |
| FR-102 | Injetar chunks de código relevantes | Busca híbrida; top-N por relevância |
| FR-103 | Respeitar orçamento de latência | recall < 4s (timeout do hook); medido 0,85s |
| FR-104 | Marcar memória como já consumida | Evita re-injeção no mesmo turno |
| FR-105 | Separar visualmente código de memória | Blocos distintos no contexto injetado |
| FR-106 | Controlar o volume injetado | Config: `maxMemories`, `maxCodeChunks`, `maxChars` |

### Ingestão

| ID | Requisito | Critério de aceite |
|---|---|---|
| FR-201 | Capturar a mensagem do usuário | Hook `chat.message` |
| FR-202 | Enviar para a fila do daemon | `POST /ingest` retorna 202 |
| FR-203 | **Nunca** bloquear o turno | Latência do hook não cresce com o tamanho do lote |
| FR-204 | Debounce por sessão | Não enfileira 1 job por mensagem |
| FR-205 | Preservar contexto na compactação | Hook `compacting` sobrevive à summarização |

### Escopo e configuração

| ID | Requisito | Critério de aceite |
|---|---|---|
| FR-301 | Workspace derivado do diretório do projeto | Hash/dir do projeto → nome lógico |
| FR-302 | Nenhum vazamento entre workspaces | Teste dedicado |
| FR-303 | Config por `plugin.yaml` + env vars | Nenhum valor hardcoded no script |
| FR-304 | Ativação/desativação por flag | Indexação e injeção desligadas por padrão |

### Multi-CLI (adaptadores)

| ID | Requisito | Critério de aceite |
|---|---|---|
| FR-401 | Kilo Code (referência) | Hooks JS — caminho de produção |
| FR-402 | OpenCode | Mesmo mecanismo de hooks |
| FR-403 | Claude Code | Hook `UserPromptSubmit` + `additionalContext` |

## 6. Requisitos não-funcionais

| ID | Requisito | Alvo | Origem |
|---|---|---|---|
| NFR-01 | Latência do hook (recall) | < 4s total | timeout do plugin atual |
| NFR-02 | Latência mediana de recall | ~0,85s | medido no grafo real |
| NFR-03 | Falha do daemon não quebra o turno | sempre | FR-305 do daemon |
| NFR-04 | Nenhuma credencial no código | — | `*-key.json` por workspace, `.gitignore` |
| NFR-05 | Node | ≥ 22 (v22.23.3 disponível) | ambiente |
| NFR-06 | Sem dependências pesadas no plugin | — | o plugin é fino; o peso está no daemon |

## 7. Épicos

| # | Épico | Entrega | Depende de |
|---|---|---|---|
| **E1** | **Cliente do daemon** | HTTP client, auth por token, workspace por dir, health check | daemon E2 |
| **E2** | **Injeção de memória** | `messages.transform` com recall; orçamento de latência | E1 |
| **E3** | **Injeção de código** | Busca híbrida; bloco separado de memória | E1, daemon E6 |
| **E4** | **Ingestão assíncrona** | Enfileira por sessão com debounce; zero bloqueio | E1, daemon E4 |
| **E5** | **Degradação** | Daemon fora do ar ⇒ turno segue, com aviso discreto | E2 |
| **E6** | **Multi-CLI** | Adaptador OpenCode; adaptador Claude Code | E2, E3 |
| **E7** | **Observabilidade** | Log de recall (acertos, latência), flag de debug | E2 |

### Dependências externas

- **E1 depende do `graphiti-daemon` E2** (borda autenticada). Até lá, o
  desenvolvimento usa um mock do daemon.
- **E3 depende do daemon E6** (busca híbrida em código).
- Este projeto **não pode ser entregue** antes do daemon estar minimamente de pé.
  A ordem natural é: daemon E1→E2, depois plugin E1→E2 em paralelo ao daemon E5→E6.

## 8. Métricas de sucesso

| Métrica | Baseline (plugin OV) | Alvo |
|---|---|---|
| Fatos contraditórios injetados | sim | **0** |
| Latência adicionada ao turno | ~0,7s | < 1s |
| Contexto de código injetado | nenhum | ≥ 1 chunk relevante por prompt técnico |
| Bloqueio por ingestão | sim (síncrona) | **zero** |
| Vazamento entre workspaces | não testado | **0** |

## 9. Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| Daemon não implementado | bloqueia E1 | Desenvolver contra mock; contratos em ARCHITECTURE §2 |
| Injeção polui o prompt | piora a resposta em vez de melhorar | Limites de volume (FR-106) + flag de debug |
| Recall traz ruído | contexto irrelevante | Score mínimo; log de acertos para calibrar |
| Mecanismo de hooks do OpenCode não confirmado | adaptador E6 falha | Validar antes de prometer (ver SPIKE-FINDINGS) |
| Overhead de rede no turno | latência perceptível | Timeout curto + cache por sessão |

## 10. Lacunas a fechar antes de implementar

1. **Contrato do daemon** — a borda HTTP precisa existir (ou ser mockada com
   fidelidade) para o E1 começar.
2. **Validar hooks do OpenCode** — o spike confirmou por documentação que o Kilo
   é fork do OpenCode, mas **não testou** (nenhuma das duas CLIs está instalada).
3. **Limiares de injeção** — quanto cabe no prompt sem degradar a resposta?
   Requer experimento.

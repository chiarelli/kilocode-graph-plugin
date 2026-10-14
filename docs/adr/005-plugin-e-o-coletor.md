# ADR-005 — O plugin é o coletor de código; o indexer é dependência do cliente

**Status:** aceito
**Data:** 2026-10-14
**Origem:** PRD §3 (delta 0.2), memtier `BACKLOG.md` §"Fora do escopo do daemon" (2026-10-07), spike 010 (F16, 2026-10-10)

## Contexto

O PRD 0.1 dizia, nos não-objetivos:

> - Indexar o repositório (é do `rust-ast-indexer`).

A frase é verdadeira mas **incompleta**. A cadeia de RAG de código tem **três**
papéis, e o PRD cobria só um:

| Papel | Quem faz | Onde estava documentado |
|---|---|---|
| Extrair símbolos/chunks/arestas | `rust-ast-indexer` | `rust_indexer/doc/protocol.md` |
| Armazenar e buscar | memtier | `memtier` ARCH §2 |
| **Coletar eventos e sincronizar** | **ninguém** | **em lugar nenhum** |

O memtier explicitou a divisão ao remover a epic E8 do seu escopo
(`BACKLOG.md`, 2026-10-07):

> **E8 — Substrato de código**: o `rust-ast-indexer` roda no **cliente** (plugin)
> em produção, não no daemon. O que passa a ser do consumidor: **rodar o indexer,
> agrupar eventos por arquivo (estado completo — `chunks: []` = delete) e chamar o
> sync**; premissa ≤1 `FullFile`/`Contextual` por arquivo vira obrigação do emissor.

E o spike 010 confirmou que **esse coletor não existe** (`010-navegabilidade-codigo/README.md`):

> **O collector** (quem pega os eventos do indexer e chama o sync) **não existe**
> — a re-medição usou um cliente de probe. Inclui a detecção de **arquivos
> removidos** (A1 do F16), que exige `chunks: []` explícito.

Consequência: o épico E3 (Injeção de código) do plugin estava pendurado num grafo
de código que ninguém popula. O PRD descrevia a **saída** (`/v1/code/search`) sem
nunca descrever a **entrada** (`/v1/code/sync`).

## Decisão

**O plugin é o coletor. O `rust-ast-indexer` é uma dependência de runtime do
cliente, distribuído como binário externo de caminho configurável.**

1. O plugin **não** reimplementa parsing/chunking. Ele **spawna** o binário do
   indexer (`code_index.indexer_bin`) e consome o protocolo JSONL em stdio.
2. O plugin **traduz** os eventos para o contrato do memtier:
   - `chunk_emitted` → `files[{file_path, language, chunks[]}]`
   - `import_edge` / `call_edge` → `edges[]`
   - arquivos que sumiram do repo → `chunks: []`
3. O plugin chama `POST /v1/code/sync` (202) — **fora do caminho crítico do turno**.
4. O binário é **externo e configurável**, não empacotado no plugin.

## Alternativas consideradas

| Alternativa | Motivo da rejeição |
|---|---|
| Empacotar o binário no plugin | complexidade de release multi-arch/versionamento; o dono escolheu binário externo configurável |
| Mover a coleta para o memtier | contraria a decisão de escopo do próprio memtier (E8 removida, 2026-10-07); o daemon não deve executar o indexer em produção |
| Reimplementar parsing no plugin | duplica o indexer; viola NFR-06 (plugin fino) e o princípio de responsabilidade única |
| Usar o modo `--mcp` do indexer | acopla dois protocolos MCP (indexer + memtier); o JSONL cru é o contrato estável e documentado |

## Consequências

- **Positivo:** fecha o buraco de escopo; o E3 (injeção de código) passa a ter
  uma fonte de dados explícita.
- **Positivo:** o plugin permanece fino — todo o peso (parsing, chunking) fica no
  binário; a coleta é I/O e tradução.
- **Positivo:** a lógica de mapeamento já foi validada em probe
  (`spike/010/probe_e2e_lifecycle.py`); o coletor a porta para produção.
- **Negativo:** o plugin passa a ter **duas dependências** de runtime (memtier +
  binário do indexer), com dois pontos de falha. Mitigado por degradação (FR-305).
- **Negativo:** o versionamento do binário é responsabilidade do usuário; uma
  incompatibilidade de protocolo é possível. Mitigado por `enabled` desligado por
  padrão e log de erro claro.
- **Requisito derivado:** **manifest por workspace** para detectar arquivos
  removidos (o contrato do memtier não auto-deleta) — FR-504.
- **Requisito derivado:** tratamento de **backpressure** do indexer (o protocolo é
  two-way; ler sem `resume` trava o job) — FR-508.
- **Requisito derivado:** resolução de arestas com **alvo existente** (alvo
  ausente → 422 no sync) — FR-505.
- **Achado (2026-10-14):** o `rust_indexer` **não tem watch mode** — não há crate
  de watch no `Cargo.toml` (`notify`/`inotify`/`hotwatch`), o protocolo tem 9
  comandos e nenhum é `watch`, e o `cli/args.rs` só aceita `--mcp`/`--quiet`. O
  único modo incremental é `incremental_index` com `use_git`/`git_range` (diff
  por git). **Consequência:** a detecção de mudança é do plugin — trigger
  híbrido (full no 1º uso, incremental com `git_range` depois), e mudanças
  **não-commitadas** não entram no MVP (o modo git não as pega).

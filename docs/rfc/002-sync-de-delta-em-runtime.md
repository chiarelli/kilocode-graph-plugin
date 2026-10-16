# RFC-002 — O delta de código é coletado só no boot (não há sync incremental em runtime)

**Status:** **implementado** (Opção A — sync de delta em runtime) · **Data:** 2026-10-16
**Decisão:** [ADR-011](../adr/011-gatilho-do-delta-em-runtime.md) (hook git
pós-commit + CLI standalone) · **Spec:** [`specs/e3a-s6-stories.md`](../../specs/e3a-s6-stories.md)
· **Ticket:** `E3a-S6` (**fechado**: S6a–S6d implementadas; E2E
`tests/e2e/test_e2e_runtime_delta.test.ts` verde)
**Autor:** verificação empírica (workspace `workspace-8af22c44`, programa `graphplugin`)
**Componentes afetados:** este plugin (`src/hooks/collect.ts`, `src/index.ts`, `src/index/trigger.ts`)
**Relacionados:** [ADR-005](../adr/005-plugin-e-o-coletor.md) (o plugin é o coletor), [ADR-007](../adr/007-gatilho-da-ingestao.md) (gatilho da **ingestão** de memória — não do código), [RFC-001](001-navegacao-e-integridade-do-grafo-de-codigo.md)

## Resumo

A coleta de código (`collectCode`) é disparada **apenas no boot** do plugin. Não
há watcher, timer, nem hook de evento que a reexecute enquanto o Kilo está
aberto. Consequências:

- Se o usuário commitar enquanto o Kilo está aberto, o grafo **não** é atualizado
  até o próximo boot.
- Mudanças **não commitadas** nunca entram (o modo incremental usa
  `git diff` **entre commits**).
- Deleção de arquivo só é propagada no **full** (não no incremental).

**Contra-achado (corrige um registro do BACKLOG):** o `incremental_index` do
`rust-ast-indexer` **não** aliasa para `index_path` — ele **executa** `git diff
--name-only <from> <to>` de verdade. Verificado com o binário real (ver §Anexo).
O mecanismo de delta **existe e funciona**; o que falta é **dispará-lo em
runtime**, não implementá-lo.

Este RFC pede: (a) confirmar a limitação como decisão ou corrigi-la; (b) se for
para mudar, abrir ticket para o sync de delta em runtime.

---

## 1. Achado — o gatilho da coleta é o boot

### Evidência no código

Há **um único** call site de `collectHook` em todo o `src/`:

```
src/index.ts:143   void collectHook({ cfg: config.code_index, repoRoot: dir, ... })
```

E ele está no corpo de `plugin()` — o `server()` do plugin —, executado **uma
vez** no carregamento. Comentário no próprio código (`src/index.ts:140-142`):

> // Coleta de código (E3a): dispara no boot, **fora do turno** (FR-510). O
> // `collectCode` nunca lança e roda em background; não é drenado no shutdown

Os hooks que o plugin retorna (`src/index.ts:185-224`) são: `messages.transform`
(injeção), o `event` da **ingestão** de memória (`message.updated`/`session.idle`,
E4), e `dispose`. **Nenhum** deles chama a coleta de código.

Busca por mecanismos de reexecução em `src/` (excluindo testes): **nenhum**
watcher (`fs.watch`/`chokidar`), **nenhum** `setInterval`. Os únicos `setTimeout`
são o timeout de job do runner (`runner.ts:187`) e o `AbortSignal.timeout` do
health — nada recorrente.

### Evidência no log vivo

No log do plugin (`/tmp/kilocode-graph-plugin.log`), as linhas `collect` do
**processo real** aparecem **imediatamente após cada boot** e nunca entre boots:

| Boot | `collect` do processo real |
|---|---|
| `02:00:10` | `02:00:11 collect indexer_ms=1164 files=0 … sync=skipped` |
| `02:10:39` | `02:10:40 collect indexer_ms=518 files=0 … sync=skipped` |

Entre `02:00:11` e `02:10:39` (10 minutos de sessão ativa, com turnos de conversa
pertencendo ao mesmo processo) **não há uma única linha de `collect`** — o
`collectCode` não roda no `session.idle` nem no `message.updated`. (As outras
linhas `collect` do log são de `tests/collect.test.ts` e de instâncias de teste;
as do processo real são só as duas acima, ambas coladas ao boot.)

### Efeito prático

Neste workspace, o boot de `01:03` rodou o **full inicial**
(`files=254 edges=3825 upserted:342`). Todos os boots seguintes dão
`files=0 … sync=skipped` porque `manifest.last_git_head == git rev-parse HEAD`
(nenhum commit novo desde a indexação). Um commit feito com o Kilo aberto só
entraria no grafo no próximo boot.

---

## 2. Achado — o incremental pega só o que está **commitado**

`decideTrigger` (`src/index/trigger.ts:26`) decide:

- 1º uso (manifest vazio ou sem `last_git_head`) → **full** (`index_path`).
- Depois → **incremental** com `git_range: { from: last_git_head, to: "HEAD" }`.

O `incremental_index` do indexer roda (confirmado, §Anexo):

```
git diff --name-only <last_git_head> HEAD
```

Ou seja, o delta é **por commit**. **Mudança não commitada não entra** — está
documentado como limitação deliberada do MVP (`trigger.ts:9-10`, FR-507):

> Mudanças não-commitadas ficam de fora do MVP (o modo git não as pega —
> FR-507/§10).

Isso significa que, mesmo que a coleta fosse reexecutada em runtime, um arquivo
salvo e **não commitado** continuaria fora do grafo até ser commitado **e** um
novo `collect` rodar.

---

## 3. Achado — deleção só é propagada no full

`collect.ts:178-184`: `removed` só é calculado quando `mode === "full"`. No
incremental, `removed = []` (comentário registra o defeito que motivou isso:
tratar o stream incremental como estado completo apagaria todo o inalterado).
Consequência: **um arquivo deletado entre dois commits não sai do grafo** até o
próximo full.

Nota: o full só acontece quando o manifest é perdido/1º uso. Numa operação normal
(manifest persistido), **nunca há full de novo** — então deleções podem ficar
órfãs indefinidamente. (`README.md` §Não-objetivos e o BACKLOG já registram que
"esvaziar repo não limpa o grafo"; este RFC acrescenta que **deletar um único
arquivo** também fica preso.)

---

## 4. Contra-achado — `incremental_index` **não** aliasa para `index_path`

O BACKLOG (§"Pendências conhecidas de contrato", item 1, `BACKLOG.md:284-286`)
afirma:

> o `rust-ast-indexer` **não emite** evento de remoção, e `incremental_index`
> **aliasa para `index_path`** (recebe lista explícita — não roda `git diff`),
> então o indexer nunca saberá os removidos.

A parte do **evento de remoção** procede. Mas a afirmação de que
`incremental_index` aliasa para `index_path` e **não roda `git diff`** está
**incorreta** na versão atual do indexer. Evidência:

- Código: `cli/mod.rs:384` chama `crate::infra::git::get_git_diff_files(&path, from, to)`,
  que executa `git diff --name-only from to` (`infra/git.rs:66-75`).
- O `explicit_files` resultante é honrado por `index_path_parallel`
  (`application/indexer.rs:128`), que parseia **apenas** essa lista.
- **Prova com o binário real** (`rust_indexer/target/release/rust_indexer`): repo de
  teste com 2 arquivos, commit alterando **só `src/b.go`**, então
  `incremental_index` com `git_range` de `HEAD1`→`HEAD2`:

  ```
  "event":"job_started"   1
  "event":"file_listed"   1     ← só b.go
  "event":"chunk_emitted" 2     ← só símbolos de b.go
  "file":"src/b.go"       2
  "processed":2
  ```

  `src/a.go` **não** apareceu — o diff foi aplicado. O delta incremental
  **funciona**.

**Implicação:** o mecanismo para atualizar o grafo de forma incremental **já
existe** (git range). O que falta para "sync do delta em runtime" é apenas o
**gatilho** dentro da sessão — não uma reimplementação do diff.

---

## 5. Propostas

> **Decidido (2026-10-16):** **Opção A** — sync de delta em runtime, via **hook
> git pós-commit** (não `session.idle`) + **CLI standalone** + **sentinela
> `.kilo/graph-ready`** + **guarda de ancestralidade** + **removidos no
> incremental**. Ver [ADR-011](../adr/011-gatilho-do-delta-em-runtime.md) e a spec
> [`specs/e3a-s6-stories.md`](../../specs/e3a-s6-stories.md). As opções abaixo
> ficam registradas como histórico.

### Opção A — escopo: sync de delta em runtime (recomendada, se o dono quer)

Adicionar um gatilho que reexecute `collectCode` durante a sessão, com
**debounce** e sempre fora do turno (nunca `await`). Candidatos de gatilho (os
hooks que o Kilo já oferece — ver `SPIKE-FINDINGS.md` §"Kilo Code — validado"):

| Gatilho | Prós | Contras |
|---|---|---|
| `event` de `session.idle` (reusar o da E4) | já usado; marca fim de turno; baixo custo | só cobre fim de turno, não commit |
| Hook de tool (ex.: após `bash`/git) | pega o commit no momento | acopla ao uso de terminal |
| `fs.watch` / timer (polling do HEAD) | pega commit mesmo sem turno | novo subsistema; risco de custo/latência |

Numeração sugerida: **E8 — Sync de delta em runtime** (ou E3a-S6).

Critérios de aceite mínimos (qualquer gatilho):
1. `collectCode` reexecuta **sem reiniciar o Kilo** após um commit.
2. A reexecução é **fora do turno** (FR-510) e **não bloqueia** a UI (o freeze
   já diagnosticado não pode voltar — ver ADR-005 e o fix do deadlock).
3. **Debounce** por HEAD: N chamadas no mesmo HEAD ⇒ 1 job (o manifest já dá o
   `last_git_head` para comparar antes de spawnar).
4. **Mudanças não commitadas**: decidir explicitamente — ou documentar "só
   commitado" (mantém o MVP), ou estender para `git diff --name-only <head>`
   (working tree) num passo separado.
5. **Deleção**: tratar removidos também no incremental (ou rodar um full
   periódico) — hoje o incremental não emite removidos.
6. Log de observabilidade (`collect indexer_ms=… files=… sync=…`) por execução.

### Opção B — manter só no boot (aceitar e documentar)

Se a decisão for manter, registrar explicitamente no PRD/README que a coleta de
código é **somente no boot**, e que commit com o Kilo aberto só entra no grafo
após reiniciar. Hoje isso está implícito (não é um "não-objetivo" declarado).

### Opção B é inconsistente com o resto do produto

A **ingestão de memória** (E4) é explicitamente acordada por eventos
(`message.updated`/`session.idle`) em runtime (ADR-007). A coleta de código
sendo a **única** parte do plugin que só roda no boot é uma assimetria
provavelmente acidental, não uma decisão desenhada.

---

## Anexo — como os achados foram verificados

- **Gatilho:** `grep` de todos os call sites de `collectHook`/`collectCode` em
  `src/` (1 call site), leitura de `src/index.ts:140-224` (hooks retornados),
  busca por watchers/timers em `src/` (nenhum), e correlação
  boot↔`collect` no log vivo do processo real.
- **Incremental por commit:** leitura de `src/index/trigger.ts` e
  `infra/git.rs::get_git_diff_files`.
- **`incremental_index` funcional (contra-achado):** execução do binário real
  (`rust_indexer/target/release/rust_indexer`) contra um repo de teste com commit de 1
  arquivo; eventos JSONL mostram `file_listed`/`chunk_emitted` apenas do arquivo
  alterado.

## Encaminhamento

| Item | Dono | Ação |
|---|---|---|
| 1. Definir: runtime delta ou boot-only | dono | ✅ **decidido: Opção A** (runtime), via hook git — [ADR-011](../adr/011-gatilho-do-delta-em-runtime.md) |
| 2. Se A: **ticket de sync de delta em runtime** | este plugin | ✅ **implementado**: `E3a-S6` (S6a–S6d) — CLI standalone + hooks git; E2E verde |
| 3. Corrigir o BACKLOG | este plugin | ✅ feito (o item afirma que `incremental_index` não roda `git diff` — falsificado) |
| 4. Deleção no incremental | este plugin | ✅ **implementado**: removidos no incremental (`git diff --no-renames --diff-filter=D` → `chunks: []`), na S6a |

## Fechamento (2026-10-16)

Implementado por [`E3a-S6`](../../specs/e3a-s6-stories.md) (S6a–S6d), na ordem
declarada. Resumo do entregue:

- **S6a** — CLI standalone (`src/cli.ts`), instalador de hooks
  (`src/index/install-hooks.ts`), trava cross-process (`src/index/lock.ts`),
  porta de git (`src/index/git.ts`); o boot **invoca o CLI em `auto`** e instala
  os hooks (não coleta). Paridade de config boot×CLI (§7).
- **S6b** — `--workspace` resolvido em runtime (`--show-toplevel`) para
  worktrees; degradações (não-git, indexer vazio, manifest corrompido→full,
  working tree fora, trava CLI×CLI).
- **S6c** — observabilidade: `formatCollectLine` com
  `source`/`mode`/`trigger`/`indexer_ms`/`files`/`edges`/`removed`/`sync`.
- **S6d** — E2E gated `test_e2e_runtime_delta`: um `git commit` REAL atualiza o
  grafo (incremental) e um `git rm` faz o arquivo sair (`chunks: []`).

A RFC-001 (navegação/`import (`/`uuid`) permanece fora deste escopo (outro dono).

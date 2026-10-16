# E3a-S6 — Sync de delta em runtime (hook git pós-commit + CLI standalone)

**Data:** 2026-10-16
**Fonte:** [RFC-002](../docs/rfc/002-sync-de-delta-em-runtime.md) · ticket `E3a-S6`
(`BACKLOG.md`) · [ADR-011](../docs/adr/011-gatilho-do-delta-em-runtime.md) (decisão)
· `specs/e3a-stories.md` (base do coletor, E3a-S1..S5)
**Depende de:** E3a-S1..S5 (coletor completo) · `rust-ast-indexer` (binário) ·
git no cliente.
**Protocolo:** tracer bullet — S6a é a fatia vertical mínima (hook → CLI →
incremental → sync); S6b–S6d **endurecem a mesma base, sem rewrite**.
**Status:** **especificado, não implementado.**

---

## Problema

A coleta roda **só no boot** (`src/index.ts:143`, único call site; nenhum
watcher/timer). Commit com o Kilo aberto não entra no grafo; deleção fica órfã
indefinidamente. Ver [RFC-002](../docs/rfc/002-sync-de-delta-em-runtime.md) para a
evidência medida.

Decisões fixadas no [ADR-011](../docs/adr/011-gatilho-do-delta-em-runtime.md):
gatilho = **hook git** (não evento do plugin); **sem** `core.hooksPath`; **CLI
standalone**; **sentinela** `.kilo/graph-ready`; guarda de **ancestralidade**;
removidos **no incremental**; delta **por commit** (não-commitado fica fora).

---

## Decisões de design fixadas nesta decomposição

### 1. Instalação de hook — idempotente, sem `core.hooksPath`

- Diretório resolvido por `git rev-parse --git-path hooks` (honra `core.hooksPath`
  e worktrees). **Atenção:** esse comando devolve caminho **relativo ao
  worktree** (ex.: `.husky`); resolver contra a raiz do repo antes de escrever.
  **Não** setar/alterar `core.hooksPath` (é excludente).
- Hooks: `post-commit` + `post-checkout` + `post-merge` + `post-rewrite`.
- **Criar só se não existir.** Se já existe (de outro dono), **não** toca: loga e
  segue. O script do plugin carrega uma **linha-marcadora** (`# kilocode-graph`)
  para reconhecer os próprios sem confundir com o do usuário.
- Nada disso no caminho crítico do boot: roda em background, nunca `await`.

### 1b. O CLI é o único escritor do grafo; o plugin só invoca

- **Decisão:** o CLI assume **full E incremental**. O plugin **não coleta** — no
  boot ele **invoca o CLI em `auto`** (background) e instala os hooks. Elimina a
  divergência "manifest em memória (plugin) × manifest em disco (CLI)" e a corrida
  de escrita no fim do sync.
- **O boot mantém o trigger HÍBRIDO (E3a-S4):** `auto` = `full` no 1º uso,
  `incremental` depois (manifest + guarda de ancestralidade decidem). **Não** é
  `full` fixo — reindexar o repo inteiro a cada boot regrediria o custo e
  contradiria o comportamento já testado.
- O CLI **chama `collectCode`** (função já testada). A lógica de coleta **não** é
  movida para o CLI: só o **gatilho** sai do plugin. `collectCode`/
  `tests/collect.test.ts` permanecem; o que muda é **quem invoca**.
- **Não** serializa invocações — boot e commit são processos distintos (§3b).

### 2. CLI standalone

- Entry: `src/cli.ts` invocável por `node <plugin>/src/cli.ts` (Node ≥22,
  type-stripping — `main: src/index.ts` já depende disso).
- Recebe `--workspace <repo-root>` **explicitamente** (o hook o passa), resolve
  daí: config (`<ws>/.kilo/graph-plugin.json`), workspace
  (`config.daemon.workspace || workspaceName(dir)`), chave
  (`resolveTokenFile`). **Reusa** `loadConfig`/`resolveWorkspaceDir`-equivalente/
  `resolveTokenFile` — não reimplementa regra.
- Modo: `--mode auto` (boot **e** hook; decide por manifest + ancestralidade, §4).
  O boot usa `auto` (híbrido, §1b) — **não** `full` fixo.
- **Fire-and-forget** a partir do hook (detached, não bloqueia o commit).
- Nunca lança para o hook: erro vira exit code + linha de log.
- **Execução do hook (shell):** o script gerado roda no ambiente do `git` — (a) o
  **caminho do `node` é embutido absoluto** no script no momento da geração (não
  confiar no `PATH` do git, que pode não incluir o gerenciador de versão do
  usuário); (b) o processo é destacado (`... >/dev/null 2>&1 &` + `disown`) para o
  git **  não** esperar o CLI — sem isso o commit trava até o fim da indexação.
- **Paridade de config com o boot (§7).**

### 3. Gate do sentinela `.kilo/graph-ready`

- Como o CLI é o **único escritor** (§1b), o **boot invoca o CLI em `auto`**; ao
  concluir com sucesso, **o CLI escreve** `graph-ready`.
- O CLI **só inicia um incremental** se `graph-ready` existir. Sem ele: exit 0 com
  log `collect: aguardando sync inicial`. (O `full` do 1º uso não exige o
  sentinela — ele é quem o cria.)
- Fecha a corrida: commit durante o full inicial não dispara um segundo full
  concorrente.

### 3b. Trava cross-process + tmp por processo

- Boot e post-commit são **processos SO distintos** (o plugin spawna o CLI; o git
  spawna o CLI). A serialização é uma **trava cross-process** (lockfile `O_EXCL` +
  retry) em torno de **load manifest → index → sync → save**. A trava em memória
  do repo (`withWorkspaceLock`, `routine.ts:81`) **não** cobre dois processos.
- Lockfile: `<ws>/.kilo/graph.lock`. **Timeout** finito (ex.: 30s) e, ao estourar,
  desiste com log (nunca espera indefinidamente). **Lock órfão** (processo morto):
  se o lock tem mtime mais velho que o timeout, é considerado stale e removido
  (retoma com log). O lock é `O_EXCL` + escrita do `pid`.
- `manifest.ts`: tmp **por processo** (`` `${path}.tmp.${pid}` ``) — o tmp fixo
  atual faz o `rename` do perdedor falhar (`ENOENT`) e o erro é engolido (só
  `debug`), perdendo estado em silêncio. O `provision.ts` já usa `.tmp.${pid}`.
- `.gitignore`: `graph-ready` e `graph.lock` entram no `.gitignore` (o default já
  cobre `.kilo/*`, mas confirmar; não versionar estado local).

### 4. Guarda de ancestralidade

```
git merge-base --is-ancestor <last_git_head> HEAD
  ├ 0 (ancestral) → incremental  (git_range from=last_git_head to=HEAD)
  └ ≠0            → full
```

Cobre checkout para trás, rebase e divergência. Vive **no CLI** (que é o único que
decide o modo), no modo `auto` — usado tanto pelo boot quanto pelo hook. O
`decideTrigger` passa a incorporar a guarda (hoje decide só pela presença de
`last_git_head`).

### 5. Removidos no incremental

- Deleções: `git diff --name-only --diff-filter=D <from> <to>`.
- Entram na lista `removed` do `buildSyncBody` (`chunks: []`), como no full.
- Sem isso, o indexer emite **chunk vazio** para o arquivo deletado (medido) e o
  grafo cria um nó fantasma.

### 6. Concorrência entre CLI e boot

Ver §3b (trava cross-process) — o sentinela cobre a corrida **do primeiro** full; a
trava cobre deltas concorrentes depois (e faz o coalescing: o 2º incremental pega o
próximo commit).

### 7. Paridade de config boot × CLI (a mesma `Config`)

`loadConfig(options, dir)` tem precedência **`options` (do `kilo.jsonc`) > env >
arquivo > default** (`config.ts:4`). O `options` é o **2º elemento da tupla do
plugin**:

```
"plugin": [ [ "<path>", { "enabled": true } ] ]
```

O **CLI standalone não tem esse objeto**. Se o usuário puser config **só no
inline**, o boot a vê e o CLI não → **divergência** (ex.: `code_index.indexer_bin`
no inline ⇒ boot acha o binário, CLI não ⇒ delta no-op silencioso).

**Contrato fixado:** o CLI resolve a **mesma `Config`** por uma das duas vias:

- **(preferida) Config como dado persistido.** No boot, o plugin grava a `Config`
  efetiva (resolvida, com `options` aplicado) em `<ws>/.kilo/graph-config.json`
  (estado local, não versionado); o CLI a lê. Elimina a classe de divergência por
  construção — uma fonte.
- **(alternativa) Inline repassado no script.** O instalador embute o `options` no
  script do hook (ex.: `--options '<json>'`). Mais simples, mas o script carrega
  segredo/config e precisa regenerar quando o inline muda.

O CLI **não** resolve `options` por conta própria (não tem de onde). Segredos
(`daemon.token`) **nunca** vão para o arquivo de config persistido — só a chave do
workspace (`graph-key.json`, já existente) carrega token.

> **Decisão de implementação (S6a):** usar a via **preferida** (config persistida)
> é o default; a alternativa fica registrada caso a persistida mostre atrito.

---

## Stories

### E3a-S6a — Tracer bullet: post-commit → CLI → incremental → sync

**Objetivo:** um commit com o plugin aberto atualiza o grafo, sem reiniciar.

**Entregável:**
- `src/cli.ts` (novo): parse de `--workspace`/`--mode auto` (default), bootstrap
  standalone (**config por §7**), guarda de sentinela + ancestralidade, **chama
  `collectCode`** (função existente) → grava manifest, escreve `graph-ready` ao
  concluir o full. `TODO(tracer-bullet):` para os gaps mínimos.
- `src/index/install-hooks.ts` (novo): gera os scripts em
  `git rev-parse --git-path hooks` (resolvendo o caminho relativo), idempotente,
  com linha-marcadora.
- `src/index.ts`: no boot **invoca o CLI em `auto`** (background) e chama
  `installHooks` — **não** coleta direto (§1b).
- `src/config.ts`: grava a `Config` efetiva em `<ws>/.kilo/graph-config.json` (§7).
- `src/index/manifest.ts` + gatilho de coleta: trava cross-process (`O_EXCL`) e tmp
  por processo (§3b).

**Testes:**

| Teste | Caso | Esperado |
|---|---|---|
| `install_hooks_creates_when_absent` | dir vazio | 4 scripts com marcador |
| `install_hooks_noop_when_exists` | script do usuário presente | **não** sobrescreve; preserva conteúdo |
| `install_hooks_idempotent` | roda 2× | segundo run inalterado |
| `cli_aborts_without_ready` | sem `graph-ready` | exit 0, log, sem spawn |
| `cli_ancestor_incremental` | `last` ancestral de HEAD | `incremental` + `git_range` |
| `cli_non_ancestor_full` | checkout antigo | `full` |
| `cli_removed_files` | `git rm` + commit | arquivo deletado em `removed` (`chunks: []`) |
| `cli_workspace_from_arg` | `--workspace <iso>` | lê `<iso>/.kilo/*`, não cwd |
| `cli_config_parity` | inline vs persistida | CLI usa a MESMA config do boot (§7) |
| `cli_boot_writes_ready` | `--mode auto` conclui o full | `graph-ready` criado |
| `cli_lock_serializes_two_procs` | 2 CLIs concorrentes (spawn real) | 1 espera; manifest íntegro |
| `cli_lock_stale_reclaimed` | lock órfão (pid morto) | stale detectado; retoma |

**Critério de aceite:** commit real com o plugin aberto → delta no grafo; log
`collect indexer_ms=… files=… sync={…}`.

### E3a-S6b — Endurecer instalação e robustez do CLI

**Entregável:**
- Worktree/`--git-common-dir`: instalar no lugar certo.
- `post-merge`/`post-rewrite`/`post-checkout` cobertos (ff-merge e rebase entram).
- Degradação: repo não-git, `indexer_bin` ausente, `graph-ready` presente mas
  manifest corrompido (→ full), key ausente (→ 401 do caminho de sempre).
- Trava por workspace (CLI × boot; CLI × CLI).

**Testes:** `install_hooks_worktree_path`, `install_hooks_no_git_noop`,
`cli_corrupt_manifest_forces_full`, `cli_lock_serializes_two_runs`,
`cli_non_committed_stays_out`.

### E3a-S6c — Abrir o delta à observabilidade (base do E7)

**Entregável:** linha de log por execução do CLI
(`{collect, source:"post-commit", indexer_ms, files, edges, removed, sync:{…}}`),
distinguível do boot; marca o delta como `incremental`/`full` e o gatilho.

### E3a-S6d — Fechamento

- E2E gated: repo de teste real, commit via `git` spawnado, delta no grafo.
- Docs: README/`ARCHITECTURE.md`/`src/README.md`; remover
  `TODO(tracer-bullet)`; marcar RFC-002/`E3a-S6` como fechados.
- `specs/e3a-stories.md` §6 (`trigger.ts`) alinhado à guarda de ancestralidade.

---

## Fora de escopo do E3a-S6

- Mudanças **não-commitadas** (working tree) — permanece a limitação FR-507.
- Encadear hook **do usuário** do mesmo nome (hoje é "não tocar"; encadear é
  trabalho futuro).
- `core.hooksPath` gerenciado.
- Full periódico (a deleção incremental o torna desnecessário no caso comum).
- Outras linguagens de parse (herda de E3a).

---

## Critérios de aceite da epic

1. Commit com o plugin aberto atualiza o grafo **sem reiniciar** o Kilo.
2. A execução é **fora do turno** (nunca bloqueia) e **não bloqueia o commit**
   (hook detached).
3. **Sem trabalho desnecessário:** se o HEAD não mudou, o CLI não spawna o
   indexer (guarda de ancestralidade/HEAD).
4. **Ancestralidade:** nunca roda incremental com range inválido (→ full).
5. **Sentinela + trava:** nunca dispara antes do full inicial; duas invocações
   concorrentes (processos distintos) não corrompem o manifest.
6. **Deleção** propagada no incremental.
7. typecheck limpo; unit verde; E2E gated verde; zero `TODO(tracer-bullet)`.

---

## Histórico de revisão

- **2026-10-16** — criada por [RFC-002](../docs/rfc/002-sync-de-delta-em-runtime.md)
  + [ADR-011](../docs/adr/011-gatilho-do-delta-em-runtime.md); decisões do dono
  (hook git, sem `core.hooksPath`, CLI standalone, sentinela) fixadas.
- **2026-10-16 (b)** — decisão do dono: **o CLI é o único escritor** (assume full
  e incremental; o plugin só invoca no boot). Adicionadas §1b e §3b: a corrida é
  **entre processos** — trava cross-process (`O_EXCL`) + tmp por processo no
  manifest; a trava em memória do repo não cobre dois processos.
- **2026-10-16 (c)** — auditoria de prontidão. Corrigido: boot usa `--mode auto`
  (híbrido, **não** full fixo — decisão do dono); `collectCode` **preservado** (o
  CLI o chama; só o gatilho muda); §7 paridade de config boot×CLI; lockfile com
  timeout/stale; `--git-path hooks` relativo; `.gitignore` do sentinela/lock.
- **2026-10-16 (d) — S6a implementada + revisão adversarial (BLIND-HUNTER /
  EDGE-CASE-HUNTER / VERIFICATION-GAP).** Defeitos corrigidos na mesma base:
  (1) **CRÍTICO** — o script do hook não passava `--workspace`, então TODO gatilho
  saía com exit 2 (delta morto); agora o repo root é embutido (com escape de
  shell) e há teste que **executa o script real** contra um CLI stub;
  (2) **lock stale** — o mtime condenava um full vivo (>30s) e um 2º CLI roubava a
  trava; a detecção de órfão passou a ser por **processo morto** (`kill(pid,0)`),
  com mtime só como fallback folgado (10 min), e erro de fs não-EEXIST desiste já;
  (3) **TOCTOU de HEAD** — resolvido UMA vez (SHA concreto) e usado em
  ancestralidade/`git_range`/`diff`/`save`; (4) **renames** — `deletedFiles` usa
  `--no-renames` (a origem conta como removida); (5) **nó fantasma** — o git vence
  o chunk do indexer para arquivo deletado (eventos filtrados) e o manifest não o
  ressuscita; (6) **full vazio** ainda grava HEAD e arma `graph-ready`;
  (7) hook próprio é **regenerado** quando os caminhos embutidos mudam;
  (8) troca de identidade de workspace força full. `spawnCollectCli` ganhou
  listener de `error`; `parseArgs` recusa flag como valor.
- **2026-10-16 (e) — S6b (endurecimento).** `install-hooks.ts`: o `--workspace`
  do script é resolvido em **runtime** por `git rev-parse --show-toplevel` (com
  fallback embutido) — em repo com **worktrees** o `git rev-parse --git-path
  hooks` devolve o hooks dir **comum** (compartilhado), e um caminho estático
  indexaria o worktree errado (medido: o hook roda com cwd = raiz do worktree).
  Degradações cobertas por teste: repo não-git (no-op), `indexer_bin` vazio
  (skipped, sem sync), manifest corrompido ⇒ full, working tree sujo fica fora
  (FR-507), e trava por workspace (`CLI × CLI`). Preservado o tmp por processo.

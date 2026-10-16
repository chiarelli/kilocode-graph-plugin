# ADR-011 — Gatilho do delta em runtime: hook git pós-commit + CLI standalone

**Status:** proposto
**Data:** 2026-10-16
**Origem:** [RFC-002](../rfc/002-sync-de-delta-em-runtime.md) — a coleta de código
só roda no boot; commit com o Kilo aberto não entra no grafo. Fecha o gate A/B do
ticket `E3a-S6`. Complementa o **ADR-005** (o plugin é o coletor) — não o
contraria: o gatilho é do plugin, o indexer continua dependência do cliente.
**Relacionados:** [ADR-007](007-gatilho-da-ingestao.md) (precedente de gatilho por
evento), [ADR-010](010-fonte-do-kilo-db.md) (boot sem rede).

## Contexto

A coleta (`collectCode`) é disparada **apenas no boot** (`src/index.ts:143`): há
**um único** call site e **nenhum** watcher/timer em `src/`. Entre boots, um
commit não entra no grafo; um arquivo deletado fica órfão indefinidamente (o
`full` só recorre quando o manifest é perdido). Medido no RFC-002.

Três fatos verificados empiricamente definem o desenho:

1. **O incremental funciona.** `incremental_index` roda `git diff --name-only
   <from> <to>` de verdade (não aliása `index_path`).
2. **Ancestralidade importa.** Numa volta a uma branch antiga (`last_git_head`
   **não** é ancestral de `HEAD`), `git diff <last> HEAD` vira um diff **reverso**
   e o indexer emite, para o arquivo que sumiu do disco, um `chunk_emitted` de
   **texto vazio** — **não** uma remoção. O coletor então o envia como arquivo
   presente, corrompendo o grafo.
3. **Remoção nunca é emitida no incremental.** Nem no movimento para frente
   (`git rm` + commit): o indexer lista o arquivo deletado e emite chunk vazio
   (`--diff-filter=D` existe no git, o indexer não o usa). Deleção só é propagada
   no `full`, via o manifest (`removedFiles`).

Além disso, o objeto de hooks do plugin tem **uma chave por nome**: hoje `event`
já é ocupado pela ingestão (E4). Um gatilho de coleta por `session.idle`
**colidiria** com a E4 (um sobrescreveria o outro) — e `session.idle` mede
**1×/ociosidade** (`TRIGGER-INGESTAO.md`), insuficiente para capturar cada commit.

## Decisão

**O gatilho do delta em runtime é um hook git, não um evento do plugin.**

### 1. Instalação idempotente de hook git no boot — **sem** `core.hooksPath`

No boot, o plugin:
- resolve o diretório de hooks por `git rev-parse --git-path hooks` (honra
  `core.hooksPath` existente e o `--git-common-dir` de worktrees), **sem** setar
  nem alterar `core.hooksPath`;
- para cada hook relevante (`post-commit`, `post-checkout`, `post-merge`,
  `post-rewrite`): **cria o script SÓ se não existir**; se já existir (de outro
  dono), **não** toca — loga e segue. É idempotente (identifica o próprio script
  por uma linha-marcadora e não reescreve o que já é seu).

`core.hooksPath` foi **rejeitado**: é **excludente** (com ele setado, o git
**ignora** `.git/hooks` — provado), então assumir o controle do diretório
**quebraria** husky/lefthook do usuário. Instalar em `.git/hooks` (o default) é a
opção não-invasiva.

### 2. O hook invoca um **CLI standalone** do plugin

O script gerado no boot chama `node <plugin>/src/cli.ts --workspace <repo-root>`
e passa o **caminho do workspace explicitamente** — o CLI é **standalone**: resolve
sozinho config (`<ws>/.kilo/graph-plugin.json`), workspace, e a chave
(`<ws>/.kilo/graph-key.json`), sem depender do plugin estar no ar. O caminho do
plugin é embutido no script no momento da geração (o plugin conhece o próprio
`import.meta.dirname`).

O hook roda **detached** (fire-and-forget): nunca bloqueia o commit. Saída vai
para o log do plugin.

**O CLI é o ÚNICO escritor do grafo de código.** Ele assume **full e
incremental**; o plugin **não coleta** — apenas **invoca o CLI no boot** (em
`auto`: híbrido, `full` no 1º uso / `incremental` depois) e instala os hooks.
Isso elimina a divergência de duas implementações (o manifest **em memória** do
plugin × o manifest **em disco** do CLI) e a divisão de escrita no fim de um sync.
**Não** serializa invocações concorrentes — são **processos SO separados**; a
serialização é a §3.

### 3. Sentinela `.kilo/graph-ready` + trava cross-process — o gate e o mutex

Como o CLI é o único escritor (§2), o **boot invoca o CLI em `auto`**; ao concluir
o full com sucesso, **o CLI escreve** `<ws>/.kilo/graph-ready`. O CLI **só inicia
um incremental** se o sentinela existir; sem ele, loga `aguardando sync inicial` e
sai com 0. Isso evita spawnar o indexer enquanto o full inicial ainda corre.

Mas o sentinela **não basta**: boot e post-commit são **processos SO distintos**
(o plugin spawna o CLI; o git spawna o CLI). Duas invocações concorrentes escrevem
o mesmo manifest sem coordenação. A serialização é uma **trava cross-process**
(lockfile com criação exclusiva `O_EXCL` + retry/espera) em torno da seção crítica
**load manifest → index → sync → save**.

> **A trava em memória do repo NÃO serve aqui.** (`withWorkspaceLock`,
> `src/ingest/routine.ts:81` é um `Map<string, Promise>` — serializa chamadas no
> **mesmo processo**, não dois processos Node.)

O sentinela é por workspace, em `.kilo/` (estado local, como o manifest e a chave).
Com a trava, o coalescing é natural: um 2º incremental espera o 1º (que já avançou
`last_git_head`) e captura o próximo commit sem trabalho duplicado.

### 3b. `manifest.ts` — tmp por processo

O `saveManifest` grava com tmp **fixo** (`` `${path}.tmp` ``); sob dois processos, o
`rename` do perdedor falha com `ENOENT` e o erro é engolido (só `debug`) — **estado
perdido em silêncio**. Com o CLI escrevendo em boot **e** em cada commit, a janela
cresce. Corrigir para tmp **por processo** (`` `${path}.tmp.${pid}` ``), como o
`provision.ts` **já faz** (`.tmp.${pid}`, verificado).

### 4. Guarda de ancestralidade — `merge-base --is-ancestor`

Antes de decidir incremental, o CLI verifica:

```
git merge-base --is-ancestor <last_git_head> HEAD
  ├ verdadeiro → incremental   (from=last_git_head, to=HEAD)
  └ falso      → full          (reindexa; cobre checkout para trás, rebase, divergência)
```

Isso é o "mirar sempre no HEAD" refinado: o defeito não é "não usar HEAD", é o
`last_git_head` deixar de ser ancestral. Quando não é, o incremental é inválido —
o `full` é o único caminho seguro.

### 5. Removidos no incremental

Deleção passa a ser tratada **também** no incremental: o CLI obtém os arquivos
deletados (`git diff --name-only --diff-filter=D <from> <to>`) e os injeta na lista
de `removed` do coletor (`chunks: []`). Fecha o item §3 do RFC-002 e a assimetria
com o `full`.

**Escopo do delta: por commit.** Mudanças **não-commitadas** continuam fora (o
gatilho é o commit). É a limitação já documentada (FR-507) — mantida.

## Consequências

**Positivas**

- Commit com o Kilo aberto entra no grafo sem reiniciar; o gatilho é o **commit**,
  não um timer — sem polling, sem `fs.watch`, sem custo de CPU ocioso.
- **Não colide** com o hook `event` da E4 (nenhuma chave nova no objeto de hooks).
- **Um único escritor do grafo** (o CLI): some a divergência manifest-em-memória ×
  manifest-em-disco e a corrida de escrita no fim de um sync.
- Reusa o coletor existente (`runIndexer` → `buildSyncBody` → `syncCode`); o CLI é
  uma casca fina de bootstrap headless.
- A guarda de ancestralidade elimina uma classe inteira de corrupção (checkout
  para trás / rebase), que também afeta o **boot** (o mesmo `decideTrigger`).

**Negativas / limites**

- **Precisa de trava cross-process** (lockfile `O_EXCL`): a serialização em memória
  não serve para dois processos; sem ela, boot e commit se sobrescrevem.
- **Mutação do repo do usuário** (`.git/hooks/`): não versionada, some em
  re-clone — daí a reinstalação idempotente no boot. Repos com hook próprio do
  mesmo nome **não** são encadeados nesta versão (documentado; encadeamento é
  trabalho futuro).
- **CLI reimplementa o bootstrap** (config + workspace + chave). Precisa bater
  exatamente com o boot, senão o workspace/segredo divergem — coberto por teste.
- **Nova superfície de segurança:** o hook executa um processo em cada commit.
  Mitigado por: script gerado e de propriedade do plugin, sem dados de entrada do
  usuário além do caminho do workspace.
- **Deleção ainda depende do manifest** estar correto; um manifest perdido força
  `full` (correto, mas caro).

## Alternativas descartadas

- **`core.hooksPath` gerenciado** — excludente (ignora `.git/hooks`); quebraria o
  gerenciador de hooks do usuário.
- **Gatilho por evento do plugin (`session.idle`)** — dispara 1×/ociosidade (não
  cobre cada commit) e **colide** com a chave `event` já usada pela E4.
- **CLI mínimo (workspace/config por args do hook)** — decide bootstrap fora do
  CLI; menos robusto pós-re-clone e duplica resolução. Escolhido o standalone.
- **Sem sentinela (abortar se o manifest estiver vazio)** — perderia um commit
  feito durante o full inicial (a corrida), sem recuperação até o próximo commit.
- **Serializar com a trava em memória do repo (`withWorkspaceLock`)** — não cobre
  dois processos Node (boot e git são processos distintos). Inútil aqui.
- **Watcher/`fs.watch`/polling do HEAD** — novo subsistema, custo contínuo e
  latência; o commit já é o sinal exato de mudança.

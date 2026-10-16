/**
 * Hook do coletor de código (E3a-S1) — thin.
 *
 * Dispara a coleta **fora do turno** (FR-510): roda em background
 * (`void run().catch(...)`) e nunca é `await` no caminho crítico. O gatilho é o
 * **boot** do plugin; o `trigger.ts` decide full (1º uso) vs incremental
 * (`git_range` a partir do HEAD gravado). O backpressure fica no `runner`.
 */

import {
  AuthError,
  InfraError,
  type MemtierClient,
  MemtierHttpError,
} from "../client.ts";
import { debug, log, logFatal } from "../logger.ts";
import { buildSyncBody } from "../index/collector.ts";
import type { GitPort } from "../index/git.ts";
import { acquireLock } from "../index/lock.ts";
import {
  emptyManifest,
  loadManifest,
  MANIFEST_REL_PATH,
  mergeManifest,
  removedFiles,
  saveManifest,
} from "../index/manifest.ts";
import { runIndexer, type IndexMode } from "../index/runner.ts";
import { decideTrigger, type TriggerDecision } from "../index/trigger.ts";
import { join } from "node:path";
import type { SyncResult } from "../types.ts";

/** Config do coletor (subconjunto de `code_index.*`). */
export interface CollectConfig {
  enabled: boolean;
  indexer_bin: string;
  /**
   * Fonte de arquivos via git (`load_ignores`). Ausente/`false` ⇒ varre tudo.
   * Quando `true`, o indexer exige git + repositório (senão `GIT_UNAVAILABLE`).
   */
  load_ignores?: boolean;
}

/** Dependências do hook (injetáveis para teste, sem spawn real). */
export interface CollectRuntime {
  cfg: CollectConfig;
  /** Diretório-raiz do repo (workspace resolvido). */
  repoRoot: string;
  identity: { workspace: string; program: string };
  client: Pick<MemtierClient, "syncCode">;
  /** Runner injetável (default `runIndexer`); stubado em teste. */
  run?: typeof runIndexer;
  /**
   * Estado por workspace (manifest). Injetável para teste; default é o manifest
   * real em `<repo>/.kilo/graph-manifest.json`.
   */
  state?: CollectState;
  /**
   * Porta de git (E3a-S6a). Presente ⇒ habilita a **guarda de ancestralidade**
   * (§4) e a detecção de **removidos no incremental** (`--diff-filter=D`, §5).
   * Ausente ⇒ comportamento S4 (decide só pela presença de `last_git_head`, sem
   * removidos no incremental) — é o que os testes unitários da S4 esperam.
   */
  git?: GitPort;
  /**
   * Caminho do lockfile cross-process (`<ws>/.kilo/graph.lock`). Presente ⇒ a
   * coleta serializa *load manifest → index → sync → save* (§3b). Ausente ⇒ sem
   * trava (testes unitários; o CLI de produção sempre passa o caminho).
   */
  lockPath?: string;
  /**
   * Chamado **após um sync bem-sucedido em modo full** (o full inicial é quem
   * arma o incremento): o CLI usa isto para escrever o sentinela `graph-ready`
   * (§3). Recebe o HEAD corrente. Default: no-op.
   */
  onFullComplete?: () => void;
  /**
   * Estado do sentinela `graph-ready` (§3). Presente ⇒ um **incremental** só roda
   * se `ready()` for `true`; caso contrário a coleta é abortada com log (o full
   * inicial ainda não concluiu). O `full` do 1º uso **não** é gated — é quem cria
   * o sentinela. Ausente ⇒ sem gate (testes unitários, boot legado).
   */
  ready?: () => boolean;
  /**
   * Modo forçado (`--mode full|incremental` no CLI). Ausente/`auto` ⇒ decide pelo
   * manifest + ancestralidade. `incremental` forçado ainda passa pela guarda de
   * ancestralidade: sem range válido, cai em `full` (nunca incremental inválido).
   */
  forceMode?: IndexMode | "auto";
  /**
   * Origem do disparo (observabilidade S6c): `boot` | `post-commit` |
   * `post-checkout` | `post-merge` | `post-rewrite`. Vai na linha de log por
   * execução para distinguir o delta de runtime da coleta de boot.
   */
  source?: string;
}

/** Porta de estado do coletor (manifest) — implementada por `index/manifest.ts`. */
export interface CollectState {
  /**
   * Estado atual (arquivos sincronizados + head). `workspace` é a identidade
   * gravada na última execução — se divergir da atual, o estado é de OUTRO
   * workspace e o incremental reusaria um manifest alheio (grafo incompleto).
   */
  load(): { files: string[]; last_git_head?: string | null; workspace?: string };
  /** Persiste o estado pós-sync (arquivos atuais + head). */
  save(files: string[], head: string | null): void;
}

/** Classifica a falha do sync para o log correto (nunca propaga). */
function logSyncFailure(err: unknown): void {
  if (err instanceof AuthError) {
    logFatal(`collect sync auth (${err.status})`, err);
    return;
  }
  if (err instanceof InfraError) {
    log(`collect: memtier indisponível (${err.status}); coleta abortada`);
    return;
  }
  if (err instanceof MemtierHttpError) {
    logFatal(`collect sync (${err.status})`, err);
    return;
  }
  logFatal("collect sync", err);
}

/**
 * Campos da linha de observabilidade por execução do coletor (S6c, base do E7).
 * Uma linha por execução, distinguível do boot pelo `source`.
 */
export interface CollectLogFields {
  /** Origem do disparo (`boot`/`post-commit`/…). Default `boot`. */
  source?: string;
  /** Modo efetivo (após trigger + guarda). */
  mode: IndexMode;
  /** Gatilho que decidiu o modo (`auto`/`full`/`incremental` pedido). */
  trigger?: string;
  /** Duração do job do indexer (ms). */
  indexerMs: number;
  /** Arquivos enviados no body. */
  files: number;
  /** Arestas enviadas. */
  edges: number;
  /** Removidos (`chunks: []`). */
  removed: number;
  /** Resultado do sync (ausente ⇒ não houve sync). */
  sync?: SyncResult | null;
  /** Motivo quando não houve sync (sentinela, binário, erro fatal, trava). */
  skip?: string;
}

/**
 * Monta a linha de log estruturada do coletor. **Pura e testável** (o E7 consome
 * estes campos). Formato estável `collect source=… mode=… trigger=… …` com o
 * bloco `sync={…}` quando houve sync.
 */
export function formatCollectLine(f: CollectLogFields): string {
  const source = f.source ?? "boot";
  const stats = f.sync
    ? ` sync={upserted:${f.sync.upserted},deleted:${f.sync.deleted},` +
      `changed:${f.sync.changed},skipped:${f.sync.skipped}}`
    : f.skip
      ? ` sync=skipped reason=${f.skip}`
      : " sync=skipped";
  const trigger = f.trigger ? ` trigger=${f.trigger}` : "";
  return (
    `collect source=${source} mode=${f.mode}${trigger} ` +
    `indexer_ms=${f.indexerMs} files=${f.files} edges=${f.edges} ` +
    `removed=${f.removed}${stats}`
  );
}

/** Log de observabilidade da coleta (base do E7). */
function logCollection(
  rt: Pick<CollectRuntime, "source">,
  fields: Omit<CollectLogFields, "source">,
): void {
  log(formatCollectLine({ source: rt.source, ...fields }));
}

/** Estado real do coletor: manifest em `<repo>/.kilo/graph-manifest.json`. */
function fileState(repoRoot: string, workspace: string): CollectState {
  const path = join(repoRoot, MANIFEST_REL_PATH);
  return {
    load: () => {
      const manifest = loadManifest(path, workspace);
      return {
        files: manifest.files,
        last_git_head: manifest.last_git_head,
        workspace: manifest.workspace,
      };
    },
    save: (files, head) => {
      try {
        saveManifest(path, mergeManifest(workspace, files, head));
      } catch (err) {
        // Manifest é otimização/estado local: falha de escrita não é fatal (o
        // próximo sync reindexa tudo por falta do estado).
        debug(
          `collect: manifest não gravado (${err instanceof Error ? err.message : err})`,
        );
      }
    },
  };
}

/** HEAD atual do repo (base do incremental); `null` fora de um repo git. */
async function currentHead(repoRoot: string): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile("git", ["-C", repoRoot, "rev-parse", "HEAD"], (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  });
}

/**
 * Coleta completa: decide full/incremental (trigger), spawna o indexer, monta o
 * body (removidos do manifest) e chama `/v1/code/sync`. **Nunca lança** — degrada
 * em qualquer falha (FR-510/E5). Devolve o `SyncResult` quando houve sync.
 */
export async function collectCode(rt: CollectRuntime): Promise<SyncResult | null> {
  if (!rt.cfg.enabled) {
    debug("collect: desligado (code_index.enabled=false)");
    return null;
  }
  // Trava cross-process (§3b): boot e post-commit são processos SO distintos. A
  // trava em memória do repo NÃO cobre dois processos; sem o lockfile, dois CLIs
  // concorrentes corrompem o manifest. Sem `lockPath` (teste unitário), segue sem
  // trava — só o CLI de produção o passa.
  const lock = rt.lockPath
    ? await acquireLock({ path: rt.lockPath })
    : { release: () => {} };
  if (rt.lockPath && lock === null) {
    // O modo ainda não foi decidido (a trava vem antes do manifest), então a
    // linha não finge um modo: só a origem + o motivo (coalescing/espera).
    log(
      `collect source=${rt.source ?? "boot"} trigger=${rt.forceMode ?? "auto"} ` +
        `sync=skipped reason=trava ocupada por outro processo`,
    );
    return null;
  }
  try {
    return await collectUnderLock(rt);
  } finally {
    lock?.release();
  }
}

/** Corpo de `collectCode` sob a trava cross-process. */
async function collectUnderLock(
  rt: CollectRuntime,
): Promise<SyncResult | null> {
  const run = rt.run ?? runIndexer;
  const state = rt.state ?? fileState(rt.repoRoot, rt.identity.workspace);
  const git = rt.git;
  const start = Date.now();

  const manifest = state.load();
  // Troca de identidade do workspace: um manifest de OUTRO workspace (o usuário
  // mudou `daemon.workspace`) não pode alimentar um incremental — o grafo novo
  // receberia só o delta e ficaria incompleto. Trata como 1º uso ⇒ full.
  const identityChanged =
    typeof manifest.workspace === "string" &&
    manifest.workspace !== "" &&
    manifest.workspace !== rt.identity.workspace;
  if (identityChanged) {
    log(
      `collect: workspace mudou (${manifest.workspace} → ${rt.identity.workspace}); ` +
        `forçando full`,
    );
  }
  // H2 (TOCTOU de HEAD): resolve o HEAD UMA vez, para o SHA concreto, e usa-o em
  // TODAS as consultas (ancestralidade, `git_range.to`, `diff`, `save`). Resolver
  // o literal `"HEAD"` em instantes distintos permitia um commit entre a
  // ancestralidade e o diff (ou entre o diff e o save) → delta perdido em
  // silêncio (o range indexado não casa o HEAD gravado).
  const headSha = git ? git.head(rt.repoRoot) : null;
  // `--mode full` explícito ignora o manifest. `auto`/`incremental` decidem por
  // manifest + guarda de ancestralidade (§4): sem range válido, cai em full.
  const trigger: TriggerDecision =
    rt.forceMode === "full" || identityChanged
      ? { mode: "full" }
      : decideTrigger(
          {
            files: manifest.files,
            last_git_head: manifest.last_git_head ?? null,
          },
          // Guarda de ancestralidade (§4): só incremental se `last_git_head` é
          // ancestral do HEAD resolvido. Sem HEAD (repo vazio) ⇒ não-ancestral ⇒
          // full. Sem porta de git, mantém o comportamento S4.
          git
            ? {
                isAncestor: (from) =>
                  headSha !== null && git.isAncestor(rt.repoRoot, from, headSha),
              }
            : {},
        );
  // Pina o `to` do range no SHA resolvido (nunca o literal "HEAD").
  if (trigger.mode === "incremental" && trigger.gitRange && headSha) {
    trigger.gitRange = { from: trigger.gitRange.from, to: headSha };
  }
  const mode: IndexMode = trigger.mode;

  // Gate do sentinela (§3): só arma o incremental DEPOIS do full inicial. Um
  // commit durante o full inicial não pode disparar um segundo full
  // concorrente — o sentinela fecha essa corrida.
  if (mode === "incremental" && rt.ready && !rt.ready()) {
    log(
      formatCollectLine({
        source: rt.source,
        mode,
        trigger: rt.forceMode,
        indexerMs: 0,
        files: 0,
        edges: 0,
        removed: 0,
        skip: "aguardando sync inicial",
      }),
    );
    return null;
  }

  let result;
  try {
    result = await run({
      bin: rt.cfg.indexer_bin,
      repoRoot: rt.repoRoot,
      mode,
      gitRange: trigger.gitRange,
      loadIgnores: rt.cfg.load_ignores ?? false,
    });
  } catch (err) {
    logFatal("collect indexer", err);
    return null;
  }
  const indexerMs = Date.now() - start;

  if (result.skipped) {
    logCollection(rt, {
      mode,
      trigger: rt.forceMode,
      indexerMs,
      files: 0,
      edges: 0,
      removed: 0,
      skip: result.reason ?? "indexer indisponível",
    });
    return null;
  }

  // Erro NÃO-recuperável do indexer (ex.: `GIT_UNAVAILABLE` com `load_ignores`
  // sem git): o stream NÃO é um estado completo. Tratá-lo como "present vazio"
  // num full marcaria TODO o manifest como removido e apagaria o grafo
  // (chunks:[]). Aborta sem sincronizar — o grafo fica intacto.
  if (result.error) {
    log(
      `collect: indexer abortou (${result.error.code}: ${result.error.message}); ` +
        `sync cancelado (grafo preservado)`,
    );
    logCollection(rt, {
      mode,
      trigger: rt.forceMode,
      indexerMs,
      files: 0,
      edges: 0,
      removed: 0,
      skip: `indexer abortou: ${result.error.code}`,
    });
    return null;
  }

  // Removidos:
  //   - FULL: o stream é o estado COMPLETO do repo ⇒ removido = manifest − present.
  //   - INCREMENTAL: o stream traz só os alterados no range; tratar os ausentes
  //     como removidos apagaria o grafo (defeito medido). A fonte de verdade das
  //     deleções é o próprio git (`--diff-filter=D` no range — §5), não o stream.
  //     Sem isso o indexer emite chunk vazio para o arquivo deletado e o grafo
  //     cria um nó fantasma.
  // `present` (full) = arquivos com chunk no stream COMPLETO.
  const presentFull = collectPresent(result.events);
  let removed: string[];
  if (mode === "full") {
    // Troca de identidade: o manifest antigo é de OUTRO workspace — seus arquivos
    // nunca estiveram no grafo novo, então NÃO entram como removidos.
    const priorFiles = identityChanged ? [] : manifest.files;
    removed = removedFiles(
      { ...emptyManifest(rt.identity.workspace), files: priorFiles },
      presentFull,
    );
  } else if (git && trigger.gitRange) {
    removed = git.deletedFiles(
      rt.repoRoot,
      trigger.gitRange.from,
      trigger.gitRange.to,
    );
  } else {
    removed = [];
  }

  // M2 (git é a verdade no incremental): se o indexer emitir um chunk para um
  // arquivo que o git reporta deletado (nó fantasma "medido"), o `buildSyncBody`
  // o descartaria do tombstone (`removed.filter(p => !present.has(p))`). Remove os
  // eventos desses caminhos ANTES de montar o body, para a deleção vencer sempre.
  const removedSet = new Set(removed);
  const events =
    mode === "incremental" && removedSet.size > 0
      ? result.events.filter((ev) => {
          if (ev.event !== "chunk_emitted") return true;
          const p = ev.payload as { file?: unknown } | null;
          return !(p && typeof p.file === "string" && removedSet.has(p.file));
        })
      : result.events;
  const present = collectPresent(events);

  const buildStart = Date.now();
  const body = buildSyncBody(events, rt.identity, {
    repoRoot: rt.repoRoot,
    removed,
  });
  const buildMs = Date.now() - buildStart;
  debug(
    `collect: build files=${body.files.length} edges=${body.edges.length} ` +
      `build_ms=${buildMs} events=${result.events.length}`,
  );
  if (body.files.length === 0 && removed.length === 0) {
    debug("collect: nenhum chunk emitido; nada a sincronizar");
    logCollection(rt, {
      mode,
      trigger: rt.forceMode,
      indexerMs,
      files: 0,
      edges: 0,
      removed: 0,
      skip: "sem chunks no range",
    });
    // M3: um full "vazio" (repo vazio/só-ignorados, ou commit só de docs) AINDA
    // precisa gravar o HEAD e (no full) armar o sentinela — senão o sentinela
    // nunca nasce e todo boot/hook refaz full para sempre. Sem isto o gate do
    // incremental nunca abre.
    if (mode === "full") {
      state.save(manifest.files, headSha ?? (git ? null : await currentHead(rt.repoRoot)));
      rt.onFullComplete?.();
    }
    return null;
  }

  try {
    const sync = await rt.client.syncCode(body.files, body.edges);
    logCollection(rt, {
      mode,
      trigger: rt.forceMode,
      indexerMs,
      files: body.files.length,
      edges: body.edges.length,
      removed: removed.length,
      sync,
    });
    // Estado pós-sync: arquivos ATUAIS (sem removidos) + HEAD atual. No
    // incremental, `present` só traz os alterados; mescla com os que já
    // estavam no manifest para não perder os inalterados. `removed` é subtraído
    // DEPOIS da união (M2): um arquivo deletado não pode ressuscitar no manifest
    // por ter vindo em `present` — o git é a verdade.
    const merged =
      mode === "incremental" && !identityChanged
        ? [
            ...new Set([
              ...manifest.files.filter((f) => !removedSet.has(f)),
              ...present,
            ]),
          ].filter((f) => !removedSet.has(f))
        : present;
    // Grava o HEAD RESOLVIDO no início (H2): o range indexado e o head gravado
    // descrevem o MESMO ponto — sem isso um commit concorrente deixaria um vão
    // de delta nunca revisitado. Sem porta de git, o caminho S4 legado.
    const newHead = git ? headSha : await currentHead(rt.repoRoot);
    state.save(merged, newHead);
    // Full concluído ⇒ arma o incremental: o CLI escreve o sentinela
    // `graph-ready` (§3). É o full inicial quem o cria; o incremental só roda
    // com ele presente.
    if (mode === "full") rt.onFullComplete?.();
    return sync;
  } catch (err) {
    logSyncFailure(err);
    return null;
  }
}

/** Arquivos com `chunk_emitted` no stream (para o diff de removidos). */
function collectPresent(events: import("../types.ts").IndexerEvent[]): string[] {
  const seen = new Set<string>();
  for (const ev of events) {
    if (ev.event !== "chunk_emitted") continue;
    const p = ev.payload as { file?: unknown } | null;
    if (p && typeof p.file === "string" && p.file) seen.add(p.file);
  }
  return [...seen];
}

/**
 * Registra o hook do coletor: no boot dispara a coleta em background (nunca
 * `await`). Devolve a promessa em voo para o `dispose` drenar (como o health).
 */
export function collectHook(rt: CollectRuntime): { boot: Promise<void> } {
  const boot = collectCode(rt)
    .then(() => undefined)
    .catch((err) => {
      // `collectCode` não deveria lançar; cinto de segurança contra rejeição
      // não tratada de uma promessa em background (nunca derruba o plugin).
      logFatal("collect boot", err);
    });
  return { boot };
}

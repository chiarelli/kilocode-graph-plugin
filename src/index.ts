/**
 * Ponto de entrada do plugin (E1-S1, decisão 1).
 *
 * Forma adotada exata do antecessor (`openviking-memory.js:1896`):
 *   export default { id, server: plugin }
 * onde `plugin` é `async (ctx, options) => ({ "<hook.name>": async (...) => {}, dispose })`.
 *
 * `index.ts` **não** contém lógica: monta config, resolve workspace, cria o
 * client e registra hooks. Na E1 não há hook de conteúdo — só um log de boot e
 * o `dispose`.
 */

import { join } from "node:path";

import { MemtierClient } from "./client.ts";
import {
  loadConfig,
  persistConfigState,
  type PluginOptions,
} from "./config.ts";
import { createGitPort } from "./index/git.ts";
import { installHooks } from "./index/install-hooks.ts";
import { cliPath, spawnCollectCli } from "./cli-spawn.ts";
import { resolveTokenFile } from "./token-file.ts";
import { ingestHook } from "./hooks/ingest.ts";
import { messagesHook } from "./hooks/messages.ts";
import {
  resolveRuntimeDbPath,
  type DbPathSource,
} from "./ingest/db.ts";
import { INGEST_STATE_REL_PATH } from "./ingest/state.ts";
import { debug, formatBootLine, log, logFatal, setDebug } from "./logger.ts";
import { scheduleMcpRegistration, type KiloLikeClient } from "./mcp/register.ts";
import { ensureWorkspaceKey } from "./provision.ts";
import type { PluginCtx } from "./types.ts";
import { resolveWorkspaceDir, workspaceName } from "./workspace.ts";

// `resolveTokenFile` mudou para `token-file.ts` (E3a-S6a) para o CLI standalone
// reutilizar a MESMA regra de confinamento. Reexportado daqui para compatibilidade
// (o boot e os testes o importam de `./index.ts`).
export { resolveTokenFile } from "./token-file.ts";

const plugin = async (ctx: PluginCtx, options?: PluginOptions) => {
  // O diretório do workspace vem do runtime do Kilo (`ctx.worktree` >
  // `ctx.directory` > cwd) ANTES do config: o `.kilo/graph-plugin.json` do
  // workspace é lido DESSE diretório, nunca de `process.cwd()` (plugin global).
  const dir = resolveWorkspaceDir(ctx);
  const config = loadConfig(options, dir);
  setDebug(config.debug);

  // Identidade do workspace: `daemon.workspace` (override explícito) > derivado
  // do diretório (`workspaceName(dir)` = `<stem>-<sha1 8>`). O override existe
  // porque o memtier escopa o bearer ao nome EXATO — quem tem token pré-escopado
  // precisa pinar o nome (o derivado carrega o hash do caminho).
  const workspace = config.daemon.workspace || workspaceName(dir);
  const keyFile = resolveTokenFile(dir, config.daemon.token_file);

  // Provisionamento do workspace 1:1. Com o bearer do gestor no ambiente
  // (`KILOCODE_GRAPH_MANAGER_TOKEN`) e a chave do workspace ausente, cria o
  // workspace memtier e grava `.kilo/graph-key.json`. Bloqueante de propósito
  // (o bearer é pré-condição das chamadas de dados) e limitado por um orçamento
  // de parede; roda só quando a chave está ausente, então o boot normal não paga
  // latência. Nunca lança — falha degrada para o caminho 401 de sempre.
  if (config.daemon.manager_token) {
    const outcome = await ensureWorkspaceKey({
      url: config.daemon.url,
      managerToken: config.daemon.manager_token,
      workspace,
      program: config.daemon.program,
      keyFile,
    });
    if (outcome.reason === "failed") {
      // Falha é VISÍVEL (não só debug): o operador precisa saber que o
      // provisionamento não persistiu a chave — senão só verá 401 adiante.
      log(`provision falhou workspace=${workspace} (chave não gravada)`);
    } else {
      debug(`provision outcome=${outcome.reason}`);
    }
  }

  const client = new MemtierClient({
    url: config.daemon.url,
    workspace,
    program: config.daemon.program,
    token: config.daemon.token,
    token_file: keyFile,
    timeout_ms: config.daemon.health_timeout_ms,
    health_timeout_ms: config.daemon.health_timeout_ms,
    recall_timeout_ms: config.inject.timeout_ms,
    search_timeout_ms: config.inject.timeout_ms,
    sync_timeout_ms: config.code_index.sync_timeout_ms,
    ingest_timeout_ms: config.ingest.timeout_ms,
  });

  log(
    formatBootLine({
      workspace,
      url: config.daemon.url,
      program: config.daemon.program,
      token: config.daemon.token,
      debug: config.debug,
    }),
  );

  // Health no boot (E1-S1): atravessa config → workspace → client → memtier.
  // Não bloqueia o carregamento do plugin e nunca lança (NFR-03).
  const bootHealth = client
    .health()
    .then((report) => {
      log(
        `health ok=${report.ok} status=${report.status} ` +
          `falkordb=${report.falkordb} indices=${report.indices}` +
          (report.reason ? ` reason=${report.reason}` : "") +
          (report.error ? ` error=${report.error}` : ""),
      );
    })
    .catch((err) => logFatal("health", err));

  if (config.debug) {
    debug(`workspace dir=${dir}`);
  }

  // Coleta de código (E3a-S6 §1b): o CLI é o **único escritor** do grafo — o
  // plugin NÃO coleta. O boot:
  //   1. persiste a `Config` efetiva (§7) para o CLI resolver a MESMA config
  //      (o CLI standalone não vê o `options` inline do `kilo.jsonc`);
  //   2. spawna o CLI em `auto` (híbrido: full no 1º uso, incremental depois —
  //      NÃO full fixo: reindexar tudo a cada boot regrediria o custo/contradiria
  //      a E3a-S4), em background (FR-510, nunca `await`);
  //   3. instala os hooks git (§1) — idempotente, sem `core.hooksPath`.
  // Tudo fora do caminho crítico e à prova de falha (nunca derruba o boot).
  if (config.code_index.enabled) {
    persistConfigState(dir, config);
    spawnCollectCli({
      workspace: dir,
      mode: "auto",
      source: "boot",
      nodeBin: config.daemon.node_bin,
    });
    try {
      installHooks({
        repoRoot: dir,
        cliPath: cliPath(),
        nodeBin: config.daemon.node_bin,
        git: createGitPort(),
      });
    } catch (err) {
      logFatal("install-hooks", err);
    }
  }

  // Registro do MCP remoto do memtier (E3b): implícito no boot, em background
  // (`void ... .catch()`), nunca bloqueia o carregamento nem derruba o plugin
  // (FR-601/FR-604). O token do header é o mesmo bearer do client HTTP.
  scheduleMcpRegistration(ctx.client as KiloLikeClient | undefined, {
    enabled: config.mcp.enabled,
    name: config.mcp.name,
    url: config.daemon.url,
    token: client.resolveToken(),
    directory: dir,
    timeout_ms: config.mcp.timeout_ms,
  });

  // E4: o `kilo.db` é localizado pela **própria regra do runtime do Kilo**
  // (`Path.data` = `XDG_DATA_HOME ?? ~/.local/share` + `/kilo`; regra `KILO_DB`),
  // reproduzida in-process — o plugin roda no mesmo processo e herda o env. Não é
  // derivado de `client.path.get().state`: `/path` expõe o diretório de ESTADO,
  // enquanto o banco vive em DATA (`~/.local/share/kilo/kilo.db`), então derivar
  // de `state` apontava para um diretório sem banco. A resolução é **síncrona e
  // sem I/O** (`resolveRuntimeDbPath`): resolver no boot não trava o `server()`.
  // Desligada a ingestão, o provider nem é aberto.
  const dbPath: DbPathSource = config.ingest.enabled ? resolveRuntimeDbPath() : "";

  // E4: ingestion hooks. Construído fora do objeto de retorno para que o
  // `dispose` (que fecha o handle do SQLite) seja referenciável no shutdown.
  const ingestHooks = ingestHook({
    cfg: {
      enabled: config.ingest.enabled,
      batch_size: config.ingest.batch_size,
      max_hashes: config.ingest.max_hashes,
    },
    dbPath,
    statePath: join(dir, INGEST_STATE_REL_PATH),
    client,
  });

  return {
    // E2: injeção de memória no turno (`messages.transform`). Só quando
    // `inject.enabled` (default `false`); o hook degrada sem quebrar o turno.
    // E3c: o bloco de código é um segundo part no MESMO hook (sentinela
    // `graph-code`), ligado por `inject.code_enabled` (default `false`).
    ...messagesHook({
      enabled: config.inject.enabled,
      cfg: {
        maxMemories: config.inject.max_memories,
        memoryMaxTokens: config.inject.memory_max_tokens,
        timeoutMs: config.inject.timeout_ms,
        // Health gate é opcional (spec §E2-S2): desligado para não dobrar o
        // round-trip no caminho crítico — um 503 do próprio recall já degrada.
        healthGate: false,
      },
      codeEnabled: config.inject.code_enabled,
      codeCfg: {
        maxCodeChunks: config.inject.max_code_chunks,
        codeMaxTokens: config.inject.code_max_tokens,
        timeoutMs: config.inject.timeout_ms,
        // D5/D7: labels e piso vêm da config (piso `undefined` = desligado).
        labels: config.inject.code_labels,
        minScore: config.inject.code_min_score,
      },
      client,
    }),
    // E4: ingestão assíncrona — `message.updated` (S1) e `session.idle` (S3)
    // acordam a MESMA rotina; o conteúdo vem do `kilo.db` (ADR-007). O evento
    // nunca é `await` (não bloqueia o turno, FR-203). Desligado por default.
    ...ingestHooks,
    // `dispose` drena o health do boot (curto, com `AbortSignal.timeout`) e
    // fecha o handle do SQLite da ingestão (E4). A coleta (E3a) é background e
    // NÃO é drenada — o job do indexer pode ser longo (FR-510). O registro do
    // MCP (E3b) também é background: não é drenado (não segura o shutdown).
    dispose: async () => {
      debug("dispose");
      ingestHooks.dispose();
      // A coleta é background (FR-510): o dispose não a espera — drenar o job
      // do indexer poderia segurar o shutdown por todo o timeout do job. O
      // health do boot é curto e tem `AbortSignal.timeout`, então é drenado.
      await bootHealth;
    },
  };
};

export default { id: "kilocode-graph-plugin", server: plugin };

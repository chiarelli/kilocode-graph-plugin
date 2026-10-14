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

import { isAbsolute, join } from "node:path";

import { MemtierClient } from "./client.ts";
import { loadConfig, type PluginOptions } from "./config.ts";
import { collectHook } from "./hooks/collect.ts";
import { messagesHook } from "./hooks/messages.ts";
import { debug, formatBootLine, log, logFatal, setDebug } from "./logger.ts";
import type { PluginCtx } from "./types.ts";
import { resolveWorkspaceDir, workspaceName } from "./workspace.ts";

/**
 * `token_file` é relativo ao workspace (`daemon.token_file` default
 * `.kilo/graph-key.json`). Caminho absoluto é respeitado como veio.
 */
function resolveTokenFile(dir: string, tokenFile: string): string {
  if (!tokenFile) return "";
  return isAbsolute(tokenFile) ? tokenFile : join(dir, tokenFile);
}

const plugin = async (ctx: PluginCtx, options?: PluginOptions) => {
  const config = loadConfig(options);
  setDebug(config.debug);

  const dir = resolveWorkspaceDir(ctx);
  const workspace = workspaceName(dir);
  const client = new MemtierClient({
    url: config.daemon.url,
    workspace,
    program: config.daemon.program,
    token: config.daemon.token,
    token_file: resolveTokenFile(dir, config.daemon.token_file),
    timeout_ms: config.daemon.health_timeout_ms,
    health_timeout_ms: config.daemon.health_timeout_ms,
    recall_timeout_ms: config.inject.timeout_ms,
    sync_timeout_ms: config.code_index.sync_timeout_ms,
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

  // Coleta de código (E3a): dispara no boot, **fora do turno** (FR-510). O
  // `collectCode` nunca lança e roda em background; não é drenado no shutdown
  // (o job do indexer pode ser longo — o processo o encerra se sair).
  void collectHook({
    cfg: config.code_index,
    repoRoot: dir,
    identity: { workspace, program: config.daemon.program },
    client,
  });

  return {
    // E2: injeção de memória no turno (`messages.transform`). Só quando
    // `inject.enabled` (default `false`); o hook degrada sem quebrar o turno.
    ...messagesHook({
      enabled: config.inject.enabled,
      cfg: {
        maxMemories: config.inject.max_memories,
        maxChars: config.inject.max_chars,
        maxTokens: config.inject.max_tokens,
        timeoutMs: config.inject.timeout_ms,
        // Health gate é opcional (spec §E2-S2): desligado para não dobrar o
        // round-trip no caminho crítico — um 503 do próprio recall já degrada.
        healthGate: false,
      },
      client,
    }),
    // Sem outros hooks de conteúdo na primeira fatia (ingestão/coleta/MCP são
    // E4/E3a/E3b). `dispose` drena o trabalho em voo (o health do boot) antes
    // de sair; o health tem timeout, então nunca pendura (`AbortSignal.timeout`).
    dispose: async () => {
      debug("dispose");
      // A coleta é background (FR-510): o dispose não a espera — drenar o job
      // do indexer poderia segurar o shutdown por todo o timeout do job. O
      // health do boot é curto e tem `AbortSignal.timeout`, então é drenado.
      await bootHealth;
    },
  };
};

export default { id: "kilocode-graph-plugin", server: plugin };

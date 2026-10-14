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

  return {
    // Sem hooks de conteúdo na E1 (injeção/ingestão/coleta/MCP são E2/E3a/E3b).
    // `dispose` drena o trabalho em voo (o health do boot) antes de sair; o
    // health tem timeout, então nunca pendura (`AbortSignal.timeout`).
    dispose: async () => {
      debug("dispose");
      await bootHealth;
    },
  };
};

export default { id: "kilocode-graph-plugin", server: plugin };

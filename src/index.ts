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

import { MemtierClient } from "./client.ts";
import { loadConfig, type PluginOptions } from "./config.ts";
import { debug, formatToken, log, logFatal, setDebug } from "./logger.ts";
import type { PluginCtx } from "./types.ts";
import { resolveWorkspaceDir, workspaceName } from "./workspace.ts";

const plugin = async (ctx: PluginCtx, options?: PluginOptions) => {
  const config = loadConfig(options);
  setDebug(config.debug);

  const dir = resolveWorkspaceDir(ctx);
  const workspace = workspaceName(dir);
  const client = new MemtierClient({
    url: config.daemon.url,
    token: config.daemon.token,
    timeout_ms: config.daemon.health_timeout_ms,
  });

  log(
    `boot workspace=${workspace} url=${config.daemon.url} ` +
      `program=${config.daemon.program} token=${formatToken(config.daemon.token)} ` +
      `debug=${config.debug}`,
  );

  // Health no boot (E1-S1): atravessa config → workspace → client → memtier.
  // Não bloqueia o carregamento do plugin e nunca lança (NFR-03).
  void client
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
    // TODO(tracer-bullet): `dispose` de verdade (drenar estado) — na E1 é um log.
    dispose: async () => {
      debug("dispose");
    },
  };
};

export default { id: "kilocode-graph-plugin", server: plugin };

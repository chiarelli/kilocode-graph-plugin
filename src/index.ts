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
import { scheduleMcpRegistration, type KiloLikeClient } from "./mcp/register.ts";
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
    // `dispose` drena o health do boot (curto, com `AbortSignal.timeout`). A
    // coleta (E3a) é background e NÃO é drenada — o job do indexer pode ser
    // longo (FR-510). O registro do MCP (E3b) também é background: não é
    // drenado (não segura o shutdown). Ingestão (E4) entra na sua epic.
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

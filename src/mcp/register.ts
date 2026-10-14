/**
 * Registro do MCP remoto do memtier (E3b).
 *
 * O plugin registra o servidor MCP do memtier **implicitamente** no boot — o
 * usuário não precisa definir nada em `kilo.jsonc` (decisão do dono, ADR-006).
 * Fluxo (reuso literal de `registerOpenVikingMcp`, do antecessor
 * `~/.config/kilo/vendor/openviking-memory.js:1781`):
 *
 *   `status` → `add` (`type:"remote"`) → `connect`
 *
 * O `client` do Kilo (`ctx.client`) é quem tem `.mcp.*` — recebido no boot. O
 * `directory` vai **sempre** no `query` (o MCP é por workspace/diretório).
 *
 * Degradação (FR-604): **nada** aqui derruba o plugin. Falha de status/add/
 * connect vira log; o boot segue sem tools.
 *
 * O Módulo é thin de propósito: `buildMcpConfig` é puro (testável isolado) e
 * `registerMemtierMcp` recebe o `client` injetado (testável com um fake de
 * `client.mcp`, sem socket).
 */

import { debug, log, logFatal } from "../logger.ts";

/** Entrada remota de MCP como o Kilo a aceita (`McpRemoteConfig` do SDK). */
export interface McpRemoteConfig {
  type: "remote";
  url: string;
  enabled: boolean;
  headers?: Record<string, string>;
  timeout: number;
}

/** Subconjunto do `client.mcp` do Kilo que o registro consome (estrutural). */
export interface KiloMcpStatus {
  status: string;
  error?: string;
}

/** Resultado de uma chamada do SDK (hey-api): `data` no ok, `error` no erro. */
export interface McpCallResult<T> {
  data?: T;
  error?: unknown;
}

/** Porta do `client.mcp` do Kilo — implementada pelo SDK; fake nos testes. */
export interface KiloMcpClient {
  status(opts: {
    query: { directory: string };
  }): Promise<McpCallResult<Record<string, KiloMcpStatus>>>;
  add(opts: {
    body: { name: string; config: McpRemoteConfig };
    query: { directory: string };
  }): Promise<McpCallResult<Record<string, KiloMcpStatus>>>;
  connect(opts: {
    path: { name: string };
    query: { directory: string };
  }): Promise<McpCallResult<unknown>>;
  disconnect(opts: {
    path: { name: string };
    query: { directory: string };
  }): Promise<McpCallResult<unknown>>;
}

/** Cliente do Kilo recebido no boot: só o `mcp` é consumido aqui. */
export interface KiloLikeClient {
  mcp?: KiloMcpClient;
}

/** Config efetiva do registro (subconjunto de `mcp.*` + identidade/URL). */
export interface McpRegisterConfig {
  /** `mcp.enabled` (default `true`). */
  enabled: boolean;
  /** Nome do servidor MCP no Kilo (`mcp.name`, default `memtier`). */
  name: string;
  /** Base do memtier (ex.: `http://127.0.0.1:8400`) — vira `…/v1/mcp`. */
  url: string;
  /** Bearer efetivo (o mesmo do client HTTP) — nunca logado. */
  token: string;
  /** Diretório do workspace (vai no `query`). */
  directory: string;
  /** Timeout de fetch de tools no Kilo (`mcp.timeout_ms`). */
  timeout_ms: number;
}

/**
 * Monta o `McpRemoteConfig` a partir da config efetiva. **Puro**. O header
 * `Authorization` só entra quando há token (a borda responde 401 sem ele — o
 * memtier MCP é rota protegida).
 */
export function buildMcpConfig(
  cfg: Pick<McpRegisterConfig, "url" | "token" | "timeout_ms">,
): McpRemoteConfig {
  const base = cfg.url.replace(/\/+$/, "");
  const config: McpRemoteConfig = {
    type: "remote",
    url: `${base}/v1/mcp`,
    enabled: true,
    timeout: cfg.timeout_ms,
  };
  if (cfg.token) config.headers = { Authorization: `Bearer ${cfg.token}` };
  return config;
}

/**
 * Registra o MCP remoto do memtier no Kilo. **Nunca lança** (FR-604): toda
 * falha vira log e o boot segue. `client` pode ser `undefined` (ctx sem client,
 * ex.: teste de boot da E1) — degrada silenciosamente.
 */
export async function registerMemtierMcp(
  client: KiloLikeClient | undefined,
  cfg: McpRegisterConfig,
): Promise<void> {
  if (!cfg.enabled) {
    debug("mcp: registro desligado (mcp.enabled=false)");
    return;
  }

  const mcp = client?.mcp;
  if (!mcp) {
    // TODO(tracer-bullet): tratamento explícito de SDK antigo (log + teste) — S2.
    debug("mcp: client.mcp indisponível (SDK sem MCP); registro ignorado");
    return;
  }

  const directory = cfg.directory;
  try {
    // TODO(tracer-bullet): override do kilo.jsonc (não registrar por cima) — S2.
    const status = await mcp.status({ query: { directory } });
    if (status.error) {
      log(`mcp: status falhou: ${JSON.stringify(status.error)}`);
      return;
    }

    const existing = status.data?.[cfg.name];
    if (existing?.status === "connected") {
      debug(`mcp "${cfg.name}" já conectado — registro ignorado`);
      return;
    }
    // TODO(tracer-bullet): refresh de registro falho (disconnect+add) — S2.

    const config = buildMcpConfig(cfg);
    const add = await mcp.add({ body: { name: cfg.name, config }, query: { directory } });
    if (add.error) {
      logFatal("mcp add", new Error(JSON.stringify(add.error)));
      return;
    }

    const connect = await mcp.connect({
      path: { name: cfg.name },
      query: { directory },
    });
    if (connect.error) {
      logFatal("mcp connect", new Error(JSON.stringify(connect.error)));
      return;
    }

    log(`mcp "${cfg.name}" registrado e conectado (${config.url})`);
  } catch (err) {
    logFatal("mcp registration", err);
  }
}

/**
 * Dispara o registro em **background** no boot (como o antecessor,
 * `scheduleOpenVikingMcpRegistration`): nunca bloqueia o carregamento do plugin.
 */
export function scheduleMcpRegistration(
  client: KiloLikeClient | undefined,
  cfg: McpRegisterConfig,
): void {
  void registerMemtierMcp(client, cfg).catch((err) => {
    logFatal("mcp background registration", err);
  });
}

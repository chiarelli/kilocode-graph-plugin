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
import { isMcpDefinedInKiloConfig } from "./kilo-config.ts";

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

/**
 * Um registro precisa de refresh quando **não** está conectado (qualquer estado
 * que não seja `connected`: `failed`, `disabled`, `connecting` preso,
 * `disconnected`, `error`). Regressão corrigida (defeito D-6): o antecessor
 * desconectava em **qualquer** estado não-conectado; tratá-los como "já
 * registrado, ignorar" deixava o MCP morto e mudo (0 tools, nenhum erro).
 */
export function shouldRefreshMcpRegistration(existing: KiloMcpStatus | undefined): boolean {
  if (!existing) return false;
  if (existing.status !== "connected") return true;
  // `connected` com `ENOENT` é estado inconsistente (binário/rota sumiu):
  // refresca mesmo assim.
  if (existing.error?.includes("ENOENT")) return true;
  return false;
}

/**
 * Nome de MCP válido: não-vazio, sem barra/barra-invertida/ponto-sequência
 * (evita traversal e segmento de path no SDK), sem espaço. Regressão corrigida
 * (defeito D-8): o `name` ia **cru** para os path params de `add`/`connect`.
 */
export function isValidMcpName(name: string): boolean {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (trimmed === "" || trimmed !== name) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.includes("..")) return false;
  // Espaço interno também é suspeito num nome de servidor MCP.
  return !/\s/.test(name);
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
 * Monta o `McpRemoteConfig` a partir da config efetiva. **Puro**.
 *
 * A URL é unida com o `URL` nativo (defeito D-5 corrigido): concatenar
 * `${base}/v1/mcp` corrompia base com `?query`/`#fragment` (o sufixo ia parar
 * **depois** do `?`) e base vazia virava `/v1/mcp` relativo. O `URL` resolve o
 * path corretamente e descarta query/fragment ao setar `pathname`.
 *
 * O header `Authorization` só entra quando há token **efetivo** (truthy após
 * `trim` — defeito D-9: um token só-espaços gerava `Bearer    `).
 */
export function buildMcpConfig(
  cfg: Pick<McpRegisterConfig, "url" | "token" | "timeout_ms">,
): McpRemoteConfig {
  const url = new URL("v1/mcp", ensureBaseUrl(cfg.url)).toString();
  const config: McpRemoteConfig = {
    type: "remote",
    url,
    enabled: true,
    timeout: cfg.timeout_ms,
  };
  const token = cfg.token.trim();
  if (token) config.headers = { Authorization: `Bearer ${token}` };
  return config;
}

/**
 * Normaliza a base do memtier para uma URL absoluta terminada em `/`, base para
 * o `new URL("v1/mcp", …)`. Sem host (ex.: `""` ou só path) ⇒ lança — o
 * chamador (`registerMemtierMcp`) degrada com log (FR-604).
 */
function ensureBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("mcp: daemon.url vazia");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  // Termina em `/` para que o path relativo seja resolvido sob a base (o `URL`
  // preserva o último segmento sem a barra).
  return withScheme.endsWith("/") ? withScheme : `${withScheme}/`;
}

/** Status HTTP de um erro do SDK, quando houver (`{status:409,...}`). */
function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

/**
 * `true` quando o erro do `add` significa "o nome já existe" — `409` de
 * concorrência (dois boots) ou detalhe `already exists`. Nesse caso o registro
 * do **outro** boot venceu e basta tentar o `connect` (defeito D-7: antes isso
 * virava FATAL e o perdedor ficava sem conectar).
 */
function isAlreadyExists(error: unknown): boolean {
  if (errorStatus(error) === 409) return true;
  const detail =
    error && typeof error === "object" && "detail" in error
      ? (error as { detail?: unknown }).detail
      : undefined;
  return typeof detail === "string" && /already exists|já existe/i.test(detail);
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
    // SDK antigo sem `client.mcp`: loga e segue — o boot nunca depende do MCP.
    log("mcp: client.mcp indisponível (SDK sem MCP); registro ignorado");
    return;
  }

  const directory = cfg.directory;

  // Valida o nome antes de usá-lo em path params (defeito D-8): nome vazio, com
  // `/`, `..` ou espaço vira segmento de path/traversal no SDK.
  if (!isValidMcpName(cfg.name)) {
    log(`mcp: nome inválido (${JSON.stringify(cfg.name)}); registro ignorado`);
    return;
  }

  // Idempotência (FR-602): se **algum** kilo.jsonc define `mcp.<name>` (com
  // qualquer valor, inclusive `false`), o plugin NÃO registra por cima — o que
  // está lá é a vontade dele. Cobre D-4 (precedência) e D-10 (`false` bloqueia).
  if (isMcpDefinedInKiloConfig(directory, cfg.name)) {
    debug(`mcp "${cfg.name}" já definido no kilo.jsonc — registro do plugin ignorado`);
    return;
  }

  let config: McpRemoteConfig;
  try {
    config = buildMcpConfig(cfg);
  } catch (err) {
    // `daemon.url` vazia/inválida: degrada sem tentar o registro (FR-604).
    log(`mcp: URL inválida (${JSON.stringify(cfg.url)}); registro ignorado`);
    debug(`mcp buildMcpConfig: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  try {
    const status = await mcp.status({ query: { directory } });
    if (status.error) {
      log(`mcp: status falhou: ${JSON.stringify(status.error)}`);
      return;
    }

    const existing = status.data?.[cfg.name];
    // Já conectado e saudável: nada a fazer.
    if (existing && !shouldRefreshMcpRegistration(existing)) {
      debug(`mcp "${cfg.name}" já conectado — registro ignorado`);
      return;
    }

    if (existing) {
      // Qualquer estado não-conectado (failed/disabled/connecting/disconnected/
      // error): derruba o antigo e re-registra — sem isso o MCP ficaria morto e
      // mudo (defeito D-6). O `add` sobre um nome existente falharia, daí o
      // `disconnect` antes.
      debug(`mcp "${cfg.name}" refresh (status=${existing.status})`);
      const disconnect = await mcp.disconnect({
        path: { name: cfg.name },
        query: { directory },
      });
      if (disconnect.error) {
        log(`mcp: disconnect falhou: ${JSON.stringify(disconnect.error)}`);
      }
    }

    const add = await mcp.add({ body: { name: cfg.name, config }, query: { directory } });
    if (add.error && !isAlreadyExists(add.error)) {
      logFatal("mcp add", new Error(JSON.stringify(add.error)));
      return;
    }
    if (add.error) {
      // 409 de concorrência (dois boots) ou registro prévio: o nome já existe —
      // não é fatal. Segue para o `connect` (defeito D-7).
      log(`mcp: add retornou "já existe" (${errorStatus(add.error)}); tentando conectar`);
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

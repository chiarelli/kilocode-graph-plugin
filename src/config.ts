/**
 * Configuração do plugin (E1-S1, decisão 2).
 *
 * Precedência: `options` (do `kilo.jsonc`) > env var > arquivo JSON > default.
 * Idêntico ao `resolveOverride` do antecessor (`openviking-memory.js:93`).
 *
 * Nada hardcoded (FR-303): todo default vive em `DEFAULTS`. As chaves de E2/E3a/
 * E3b são **declaradas aqui com default** e lidas pela epic dona — declarar todas
 * evita churn de config entre epics (decisão do dono, 2026-10-14).
 *
 * Arquivo: `<workspace>/.kilo/graph-plugin.json` (por workspace) e
 * `~/.config/kilo/graph-plugin.json` (global). JSON fixado (o ecossistema Kilo
 * usa JSON no `.kilo/`); o ARCH §6 é ajustado para refletir isso na E1-S3.
 *
 * **Escopo por workspace.** O arquivo de config do workspace é lido do
 * diretório resolvido do workspace (`ctx.worktree` > `ctx.directory` > cwd), lido
 * no **runtime do Kilo** — NUNCA de `process.cwd()`, que num plugin instalado
 * globalmente aponta para o processo do Kilo, não para o projeto. `loadConfig`
 * recebe esse diretório como segundo argumento.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { debug, log } from "./logger.ts";
import {
  CHUNKING_STRATEGIES,
  type BackpressureOptions,
  type ChunkingOptions,
  type Config,
  type CpuGuardOptions,
} from "./types.ts";

/**
 * Teto interno de `max_tokens` no servidor (memtier `budget.py:61`,
 * `MAX_RESPONSE_TOKENS`): acima dele o memtier responde **422**. O cliente nunca
 * envia acima disso (ADR-009, decisão 1).
 */
const MAX_RESPONSE_TOKENS = 16000;

/** Defaults — a única fonte de verdade dos valores não configurados (FR-303). */
export const DEFAULTS = {
  daemon: {
    url: "http://127.0.0.1:8400",
    token_file: ".kilo/graph-key.json",
    program: "default",
    // Vazio ⇒ o nome do workspace é DERIVADO do diretório
    // (`workspaceName(dir)` = `<stem>-<sha1 8 do caminho>`). Setado ⇒ identidade
    // EXPLÍCITA, usada como veio (escapa do derivado). Necessário porque o
    // memtier escopa o bearer ao nome EXATO do workspace (medido: `alfa` vs
    // `alfa-1a2b3c4d` ⇒ 403), então quem tem token pré-escopado (E2E, migração)
    // precisa pinar o nome. NÃO recebe o sufixo de hash.
    workspace: "",
    health_timeout_ms: 2000,
    // Interpretador JS do CLI standalone (boot + hook). Vazio ⇒ `process.execPath`
    // (num host Bun, o binário do extension host do Kilo — ver `runtime.ts`).
    // Setado ⇒ pinar um `node`/`bun` explícito (útil em CI ou host sem Bun).
    node_bin: "",
    // Provisionamento: bearer do gestor. Vazio ⇒ provisionamento desligado
    // (a chave do workspace é pré-requisito manual, como antes).
    manager_token: "",
  },
  inject: {
    enabled: false,
    max_memories: 5,
    // ADR-009: unidade única = tokens (`chars/4`, o tipo do memtier). Um teto
    // POR endpoint (`max_tokens` no body de cada rota), o mesmo default nos dois.
    // Substituem o teto de chars do cliente e o `max_tokens` único
    // (servidor, compartilhado) do ADR-004 — que MORRERAM.
    memory_max_tokens: 2000,
    code_max_tokens: 2000,
    timeout_ms: 4000,
    // E3c — injeção de código (segunda onda; declarada pela epic dona, pois o
    // E1 fechou antes da E3c ser especada — ver histórico do BACKLOG).
    code_enabled: false,
    max_code_chunks: 3,
    // D5: labels enviados SÓ pelo plugin (o default do servidor continua
    // `("CodeChunk",)`). `CodeSymbol` restringe a busca a símbolos — o que a
    // injeção quer — sem mudar o contrato da rota nem da tool MCP.
    code_labels: ["CodeSymbol"] as string[],
    // D7: piso de relevância DESLIGADO por default (`undefined` ⇒ o campo não
    // vai no body). Só vale com servidor que honra `min_score`; a calibração
    // no corpus real fica para uma entrega seguinte.
    //
    // ATENÇÃO ao calibrar: o servidor já corta a perna VETORIAL com
    // `VEC_MIN_SCORE = 0.65`, então um piso abaixo disso só afeta chunks
    // fulltext-only — não espere que ele descarte vetor fraco.
    code_min_score: undefined as number | undefined,
  },
  code_index: {
    enabled: false,
    indexer_bin: "",
    sync_timeout_ms: 120000,
    // Fonte de arquivos via git (`git ls-files --exclude-standard`), honrando o
    // ignore-stack completo. Default `false` (varre tudo). `true` exige git +
    // repositório: ausente ⇒ o indexer falha com `GIT_UNAVAILABLE` (sem fallback).
    load_ignores: false,
    // Estratégia de chunking (`options.chunking` do indexer). Default =
    // `symbol_boundary` (um chunk por símbolo): o chunk agrupado do
    // `SemanticChunker` (default do indexer) fazia 1 def de teste cair DENTRO de
    // um blob de ~200 linhas, quebrando busca por identificador. `max_lines: 0`
    // é OBRIGATÓRIO com `symbol_boundary` (valor >0 DESCARTA chunks grandes);
    // `overlap_lines: 0` evita misturar métodos vizinhos.
    chunking: {
      strategy: "symbol_boundary",
      max_lines: 0,
      overlap_lines: 0,
      include_context: true,
      token_counting: false,
    } as ChunkingOptions,
    // Backpressure ligado por default: sem `options.backpressure` o indexer não
    // instancia o monitor e emite o corpus inteiro sem freio (CPU/memória).
    backpressure: {
      max_queue_size: 500,
      threshold_percent: 90,
      ack_required: false,
      pause_timeout_secs: 60,
    } as BackpressureOptions,
    // Não limita núcleos; rebaixa a prioridade e pausa o processo quando o
    // sistema passa de 85%, retomando em 75%.
    cpu_guard: {
      enabled: true,
      threshold_percent: 85,
      resume_percent: 75,
      sample_ms: 1000,
      max_pause_ms: 30_000,
      nice: 10,
    } as CpuGuardOptions,
  },
  ingest: {
    // Defaults desligados (preferência do dono, coerente com index/inject).
    enabled: false,
    // Tamanho do lote (valor de config — decisão do dono). Medido: 20 é o
    // ponto de custo ótimo (~140× mais barato que batch=1, qualidade ~igual).
    batch_size: 20,
    // Teto de hashes por workspace (L-2): FIFO ao ultrapassar (aplicado S4).
    max_hashes: 5000,
    // Timeout do `/v1/ingest` (responde 202 imediato; folga p/ fila).
    timeout_ms: 15000,
  },
  mcp: {
    enabled: true,
    name: "memtier",
    timeout_ms: 15000,
  },
  debug: false,
} as const;

/** Overrides vindos do `kilo.jsonc` (`plugin: [[path, { ... }]]`). */
export type PluginOptions = Record<string, unknown>;

/**
 * Resolve um valor por precedência `options` > env > arquivo > default.
 * Suporta o placeholder `{env:VAR}` em `options` (como o antecessor).
 */
function resolveOverride(
  val: unknown,
  envValue: string | undefined,
  fileValue: string | undefined,
  fallback: string,
): string {
  if (val !== undefined && val !== null) {
    if (typeof val === "string") {
      const m = /^\{env:(.+)\}$/.exec(val);
      if (m) {
        const resolved = process.env[m[1] as string] ?? fileValue;
        return trimOr(resolved, fallback);
      }
    }
    return String(val).trim();
  }
  return trimOr(envValue ?? fileValue, fallback);
}

/**
 * `trim()` de um valor de string; vazio/só-espaços ⇒ `fallback`. Defeito medido:
 * um env var `" "` (artefato de cópia/quoting) era honrado como setado — ex.:
 * `KILOCODE_GRAPH_URL=" "` virava base vazia e toda chamada falhava, e
 * `KILOCODE_GRAPH_PROGRAM=" "` mandava um slug inválido. Vazio agora cai no
 * default, como se não estivesse setado.
 */
function trimOr(raw: string | undefined, fallback: string): string {
  if (raw === undefined) return fallback;
  const t = raw.trim();
  return t === "" ? fallback : t;
}

/** Lê o valor de `options` aninhado (ex.: `options.daemon.url`). */
function pick(options: PluginOptions | undefined, path: string): unknown {
  if (!options) return undefined;
  const parts = path.split(".");
  let cur: unknown = options;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Config `false`/`true` estrita; qualquer outro valor cai no default. */
function resolveBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

/** Inteiro estrito; valor inválido cai no default (nunca `NaN` silencioso). */
function resolveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) ? n : fallback;
}

/**
 * Teto de tokens de um endpoint. O servidor devolve **422** para
 * `max_tokens > MAX_RESPONSE_TOKENS` (16000) ou `<= 0`.
 *
 * D8: acima do teto o valor é **CLAMPADO** para 16000 (com log), não
 * descartado. Medido: `16384` configurado caía no default 2000 em silêncio —
 * o operador pedia 8× mais orçamento e recebia menos que o default, sem sinal.
 * Abaixo de 1 (ou inválido) continua caindo no default, agora também com log.
 * O teto em si existe por causa do `MAX_RESPONSE_TOKENS` do servidor (ADR-009,
 * decisão 1): acima dele o memtier responde 422.
 */
function resolveTokenCap(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  // String vazia = "não configurado" (artefato comum de `KEY=` no ambiente):
  // cai no default SEM log — não é um valor inválido digitado pelo operador.
  if (raw.trim() === "") return fallback;
  const n = Number(raw);
  const valid = Number.isFinite(n) && Number.isInteger(n);
  if (valid && n > MAX_RESPONSE_TOKENS) {
    log(
      `config: max_tokens ${n} acima do teto interno (${MAX_RESPONSE_TOKENS}); ` +
        `CLAMPADO para ${MAX_RESPONSE_TOKENS} (valores maiores dão 422 no servidor)`,
    );
    return MAX_RESPONSE_TOKENS;
  }
  if (valid && n >= 1) return n;
  log(
    `config: max_tokens inválido (${String(raw)}); usando o default ${fallback} ` +
      `(o servidor aceita só inteiros em [1, ${MAX_RESPONSE_TOKENS}])`,
  );
  return fallback;
}

/**
 * Lista de labels da busca de código (D5). Aceita JSON array ou CSV. Lista
 * vazia, item não-string/vazio ou JSON inválido caem no default — o servidor
 * responde **422** para `labels: []` explícito, então enviar lixo seria pior
 * que usar o default.
 */
function resolveCodeLabels(raw: string | undefined, fallback: string[]): string[] {
  // Sempre uma CÓPIA: `DEFAULTS.inject.code_labels` é compartilhado e um
  // consumidor que mutasse o array corromperia o default do processo.
  if (raw === undefined) return [...fallback];
  const text = raw.trim();
  if (text === "") return [...fallback];
  let parsed: unknown;
  if (text.startsWith("[")) {
    try {
      parsed = JSON.parse(text);
    } catch {
      return [...fallback];
    }
  } else {
    parsed = text.split(",").map((part) => part.trim());
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return [...fallback];
  if (!parsed.every((v) => typeof v === "string" && v.trim() !== "")) {
    return [...fallback];
  }
  // Não muta o array do JSON/CSV de origem e normaliza o trim uma vez.
  return parsed.map((v) => (v as string).trim());
}

/**
 * Piso de relevância da memória/código (D7). `undefined` = desligado: o campo
 * NÃO vai no body. Fora de `[0,1]` ou não-numérico também cai em `undefined`
 * (nunca um 422 no caminho do turno).
 */
function resolveOptionalScore(
  raw: string | undefined,
  fallback: number | undefined = undefined,
): number | undefined {
  if (raw === undefined) return fallback;
  const text = raw.trim();
  if (text === "" || text === "undefined") return fallback;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

/**
 * Inteiro estritamente **positivo**; `<= 0` (ou inválido) cai no default. Usado
 * onde `0`/negativo seria um modo degenerado silencioso — p.ex. `ingest.batch_size`
 * com `LIMIT 0`/`LIMIT -n` (que no SQLite significa "sem limite") travaria ou
 * varreria a tabela.
 */
function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  const n = resolveInt(raw, fallback);
  return n > 0 ? n : fallback;
}

/** Objeto de chunking válido? (as chaves são o contrato do indexer) */
function isChunkingOptions(v: unknown): v is ChunkingOptions {
  if (!isPlainObject(v)) return false;
  const strategy = v.strategy;
  if (strategy !== undefined) {
    if (!(CHUNKING_STRATEGIES as readonly unknown[]).includes(strategy)) return false;
  }
  for (const k of ["max_lines", "overlap_lines"]) {
    const n = v[k];
    if (n !== undefined && (!Number.isInteger(n) || (n as number) < 0)) return false;
  }
  for (const k of ["include_context", "token_counting"]) {
    const b = v[k];
    if (b !== undefined && typeof b !== "boolean") return false;
  }
  return true;
}

/**
 * Normaliza um objeto de chunking VÁLIDO para uma forma segura antes de
 * repassá-lo ao indexer.
 *
 * Regra crítica: `symbol_boundary` com `max_lines > 0` (ou ausente, que o indexer
 * defaulta para 200) DESCARTA símbolos maiores que o limite — o arquivo pode
 * emitir ZERO chunks e o coletor, no full, o trata como removido e APAGA seus
 * chunks do grafo. Aqui forçamos `max_lines: 0` nessa estratégia. Defesa em
 * profundidade: o indexer também foi corrigido para nunca descartar, mas impor
 * o valor certo aqui evita depender do binário.
 */
function normalizeChunking(v: ChunkingOptions): ChunkingOptions {
  if (v.strategy === "symbol_boundary") {
    return { ...v, max_lines: 0 };
  }
  return v;
}

/**
 * Resolve `code_index.chunking` por precedência `options` > env > arquivo >
 * default. Aceita um OBJETO (de `options`/do arquivo) ou uma STRING JSON (de
 * env). Valor inválido cai no default — nunca lança nem produz um objeto
 * malformado (que faria o indexer responder `INVALID_PAYLOAD` e abortar o job).
 * Um objeto válido passa por `normalizeChunking` (fecha o footgun do
 * `symbol_boundary` sem `max_lines`).
 */
function resolveChunking(
  val: unknown,
  envValue: string | undefined,
  fileValue: string | undefined,
  fallback: ChunkingOptions,
): ChunkingOptions {
  if (isChunkingOptions(val)) return normalizeChunking(val);
  const raw = envValue ?? fileValue;
  if (raw !== undefined && raw.trim() !== "" && raw.trim() !== "undefined") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isChunkingOptions(parsed)) return normalizeChunking(parsed);
    } catch {
      // String não-JSON ⇒ default (modo degenerado não passa em silêncio).
    }
  }
  return fallback;
}

/**
 * Valida `options.backpressure`. O indexer REJEITA o job (`BACKPRESSURE_CONFIG`)
 * com `max_queue_size < 10` ou `threshold_percent` fora de 80–99 — um valor
 * inválido abortaria a coleta inteira. Campo inválido cai no default.
 */
function isBackpressureOptions(v: unknown): v is BackpressureOptions {
  if (!isPlainObject(v)) return false;
  const q = v.max_queue_size;
  if (q !== undefined && (!Number.isInteger(q) || (q as number) < 10)) return false;
  const t = v.threshold_percent;
  if (t !== undefined && (!Number.isInteger(t) || (t as number) < 80 || (t as number) > 99)) {
    return false;
  }
  if (v.ack_required !== undefined && typeof v.ack_required !== "boolean") return false;
  const p = v.pause_timeout_secs;
  if (p !== undefined && (!Number.isInteger(p) || (p as number) < 0)) return false;
  return true;
}

/** `code_index.backpressure`: objeto, `false` (desliga) ou default. */
function resolveBackpressure(
  val: unknown,
  envValue: string | undefined,
  fileValue: string | undefined,
  fallback: BackpressureOptions | false,
): BackpressureOptions | false {
  if (val === false) return false;
  if (isBackpressureOptions(val)) return val;
  const raw = envValue ?? fileValue;
  if (raw !== undefined && raw.trim() !== "" && raw.trim() !== "undefined") {
    if (raw.trim() === "false") return false;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isBackpressureOptions(parsed)) return parsed;
    } catch {
      // não-JSON ⇒ default
    }
  }
  return fallback;
}

/**
 * Valida `options.cpu_guard`. Percentuais em 0–100, `sample_ms` positivo e
 * `resume_percent <= threshold_percent` (senão a guarda oscilaria).
 */
function isCpuGuardOptions(v: unknown): v is CpuGuardOptions {
  if (!isPlainObject(v)) return false;
  if (v.enabled !== undefined && typeof v.enabled !== "boolean") return false;
  for (const k of ["threshold_percent", "resume_percent"]) {
    const n = v[k];
    if (n !== undefined && (!Number.isInteger(n) || (n as number) < 0 || (n as number) > 100)) {
      return false;
    }
  }
  for (const k of ["sample_ms", "max_pause_ms"]) {
    const n = v[k];
    if (n !== undefined && (!Number.isInteger(n) || (n as number) <= 0)) return false;
  }
  const nice = v.nice;
  if (nice !== undefined && (!Number.isInteger(nice) || (nice as number) < 0 || (nice as number) > 19)) {
    return false;
  }
  const threshold = (v.threshold_percent as number | undefined) ?? 85;
  const resume = (v.resume_percent as number | undefined) ?? 75;
  return resume <= threshold;
}

/** `code_index.cpu_guard`: objeto, `false` (desliga) ou default. */
function resolveCpuGuard(
  val: unknown,
  envValue: string | undefined,
  fileValue: string | undefined,
  fallback: CpuGuardOptions | false,
): CpuGuardOptions | false {
  if (val === false) return false;
  if (isCpuGuardOptions(val)) return { ...fallback, ...val } as CpuGuardOptions;
  const raw = envValue ?? fileValue;
  if (raw !== undefined && raw.trim() !== "" && raw.trim() !== "undefined") {
    if (raw.trim() === "false") return false;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isCpuGuardOptions(parsed)) return { ...fallback, ...parsed } as CpuGuardOptions;
    } catch {
      // não-JSON ⇒ default
    }
  }
  return fallback;
}

function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "kilo");
  return join(homedir(), ".config", "kilo");
}

/** Objeto simples (não array/nulo) — candidato a merge recursivo. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Merge **profundo** (só um nível de recursão basta: a config é `{secao:{chave}}`).
 * Um objeto aninhado do arquivo do workspace complementa o do global em vez de
 * substituí-lo inteiro — sem isso, split de chaves entre os dois arquivos (ex.:
 * `daemon.url` no global, `daemon.program` no workspace) descartava uma delas.
 */
function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const prev = out[k];
    out[k] = isPlainObject(prev) && isPlainObject(v) ? deepMerge(prev, v) : v;
  }
  return out;
}

/**
 * Carrega `.kilo/graph-plugin.json` do workspace (resolvido no runtime do Kilo)
 * mesclado sobre o global `~/.config/kilo/graph-plugin.json`. O `dir` do
 * workspace é a fonte de escopo — nunca `process.cwd()` (plugin global). O merge
 * é **profundo** (ver `deepMerge`).
 */
function loadConfigFile(dir: string): Record<string, unknown> {
  const paths = [
    join(globalConfigDir(), "graph-plugin.json"),
    join(dir, ".kilo", "graph-plugin.json"),
  ];
  let result: Record<string, unknown> = {};
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
      if (isPlainObject(parsed)) result = deepMerge(result, parsed);
    } catch {
      // Arquivo de config corrompido não é fatal — defaults assumem.
    }
  }
  return result;
}

/**
 * Como `resolveOverride`, mas SEM fallback: devolve `undefined` quando nada foi
 * configurado (necessário para chaves cujo default é "desligado", D7).
 */
function resolveOptional(
  val: unknown,
  envValue: string | undefined,
  fileValue: string | undefined,
): string | undefined {
  if (val !== undefined && val !== null) {
    if (typeof val === "string") {
      const m = /^\{env:(.+)\}$/.exec(val);
      if (m) return process.env[m[1] as string] ?? fileValue ?? undefined;
    }
    return String(val).trim();
  }
  const raw = envValue ?? fileValue;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Lê um valor aninhado do arquivo de config (ex.: `inject.memory_max_tokens`). */
function filePick(
  file: Record<string, unknown>,
  path: string,
): string | undefined {
  const parts = path.split(".");
  let cur: unknown = file;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  if (cur === undefined || cur === null) return undefined;
  return typeof cur === "string" ? cur : JSON.stringify(cur);
}

/**
 * Envs LEGADAS de limite de injeção (ADR-009, decisão 5). Montadas a partir do
 * prefixo comum **de propósito**: o critério de aceite do ADR-009 exige que o
 * repositório não guarde referência mecânica às chaves antigas (busca no `src/`
 * por elas retorna zero), e estes nomes existem só AQUI, para **detectar e
 * avisar** — nunca para ler um valor. Escrever o nome inteiro faria o próprio
 * aviso de depreciação reprovar a checagem; a montagem preserva os dois
 * contratos (aviso + busca limpa).
 */
const LEGACY_INJECT_PREFIX = "KILOCODE_GRAPH_INJECT";
const LEGACY_INJECT_ENVS = [
  `${LEGACY_INJECT_PREFIX}_MAX_CHARS`,
  `${LEGACY_INJECT_PREFIX}_MAX_TOKENS`,
] as const;

/**
 * Aviso de depreciação das envs LEGADAS (ADR-009, decisão 5). O teto de chars do
 * cliente e o `max_tokens` compartilhado deixaram de ser lidos; se o ambiente
 * ainda os seta, o boot emite **um** log de aviso (depreciação + chave
 * substituta) — quem calibrou não perde o ajuste em silêncio. Pura e testável:
 * devolve a linha ou `null` quando nenhuma env legada está setada.
 */
export function legacyInjectWarning(env: NodeJS.ProcessEnv): string | null {
  const set = LEGACY_INJECT_ENVS.filter((name) => {
    const v = env[name];
    return v !== undefined && v.trim() !== "";
  });
  if (set.length === 0) return null;
  return (
    `config: env(s) legada(s) de limite de injeção setada(s): ` +
    `${set.join(", ")} — DEPRECIADA(s) e IGNORADA(s); use ` +
    `KILOCODE_GRAPH_INJECT_MEMORY_MAX_TOKENS e/ou ` +
    `KILOCODE_GRAPH_INJECT_CODE_MAX_TOKENS (ADR-009)`
  );
}

/**
 * Monta a configuração efetiva. `options` vem do `kilo.jsonc`; env e arquivos
 * são lidos do ambiente/workspace. `dir` é o diretório do workspace resolvido
 * no runtime do Kilo (`resolveWorkspaceDir(ctx)`); default `process.cwd()` só
 * para chamadas legadas/teste — o boot de produção SEMPRE passa o `dir`.
 */
export function loadConfig(
  options?: PluginOptions,
  dir: string = process.cwd(),
): Config {
  const env = process.env;
  const file = loadConfigFile(dir);

  // ADR-009, decisão 5: envs legadas setadas ⇒ **um** aviso (nunca silêncio).
  const legacy = legacyInjectWarning(env);
  if (legacy) log(legacy);

  const resolve = (
    key: string,
    envName: string,
    fallback: string,
  ): string =>
    resolveOverride(pick(options, key), env[envName], filePick(file, key), fallback);

  return {
    daemon: {
      url: resolve("daemon.url", "KILOCODE_GRAPH_URL", DEFAULTS.daemon.url),
      token_file: resolve(
        "daemon.token_file",
        "KILOCODE_GRAPH_TOKEN_FILE",
        DEFAULTS.daemon.token_file,
      ),
      // `trim()`: um token só-espaços não pode vencer o `token_file` (defeito
      // medido — virava `Authorization: Bearer    ` e o arquivo nunca era lido).
      token: env.KILOCODE_GRAPH_TOKEN?.trim() ?? "",
      // Env-only, como `token`: o bearer do gestor é credencial viva, não config
      // de arquivo. Vazio ⇒ provisionamento desligado.
      manager_token: env.KILOCODE_GRAPH_MANAGER_TOKEN?.trim() ?? "",
      program: resolve(
        "daemon.program",
        "KILOCODE_GRAPH_PROGRAM",
        DEFAULTS.daemon.program,
      ),
      workspace: resolve(
        "daemon.workspace",
        "KILOCODE_GRAPH_WORKSPACE",
        DEFAULTS.daemon.workspace,
      ),
      health_timeout_ms: resolveInt(
        resolve(
          "daemon.health_timeout_ms",
          "KILOCODE_GRAPH_HEALTH_TIMEOUT_MS",
          String(DEFAULTS.daemon.health_timeout_ms),
        ),
        DEFAULTS.daemon.health_timeout_ms,
      ),
      node_bin: resolve(
        "daemon.node_bin",
        "KILOCODE_GRAPH_NODE_BIN",
        DEFAULTS.daemon.node_bin,
      ),
    },
    inject: {
      enabled: resolveBool(
        resolve(
          "inject.enabled",
          "KILOCODE_GRAPH_INJECT_ENABLED",
          String(DEFAULTS.inject.enabled),
        ),
        DEFAULTS.inject.enabled,
      ),
      max_memories: resolveInt(
        resolve(
          "inject.max_memories",
          "KILOCODE_GRAPH_INJECT_MAX_MEMORIES",
          String(DEFAULTS.inject.max_memories),
        ),
        DEFAULTS.inject.max_memories,
      ),
      memory_max_tokens: resolveTokenCap(
        resolve(
          "inject.memory_max_tokens",
          "KILOCODE_GRAPH_INJECT_MEMORY_MAX_TOKENS",
          String(DEFAULTS.inject.memory_max_tokens),
        ),
        DEFAULTS.inject.memory_max_tokens,
      ),
      code_max_tokens: resolveTokenCap(
        resolve(
          "inject.code_max_tokens",
          "KILOCODE_GRAPH_INJECT_CODE_MAX_TOKENS",
          String(DEFAULTS.inject.code_max_tokens),
        ),
        DEFAULTS.inject.code_max_tokens,
      ),
      timeout_ms: resolveInt(
        resolve(
          "inject.timeout_ms",
          "KILOCODE_GRAPH_INJECT_TIMEOUT_MS",
          String(DEFAULTS.inject.timeout_ms),
        ),
        DEFAULTS.inject.timeout_ms,
      ),
      code_enabled: resolveBool(
        resolve(
          "inject.code_enabled",
          "KILOCODE_GRAPH_INJECT_CODE_ENABLED",
          String(DEFAULTS.inject.code_enabled),
        ),
        DEFAULTS.inject.code_enabled,
      ),
      max_code_chunks: resolveInt(
        resolve(
          "inject.max_code_chunks",
          "KILOCODE_GRAPH_INJECT_MAX_CODE_CHUNKS",
          String(DEFAULTS.inject.max_code_chunks),
        ),
        DEFAULTS.inject.max_code_chunks,
      ),
      code_labels: resolveCodeLabels(
        resolveOptional(
          pick(options, "inject.code_labels"),
          env.KILOCODE_GRAPH_INJECT_CODE_LABELS,
          filePick(file, "inject.code_labels"),
        ),
        DEFAULTS.inject.code_labels,
      ),
      code_min_score: resolveOptionalScore(
        resolveOptional(
          pick(options, "inject.code_min_score"),
          env.KILOCODE_GRAPH_INJECT_CODE_MIN_SCORE,
          filePick(file, "inject.code_min_score"),
        ),
        DEFAULTS.inject.code_min_score,
      ),
    },
    code_index: {
      enabled: resolveBool(
        resolve(
          "code_index.enabled",
          "KILOCODE_GRAPH_INDEX_ENABLED",
          String(DEFAULTS.code_index.enabled),
        ),
        DEFAULTS.code_index.enabled,
      ),
      indexer_bin: resolve(
        "code_index.indexer_bin",
        "KILOCODE_GRAPH_INDEXER_BIN",
        DEFAULTS.code_index.indexer_bin,
      ),
      sync_timeout_ms: resolveInt(
        resolve(
          "code_index.sync_timeout_ms",
          "KILOCODE_GRAPH_INDEX_SYNC_TIMEOUT_MS",
          String(DEFAULTS.code_index.sync_timeout_ms),
        ),
        DEFAULTS.code_index.sync_timeout_ms,
      ),
      load_ignores: resolveBool(
        resolve(
          "code_index.load_ignores",
          "KILOCODE_GRAPH_INDEX_LOAD_IGNORES",
          String(DEFAULTS.code_index.load_ignores),
        ),
        DEFAULTS.code_index.load_ignores,
      ),
      chunking: resolveChunking(
        pick(options, "code_index.chunking"),
        env.KILOCODE_GRAPH_INDEX_CHUNKING,
        filePick(file, "code_index.chunking"),
        DEFAULTS.code_index.chunking,
      ),
      backpressure: resolveBackpressure(
        pick(options, "code_index.backpressure"),
        env.KILOCODE_GRAPH_INDEX_BACKPRESSURE,
        filePick(file, "code_index.backpressure"),
        DEFAULTS.code_index.backpressure,
      ),
      cpu_guard: resolveCpuGuard(
        pick(options, "code_index.cpu_guard"),
        env.KILOCODE_GRAPH_INDEX_CPU_GUARD,
        filePick(file, "code_index.cpu_guard"),
        DEFAULTS.code_index.cpu_guard,
      ),
    },
    ingest: {
      enabled: resolveBool(
        resolve(
          "ingest.enabled",
          "KILOCODE_GRAPH_INGEST_ENABLED",
          String(DEFAULTS.ingest.enabled),
        ),
        DEFAULTS.ingest.enabled,
      ),
      batch_size: resolvePositiveInt(
        resolve(
          "ingest.batch_size",
          "KILOCODE_GRAPH_INGEST_BATCH_SIZE",
          String(DEFAULTS.ingest.batch_size),
        ),
        DEFAULTS.ingest.batch_size,
      ),
      max_hashes: resolveInt(
        resolve(
          "ingest.max_hashes",
          "KILOCODE_GRAPH_INGEST_MAX_HASHES",
          String(DEFAULTS.ingest.max_hashes),
        ),
        DEFAULTS.ingest.max_hashes,
      ),
      timeout_ms: resolveInt(
        resolve(
          "ingest.timeout_ms",
          "KILOCODE_GRAPH_INGEST_TIMEOUT_MS",
          String(DEFAULTS.ingest.timeout_ms),
        ),
        DEFAULTS.ingest.timeout_ms,
      ),
    },
    mcp: {
      enabled: resolveBool(
        resolve(
          "mcp.enabled",
          "KILOCODE_GRAPH_MCP_ENABLED",
          String(DEFAULTS.mcp.enabled),
        ),
        DEFAULTS.mcp.enabled,
      ),
      name: resolve("mcp.name", "KILOCODE_GRAPH_MCP_NAME", DEFAULTS.mcp.name),
      timeout_ms: resolveInt(
        resolve(
          "mcp.timeout_ms",
          "KILOCODE_GRAPH_MCP_TIMEOUT_MS",
          String(DEFAULTS.mcp.timeout_ms),
        ),
        DEFAULTS.mcp.timeout_ms,
      ),
    },
    debug: resolveBool(
      resolve("debug", "KILOCODE_GRAPH_DEBUG", String(DEFAULTS.debug)),
      DEFAULTS.debug,
    ),
  };
}

// --- E3a-S6 §7: paridade de config boot × CLI --------------------------------

/** Arquivo de config persistida (estado local, não versionado). */
export const CONFIG_STATE_REL_PATH = ".kilo/graph-config.json";

/** Sentinela que arma o incremental (criado ao concluir o full inicial). */
export const READY_REL_PATH = ".kilo/graph-ready";

/**
 * Config efetiva → objeto no formato de `options` (o 2º elemento da tupla do
 * plugin). **Segredos são removidos**: `daemon.token`/`daemon.manager_token` são
 * credenciais vivas (env) e **nunca** vão para o arquivo persistido — só a chave
 * do workspace (`graph-key.json`, `0600`) carrega token. As demais chaves são
 * valores resolvidos (config, não segredo), então reproduzem a config do boot.
 */
export function configStateFrom(config: Config): PluginOptions {
  return {
    daemon: {
      url: config.daemon.url,
      token_file: config.daemon.token_file,
      program: config.daemon.program,
      workspace: config.daemon.workspace,
      health_timeout_ms: config.daemon.health_timeout_ms,
      node_bin: config.daemon.node_bin,
    },
    inject: {
      enabled: config.inject.enabled,
      max_memories: config.inject.max_memories,
      memory_max_tokens: config.inject.memory_max_tokens,
      code_max_tokens: config.inject.code_max_tokens,
      timeout_ms: config.inject.timeout_ms,
      code_enabled: config.inject.code_enabled,
      max_code_chunks: config.inject.max_code_chunks,
    },
    code_index: {
      enabled: config.code_index.enabled,
      indexer_bin: config.code_index.indexer_bin,
      sync_timeout_ms: config.code_index.sync_timeout_ms,
      load_ignores: config.code_index.load_ignores,
      chunking: config.code_index.chunking,
      backpressure: config.code_index.backpressure,
      cpu_guard: config.code_index.cpu_guard,
    },
    ingest: {
      enabled: config.ingest.enabled,
      batch_size: config.ingest.batch_size,
      max_hashes: config.ingest.max_hashes,
      timeout_ms: config.ingest.timeout_ms,
    },
    mcp: {
      enabled: config.mcp.enabled,
      name: config.mcp.name,
      timeout_ms: config.mcp.timeout_ms,
    },
    debug: config.debug,
  };
}

/**
 * Lê a config persistida do workspace (estado local). Ausente/corrompido ⇒
 * `undefined` (o CLI cai no path de config normal: env > arquivo > default).
 * **Nunca lança.**
 */
export function loadConfigState(dir: string): PluginOptions | undefined {
  const path = join(dir, CONFIG_STATE_REL_PATH);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Grava a config efetiva do boot em `<dir>/.kilo/graph-config.json` (escrita
 * atômica tmp+rename; segredos removidos por `configStateFrom`). É a **fonte
 * única** de config para o CLI standalone (§7): sem isso, config só-no-inline do
 * `kilo.jsonc` divergiria entre boot e CLI. **Nunca lança** — falha é debug.
 */
export function persistConfigState(dir: string, config: Config): void {
  const path = join(dir, CONFIG_STATE_REL_PATH);
  try {
    const parent = dirname(path);
    if (parent && parent !== ".") mkdirSync(parent, { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(configStateFrom(config), null, 2)}\n`, "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    debug(
      `config: estado não persistido (${err instanceof Error ? err.message : err})`,
    );
  }
}

/**
 * Hook `experimental.chat.system.transform` (E8-S2) — instrução de uso do
 * memtier.
 *
 * Hook **irmão** do `messages.transform` (não substituto): o bloco injetado
 * carrega os ids (`[id=…]`, `[ep=…]`); o system prompt carrega o PROTOCOLO de
 * como expandir por eles com as tools MCP (RFC-001 §6). Sem duplicação: o
 * bloco não repete a legenda (custaria tokens em todo turno).
 *
 * Decisões aplicadas (spec §"Decisões de design fixadas"):
 *   - 6: a lista de tools é DERIVADA da config — `mcp.enabled` para memória,
 *     `+ code_index.enabled` para código (pull ≠ push; `inject.code_enabled`
 *     governa o bloco empurrado, não a tool). `ingest`/`code_sync` nunca
 *     aparecem: são escrita, não do turno do agente.
 *   - 7: efetiva só com `inject.enabled` **e** `mcp.enabled`;
 *     `instruction_enabled` governa o texto.
 *   - 8: `output.system.push` (nunca substitui o prompt do host); idempotente;
 *     **nunca lança** (NFR-03); `output.system` fora da forma ⇒ não escreve.
 *
 * Custo: reenviado a cada turno, então o teto é contrato (`≤ 1000` chars; a
 * redação final mede 707 com código e 555 sem — o rascunho media 870). Unidade
 * `chars/4` (ADR-009).
 */

/** Teto do texto da instrução (chars). Reenviado a cada turno: é contrato. */
export const INSTRUCTION_MAX_CHARS = 1000;

/** Dependências do hook — só config efetiva, sem I/O (ADR-004). */
export interface SystemRuntime {
  /** `inject.enabled` — sem injeção não há bloco nem protocolo. */
  enabled: boolean;
  /** `inject.instruction_enabled` — governa o TEXTO, não o bloco. */
  instructionEnabled: boolean;
  /** `mcp.enabled` — sem MCP não existe tool a anunciar. */
  mcpEnabled: boolean;
  /** `code_index.enabled` — há chunks/arestas no grafo (conteúdo, não push). */
  codeIndexEnabled: boolean;
}

/** Subconjunto da `Config` que a instrução lê (nada além das três flags). */
export interface SystemConfig {
  inject: { enabled: boolean; instruction_enabled: boolean };
  mcp: { enabled: boolean };
  code_index: { enabled: boolean };
}

/**
 * `Config` efetiva → runtime do hook. Existe para a derivação ser **pura e
 * testável sem boot** (um boot com `code_index.enabled` spawna o indexer — não
 * cabe num teste de unidade).
 *
 * Deliberadamente **não** lê `inject.code_enabled`: as tools de código são
 * PULL e dependem do CONTEÚDO (`code_index.enabled`), não do bloco empurrado
 * (decisão 6). Essa é a linha que o teste de derivação protege.
 */
export function systemRuntimeFrom(config: SystemConfig): SystemRuntime {
  return {
    enabled: config.inject.enabled,
    instructionEnabled: config.inject.instruction_enabled,
    mcpEnabled: config.mcp.enabled,
    codeIndexEnabled: config.code_index.enabled,
  };
}

/** Parágrafo 1 — o que o bloco é (amostra, não o conjunto). */
const INTRO =
  "O workspace tem um grafo consultável via MCP. Os blocos de contexto " +
  "injetados (graph-memory e graph-code) são uma AMOSTRA, não o conjunto: " +
  "cite pelo id e expanda quando a resposta exigir o que não está no bloco.";

/** Parágrafo 2 — como expandir, com a chave de entrada de cada tool. */
function expansionParagraph(rt: SystemRuntime): string {
  const lines = [
    "- memory_neighbors (uuid do [id=…]): fatos vizinhos do fato.",
    "- memory_episodes (uuids do [ep=…]): conteúdo original do episódio.",
    "- recall (nova query; filtros as_of, depth, entity_types): outra busca.",
  ];
  if (rt.codeIndexEnabled) {
    lines.push(
      "- code_neighbors (uuid do [id=…]; direction, edge_kind, depth): " +
        "arestas do chunk.",
      "- code_search (nova query; labels, min_score): outra busca de código.",
    );
  }
  return `Expanda com as tools, usando o id como chave de entrada:\n${lines.join("\n")}`;
}

/** Parágrafo 3 — vocabulário dos ids. */
const VOCABULARY =
  "Os ids: [id=…] é o uuid do fato ou do chunk; [ep=…] é o uuid do episódio " +
  "de origem.";

/**
 * Texto da instrução, derivado da config efetiva — `null` quando nada deve ser
 * anunciado. Pura: sem I/O, sem log; fácil de medir e testar.
 */
export function buildInstruction(rt: SystemRuntime): string | null {
  if (!rt.enabled || !rt.instructionEnabled || !rt.mcpEnabled) return null;
  return [INTRO, expansionParagraph(rt), VOCABULARY].join("\n\n");
}

/** Forma mínima do `output` do hook (`system: string[]`). */
interface SystemOutput {
  system?: unknown;
}

/**
 * Acrescenta a instrução ao system prompt. **Nunca lança**: config ausente,
 * `output` malformado ou `system` que não é array terminam em no-op. Idempotente
 * — confere se o texto já está lá antes de empurrar (defesa contra reentrância
 * do host, que reusa o mesmo `output`).
 */
export function appendInstruction(rt: SystemRuntime, output: SystemOutput): void {
  try {
    if (!rt || typeof rt !== "object") return;
    const text = buildInstruction(rt);
    if (!text) return;
    const system = output?.system;
    if (!Array.isArray(system)) return;
    if (system.includes(text)) return;
    system.push(text);
  } catch {
    // NFR-03: falhar aqui não pode derrubar o turno.
  }
}

/** Registra o hook no formato do Kilo (`{ "hook.name": fn }`). */
export function systemHook(rt: SystemRuntime) {
  return {
    "experimental.chat.system.transform": async (
      _input: Record<string, unknown>,
      output: { system: string[] },
    ): Promise<void> => {
      appendInstruction(rt, output);
    },
  };
}

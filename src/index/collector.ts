/**
 * `collector.ts` — eventos do indexer → body do `POST /v1/code/sync`.
 *
 * E3a-S1 (tracer): agrupa `chunk_emitted` por `file` em `files[]`; `symbol_id` do
 * indexer é o NOME PURO (`protocol.md:105`) — usa-se CRU. E3a-S2: arestas
 * resolvidas (orfã descartada). E3a-S3: `FullFile` sintético quando o indexer não
 * o emite (necessário para as arestas de import em nível de arquivo, ADR-012 D3)
 * e **removidos** (`chunks: []`).
 *
 * Puro quanto a eventos → estruturas; o `readFile` (para o `FullFile` sintético)
 * e os removidos entram por injeção — sem I/O de rede.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { CodeChunk, CodeEdge, CodeFile, IndexerEvent } from "../types.ts";
import {
  resolveEdges,
  type CallEdge,
  type ImportEdge,
} from "./edges.ts";

/** Identidade lógica do sync (aditiva E11: `program`). */
export interface SyncIdentity {
  workspace: string;
  program: string;
}

/** Body de `POST /v1/code/sync`. */
export interface SyncBody extends SyncIdentity {
  files: CodeFile[];
  edges: CodeEdge[];
}

/** Leitor de arquivo injetável (default `readFileSync` utf-8). */
export type ReadFileLike = (path: string) => string;

/** Opções de `buildSyncBody` (S3+): leitor do `FullFile` e removidos. */
export interface BuildBodyOptions {
  /** Lê o texto do arquivo para o `FullFile` sintético. Default `readFileSync`. */
  readFile?: ReadFileLike;
  /** Arquivos removidos (estavam no manifest, sumiram) ⇒ `chunks: []`. */
  removed?: string[];
  /** Raiz do repo (para o `readFile` default resolver caminho relativo). */
  repoRoot?: string;
}

const CHUNK_KINDS = new Set(["Symbol", "FullFile", "Contextual"]);

/** Coerção estrita a número inteiro ≥0 (payload pode trazer `null`/string). */
function toInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

/**
 * `symbol_id` em NOME PURO (protocol.md:105). O indexer já o emite cru; o
 * `rsplit(":")` é **cinto de segurança** (mesma tolerância do probe) contra uma
 * versão que volte a qualificar com o caminho — nunca reconcatenar `file`.
 */
function bareSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const bare = raw.split(":").pop() ?? "";
  return bare.trim() === "" ? null : bare;
}

/** Mapeia um kind não-`Symbol` para `FullFile`/`Contextual` (default `Symbol`). */
function normalizeKind(raw: unknown): CodeChunk["chunk_kind"] {
  return typeof raw === "string" && CHUNK_KINDS.has(raw)
    ? (raw as CodeChunk["chunk_kind"])
    : "Symbol";
}


/** Payload de `chunk_emitted` como objeto (ou `null` se malformado). */
function chunkPayload(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  return payload as Record<string, unknown>;
}

/** Separa os eventos de aresta (`import_edge`/`call_edge`) do stream de chunks. */
export function collectEdges(events: IndexerEvent[]): {
  imports: ImportEdge[];
  calls: CallEdge[];
} {
  const imports: ImportEdge[] = [];
  const calls: CallEdge[] = [];
  for (const ev of events) {
    const payload = chunkPayload(ev.payload);
    if (!payload) continue;
    if (ev.event === "import_edge") imports.push(payload as ImportEdge);
    else if (ev.event === "call_edge") calls.push(payload as CallEdge);
  }
  return { imports, calls };
}

/**
 * Converte um `chunk_emitted` no `CodeChunk` do contrato, ou `null` se o payload
 * não tem o mínimo (sem `file`, `chunk_md5` ou `chunk_id` o servidor rejeitaria).
 */
export function toChunk(payload: Record<string, unknown>): CodeChunk | null {
  const chunkId = payload.chunk_id;
  const md5 = payload.chunk_md5;
  if (typeof chunkId !== "string" || chunkId.trim() === "") return null;
  if (typeof md5 !== "string" || md5.trim() === "") return null;

  const rawKind = payload.chunk_kind;
  const chunkKind = normalizeKind(rawKind);

  // O indexer emite `symbol_id` como nome puro; `bareSymbol` faz o rsplit de
  // segurança contra uma versão que volte a qualificar com o caminho.
  const rawSym = payload.symbol_id;
  const symbol = bareSymbol(rawSym);

  const text = typeof payload.text === "string" ? payload.text : "";
  const capped = capChunkText(text);
  const cut = capped !== text || typeof payload.text !== "string";
  const startLine = toInt(payload.start_line);
  // `end_line` do indexer só vale para o texto ORIGINAL; após o corte, o texto
  // enviado tem menos linhas — manter o valor antigo faria o servidor inferir
  // linhas que não existem no chunk. Sem corte, preserva o do indexer.
  const endLine = cut
    ? startLine + Math.max(0, capped.split("\n").length - 1)
    : toInt(payload.end_line);
  return {
    chunk_id: chunkId,
    chunk_kind: chunkKind as CodeChunk["chunk_kind"],
    symbol_id: chunkKind === "Symbol" ? symbol : null,
    start_line: startLine,
    end_line: endLine,
    // Se o texto enviado NÃO é exatamente o do indexer (corte em Symbol grande,
    // ou `text` ausente/não-string), o md5 do indexer deixa de descrevê-lo — o
    // servidor usa o md5 para decidir reingestão, e um md5 mentiroso pularia a
    // atualização. Só conserva o md5 do indexer quando o texto é idêntico.
    chunk_md5: !cut ? md5 : md5Hex(capped),
    text: capped,
  };
}

/**
 * Agrupa `chunk_emitted` por arquivo em `CodeFile[]` (ordem de primeira
 * aparição). Eventos de outro tipo (import/call/capabilities/job_*) são
 * ignorados nesta fatia.
 */
export function collectFiles(events: IndexerEvent[]): CodeFile[] {
  const byFile = new Map<string, CodeFile>();
  for (const ev of events) {
    if (ev.event !== "chunk_emitted") continue;
    const payload = chunkPayload(ev.payload);
    if (!payload) continue;
    const file = payload.file;
    if (typeof file !== "string" || file.trim() === "") continue;

    let entry = byFile.get(file);
    if (!entry) {
      const lang = payload.language;
      entry = {
        file_path: file,
        language: typeof lang === "string" && lang ? lang : "rust",
        chunks: [],
      };
      byFile.set(file, entry);
    }
    const chunk = toChunk(payload);
    if (chunk) entry.chunks.push(chunk);
  }
  return [...byFile.values()];
}

/**
 * `true` se há um `FullFile`/`Contextual` no arquivo (≤1 por arquivo; identidade
 * `file:chunk_kind` — ADR-002). O indexer emite só `Symbol`; o `FullFile` é
 * sintetizado por `ensureFullFile`.
 */
function hasFileChunk(entry: CodeFile): boolean {
  return entry.chunks.some((c) => c.chunk_kind !== "Symbol");
}

/** md5 hex (mesmo algoritmo do probe: `hashlib.md5(texto.encode())`). */
function md5Hex(text: string): string {
  return createHash("md5").update(text, "utf-8").digest("hex");
}

/**
 * Teto do texto de QUALQUER chunk (chars). O memtier rejeita chunk com `text`
 * acima de `MAX_TEXT_LENGTH=100000` (422 `string_too_long`); o `FullFile`
 * carrega o arquivo inteiro e estourava em arquivos grandes (ex.: 178070 chars),
 * derrubando o LOTE inteiro. Trunca com margem para nunca gerar 422 por tamanho.
 */
export const MAX_FULLFILE_CHARS = 90_000;

/** Marca de corte anexada ao texto truncado (cabe dentro do teto). */
const TRUNC_MARK = "\n… [truncated]";

/**
 * Corta `text` em `keep` unidades UTF-16 **sem partir um par substituto**
 * (emoji/símbolos astrais). Um corte no meio de um par deixa um surrogate solto
 * — Unicode inválido, que o memtier pode rejeitar (422). Recua uma unidade
 * quando a fronteira cai entre o high e o low surrogate.
 */
function sliceWholeChars(text: string, keep: number): string {
  if (keep <= 0) return "";
  if (keep >= text.length) return text;
  const last = text.charCodeAt(keep - 1);
  // High surrogate (D800–DBFF) na fronteira ⇒ o low (DC00–DFFF) ficaria de fora.
  if (last >= 0xd800 && last <= 0xdbff) return text.slice(0, keep - 1);
  return text.slice(0, keep);
}

/**
 * Trunca o texto de um chunk ao teto, anexando a marca de corte **dentro** do
 * limite. Sem a marca, o consumidor não distingue um arquivo completo de um
 * truncado (navegação/`end_line` mentiriam sem aviso).
 */
export function capChunkText(text: string): string {
  if (text.length <= MAX_FULLFILE_CHARS) return text;
  const keep = Math.max(0, MAX_FULLFILE_CHARS - TRUNC_MARK.length);
  return `${sliceWholeChars(text, keep)}${TRUNC_MARK}`;
}

/**
 * Insere o `FullFile` sintético quando o indexer não o emitiu (o probe o
 * materializa — `probe_e2e_lifecycle.py:205`). Necessário porque `import_edge`
 * em nível de arquivo resolve para `{file}:FullFile` (ADR-012 D3). Se o arquivo
 * não puder ser lido, usa texto vazio (o `FullFile` ainda existe como nó).
 * Texto acima de `MAX_FULLFILE_CHARS` é truncado com marca (`capChunkText`); o
 * `end_line` reflete o texto enviado, não o arquivo original.
 */
export function ensureFullFile(
  entry: CodeFile,
  repoRoot: string,
  read: ReadFileLike,
): CodeFile {
  if (hasFileChunk(entry)) return entry;
  const abs = repoRoot ? join(repoRoot, entry.file_path) : entry.file_path;
  let text = "";
  try {
    text = read(abs);
  } catch {
    text = "";
  }
  const capped = capChunkText(text);
  const full: CodeChunk = {
    chunk_id: `full-${entry.file_path}`,
    chunk_kind: "FullFile",
    symbol_id: null,
    start_line: 1,
    // `end_line` reflete o texto ENVIADO (após o corte), não o arquivo original —
    // o servidor não deve inferir linhas que não estão no chunk.
    end_line: Math.max(1, capped.split("\n").length),
    chunk_md5: md5Hex(capped),
    text: capped,
  };
  return { ...entry, chunks: [full, ...entry.chunks] };
}

/** Arquivo removido (estava no manifest, sumiu) ⇒ `chunks: []` (FR-504). */
export function removedFile(path: string): CodeFile {
  return { file_path: path, language: "rust", chunks: [] };
}

/**
 * Eventos → body do sync. S3: inclui `edges[]` resolvidas, `FullFile` sintético
 * quando ausente (habilitando as arestas de import) e os `removed` (`chunks: []`).
 */
/** Leitor de arquivo padrão (utf-8; erro ⇒ texto vazio). */
export function defaultReadFile(p: string): string {
  try {
    return readFileSync(p, "utf-8") as string;
  } catch {
    return "";
  }
}

export function buildSyncBody(
  events: IndexerEvent[],
  identity: SyncIdentity,
  opts: BuildBodyOptions = {},
): SyncBody {
  const repoRoot = opts.repoRoot ?? "";
  const read =
    opts.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf-8") as string;
      } catch {
        return "";
      }
    });

  const files = collectFiles(events).map((f) => ensureFullFile(f, repoRoot, read));

  // Removidos: não estão no payload atual ⇒ entram com `chunks: []`. O servidor
  // não auto-deleta arquivo ausente (spike 010, A1).
  const present = new Set(files.map((f) => f.file_path));
  const removed = (opts.removed ?? []).filter((p) => !present.has(p));
  for (const path of removed) files.push(removedFile(path));

  const { imports, calls } = collectEdges(events);
  return {
    workspace: identity.workspace,
    program: identity.program,
    files,
    edges: resolveEdges(imports, calls, files),
  };
}

/**
 * `edges.ts` — resolução de arestas `import_edge`/`call_edge` (E3a-S2).
 *
 * Contrato do memtier (ADR-012 D3): `EntityEdge` exige **os dois nós**; aresta
 * cujo alvo não existe como `CodeChunk` ⇒ **422 e derruba o lote inteiro**.
 * Aqui o alvo é resolvido **antes** de enviar; o que não resolve é **descartado**
 * (nunca inventa alvo, nunca 422).
 *
 * Resolução de módulo Rust portada do probe validado (`probe_e2e_lifecycle.py`,
 * `resolve_module`): `crate::a::b` → `src/a/b.rs`|`src/a/b/mod.rs`;
 * `self::`/`super::` relativos; `std`/`core`/`alloc` descartados; só resolve se
 * o arquivo está no conjunto indexado.
 *
 * Módulo **puro** (sem I/O). Resolução de TS/Go/Java/Python fora do MVP — sem
 * resolução, a aresta é descartada (o alvo não é inventado).
 */

import type { CodeEdge, CodeFile } from "../types.ts";

/** Payload de `import_edge` (doc/protocol.md § import_edge). */
export interface ImportEdge {
  from_file?: unknown;
  to_module?: unknown;
  imported_symbol?: unknown;
}

/** Payload de `call_edge` (doc/protocol.md § call_edge). */
export interface CallEdge {
  from_file?: unknown;
  caller_symbol_id?: unknown;
  callee_name?: unknown;
}

const EXTERNAL_HEADS = new Set(["std", "core", "alloc"]);

/** Junta segmentos de caminho em POSIX (paths do indexer são relativos, `/`). */
function joinPath(...parts: string[]): string {
  return parts.filter((p) => p !== "").join("/");
}

/** Remove `.`/`..` e colapsa barras (equivalente a `os.path.normpath`). */
function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
}

/**
 * `to_module` → arquivo do repo, ou `null` se não resolver (externo, ausente ou
 * fora do conjunto indexado). Só Rust no MVP.
 */
export function resolveModule(
  src: string,
  module: string,
  known: Set<string>,
): string | null {
  if (!module || !module.includes("::")) return null;
  const parts = module.split("::");
  const head = parts[0] as string;
  if (EXTERNAL_HEADS.has(head)) return null;

  let base: string;
  if (head === "crate") {
    base = joinPath("src", ...parts.slice(1));
  } else if (head === "self") {
    base = joinPath(dirname(src), ...parts.slice(1));
  } else if (head === "super") {
    base = joinPath(dirname(src), "..", ...parts.slice(1));
  } else {
    base = joinPath("src", ...parts);
  }
  base = normalize(base);

  for (const cand of [`${base}.rs`, joinPath(base, "mod.rs")]) {
    if (known.has(cand)) return cand;
  }
  return null;
}

/** Chave de aresta do servidor: `kind:from:fromSym|FullFile->to:toSym|FullFile`. */
function edgeKey(edge: CodeEdge): string {
  return (
    `${edge.edge_kind}:${edge.from_file}:${edge.from_symbol_id ?? "FullFile"}` +
    `->${edge.to_file}:${edge.to_symbol_id ?? "FullFile"}`
  );
}

/** Índices de símbolos dos arquivos: `(path, sym)` conhecido + símbolos por arquivo. */
export interface SymbolIndex {
  has(path: string, symbol: string): boolean;
  /** Origem de aresta existe? `null` ⇒ `FullFile`/`Contextual` do arquivo. */
  hasOrigin(path: string, symbol: string | null): boolean;
  symbolsOf(path: string): Set<string>;
  paths: string[];
}

/**
 * Entrada do índice construída SEM os chunks: `{path, symbols, hasFileChunk}`.
 * Permite resolver arestas a partir do spool em disco (streaming), sem manter o
 * texto dos chunks em RAM — só os nomes de símbolo.
 */
export interface EdgeIndexEntry {
  filePath: string;
  symbols: Iterable<string>;
  /** O arquivo terá nó `FullFile`/`Contextual` (origem de import_edge). */
  hasFileChunk: boolean;
}

/** Constrói o índice a partir de metadados já extraídos (spool). */
export function buildEdgeIndex(entries: Iterable<EdgeIndexEntry>): SymbolIndex {
  const byName = new Set<string>();
  const fullFiles = new Set<string>();
  const callable = new Map<string, Set<string>>();
  const paths: string[] = [];
  for (const e of entries) {
    paths.push(e.filePath);
    const set = new Set<string>();
    for (const sym of e.symbols) {
      byName.add(`${e.filePath}\u0000${sym}`);
      set.add(sym);
    }
    if (e.hasFileChunk) fullFiles.add(e.filePath);
    callable.set(e.filePath, set);
  }
  return {
    has: (path, symbol) => byName.has(`${path}\u0000${symbol}`),
    hasOrigin: (path, symbol) =>
      symbol === null ? fullFiles.has(path) : byName.has(`${path}\u0000${symbol}`),
    symbolsOf: (path) => callable.get(path) ?? new Set<string>(),
    paths,
  };
}

function buildIndex(files: CodeFile[]): SymbolIndex {
  return buildEdgeIndex(
    files.map((f) => ({
      filePath: f.file_path,
      symbols: f.chunks
        .filter((c) => c.chunk_kind === "Symbol" && c.symbol_id)
        .map((c) => c.symbol_id as string),
      hasFileChunk: f.chunks.some((c) => c.chunk_kind !== "Symbol"),
    })),
  );
}

/** Ultimo segmento do callee (`Parser::parse`/`dsn.to_string` → `parse`/`to_string`). */
function lastSegment(callee: string): string {
  const parts = callee.split(/::|\./);
  return parts[parts.length - 1] ?? "";
}

/**
 * Resolve `import_edge`/`call_edge` em `CodeEdge[]`. Alvo ausente é descartado;
 * aresta duplicada (mesma chave do servidor) entra uma vez só.
 */
export function resolveEdges(
  imports: ImportEdge[],
  calls: CallEdge[],
  files: CodeFile[],
): CodeEdge[] {
  return resolveEdgesWithIndex(imports, calls, buildIndex(files));
}

/** `resolveEdges` sobre um índice já construído (spool/streaming). */
export function resolveEdgesWithIndex(
  imports: ImportEdge[],
  calls: CallEdge[],
  index: SymbolIndex,
): CodeEdge[] {
  const known = new Set(index.paths);
  const edges: CodeEdge[] = [];
  const seen = new Set<string>();

  const push = (edge: CodeEdge): void => {
    const key = edgeKey(edge);
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  for (const p of imports) {
    const src = typeof p.from_file === "string" ? p.from_file : "";
    const module = typeof p.to_module === "string" ? p.to_module.trim() : "";
    if (!src) continue;
    const toFile = resolveModule(src, module, known);
    if (!toFile) continue;
    // A ORIGEM também tem de existir como CodeChunk (ADR-012 D3). `import_edge`
    // é nível de arquivo ⇒ origem `{src}:FullFile`, que só existe após o S3
    // sintetizar o `FullFile`. Até lá a aresta é descartada (nunca 422); o
    // alvo-símbolo, quando presente, exige que o nó exista.
    const sym = p.imported_symbol;
    const toSymbol = typeof sym === "string" && index.has(toFile, sym) ? sym : null;
    const edge: CodeEdge = {
      from_file: src,
      to_file: toFile,
      edge_kind: "import",
    };
    if (toSymbol) edge.to_symbol_id = toSymbol;
    if (!index.hasOrigin(src, null)) continue;
    push(edge);
  }

  for (const p of calls) {
    const caller = typeof p.caller_symbol_id === "string" ? p.caller_symbol_id : "";
    const callee = typeof p.callee_name === "string" ? p.callee_name : "";
    if (!caller || !callee) continue;

    let srcFile = typeof p.from_file === "string" ? p.from_file : "";
    let srcSym = caller.split(":").pop() ?? "";
    if (!srcFile) {
      // Compatibilidade com o protocolo antigo (`caller` embutia o arquivo).
      const idx = caller.lastIndexOf(":");
      srcFile = idx >= 0 ? caller.slice(0, idx) : "";
      srcSym = idx >= 0 ? caller.slice(idx + 1) : caller;
    }
    if (!srcFile || !index.symbolsOf(srcFile).has(srcSym)) continue;

    const needle = lastSegment(callee);
    let target: { file: string; symbol: string } | null = null;
    for (const path of index.paths) {
      if (index.has(path, needle)) {
        target = { file: path, symbol: needle };
        break;
      }
    }
    if (!target) continue;
    push({
      from_file: srcFile,
      from_symbol_id: srcSym,
      to_file: target.file,
      to_symbol_id: target.symbol,
      edge_kind: "call",
    });
  }

  return edges;
}

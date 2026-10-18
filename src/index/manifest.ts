/**
 * `manifest.ts` — estado por workspace (E3a-S3).
 *
 * O contrato do memtier **não** auto-deleta arquivo ausente do payload (spike
 * 010, A1): quem some do repo precisa ser enviado com `chunks: []`. O manifest
 * guarda o conjunto de arquivos já sincronizados (para calcular os **removidos**)
 * e o `last_git_head` (alimenta o `git_range` do incremental na S4).
 *
 * Arquivo por workspace: `.kilo/graph-manifest.json`. Escrita **atômica**
 * (tmp+rename); corrompido ⇒ tratado como vazio (força full). É estado local —
 * `.gitignore` cobre (padrão `.kilo/*` e `graph-manifest.json`).
 *
 * Módulo com I/O de arquivo, mas funções puras de estado (`removedFiles`,
 * `mergeManifest`) testáveis isoladas; o leitor é injetável no teste.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Estado persistido por workspace. */
export interface Manifest {
  workspace: string;
  /** SHA do HEAD no último sync (base do incremental). `null` no 1º uso. */
  last_git_head: string | null;
  /** Arquivos sincronizados na última execução (para detectar removidos). */
  files: string[];
  /**
   * Impressão da config de chunking vigente no último full (E3a). Uma mudança
   * (ex.: default Semantic → symbol_boundary) altera COMO cada arquivo vira
   * chunk, mas o incremental só re-chunka o que o git mudou — sem este campo o
   * corpus antigo ficaria com o chunking velho para sempre, em silêncio. Ausente
   * (manifest legado) ⇒ tratado como divergente ⇒ força um full de reindexação.
   */
  chunking_fingerprint?: string;
  /** ISO-8601 da última escrita. */
  updated_at: string;
}

/** Manifest vazio (workspace sem estado — 1º uso ⇒ full). */
export function emptyManifest(workspace: string): Manifest {
  return { workspace, last_git_head: null, files: [], updated_at: "" };
}

/** Caminho default do manifest dentro do workspace. */
export const MANIFEST_REL_PATH = ".kilo/graph-manifest.json";

/**
 * Carrega o manifest de `path`. Ausente/corrompido ⇒ manifest vazio (o chamador
 * cai no full). `readFile` injetável (default `readFileSync` utf-8).
 */
export function loadManifest(
  path: string,
  workspace: string,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf-8") as string,
): Manifest {
  if (!path) return emptyManifest(workspace);
  try {
    const parsed = JSON.parse(readFile(path)) as Partial<Manifest>;
    return {
      workspace:
        typeof parsed.workspace === "string" ? parsed.workspace : workspace,
      last_git_head:
        typeof parsed.last_git_head === "string" ? parsed.last_git_head : null,
      files: Array.isArray(parsed.files)
        ? parsed.files.filter((f): f is string => typeof f === "string")
        : [],
      chunking_fingerprint:
        typeof parsed.chunking_fingerprint === "string"
          ? parsed.chunking_fingerprint
          : undefined,
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : "",
    };
  } catch {
    // Ausente/corrompido não é fatal: vazio força full (reindexa tudo).
    return emptyManifest(workspace);
  }
}

/**
 * Grava o manifest com escrita atômica (tmp + rename): um crash no meio nunca
 * deixa um JSON pela metade. `writeFile`/`rename` injetáveis para teste.
 */
export function saveManifest(
  path: string,
  manifest: Manifest,
  io: {
    writeFile?: (p: string, data: string) => void;
    rename?: (from: string, to: string) => void;
    exists?: (p: string) => boolean;
    mkdir?: (p: string) => void;
    /** Sufixo de unicidade do tmp (default `process.pid`; injetável em teste). */
    tmpSuffix?: string;
  } = {},
): void {
  if (!path) return;
  const write = io.writeFile ?? ((p, d) => writeFileSync(p, d, "utf-8"));
  const rename = io.rename ?? renameSync;
  const mkdir = io.mkdir ?? ((p) => void mkdirSync(p, { recursive: true }));
  // `.kilo/` pode não existir (repo sem config do Kilo) — sem criar, a escrita
  // falha silenciosamente e o manifest nunca persiste (o full refaz sempre).
  const dir = dirname(path);
  if (dir && dir !== ".") mkdir(dir);
  // `.tmp` ÚNICO por processo: boot e post-commit são processos distintos (§3b).
  // Um tmp FIXO faz o `rename` do perdedor falhar com `ENOENT` (o vencedor já o
  // consumiu) e o erro é engolido (só `debug`), perdendo estado em silêncio. O
  // `provision.ts` já usa `.tmp.${pid}` (mesmo padrão).
  const suffix = io.tmpSuffix ?? String(process.pid);
  const tmp = `${path}.tmp.${suffix}`;
  const data = `${JSON.stringify(manifest, null, 2)}\n`;
  write(tmp, data);
  rename(tmp, path);
}

/** Removidos = estado anterior − arquivos do payload atual (preserva ordem). */
export function removedFiles(manifest: Manifest, current: string[]): string[] {
  const now = new Set(current);
  return manifest.files.filter((f) => !now.has(f));
}

/** Novo estado a persistir após um sync (arquivos atuais + head opcional). */
export function mergeManifest(
  workspace: string,
  current: string[],
  head: string | null,
  chunkingFingerprint?: string,
): Manifest {
  return {
    workspace,
    last_git_head: head,
    files: [...new Set(current)],
    ...(chunkingFingerprint !== undefined
      ? { chunking_fingerprint: chunkingFingerprint }
      : {}),
    updated_at: new Date().toISOString(),
  };
}

/** `true` quando o manifest existe mas não tem arquivos (força full). */
export function isFirstUse(manifest: Manifest): boolean {
  return manifest.files.length === 0;
}

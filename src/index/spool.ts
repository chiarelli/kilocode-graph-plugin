/**
 * `spool.ts` — buffer em DISCO dos eventos do indexer.
 *
 * O runner não acumula mais o job inteiro em RAM (`events.push(ev)`): cada
 * evento é gravado num spool temporário, agrupado por **arquivo de origem**.
 * O coletor processa o spool em lotes de ≤100 arquivos, com memória limitada
 * ao lote (+ índices de nomes/símbolos, pequenos).
 *
 * Por que por arquivo: o servidor reconcilia chunks POR ARQUIVO (`/v1/code/sync`
 * — reenviar um subconjunto apagaria os demais). Como o indexer emite chunks em
 * paralelo (a ordem dos arquivos intercala), só o fim do job garante que um
 * arquivo está completo — então o spool é escrito durante o job e lido depois.
 *
 * Formato: `<dir>/chunks/<sha1(file)>.jsonl` (um evento `chunk_emitted` por
 * linha) + `<dir>/edges/<sha1(from_file)>.jsonl` (`import_edge`/`call_edge`
 * agrupados pelo arquivo de ORIGEM, para o 2º passe ler só o lote corrente).
 * `registry` mantém `file_path → language` em memória (metadados pequenos; nunca
 * o texto).
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { IndexerEvent } from "../types.ts";

/** Marcador de spool COMPLETO (o job terminou sem erro). */
const COMMITTED_MARKER = "COMMITTED";
/** Marcador de spool EM ANDAMENTO (presente desde a criação). */
const INCOMPLETE_MARKER = "INCOMPLETE";

/**
 * Spool consumido sem `commit()`: o job não terminou com sucesso. Consumir um
 * spool incompleto trataria arquivos ainda não emitidos como removidos (wipe).
 */
export class SpoolNotCommittedError extends Error {
  constructor(dir: string) {
    super(`spool não commitado (job incompleto): ${dir}`);
    this.name = "SpoolNotCommittedError";
  }
}

/** Metadados de um arquivo visto no stream (nomes de símbolo, nunca o texto). */
export interface SpoolFile {
  filePath: string;
  language: string;
  /** Nomes de símbolo do arquivo (base da resolução de arestas). */
  symbols: string[];
  /** O arquivo tem (ou terá, via `FullFile`) nó de arquivo. */
  hasFileChunk: boolean;
}

/** Buffer por arquivo; flush quando passa do teto (memória limitada). */
interface FileSink {
  fd: number;
  lines: string[];
  bytes: number;
}

const FLUSH_BYTES = 256 * 1024;

/**
 * Teto de descritores ABERTOS simultaneamente. O indexer emite arquivos em
 * paralelo (ordem intercalada), então um sink por arquivo abriria um fd por
 * arquivo — num repo grande isso estoura `ulimit -n` e derruba o plugin. Ao
 * passar do teto, o sink menos recentemente usado é fechado (o buffer já foi
 * escrito; a próxima escrita reabre em modo `append`).
 */
const MAX_OPEN_SINKS = 32;

/** Nome de arquivo estável para um `file_path` (paths podem ter `/`). */
function fileNameFor(filePath: string): string {
  return `${createHash("sha1").update(filePath, "utf-8").digest("hex")}.jsonl`;
}

/**
 * Spool de eventos. Criado pelo runner, consumido pelo coletor e descartado ao
 * fim (`dispose`). `null` em ambientes sem FS gravável ⇒ o runner mantém o
 * caminho legado em memória (degradação explícita).
 */
export class EventSpool {
  private readonly dir: string;
  private readonly chunksDir: string;
  private readonly sinks = new Map<string, FileSink>();
  private readonly registry = new Map<
    string,
    { language: string; symbols: Set<string>; hasFileChunk: boolean }
  >();
  /** Arquivos (origem) que têm arestas — só o 2º passe os visita. */
  private readonly edgeOrigins = new Set<string>();
  private readonly edgeSinks = new Map<string, FileSink>();
  private readonly edgesDir: string;
  private closed = false;
  private committed = false;

  private constructor(dir: string) {
    this.dir = dir;
    this.chunksDir = join(dir, "chunks");
    this.edgesDir = join(dir, "edges");
    mkdirSync(this.chunksDir, { recursive: true });
    mkdirSync(this.edgesDir, { recursive: true });
    // Estado inicial: INCOMPLETO. Só `commit()` troca a marca — um job morto
    // (timeout/erro) deixa o spool sem commit e o consumidor recusa lê-lo.
    writeFileSync(join(dir, INCOMPLETE_MARKER), "");
  }

  /** Cria o spool num diretório temporário (ou no `baseDir` dado). */
  static create(baseDir: string = tmpdir()): EventSpool {
    return new EventSpool(mkdtempSync(join(baseDir, "graph-spool-")));
  }

  /** Diretório raiz do spool (para limpeza/log). */
  get path(): string {
    return this.dir;
  }

  /**
   * Grava um evento. `chunk_emitted` vai para o arquivo do seu `file`; arestas
   * vão para o spool global; eventos de controle (`job_*`, `file_listed`, …) são
   * ignorados (o runner já os usa para o ciclo de vida).
   */
  write(ev: IndexerEvent): void {
    if (this.closed) return;
    if (ev.event === "import_edge" || ev.event === "call_edge") {
      this.writeEdge(ev);
      return;
    }
    if (ev.event !== "chunk_emitted") return;
    const payload = ev.payload as
      | {
          file?: unknown;
          language?: unknown;
          symbol_id?: unknown;
          chunk_kind?: unknown;
        }
      | null;
    const file = payload?.file;
    if (typeof file !== "string" || file.trim() === "") return;
    let meta = this.registry.get(file);
    if (!meta) {
      meta = {
        language:
          typeof payload?.language === "string" && payload.language
            ? payload.language
            : "rust",
        symbols: new Set<string>(),
        hasFileChunk: false,
      };
      this.registry.set(file, meta);
    }
    if (payload?.chunk_kind !== "Symbol") meta.hasFileChunk = true;
    if (typeof payload?.symbol_id === "string" && payload.symbol_id) {
      meta.symbols.add(payload.symbol_id.split(":").pop() || payload.symbol_id);
    }
    this.writeChunk(file, ev);
  }

  private sinkFor(file: string, dir: string): FileSink {
    const existing = this.sinks.get(file);
    if (existing) {
      // Reinsere no fim do Map (ordem de recência para o despejo).
      this.sinks.delete(file);
      this.sinks.set(file, existing);
      return existing;
    }
    if (this.sinks.size >= MAX_OPEN_SINKS) this.evictOldest();
    const sink: FileSink = {
      fd: openSync(join(dir, fileNameFor(file)), "a"),
      lines: [],
      bytes: 0,
    };
    this.sinks.set(file, sink);
    return sink;
  }

  /** Fecha o sink mais antigo (já drenado para o disco). */
  private evictOldest(): void {
    const oldest = this.sinks.keys().next();
    if (oldest.done) return;
    const sink = this.sinks.get(oldest.value);
    this.sinks.delete(oldest.value);
    if (!sink) return;
    try {
      this.flush(sink);
      closeSync(sink.fd);
    } catch {
      // Spool é transitório: falha de close/escrita não derruba o job.
    }
  }

  private writeChunk(file: string, ev: IndexerEvent): void {
    const sink = this.sinkFor(file, this.chunksDir);
    const line = `${JSON.stringify(ev)}\n`;
    sink.lines.push(line);
    sink.bytes += line.length;
    if (sink.bytes >= FLUSH_BYTES) this.flush(sink);
  }

  private writeEdge(ev: IndexerEvent): void {
    const payload = ev.payload as { from_file?: unknown } | null;
    const origin = typeof payload?.from_file === "string" ? payload.from_file : "";
    if (!origin) return; // aresta sem origem não resolve no servidor
    this.edgeOrigins.add(origin);
    let sink = this.edgeSinks.get(origin);
    if (!sink) {
      // Arestas são poucas por origem; o teto global de sinks não se aplica
      // aqui, mas fechar tudo em `close()` cobre o volume de origens.
      sink = {
        fd: openSync(join(this.edgesDir, fileNameFor(origin)), "a"),
        lines: [],
        bytes: 0,
      };
      this.edgeSinks.set(origin, sink);
    }
    const line = `${JSON.stringify(ev)}\n`;
    sink.lines.push(line);
    sink.bytes += line.length;
    if (sink.bytes >= FLUSH_BYTES) this.flush(sink);
  }

  private flush(sink: FileSink): void {
    if (sink.lines.length === 0) return;
    writeSync(sink.fd, sink.lines.join(""));
    sink.lines = [];
    sink.bytes = 0;
  }

  /** Fecha os descritores e materializa os buffers pendentes. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const sink of this.sinks.values()) {
      try {
        this.flush(sink);
        closeSync(sink.fd);
      } catch {
        // Spool é estado transitório; falha de close não derruba o job.
      }
    }
    this.sinks.clear();
    for (const sink of this.edgeSinks.values()) {
      try {
        this.flush(sink);
        closeSync(sink.fd);
      } catch {
        // idem
      }
    }
    this.edgeSinks.clear();
  }

  /**
   * Commit ATÔMICO: fecha o spool e troca a marca `INCOMPLETE` por `COMMITTED`.
   * Só depois disto os arquivos podem ser consumidos. Chamado pelo coletor
   * SOMENTE após `job_completed` sem erro — um job que morreu (timeout, erro
   * não-recuperável) deixa o spool incompleto, e o consumidor recusa lê-lo
   * (`SpoolNotCommittedError`) em vez de tratar ausentes como removidos.
   *
   * O rename é o mesmo filesystem (mesmo diretório): atômico.
   */
  commit(): void {
    if (this.committed) return;
    this.close();
    const tmp = join(this.dir, `${COMMITTED_MARKER}.tmp`);
    const final = join(this.dir, COMMITTED_MARKER);
    writeFileSync(tmp, "");
    renameSync(tmp, final);
    rmSync(join(this.dir, INCOMPLETE_MARKER), { force: true });
    this.committed = true;
  }

  /** O job terminou com sucesso e o spool pode ser consumido? */
  isCommitted(): boolean {
    return this.committed;
  }

  /**
   * Lança se o spool não foi commitado (job incompleto).
   *
   * `close()` sozinho NÃO é commit: o coletor só chama `commit()` depois de
   * `job_completed` sem erro. Assim um job que morreu no meio não é consumido
   * (ausentes virariam "removidos" e apagariam o grafo).
   */
  assertCommitted(): void {
    if (!this.committed) throw new SpoolNotCommittedError(this.dir);
  }

  /** Arquivos vistos, na ordem de primeira aparição. */
  files(): SpoolFile[] {
    return [...this.registry].map(([filePath, meta]) => ({
      filePath,
      language: meta.language,
      symbols: [...meta.symbols],
      hasFileChunk: meta.hasFileChunk,
    }));
  }

  /**
   * Eventos `chunk_emitted` de UM arquivo (já completos: o job terminou).
   * Linha inválida é ignorada (mesma tolerância do runner).
   */
  readFile(filePath: string): IndexerEvent[] {
    return this.readLinesSync(join(this.chunksDir, fileNameFor(filePath)));
  }

  /** Origens que têm arestas (`import_edge`/`call_edge`) no spool. */
  edgesOrigins(): string[] {
    return [...this.edgeOrigins];
  }

  /** Arestas cujo `from_file` é `filePath` (chamado lote a lote). */
  readEdges(filePath: string): IndexerEvent[] {
    return this.readLinesSync(join(this.edgesDir, fileNameFor(filePath)));
  }

  /**
   * Leitor STREAMING de `chunk_emitted` de um arquivo, linha a linha.
   *
   * `readFile` carrega o JSONL inteiro (`readFileSync`): um bundle minificado de
   * 9 MB vira ~23 MB de JSONL e um lote de 100 arquivos multiplica isso. Aqui o
   * pico é UMA linha — o consumidor processa e descarta cada evento.
   *
   * Retorna um `AsyncIterable`; o chamador pode parar quando quiser (o stream é
   * fechado no `return`).
   */
  async *streamFile(filePath: string): AsyncGenerator<IndexerEvent> {
    this.assertCommitted();
    yield* this.streamLines(join(this.chunksDir, fileNameFor(filePath)));
  }

  /** Leitor STREAMING de arestas de um arquivo de origem. */
  async *streamEdges(filePath: string): AsyncGenerator<IndexerEvent> {
    this.assertCommitted();
    yield* this.streamLines(join(this.edgesDir, fileNameFor(filePath)));
  }

  /** Linhas JSONL de um arquivo, uma por vez (memória ~1 evento). */
  private async *streamLines(path: string): AsyncGenerator<IndexerEvent> {
    // Arquivo ausente = arquivo sem chunks/arestas: fim normal, não erro.
    if (!existsSync(path)) return;
    const stream = createReadStream(path, {
      encoding: "utf-8",
      highWaterMark: 64 * 1024,
    });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    // O `readline` reemite o erro do input no `for await`; sem capturá-lo, um
    // I/O no meio da leitura vira exceção do job.
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            yield parsed as IndexerEvent;
          }
        } catch {
          // linha corrompida: ignora
        }
      }
    } catch {
      // erro de leitura: encerra o stream (o que já veio foi consumido)
    } finally {
      rl.close();
      stream.destroy();
    }
  }

  /** Lê um JSONL do spool linha a linha (linha corrompida é ignorada). */
  private readLinesSync(path: string): IndexerEvent[] {
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      return [];
    }
    const out: IndexerEvent[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out.push(parsed as IndexerEvent);
        }
      } catch {
        // linha corrompida: ignora
      }
    }
    return out;
  }

  /** Remove o diretório do spool. Nunca lança. */
  dispose(): void {
    this.close();
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      // melhor esforço
    }
  }
}

/**
 * E1-S2 — `logger.ts`: o token **nunca** aparece no log.
 *
 * `formatBootLine` é o ponto único onde o token é serializado no boot; a prova
 * é pura (sem socket): o valor do token não aparece na linha.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  __setLogSink,
  formatBootLine,
  formatInjectRaw,
  formatToken,
  logFatal,
  writeInjectRaw,
} from "../src/logger.ts";
import { setDebug } from "../src/logger.ts";

const SECRET = "super-secret-bearer-xyz";

test("formatToken: só o tamanho, nunca o valor", () => {
  assert.equal(formatToken(SECRET), `SET(len=${SECRET.length})`);
  assert.ok(!formatToken(SECRET).includes(SECRET));
  assert.equal(formatToken(""), "EMPTY");
  assert.equal(formatToken(null), "EMPTY");
});

test("token_never_logged: a linha de boot não contém o token", () => {
  const line = formatBootLine({
    workspace: "waweb",
    url: "http://127.0.0.1:8400",
    program: "default",
    token: SECRET,
    debug: true,
  });
  assert.ok(!line.includes(SECRET), "o token não pode aparecer no log");
  assert.ok(line.includes(`SET(len=${SECRET.length})`));
  assert.ok(line.includes("workspace=waweb"));
});

/** Um erro cujo `message` embute um body HTTP gigante (o caso que travou a UI). */
function giantError(size: number): Error {
  return new Error("memtier HTTP 422: " + "x".repeat(size));
}

test("logFatal_truncates: mensagem gigante não é emitida inteira", () => {
  const lines: string[] = [];
  __setLogSink((line) => lines.push(line));
  try {
    logFatal("collect sync (422)", giantError(5_000_000));
  } finally {
    __setLogSink(null);
  }
  assert.equal(lines.length, 1);
  // Teto duro: muito abaixo do body (5 MB). Folga p/ prefixo + stack.
  assert.ok(
    lines[0]!.length < 16_384,
    `linha de log tem ${lines[0]!.length} chars — deveria ser truncada`,
  );
  assert.ok(lines[0]!.includes("FATAL collect sync (422)"));
  assert.ok(lines[0]!.includes("truncat"), "deve sinalizar truncamento");
});

test("logFatal_keeps_small_messages_intact", () => {
  const lines: string[] = [];
  __setLogSink((line) => lines.push(line));
  try {
    logFatal("boot", new Error("boom"));
  } finally {
    __setLogSink(null);
  }
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes("boom"));
  assert.ok(!lines[0]!.includes("truncat"), "não deve truncar mensagem curta");
});

// ---------------------------------------------------------------------------
// Dump do raw injetado (debug): formato legível + truncamento + gate do debug
// ---------------------------------------------------------------------------

test("formatInjectRaw: cabeçalho, título com contagem e bloco cru abaixo", () => {
  const block = `\n\n<context graph-memory="true">\n[CONTEXTO DE MEMÓRIA]\n- fato A\n</context>`;
  const out = formatInjectRaw(
    [{ title: "MEMÓRIA", block, count: 1 }],
    new Date("2026-10-16T02:00:00.000Z"),
  );
  assert.ok(out.includes("KILOCODE GRAPH"), "tem cabeçalho legível");
  assert.ok(out.includes("2026-10-16T02:00:00.000Z"), "tem a data/hora");
  assert.ok(out.includes("MEMÓRIA"), "tem o título da seção");
  assert.ok(out.includes("1 item ·"), "mostra contagem e chars");
  assert.ok(out.includes(block.trim()), "preserva o bloco cru (aparado nas bordas)");
});

test("formatInjectRaw: seção vazia é rotulada, não some", () => {
  const out = formatInjectRaw(
    [
      { title: "MEMÓRIA", block: "x".repeat(10), count: 2 },
      { title: "CÓDIGO", block: null },
    ],
    new Date("2026-10-16T02:00:00.000Z"),
  );
  assert.ok(out.includes("MEMÓRIA"));
  assert.ok(out.includes("CÓDIGO"));
  assert.ok(out.includes("nada injetado"), "seção ausente fica explícita");
});

test("writeInjectRaw_gated_by_debug: sem debug, nada é escrito no sink", () => {
  const lines: string[] = [];
  __setLogSink((line) => lines.push(line));
  try {
    setDebug(false);
    writeInjectRaw([{ title: "MEMÓRIA", block: "<context graph-memory=\"true\">a</context>" }]);
    assert.equal(lines.length, 0, "sem debug, o dump é ignorado");

    setDebug(true);
    writeInjectRaw([{ title: "MEMÓRIA", block: "<context graph-memory=\"true\">a</context>" }]);
    assert.equal(lines.length, 1, "com debug, o dump é emitido");
    assert.ok(lines[0]!.includes("MEMÓRIA"));
  } finally {
    setDebug(false);
    __setLogSink(null);
  }
});

test("writeInjectRaw_overwrites: cada escrita reflete só o último turno", () => {
  const writes: string[] = [];
  __setLogSink((line) => writes.push(line));
  try {
    setDebug(true);
    writeInjectRaw([{ title: "MEMÓRIA", block: "turno-1", count: 1 }]);
    writeInjectRaw([{ title: "CÓDIGO", block: "turno-2", count: 3 }]);
  } finally {
    setDebug(false);
    __setLogSink(null);
  }
  assert.equal(writes.length, 2);
  const last = writes.at(-1)!;
  assert.ok(last.includes("turno-2"));
  assert.ok(!last.includes("turno-1"), "o dump não acumula turnos anteriores");
});

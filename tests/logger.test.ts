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
  formatToken,
  logFatal,
} from "../src/logger.ts";

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

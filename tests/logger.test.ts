/**
 * E1-S2 — `logger.ts`: o token **nunca** aparece no log.
 *
 * `formatBootLine` é o ponto único onde o token é serializado no boot; a prova
 * é pura (sem socket): o valor do token não aparece na linha.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatBootLine, formatToken } from "../src/logger.ts";

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

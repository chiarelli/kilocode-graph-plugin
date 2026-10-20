/**
 * `clampQuery` — janela 25/75 ancorada na pergunta para o body de
 * `POST /v1/code/search`.
 *
 * O servidor valida `query` com `max_length=512` (422 acima disso) e o texto do
 * usuário costuma ser bem maior — a mensagem do host já traz o
 * `<system-reminder>`. O clamp existe para não perder o turno inteiro, mas o
 * `slice(0, 512)` anterior descartava justamente a pergunta: no corpus real ela
 * está no último terço em 65% das mensagens longas (mediana 0,84).
 *
 * Estratégia: 25% do orçamento na cabeça (contexto/tema) e 75% na cauda, com a
 * cauda deslocada para conter a última `?` quando ela cairia fora da janela
 * final. Sem `?`, é o split 25/75 puro.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { clampQuery } from "../src/client.ts";

const CAP = 512;
const HEAD = Math.floor(CAP * 0.25); // 128

test("clamp_query_short_untouched: texto dentro do teto passa intacto", () => {
  assert.equal(clampQuery("db.Insert"), "db.Insert");
  assert.equal(clampQuery(""), "");
});

test("clamp_query_exactly_cap: no limite exato nada muda", () => {
  const t = "a".repeat(CAP);
  assert.equal(clampQuery(t), t);
});

test("clamp_query_never_exceeds_cap: qualquer entrada respeita o teto", () => {
  for (const n of [CAP + 1, 600, 1000, 5000, 20000]) {
    for (const cap of [64, 128, 512, 1024]) {
      const out = clampQuery("palavra ".repeat(Math.ceil(n / 8)).slice(0, n), cap);
      assert.ok(out.length <= cap, `len=${out.length} > cap=${cap} (n=${n})`);
    }
  }
});

test("clamp_query_25_75_split: sem pergunta mantém cabeça e cauda, corta o meio", () => {
  const text = "CABECA_MARCADOR " + "m".repeat(2000) + " CAUDA_MARCADOR";
  const out = clampQuery(text, CAP);
  assert.ok(out.includes("CABECA_MARCADOR"), "cabeça preservada");
  assert.ok(out.includes("CAUDA_MARCADOR"), "cauda preservada");
  assert.ok(out.length <= CAP);
  // O miolo (só "m") não pode sobreviver inteiro: a janela é finita.
  assert.ok(!out.includes("m".repeat(1000)));
});

test("clamp_query_anchors_on_question: pergunta distante do fim entra na janela", () => {
  // Pergunta em ~620; a cauda de 383 chars sozinha começaria em ~1457 e a
  // perderia — é o caso que o slice(0,512) e o 25/75 puro erram.
  const text =
    "preambulo ".repeat(60) +
    "onde fica o handler de sessao?" +
    " ruido".repeat(200);
  const out = clampQuery(text, CAP);
  assert.ok(out.includes("onde fica o handler de sessao?"), "pergunta preservada");
  assert.ok(out.length <= CAP);
});

test("clamp_query_question_in_head: pergunta já na cabeça, cauda segue o fim", () => {
  const text = "onde fica o handler? " + "r".repeat(1000) + " FIM_MARCADOR";
  const out = clampQuery(text, CAP);
  assert.ok(out.includes("onde fica o handler?"), "pergunta na cabeça");
  assert.ok(out.includes("FIM_MARCADOR"), "cauda vai até o fim do texto");
  assert.ok(out.length <= CAP);
});

test("clamp_query_anchored_excludes_trailing_noise: corta o lembrete após a pergunta", () => {
  // Caso real do host: a pergunta vem antes e o <system-reminder> ocupa a cauda.
  const text =
    "contexto ".repeat(80) +
    "como faco para registrar os modelos no router? " +
    "<system-reminder>".repeat(60);
  const out = clampQuery(text, CAP);
  assert.ok(out.includes("como faco para registrar os modelos no router?"));
  assert.ok(!out.includes("<system-reminder>"), "ruído após a pergunta fica de fora");
});

test("clamp_query_head_budget_is_quarter: a cabeça para em 25% do teto", () => {
  const text = "Z".repeat(HEAD) + "y".repeat(4000);
  const out = clampQuery(text, CAP);
  // Todo o bloco de "Z" (exatamente o orçamento da cabeça) sobrevive.
  assert.ok(out.startsWith("Z".repeat(HEAD)));
  assert.ok(out.length <= CAP);
});

test("clamp_query_separator: cabeça e cauda não colam palavras", () => {
  const text = "AAAA".repeat(500) + "BBBB".repeat(500);
  const out = clampQuery(text, CAP);
  assert.ok(out.length <= CAP);
  assert.ok(!out.includes("AB"), "não emenda o fim da cabeça no início da cauda");
});

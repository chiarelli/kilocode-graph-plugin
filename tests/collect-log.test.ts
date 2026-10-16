/**
 * E3a-S6c — observabilidade do delta: linha por execução do coletor
 * (`formatCollectLine`), distinguível do boot pelo `source`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatCollectLine } from "../src/hooks/collect.ts";
import type { SyncResult } from "../src/types.ts";

const SYNC: SyncResult = { upserted: 3, deleted: 1, changed: 3, skipped: 0 };

test("collect_line_boot: source default = boot", () => {
  const line = formatCollectLine({
    mode: "full",
    indexerMs: 42,
    files: 5,
    edges: 2,
    removed: 0,
    sync: SYNC,
  });
  assert.match(line, /^collect source=boot mode=full /);
  assert.match(line, /indexer_ms=42 files=5 edges=2 removed=0 /);
  assert.match(line, /sync=\{upserted:3,deleted:1,changed:3,skipped:0\}/);
});

test("collect_line_post_commit: source distingue o delta de runtime do boot", () => {
  const line = formatCollectLine({
    source: "post-commit",
    mode: "incremental",
    trigger: "auto",
    indexerMs: 10,
    files: 1,
    edges: 0,
    removed: 1,
    sync: SYNC,
  });
  assert.match(line, /source=post-commit/);
  assert.match(line, /mode=incremental/);
  assert.match(line, /trigger=auto/);
  assert.match(line, /removed=1/);
});

test("collect_line_skip_reason: sem sync ⇒ marca o motivo", () => {
  const line = formatCollectLine({
    source: "post-merge",
    mode: "incremental",
    indexerMs: 0,
    files: 0,
    edges: 0,
    removed: 0,
    skip: "aguardando sync inicial",
  });
  assert.match(line, /sync=skipped reason=aguardando sync inicial/);
  assert.ok(!line.includes("sync={"), "sem bloco de sync quando não houve");
});

test("collect_line_skip_no_reason: skip genérico quando o motivo é ausente", () => {
  const line = formatCollectLine({
    mode: "full",
    indexerMs: 0,
    files: 0,
    edges: 0,
    removed: 0,
  });
  assert.match(line, /sync=skipped$/);
});

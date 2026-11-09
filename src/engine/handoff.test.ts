import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHandoffContinuationPrompt,
  buildHandoffRequestPrompt,
  MAX_HANDOFF_DIFF_CHARS,
  MAX_HANDOFF_NOTE_CHARS,
  parseHandoffNote,
  saveHandoffNote,
  shouldHandOff,
} from "./handoff.js";

const cfg = { thresholdTokens: 80_000, maxHandoffs: 2, baseBranch: "dev" };
const task = { id: "XEN-1", title: "Fix thing", description: "Desc", acceptanceCriteria: ["A works", "B works"] };
const failing = [{ name: "test", command: "yarn test", passed: false, output: "1 failed" }];

test("hands off at the threshold, not below it", () => {
  assert.equal(shouldHandOff(79_999, 0, cfg), false);
  assert.equal(shouldHandOff(80_000, 0, cfg), true);
});

test("stops handing off once maxHandoffs is used — the hard stop takes over", () => {
  assert.equal(shouldHandOff(120_000, 1, cfg), true);
  assert.equal(shouldHandOff(120_000, 2, cfg), false);
});

test("disabled or zero-threshold handoff never fires", () => {
  assert.equal(shouldHandOff(1_000_000, 0, undefined), false);
  assert.equal(shouldHandOff(1_000_000, 0, { ...cfg, thresholdTokens: 0 }), false);
});

test("the request asks for the note in tags and forbids edits", () => {
  const prompt = buildHandoffRequestPrompt(failing);
  assert.match(prompt, /<handoff>/);
  assert.match(prompt, /Do NOT edit/);
  assert.match(prompt, /Tried and failed/);
  assert.match(prompt, /test/);
});

test("parses the note from tags, falls back to the whole reply, caps its size", () => {
  assert.equal(parseHandoffNote("noise <handoff>\n## Done\nx\n</handoff> tail"), "## Done\nx");
  assert.equal(parseHandoffNote("  no tags here  "), "no tags here");
  assert.equal(parseHandoffNote("<handoff>" + "a".repeat(MAX_HANDOFF_NOTE_CHARS + 100) + "</handoff>").length, MAX_HANDOFF_NOTE_CHARS);
});

test("the fresh session gets task, criteria, note, diff and failing gates", () => {
  const prompt = buildHandoffContinuationPrompt(task, "## Tried and failed\nX", "diff --git a/f b/f", failing, 1);
  for (const part of ["XEN-1", "A works", "handoff #1", "## Tried and failed", "diff --git", "yarn test", "NOT finished"]) {
    assert.ok(prompt.includes(part), `missing: ${part}`);
  }
});

test("a huge diff is truncated and the session is told so", () => {
  const prompt = buildHandoffContinuationPrompt(task, "note", "x".repeat(MAX_HANDOFF_DIFF_CHARS + 10), [], 2);
  assert.match(prompt, /diff truncated/);
  assert.ok(!prompt.includes("x".repeat(MAX_HANDOFF_DIFF_CHARS + 1)));
});

test("saves each note under the task's own folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "handoff-"));
  try {
    const path = await saveHandoffNote("XEN-7", 2, "the note", root);
    assert.ok(path?.endsWith(join("XEN-7", "handoff-2.md")));
    assert.equal(await readFile(path!, "utf8"), "the note");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

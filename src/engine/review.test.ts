import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPrompt, parseReviewResponse, buildReviewFixPrompt, formatReviewRound, interpretReview, parseVerdictLine, reviewGate } from "./review.js";
import type { ReviewFinding, TaskSpec } from "../types.js";

const task: TaskSpec = {
  id: "XEN-55",
  title: "Пагинация не работает для архивных записей",
  description: "Фильтр по статусу не учитывает архивные записи.",
  acceptanceCriteria: ["Архивные записи не попадают в выдачу по умолчанию"],
};

test("buildReviewPrompt includes the task, criteria, and diff", () => {
  const prompt = buildReviewPrompt(task, "diff --git a/x.ts b/x.ts\n+added line");
  assert.match(prompt, /XEN-55/);
  assert.match(prompt, /Архивные записи не попадают/);
  assert.match(prompt, /added line/);
  assert.match(prompt, /БЛОКИРУЮЩИЕ:/);
  assert.match(prompt, /ЗАМЕЧАНИЯ:/);
});

test("buildReviewPrompt handles a task with no frozen acceptance criteria", () => {
  const bare: TaskSpec = { ...task, acceptanceCriteria: [] };
  const prompt = buildReviewPrompt(bare, "diff");
  assert.match(prompt, /не зафиксированы для этой задачи/);
});

test("buildReviewPrompt caps the embedded diff", () => {
  const longDiff = "x".repeat(20_000);
  const prompt = buildReviewPrompt(task, longDiff);
  assert.ok(prompt.length < 12_000, `expected the diff to be capped, got a ${prompt.length}-char prompt`);
});

test("parseReviewResponse extracts both blocking and nonblocking findings", () => {
  const text = [
    "БЛОКИРУЮЩИЕ:",
    "- src/x.ts:10 — SQL-инъекция через неэкранированный параметр",
    "",
    "ЗАМЕЧАНИЯ:",
    "- src/y.ts:20 — можно вынести в отдельную функцию",
    "- src/z.ts:5 — не хватает комментария",
  ].join("\n");
  const findings = parseReviewResponse(text);
  assert.equal(findings.length, 3);
  assert.deepEqual(findings[0], { blocking: true, description: "src/x.ts:10 — SQL-инъекция через неэкранированный параметр" });
  assert.equal(findings[1].blocking, false);
  assert.equal(findings[2].blocking, false);
});

test("parseReviewResponse treats 'НЕТ' as no findings in that section", () => {
  const text = ["БЛОКИРУЮЩИЕ:", "НЕТ", "", "ЗАМЕЧАНИЯ:", "НЕТ"].join("\n");
  assert.deepEqual(parseReviewResponse(text), []);
});

test("parseReviewResponse returns empty (fail open) when the model doesn't follow the format", () => {
  const freeform = "Выглядит нормально, замечаний нет.";
  assert.deepEqual(parseReviewResponse(freeform), []);
});

test("parseReviewResponse handles only blocking findings with no nonblocking section reached", () => {
  const text = ["БЛОКИРУЮЩИЕ:", "- src/x.ts:1 — проблема", "", "ЗАМЕЧАНИЯ:", "НЕТ"].join("\n");
  const findings = parseReviewResponse(text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].blocking, true);
});

test("buildReviewFixPrompt lists every blocking finding and invites pushback", () => {
  const blocking: ReviewFinding[] = [
    { blocking: true, description: "src/x.ts:10 — SQL-инъекция" },
    { blocking: true, description: "src/y.ts:5 — не обработан null" },
  ];
  const prompt = buildReviewFixPrompt(blocking);
  assert.match(prompt, /SQL-инъекция/);
  assert.match(prompt, /не обработан null/);
  assert.match(prompt, /не игнорируй его молча/);
});

test("formatReviewRound reconstructs the БЛОКИРУЮЩИЕ/ЗАМЕЧАНИЯ shape from parsed findings", () => {
  const findings: ReviewFinding[] = [
    { blocking: true, description: "блокирующая проблема" },
    { blocking: false, description: "просто замечание" },
  ];
  const text = formatReviewRound(findings, undefined);
  assert.match(text, /БЛОКИРУЮЩИЕ:\n- блокирующая проблема/);
  assert.match(text, /ЗАМЕЧАНИЯ:\n- просто замечание/);
});

test("formatReviewRound writes НЕТ for an empty section, not an empty list", () => {
  const text = formatReviewRound([], undefined);
  assert.match(text, /БЛОКИРУЮЩИЕ:\nНЕТ/);
  assert.match(text, /ЗАМЕЧАНИЯ:\nНЕТ/);
});

test("formatReviewRound reports the turn's own failure reason instead of guessing at findings", () => {
  const text = formatReviewRound([], "ход завершился ошибкой: timeout");
  assert.match(text, /Ревью не удалось провести: ход завершился ошибкой: timeout/);
});

test("a cut diff tells the reviewer it is cut and how much is missing; a short one carries no such note", async () => {
  const { REVIEW_DIFF_CHARS } = await import("./review.js");
  const long = buildReviewPrompt(task, "x".repeat(REVIEW_DIFF_CHARS + 500));
  assert.match(long, new RegExp(`Diff обрезан: показаны первые ${REVIEW_DIFF_CHARS} из ${REVIEW_DIFF_CHARS + 500} символов`));
  assert.doesNotMatch(buildReviewPrompt(task, "short diff"), /обрезан/);
});

test("a '- НЕТ' bullet is not a finding, and a numbered list under БЛОКИРУЮЩИЕ is", () => {
  assert.deepEqual(parseReviewResponse("БЛОКИРУЮЩИЕ:\n- НЕТ\n\nЗАМЕЧАНИЯ:\n- нет."), []);
  const numbered = parseReviewResponse("БЛОКИРУЮЩИЕ:\n1. a.ts:3 — гонка\n2) b.ts:9 — утечка\n\nЗАМЕЧАНИЯ:\nНЕТ");
  assert.deepEqual(numbered.map((f) => [f.blocking, f.description]), [[true, "a.ts:3 — гонка"], [true, "b.ts:9 — утечка"]]);
});

test("the explicit verdict line is required; missing = no verdict (fail closed), BLOCK without a parsed list still blocks", () => {
  assert.equal(parseVerdictLine("БЛОКИРУЮЩИЕ:\nНЕТ\nЗАМЕЧАНИЯ:\nНЕТ\nВЕРДИКТ: OK"), "OK");
  assert.equal(parseVerdictLine("…\n**ВЕРДИКТ: BLOCK**"), "BLOCK");
  assert.equal(parseVerdictLine("Формат: ВЕРДИКТ: OK|BLOCK\n…\nВЕРДИКТ: block"), "BLOCK");
  assert.equal(parseVerdictLine("БЛОКИРУЮЩИЕ:\nНЕТ"), undefined);
  assert.match(buildReviewPrompt(task, "d"), /ВЕРДИКТ: OK/);

  const none = interpretReview("Всё хорошо, замечаний нет.");
  assert.equal(none.verdict, false);
  assert.match(none.reason!, /нет строки ВЕРДИКТ/);
  assert.ok(reviewGate({ ...none, costUsd: 0 }).some((f) => f.blocking && /нужен человек/.test(f.description)));

  const block = interpretReview("БЛОКИРУЮЩИЕ:\nесть гонка в a.ts, абзацем\n\nЗАМЕЧАНИЯ:\nНЕТ\n\nВЕРДИКТ: BLOCK");
  assert.equal(block.verdict, true);
  assert.ok(block.findings.some((f) => f.blocking));

  const ok = interpretReview("БЛОКИРУЮЩИЕ:\n- НЕТ\n\nЗАМЕЧАНИЯ:\n- a.ts:1 — мелочь\n\nВЕРДИКТ: OK");
  assert.equal(ok.verdict, true);
  assert.deepEqual(reviewGate({ ...ok, costUsd: 0 }).filter((f) => f.blocking), []);

  assert.ok(reviewGate({ findings: [], costUsd: 0, reason: "ход завершился ошибкой: timeout" }).some((f) => f.blocking), "an errored review is never 'no findings'");
});

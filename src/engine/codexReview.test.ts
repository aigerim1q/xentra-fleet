import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_FINDING_PREFIX,
  CODEX_REVIEW_SCHEMA,
  buildCodexArgs,
  buildCodexReviewPrompt,
  mergeReviewOutcomes,
  parseCodexReview,
} from "./codexReview.js";
import type { TaskSpec } from "../types.js";

const task: TaskSpec = {
  id: "XEN-55",
  title: "Пагинация не работает для архивных записей",
  description: "Фильтр по статусу не учитывает архивные записи.",
  acceptanceCriteria: ["Архивные записи не попадают в выдачу по умолчанию"],
};

test("buildCodexReviewPrompt shares the task brief and asks for the JSON fields", () => {
  const prompt = buildCodexReviewPrompt(task, "diff --git a/x.ts b/x.ts\n+added line");
  assert.match(prompt, /XEN-55/);
  assert.match(prompt, /Архивные записи не попадают/);
  assert.match(prompt, /added line/);
  assert.match(prompt, /"blocking"/);
  assert.match(prompt, /"notes"/);
  assert.doesNotMatch(prompt, /БЛОКИРУЮЩИЕ:/);
});

test("buildCodexArgs runs read-only, without MCP, with the prompt on stdin", () => {
  const args = buildCodexArgs({ model: "gpt-6-astra", effort: "high", cwd: "/wt", schemaPath: "/s.json", outputPath: "/o.json" });
  assert.equal(args[0], "exec");
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(args[args.indexOf("-m") + 1], "gpt-6-astra");
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes("mcp_servers={}"));
  assert.equal(args[args.indexOf("-C") + 1], "/wt");
  assert.equal(args[args.indexOf("--output-schema") + 1], "/s.json");
  assert.equal(args[args.indexOf("-o") + 1], "/o.json");
  assert.equal(args.at(-1), "-");
  assert.ok(!args.some((a) => a.includes("danger") || a === "--full-auto"));
});

test("CODEX_REVIEW_SCHEMA is strict: both fields required, nothing extra", () => {
  assert.deepEqual([...CODEX_REVIEW_SCHEMA.required], ["blocking", "notes"]);
  assert.equal(CODEX_REVIEW_SCHEMA.additionalProperties, false);
});

test("parseCodexReview maps blocking and notes into prefixed findings", () => {
  const findings = parseCodexReview(
    JSON.stringify({ blocking: ["src/x.ts:10 — SQL-инъекция"], notes: ["src/y.ts:20 — вынести функцию", "  "] }),
  );
  assert.deepEqual(findings, [
    { blocking: true, description: `${CODEX_FINDING_PREFIX}src/x.ts:10 — SQL-инъекция` },
    { blocking: false, description: `${CODEX_FINDING_PREFIX}src/y.ts:20 — вынести функцию` },
  ]);
});

test("parseCodexReview returns no findings for a clean review", () => {
  assert.deepEqual(parseCodexReview('{"blocking":[],"notes":[]}'), []);
});

test("parseCodexReview returns undefined for output that isn't JSON", () => {
  assert.equal(parseCodexReview("Looks good to me"), undefined);
  assert.equal(parseCodexReview("null"), undefined);
});

test("parseCodexReview ignores non-string items instead of throwing", () => {
  assert.deepEqual(parseCodexReview('{"blocking":[1,null,{"a":1}],"notes":"x"}'), []);
});

test("mergeReviewOutcomes blocks when only the second reviewer blocks", () => {
  const merged = mergeReviewOutcomes(
    { findings: [{ blocking: false, description: "мелочь" }], costUsd: 0.4 },
    { findings: [{ blocking: true, description: "[Codex] дыра" }], costUsd: 0 },
  );
  assert.equal(merged.findings.filter((f) => f.blocking).length, 1);
  assert.equal(merged.findings.length, 2);
  assert.equal(merged.costUsd, 0.4);
  assert.equal(merged.reason, undefined);
});

test("mergeReviewOutcomes keeps one reviewer's verdict when the other errored", () => {
  const merged = mergeReviewOutcomes(
    { findings: [{ blocking: true, description: "дыра" }], costUsd: 0.2 },
    { findings: [], costUsd: 0, reason: "Codex: не уложился в 20 мин" },
  );
  assert.equal(merged.findings.length, 1);
  assert.equal(merged.reason, "Codex: не уложился в 20 мин");
});

test("mergeReviewOutcomes joins both reasons when both errored", () => {
  const merged = mergeReviewOutcomes(
    { findings: [], costUsd: 0.1, reason: "ход завершился ошибкой" },
    { findings: [], costUsd: 0, reason: "Codex: ответ не по схеме" },
  );
  assert.equal(merged.reason, "ход завершился ошибкой; Codex: ответ не по схеме");
});

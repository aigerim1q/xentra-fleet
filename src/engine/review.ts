import { runClaudeTurn } from "./claudeEngine.js";
import { getWorktreeDiff } from "./git.js";
import type { ReviewFinding, TaskSpec } from "../types.js";

export interface ReviewOutcome {
  findings: ReviewFinding[];
  costUsd: number;
  reason?: string; // set when the turn itself errored — findings is then always []
  // Whether the reviewer actually delivered a verdict (an explicit ВЕРДИКТ line, or a
  // schema-checked Codex answer). Absent = derived from `reason` (older callers).
  verdict?: boolean;
}

export function producedVerdict(o: ReviewOutcome): boolean {
  return o.verdict ?? o.reason === undefined;
}

// Fail closed: a review that produced no verdict (turn error, format not followed) is a
// blocking finding for a human, never "no findings".
export function reviewGate(o: ReviewOutcome): ReviewFinding[] {
  if (producedVerdict(o)) return o.findings;
  return [...o.findings, { blocking: true, description: `Ревью не проведено: ${o.reason ?? "ревьюер не дал вердикта"} — нужен человек` }];
}

// Deliberately asked NOT to re-check what gates/tests already cover — a reviewer that
// repeats "tests pass" is noise, not signal. The whole point of this step is to catch
// the category of problem automated checks structurally can't: architectural
// decisions, security issues a passing test doesn't exercise, edge cases nobody wrote
// a test for, convention violations.
// Shared by both reviewers (Claude here, Codex in codexReview.ts) so they judge the
// exact same task, criteria and diff — only the answer format differs.
// The embedded diff is capped; a cut diff says so, with the size, so the reviewer reads
// the rest in the worktree instead of taking a partial view for the whole change.
export const REVIEW_DIFF_CHARS = 8000;

export function buildReviewBrief(task: TaskSpec, diffText: string): string[] {
  const criteria =
    task.acceptanceCriteria.length > 0
      ? task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")
      : "(не зафиксированы для этой задачи)";
  const truncated = diffText.length > REVIEW_DIFF_CHARS;
  return [
    `Задача ${task.id}: ${task.title}`,
    "",
    task.description,
    "",
    "Критерии приёмки:",
    criteria,
    "",
    "Изменения (diff), уже прошедшие typecheck/lint/build/тесты:",
    "```diff",
    truncated ? diffText.slice(0, REVIEW_DIFF_CHARS) : diffText,
    "```",
    ...(truncated
      ? [
          `⚠️ Diff обрезан: показаны первые ${REVIEW_DIFF_CHARS} из ${diffText.length} символов. Остальные изменения прочитай в рабочей копии (git недоступен — открывай файлы) и не считай непоказанное проверенным.`,
        ]
      : []),
    "",
    "Ты — независимый ревьюер. Найди то, что НЕ поймали автоматические проверки:",
    "архитектурные проблемы, уязвимости, граничные случаи без покрытия, нарушение",
    "конвенций проекта, нечитаемый или рискованный код. НЕ повторяй то, что уже",
    "гарантировано прошедшими тестами/типами/сборкой, и не придирайся к стилю,",
    "если он соответствует остальному проекту.",
  ];
}

export function buildReviewPrompt(task: TaskSpec, diffText: string): string {
  return [
    ...buildReviewBrief(task, diffText),
    "",
    "Ответь СТРОГО в этом формате, на русском:",
    "",
    "БЛОКИРУЮЩИЕ:",
    "- <файл:строка — конкретная проблема и почему она блокирует>",
    "(если блокирующих проблем нет — напиши ровно НЕТ)",
    "",
    "ЗАМЕЧАНИЯ:",
    "- <файл:строка — на что стоит обратить внимание, не блокирует>",
    "(если замечаний нет — напиши ровно НЕТ)",
    "",
    "ВЕРДИКТ: OK",
    "(последняя строка — ровно `ВЕРДИКТ: OK` или `ВЕРДИКТ: BLOCK`; без неё ревью не засчитывается)",
  ].join("\n");
}

const BLOCKING_HEADING = /блокирующие\s*:?/i;
const NONBLOCKING_HEADING = /замечания\s*:?/i;
// "- item", "* item", "1. item", "1) item" — a numbered list under БЛОКИРУЮЩИЕ is a list too.
const BULLET_LINE = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/gm;
const NONE_ITEM = /^(нет|no|none)\.?$/i;
const VERDICT_LINE = /^\s*\**\s*ВЕРДИКТ\s*:\s*\**\s*(OK|BLOCK)\b/im;

// The explicit verdict line, or undefined when the reviewer didn't give one. Taken from
// the LAST such line: a reviewer quoting the format first and deciding later wins.
export function parseVerdictLine(text: string): "OK" | "BLOCK" | undefined {
  let last: string | undefined;
  for (const m of text.matchAll(new RegExp(VERDICT_LINE.source, "gim"))) last = m[1].toUpperCase();
  return last as "OK" | "BLOCK" | undefined;
}

export function parseReviewResponse(text: string): ReviewFinding[] {
  const blockIdx = text.search(BLOCKING_HEADING);
  const noteIdx = text.search(NONBLOCKING_HEADING);
  // Model didn't follow the format — fail open (no findings) rather than guessing at
  // structure that isn't there; a review that can't be parsed shouldn't silently block.
  if (blockIdx === -1 && noteIdx === -1) return [];

  const blockingEnd = noteIdx !== -1 && noteIdx > blockIdx ? noteIdx : undefined;
  const blockingSection = blockIdx !== -1 ? text.slice(blockIdx, blockingEnd) : "";
  const nonblockingSection = noteIdx !== -1 ? text.slice(noteIdx) : "";

  const items = (section: string) => [...section.matchAll(BULLET_LINE)].map((m) => m[1].trim()).filter((d) => !NONE_ITEM.test(d));
  const blocking = items(blockingSection).map((description) => ({ blocking: true, description }));
  const nonblocking = items(nonblockingSection).map((description) => ({ blocking: false, description }));
  return [...blocking, ...nonblocking];
}

// What the developer turn sees when the reviewer found something blocking — same
// session (resumeSessionId), so it already remembers the whole task; this only needs
// to hand over what's new. Explicitly invites pushback rather than silent compliance —
// "не додумывай и не игнорируй" is a prompt-level nudge, not a mechanical guarantee,
// but asking the agent to say so when a finding looks wrong is strictly better than not
// asking at all.
export function buildReviewFixPrompt(blocking: ReviewFinding[]): string {
  return [
    "Независимый ревьюер проверил твои изменения и нашёл блокирующие проблемы.",
    "Исправь именно их, не трогая остальное без необходимости:",
    "",
    ...blocking.map((f, i) => `${i + 1}. ${f.description}`),
    "",
    "Если какое-то замечание кажется ошибочным или смысл неясен — прямо напиши об этом",
    "в ответе, а не игнорируй его молча и не додумывай за ревьюера.",
  ].join("\n");
}

// Audit-trail format for .harness-state/tasks/<id>/reviewer/round-N.md — reconstructs
// the review turn's own БЛОКИРУЮЩИЕ/ЗАМЕЧАНИЯ shape from the parsed findings, so a
// human reading the file back sees the same thing the model itself saw and responded
// to, round by round.
export function formatReviewRound(findings: ReviewFinding[], reason: string | undefined): string {
  if (reason) return `Ревью не удалось провести: ${reason}`;
  const blocking = findings.filter((f) => f.blocking);
  const nonblocking = findings.filter((f) => !f.blocking);
  return [
    "БЛОКИРУЮЩИЕ:",
    blocking.length > 0 ? blocking.map((f) => `- ${f.description}`).join("\n") : "НЕТ",
    "",
    "ЗАМЕЧАНИЯ:",
    nonblocking.length > 0 ? nonblocking.map((f) => `- ${f.description}`).join("\n") : "НЕТ",
  ].join("\n");
}

// Read-only, same shape as propose/acceptance: runs in the already-committed worktree
// (Edit/Write/Bash denied) so it can explore surrounding code for context, but can
// never itself change anything — a reviewer that edits the thing it's reviewing isn't
// independent.
export async function reviewChanges(
  worktreeDir: string,
  task: TaskSpec,
  opts: { model: string; baseBranch: string },
): Promise<ReviewOutcome> {
  const diffText = await getWorktreeDiff(worktreeDir, opts.baseBranch).catch(() => "");

  const turn = await runClaudeTurn({
    logLabel: "reviewer",
    cwd: worktreeDir,
    prompt: buildReviewPrompt(task, diffText),
    permissionMode: "acceptEdits",
    disallowedToolsOverride: "Bash,Edit,Write,MultiEdit",
    model: opts.model,
  });

  if (turn.isError) {
    return { findings: [], costUsd: turn.totalCostUsd, verdict: false, reason: `ход завершился ошибкой: ${turn.resultText.slice(0, 200)}` };
  }
  return { ...interpretReview(turn.resultText), costUsd: turn.totalCostUsd };
}

// Findings plus the explicit verdict. No ВЕРДИКТ line = no verdict (fail closed); a
// BLOCK line with nothing parsed under БЛОКИРУЮЩИЕ still blocks, with the text to read.
export function interpretReview(text: string): { findings: ReviewFinding[]; verdict: boolean; reason?: string } {
  const line = parseVerdictLine(text);
  const findings = parseReviewResponse(text);
  if (!line) return { findings, verdict: false, reason: "в ответе ревьюера нет строки ВЕРДИКТ: OK|BLOCK" };
  if (line === "BLOCK" && !findings.some((f) => f.blocking)) {
    findings.push({ blocking: true, description: `ревьюер поставил ВЕРДИКТ: BLOCK, но список блокирующих не разобран — прочитай его ответ: ${text.slice(0, 300)}` });
  }
  return { findings, verdict: true };
}

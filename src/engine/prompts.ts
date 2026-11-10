import type { GateResult, TaskSpec } from "../types.js";
import { buildBriefInstructions } from "./brief.js";

// memoryContext (from engine/memory.ts) is injected directly rather than left for the
// agent to discover on its own — it's not auto-loaded by the project's own CLAUDE.md
// (only AGENTS.md is), so without this the agent would only see it if it happened to
// read those files unprompted.
// ImpossibleBench (Zhong, Raghunathan, Carlini): an explicit "stop if the tests are
// flawed" instruction cut test-gaming from ~93% to ~1% on a model that otherwise made
// contradictory tests pass by special-casing them. Included in every implement prompt,
// with or without briefs.
export function buildTestIntegrityRule(briefsEnabled = true): string {
  return [
    "Never make a check pass by weakening it: do not delete, skip or loosen tests, do not",
    "special-case test inputs, do not change what a gate runs. If the acceptance criteria,",
    "the acceptance test or existing tests contradict each other or the task,",
    briefsEnabled
      ? "STOP and raise a brief (format below) instead of forcing them to pass."
      : "STOP, make no further edits and explain the contradiction in your reply.",
  ].join("\n");
}

export function buildInitialPrompt(task: TaskSpec, memoryContext = "", briefsEnabled = true, contextPack = ""): string {
  const criteria = task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return [
    `Task ${task.id}: ${task.title}`,
    "",
    task.description,
    "",
    "Acceptance criteria:",
    criteria,
    contextPack ? `\n${contextPack}\n` : "",
    memoryContext ? `\n${memoryContext}\n` : "",
    "Implement this fully in the current repository by editing files directly.",
    "Follow the project's existing conventions. You do not have shell access in",
    "this session and should not attempt to run commands; a separate process",
    "will run tests and commit your changes. Stop once the files are correct.",
    "",
    buildTestIntegrityRule(briefsEnabled),
    briefsEnabled ? `\n${buildBriefInstructions()}` : "",
  ].join("\n");
}

// A human explicitly chose to continue past a context_budget stop with a brand-new
// session (CloseLoopResumeState.freshSession, queue.ts's continueNeedsHuman) — this
// session has no memory of what the old one tried or why, only the diff it actually
// left behind. Says so honestly rather than presenting the diff as this turn's own
// prior work, and leads with it being INCOMPLETE (stopped on a budget limit, not
// because it was finished) so the model reads/verifies before assuming it just needs
// polish.
export function buildContinuationPrompt(task: TaskSpec, diff: string, briefsEnabled = true): string {
  const criteria = task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return [
    `Task ${task.id}: ${task.title}`,
    "",
    task.description,
    "",
    "Acceptance criteria:",
    criteria,
    "",
    "A previous session already made partial progress on this task in the current",
    "repository, then stopped because its own context window was getting too full to",
    "keep working reliably — not because the work was finished or verified. You are a",
    "fresh session with no memory of that one's reasoning; the diff below (uncommitted",
    "and committed changes together) is everything that actually happened so far.",
    "",
    "```diff",
    diff,
    "```",
    "",
    "Review what's already there against the acceptance criteria above — it may be",
    "incomplete, or partway through an approach worth reconsidering — then finish the",
    "implementation by editing files directly. Follow the project's existing",
    "conventions. You do not have shell access in this session and should not attempt",
    "to run commands; a separate process will run tests and commit your changes. Stop",
    "once the files are correct.",
    "",
    buildTestIntegrityRule(briefsEnabled),
    briefsEnabled ? `\n${buildBriefInstructions()}` : "",
  ].join("\n");
}

// One section per failing gate (not one combined blob) — each capped separately so
// e.g. a verbose lint failure can't crowd a short typecheck failure out of the
// agent's view. Naming the gate up front also lets the agent see immediately that
// typecheck/lint/test are independent problems, not one tangled failure.
export function buildFeedbackPrompt(failedGates: GateResult[]): string {
  const sections = failedGates
    .map((g) => `### ${g.name} (\`${g.command}\`) failed\n\n\`\`\`\n${g.output.slice(0, 4000)}\n\`\`\``)
    .join("\n\n");
  return [
    `Verification failed after your last change. ${failedGates.length} gate(s) failed:`,
    "",
    sections,
    "",
    "Fix the root cause for each failing gate by editing files, then stop. Do not",
    "weaken, skip or delete a check to get it green — if a test itself is wrong or",
    "contradicts the task, stop and say so instead.",
  ].join("\n");
}

// Continue after the harness killed a turn on time (idle watchdog or turn ceiling).
// Sent into the SAME session via --resume, so the task itself is already known — this
// only says what happened, where the unfinished edits are, and to check before trusting
// them (the turn was cut mid-way, the last edit may be half-done).
export function buildTimeoutResumePrompt(stoppedBy: { kind: "idle" | "ceiling"; afterMs: number; checkpointCommitted: boolean }): string {
  const minutes = Math.round(stoppedBy.afterMs / 60000);
  const why =
    stoppedBy.kind === "idle"
      ? `the session produced no output for ${minutes} min (idle watchdog)`
      : `the turn ran past its ${minutes}-min time limit`;
  return [
    `Your previous turn was stopped by the harness: ${why}.`,
    stoppedBy.checkpointCommitted
      ? "Your unfinished edits at that moment were saved as a commit \"wip: checkpoint ...\" in this worktree (see `git log`)."
      : "There were no unfinished edits to save at that moment.",
    "The turn was cut mid-way, so the last edit may be incomplete. Re-read the files you",
    "were changing, check them against the acceptance criteria, then finish the task.",
    "If you were stuck on something, take a different approach instead of repeating it.",
  ].join("\n");
}

// The same notice for a continue that has to start a fresh session (no session id to
// resume): prepended to buildContinuationPrompt's diff-based handover.
export function buildTimeoutCheckpointNote(stoppedBy: { checkpointCommitted: boolean }): string {
  return stoppedBy.checkpointCommitted
    ? "The previous session was stopped on time; its unfinished edits are in a \"wip: checkpoint ...\" commit, included in the diff below."
    : "The previous session was stopped on time before making further edits.";
}

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GateResult, TaskSpec } from "../types.js";
import { buildBriefInstructions } from "./brief.js";
import { buildTestIntegrityRule } from "./prompts.js";

// Context handoff for the implement session.
//
// Model quality drops well before the context window is full, and the agent can't see
// its own context size, so the harness measures it (totalContextTokens) and acts. At
// the handoff threshold (default 80k ≈ 40% of a 200k window), the session writes a
// short handoff note, then a brand-new session continues from that note, the current
// diff and the failing gates. The hard stop (maxContextTokens) stays as the last
// resort for when handoffs are exhausted or disabled.

export interface HandoffConfig {
  thresholdTokens: number;
  maxHandoffs: number;
  baseBranch: string;
}

const HANDOFF_TAG = /<handoff>([\s\S]*?)<\/handoff>/i;
export const MAX_HANDOFF_NOTE_CHARS = 6_000;
export const MAX_HANDOFF_DIFF_CHARS = 40_000;

/** Pure decision, kept separate from the loop so it can be tested on its own. */
export function shouldHandOff(contextTokens: number, handoffsUsed: number, cfg: HandoffConfig | undefined): boolean {
  if (!cfg || cfg.thresholdTokens <= 0) return false;
  return contextTokens >= cfg.thresholdTokens && handoffsUsed < cfg.maxHandoffs;
}

// Asked in the SAME session that is about to be replaced: only it knows what it tried
// and why. Read-only turn — the loop runs it with Edit/Write disallowed.
export function buildHandoffRequestPrompt(failedGates: GateResult[]): string {
  const gates = failedGates.map((g) => g.name).join(", ") || "none";
  return [
    "Your context is getting large, so this session will end and a fresh session will",
    "continue the task. Do NOT edit any files now. Write a handoff note for that next",
    "session — it will see the task, the current diff and the failing gates, but none",
    "of your reasoning. Put ONLY these sections inside <handoff>...</handoff>:",
    "",
    "## Done — what is implemented and believed correct",
    "## Tried and failed — each approach that did not work and WHY (so it isn't repeated)",
    "## Current hypothesis — what you think is wrong now",
    "## Next steps — concrete, in order",
    "## Watch out — constraints, project rules or traps you discovered",
    "",
    `Currently failing gates: ${gates}. Be specific (file paths, function names), keep it`,
    "under 60 lines, no code dumps — the diff is passed separately.",
  ].join("\n");
}

/** The note inside <handoff> tags; falls back to the whole reply if the tag is missing. */
export function parseHandoffNote(text: string): string {
  const match = HANDOFF_TAG.exec(text);
  const note = (match ? match[1] : text).trim();
  return note.slice(0, MAX_HANDOFF_NOTE_CHARS);
}

export function buildHandoffContinuationPrompt(
  task: TaskSpec,
  note: string,
  diff: string,
  failedGates: GateResult[],
  handoffNumber: number,
  briefsEnabled = true,
): string {
  const criteria = task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const gates = failedGates
    .map((g) => `### ${g.name} (\`${g.command}\`)\n\n\`\`\`\n${g.output.slice(0, 3000)}\n\`\`\``)
    .join("\n\n");
  const truncated = diff.length > MAX_HANDOFF_DIFF_CHARS;
  return [
    `Task ${task.id}: ${task.title}`,
    "",
    task.description,
    "",
    "Acceptance criteria:",
    criteria || "(none)",
    "",
    `You are continuing this task as a fresh session (handoff #${handoffNumber}). The previous`,
    "session stopped because its context grew too large — the work is NOT finished.",
    "It left you this handoff note:",
    "",
    "<previous_session_handoff>",
    note,
    "</previous_session_handoff>",
    "",
    "Current changes (committed and uncommitted together):",
    "```diff",
    diff.slice(0, MAX_HANDOFF_DIFF_CHARS),
    "```",
    truncated ? "(diff truncated — read the files themselves for the rest)" : "",
    "",
    gates ? `Gates still failing:\n\n${gates}` : "",
    "",
    "Before any edit, check the note against the code and the failing gates above: the",
    "note is a summary and can be stale or wrong. Where they disagree, trust the code and",
    "the gates. Do not repeat approaches the note lists as failed. Then finish the",
    "implementation by editing files directly, following the project's conventions. You",
    "have no shell; a separate process runs the gates and commits. Stop once the files",
    "are correct.",
    "",
    buildTestIntegrityRule(briefsEnabled),
    briefsEnabled ? `\n${buildBriefInstructions()}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

const STATE_ROOT = fileURLToPath(new URL("../../.harness-state/tasks/", import.meta.url));

/** Keeps every handoff note for audit/debugging; never fails the task over it. */
export async function saveHandoffNote(taskId: string, handoffNumber: number, note: string, root = STATE_ROOT): Promise<string | null> {
  const path = join(root, taskId.replace(/[^A-Za-z0-9_-]/g, "_"), `handoff-${handoffNumber}.md`);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, note);
    return path;
  } catch {
    return null;
  }
}

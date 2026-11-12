import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentEnv } from "./claudeEngine.js";
import { buildReviewBrief, producedVerdict } from "./review.js";
import { scrubSecrets } from "./secretScrub.js";
import { secretValues } from "../config.js";
import { getWorktreeDiff } from "./git.js";
import type { ReviewFinding, TaskSpec } from "../types.js";
import type { ReviewOutcome } from "./review.js";

// Second, independent reviewer on another provider. A reviewer from a different model
// lineage is less likely to share the implementer's blind spots than a second Claude
// turn would be. Same contract as reviewChanges: ReviewOutcome, fail open on error.

export interface CodexReviewOptions {
  model: string;
  effort: string;
  baseBranch: string;
  timeoutMs: number;
}

// Strict structured output: Codex enforces this schema on its final message, so there is
// no free-text format to drift from (unlike the Claude reviewer's БЛОКИРУЮЩИЕ/ЗАМЕЧАНИЯ).
export const CODEX_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    blocking: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["blocking", "notes"],
  additionalProperties: false,
} as const;

export const CODEX_FINDING_PREFIX = "[Codex] ";

export function buildCodexReviewPrompt(task: TaskSpec, diffText: string): string {
  return [
    ...buildReviewBrief(task, diffText),
    "",
    "Репозиторий доступен только на чтение — смотри окружающий код, если нужно, но ничего не меняй.",
    "",
    "Ответь на русском JSON-объектом по заданной схеме:",
    '- "blocking": блокирующие проблемы, каждая строкой "файл:строка — проблема и почему блокирует";',
    '- "notes": неблокирующие замечания в том же виде.',
    "Если проблем нет — пустые массивы.",
  ].join("\n");
}

// Read-only sandbox, no MCP servers (the user's ~/.codex/config.toml may list some),
// ephemeral session. The prompt goes over stdin ("-") so a long diff never hits argv limits.
export function buildCodexArgs(opts: {
  model: string;
  effort: string;
  cwd: string;
  schemaPath?: string;
  outputPath: string;
}): string[] {
  const schema = opts.schemaPath ? ["--output-schema", opts.schemaPath] : [];
  return [
    "exec",
    "--sandbox",
    "read-only",
    "--ephemeral",
    "-m",
    opts.model,
    "-c",
    `model_reasoning_effort="${opts.effort}"`,
    "-c",
    "mcp_servers={}",
    "-C",
    opts.cwd,
    ...schema,
    "-o",
    opts.outputPath,
    "-",
  ];
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
}

// Unparseable output fails open (no findings), same as parseReviewResponse: a review we
// can't read shouldn't silently block the task. The caller reports it via `reason`.
export function parseCodexReview(text: string): ReviewFinding[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  return [
    ...stringList(obj.blocking).map((d) => ({ blocking: true, description: CODEX_FINDING_PREFIX + d })),
    ...stringList(obj.notes).map((d) => ({ blocking: false, description: CODEX_FINDING_PREFIX + d })),
  ];
}

// Blocks if either reviewer blocks: findings are simply concatenated, and the loop
// already treats any blocking finding as blocking. A reviewer that errored contributes
// no findings, only its reason — the other one's verdict still stands.
export function mergeReviewOutcomes(a: ReviewOutcome, b: ReviewOutcome): ReviewOutcome {
  const reasons = [a.reason, b.reason].filter((r): r is string => !!r);
  return {
    findings: [...a.findings, ...b.findings],
    costUsd: a.costUsd + b.costUsd,
    reason: reasons.length > 0 ? reasons.join("; ") : undefined,
    verdict: producedVerdict(a) || producedVerdict(b),
  };
}

let currentCodex: ChildProcess | null = null;

export function killCodexReview(): boolean {
  if (!currentCodex) return false;
  currentCodex.kill("SIGTERM");
  return true;
}

function runCodex(args: string[], prompt: string, timeoutMs: number): Promise<{ code: number | null; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    // buildAgentEnv strips the harness's Jira/GitLab/Telegram tokens; Codex keeps its
    // own ChatGPT login from ~/.codex, which lives outside the env.
    const child = spawn("codex", args, { env: buildAgentEnv(), stdio: ["pipe", "ignore", "pipe"] });
    currentCodex = child;
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const finish = (code: number | null) => {
      clearTimeout(timer);
      if (currentCodex === child) currentCodex = null;
      resolve({ code, stderr, timedOut });
    };
    child.on("error", (err) => {
      stderr += String(err);
      finish(null);
    });
    child.on("close", finish);
    child.stdin.end(prompt);
  });
}

// General one-shot Codex run (read-only sandbox, no MCP, tokens stripped from env):
// returns the final message, or why there is none. Used by the reviewer below and by
// the fleet's codex roles.
export async function runCodexExec(opts: {
  cwd: string;
  prompt: string;
  model: string;
  effort: string;
  timeoutMs: number;
  schema?: object;
}): Promise<{ text: string } | { error: string }> {
  const dir = mkdtempSync(join(tmpdir(), "codex-run-"));
  try {
    const outputPath = join(dir, "last-message.txt");
    let schemaPath: string | undefined;
    if (opts.schema) {
      schemaPath = join(dir, "schema.json");
      writeFileSync(schemaPath, JSON.stringify(opts.schema));
    }
    const args = buildCodexArgs({ model: opts.model, effort: opts.effort, cwd: opts.cwd, schemaPath, outputPath });
    const run = await runCodex(args, opts.prompt, opts.timeoutMs);
    const why = (s: string) => ({ error: scrubSecrets(s, secretValues()).slice(0, 200) });
    if (run.timedOut) return why(`не уложился в ${Math.round(opts.timeoutMs / 60000)} мин`);
    if (run.code !== 0) return why(`код выхода ${run.code}: ${run.stderr.trim().split("\n").slice(-3).join(" ")}`);
    try {
      return { text: scrubSecrets(readFileSync(outputPath, "utf8"), secretValues()) };
    } catch {
      return why("нет итогового ответа");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function reviewWithCodex(worktreeDir: string, task: TaskSpec, opts: CodexReviewOptions): Promise<ReviewOutcome> {
  const diffText = await getWorktreeDiff(worktreeDir, opts.baseBranch).catch(() => "");
  const run = await runCodexExec({
    cwd: worktreeDir,
    prompt: buildCodexReviewPrompt(task, diffText),
    model: opts.model,
    effort: opts.effort,
    timeoutMs: opts.timeoutMs,
    schema: CODEX_REVIEW_SCHEMA,
  });
  if ("error" in run) return { findings: [], costUsd: 0, verdict: false, reason: `Codex: ${run.error}` };
  const findings = parseCodexReview(run.text);
  if (!findings) return { findings: [], costUsd: 0, verdict: false, reason: "Codex: ответ не по схеме" };
  // Billed to the ChatGPT subscription, not per token — nothing to add to the task cost.
  return { findings, costUsd: 0, verdict: true };
}

import { spawn } from "node:child_process";
import type { GateBaseline, GateResult, GateSpec, VerifyResult } from "../types.js";
import { buildRepoCodeEnv } from "./claudeEngine.js";
import { secretValues } from "../config.js";
import { killProcessGroup } from "./processGroup.js";
import { scrubSecrets } from "./secretScrub.js";

// A gate that hangs (a test waiting on a port, a watcher that never exits) would hold
// the role and its thread forever: every gate has a time limit, and on timeout its whole
// process group is killed, not just the shell at the top.
export const DEFAULT_GATE_TIMEOUT_MS = Number(process.env.GATE_TIMEOUT_MS ?? 30 * 60 * 1000);
const GATE_KILL_GRACE_MS = 10_000;
const OUTPUT_CAP = 1024 * 1024 * 20;

// Gates run code the agent wrote (tests, acceptance tests, whatever `yarn test`
// picks up), so they get the same token-free env as the agent itself — otherwise a
// test could read JIRA_PAT/GITLAB_TOKEN/TELEGRAM_BOT_TOKEN from process.env and
// send them out, bypassing buildAgentEnv entirely. Output is scrubbed too: it goes
// back into the agent's prompt and, on needs-human, to Telegram.
// Jest takes every core by default; on the owner's laptop that is a frozen machine. Unless the
// command already says otherwise, jest gates run with --maxWorkers (FLEET_JEST_MAX_WORKERS, 2).
export function capJestWorkers(command: string, workers = process.env.FLEET_JEST_MAX_WORKERS ?? "2"): string {
  if (/--maxWorkers|-w\s/.test(command)) return command;
  return `${command} --maxWorkers=${workers}`;
}

// One gate command at a time across the whole process (all threads, the pipeline, baselines):
// a full jest/tsc/build run eats several GB of RAM, and two of them in parallel froze the
// owner's laptop (2026-11-13). Queued commands wait; their timeout starts when they run.
let gateQueue: Promise<unknown> = Promise.resolve();
export function runRaw(cwd: string, command: string, timeoutMs = DEFAULT_GATE_TIMEOUT_MS): Promise<{ exitedZero: boolean; output: string; timedOut: boolean }> {
  const run = gateQueue.then(() => runRawNow(cwd, command, timeoutMs));
  gateQueue = run.catch(() => undefined);
  return run;
}

function runRawNow(cwd: string, command: string, timeoutMs: number): Promise<{ exitedZero: boolean; output: string; timedOut: boolean }> {
  const scrub = (text: string) => scrubSecrets(text, secretValues());
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, detached: true, env: buildRepoCodeEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const append = (chunk: Buffer) => {
      out += chunk.toString();
      if (out.length > OUTPUT_CAP) out = out.slice(-OUTPUT_CAP);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killProcessGroup(child, "SIGTERM");
            killTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), GATE_KILL_GRACE_MS);
          }, timeoutMs)
        : undefined;
    const done = (exitedZero: boolean, extra: string) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ exitedZero, output: scrub([out, extra].filter(Boolean).join("\n")), timedOut });
    };
    child.on("error", (err) => done(false, err.message));
    child.on("close", (code, signal) => {
      if (timedOut) done(false, `[гейт остановлен: не уложился в ${Math.round(timeoutMs / 60000)} мин, процессы убиты]`);
      else done(code === 0, signal ? `[гейт убит сигналом ${signal}]` : "");
    });
  });
}

// Per-gate count parsers. A gate without one (or whose output doesn't match) falls
// back to a plain exit-code check against the gate's own baseline exit code — see
// the exitedZero fallback in compareGate below.
//
// Jest ("Tests:  N failed, ...") and Vitest ("Tests  N failed | ...") summaries both
// have a line starting with the word "Tests" — `\bTests\b` deliberately excludes
// Jest's "Test Suites:" and Vitest's "Test Files" lines, which report a DIFFERENT
// (smaller) count: one failing suite can contain several failing tests. Reproduced
// live: an unqualified `(\d+)\s+failed` matched "24 failed" from "Test Suites:"
// instead of the real "86 failed" on the "Tests:" line, understating the baseline.
const GATE_PARSERS: Record<string, (output: string) => number | null> = {
  test: (output) => {
    const match = output.match(/\bTests:?\s+(\d+)\s+failed\b/i);
    return match ? Number(match[1]) : null;
  },
  typecheck: (output) => {
    const matches = output.match(/error TS\d+:/g);
    return matches ? matches.length : null;
  },
  lint: (output) => {
    const match = output.match(/\b(\d+)\s+problems?\b/i);
    return match ? Number(match[1]) : null;
  },
};

function parseFailureCount(gateName: string, output: string): number | null {
  return GATE_PARSERS[gateName]?.(output) ?? null;
}

// Run once per gate against the freshly created worktree, before any agent edits. A
// flat "command must exit 0" check can never be satisfied in a repo that already has
// unrelated failing tests/lint errors (86 pre-existing test failures on back-ai as of
// 2026-10-29, none touching the ticket at hand) — every iteration was burning its
// budget on pre-existing failures that no fix could ever clear. Comparing against each
// gate's own pre-existing count (or, when uncountable, its own pre-existing exit code)
// means a gate that was already broken for unrelated reasons doesn't hold the agent's
// fix hostage.
export async function establishBaselines(cwd: string, gates: GateSpec[]): Promise<GateBaseline[]> {
  const baselines: GateBaseline[] = [];
  for (const gate of gates) {
    const { exitedZero, output } = await runRaw(cwd, gate.command, gate.timeoutMs);
    baselines.push({ name: gate.name, command: gate.command, exitedZero, failureCount: parseFailureCount(gate.name, output) });
  }
  return baselines;
}

function compareGate(gate: GateSpec, baseline: GateBaseline, exitedZero: boolean, output: string): boolean {
  if (exitedZero) return true;
  const failureCount = parseFailureCount(gate.name, output);
  // Can't count-compare when either side's output doesn't match the expected
  // summary format — fall back to the baseline's own exit code rather than risk
  // calling a real regression "no new failures" by accident, but also rather than
  // blocking forever on a gate that was already red before the agent touched anything.
  if (baseline.failureCount !== null && failureCount !== null) {
    return failureCount <= baseline.failureCount;
  }
  return !baseline.exitedZero; // gate was already failing at baseline time — not this fix's fault
}

// Runs every configured gate (doesn't stop at the first failure) and reports all of
// them together — one combined feedback prompt covering tsc+lint+test failures lets
// the agent fix everything in a single edit pass instead of burning separate
// iterations chasing one gate at a time under a tight MAX_ITERATIONS budget.
export async function runGates(cwd: string, gates: GateSpec[], baselines: GateBaseline[]): Promise<VerifyResult> {
  const results: GateResult[] = [];
  for (const gate of gates) {
    const baseline = baselines.find((b) => b.name === gate.name);
    const { exitedZero, output } = await runRaw(cwd, gate.command, gate.timeoutMs);
    // Strict gates never consult their baseline — a brand-new acceptance test failing
    // at baseline (no fix exists yet) is expected, not a pre-existing condition to
    // tolerate; it must actually pass now, "no worse than before" isn't good enough.
    const passed = gate.strict ? exitedZero : baseline ? compareGate(gate, baseline, exitedZero, output) : exitedZero;
    results.push({ name: gate.name, command: gate.command, passed, output });
  }
  const passed = results.every((r) => r.passed);
  const output = results
    .filter((r) => !r.passed)
    .map((r) => `[${r.name}]\n${r.output}`)
    .join("\n\n");
  return { passed, output, gates: results };
}

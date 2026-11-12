import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ClaudeTurnResult } from "../types.js";
import { buildDisallowedTools, withAlwaysDisallowed } from "./guardrails.js";
import { SECRET_ENV_VARS, config, secretValues } from "../config.js";
import { killProcessGroup } from "./processGroup.js";
import { scrubSecrets } from "./secretScrub.js";
import { openSessionLog } from "./sessionLog.js";

// What the agent, its gates and commit hooks may see of the owner's shell environment.
// Not a pure allowlist: the `claude`/`codex` CLIs' own env surface (PATH, HOME, proxy,
// NODE_OPTIONS, login state) isn't fully known here and an allowlist would silently
// break them. Instead: the harness's own secrets by name (SECRET_ENV_VARS), plus every
// variable whose NAME looks like a credential (…_TOKEN, …_SECRET, …PASSWORD…, …_API_KEY,
// AWS_…, …PRIVATE_KEY…), are dropped — except the engines' own credentials
// (AGENT_ENV_KEEP_PREFIXES) and names the owner lists in AGENT_ENV_KEEP.
export const SECRET_NAME_PATTERN = /(TOKEN|SECRET|PASSW(OR)?D|PASS$|API_?KEY|APIKEY|PRIVATE_?KEY|CREDENTIAL|ACCESS_KEY|AUTH_?KEY|^AWS_|^GH_|^NPM_|^DOCKER_|^VAULT_|_PAT$|^PAT$|^GITLAB_|^JIRA_)/i;
export const AGENT_ENV_KEEP_PREFIXES = ["CLAUDE_", "ANTHROPIC_", "CODEX_", "OPENAI_"];

export function buildAgentEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = new Set(
    (source.AGENT_ENV_KEEP ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if ((SECRET_ENV_VARS as readonly string[]).includes(key)) continue;
    if (keep.has(key) || AGENT_ENV_KEEP_PREFIXES.some((p) => key.startsWith(p))) {
      env[key] = value;
      continue;
    }
    if (SECRET_NAME_PATTERN.test(key)) continue;
    env[key] = value;
  }
  return env;
}

interface RunClaudeTurnOptions {
  cwd: string;
  prompt: string;
  permissionMode: string;
  resumeSessionId?: string;
  maxBudgetUsd?: number;
  extraDeniedPaths?: string[];
  // Bypasses the default guardrail deny-list with a caller-supplied value —
  // used for the read-only "propose a solution" turn, which denies Edit/Write
  // outright rather than just the usual sensitive-path subset.
  disallowedToolsOverride?: string;
  // Omit to inherit the CLI's own default model — every call site now passes one
  // explicitly (config.models.*) so this is effectively always set in practice.
  model?: string;
  onLog?: (line: string) => void;
  // Default to config.agentIdleTimeoutMs / agentTurnTimeoutMs; 0 disables.
  idleTimeoutMs?: number;
  turnTimeoutMs?: number;
  // Role name for the session journal file (engine/sessionLog.ts), e.g. "dev", "pm";
  // also the key under which the running child can be killed (killTurnsByLabel).
  logLabel?: string;
  // Called with the child's pid once spawned (the fleet records it next to the role).
  onSpawn?: (pid: number) => void;
}

// Thrown when the harness itself killed the turn: "idle" — the stream went silent for
// idleTimeoutMs; "ceiling" — the turn ran past turnTimeoutMs. sessionId comes from the
// stream's init event, so a caller can still --resume the killed session. costUsd is
// an estimate from the usage the stream reported before the kill (no result line ever
// arrives), so a killed session is not booked as free.
export class TurnTimeoutError extends Error {
  constructor(
    readonly kind: "idle" | "ceiling",
    readonly afterMs: number,
    readonly sessionId?: string,
    readonly costUsd = 0,
  ) {
    super(`claude turn stopped by ${kind === "idle" ? "idle watchdog" : "turn ceiling"} after ${Math.round(afterMs / 60000)} min`);
    this.name = "TurnTimeoutError";
  }
}

// Thrown when something else killed the turn by signal: /kill in the bot, the owner's
// "прервать" in the fleet, a shutdown. Same session id / cost estimate as above.
export class TurnKilledError extends Error {
  constructor(
    readonly signal: string,
    readonly sessionId?: string,
    readonly costUsd = 0,
  ) {
    super(`claude killed by ${signal}`);
    this.name = "TurnKilledError";
  }
}

export interface UsageTotals {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
}

// $/M tokens by model family, in the order input / cache read / cache write / output.
// A rough ledger figure for killed sessions, not billing: real cost comes from the
// result line when a turn finishes.
const PRICES: Array<[RegExp, [number, number, number, number]]> = [
  [/opus/i, [15, 1.5, 18.75, 75]],
  [/haiku/i, [1, 0.1, 1.25, 5]],
  [/./, [3, 0.3, 3.75, 15]],
];

export function estimateCostUsd(u: UsageTotals, model = ""): number {
  const [, p] = PRICES.find(([re]) => re.test(model)) ?? PRICES[PRICES.length - 1];
  const usd = (u.input * p[0] + u.cacheRead * p[1] + u.cacheCreation * p[2] + u.output * p[3]) / 1_000_000;
  return Math.round(usd * 10_000) / 10_000;
}

// SIGTERM first, SIGKILL if the process is still around after this — same grace the
// CTO fleet gives with `timeout --kill-after=60`.
const KILL_GRACE_MS = 60_000;

// input + cache read + cache creation of ONE model call — what the model actually saw.
export function messageContextTokens(usage: Record<string, unknown> | undefined): number {
  if (!usage) return 0;
  return (
    Number(usage.input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0)
  );
}

// Tracked outside the promise closure so /kill (bot) and the fleet's "прервать" can reach
// turns across call stacks. The pipeline runs one turn at a time; the fleet runs one per
// role, keyed by logLabel (the role name). Kills go to the whole process group.
const active = new Map<ChildProcess, string>();

export function killCurrentTurn(): boolean {
  let any = false;
  for (const child of active.keys()) any = killProcessGroup(child, "SIGTERM") || any;
  return any;
}

export function killTurnsByLabel(label: string): boolean {
  let any = false;
  for (const [child, l] of active) if (l === label) any = killProcessGroup(child, "SIGTERM") || any;
  return any;
}

export function activeTurnLabels(): string[] {
  return [...active.values()];
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  const path = (input.file_path as string) ?? (input.path as string);
  switch (name) {
    case "Read":
      return `Чтение ${path}`;
    case "Edit":
    case "MultiEdit":
      return `Правка ${path}`;
    case "Write":
      return `Запись ${path}`;
    case "Grep":
      return `Поиск по коду: "${truncate(String(input.pattern ?? ""), 60)}"`;
    case "Glob":
      return `Поиск файлов: "${truncate(String(input.pattern ?? ""), 60)}"`;
    default:
      return name;
  }
}

// Each line of `stream-json` output is one complete JSON event (verified live,
// without --include-partial-messages): "assistant" per finished content block,
// "user" for tool results, and a final "result" line shaped exactly like the
// single-shot `--output-format json` result — so the existing result parsing
// below needs no change, just finding that one line instead of the whole blob.
export async function runClaudeTurn(opts: RunClaudeTurnOptions): Promise<ClaudeTurnResult> {
  // The agent only edits files; git (commit/push/MR) stays in the harness's own
  // hands, not the model's — also sidesteps Auto Mode's Bash classifier, which
  // blocks unattended shell commands in headless runs even under bypassPermissions.
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    opts.permissionMode,
    "--disallowedTools",
    opts.disallowedToolsOverride
      ? withAlwaysDisallowed(opts.disallowedToolsOverride)
      : buildDisallowedTools(opts.extraDeniedPaths),
    // The owner's own MCP servers (Telegram, Atlassian, ...) must not load into an
    // unattended agent: an empty config plus --strict-mcp-config means no MCP at all.
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
  ];
  if (config.agentRestrictedMode) args.push("--restricted");
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  if (opts.maxBudgetUsd) args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  if (opts.model) args.push("--model", opts.model);
  // `--disallowedTools` is variadic; without `--` to end option parsing, commander
  // can swallow the prompt itself into that list instead of treating it as the
  // positional argument (reproduced live — the run then fails with "Input must be
  // provided either through stdin or as a prompt argument").
  args.push("--", opts.prompt);

  let resultLine: Record<string, unknown> | null = null;
  let stderrText = "";
  let lastContextTokens = 0;
  let streamSessionId: string | undefined;
  const totals: UsageTotals = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
  const idleMs = opts.idleTimeoutMs ?? config.agentIdleTimeoutMs;
  const ceilingMs = opts.turnTimeoutMs ?? config.agentTurnTimeoutMs;

  await new Promise<void>((resolve, reject) => {
    // Own process group: a kill (watchdog, /kill, shutdown) reaches every subprocess the
    // agent started, not just the CLI — see engine/processGroup.ts.
    const child = spawn("claude", args, { cwd: opts.cwd, env: buildAgentEnv(), detached: true });
    active.set(child, opts.logLabel ?? "turn");
    if (child.pid) opts.onSpawn?.(child.pid);
    const journal = openSessionLog(opts.logLabel ?? "turn", secretValues());

    let stoppedBy: { kind: "idle" | "ceiling"; afterMs: number } | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (kind: "idle" | "ceiling", afterMs: number) => {
      if (stoppedBy) return;
      stoppedBy = { kind, afterMs };
      killProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), KILL_GRACE_MS);
    };
    const ceilingTimer = ceilingMs > 0 ? setTimeout(() => stop("ceiling", ceilingMs), ceilingMs) : undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdle = () => {
      if (idleMs <= 0) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop("idle", idleMs), idleMs);
    };
    armIdle();

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      armIdle();
      journal?.write(line);
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        return; // a stray non-JSON line shouldn't crash the turn
      }

      if (event.type === "result") {
        resultLine = event;
        return;
      }
      if (event.type === "system" && typeof event.session_id === "string") streamSessionId = event.session_id;
      if (event.type === "assistant") {
        const u = (event.message as Record<string, unknown>)?.usage as Record<string, unknown> | undefined;
        const used = messageContextTokens(u);
        if (used > 0) lastContextTokens = used;
        if (u) {
          totals.input += Number(u.input_tokens ?? 0);
          totals.cacheRead += Number(u.cache_read_input_tokens ?? 0);
          totals.cacheCreation += Number(u.cache_creation_input_tokens ?? 0);
          totals.output += Number(u.output_tokens ?? 0);
        }
      }
      if (!opts.onLog) return;

      if (event.type === "assistant") {
        const content = ((event.message as Record<string, unknown>)?.content ?? []) as Array<Record<string, unknown>>;
        for (const block of content) {
          if (block.type === "tool_use") {
            opts.onLog(`→ ${summarizeToolUse(String(block.name), (block.input as Record<string, unknown>) ?? {})}`);
          } else if (block.type === "text" && block.text) {
            opts.onLog(truncate(String(block.text), 300));
          }
        }
      }
    });

    child.stderr.on("data", (chunk) => (stderrText += chunk));
    child.on("error", (err) => {
      active.delete(child);
      journal?.close();
      clearTimeout(ceilingTimer);
      clearTimeout(idleTimer);
      clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      active.delete(child);
      journal?.close();
      clearTimeout(ceilingTimer);
      clearTimeout(idleTimer);
      clearTimeout(killTimer);
      if (stoppedBy) {
        reject(new TurnTimeoutError(stoppedBy.kind, stoppedBy.afterMs, streamSessionId, estimateCostUsd(totals, opts.model)));
        return;
      }
      if (signal) {
        reject(new TurnKilledError(signal, streamSessionId, estimateCostUsd(totals, opts.model)));
        return;
      }
      if (code !== 0 && !resultLine) {
        reject(new Error(`claude exited with code ${code}: ${stderrText.trim()}`));
        return;
      }
      resolve();
    });
  });

  if (!resultLine) {
    throw new Error(`claude produced no result event. stderr:\n${stderrText.slice(0, 2000)}`);
  }

  const raw = resultLine as Record<string, unknown>;
  const usage = (raw.usage as Record<string, unknown>) ?? {};
  return {
    sessionId: String(raw.session_id ?? ""),
    // Scrubbed here, once, for every role — implement/acceptance's resultText is just
    // a status message (the real output is file edits, already outside this string),
    // while propose/review/memory/testing-notes/brief feed this straight into a Jira
    // comment, an MR description, or a committed memory file.
    resultText: scrubSecrets(String(raw.result ?? ""), secretValues()),
    isError: Boolean(raw.is_error),
    terminalReason: String(raw.terminal_reason ?? "unknown"),
    totalCostUsd: Number(raw.total_cost_usd ?? 0),
    usage: {
      inputTokens: Number(usage.input_tokens ?? 0),
      outputTokens: Number(usage.output_tokens ?? 0),
      cacheCreationInputTokens: Number(usage.cache_creation_input_tokens ?? 0),
      cacheReadInputTokens: Number(usage.cache_read_input_tokens ?? 0),
    },
    contextTokens: lastContextTokens,
  };
}

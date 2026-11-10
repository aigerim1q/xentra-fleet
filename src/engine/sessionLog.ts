import { AsyncLocalStorage } from "node:async_hooks";
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { scrubSecrets } from "./secretScrub.js";

// Session journal, as in the CTO fleet: every line of an agent turn's stream-json goes
// to .harness-state/tasks/<KEY>/sessions/<time>-<role>.jsonl as it arrives (`tail -f`),
// with secrets masked. Lets a human reconstruct what the agent read, ran and decided
// after the fact — especially after a turn was killed on time and left no result.
//
// Which task a turn belongs to travels in an AsyncLocalStorage scope set by the queue
// around a task's work, so the many runClaudeTurn call sites don't each need a task id.
// Outside a scope (e.g. the Telegram chat turn) nothing is written.
// A write or open failure never breaks the turn: the journal is best-effort.

const scope = new AsyncLocalStorage<{ taskId: string; dir: string }>();

export function withTaskLogScope<T>(taskId: string, stateDir: string, fn: () => Promise<T>): Promise<T> {
  return scope.run({ taskId, dir: join(stateDir, "tasks", taskId, "sessions") }, fn);
}

// Masks string VALUES of a JSON event (masking the raw line could break its quoting);
// a line that isn't JSON is masked whole.
export function maskStreamLine(line: string, knownSecrets: Record<string, string>): string {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return scrubSecrets(line, knownSecrets);
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrubSecrets(v, knownSecrets);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return JSON.stringify(walk(event));
}

export function sessionLogFileName(label: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${label.replace(/[^a-z0-9-]/gi, "_")}.jsonl`;
}

export interface SessionLogWriter {
  path: string;
  write(line: string): void;
  close(): void;
}

export function openSessionLog(label: string, knownSecrets: Record<string, string>): SessionLogWriter | undefined {
  const ctx = scope.getStore();
  if (!ctx) return undefined;
  let stream: WriteStream | undefined;
  const path = join(ctx.dir, sessionLogFileName(label));
  try {
    mkdirSync(ctx.dir, { recursive: true });
    stream = createWriteStream(path, { flags: "a" });
    stream.on("error", () => {
      stream = undefined;
    });
  } catch {
    return undefined;
  }
  return {
    path,
    write(line) {
      try {
        stream?.write(maskStreamLine(line, knownSecrets) + "\n");
      } catch {
        /* best-effort */
      }
    },
    close() {
      stream?.end();
      stream = undefined;
    },
  };
}

// Journals are big and only useful for a while — older than `days` are deleted at bot
// start (the CTO fleet prunes its session logs the same way). Returns how many went.
export function pruneSessionLogs(stateDir: string, days: number, now = Date.now()): number {
  if (days <= 0) return 0;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  const tasksDir = join(stateDir, "tasks");
  let tasks: string[];
  try {
    tasks = readdirSync(tasksDir);
  } catch {
    return 0;
  }
  for (const task of tasks) {
    const dir = join(tasksDir, task, "sessions");
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(dir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) {
          rmSync(p, { force: true });
          removed++;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { killPidGroup, pidAlive } from "../engine/processGroup.js";

// Process bookkeeping of the supervisor, all under state/:
//   supervisor.pid    one supervisor per spool — a second `fleet run` (or `fleet once`
//                     next to it) would start a second session in the same worktree;
//   running.<role>    written for the role's current session (thread, start, child pid);
//                     left behind by a crash it shows "работает" forever and the agent
//                     process it names may still be editing files — cleaned at start;
//   kill.<role>       the owner's request to interrupt that role's current session.

export const SUPERVISOR_LOCK = "supervisor.pid";

export function acquireSupervisorLock(stateDir: string, pid = process.pid): () => void {
  mkdirSync(stateDir, { recursive: true });
  const p = join(stateDir, SUPERVISOR_LOCK);
  const other = readPid(p);
  if (other !== undefined && other !== pid && pidAlive(other)) {
    throw new Error(`another supervisor is running (pid ${other}, ${p}) — stop it first or wait for it`);
  }
  rmSync(p, { force: true }); // stale (dead pid) or ours
  const fd = openSync(p, "wx");
  try {
    writeFileSync(fd, String(pid));
  } finally {
    closeSync(fd);
  }
  return () => {
    if (readPid(p) === pid) rmSync(p, { force: true });
  };
}

function readPid(p: string): number | undefined {
  try {
    const n = Number(readFileSync(p, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

export interface RunningSession {
  role: string;
  thread?: string;
  pid?: number;
}

// Leftovers of a previous supervisor: every running.<role> is removed, and an agent
// process still alive under it is killed with its group (it would keep editing a
// worktree this supervisor is about to hand to a new session).
export function cleanStaleRunning(stateDir: string, log?: (line: string) => void): RunningSession[] {
  if (!existsSync(stateDir)) return [];
  const out: RunningSession[] = [];
  for (const f of readdirSync(stateDir).filter((f) => f.startsWith("running."))) {
    const role = f.slice("running.".length);
    let info: RunningSession = { role };
    try {
      const r = JSON.parse(readFileSync(join(stateDir, f), "utf8")) as { thread?: string; pid?: number };
      info = { role, thread: r.thread, pid: typeof r.pid === "number" ? r.pid : undefined };
    } catch {
      /* unreadable: still stale */
    }
    if (info.pid && info.pid !== process.pid && pidAlive(info.pid)) {
      killPidGroup(info.pid, "SIGTERM");
      log?.(`${role}: killed orphaned agent process group ${info.pid} (thread ${info.thread ?? "?"})`);
    } else {
      log?.(`${role}: removed stale running marker (thread ${info.thread ?? "?"})`);
    }
    rmSync(join(stateDir, f), { force: true });
    out.push(info);
  }
  return out;
}

function killFile(stateDir: string, role: string): string {
  return join(stateDir, `kill.${role.replace(/[^a-z0-9-]/g, "_")}`);
}

export function requestKill(stateDir: string, role: string, by = "owner"): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(killFile(stateDir, role), JSON.stringify({ by, at: new Date().toISOString() }));
}

// Consumes the request (returns true once).
export function takeKillRequest(stateDir: string, role: string): boolean {
  const p = killFile(stateDir, role);
  if (!existsSync(p)) return false;
  rmSync(p, { force: true });
  return true;
}

import type { ChildProcess } from "node:child_process";

// Children the harness runs on the agent's behalf (claude, codex, gate commands) are
// spawned as leaders of their own process group (`detached: true`), so a kill reaches
// everything they started — a test runner's workers, a dev server a gate forgot to stop —
// and not just the shell at the top, as the CTO fleet does with `kill -- -pgid`.
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
}

export function killPidGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

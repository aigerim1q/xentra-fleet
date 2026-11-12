import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Verdict } from "./mergeBot.js";

// The last gate run per thread, pinned to the commit it ran on — shown to the owner in a
// push request next to the auditors' verdicts, so the decision is about this exact sha.

export interface GateRun {
  sha: string;
  passed: boolean;
  at: string;
  gates: Array<{ name: string; passed: boolean }>;
  integrity?: string[]; // gate-integrity violations found on that sha (empty = none)
}

const SAFE = (t: string) => t.replace(/[^A-Za-z0-9_-]/g, "_");

function file(stateDir: string, thread: string): string {
  return join(stateDir, "gates", `${SAFE(thread)}.json`);
}

export function saveGateRun(stateDir: string, thread: string, run: GateRun): void {
  mkdirSync(join(stateDir, "gates"), { recursive: true });
  const p = file(stateDir, thread);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(run, null, 2));
  renameSync(tmp, p);
}

export function loadGateRun(stateDir: string, thread: string): GateRun | undefined {
  const p = file(stateDir, thread);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as GateRun;
  } catch {
    return undefined;
  }
}

// Lines for the owner: what the gates and every auditor say about exactly this commit.
export function describeShaState(sha: string, gateRun: GateRun | undefined, verdicts: Record<string, Verdict>, auditors: string[]): string[] {
  const short = (s: string) => s.slice(0, 8);
  const lines: string[] = [];
  if (!gateRun) lines.push("Гейты: не запускались в этом треде");
  else if (gateRun.sha !== sha) lines.push(`Гейты: на этом коммите не запускались (последний прогон на ${short(gateRun.sha)}: ${gateRun.passed ? "зелёные" : "красные"})`);
  else {
    const detail = gateRun.gates.map((g) => `${g.name} ${g.passed ? "✅" : "❌"}`).join(", ");
    lines.push(`Гейты на ${short(sha)}: ${gateRun.passed ? "зелёные" : "есть красные"}${detail ? ` (${detail})` : ""}`);
    if (gateRun.integrity?.length) lines.push(`⚠️ Целостность гейтов нарушена: ${gateRun.integrity.join("; ")}`);
  }
  for (const a of auditors) {
    const v = verdicts[a];
    if (!v) lines.push(`${a}: вердикта нет`);
    else if (v.sha !== sha) lines.push(`${a}: смотрел другой коммит (${short(v.sha)}: ${v.blocking ? "BLOCK" : "OK"})`);
    else lines.push(`${a}: ${v.blocking ? "BLOCK ❌" : "OK ✅"} на ${short(sha)}`);
  }
  return lines;
}

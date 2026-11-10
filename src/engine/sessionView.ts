import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { summarizeToolUse } from "./claudeEngine.js";

// Human-readable view of the session journals (sessionLog.ts) for the owner's terminal:
// `node dist/cli.js watch` — what each agent reads, edits and says, live.
// Journals live under <stateDir>/tasks/<task-or-fleet-thread>/sessions/<time>-<role>.jsonl
// for both the pipeline (.harness-state) and the role fleet (~/.xentra-fleet/state).

export interface JournalFile {
  path: string;
  task: string; // XEN-55, or fleet-<thread>
  label: string; // role
  mtimeMs: number;
}

export function listJournals(stateDirs: string[]): JournalFile[] {
  const out: JournalFile[] = [];
  for (const root of stateDirs) {
    const tasks = join(root, "tasks");
    if (!existsSync(tasks)) continue;
    for (const task of readdirSync(tasks)) {
      const dir = join(tasks, task, "sessions");
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
        const path = join(dir, f);
        const label = f.replace(/\.jsonl$/, "").replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-/, "");
        out.push({ path, task, label, mtimeMs: statSync(path).mtimeMs });
      }
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

// One journal line -> zero or more display lines. Unknown events are skipped.
export function formatEvent(line: string, opts: { textChars?: number } = {}): string[] {
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line);
  } catch {
    return [];
  }
  const n = opts.textChars ?? 400;
  if (e.type === "system" && e.subtype === "init") return [`▶ сессия ${String(e.session_id ?? "").slice(0, 8)} · ${e.model ?? ""}`];
  if (e.type === "assistant") {
    const content = ((e.message as Record<string, unknown>)?.content ?? []) as Array<Record<string, unknown>>;
    const out: string[] = [];
    for (const b of content) {
      if (b.type === "tool_use") out.push(`→ ${summarizeToolUse(String(b.name), (b.input as Record<string, unknown>) ?? {})}`);
      else if (b.type === "text" && b.text) out.push(`💬 ${clip(String(b.text), n)}`);
    }
    return out;
  }
  if (e.type === "user") {
    const content = ((e.message as Record<string, unknown>)?.content ?? []) as Array<Record<string, unknown>>;
    return content.filter((b) => b.type === "tool_result" && b.is_error).map((b) => `  ✖ ошибка инструмента: ${clip(JSON.stringify(b.content ?? ""), 200)}`);
  }
  if (e.type === "result") {
    const cost = typeof e.total_cost_usd === "number" ? `~$${e.total_cost_usd.toFixed(2)}` : "";
    const dur = typeof e.duration_ms === "number" ? `${Math.round(e.duration_ms / 1000)} с` : "";
    return [`■ ${e.is_error ? "ошибка" : "готово"} · ${[cost, dur, e.num_turns ? `${e.num_turns} ходов` : ""].filter(Boolean).join(" · ")}`];
  }
  return [];
}

export function matches(j: JournalFile, filter: { task?: string; role?: string }): boolean {
  if (filter.task && !j.task.toLowerCase().includes(filter.task.toLowerCase())) return false;
  if (filter.role && j.label !== filter.role) return false;
  return true;
}

// Prints the last `tail` sessions in full, then (follow) new lines as they are written.
export function watchJournals(
  stateDirs: string[],
  opts: { task?: string; role?: string; tail?: number; follow?: boolean; print?: (s: string) => void; pollMs?: number },
): () => void {
  const print = opts.print ?? ((s: string) => console.log(s));
  const offsets = new Map<string, number>();
  const header = (j: JournalFile) => print(`\n── ${j.task} · ${j.label} · ${new Date(j.mtimeMs).toLocaleString("ru-RU")}`);

  const drain = (j: JournalFile, withHeader: boolean) => {
    const text = readFileSync(j.path, "utf8");
    const from = offsets.get(j.path) ?? 0;
    const end = text.lastIndexOf("\n") + 1; // only whole lines; a half-written one waits
    if (end <= from) return;
    const lines = text.slice(from, end).split("\n").flatMap((l) => (l ? formatEvent(l) : []));
    offsets.set(j.path, end);
    if (lines.length === 0) return;
    if (withHeader) header(j);
    for (const l of lines) print(`[${j.task} ${j.label}] ${l}`);
  };

  const initial = listJournals(stateDirs).filter((j) => matches(j, opts));
  const shown = initial.slice(-(opts.tail ?? 3));
  for (const j of initial) if (!shown.includes(j)) offsets.set(j.path, readFileSync(j.path, "utf8").length);
  for (const j of shown) drain(j, true);
  if (!opts.follow) return () => {};

  if (initial.length === 0) print("(журналов пока нет — жду новых сессий)");
  const timer = setInterval(() => {
    for (const j of listJournals(stateDirs).filter((x) => matches(x, opts))) {
      drain(j, !offsets.has(j.path));
    }
  }, opts.pollMs ?? 1000);
  return () => clearInterval(timer);
}

// Session id and working dir from a journal's init event — enough to open the session
// in Claude Code: cd <cwd> && claude --resume <id> --fork-session
export function sessionInfo(path: string): { sessionId?: string; cwd?: string; model?: string } {
  const first = readFileSync(path, "utf8").split("\n").find((l) => l.includes('"subtype":"init"'));
  if (!first) return {};
  try {
    const e = JSON.parse(first);
    return { sessionId: e.session_id, cwd: e.cwd, model: e.model };
  } catch {
    return {};
  }
}

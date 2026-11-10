import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scrubSecrets } from "../engine/secretScrub.js";

// Shared memory of the fleet, like the CTO fleet's `mail.<thread>` / `task.<key>`
// namespaces: a session can end any time, so what matters must live here, not in one
// session's context.
//   memory/thread/<thread>.md  decisions and facts of one thread
//   memory/task/<KEY>.md       what's known about a Jira task, across threads
// Read: injected into every session's prompt by the supervisor. Write: the role's
// <memory scope="thread|task"> blocks, appended with role and time. Bounded: oldest
// entries are dropped beyond MAX_MEMORY_CHARS.

export const MAX_MEMORY_CHARS = 12_000;
export type MemoryScope = "thread" | "task";

const SAFE = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");

function path(stateDir: string, scope: MemoryScope, id: string): string {
  return join(stateDir, "memory", scope, `${SAFE(id)}.md`);
}

export function readMemory(stateDir: string, scope: MemoryScope, id: string): string {
  const p = path(stateDir, scope, id);
  return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
}

// Keeps whole entries: drops the oldest "## " sections until the file fits.
export function trimEntries(text: string, max = MAX_MEMORY_CHARS): string {
  if (text.length <= max) return text;
  const parts = text.split(/\n(?=## )/);
  while (parts.length > 1 && parts.join("\n").length > max) parts.shift();
  const joined = parts.join("\n");
  return joined.length > max ? joined.slice(joined.length - max) : joined;
}

export function appendMemory(
  stateDir: string,
  scope: MemoryScope,
  id: string,
  entry: { role: string; text: string },
  knownSecrets: Record<string, string> = {},
  now = new Date(),
): void {
  const text = scrubSecrets(entry.text.trim(), knownSecrets);
  if (!text) return;
  const p = path(stateDir, scope, id);
  mkdirSync(join(stateDir, "memory", scope), { recursive: true });
  const prev = existsSync(p) ? readFileSync(p, "utf8").trimEnd() : "";
  const block = `## ${now.toISOString().slice(0, 16).replace("T", " ")} · ${entry.role}\n${text}`;
  writeFileSync(p, trimEntries(prev ? `${prev}\n\n${block}` : block) + "\n");
}

export function memoryPromptBlock(stateDir: string, thread: string, keys: string[]): string {
  const parts: string[] = [];
  const t = readMemory(stateDir, "thread", thread);
  parts.push(`## Память треда ${thread}\n${t || "(пусто)"}`);
  for (const k of [...new Set(keys)]) {
    const m = readMemory(stateDir, "task", k);
    parts.push(`## Память задачи ${k}\n${m || "(пусто)"}`);
  }
  return parts.join("\n\n");
}

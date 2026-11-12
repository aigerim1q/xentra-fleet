import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// State files under ~/.xentra-fleet/state are written by the supervisor and read by the
// bot and the console at the same time. tmp + rename means a reader never sees a half-
// written JSON; a reader that still meets junk (a crash mid-rename, a hand edit) skips it
// instead of taking the whole listing down.

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export function readJsonOr<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

// Every readable *.json in a directory; unreadable ones are skipped (and reported).
export function readJsonDir<T>(dir: string, onBad?: (file: string) => void): T[] {
  if (!existsSync(dir)) return [];
  const out: T[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as T);
    } catch {
      onBad?.(f);
    }
  }
  return out;
}

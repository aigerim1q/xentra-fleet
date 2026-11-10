import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Letter, type Spool, parseLetter } from "./mail.js";
import { OWNER_ADDRESS } from "./roles.js";

// Echo/loop protection, as in the CTO fleet: when roles mail each other in one thread
// faster than any real work needs (more than HOLD_LIMIT letters in HOLD_WINDOW_MS, or
// more than EARLY_LIMIT short "thanks/ok" letters), the thread is put on hold:
//   Holds/<thread>              flag, created atomically — only one guard wins the race
//   Holds/<thread>.triggered-at letters before this moment don't count again after release
// While held, role-to-role letters of that thread are moved to Quarantine/ unopened; the
// owner's letters still pass. The owner releases the hold (Telegram, or deleting the flag).

export const HOLD_WINDOW_MS = 30 * 60 * 1000;
export const HOLD_LIMIT = 30;
export const EARLY_LIMIT = 10;

function holdPath(spool: Spool, thread: string): string {
  return join(spool.holdsDir(), thread.replace(/[^A-Za-z0-9_-]/g, "_"));
}

export function isHeld(spool: Spool, thread: string): boolean {
  return existsSync(holdPath(spool, thread));
}

export function releaseHold(spool: Spool, thread: string): boolean {
  const p = holdPath(spool, thread);
  if (!existsSync(p)) return false;
  rmSync(p, { force: true });
  return true;
}

export function listHolds(spool: Spool): string[] {
  const dir = spool.holdsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => !f.endsWith(".triggered-at"));
}

function letterTime(l: Letter): number {
  const ts = Number(l.id.split("-")[0]);
  return Number.isFinite(ts) ? ts * 1000 : Date.parse(l.date);
}

// Short, content-free letters are what an echo loop looks like.
export function looksLikeEcho(bodies: string[]): boolean {
  if (bodies.length === 0) return false;
  const short = bodies.filter((b) => b.trim().length < 80).length;
  const avg = bodies.reduce((s, b) => s + b.trim().length, 0) / bodies.length;
  return short / bodies.length >= 0.3 || avg < 300;
}

// Role-to-role letters sent in this thread within the window and after the last trigger.
export function recentRoleLetters(spool: Spool, roleAddresses: string[], thread: string, now = Date.now()): Letter[] {
  let since = now - HOLD_WINDOW_MS;
  const trig = `${holdPath(spool, thread)}.triggered-at`;
  if (existsSync(trig)) since = Math.max(since, Number(readFileSync(trig, "utf8")) || 0);
  const out: Letter[] = [];
  for (const addr of roleAddresses) {
    const dir = spool.dir("Sent", addr);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const l = parseLetter(readFileSync(join(dir, f), "utf8"));
        if (l.thread === thread && !l.kind && letterTime(l) >= since) out.push(l);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

export function shouldHold(letters: Letter[]): boolean {
  if (letters.length > HOLD_LIMIT) return true;
  return letters.length > EARLY_LIMIT && looksLikeEcho(letters.map((l) => l.body));
}

// Returns true only for the caller that actually created the flag (O_EXCL), so exactly
// one alert goes out per trigger.
export function placeHold(spool: Spool, thread: string, now = Date.now()): boolean {
  mkdirSync(spool.holdsDir(), { recursive: true });
  try {
    const fd = openSync(holdPath(spool, thread), "wx");
    closeSync(fd);
  } catch {
    return false;
  }
  writeFileSync(`${holdPath(spool, thread)}.triggered-at`, String(now));
  return true;
}

// Moves a held thread's role-to-role letters out of an Inbox without waking anyone.
export function quarantine(spool: Spool, address: string, letter: Letter, now = new Date()): void {
  if (letter.from === OWNER_ADDRESS) return;
  const dir = join(spool.root, "Quarantine", `${now.toISOString().slice(0, 10)}-loop-${letter.thread}`);
  mkdirSync(dir, { recursive: true });
  const src = join(spool.dir("Inbox", address), `${letter.id}.md`);
  if (existsSync(src)) renameSync(src, join(dir, `${address.replace("/", "_")}-${letter.id}.md`));
}

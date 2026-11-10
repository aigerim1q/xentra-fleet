import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// File spool for mail between fleet roles — same layout and message format as the CTO
// fleet's team-mail, re-implemented in TS:
//   Inbox/<g>/<p>/<id>.md         unread letters of mailbox g/p
//   Sent/<g>/<p>/<id>.md          one copy per sent letter
//   Archive/<g>/<p>/YYYY-MM-DD/   read/handled letters, by day
//   Acks/<g>/<p>/<id>.md          acks addressed to g/p — never the Inbox, so an ack never wakes anyone
//   Holds/<thread>                echo-protection flag (see loopGuard.ts)
// A letter is markdown with a flat YAML-style header between `---` lines.

export type Priority = "low" | "normal" | "high" | "urgent";

export interface MailHeader {
  id: string;
  from: string;
  to: string[];
  subject: string;
  priority: Priority;
  date: string;
  thread: string;
  repo?: string;
  key?: string;
  kind?: "ack" | "auto-ack";
  ackOf?: string;
}

export interface Letter extends MailHeader {
  body: string;
}

export const ADDRESS_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/;
const ID_RE = /^[A-Za-z0-9_-]+$/;

export function spoolRoot(): string {
  return process.env.FLEET_MAIL_DIR ?? join(homedir(), ".xentra-fleet", "mail");
}

export class Spool {
  constructor(readonly root: string = spoolRoot()) {}

  dir(kind: "Inbox" | "Sent" | "Acks" | "Archive", address: string): string {
    if (!ADDRESS_RE.test(address)) throw new Error(`bad mailbox address: ${address}`);
    return join(this.root, kind, address);
  }

  holdsDir(): string {
    return join(this.root, "Holds");
  }

  // A mailbox exists once registered (Inbox folder created); send never creates one,
  // so a typo in an address fails loudly instead of mailing into the void.
  register(address: string): void {
    for (const kind of ["Inbox", "Sent", "Acks", "Archive"] as const) mkdirSync(this.dir(kind, address), { recursive: true });
  }

  isRegistered(address: string): boolean {
    return ADDRESS_RE.test(address) && existsSync(this.dir("Inbox", address));
  }
}

// --- format -----------------------------------------------------------------

function oneLine(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

export function slugify(subject: string): string {
  const s = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return s || "message";
}

export function formatDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}

export function serializeLetter(l: Letter): string {
  const lines = [
    "---",
    `id: ${l.id}`,
    `from: ${l.from}`,
    `to: ${l.to.join(",")}`,
    `subject: ${oneLine(l.subject)}`,
    `priority: ${l.priority}`,
    `date: ${l.date}`,
    `thread: ${l.thread}`,
  ];
  if (l.repo) lines.push(`repo: ${l.repo}`);
  if (l.key) lines.push(`key: ${l.key}`);
  if (l.kind) lines.push(`kind: ${l.kind}`);
  if (l.ackOf) lines.push(`ack-of: ${l.ackOf}`);
  lines.push("---", "", l.body.replace(/\s+$/, ""), "");
  return lines.join("\n");
}

const PRIORITIES: Priority[] = ["low", "normal", "high", "urgent"];

export function parseLetter(text: string): Letter {
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) throw new Error("letter has no header");
  const h: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const req of ["id", "from", "to", "subject", "date"]) {
    if (!h[req]) throw new Error(`letter header misses ${req}`);
  }
  const priority = PRIORITIES.includes(h.priority as Priority) ? (h.priority as Priority) : "normal";
  const kind = h.kind === "ack" || h.kind === "auto-ack" ? h.kind : undefined;
  return {
    id: h.id,
    from: h.from,
    to: h.to.split(",").map((s) => s.trim()).filter(Boolean),
    subject: h.subject,
    priority,
    date: h.date,
    thread: h.thread || h.id,
    repo: h.repo || undefined,
    key: h.key || undefined,
    kind,
    ackOf: h["ack-of"] || undefined,
    body: m[2].replace(/\s+$/, ""),
  };
}

// --- operations ---------------------------------------------------------------

function writeAtomic(path: string, content: string): void {
  const tmp = join(path, "..", `.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function uniqueId(spool: Spool, from: string, base: string): string {
  const sent = spool.dir("Sent", from);
  let id = base;
  for (let n = 2; existsSync(join(sent, `${id}.md`)); n++) id = `${base}-${n}`;
  return id;
}

export interface SendInput {
  from: string;
  to: string[];
  subject: string;
  body: string;
  thread?: string;
  priority?: Priority;
  repo?: string;
  key?: string;
}

// Validates everything before writing anything: addresses registered, thread/repo/key
// well-formed. Delivery is tmp-then-rename per recipient, then one copy in Sent.
export function send(spool: Spool, input: SendInput, now = new Date()): Letter {
  if (!spool.isRegistered(input.from)) throw new Error(`sender mailbox not registered: ${input.from}`);
  const to = [...new Set(input.to)];
  if (to.length === 0) throw new Error("no recipients");
  for (const addr of to) if (!spool.isRegistered(addr)) throw new Error(`unknown mailbox: ${addr}`);
  if (!input.subject.trim()) throw new Error("empty subject");
  if (input.thread && !ID_RE.test(input.thread)) throw new Error(`bad thread: ${input.thread}`);
  if (input.repo && !/^[a-z0-9-]+$/.test(input.repo)) throw new Error(`bad repo: ${input.repo}`);
  if (input.key && !/^[A-Z][A-Z0-9]+-[0-9]+$/.test(input.key)) throw new Error(`bad key: ${input.key}`);

  // Sender in the id: two senders writing the same subject in the same second must not
  // collide in a shared recipient's Inbox (the same-sender case is caught via Sent).
  const sender = input.from.split("/")[1];
  const id = uniqueId(spool, input.from, `${Math.floor(now.getTime() / 1000)}-${sender}-${slugify(input.subject)}`);
  const letter: Letter = {
    id,
    from: input.from,
    to,
    subject: oneLine(input.subject),
    priority: input.priority ?? "normal",
    date: formatDate(now),
    thread: input.thread ?? id,
    repo: input.repo,
    key: input.key,
    body: input.body,
  };
  const text = serializeLetter(letter);
  for (const addr of to) writeAtomic(join(spool.dir("Inbox", addr), `${id}.md`), text);
  writeAtomic(join(spool.dir("Sent", input.from), `${id}.md`), text);
  return letter;
}

export function readInbox(spool: Spool, address: string): Letter[] {
  const dir = spool.dir("Inbox", address);
  if (!existsSync(dir)) return [];
  const out: Letter[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    try {
      out.push(parseLetter(readFileSync(join(dir, f), "utf8")));
    } catch {
      /* a malformed file is skipped, not fatal */
    }
  }
  return out;
}

export function findInInbox(spool: Spool, address: string, id: string): Letter | undefined {
  const p = join(spool.dir("Inbox", address), `${id}.md`);
  return existsSync(p) ? parseLetter(readFileSync(p, "utf8")) : undefined;
}

export function archive(spool: Spool, address: string, id: string, now = new Date()): boolean {
  const src = join(spool.dir("Inbox", address), `${id}.md`);
  if (!existsSync(src)) return false;
  const day = formatDate(now).slice(0, 10);
  const dst = join(spool.dir("Archive", address), day);
  mkdirSync(dst, { recursive: true });
  renameSync(src, join(dst, `${id}.md`));
  return true;
}

// An ack goes to the original sender's Acks folder, never its Inbox — it can't wake a
// session. Acking an ack is refused, so two roles can't ping-pong receipts forever.
export function ack(
  spool: Spool,
  by: string,
  target: Letter,
  opts: { note?: string; auto?: boolean } = {},
  now = new Date(),
): Letter {
  if (target.kind) throw new Error("cannot ack an ack");
  if (!spool.isRegistered(target.from)) throw new Error(`unknown mailbox: ${target.from}`);
  const base = `${Math.floor(now.getTime() / 1000)}-ack-${target.id}`;
  let id = base;
  for (let n = 2; existsSync(join(spool.dir("Acks", target.from), `${id}.md`)); n++) id = `${base}-${n}`;
  const letter: Letter = {
    id,
    from: by,
    to: [target.from],
    subject: `ack: ${target.subject}`,
    priority: "normal",
    date: formatDate(now),
    thread: target.thread,
    kind: opts.auto ? "auto-ack" : "ack",
    ackOf: target.id,
    body: (opts.note ?? "").slice(0, 200),
  };
  writeAtomic(join(spool.dir("Acks", target.from), `${id}.md`), serializeLetter(letter));
  return letter;
}

function listLetters(dir: string, recursive: boolean): Letter[] {
  if (!existsSync(dir)) return [];
  const out: Letter[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) out.push(...listLetters(p, true));
    } else if (entry.name.endsWith(".md")) {
      try {
        out.push(parseLetter(readFileSync(p, "utf8")));
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

// Every letter of a thread across the whole spool (any mailbox's Inbox, Sent, Archive,
// Acks), de-duplicated by id and ordered by date.
export function thread(spool: Spool, threadId: string): Letter[] {
  const seen = new Map<string, Letter>();
  for (const kind of ["Inbox", "Sent", "Archive", "Acks"]) {
    for (const l of listLetters(join(spool.root, kind), true)) {
      if (l.thread === threadId && !seen.has(l.id)) seen.set(l.id, l);
    }
  }
  return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

// Letters a mailbox sent (Sent folder), unordered — used by the echo guard.
export function sentBy(spool: Spool, address: string): Letter[] {
  return listLetters(spool.dir("Sent", address), false);
}

// Hands a letter from one Inbox to another unchanged (pool routing). Atomic rename.
export function moveToInbox(spool: Spool, fromAddress: string, toAddress: string, id: string): boolean {
  const src = join(spool.dir("Inbox", fromAddress), `${id}.md`);
  if (!existsSync(src)) return false;
  renameSync(src, join(spool.dir("Inbox", toAddress), `${id}.md`));
  return true;
}

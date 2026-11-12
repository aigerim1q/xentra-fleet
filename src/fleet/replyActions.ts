import type { Priority } from "./mail.js";

// What a role asked for in its reply (it has no shell — see roles/_protocol.md):
//   <mail to=".." subject=".." [priority=".."] [thread="new"] [repo=".."]>body</mail>
//   <ack id=".." [note=".."]/>
//   <gates/>
//   <memory scope="thread|task" [key=".."]>text</memory>
//   <watch-ci/>          (letter from ci-watch when the thread MR's pipeline finishes)
//   <push title=".."/>   (roles with canRequestPush — asks the owner to push + open an MR)
//   <delete path=".."/>  (edit roles — removes a file or folder in the thread's worktree)
// Parsed leniently (attribute order, quotes ' or ") and validated later, by the
// supervisor, against the spool — a bad address fails that one block, not the session.

export interface MailAction {
  to: string[];
  subject: string;
  body: string;
  priority: Priority;
  newThread: boolean;
  repo?: string;
  key?: string;
}

export interface MemoryAction {
  scope: "thread" | "task";
  key?: string;
  text: string;
}

export interface ReplyActions {
  mails: MailAction[];
  acks: Array<{ id: string; note?: string }>;
  gates: boolean;
  memory: MemoryAction[];
  push?: { title: string };
  watchCi: boolean;
  deletes: string[];
}

const ATTR = /([a-z-]+)\s*=\s*("([^"]*)"|'([^']*)')/gi;
const PRIORITIES: Priority[] = ["low", "normal", "high", "urgent"];

function attrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(ATTR)) out[m[1].toLowerCase()] = (m[3] ?? m[4] ?? "").trim();
  return out;
}

// Blocks are commands only in the role's own prose. Anything quoted — fenced code, inline
// code, blockquote lines — is masked first, so a role that cites a letter containing
// `<push title=…/>` or explains the protocol with an example does not execute it. The
// mask keeps every offset (quoted chars become spaces, newlines stay): blocks are FOUND
// in the masked text but their attributes and bodies are READ from the original, so a
// letter body keeps its code identifiers and code blocks.
const QUOTED = [/```[\s\S]*?(```|$)/g, /~~~[\s\S]*?(~~~|$)/g, /`[^`\n]*`/g, /^[ \t]*>.*$/gm];

export function maskQuoted(text: string): string {
  let out = text;
  for (const re of QUOTED) out = out.replace(re, (m) => m.replace(/[^\n]/g, " "));
  return out;
}

// Kept for callers that want the role's prose only (quoted parts removed).
export function stripQuoted(text: string): string {
  let out = text;
  for (const re of QUOTED) out = out.replace(re, "");
  return out;
}

// Every match of `re` (needs the d flag) in the masked text, with its groups read from the raw text.
function* blocks(raw: string, masked: string, re: RegExp): Generator<string[]> {
  for (const m of masked.matchAll(re)) {
    const idx = (m as RegExpMatchArray & { indices: Array<[number, number] | undefined> }).indices;
    yield idx.map((r) => (r ? raw.slice(r[0], r[1]) : ""));
  }
}

export function parseReplyActions(raw: string): ReplyActions {
  const text = maskQuoted(raw);
  const mails: MailAction[] = [];
  for (const m of blocks(raw, text, /<mail\b([^>]*)>([\s\S]*?)<\/mail>/dgi)) {
    const a = attrs(m[1]);
    const to = (a.to ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (to.length === 0 || !a.subject) continue;
    mails.push({
      to,
      subject: a.subject,
      body: m[2].replace(/^\n+|\s+$/g, ""),
      priority: PRIORITIES.includes(a.priority as Priority) ? (a.priority as Priority) : "normal",
      newThread: a.thread === "new",
      repo: a.repo || undefined,
      key: a.key || undefined,
    });
  }
  const acks: Array<{ id: string; note?: string }> = [];
  for (const m of blocks(raw, text, /<ack\b([^>]*?)\/?>/dgi)) {
    const a = attrs(m[1]);
    if (a.id) acks.push({ id: a.id, note: a.note || undefined });
  }
  const memory: MemoryAction[] = [];
  for (const m of blocks(raw, text, /<memory\b([^>]*)>([\s\S]*?)<\/memory>/dgi)) {
    const a = attrs(m[1]);
    const body = m[2].trim();
    if (!body) continue;
    memory.push({ scope: a.scope === "task" ? "task" : "thread", key: a.key || undefined, text: body });
  }
  const pushTag = blocks(raw, text, /<push\b([^>]*?)\/?>/dgi).next().value;
  const pushTitle = pushTag ? attrs(pushTag[1]).title : undefined;
  const deletes: string[] = [];
  for (const m of blocks(raw, text, /<delete\b([^>]*?)\/?>/dgi)) {
    const path = attrs(m[1]).path;
    if (path && !deletes.includes(path)) deletes.push(path);
  }
  return { mails, acks, deletes, gates: /<gates\s*\/?>/i.test(text), memory, watchCi: /<watch-ci\s*\/?>/i.test(text), ...(pushTitle ? { push: { title: pushTitle } } : {}) };
}

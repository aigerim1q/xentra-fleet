import type { Priority } from "./mail.js";

// What a role asked for in its reply (it has no shell — see roles/_protocol.md):
//   <mail to=".." subject=".." [priority=".."] [thread="new"] [repo=".."]>body</mail>
//   <ack id=".." [note=".."]/>
//   <gates/>
// Parsed leniently (attribute order, quotes ' or ") and validated later, by the
// supervisor, against the spool — a bad address fails that one block, not the session.

export interface MailAction {
  to: string[];
  subject: string;
  body: string;
  priority: Priority;
  newThread: boolean;
  repo?: string;
}

export interface ReplyActions {
  mails: MailAction[];
  acks: Array<{ id: string; note?: string }>;
  gates: boolean;
}

const ATTR = /([a-z-]+)\s*=\s*("([^"]*)"|'([^']*)')/gi;
const PRIORITIES: Priority[] = ["low", "normal", "high", "urgent"];

function attrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(ATTR)) out[m[1].toLowerCase()] = (m[3] ?? m[4] ?? "").trim();
  return out;
}

export function parseReplyActions(text: string): ReplyActions {
  const mails: MailAction[] = [];
  for (const m of text.matchAll(/<mail\b([^>]*)>([\s\S]*?)<\/mail>/gi)) {
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
    });
  }
  const acks: Array<{ id: string; note?: string }> = [];
  for (const m of text.matchAll(/<ack\b([^>]*?)\/?>/gi)) {
    const a = attrs(m[1]);
    if (a.id) acks.push({ id: a.id, note: a.note || undefined });
  }
  return { mails, acks, gates: /<gates\s*\/?>/i.test(text) };
}

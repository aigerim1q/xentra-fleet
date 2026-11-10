import type { Priority } from "./mail.js";

// What a role asked for in its reply (it has no shell — see roles/_protocol.md):
//   <mail to=".." subject=".." [priority=".."] [thread="new"] [repo=".."]>body</mail>
//   <ack id=".." [note=".."]/>
//   <gates/>
//   <memory scope="thread|task" [key=".."]>text</memory>
//   <watch-ci/>          (letter from ci-watch when the thread MR's pipeline finishes)
//   <push title=".."/>   (roles with canRequestPush — asks the owner to push + open an MR)
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
      key: a.key || undefined,
    });
  }
  const acks: Array<{ id: string; note?: string }> = [];
  for (const m of text.matchAll(/<ack\b([^>]*?)\/?>/gi)) {
    const a = attrs(m[1]);
    if (a.id) acks.push({ id: a.id, note: a.note || undefined });
  }
  const memory: MemoryAction[] = [];
  for (const m of text.matchAll(/<memory\b([^>]*)>([\s\S]*?)<\/memory>/gi)) {
    const a = attrs(m[1]);
    const body = m[2].trim();
    if (!body) continue;
    memory.push({ scope: a.scope === "task" ? "task" : "thread", key: a.key || undefined, text: body });
  }
  const pushTag = /<push\b([^>]*?)\/?>/i.exec(text);
  const pushTitle = pushTag ? attrs(pushTag[1]).title : undefined;
  return { mails, acks, gates: /<gates\s*\/?>/i.test(text), memory, watchCi: /<watch-ci\s*\/?>/i.test(text), ...(pushTitle ? { push: { title: pushTitle } } : {}) };
}

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listHolds } from "./loopGuard.js";
import { type Letter, type Spool, parseLetter, readInbox } from "./mail.js";
import { listPushes } from "./pushRequests.js";
import type { Role } from "./roles.js";

// The owner's standing conversation with pm — "Зам. CTO" in Telegram. One permanent
// thread, so pm's session for it is resumed every time and remembers past talks (plus
// the thread memory). In this thread pm also gets a snapshot of the whole fleet, since
// its usual prompt only shows one thread.

export const DEPUTY_THREAD = "deputy";

const letterTime = (l: Letter) => {
  const ts = Number(l.id.split("-")[0]);
  return Number.isFinite(ts) ? ts * 1000 : Date.parse(l.date);
};

function allSent(spool: Spool): Letter[] {
  const root = join(spool.root, "Sent");
  if (!existsSync(root)) return [];
  const out: Letter[] = [];
  for (const g of readdirSync(root)) {
    for (const p of readdirSync(join(root, g))) {
      const dir = join(root, g, p);
      for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
        try {
          out.push(parseLetter(readFileSync(join(dir, f), "utf8")));
        } catch {
          /* skip */
        }
      }
    }
  }
  return out;
}

export function fleetSnapshot(spool: Spool, stateDir: string, roles: Role[], now = Date.now()): string {
  const lines: string[] = ["## Состояние флота (снимок для тебя как Зам. CTO)"];

  const running = existsSync(stateDir)
    ? readdirSync(stateDir)
        .filter((f) => f.startsWith("running."))
        .map((f) => {
          try {
            return `${f.slice(8)} — тред ${JSON.parse(readFileSync(join(stateDir, f), "utf8")).thread}`;
          } catch {
            return f.slice(8);
          }
        })
    : [];
  lines.push(`Сейчас работают: ${running.length ? running.join("; ") : "никто"}`);

  const queues = roles.map((r) => [r.role, readInbox(spool, r.mail).filter((l) => !l.kind).length] as const).filter(([, n]) => n > 0);
  lines.push(`Очереди: ${queues.length ? queues.map(([r, n]) => `${r} ${n}`).join(", ") : "пусто"}`);

  const holds = listHolds(spool);
  if (holds.length) lines.push(`Остановлены защитой от зацикливания: ${holds.join(", ")}`);
  const pending = listPushes(stateDir).filter((p) => p.status === "pending");
  if (pending.length) lines.push(`Ждут решения владельца по push: ${pending.map((p) => `${p.thread} («${p.title}»)`).join(", ")}`);
  const mrs = listPushes(stateDir).filter((p) => p.status === "pushed" && p.mr);
  if (mrs.length) lines.push(`Открытые MR флота: ${mrs.map((p) => `!${p.mr!.iid} (${p.thread})`).join(", ")}`);

  // Latest letter per thread over the last week, newest first.
  const week = now - 7 * 86_400_000;
  const last = new Map<string, Letter>();
  for (const l of allSent(spool)) {
    if (l.kind || l.thread === DEPUTY_THREAD || letterTime(l) < week) continue;
    const prev = last.get(l.thread);
    if (!prev || letterTime(prev) < letterTime(l)) last.set(l.thread, l);
  }
  const threads = [...last.values()].sort((a, b) => letterTime(b) - letterTime(a)).slice(0, 15);
  lines.push("", "Треды за неделю (последнее письмо):");
  if (threads.length === 0) lines.push("- (нет)");
  for (const l of threads) {
    lines.push(`- ${l.thread}${l.key ? ` [${l.key}]` : ""}: ${l.date.slice(0, 16).replace("T", " ")} ${l.from} → ${l.to.join(",")} «${l.subject}»`);
  }
  return lines.join("\n");
}

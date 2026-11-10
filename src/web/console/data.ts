import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatEvent, listJournals, sessionInfo } from "../../engine/sessionView.js";
import { DEPUTY_THREAD } from "../../fleet/deputy.js";
import type { FleetLimits } from "../../fleet/limits.js";
import { listHolds } from "../../fleet/loopGuard.js";
import { type Letter, type Spool, parseLetter, readInbox, thread as threadLetters } from "../../fleet/mail.js";
import { loadVerdicts } from "../../fleet/mergeBot.js";
import { readMemory } from "../../fleet/memory.js";
import { computeMetrics } from "../../fleet/metrics.js";
import { fleetAlive, roleName, threadTitle } from "../../fleet/names.js";
import { listPushes, loadPush } from "../../fleet/pushRequests.js";
import { OWNER_ADDRESS, type Role } from "../../fleet/roles.js";
import { FLEET_ADDRESS } from "../../fleet/supervisor.js";
import { WATCHER_ADDRESSES } from "../../fleet/watchers.js";

// Everything the web console shows, computed from the fleet's own files — the same
// sources the supervisor and the Telegram bridge use. Pure reads; no secrets here
// (letters and journals are already masked when written).

export interface ConsoleCtx {
  spool: Spool;
  stateDir: string; // ~/.xentra-fleet/state
  harnessDir: string; // .harness-state of the pipeline bot
  roles: Role[];
  limits: FleetLimits;
  now?: number;
}

const letterTime = (l: Letter) => {
  const ts = Number(l.id.split("-")[0]);
  return Number.isFinite(ts) ? ts * 1000 : Date.parse(l.date);
};

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function allSent(spool: Spool): Letter[] {
  const root = join(spool.root, "Sent");
  if (!existsSync(root)) return [];
  const out: Letter[] = [];
  for (const g of readdirSync(root)) {
    for (const p of readdirSync(join(root, g))) {
      const dir = join(root, g, p);
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
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

// ── Роли ─────────────────────────────────────────────────────────────────────────────
export interface RoleRow {
  role: string;
  name: string;
  model: string;
  engine: string;
  access: string;
  state: "работает" | "свободна" | "пауза";
  inbox: number;
  current?: { thread: string; title: string; startedAt: string };
  sessionsToday: number;
  costToday: number;
}

export function rolesView(ctx: ConsoleCtx): RoleRow[] {
  const now = ctx.now ?? Date.now();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const sessions = readSessions(ctx.stateDir).filter((s) => Date.parse(s.at) >= dayStart.getTime());
  const paused = new Set(ctx.limits.pausedRoles());
  const fleetPaused = ctx.limits.isFleetPaused();
  return ctx.roles.map((r) => {
    const running = readJson<{ thread: string; startedAt: string }>(join(ctx.stateDir, `running.${r.role}`));
    const mine = sessions.filter((s) => s.role === r.role);
    return {
      role: r.role,
      name: roleName(r.role),
      model: r.model,
      engine: r.engine,
      access: r.access === "edit" ? "правка" : "чтение",
      state: running ? "работает" : fleetPaused || paused.has(r.role) ? "пауза" : "свободна",
      inbox: readInbox(ctx.spool, r.mail).filter((l) => !l.kind).length,
      current: running ? { thread: running.thread, title: threadTitle(ctx.spool, running.thread), startedAt: running.startedAt } : undefined,
      sessionsToday: mine.length,
      costToday: mine.reduce((a, s) => a + (s.costUsd || 0), 0),
    };
  });
}

interface SessionRecord {
  at: string;
  role: string;
  model: string;
  thread: string;
  durationMs: number;
  costUsd: number;
  ok: boolean;
}

function readSessions(stateDir: string): SessionRecord[] {
  const p = join(stateDir, "sessions.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as SessionRecord];
      } catch {
        return [];
      }
    });
}

// ── Лимиты ───────────────────────────────────────────────────────────────────────────
export function limitsView(ctx: ConsoleCtx, bot: { todayUsd: number; dailyBudgetUsd: number }) {
  const ledger = ctx.limits.ledger();
  const caps = ctx.limits.caps();
  return {
    teamAlive: fleetAlive(ctx.stateDir),
    paused: ctx.limits.isFleetPaused(),
    pausedRoles: ctx.limits.pausedRoles(),
    override: ctx.limits.hasOverride(),
    claude: { sessions: ledger.claude.sessions, capSessions: caps.claudeSessions, costUsd: ledger.claude.costUsd, capUsd: caps.claudeUsd },
    codex: { sessions: ledger.codex.sessions, capSessions: caps.codexSessions },
    bot,
  };
}

// ── Ждёт тебя ────────────────────────────────────────────────────────────────────────
export interface PendingConveyor {
  kind: "approval" | "humanReview" | "brief";
  issueKey: string;
  title: string;
}

export function decisionsView(ctx: ConsoleCtx, conveyor: PendingConveyor[]) {
  const t = (thread: string) => threadTitle(ctx.spool, thread);
  const letters = readInbox(ctx.spool, OWNER_ADDRESS)
    .filter((l) => !l.kind && l.thread !== DEPUTY_THREAD)
    .map((l) => ({ id: l.id, from: l.from, fromName: roleName(l.from), thread: l.thread, title: t(l.thread), subject: l.subject, body: l.body, date: l.date, priority: l.priority }));
  const pushes = listPushes(ctx.stateDir)
    .filter((p) => p.status === "pending")
    .map((p) => ({ thread: p.thread, title: t(p.thread), branch: p.branch, repo: p.repo, requestedBy: roleName(p.requestedBy), requestedAt: p.requestedAt, pushTitle: p.title, hasMr: !!p.mr }));
  const mergeReady = listPushes(ctx.stateDir)
    .filter((p) => p.status === "pushed" && p.mr && existsSync(join(ctx.stateDir, "merge-announced", p.thread.replace(/[^A-Za-z0-9_-]/g, "_"))))
    .map((p) => ({ thread: p.thread, title: t(p.thread), mr: p.mr! }));
  const holds = listHolds(ctx.spool).map((thread) => ({ thread, title: t(thread) }));
  return { letters, pushes, mergeReady, holds, conveyor };
}

// ── Задачи (треды) ───────────────────────────────────────────────────────────────────
export interface TaskRow {
  thread: string;
  title: string;
  key?: string;
  startedAt: string;
  lastAt: string;
  last: { from: string; to: string; subject: string };
  letters: number;
  working: string[];
  waitingOwner: boolean;
  push?: { status: string; mr?: { iid: number; webUrl: string } };
  held: boolean;
}

export function tasksView(ctx: ConsoleCtx, days = 14): TaskRow[] {
  const since = (ctx.now ?? Date.now()) - days * 86_400_000;
  const byThread = new Map<string, Letter[]>();
  for (const l of allSent(ctx.spool)) {
    if (l.kind || l.thread === DEPUTY_THREAD) continue;
    byThread.set(l.thread, [...(byThread.get(l.thread) ?? []), l]);
  }
  const running = existsSync(ctx.stateDir)
    ? readdirSync(ctx.stateDir)
        .filter((f) => f.startsWith("running."))
        .map((f) => ({ role: f.slice(8), thread: readJson<{ thread: string }>(join(ctx.stateDir, f))?.thread }))
    : [];
  const ownerInbox = new Set(readInbox(ctx.spool, OWNER_ADDRESS).filter((l) => !l.kind).map((l) => l.thread));
  const holds = new Set(listHolds(ctx.spool));
  const rows: TaskRow[] = [];
  for (const [thread, ls] of byThread) {
    const sorted = ls.sort((a, b) => letterTime(a) - letterTime(b));
    const last = sorted[sorted.length - 1];
    if (letterTime(last) < since) continue;
    const p = loadPush(ctx.stateDir, thread);
    rows.push({
      thread,
      title: threadTitle(ctx.spool, thread),
      key: sorted.find((l) => l.key)?.key,
      startedAt: new Date(letterTime(sorted[0])).toISOString(),
      lastAt: new Date(letterTime(last)).toISOString(),
      last: { from: roleName(last.from), to: last.to.map(roleName).join(", "), subject: last.subject },
      letters: sorted.length,
      working: running.filter((r) => r.thread === thread).map((r) => roleName(r.role)),
      waitingOwner: ownerInbox.has(thread),
      push: p ? { status: p.status, mr: p.mr } : undefined,
      held: holds.has(thread),
    });
  }
  return rows.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

export function threadDetail(ctx: ConsoleCtx, thread: string) {
  const letters = threadLetters(ctx.spool, thread)
    .filter((l) => !l.kind)
    .map((l) => ({ id: l.id, from: roleName(l.from), to: l.to.map(roleName).join(", "), date: l.date, subject: l.subject, body: l.body, priority: l.priority }));
  const keys = [...new Set(threadLetters(ctx.spool, thread).map((l) => l.key).filter((k): k is string => !!k))];
  return {
    thread,
    title: threadTitle(ctx.spool, thread),
    letters,
    memory: readMemory(ctx.stateDir, "thread", thread),
    taskMemory: keys.map((k) => ({ key: k, text: readMemory(ctx.stateDir, "task", k) })),
    push: loadPush(ctx.stateDir, thread),
    verdicts: Object.values(loadVerdicts(ctx.stateDir, thread)).map((v) => ({ ...v, role: roleName(v.role) })),
  };
}

// ── Сессии ───────────────────────────────────────────────────────────────────────────
// Session ids are base64url of the journal path; a request is served only when the path
// resolves to one of the journals actually listed (no arbitrary file reads).
const encodeId = (p: string) => Buffer.from(p).toString("base64url");

export function sessionsView(ctx: ConsoleCtx, limit = 40) {
  return listJournals([ctx.harnessDir, ctx.stateDir])
    .slice(-limit)
    .reverse()
    .map((j) => {
      const info = sessionInfo(j.path);
      return {
        id: encodeId(j.path),
        role: roleName(j.label),
        title: j.task.startsWith("fleet-") ? threadTitle(ctx.spool, j.task.slice(6)) : j.task,
        at: new Date(j.mtimeMs).toISOString(),
        model: info.model,
        open: info.sessionId && info.cwd ? `cd ${info.cwd} && claude --resume ${info.sessionId} --fork-session` : undefined,
      };
    });
}

export function sessionTail(ctx: ConsoleCtx, id: string, fromLine = 0): { lines: string[]; next: number } | undefined {
  let path: string;
  try {
    path = resolve(Buffer.from(id, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const j = listJournals([ctx.harnessDir, ctx.stateDir]).find((x) => resolve(x.path) === path);
  if (!j) return undefined;
  const raw = readFileSync(j.path, "utf8");
  const complete = raw.slice(0, raw.lastIndexOf("\n") + 1).split("\n").filter(Boolean);
  const lines = complete.slice(fromLine).flatMap((l) => formatEvent(l, { textChars: 600 }));
  return { lines, next: complete.length };
}

// ── Аналитика ────────────────────────────────────────────────────────────────────────
export const BUCKETS: Array<{ label: string; maxMin: number }> = [
  { label: "0–5 мин", maxMin: 5 },
  { label: "5–15 мин", maxMin: 15 },
  { label: "15–30 мин", maxMin: 30 },
  { label: "30–60 мин", maxMin: 60 },
  { label: "1–2 ч", maxMin: 120 },
  { label: "2–4 ч", maxMin: 240 },
  { label: ">4 ч", maxMin: Infinity },
];

export function distribution(minutes: number[]) {
  const sorted = [...minutes].sort((a, b) => a - b);
  const pick = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : undefined);
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : undefined;
  return {
    count: sorted.length,
    median,
    mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : undefined,
    p90: pick(0.9),
    max: sorted.at(-1),
    buckets: BUCKETS.map((b, i) => ({
      label: b.label,
      n: sorted.filter((m) => m >= (i === 0 ? 0 : BUCKETS[i - 1].maxMin) && m < b.maxMin).length,
    })),
  };
}

export function analyticsView(ctx: ConsoleCtx, days = 14) {
  const since = (ctx.now ?? Date.now()) - days * 86_400_000;
  const sent = allSent(ctx.spool).filter((l) => !l.kind);
  const ownerSent = sent.filter((l) => l.from === OWNER_ADDRESS);
  const roleMails = new Set(ctx.roles.map((r) => r.mail));

  // (a) a role's question to the owner -> the owner's next letter in that thread
  const answers: number[] = [];
  let unanswered = 0;
  for (const q of sent) {
    if (!roleMails.has(q.from) || !q.to.includes(OWNER_ADDRESS) || q.thread === DEPUTY_THREAD) continue;
    const t = letterTime(q);
    if (t < since) continue;
    const reply = ownerSent.filter((o) => o.thread === q.thread && letterTime(o) > t).sort((a, b) => letterTime(a) - letterTime(b))[0];
    if (reply) answers.push((letterTime(reply) - t) / 60000);
    else unanswered++;
  }

  // (b) push request -> the owner's decision
  const pushes = listPushes(ctx.stateDir).filter((p) => p.decidedAt && Date.parse(p.requestedAt) >= since);
  const pushDecisions = pushes.map((p) => (Date.parse(p.decidedAt!) - Date.parse(p.requestedAt)) / 60000);

  const metrics = computeMetrics(ctx.spool, ctx.stateDir, ctx.roles, since);
  const timeToMr = metrics.threads.map((t) => t.timeToMrMin).filter((x): x is number => x !== undefined);

  const notices = sent.filter((l) => [FLEET_ADDRESS, ...WATCHER_ADDRESSES].includes(l.from) && letterTime(l) >= since).length;
  return {
    days,
    ownerReply: { ...distribution(answers), unanswered },
    pushDecision: distribution(pushDecisions),
    timeToMr: distribution(timeToMr),
    returnsPerThread: metrics.returnsPerThread,
    sessions: metrics.sessions,
    costUsd: metrics.costUsd,
    byRoleModel: metrics.byRoleModel.map((r) => ({ ...r, name: roleName(r.role) })),
    owner: metrics.owner,
    notices,
  };
}

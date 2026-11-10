import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewResponse } from "../engine/review.js";
import { type Letter, type Spool, sentBy, thread as threadLetters } from "./mail.js";
import { listPushes } from "./pushRequests.js";
import { OWNER_ADDRESS, type Role } from "./roles.js";
import { CI_WATCH_ADDRESS } from "./watchers.js";

// Fleet metrics over a window, computed from what the fleet already keeps:
// - state/sessions.jsonl — one line per session (supervisor);
// - the spool — letters per thread, the owner's own letters;
// - state/push/*.json — when a thread first reached an MR.
// Model comparison falls out of the per-(role, model) table: the same role on two models
// over the same kind of work, compared on success rate, cost and duration.

export interface SessionRecord {
  at: string;
  role: string;
  engine: string;
  model: string;
  thread: string;
  letters: number;
  durationMs: number;
  costUsd: number;
  ok: boolean;
  error?: string;
}

export interface RoleModelStats {
  role: string;
  model: string;
  sessions: number;
  okRate: number;
  costUsd: number;
  avgCostUsd: number;
  avgDurationMin: number;
}

export interface ThreadStats {
  thread: string;
  startedAt: string;
  timeToMrMin?: number;
  auditReturns: number; // auditor letters with blocking findings
  ciFailures: number; // ci-watch letters reporting a red pipeline
  sessions: number;
  costUsd: number;
}

export interface FleetMetrics {
  sinceIso: string;
  sessions: number;
  costUsd: number;
  byRoleModel: RoleModelStats[];
  threads: ThreadStats[];
  medianTimeToMrMin?: number;
  returnsPerThread: number;
  owner: { lettersReceived: number; lettersWritten: number; pushDecisions: number };
}

export function readSessions(stateDir: string): SessionRecord[] {
  const p = join(stateDir, "sessions.jsonl");
  if (!existsSync(p)) return [];
  const out: SessionRecord[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const letterTime = (l: Letter) => {
  const ts = Number(l.id.split("-")[0]);
  return Number.isFinite(ts) ? ts * 1000 : Date.parse(l.date);
};

export function computeMetrics(spool: Spool, stateDir: string, roles: Role[], sinceMs: number): FleetMetrics {
  const sessions = readSessions(stateDir).filter((s) => Date.parse(s.at) >= sinceMs);

  const groups = new Map<string, SessionRecord[]>();
  for (const s of sessions) {
    const k = `${s.role}\u0000${s.model}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  const byRoleModel: RoleModelStats[] = [...groups.values()]
    .map((g) => {
      const cost = g.reduce((a, s) => a + s.costUsd, 0);
      return {
        role: g[0].role,
        model: g[0].model,
        sessions: g.length,
        okRate: g.filter((s) => s.ok).length / g.length,
        costUsd: cost,
        avgCostUsd: cost / g.length,
        avgDurationMin: g.reduce((a, s) => a + s.durationMs, 0) / g.length / 60000,
      };
    })
    .sort((a, b) => a.role.localeCompare(b.role) || a.model.localeCompare(b.model));

  // Threads the owner started in the window.
  const ownerSent = sentBy(spool, OWNER_ADDRESS);
  const started = new Map<string, number>();
  for (const l of ownerSent) {
    if (l.thread !== l.id) continue; // a reply, not a thread start
    const t = letterTime(l);
    if (t >= sinceMs) started.set(l.thread, t);
  }
  const pushes = new Map(listPushes(stateDir).map((p) => [p.thread, p]));
  const auditors = new Set(roles.filter((r) => r.isAuditor).map((r) => r.mail));
  const threads: ThreadStats[] = [...started.entries()].map(([thread, t0]) => {
    const letters = threadLetters(spool, thread).filter((l) => !l.kind);
    const auditReturns = letters.filter((l) => auditors.has(l.from) && parseReviewResponse(l.body).some((f) => f.blocking)).length;
    const ciFailures = letters.filter((l) => l.from === CI_WATCH_ADDRESS && /failed/.test(l.subject)).length;
    const ts = sessions.filter((s) => s.thread === thread);
    const firstPush = pushes.get(thread)?.firstPushedAt;
    return {
      thread,
      startedAt: new Date(t0).toISOString(),
      timeToMrMin: firstPush ? (Date.parse(firstPush) - t0) / 60000 : undefined,
      auditReturns,
      ciFailures,
      sessions: ts.length,
      costUsd: ts.reduce((a, s) => a + s.costUsd, 0),
    };
  });

  const toOwner = (() => {
    let n = 0;
    for (const role of [...roles.map((r) => r.mail), "xentra/fleet", CI_WATCH_ADDRESS, "xentra/jira-watch"]) {
      n += sentBy(spool, role).filter((l) => l.to.includes(OWNER_ADDRESS) && !l.kind && letterTime(l) >= sinceMs).length;
    }
    return n;
  })();

  return {
    sinceIso: new Date(sinceMs).toISOString(),
    sessions: sessions.length,
    costUsd: sessions.reduce((a, s) => a + s.costUsd, 0),
    byRoleModel,
    threads,
    medianTimeToMrMin: median(threads.map((t) => t.timeToMrMin).filter((x): x is number => x !== undefined)),
    returnsPerThread: threads.length ? threads.reduce((a, t) => a + t.auditReturns + t.ciFailures, 0) / threads.length : 0,
    owner: {
      lettersReceived: toOwner,
      lettersWritten: ownerSent.filter((l) => letterTime(l) >= sinceMs).length,
      pushDecisions: [...pushes.values()].filter((p) => p.decidedAt && Date.parse(p.decidedAt) >= sinceMs).length,
    },
  };
}

export function formatMetrics(m: FleetMetrics): string {
  const fmtMin = (x?: number) => (x === undefined ? "—" : x < 120 ? `${Math.round(x)} мин` : `${(x / 60).toFixed(1)} ч`);
  const lines = [
    `Флот с ${m.sinceIso.slice(0, 10)}: ${m.sessions} сессий, ~$${m.costUsd.toFixed(2)} (оценка Claude по токенам; Codex — по подписке)`,
    `Тредов начато: ${m.threads.length}; до MR (медиана): ${fmtMin(m.medianTimeToMrMin)}; возвратов на тред: ${m.returnsPerThread.toFixed(1)}`,
    `Внимание владельца: получено ${m.owner.lettersReceived} писем, написано ${m.owner.lettersWritten}, решений по push ${m.owner.pushDecisions}`,
  ];
  if (m.byRoleModel.length) {
    lines.push("", "Роль / модель: сессий, успех, $ всего (средн.), мин в среднем");
    for (const r of m.byRoleModel) {
      lines.push(
        `- ${r.role} / ${r.model}: ${r.sessions}, ${Math.round(r.okRate * 100)}%, $${r.costUsd.toFixed(2)} ($${r.avgCostUsd.toFixed(2)}), ${r.avgDurationMin.toFixed(1)}`,
      );
    }
  }
  const recent = [...m.threads].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 8);
  if (recent.length) {
    lines.push("", "Последние треды: до MR, возвраты (аудит/CI), сессий, $");
    for (const t of recent) {
      lines.push(`- ${t.thread}: ${fmtMin(t.timeToMrMin)}, ${t.auditReturns}/${t.ciFailures}, ${t.sessions}, $${t.costUsd.toFixed(2)}`);
    }
  }
  return lines.join("\n");
}

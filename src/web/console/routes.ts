import { existsSync, watch, type FSWatcher } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { HARNESS_STATE_DIR, getLiveState } from "../../bot/liveState.js";
import { config } from "../../config.js";
import { loadState, costSince, startOfTodayIso } from "../../bot/state.js";
import { FleetLimits } from "../../fleet/limits.js";
import { requestKill } from "../../fleet/lock.js";
import { releaseHold } from "../../fleet/loopGuard.js";
import { Spool, archive, findInInbox, send } from "../../fleet/mail.js";
import { checkReadiness } from "../../fleet/mergeBot.js";
import { approvePush, declinePush, loadPush } from "../../fleet/pushRequests.js";
import { OWNER_ADDRESS, loadRoles, poolAddresses } from "../../fleet/roles.js";
import { FLEET_ADDRESS } from "../../fleet/supervisor.js";
import { realMergeDeps, realPushDeps, replyTarget } from "../../fleet/telegramBridge.js";
import { WATCHER_ADDRESSES } from "../../fleet/watchers.js";
import { fleetHome } from "../../fleet/workspace.js";
import { CONSOLE_CSS, CONSOLE_HTML, CONSOLE_JS } from "./assets.js";
import {
  type ConsoleCtx,
  type PendingConveyor,
  analyticsView,
  decisionsView,
  limitsView,
  rolesView,
  sessionTail,
  sessionsView,
  tasksView,
  threadDetail,
} from "./data.js";

// The web console (/console): the CTO-fleet style dashboard for this fleet. Same safety
// as the rest of the dashboard: loopback only, Host-checked by the caller, and every
// state-changing call needs the page's token. Live data: one SSE stream — a snapshot on
// connect, then only the channels that changed (on file events, and every few seconds
// for the bot's in-memory state).

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'";

function makeCtx(): ConsoleCtx {
  const stateDir = join(fleetHome(), "state");
  const spool = new Spool();
  const roles = loadRoles();
  for (const a of [OWNER_ADDRESS, FLEET_ADDRESS, ...WATCHER_ADDRESSES, ...roles.map((r) => r.mail), ...poolAddresses(roles).keys()]) spool.register(a);
  return { spool, stateDir, harnessDir: HARNESS_STATE_DIR, roles, limits: new FleetLimits(stateDir) };
}

function conveyorPending(): PendingConveyor[] {
  const live = getLiveState();
  const out: PendingConveyor[] = [];
  if (live.pendingApproval) out.push({ kind: "approval", issueKey: live.pendingApproval.issueKey, title: live.pendingApproval.title });
  if (live.pendingHumanReview) out.push({ kind: "humanReview", issueKey: live.pendingHumanReview.issueKey, title: live.pendingHumanReview.title });
  if (live.pendingBrief) out.push({ kind: "brief", issueKey: live.pendingBrief.issueKey, title: live.pendingBrief.title });
  return out;
}

export function snapshot(ctx: ConsoleCtx): Record<string, unknown> {
  const live = getLiveState();
  const persisted = loadState();
  return {
    bot: {
      running: live.botRunning,
      job: live.currentJob
        ? { issueKey: live.currentJob.issueKey, title: live.currentJob.title, phase: live.currentJob.phase, iteration: live.currentJob.iteration, maxIterations: live.currentJob.maxIterations, startedAt: live.currentJob.startedAt, costUsd: live.currentJob.costUsd }
        : null,
    },
    roles: rolesView(ctx),
    limits: limitsView(ctx, { todayUsd: costSince(persisted, startOfTodayIso()), dailyBudgetUsd: config.dailyBudgetUsd }),
    decisions: decisionsView(ctx, conveyorPending()),
    tasks: tasksView(ctx),
  };
}

// ── live stream ──
const clients = new Set<ServerResponse>();
let lastSent: Record<string, string> = {};
let watchers: FSWatcher[] = [];
let timer: NodeJS.Timeout | undefined;
let debounce: NodeJS.Timeout | undefined;

function broadcast(force = false): void {
  if (clients.size === 0) return;
  let snap: Record<string, unknown>;
  try {
    snap = snapshot(makeCtx());
  } catch (err) {
    console.error("[console] snapshot failed:", (err as Error).message);
    return;
  }
  for (const [channel, data] of Object.entries(snap)) {
    const json = JSON.stringify(data);
    if (!force && lastSent[channel] === json) continue;
    lastSent[channel] = json;
    for (const c of clients) c.write(`event: delta\ndata: ${JSON.stringify({ channel, data })}\n\n`);
  }
}

function ensureWatching(): void {
  if (timer) return;
  const kick = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => broadcast(), 300);
  };
  for (const dir of [new Spool().root, join(fleetHome(), "state"), HARNESS_STATE_DIR]) {
    try {
      watchers.push(watch(dir, { recursive: true }, kick));
    } catch {
      /* not there yet — the timer still covers it */
    }
  }
  timer = setInterval(() => broadcast(), 3000);
}

function stopWatchingIfIdle(): void {
  if (clients.size > 0) return;
  clearInterval(timer);
  timer = undefined;
  for (const w of watchers) w.close();
  watchers = [];
  lastSent = {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw new Error("body too large");
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

// Returns true when the request was a console route (handled), false to fall through.
export function handleConsole(req: IncomingMessage, res: ServerResponse, opts: { token: string; hasValidToken: (req: IncomingMessage) => boolean }): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/console" || path === "/console/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP, "Cache-Control": "no-store" });
    res.end(CONSOLE_HTML.replace("__CONSOLE_TOKEN__", opts.token));
    return true;
  }
  if (path === "/console/app.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Content-Security-Policy": CSP });
    res.end(CONSOLE_JS);
    return true;
  }
  if (path === "/console/app.css") {
    res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
    res.end(CONSOLE_CSS);
    return true;
  }
  if (!path.startsWith("/api/console/")) return false;

  if (path === "/api/console/events" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    clients.add(res);
    ensureWatching();
    try {
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot(makeCtx()))}\n\n`);
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
    }
    const hb = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(hb);
      clients.delete(res);
      stopWatchingIfIdle();
    });
    return true;
  }

  if (req.method === "GET") {
    const ctx = makeCtx();
    if (path === "/api/console/thread") return void sendJson(res, 200, threadDetail(ctx, str(url.searchParams.get("t")))), true;
    if (path === "/api/console/sessions") return void sendJson(res, 200, sessionsView(ctx)), true;
    if (path === "/api/console/session") {
      const tail = sessionTail(ctx, str(url.searchParams.get("id")), Number(url.searchParams.get("from") ?? 0) || 0);
      return void (tail ? sendJson(res, 200, tail) : sendJson(res, 404, { error: "no such session" })), true;
    }
    if (path === "/api/console/analytics") return void sendJson(res, 200, analyticsView(ctx, Number(url.searchParams.get("days") ?? 14) || 14)), true;
    sendJson(res, 404, { error: "not found" });
    return true;
  }

  if (req.method !== "POST") return void sendJson(res, 405, { error: "method not allowed" }), true;
  if (!opts.hasValidToken(req)) return void sendJson(res, 403, { error: "missing or invalid token" }), true;

  void (async () => {
    try {
      const body = await readBody(req);
      const ctx = makeCtx();
      const stateDir = ctx.stateDir;
      const notify = (thread: string, to: string, subject: string, text: string) => {
        try {
          send(ctx.spool, { from: FLEET_ADDRESS, to: [to], subject, body: text, thread });
        } catch {
          /* best-effort */
        }
      };
      switch (path) {
        case "/api/console/pause":
          ctx.limits.pause(str(body.role) || undefined);
          break;
        case "/api/console/resume":
          ctx.limits.resume(str(body.role) || undefined);
          break;
        case "/api/console/override":
          ctx.limits.overrideToday();
          break;
        case "/api/console/release":
          releaseHold(ctx.spool, str(body.thread));
          break;
        case "/api/console/kill": {
          const role = str(body.role);
          if (!ctx.roles.some((r) => r.role === role)) throw new Error("нет такой роли");
          if (!existsSync(join(stateDir, `running.${role}`))) throw new Error("эта роль сейчас ничего не делает");
          requestKill(stateDir, role, "console");
          break;
        }
        case "/api/console/read":
          archive(ctx.spool, OWNER_ADDRESS, str(body.letterId));
          break;
        case "/api/console/reply": {
          const letter = findInInbox(ctx.spool, OWNER_ADDRESS, str(body.letterId));
          const text = str(body.text).trim();
          if (!letter || !text) throw new Error("нет такого письма или пустой ответ");
          send(ctx.spool, {
            from: OWNER_ADDRESS,
            to: [replyTarget(letter.from)],
            subject: letter.subject.startsWith("Re:") ? letter.subject : `Re: ${letter.subject}`,
            body: text,
            thread: letter.thread,
            repo: letter.repo,
          });
          archive(ctx.spool, OWNER_ADDRESS, letter.id);
          break;
        }
        case "/api/console/push": {
          const thread = str(body.thread);
          if (body.decision === "decline") {
            const r = declinePush(stateDir, thread);
            if (r?.status === "declined") notify(thread, r.requestedBy, "Push отклонён", "Владелец не одобрил push. Если нужно — спроси у него, что изменить.");
          } else {
            const r = await approvePush(stateDir, thread, realPushDeps);
            if (r.status === "pushed") notify(thread, r.requestedBy, "Push выполнен", `Владелец одобрил. Ветка \`${r.branch}\` запушена.${r.mr ? ` MR: ${r.mr.webUrl}` : ""}`);
            else if (r.status === "stale") {
              notify(thread, r.requestedBy, "Push не выполнен: ветка изменилась", `Владелец одобрил, но ${r.error}. Запроси <push/> заново, если всё ещё нужно.`);
              throw new Error(`не пушу: ${r.error}`);
            } else throw new Error(`push не удался: ${r.error}`);
          }
          break;
        }
        case "/api/console/merge": {
          const thread = str(body.thread);
          const p = loadPush(stateDir, thread);
          if (!p?.mr) throw new Error("у треда нет MR");
          const auditors = ctx.roles.filter((r) => r.isAuditor).map((r) => r.role);
          const ready = checkReadiness(stateDir, p, await realMergeDeps.pipeline(p.gitlabProjectPath, p.mr.iid), auditors);
          if (!ready.ready || !ready.sha) throw new Error(`не мержу: ${ready.reasons.join("; ")}`);
          await realMergeDeps.merge(p.gitlabProjectPath, p.mr.iid, ready.sha);
          notify(thread, p.requestedBy, "Смержено", `Владелец смержил MR !${p.mr.iid}. ${p.mr.webUrl}`);
          break;
        }
        default:
          return sendJson(res, 404, { error: "not found" });
      }
      sendJson(res, 200, { ok: true });
      broadcast();
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
  })();
  return true;
}

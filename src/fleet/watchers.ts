import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readJsonDir, readJsonOr, writeJsonAtomic } from "./atomic.js";
import { scrubSecrets } from "../engine/secretScrub.js";
import type { JiraComment, JiraIssueCard } from "../jira/client.js";
import type { PipelineState } from "../gitlab.js";
import { Spool, parseLetter, send } from "./mail.js";

// Watchers turn outside events into letters, like the CTO fleet's ci-watch/jira-watch.
// Both are one-way senders: a role acks their letters, never replies to them.
// - ci-watch: a role asks with <watch-ci/> and ends its session; when the thread's MR
//   pipeline reaches a final status, the role gets a letter (failed jobs + log tails).
//   One-shot; dropped with a letter after CI_WATCH_MAX_MS.
// - jira-watch: for every Jira key the fleet mailed about in the last JIRA_WINDOW_MS,
//   a status change or a new comment becomes a letter to pm in that key's latest thread.

export const CI_WATCH_ADDRESS = "xentra/ci-watch";
export const JIRA_WATCH_ADDRESS = "xentra/jira-watch";
export const WATCHER_ADDRESSES = [CI_WATCH_ADDRESS, JIRA_WATCH_ADDRESS];
export const CI_WATCH_MAX_MS = 3 * 60 * 60 * 1000;
export const JIRA_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const FINAL = new Set(["success", "failed", "canceled", "skipped"]);
const SAFE = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

export interface CiWatch {
  thread: string;
  requestedBy: string;
  projectPath: string;
  mrIid: number;
  repo?: string;
  since: string;
}

export interface WatcherDeps {
  pipeline(projectPath: string, iid: number): Promise<PipelineState>;
  failedJobs(projectPath: string, pipelineId: number): Promise<Array<{ name: string; stage: string; webUrl: string; logTail: string }>>;
  jiraCard(key: string): Promise<JiraIssueCard>;
  jiraComments(key: string): Promise<JiraComment[]>;
  knownSecrets?: Record<string, string>;
  log?: (line: string) => void;
}

export function addCiWatch(stateDir: string, w: Omit<CiWatch, "since">, now = new Date()): void {
  writeJsonAtomic(join(stateDir, "watch-ci", `${SAFE(w.thread)}.json`), { ...w, since: now.toISOString() });
}

export function listCiWatches(stateDir: string): CiWatch[] {
  return readJsonDir<CiWatch>(join(stateDir, "watch-ci")).filter((w) => w && typeof w.thread === "string");
}

function dropCiWatch(stateDir: string, thread: string): void {
  rmSync(join(stateDir, "watch-ci", `${SAFE(thread)}.json`), { force: true });
}

export async function pollCi(spool: Spool, stateDir: string, deps: WatcherDeps, now = Date.now()): Promise<number> {
  let sent = 0;
  for (const w of listCiWatches(stateDir)) {
    try {
      const p = await deps.pipeline(w.projectPath, w.mrIid);
      const status = p.status;
      if (status && FINAL.has(status)) {
        const lines = [`Пайплайн MR !${w.mrIid}: **${status}**${p.webUrl ? ` — ${p.webUrl}` : ""}`, `коммит ${p.sha?.slice(0, 8) ?? "?"}`];
        if (status === "failed" && p.pipelineId) {
          const jobs = await deps.failedJobs(w.projectPath, p.pipelineId).catch(() => []);
          for (const j of jobs) lines.push("", `### ${j.stage} / ${j.name} — ${j.webUrl}`, "```", j.logTail.trim(), "```");
        }
        send(spool, {
          from: CI_WATCH_ADDRESS,
          to: [w.requestedBy],
          subject: `CI ${status === "success" ? "зелёный" : status}: MR !${w.mrIid}`,
          body: scrubSecrets(lines.join("\n"), deps.knownSecrets ?? {}),
          priority: status === "success" ? "normal" : "high",
          thread: w.thread,
          repo: w.repo,
        });
        dropCiWatch(stateDir, w.thread);
        sent++;
      } else if (now - Date.parse(w.since) > CI_WATCH_MAX_MS) {
        send(spool, {
          from: CI_WATCH_ADDRESS,
          to: [w.requestedBy],
          subject: `CI не завершился за ${CI_WATCH_MAX_MS / 3_600_000} ч: MR !${w.mrIid}`,
          body: `Последний статус: ${status ?? "пайплайна нет"}. Наблюдение снято; поставь заново, если нужно.`,
          thread: w.thread,
          repo: w.repo,
        });
        dropCiWatch(stateDir, w.thread);
        sent++;
      }
    } catch (err) {
      deps.log?.(`ci-watch ${w.thread}: ${(err as Error).message}`);
    }
  }
  return sent;
}

// Jira keys the fleet has mailed about recently, each with its latest thread.
export function recentKeys(spool: Spool, now = Date.now()): Map<string, { thread: string; repo?: string }> {
  const out = new Map<string, { thread: string; repo?: string; at: number }>();
  const sentRoot = join(spool.root, "Sent");
  if (!existsSync(sentRoot)) return new Map();
  for (const g of readdirSync(sentRoot)) {
    for (const p of readdirSync(join(sentRoot, g))) {
      const dir = join(sentRoot, g, p);
      for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
        const at = Number(f.split("-")[0]) * 1000;
        if (!Number.isFinite(at) || now - at > JIRA_WINDOW_MS) continue;
        try {
          const l = parseLetter(readFileSync(join(dir, f), "utf8"));
          if (!l.key) continue;
          const prev = out.get(l.key);
          if (!prev || prev.at < at) out.set(l.key, { thread: l.thread, repo: l.repo, at });
        } catch {
          /* skip */
        }
      }
    }
  }
  return new Map([...out].map(([k, v]) => [k, { thread: v.thread, repo: v.repo }]));
}

interface JiraSeen {
  status: string;
  lastCommentAt?: string;
}

export async function pollJira(spool: Spool, stateDir: string, deps: WatcherDeps, now = Date.now()): Promise<number> {
  const dir = join(stateDir, "watch-jira");
  mkdirSync(dir, { recursive: true });
  let sent = 0;
  for (const [key, where] of recentKeys(spool, now)) {
    try {
      const card = await deps.jiraCard(key);
      const comments = await deps.jiraComments(key);
      const file = join(dir, `${SAFE(key)}.json`);
      const prev = readJsonOr<JiraSeen | undefined>(file, undefined);
      const lastAt = comments.at(-1)?.created;
      writeJsonAtomic(file, { status: card.status, lastCommentAt: lastAt } satisfies JiraSeen);
      if (!prev) continue; // first look: remember, don't announce history
      const lines: string[] = [];
      if (prev.status !== card.status) lines.push(`Статус: ${prev.status} → **${card.status}**`);
      const fresh = comments.filter((c) => !prev.lastCommentAt || c.created > prev.lastCommentAt);
      for (const c of fresh) lines.push(`Комментарий ${c.author} (${c.created.slice(0, 16).replace("T", " ")}): ${c.body.replace(/\s+/g, " ").slice(0, 800)}`);
      if (lines.length === 0) continue;
      send(spool, {
        from: JIRA_WATCH_ADDRESS,
        to: ["xentra/pm"],
        subject: `Jira ${key}: ${prev.status !== card.status ? card.status : "новый комментарий"}`,
        body: scrubSecrets(lines.join("\n"), deps.knownSecrets ?? {}),
        thread: where.thread,
        repo: where.repo,
        key,
      });
      sent++;
    } catch (err) {
      deps.log?.(`jira-watch ${key}: ${(err as Error).message}`);
    }
  }
  return sent;
}

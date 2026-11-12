import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEPUTY_THREAD } from "./deputy.js";
import { type Letter, type Spool, parseLetter, readInbox } from "./mail.js";
import { listPushes } from "./pushRequests.js";
import type { Role } from "./roles.js";
import { branchFor, workspaceDir, type RepoTarget } from "./workspace.js";

const execFileAsync = promisify(execFile);

// Worktrees and fleet/* branches of threads nobody will touch again. Conservative on
// purpose: a thread is "archived" only when it has been quiet for `days`, nothing of it
// waits in any Inbox, no session runs on it and no push decision is pending. The
// worktree goes; the branch goes only when its commits are safe elsewhere (pushed, or
// no commits of its own beyond the base) — unpushed work is never deleted.

export interface StaleThread {
  thread: string;
  repo: RepoTarget["kind"];
  lastLetterAt: number;
}

function letterTime(l: Letter): number {
  const ts = Number(l.id.split("-")[0]);
  return Number.isFinite(ts) ? ts * 1000 : Date.parse(l.date);
}

function allLetters(spool: Spool): Letter[] {
  const out: Letter[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) {
        try {
          out.push(parseLetter(readFileSync(p, "utf8")));
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(join(spool.root, "Sent"));
  return out;
}

export function staleThreads(spool: Spool, stateDir: string, roles: Role[], opts: { days: number; now?: number }): StaleThread[] {
  const now = opts.now ?? Date.now();
  const cutoff = now - opts.days * 86_400_000;
  const last = new Map<string, { at: number; repo?: string }>();
  for (const l of allLetters(spool)) {
    if (l.kind || l.thread === DEPUTY_THREAD) continue;
    const prev = last.get(l.thread);
    if (!prev || prev.at < letterTime(l)) last.set(l.thread, { at: letterTime(l), repo: l.repo ?? prev?.repo });
    else if (!prev.repo && l.repo) prev.repo = l.repo;
  }
  const pendingInbox = new Set(roles.flatMap((r) => readInbox(spool, r.mail).map((l) => l.thread)));
  const running = new Set(
    existsSync(stateDir)
      ? readdirSync(stateDir)
          .filter((f) => f.startsWith("running."))
          .map((f) => {
            try {
              return String(JSON.parse(readFileSync(join(stateDir, f), "utf8")).thread);
            } catch {
              return "";
            }
          })
      : [],
  );
  const pendingPush = new Set(listPushes(stateDir).filter((p) => p.status === "pending").map((p) => p.thread));
  const out: StaleThread[] = [];
  for (const [thread, { at }] of last) {
    if (at > cutoff || pendingInbox.has(thread) || running.has(thread) || pendingPush.has(thread)) continue;
    for (const repo of ["backend", "frontend"] as const) {
      if (existsSync(join(workspaceDir(repo, thread), ".git"))) out.push({ thread, repo, lastLetterAt: at });
    }
  }
  return out.sort((a, b) => a.lastLetterAt - b.lastLetterAt);
}

export interface CleanupResult {
  thread: string;
  repo: RepoTarget["kind"];
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  note?: string;
}

// Removes the worktree (and its meta file); deletes the branch only when safe.
export async function removeWorkspace(target: RepoTarget, thread: string, opts: { pushed: boolean }): Promise<CleanupResult> {
  const dir = workspaceDir(target.kind, thread);
  const branch = branchFor(thread);
  const git = (args: string[]) => execFileAsync("git", args, { cwd: target.path }).then((r) => r.stdout.trim());
  const result: CleanupResult = { thread, repo: target.kind, worktreeRemoved: false, branchDeleted: false };
  await git(["worktree", "remove", "--force", dir]).catch(() => {});
  await git(["worktree", "prune"]).catch(() => {});
  rmSync(dir, { recursive: true, force: true });
  rmSync(`${dir}.meta.json`, { force: true });
  result.worktreeRemoved = !existsSync(dir);
  const exists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true).catch(() => false);
  if (!exists) return result;
  const base = await git(["rev-parse", "--verify", "--quiet", `origin/${target.baseBranch}`]).then(() => `origin/${target.baseBranch}`).catch(() => target.baseBranch);
  const own = await git(["rev-list", "--count", `${base}..${branch}`]).catch(() => "?");
  const safe = opts.pushed || own === "0";
  if (!safe) {
    result.note = `ветка ${branch} оставлена: ${own} незапушенных коммитов`;
    return result;
  }
  await git(["branch", "-D", branch]);
  result.branchDeleted = true;
  return result;
}

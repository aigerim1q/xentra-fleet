import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeWorkspace, staleThreads } from "./cleanup.js";
import { Spool, send } from "./mail.js";
import { fileRequest } from "./pushRequests.js";
import { OWNER_ADDRESS, parseRole } from "./roles.js";
import { ensureWorkspace, workspaceDir, type RepoTarget } from "./workspace.js";

let home: string;
let repoDir: string;
const oldHome = process.env.FLEET_HOME;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

before(() => {
  home = mkdtempSync(join(tmpdir(), "cleanup-"));
  process.env.FLEET_HOME = home;
  repoDir = join(home, "repo");
  execFileSync("git", ["init", "-q", "-b", "dev", repoDir]);
  git(repoDir, "config", "user.email", "t@example.com");
  git(repoDir, "config", "user.name", "T");
  writeFileSync(join(repoDir, "README.md"), "x\n");
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-q", "-m", "init");
});
after(() => {
  process.env.FLEET_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

const target = (): RepoTarget => ({ kind: "backend", path: repoDir, baseBranch: "dev", gates: [] });
const DAY = 86_400_000;

test("only quiet threads with nothing pending, nothing running and no open push decision are stale", async () => {
  const spool = new Spool(join(home, "mail"));
  for (const a of [OWNER_ADDRESS, "xentra/pm"]) spool.register(a);
  const stateDir = join(home, "state");
  mkdirSync(stateDir, { recursive: true });
  const roles = [parseRole({ role: "pm", engine: "claude", model: "m", access: "read" }, "")];
  const now = Date.now();
  const old = (daysAgo: number) => new Date(now - daysAgo * DAY);
  const quiet = send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: "quiet", body: "" }, old(20));
  const fresh = send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: "fresh", body: "" }, old(2));
  const waiting = send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: "waiting", body: "" }, old(30));
  const running = send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: "running", body: "" }, old(30));
  const pushing = send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: "pushing", body: "" }, old(30));
  for (const t of [quiet, fresh, waiting, running, pushing]) await ensureWorkspace(target(), t.thread, { baselines: false });
  // "waiting" still sits in pm's Inbox; the others were handled
  for (const t of [quiet, fresh, running, pushing]) rmSync(join(spool.dir("Inbox", "xentra/pm"), `${t.id}.md`));
  writeFileSync(join(stateDir, "running.pm"), JSON.stringify({ thread: running.thread }));
  fileRequest(stateDir, { thread: pushing.thread, repo: "backend", dir: "/wt", branch: "b", baseBranch: "dev", gitlabProjectPath: "p", title: "t", requestedBy: "xentra/pm" });

  const stale = staleThreads(spool, stateDir, roles, { days: 14, now });
  assert.deepEqual(stale.map((s) => s.thread), [quiet.thread]);
});

test("removeWorkspace drops the worktree; the branch only when pushed or without own commits", async () => {
  const t = target();
  const a = await ensureWorkspace(t, "clean-thread", { baselines: false });
  const r1 = await removeWorkspace(t, "clean-thread", { pushed: false });
  assert.equal(r1.worktreeRemoved, true);
  assert.equal(r1.branchDeleted, true, "no commits of its own: branch deleted");
  assert.ok(!existsSync(a));
  assert.ok(!existsSync(`${workspaceDir("backend", "clean-thread")}.meta.json`));

  const b = await ensureWorkspace(t, "unpushed-thread", { baselines: false });
  writeFileSync(join(b, "w.txt"), "work\n");
  git(b, "add", "-A");
  git(b, "commit", "-q", "-m", "work");
  const r2 = await removeWorkspace(t, "unpushed-thread", { pushed: false });
  assert.equal(r2.worktreeRemoved, true);
  assert.equal(r2.branchDeleted, false, "unpushed commits are never deleted");
  assert.match(r2.note!, /1 незапушенных/);
  assert.match(git(repoDir, "branch", "--list", "fleet/unpushed-thread"), /unpushed-thread/);

  const c = await ensureWorkspace(t, "pushed-thread", { baselines: false });
  writeFileSync(join(c, "w.txt"), "work\n");
  git(c, "add", "-A");
  git(c, "commit", "-q", "-m", "work");
  const r3 = await removeWorkspace(t, "pushed-thread", { pushed: true });
  assert.equal(r3.branchDeleted, true);
  assert.equal(git(repoDir, "branch", "--list", "fleet/pushed-thread"), "");
});

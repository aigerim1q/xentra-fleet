import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteRejection, ensureWorkspace, removeInWorkspace, workspaceHead, type RepoTarget } from "./workspace.js";

let home: string;
let repoDir: string;
const oldHome = process.env.FLEET_HOME;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

before(() => {
  home = mkdtempSync(join(tmpdir(), "ws-home-"));
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

test("a worktree whose directory was deleted by hand is re-created on the same branch, keeping its commits", async () => {
  const dir = await ensureWorkspace(target(), "t-stale", { baselines: false });
  assert.ok(existsSync(join(dir, ".git")));
  writeFileSync(join(dir, "work.txt"), "edit\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "thread work");
  const sha = await workspaceHead(dir);

  rmSync(dir, { recursive: true, force: true }); // still registered with git
  assert.match(git(repoDir, "worktree", "list"), /t-stale/);

  const again = await ensureWorkspace(target(), "t-stale", { baselines: false });
  assert.equal(again, dir);
  assert.ok(existsSync(join(dir, "work.txt")), "the thread's commit is still there");
  assert.equal(await workspaceHead(dir), sha);
});

test("removeInWorkspace deletes files and folders inside the worktree and refuses everything else", async () => {
  const base = mkdtempSync(join(tmpdir(), "fleet-rm-"));
  try {
    const wt = join(base, "wt");
    const outside = join(base, "outside");
    mkdirSync(join(wt, "src/old"), { recursive: true });
    mkdirSync(join(wt, ".git"));
    mkdirSync(outside);
    writeFileSync(join(wt, "src/old/a.ts"), "x");
    writeFileSync(join(wt, "src/keep.ts"), "x");
    writeFileSync(join(wt, ".env-example"), "x");
    writeFileSync(join(outside, "secret"), "x");
    symlinkSync(outside, join(wt, "link"));
    const r = await removeInWorkspace(wt, ["src/old", "../outside", "/etc/hosts", ".git", ".env-example", "link/secret", "src/missing", "", "."]);
    assert.deepEqual(r.removed, ["src/old"]);
    assert.deepEqual(r.rejected.map((x) => x.path), ["../outside", "/etc/hosts", ".git", ".env-example", "link/secret", "src/missing", "", "."]);
    assert.ok(!existsSync(join(wt, "src/old")));
    assert.ok(existsSync(join(wt, "src/keep.ts")));
    assert.ok(existsSync(join(outside, "secret")), "a path through a symlink out of the worktree is not followed");
    // The symlink itself may go — as a link, without touching its target.
    assert.equal(deleteRejection(wt, "link"), undefined);
    await removeInWorkspace(wt, ["link"]);
    assert.ok(existsSync(join(outside, "secret")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

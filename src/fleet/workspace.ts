import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { commitAll } from "../engine/git.js";
import { establishBaselines, runGates } from "../engine/verify.js";
import type { GateBaseline, GateSpec, VerifyResult } from "../types.js";

const execFileAsync = promisify(execFile);

// One git worktree per (repo, thread), on branch fleet/<thread>, shared by every role
// of that thread: the developer edits it, auditors/tester read the same files. Only one
// session per thread runs at a time (supervisor lock), so roles never race on it.
// Gate baselines are taken when the worktree is created — before any edit — so a later
// <gates/> run compares against the untouched base, like the single-task pipeline.

export interface RepoTarget {
  kind: "backend" | "frontend";
  path: string;
  baseBranch: string;
  gates: GateSpec[];
  gitlabProjectPath?: string;
}

interface WorkspaceMeta {
  repo: string;
  thread: string;
  branch: string;
  createdAt: string;
  baselines: GateBaseline[] | null;
}

export function fleetHome(): string {
  return process.env.FLEET_HOME ?? join(homedir(), ".xentra-fleet");
}

export function workspaceDir(repo: RepoTarget["kind"], thread: string): string {
  return join(fleetHome(), "worktrees", repo, thread.replace(/[^A-Za-z0-9_-]/g, "_"));
}

function metaPath(dir: string): string {
  return join(dirname(dir), `${dir.split("/").pop()}.meta.json`);
}

function readMeta(dir: string): WorkspaceMeta | undefined {
  try {
    return JSON.parse(readFileSync(metaPath(dir), "utf8"));
  } catch {
    return undefined;
  }
}

export function branchFor(thread: string): string {
  return `fleet/${thread.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export async function ensureWorkspace(target: RepoTarget, thread: string, opts: { baselines: boolean }): Promise<string> {
  const dir = workspaceDir(target.kind, thread);
  if (existsSync(join(dir, ".git"))) {
    const meta = readMeta(dir);
    if (opts.baselines && meta && meta.baselines === null) {
      // Created earlier by a read-only role (no edits yet, since only edit roles change
      // files) — safe to take the baseline now.
      meta.baselines = await establishBaselines(dir, target.gates);
      writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2));
    }
    return dir;
  }
  mkdirSync(dirname(dir), { recursive: true });
  await execFileAsync("git", ["fetch", "origin", target.baseBranch], { cwd: target.path }).catch(() => {});
  const start = await execFileAsync("git", ["rev-parse", "--verify", `origin/${target.baseBranch}`], { cwd: target.path })
    .then(() => `origin/${target.baseBranch}`)
    .catch(() => "HEAD");
  const branch = branchFor(thread);
  await execFileAsync("git", ["worktree", "add", "-B", branch, dir, start], { cwd: target.path });
  const nm = join(target.path, "node_modules");
  if (existsSync(nm)) {
    try {
      symlinkSync(nm, join(dir, "node_modules"), "dir");
    } catch {
      /* already there */
    }
  }
  const meta: WorkspaceMeta = {
    repo: target.kind,
    thread,
    branch,
    createdAt: new Date().toISOString(),
    baselines: opts.baselines ? await establishBaselines(dir, target.gates) : null,
  };
  writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2));
  return dir;
}

export async function commitWorkspace(dir: string, message: string): Promise<boolean> {
  return commitAll(dir, message).catch(() => false);
}

export async function runWorkspaceGates(target: RepoTarget, dir: string): Promise<VerifyResult> {
  const meta = readMeta(dir);
  return runGates(dir, target.gates, meta?.baselines ?? []);
}

export async function workspaceDiff(dir: string, baseBranch: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["diff", `origin/${baseBranch}...HEAD`, "--stat"], { cwd: dir }).catch(() => ({
    stdout: "",
  }));
  return stdout.trim();
}

export async function workspaceHead(dir: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
  return stdout.trim();
}

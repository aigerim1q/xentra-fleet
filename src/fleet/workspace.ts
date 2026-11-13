import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { checkGateIntegrity } from "../engine/gateIntegrity.js";
import { commitAll } from "../engine/git.js";
import { establishBaselines, runGates } from "../engine/verify.js";
import type { GateBaseline, GateSpec, VerifyResult } from "../types.js";

const execFileAsync = promisify(execFile);

// One git worktree per (repo, thread), on branch fleet/<thread>, shared by every role
// of that thread: the developer edits it, auditors/tester read the same files. Only one
// session per thread runs at a time (supervisor lock), so roles never race on it.
// Gate baselines are taken when the worktree is created — before any edit — so a later
// <gates/> run compares against the untouched base, like the single-task pipeline.

import type { FleetRepoKind } from "./repoKinds.js";

export { FLEET_REPO_KINDS, type FleetRepoKind } from "./repoKinds.js";

export interface RepoTarget {
  kind: FleetRepoKind;
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
  const git = (args: string[]) => execFileAsync("git", args, { cwd: target.path });
  await git(["fetch", "origin", target.baseBranch]).catch(() => {});
  const start = await git(["rev-parse", "--verify", `origin/${target.baseBranch}`])
    .then(() => `origin/${target.baseBranch}`)
    .catch(() => "HEAD");
  const branch = branchFor(thread);
  // A directory deleted by hand (or a half-created one) can still be registered with git,
  // which then refuses `worktree add` outright — same repair as the pipeline (engine/git.ts).
  // The thread branch itself is kept: its commits are the thread's work.
  await git(["worktree", "remove", "--force", dir]).catch(() => {});
  await git(["worktree", "prune"]).catch(() => {});
  const branchExists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
    .then(() => true)
    .catch(() => false);
  await git(branchExists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-B", branch, dir, start]);
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

// False = nothing to commit; a failed commit (hook, index) throws — the supervisor reports it.
export async function commitWorkspace(dir: string, message: string): Promise<boolean> {
  return commitAll(dir, message);
}

export async function runWorkspaceGates(target: RepoTarget, dir: string): Promise<VerifyResult> {
  const meta = readMeta(dir);
  return runGates(dir, target.gates, meta?.baselines ?? []);
}

async function baseRef(dir: string, baseBranch: string): Promise<string> {
  return execFileAsync("git", ["rev-parse", "--verify", "--quiet", `origin/${baseBranch}`], { cwd: dir })
    .then(() => `origin/${baseBranch}`)
    .catch(() => baseBranch);
}

// Same mechanical check as the pipeline (engine/gateIntegrity.ts): deleted tests, skip
// markers, edited gate/CI config in the thread's diff against the base.
export async function workspaceIntegrity(dir: string, baseBranch: string): Promise<string[]> {
  const violations = await checkGateIntegrity(dir, await baseRef(dir, baseBranch));
  return violations.map((v) => v.description);
}

export async function workspaceDiff(dir: string, baseBranch: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["diff", `origin/${baseBranch}...HEAD`, "--stat"], { cwd: dir }).catch(() => ({
    stdout: "",
  }));
  return stdout.trim();
}

export interface WorkspaceChanges {
  head: string;
  stat: string;
  text: string;
}

// What the thread changed against the base (committed work: the supervisor commits after
// every edit session). Read-only roles get this in their prompt — they have no shell to
// run git themselves.
export async function workspaceChanges(dir: string, baseBranch: string): Promise<WorkspaceChanges> {
  const git = (args: string[]) => execFileAsync("git", args, { cwd: dir, maxBuffer: 1024 * 1024 * 20 }).then((r) => r.stdout);
  const head = (await git(["rev-parse", "HEAD"])).trim();
  const base = await baseRef(dir, baseBranch);
  const stat = (await git(["diff", `${base}...HEAD`, "--stat"]).catch(() => "")).trim();
  const text = stat ? await git(["diff", `${base}...HEAD`]).catch(() => "") : "";
  return { head, stat, text };
}

export async function workspaceHead(dir: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
  return stdout.trim();
}

export interface RemoveResult {
  removed: string[];
  rejected: Array<{ path: string; reason: string }>;
}

export const MAX_DELETES_PER_REPLY = 50;

// Why a <delete path> must not run, or undefined if it may. Only paths inside the
// worktree, never the worktree itself, git internals, the node_modules symlink or env
// files (agents never touch secrets — roles can't read .env either).
export function deleteRejection(dir: string, path: string): string | undefined {
  if (!path || isAbsolute(path) || path.includes("\0")) return "нужен относительный путь внутри репозитория";
  const root = realpathSync(dir);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel === "." ) return "нельзя удалить корень репозитория";
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return "путь выходит за рабочую копию";
  const parts = rel.split(sep);
  if (parts[0] === ".git" || parts[0] === "node_modules") return `${parts[0]} не трогаю`;
  if (parts.some((s) => /^\.env(\b|$)|^\.env[-.]/i.test(s))) return "env-файлы удаляет только владелец";
  // A symlinked parent could point anywhere: the real parent must still be inside.
  let parent: string;
  try {
    parent = realpathSync(dirname(target));
  } catch {
    return "такого пути нет";
  }
  const relParent = relative(root, parent);
  if (relParent === ".." || relParent.startsWith(".." + sep) || isAbsolute(relParent)) return "путь выходит за рабочую копию";
  try {
    lstatSync(target);
  } catch {
    return "такого пути нет";
  }
  return undefined;
}

// Executes <delete path> blocks of an edit role. The supervisor commits right after, so
// the deletion lands in the thread branch like any other edit (and gate integrity still
// sees a deleted test file against the base).
export async function removeInWorkspace(dir: string, paths: string[]): Promise<RemoveResult> {
  const out: RemoveResult = { removed: [], rejected: [] };
  for (const [i, path] of paths.entries()) {
    if (i >= MAX_DELETES_PER_REPLY) {
      out.rejected.push({ path, reason: `не больше ${MAX_DELETES_PER_REPLY} удалений за ответ` });
      continue;
    }
    const why = deleteRejection(dir, path);
    if (why) {
      out.rejected.push({ path, reason: why });
      continue;
    }
    // lstat-based: a symlink is removed as a link, never followed.
    rmSync(resolve(realpathSync(dir), path), { recursive: true, force: true });
    out.removed.push(path);
  }
  return out;
}

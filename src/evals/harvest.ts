import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { MergedMr } from "../gitlab.js";
import type { EvalCase } from "./types.js";

const execFileAsync = promisify(execFile);

// Builds eval cases from closed XEN tickets: the ticket text is the task, the merged MR
// is the historical answer. baseCommit = the target branch right before the MR,
// referenceCommit = the merged result, hiddenTestPaths = the tests the MR added or
// changed — staged before the agent starts and gating its run, never shown up front.
// A ticket qualifies only with a merged MR that touched both tests and real code.

export const TEST_FILE = /\.(spec|test)\.(ts|tsx|js|jsx)$/;
// A case should be task-sized: a feature-sized MR makes an expensive, uninformative case.
export const MAX_HIDDEN_TESTS = 8;
export const MAX_CODE_FILES = 25;

export interface HarvestCandidate {
  key: string;
  title: string;
  description: string;
}

export interface HarvestDeps {
  mergedMrs(repo: EvalCase["repo"], key: string): Promise<MergedMr[]>;
  // true when the commit exists in the local clone of that repo
  hasCommit(repo: EvalCase["repo"], sha: string): Promise<boolean>;
}

export type HarvestOutcome = { key: string; case: EvalCase } | { key: string; skipped: string };

// [backend]/[frontend] tag in the title picks the repo; untagged tickets try both.
export function reposFor(title: string): EvalCase["repo"][] {
  const t = title.toLowerCase();
  if (t.includes("[frontend]") || t.includes("[web]")) return ["frontend"];
  if (t.includes("[backend]")) return ["backend"];
  return ["backend", "frontend"];
}

export async function harvestOne(c: HarvestCandidate, deps: HarvestDeps): Promise<HarvestOutcome> {
  if (c.description.trim().length < 40) return { key: c.key, skipped: "описание тикета слишком короткое для задачи" };
  const reasons: string[] = [];
  for (const repo of reposFor(c.title)) {
    let mrs: MergedMr[];
    try {
      mrs = await deps.mergedMrs(repo, c.key);
    } catch (err) {
      reasons.push(`${repo}: ${(err as Error).message}`);
      continue;
    }
    if (mrs.length === 0) {
      reasons.push(`${repo}: нет смерженного MR`);
      continue;
    }
    if (mrs.length > 1) {
      reasons.push(`${repo}: ${mrs.length} смерженных MR — ответ размазан, кейс неоднозначен`);
      continue;
    }
    const mr = mrs[0];
    const others = (mr.keysMentioned ?? []).filter((k) => k.toUpperCase() !== c.key.toUpperCase());
    if (others.length > 0) {
      reasons.push(`${repo}: MR !${mr.iid} закрывает несколько тикетов (${others.slice(0, 3).join(", ")})`);
      continue;
    }
    const tests = mr.changedPaths.filter((p) => TEST_FILE.test(p));
    const code = mr.changedPaths.filter((p) => !TEST_FILE.test(p) && /\.(ts|tsx|js|jsx)$/.test(p));
    if (tests.length === 0) {
      reasons.push(`${repo}: MR !${mr.iid} без тестов`);
      continue;
    }
    if (code.length === 0) {
      reasons.push(`${repo}: MR !${mr.iid} меняет только тесты`);
      continue;
    }
    if (tests.length > MAX_HIDDEN_TESTS || code.length > MAX_CODE_FILES) {
      reasons.push(`${repo}: MR !${mr.iid} размером с фичу (${tests.length} тестов, ${code.length} файлов кода)`);
      continue;
    }
    if (!mr.baseSha || !mr.referenceSha) {
      reasons.push(`${repo}: MR !${mr.iid} без base/merge коммита`);
      continue;
    }
    if (!(await deps.hasCommit(repo, mr.baseSha)) || !(await deps.hasCommit(repo, mr.referenceSha))) {
      reasons.push(`${repo}: коммитов MR !${mr.iid} нет в локальном клоне (git fetch)`);
      continue;
    }
    return {
      key: c.key,
      case: {
        id: c.key,
        title: c.title,
        description: c.description,
        repo,
        baseCommit: mr.baseSha,
        referenceCommit: mr.referenceSha,
        hiddenTestPaths: tests,
      },
    };
  }
  return { key: c.key, skipped: reasons.join("; ") || "не подошёл" };
}

export async function gitHasCommit(repoPath: string, sha: string): Promise<boolean> {
  return execFileAsync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: repoPath })
    .then(() => true)
    .catch(() => false);
}

export function writeCase(dir: string, c: EvalCase, overwrite = false): boolean {
  const p = join(dir, `${c.id.toLowerCase()}.json`);
  if (existsSync(p) && !overwrite) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
  return true;
}

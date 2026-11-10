import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function pushBranch(worktreeDir: string, branchName: string): Promise<void> {
  await execFileAsync("git", ["push", "-u", "origin", branchName], { cwd: worktreeDir });
}

export interface CreateMrOptions {
  gitlabBaseUrl: string;
  token: string;
  projectPath: string; // e.g. "saqr/back-ai"
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}

export async function createMergeRequest(opts: CreateMrOptions): Promise<{ webUrl: string }> {
  const projectId = encodeURIComponent(opts.projectPath);
  const res = await fetch(`${opts.gitlabBaseUrl}/api/v4/projects/${projectId}/merge_requests`, {
    method: "POST",
    headers: {
      "PRIVATE-TOKEN": opts.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source_branch: opts.sourceBranch,
      target_branch: opts.targetBranch,
      title: opts.title,
      description: opts.description,
      remove_source_branch: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`GitLab MR creation failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { web_url: string };
  return { webUrl: data.web_url };
}

export interface MergeRequestSummary {
  iid: number;
  title: string;
  state: string;
  sourceBranch: string;
  webUrl: string;
  pipelineStatus?: string;
  pipelineUrl?: string;
}

// The freshest MR that mentions the issue key (title or description), open ones first —
// covers both the fleet's own harness/<key> branches and MRs a human opened by hand.
// One extra request for the chosen MR, because the list endpoint carries no pipeline.
export async function findMergeRequestForIssue(opts: {
  gitlabBaseUrl: string;
  token: string;
  projectPath: string;
  issueKey: string;
  signal?: AbortSignal;
}): Promise<MergeRequestSummary | undefined> {
  const projectId = encodeURIComponent(opts.projectPath);
  const base = `${opts.gitlabBaseUrl}/api/v4/projects/${projectId}/merge_requests`;
  const get = async (url: string): Promise<unknown> => {
    const res = await fetch(url, { headers: { "PRIVATE-TOKEN": opts.token }, signal: opts.signal });
    if (!res.ok) throw new Error(`GitLab ${res.status}`);
    return res.json();
  };
  type Mr = { iid: number; title: string; state: string; source_branch: string; web_url: string };
  const list = (await get(
    `${base}?search=${encodeURIComponent(opts.issueKey)}&in=title,description&order_by=updated_at&sort=desc&per_page=10`,
  )) as Mr[];
  const key = opts.issueKey.toLowerCase();
  const matching = list.filter((m) => m.title.toLowerCase().includes(key) || m.source_branch.toLowerCase().includes(key));
  const pick = (matching.length > 0 ? matching : list).sort((a, b) => Number(b.state === "opened") - Number(a.state === "opened"))[0];
  if (!pick) return undefined;
  const full = (await get(`${base}/${pick.iid}`)) as Mr & { head_pipeline?: { status: string; web_url: string } | null };
  return {
    iid: full.iid,
    title: full.title,
    state: full.state,
    sourceBranch: full.source_branch,
    webUrl: full.web_url,
    pipelineStatus: full.head_pipeline?.status,
    pipelineUrl: full.head_pipeline?.web_url,
  };
}

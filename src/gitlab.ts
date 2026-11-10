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

export interface PipelineState {
  status?: string; // head pipeline status, undefined when there is none yet
  sha?: string;
  pipelineId?: number;
  webUrl?: string;
  mrState: string;
}

async function gitlabGet(baseUrl: string, token: string, path: string, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(`${baseUrl}/api/v4${path}`, { headers: { "PRIVATE-TOKEN": token }, signal });
  if (!res.ok) throw new Error(`GitLab ${res.status}`);
  return res;
}

export async function getMergeRequestPipeline(opts: { gitlabBaseUrl: string; token: string; projectPath: string; iid: number }): Promise<PipelineState> {
  const p = encodeURIComponent(opts.projectPath);
  const mr = (await (await gitlabGet(opts.gitlabBaseUrl, opts.token, `/projects/${p}/merge_requests/${opts.iid}`)).json()) as {
    state: string;
    head_pipeline?: { id: number; status: string; sha: string; web_url: string } | null;
  };
  return {
    mrState: mr.state,
    status: mr.head_pipeline?.status,
    sha: mr.head_pipeline?.sha,
    pipelineId: mr.head_pipeline?.id,
    webUrl: mr.head_pipeline?.web_url,
  };
}

// Failed jobs of a pipeline with the tail of each log — what a developer needs first.
export async function getFailedJobs(opts: {
  gitlabBaseUrl: string;
  token: string;
  projectPath: string;
  pipelineId: number;
  tailChars?: number;
}): Promise<Array<{ name: string; stage: string; webUrl: string; logTail: string }>> {
  const p = encodeURIComponent(opts.projectPath);
  const jobs = (await (
    await gitlabGet(opts.gitlabBaseUrl, opts.token, `/projects/${p}/pipelines/${opts.pipelineId}/jobs?scope[]=failed&per_page=10`)
  ).json()) as Array<{ id: number; name: string; stage: string; web_url: string }>;
  const out = [];
  for (const j of jobs.slice(0, 5)) {
    const trace = await gitlabGet(opts.gitlabBaseUrl, opts.token, `/projects/${p}/jobs/${j.id}/trace`)
      .then((r) => r.text())
      .catch(() => "");
    out.push({ name: j.name, stage: j.stage, webUrl: j.web_url, logTail: cleanJobTrace(trace).slice(-(opts.tailChars ?? 3000)) });
  }
  return out;
}

// GitLab traces carry ANSI colours, section markers and (on timestamped runners) a
// "2026-11-05T15:12:33.520008Z 00O " prefix per line; the last lines are the runner's
// own cleanup. Strip all that so the tail shows the actual failure.
export function cleanJobTrace(trace: string): string {
  let t = trace
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/section_(start|end):\d+:[^\r\n]*\r?/g, "")
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \d{2}[OE]\+?\s?/gm, "")
    .replace(/\r/g, "");
  const cleanup = t.search(/^(Cleaning up project directory|Running after_script|Uploading artifacts)/m);
  if (cleanup > 0) t = t.slice(0, cleanup);
  return t.replace(/\n{3,}/g, "\n\n").trimEnd();
}

// Merge pinned to the checked head sha: GitLab refuses if the branch moved since.
export async function mergeMergeRequest(opts: { gitlabBaseUrl: string; token: string; projectPath: string; iid: number; sha: string }): Promise<void> {
  const p = encodeURIComponent(opts.projectPath);
  const res = await fetch(`${opts.gitlabBaseUrl}/api/v4/projects/${p}/merge_requests/${opts.iid}/merge`, {
    method: "PUT",
    headers: { "PRIVATE-TOKEN": opts.token, "Content-Type": "application/json" },
    body: JSON.stringify({ sha: opts.sha, should_remove_source_branch: true }),
  });
  if (!res.ok) throw new Error(`GitLab merge ${res.status}`);
}

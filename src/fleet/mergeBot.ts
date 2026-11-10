import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewResponse } from "../engine/review.js";
import type { PipelineState } from "../gitlab.js";
import { Spool, send } from "./mail.js";
import { listPushes, type PushRequest } from "./pushRequests.js";
import { OWNER_ADDRESS } from "./roles.js";

// Merge bot, as in the CTO fleet: a thread's MR is ready when
//   1) the MR is open, 2) its head pipeline is green, 3) every auditor's latest verdict
//   is non-blocking on exactly that head commit, 4) the owner hasn't vetoed the thread.
// Mode (FLEET_MERGE_BOT): off (default) — nothing; notify — the owner gets a letter with a
// Merge button and merges by clicking; auto — the bot merges. Merging stays the owner's
// decision unless the owner switches to auto.

export type MergeMode = "off" | "notify" | "auto";

export function mergeModeFromEnv(env: NodeJS.ProcessEnv = process.env): MergeMode {
  const m = env.FLEET_MERGE_BOT;
  return m === "notify" || m === "auto" ? m : "off";
}

export interface Verdict {
  role: string;
  sha: string;
  blocking: boolean;
  at: string;
}

const SAFE = (t: string) => t.replace(/[^A-Za-z0-9_-]/g, "_");

function verdictFile(stateDir: string, thread: string): string {
  return join(stateDir, "verdicts", `${SAFE(thread)}.json`);
}

export function loadVerdicts(stateDir: string, thread: string): Record<string, Verdict> {
  try {
    return JSON.parse(readFileSync(verdictFile(stateDir, thread), "utf8"));
  } catch {
    return {};
  }
}

// An auditor's reply carries БЛОКИРУЮЩИЕ/ЗАМЕЧАНИЯ; the verdict is pinned to the commit
// the auditor actually looked at. Returns undefined when the text has no verdict.
export function recordVerdict(stateDir: string, thread: string, role: string, sha: string, replyText: string, now = new Date()): Verdict | undefined {
  if (!/блокирующие\s*:/i.test(replyText)) return undefined;
  const blocking = parseReviewResponse(replyText).some((f) => f.blocking);
  const v: Verdict = { role, sha, blocking, at: now.toISOString() };
  const all = loadVerdicts(stateDir, thread);
  all[role] = v;
  mkdirSync(join(stateDir, "verdicts"), { recursive: true });
  writeFileSync(verdictFile(stateDir, thread), JSON.stringify(all, null, 2));
  return v;
}

export function vetoPath(stateDir: string, thread: string): string {
  return join(stateDir, "veto", SAFE(thread));
}

export function setVeto(stateDir: string, thread: string, on: boolean): void {
  if (on) {
    mkdirSync(join(stateDir, "veto"), { recursive: true });
    writeFileSync(vetoPath(stateDir, thread), new Date().toISOString());
  } else {
    rmSync(vetoPath(stateDir, thread), { force: true });
  }
}

export interface Readiness {
  ready: boolean;
  reasons: string[]; // why not, when not ready
  sha?: string;
}

export function checkReadiness(stateDir: string, push: PushRequest, pipeline: PipelineState, auditors: string[]): Readiness {
  const reasons: string[] = [];
  if (pipeline.mrState !== "opened") reasons.push(`MR ${pipeline.mrState}`);
  if (pipeline.status !== "success") reasons.push(`CI ${pipeline.status ?? "нет пайплайна"}`);
  const verdicts = loadVerdicts(stateDir, push.thread);
  for (const a of auditors) {
    const v = verdicts[a];
    if (!v) reasons.push(`нет вердикта ${a}`);
    else if (v.blocking) reasons.push(`${a}: есть блокирующие`);
    else if (!pipeline.sha || v.sha !== pipeline.sha) reasons.push(`${a} смотрел другой коммит`);
  }
  if (existsSync(vetoPath(stateDir, push.thread))) reasons.push("вето владельца");
  return { ready: reasons.length === 0, reasons, sha: pipeline.sha };
}

export interface MergeDeps {
  pipeline(projectPath: string, iid: number): Promise<PipelineState>;
  merge(projectPath: string, iid: number, sha: string): Promise<void>;
  log?: (line: string) => void;
}

function announcedFile(stateDir: string, thread: string): string {
  return join(stateDir, "merge-announced", SAFE(thread));
}

// One pass over threads with a pushed MR. notify: one letter per ready head commit.
// auto: merge, pinned to the checked sha (GitLab refuses if the head moved meanwhile).
export async function pollMerges(
  spool: Spool,
  stateDir: string,
  mode: MergeMode,
  auditors: string[],
  deps: MergeDeps,
): Promise<number> {
  if (mode === "off") return 0;
  let acted = 0;
  for (const p of listPushes(stateDir)) {
    if (p.status !== "pushed" || !p.mr) continue;
    try {
      const pipe = await deps.pipeline(p.gitlabProjectPath, p.mr.iid);
      const r = checkReadiness(stateDir, p, pipe, auditors);
      if (!r.ready || !r.sha) continue;
      const marker = announcedFile(stateDir, p.thread);
      if (existsSync(marker) && readFileSync(marker, "utf8") === r.sha) continue;
      if (mode === "auto") {
        await deps.merge(p.gitlabProjectPath, p.mr.iid, r.sha);
        send(spool, {
          from: "xentra/fleet",
          to: [OWNER_ADDRESS, p.requestedBy],
          subject: `Смержено: MR !${p.mr.iid}`,
          body: `Merge-бот (режим auto): CI зелёный, аудиторы без блокирующих на ${r.sha.slice(0, 8)}. ${p.mr.webUrl}`,
          thread: p.thread,
        });
      } else {
        send(spool, {
          from: "xentra/fleet",
          to: [OWNER_ADDRESS],
          subject: `Готово к мержу: MR !${p.mr.iid}`,
          body: `CI зелёный, ${auditors.join(" и ")} без блокирующих на коммите ${r.sha.slice(0, 8)}. ${p.mr.webUrl}\nСмержить — кнопкой; вето — /veto ${p.thread}.`,
          priority: "high",
          thread: p.thread,
        });
      }
      mkdirSync(join(stateDir, "merge-announced"), { recursive: true });
      writeFileSync(marker, r.sha);
      acted++;
    } catch (err) {
      deps.log?.(`merge-bot ${p.thread}: ${(err as Error).message}`);
    }
  }
  return acted;
}

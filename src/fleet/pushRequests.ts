import { join } from "node:path";
import { readJsonDir, readJsonOr, writeJsonAtomic } from "./atomic.js";
import type { FleetRepoKind } from "./repoKinds.js";

// Push and MR leave the machine, so they happen only on the owner's click, every time
// (the fleet's "push only with the owner's confirmation" rule). A role asks with
// <push title=".."/>; the supervisor files a request here and mails the owner; the
// Telegram bridge shows Approve/Decline; approve() pushes the thread branch and opens
// (or reuses) its MR. The MR is remembered per thread for ci-watch and the merge bot.

export interface PushRequest {
  thread: string;
  repo: FleetRepoKind;
  dir: string;
  branch: string;
  baseBranch: string;
  gitlabProjectPath: string;
  title: string;
  requestedBy: string;
  requestedAt: string;
  // Head of the thread branch when the role asked. The owner approves THIS commit: if
  // the branch moved by the time of the click, approve refuses ("stale") and the role
  // has to ask again, so what gets pushed is what the owner saw.
  headSha?: string;
  status: "pending" | "pushed" | "declined" | "failed" | "stale";
  mr?: { iid: number; webUrl: string };
  error?: string;
  decidedAt?: string; // when the owner pushed or declined
  firstPushedAt?: string; // first successful push of the thread — "time to MR"
}

const SAFE = (t: string) => t.replace(/[^A-Za-z0-9_-]/g, "_");

function file(stateDir: string, thread: string): string {
  return join(stateDir, "push", `${SAFE(thread)}.json`);
}

export function loadPush(stateDir: string, thread: string): PushRequest | undefined {
  return readJsonOr<PushRequest | undefined>(file(stateDir, thread), undefined);
}

export function savePush(stateDir: string, req: PushRequest): void {
  writeJsonAtomic(file(stateDir, req.thread), req);
}

// A half-written or corrupt request file is skipped, not fatal: the bot's status line
// and the console list every push, and one bad file must not hide the rest.
export function listPushes(stateDir: string): PushRequest[] {
  return readJsonDir<PushRequest>(join(stateDir, "push")).filter((p) => p && typeof p.thread === "string");
}

// A new request keeps the thread's MR (a second push updates the same MR).
export function fileRequest(stateDir: string, req: Omit<PushRequest, "status" | "requestedAt" | "mr" | "error">, now = new Date()): PushRequest {
  const prev = loadPush(stateDir, req.thread);
  const r: PushRequest = { ...req, status: "pending", requestedAt: now.toISOString(), mr: prev?.mr, firstPushedAt: prev?.firstPushedAt };
  savePush(stateDir, r);
  return r;
}

export interface PushDeps {
  push(dir: string, branch: string): Promise<void>;
  createMr(r: PushRequest): Promise<{ iid: number; webUrl: string }>;
  headSha(dir: string): Promise<string>;
}

export async function approvePush(stateDir: string, thread: string, deps: PushDeps): Promise<PushRequest> {
  const r = loadPush(stateDir, thread);
  if (!r) throw new Error(`нет запроса на push для треда ${thread}`);
  if (r.status !== "pending") throw new Error(`запрос уже обработан (${r.status})`);
  if (r.headSha) {
    const now = await deps.headSha(r.dir).catch(() => "");
    if (now !== r.headSha) {
      r.status = "stale";
      r.error = `ветка изменилась после запроса (${r.headSha.slice(0, 8)} → ${now.slice(0, 8) || "?"}); нужен новый запрос на push`;
      r.decidedAt = new Date().toISOString();
      savePush(stateDir, r);
      return r;
    }
  }
  try {
    await deps.push(r.dir, r.branch);
    if (!r.mr) r.mr = await deps.createMr(r);
    r.status = "pushed";
    r.error = undefined;
    r.firstPushedAt ??= new Date().toISOString();
  } catch (err) {
    r.status = "failed";
    r.error = (err as Error).message.slice(0, 300);
  }
  r.decidedAt = new Date().toISOString();
  savePush(stateDir, r);
  return r;
}

export function declinePush(stateDir: string, thread: string): PushRequest | undefined {
  const r = loadPush(stateDir, thread);
  if (!r || r.status !== "pending") return r;
  r.status = "declined";
  r.decidedAt = new Date().toISOString();
  savePush(stateDir, r);
  return r;
}

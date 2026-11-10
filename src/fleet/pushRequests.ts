import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Push and MR leave the machine, so they happen only on the owner's click, every time
// (the fleet's "push only with the owner's confirmation" rule). A role asks with
// <push title=".."/>; the supervisor files a request here and mails the owner; the
// Telegram bridge shows Approve/Decline; approve() pushes the thread branch and opens
// (or reuses) its MR. The MR is remembered per thread for ci-watch and the merge bot.

export interface PushRequest {
  thread: string;
  repo: "backend" | "frontend";
  dir: string;
  branch: string;
  baseBranch: string;
  gitlabProjectPath: string;
  title: string;
  requestedBy: string;
  requestedAt: string;
  status: "pending" | "pushed" | "declined" | "failed";
  mr?: { iid: number; webUrl: string };
  error?: string;
}

const SAFE = (t: string) => t.replace(/[^A-Za-z0-9_-]/g, "_");

function file(stateDir: string, thread: string): string {
  return join(stateDir, "push", `${SAFE(thread)}.json`);
}

export function loadPush(stateDir: string, thread: string): PushRequest | undefined {
  try {
    return JSON.parse(readFileSync(file(stateDir, thread), "utf8"));
  } catch {
    return undefined;
  }
}

export function savePush(stateDir: string, req: PushRequest): void {
  mkdirSync(join(stateDir, "push"), { recursive: true });
  writeFileSync(file(stateDir, req.thread), JSON.stringify(req, null, 2));
}

export function listPushes(stateDir: string): PushRequest[] {
  const dir = join(stateDir, "push");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as PushRequest);
}

// A new request keeps the thread's MR (a second push updates the same MR).
export function fileRequest(stateDir: string, req: Omit<PushRequest, "status" | "requestedAt" | "mr" | "error">, now = new Date()): PushRequest {
  const prev = loadPush(stateDir, req.thread);
  const r: PushRequest = { ...req, status: "pending", requestedAt: now.toISOString(), mr: prev?.mr };
  savePush(stateDir, r);
  return r;
}

export interface PushDeps {
  push(dir: string, branch: string): Promise<void>;
  createMr(r: PushRequest): Promise<{ iid: number; webUrl: string }>;
}

export async function approvePush(stateDir: string, thread: string, deps: PushDeps): Promise<PushRequest> {
  const r = loadPush(stateDir, thread);
  if (!r) throw new Error(`нет запроса на push для треда ${thread}`);
  if (r.status !== "pending") throw new Error(`запрос уже обработан (${r.status})`);
  try {
    await deps.push(r.dir, r.branch);
    if (!r.mr) r.mr = await deps.createMr(r);
    r.status = "pushed";
    r.error = undefined;
  } catch (err) {
    r.status = "failed";
    r.error = (err as Error).message.slice(0, 300);
  }
  savePush(stateDir, r);
  return r;
}

export function declinePush(stateDir: string, thread: string): PushRequest | undefined {
  const r = loadPush(stateDir, thread);
  if (!r || r.status !== "pending") return r;
  r.status = "declined";
  savePush(stateDir, r);
  return r;
}

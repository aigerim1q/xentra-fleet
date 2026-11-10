import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Spool, thread as threadLetters } from "./mail.js";

// What the owner sees instead of internal ids: role names in plain words, and a thread
// shown by its Jira key and first subject rather than "1794296929-owner-message".

const ROLE_NAMES: Record<string, string> = {
  owner: "Ты",
  pm: "Зам. CTO",
  dev: "Разработчики",
  "dev-1": "Разработчик 1",
  "dev-2": "Разработчик 2",
  auditor: "Аудитор",
  "auditor-codex": "Аудитор (Codex)",
  tester: "Тестировщик",
  fleet: "Система",
  "ci-watch": "CI",
  "jira-watch": "Jira",
  reviewer: "Ревьюер",
  memory: "Память",
  testing: "Заметки тестировщику",
  report: "Отчёт",
  acceptance: "Приёмочный тест",
};

// Accepts "xentra/dev-1" or "dev-1" (or a journal label like "dev-review-fix").
export function roleName(addressOrRole: string): string {
  const r = addressOrRole.includes("/") ? addressOrRole.split("/")[1] : addressOrRole;
  return ROLE_NAMES[r] ?? r;
}

export function threadTitle(spool: Spool, thread: string, max = 60): string {
  if (thread === "deputy") return "разговор с Зам. CTO";
  const letters = threadLetters(spool, thread).filter((l) => !l.kind);
  // The letter that started the thread (its id is the thread id), else the earliest.
  const first = letters.find((l) => l.id === thread) ?? letters[0];
  if (!first) return thread;
  const key = letters.find((l) => l.key)?.key;
  const subject = first.subject.replace(/^(Re:\s*)+/i, "");
  const title = key && !subject.includes(key) ? `${key} · ${subject}` : subject;
  return title.length > max ? `${title.slice(0, max)}…` : title;
}

// The supervisor touches this file on every loop; the bot treats the team as running
// while it is fresh.
export const HEARTBEAT_FILE = "heartbeat";
export const HEARTBEAT_MAX_AGE_MS = 60_000;

export function fleetAlive(stateDir: string, now = Date.now()): boolean {
  const p = join(stateDir, HEARTBEAT_FILE);
  return existsSync(p) && now - statSync(p).mtimeMs < HEARTBEAT_MAX_AGE_MS;
}

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "./roles.js";

// Gate on session START, as in the CTO fleet: a running session is never interrupted;
// when a limit is hit the letters simply wait in the Inbox (no attempt is counted) until
// the next day, a resume, or an owner override.
// - pause: the whole fleet (state/paused) or one role (state/paused.<role>), set by the
//   owner from Telegram;
// - buckets: "claude" (subscription, $ estimated from tokens) and "codex" (ChatGPT
//   subscription, counted in sessions) with daily caps;
// - override: the owner lifts the caps for the rest of today (pauses still apply).

export type Bucket = Role["engine"];

export interface DailyLimits {
  claudeUsd: number;
  claudeSessions: number;
  codexSessions: number;
}

export interface Ledger {
  claude: { sessions: number; costUsd: number };
  codex: { sessions: number; costUsd: number };
}

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): DailyLimits {
  return {
    claudeUsd: Number(env.FLEET_CLAUDE_DAILY_USD ?? 30),
    claudeSessions: Number(env.FLEET_CLAUDE_DAILY_SESSIONS ?? 80),
    codexSessions: Number(env.FLEET_CODEX_DAILY_SESSIONS ?? 40),
  };
}

function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export class FleetLimits {
  constructor(
    private readonly stateDir: string,
    private readonly limits: DailyLimits = limitsFromEnv(),
  ) {}

  caps(): DailyLimits {
    return { ...this.limits };
  }

  private ledgerPath(now = new Date()): string {
    return join(this.stateDir, "ledger", `${today(now)}.json`);
  }

  ledger(now = new Date()): Ledger {
    try {
      return JSON.parse(readFileSync(this.ledgerPath(now), "utf8"));
    } catch {
      return { claude: { sessions: 0, costUsd: 0 }, codex: { sessions: 0, costUsd: 0 } };
    }
  }

  record(bucket: Bucket, costUsd: number, now = new Date()): void {
    const l = this.ledger(now);
    l[bucket].sessions += 1;
    l[bucket].costUsd += costUsd;
    mkdirSync(join(this.stateDir, "ledger"), { recursive: true });
    writeFileSync(this.ledgerPath(now), JSON.stringify(l, null, 2));
  }

  // --- owner controls
  pause(role?: string): void {
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(join(this.stateDir, role ? `paused.${role}` : "paused"), new Date().toISOString());
  }

  resume(role?: string): void {
    rmSync(join(this.stateDir, role ? `paused.${role}` : "paused"), { force: true });
  }

  pausedRoles(): string[] {
    if (!existsSync(this.stateDir)) return [];
    return readdirSync(this.stateDir)
      .filter((f) => f.startsWith("paused."))
      .map((f) => f.slice("paused.".length));
  }

  isFleetPaused(): boolean {
    return existsSync(join(this.stateDir, "paused"));
  }

  overrideToday(now = new Date()): void {
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(join(this.stateDir, `override.${today(now)}`), new Date().toISOString());
  }

  hasOverride(now = new Date()): boolean {
    return existsSync(join(this.stateDir, `override.${today(now)}`));
  }

  // Why this role may not start a session now, or undefined if it may.
  blockReason(role: Role, now = new Date()): string | undefined {
    if (this.isFleetPaused()) return "флот на паузе";
    if (existsSync(join(this.stateDir, `paused.${role.role}`))) return `роль ${role.role} на паузе`;
    if (this.hasOverride(now)) return undefined;
    const l = this.ledger(now);
    if (role.engine === "claude") {
      if (l.claude.costUsd >= this.limits.claudeUsd) return `дневной лимит Claude ~$${this.limits.claudeUsd} исчерпан`;
      if (l.claude.sessions >= this.limits.claudeSessions) return `дневной лимит сессий Claude (${this.limits.claudeSessions}) исчерпан`;
    } else if (l.codex.sessions >= this.limits.codexSessions) {
      return `дневной лимит сессий Codex (${this.limits.codexSessions}) исчерпан`;
    }
    return undefined;
  }

  summary(now = new Date()): string {
    const l = this.ledger(now);
    const lines = [
      `Claude: ${l.claude.sessions}/${this.limits.claudeSessions} сессий, ~$${l.claude.costUsd.toFixed(2)}/$${this.limits.claudeUsd} (оценка по токенам)`,
      `Codex: ${l.codex.sessions}/${this.limits.codexSessions} сессий`,
    ];
    if (this.hasOverride(now)) lines.push("⚡️ Лимиты сняты владельцем до конца дня");
    if (this.isFleetPaused()) lines.push("⏸ Флот на паузе");
    const roles = this.pausedRoles();
    if (roles.length) lines.push(`⏸ На паузе роли: ${roles.join(", ")}`);
    return lines.join("\n");
  }
}

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Spool, readInbox } from "./fleet/mail.js";
import { fleetAlive } from "./fleet/names.js";
import { OWNER_ADDRESS } from "./fleet/roles.js";
import { fleetHome } from "./fleet/workspace.js";

// One line under the CTO console, like the CTO's own:
//   [Opus 5.5 · ctx 84k · $3.21] команда: ▶ 2 · ✉️ 1
// Everything is read defensively — a status line must never throw.

function lastContextTokens(transcriptPath?: string): number | undefined {
  if (!transcriptPath || !existsSync(transcriptPath)) return undefined;
  const lines = readFileSync(transcriptPath, "utf8").trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 200; i--) {
    try {
      const e = JSON.parse(lines[i]);
      const u = e?.message?.usage;
      if (e?.type === "assistant" && u) return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    } catch {
      /* skip */
    }
  }
  return undefined;
}

export function ctoStatusLine(stdinJson: string, stateDir = join(fleetHome(), "state"), spool = new Spool()): string {
  let s: Record<string, any> = {};
  try {
    s = JSON.parse(stdinJson || "{}");
  } catch {
    /* empty */
  }
  const parts: string[] = [];
  if (s.model?.display_name) parts.push(String(s.model.display_name));
  const ctx = lastContextTokens(s.transcript_path);
  if (ctx !== undefined) parts.push(`ctx ${Math.round(ctx / 1000)}k`);
  if (typeof s.cost?.total_cost_usd === "number") parts.push(`$${s.cost.total_cost_usd.toFixed(2)}`);

  let team: string;
  try {
    if (!fleetAlive(stateDir)) team = "команда: не запущена";
    else {
      const running = existsSync(stateDir) ? readdirSync(stateDir).filter((f) => f.startsWith("running.")).length : 0;
      const paused = existsSync(join(stateDir, "paused"));
      team = `команда: ${paused ? "⏸ пауза" : `▶ ${running}`}`;
    }
    const mail = readInbox(spool, OWNER_ADDRESS).filter((l) => !l.kind).length;
    team += ` · ✉️ ${mail}`;
  } catch {
    team = "команда: ?";
  }
  return `${parts.length ? `[${parts.join(" · ")}] ` : ""}${team}`;
}

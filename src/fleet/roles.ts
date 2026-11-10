import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADDRESS_RE } from "./mail.js";

// Fleet roles, one roles/<role>.json each (plus roles/<role>.md — the role's own
// instructions — and roles/_protocol.md, shared by every role). Same idea as the CTO
// fleet's identity yaml: model, rights, timeout, who may write to the role.

export const OWNER_ADDRESS = "xentra/owner";

export interface Role {
  role: string;
  mail: string;
  engine: "claude" | "codex";
  model: string;
  effort?: string; // codex only
  access: "read" | "edit";
  sessionTimeoutMs: number;
  defaultRepo: "backend" | "frontend";
  // Empty = anyone may write; otherwise only these senders (others are refused, the
  // sender is told once, the letter archived).
  acceptFrom: string[];
  // May ask the owner to push the thread branch and open an MR (<push/>).
  canRequestPush: boolean;
  description: string;
  instructions: string;
}

export const ROLES_DIR = fileURLToPath(new URL("../../roles/", import.meta.url));

export function parseDuration(text: string): number {
  const m = /^(\d+)\s*(m|h)$/.exec(text.trim());
  if (!m) throw new Error(`bad duration: ${text} (use 45m or 5h)`);
  return Number(m[1]) * (m[2] === "h" ? 3_600_000 : 60_000);
}

export function parseRole(raw: unknown, instructions: string): Role {
  const r = raw as Record<string, unknown>;
  const str = (k: string): string => {
    if (typeof r[k] !== "string" || !r[k]) throw new Error(`role field ${k} is required`);
    return r[k] as string;
  };
  const role = str("role");
  if (!/^[a-z0-9-]+$/.test(role)) throw new Error(`bad role name: ${role}`);
  const mail = typeof r.mail === "string" ? r.mail : `xentra/${role}`;
  if (!ADDRESS_RE.test(mail)) throw new Error(`bad mail address for ${role}: ${mail}`);
  const engine = str("engine");
  if (engine !== "claude" && engine !== "codex") throw new Error(`bad engine for ${role}: ${engine}`);
  const access = str("access");
  if (access !== "read" && access !== "edit") throw new Error(`bad access for ${role}: ${access}`);
  if (engine === "codex" && access === "edit") throw new Error(`${role}: codex roles are read-only`);
  const defaultRepo = (r.defaultRepo ?? "backend") as string;
  if (defaultRepo !== "backend" && defaultRepo !== "frontend") throw new Error(`bad defaultRepo for ${role}`);
  const acceptFrom = Array.isArray(r.acceptFrom) ? (r.acceptFrom as unknown[]).map(String) : [];
  for (const a of acceptFrom) if (!ADDRESS_RE.test(a)) throw new Error(`bad acceptFrom address for ${role}: ${a}`);
  return {
    role,
    mail,
    engine,
    model: str("model"),
    effort: typeof r.effort === "string" ? r.effort : undefined,
    access,
    sessionTimeoutMs: parseDuration(typeof r.sessionTimeout === "string" ? r.sessionTimeout : "5h"),
    defaultRepo,
    acceptFrom,
    canRequestPush: r.canRequestPush === true,
    description: typeof r.description === "string" ? r.description : "",
    instructions,
  };
}

export function loadRoles(dir = ROLES_DIR): Role[] {
  if (!existsSync(dir)) throw new Error(`roles dir not found: ${dir}`);
  const protocolPath = join(dir, "_protocol.md");
  const protocol = existsSync(protocolPath) ? readFileSync(protocolPath, "utf8") : "";
  const roles: Role[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const mdPath = join(dir, f.replace(/\.json$/, ".md"));
    const own = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
    const role = parseRole(raw, [protocol, own].filter(Boolean).join("\n\n"));
    if (`${role.role}.json` !== f) throw new Error(`${f}: role name must match the file name`);
    roles.push(role);
  }
  const mails = new Set<string>();
  for (const r of roles) {
    if (r.mail === OWNER_ADDRESS) throw new Error(`${r.role}: ${OWNER_ADDRESS} is reserved for the owner`);
    if (mails.has(r.mail)) throw new Error(`duplicate mail address: ${r.mail}`);
    mails.add(r.mail);
  }
  return roles;
}

export function senderAllowed(role: Role, from: string): boolean {
  // The owner may always write; acceptFrom narrows everyone else.
  return from === OWNER_ADDRESS || role.acceptFrom.length === 0 || role.acceptFrom.includes(from);
}

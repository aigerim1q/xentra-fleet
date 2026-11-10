import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetLimits, limitsFromEnv } from "./limits.js";
import { parseRole } from "./roles.js";
import { Spool, readInbox, send } from "./mail.js";
import { Supervisor } from "./supervisor.js";
import { parseReplyActions } from "./replyActions.js";

const claude = parseRole({ role: "dev-1", engine: "claude", model: "m", access: "edit" }, "");
const codex = parseRole({ role: "auditor-codex", engine: "codex", model: "m", access: "read" }, "");
const caps = { claudeUsd: 1, claudeSessions: 2, codexSessions: 1 };

function withDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "limits-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("limitsFromEnv reads the caps with defaults", () => {
  assert.deepEqual(limitsFromEnv({}), { claudeUsd: 30, claudeSessions: 80, codexSessions: 40 });
  assert.equal(limitsFromEnv({ FLEET_CODEX_DAILY_SESSIONS: "5" }).codexSessions, 5);
});

test("caps block by bucket: sessions, dollars, codex separately", withDir((dir) => {
  const l = new FleetLimits(dir, caps);
  assert.equal(l.blockReason(claude), undefined);
  l.record("claude", 0.2);
  l.record("claude", 0.2);
  assert.match(l.blockReason(claude)!, /сессий Claude/);
  assert.equal(l.blockReason(codex), undefined);
  l.record("codex", 0);
  assert.match(l.blockReason(codex)!, /Codex/);
  const l2 = new FleetLimits(join(dir, "b"), caps);
  l2.record("claude", 1.5);
  assert.match(l2.blockReason(claude)!, /\$1/);
}));

test("override lifts caps for today but not pauses", withDir((dir) => {
  const l = new FleetLimits(dir, caps);
  l.record("claude", 5);
  l.overrideToday();
  assert.equal(l.blockReason(claude), undefined);
  l.pause("dev-1");
  assert.match(l.blockReason(claude)!, /на паузе/);
  l.resume("dev-1");
  l.pause();
  assert.match(l.blockReason(codex)!, /флот на паузе/);
  l.resume();
  assert.equal(l.blockReason(codex), undefined);
  assert.match(l.summary(), /сняты/);
}));

test("a blocked role keeps its letters and burns no attempts", withDir(async (dir) => {
  const spool = new Spool(join(dir, "mail"));
  const limits = new FleetLimits(join(dir, "state"), caps);
  limits.pause("dev-1");
  let sessions = 0;
  const sup = new Supervisor({
    spool,
    roles: [claude],
    repos: { backend: { kind: "backend", path: "/r", baseBranch: "dev", gates: [] }, frontend: undefined },
    stateDir: join(dir, "state"),
    limits,
    workspace: { ensure: async () => dir, commit: async () => false, gates: async () => ({ passed: true, output: "", gates: [] }), diffStat: async () => "", headSha: async () => "sha1" },
    runSession: async (i) => {
      sessions++;
      const t = `<ack id="${i.batch.primary.id}"/>`;
      return { ok: true, actions: parseReplyActions(t), resultText: t, costUsd: 0.1 };
    },
  });
  send(spool, { from: "xentra/owner", to: ["xentra/dev-1"], subject: "x", body: "" });
  await sup.settle();
  assert.equal(sessions, 0);
  assert.equal(readInbox(spool, "xentra/dev-1").length, 1);
  limits.resume("dev-1");
  await sup.settle();
  assert.equal(sessions, 1);
  assert.equal(limits.ledger().claude.sessions, 1);
  assert.ok(Math.abs(limits.ledger().claude.costUsd - 0.1) < 1e-9);
}));

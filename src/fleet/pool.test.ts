import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spool, readInbox, send } from "./mail.js";
import { OWNER_ADDRESS, loadRoles, parseRole, poolAddresses } from "./roles.js";
import { Supervisor } from "./supervisor.js";
import { parseReplyActions } from "./replyActions.js";
import { writeThreadState, type SessionInput } from "./session.js";
import { FleetLimits } from "./limits.js";

const dev = (n: string) => parseRole({ role: n, engine: "claude", model: "m", access: "edit", pool: "dev" }, "");

function make(dir: string, roles = [dev("dev-1"), dev("dev-2")], limits?: FleetLimits) {
  const spool = new Spool(join(dir, "mail"));
  const inputs: SessionInput[] = [];
  const sup = new Supervisor({
    spool,
    roles,
    repos: { backend: { kind: "backend", path: "/r", baseBranch: "dev", gates: [] }, frontend: undefined },
    stateDir: join(dir, "state"),
    limits,
    workspace: { ensure: async () => dir, commit: async () => false, gates: async () => ({ passed: true, output: "", gates: [] }), diffStat: async () => "", headSha: async () => "s", changes: async () => ({ head: "s", stat: "", text: "" }), integrity: async () => [] },
    runSession: async (i) => {
      inputs.push(i);
      await new Promise((r) => setTimeout(r, 10));
      const t = `<ack id="${i.batch.primary.id}"/>`;
      return { ok: true, actions: parseReplyActions(t), resultText: t, costUsd: 0 };
    },
  });
  return { spool, sup, inputs };
}

test("the shipped devs form the xentra/dev pool", () => {
  assert.deepEqual([...poolAddresses(loadRoles()).entries()].map(([a, rs]) => [a, rs.map((r) => r.role)]), [["xentra/dev", ["dev-1", "dev-2"]]]);
});

test("two independent threads to the pool run on both devs in parallel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pool-"));
  try {
    const { spool, sup, inputs } = make(dir);
    send(spool, { from: OWNER_ADDRESS, to: ["xentra/dev"], subject: "task A", body: "" });
    send(spool, { from: OWNER_ADDRESS, to: ["xentra/dev"], subject: "task B", body: "" });
    await sup.settle();
    assert.deepEqual(inputs.map((i) => i.role.role).sort(), ["dev-1", "dev-2"]);
    assert.equal(readInbox(spool, "xentra/dev").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pool letter in a thread a dev already worked on goes to that dev", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pool-"));
  try {
    const { spool, sup, inputs } = make(dir);
    writeThreadState(join(dir, "state"), "dev-2", "t-known", { sessionId: "x", cwd: "/", model: "m", engine: "claude", updatedAt: "" });
    send(spool, { from: OWNER_ADDRESS, to: ["xentra/dev"], subject: "more", body: "", thread: "t-known" });
    await sup.settle();
    assert.deepEqual(inputs.map((i) => i.role.role), ["dev-2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a paused dev gets no pool work while another dev is free", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pool-"));
  try {
    const limits = new FleetLimits(join(dir, "state"));
    limits.pause("dev-1");
    const { spool, sup, inputs } = make(dir, undefined, limits);
    send(spool, { from: OWNER_ADDRESS, to: ["xentra/dev"], subject: "task", body: "" });
    await sup.settle();
    assert.deepEqual(inputs.map((i) => i.role.role), ["dev-2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

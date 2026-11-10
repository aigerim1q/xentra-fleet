import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvePush, declinePush, fileRequest, loadPush } from "./pushRequests.js";
import { parseReplyActions } from "./replyActions.js";
import { parseRole, loadRoles, OWNER_ADDRESS } from "./roles.js";
import { Spool, readInbox, send } from "./mail.js";
import { Supervisor } from "./supervisor.js";

const tmp = () => mkdtempSync(join(tmpdir(), "push-"));
const base = { thread: "t1", repo: "backend" as const, dir: "/wt", branch: "fleet/t1", baseBranch: "dev", gitlabProjectPath: "saqr/back-ai", title: "XEN-1", requestedBy: "xentra/pm" };

test("approve pushes, opens the MR once, and a second push reuses it", async () => {
  const dir = tmp();
  try {
    const calls: string[] = [];
    const deps = {
      push: async (d: string, b: string) => void calls.push(`push ${d} ${b}`),
      createMr: async () => {
        calls.push("mr");
        return { iid: 42, webUrl: "https://g/mr/42" };
      },
    };
    fileRequest(dir, base);
    const r1 = await approvePush(dir, "t1", deps);
    assert.equal(r1.status, "pushed");
    assert.equal(r1.mr?.iid, 42);
    await assert.rejects(approvePush(dir, "t1", deps), /уже обработан/);
    fileRequest(dir, { ...base, title: "XEN-1 fixes" });
    assert.equal(loadPush(dir, "t1")!.mr?.iid, 42);
    await approvePush(dir, "t1", deps);
    assert.deepEqual(calls, ["push /wt fleet/t1", "mr", "push /wt fleet/t1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed push is recorded with its error; decline only touches a pending request", async () => {
  const dir = tmp();
  try {
    fileRequest(dir, base);
    const r = await approvePush(dir, "t1", { push: async () => { throw new Error("rejected by remote"); }, createMr: async () => ({ iid: 1, webUrl: "" }) });
    assert.equal(r.status, "failed");
    assert.match(r.error!, /rejected/);
    assert.equal(declinePush(dir, "t1")!.status, "failed");
    fileRequest(dir, base);
    assert.equal(declinePush(dir, "t1")!.status, "declined");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseReplyActions reads <push title>", () => {
  assert.deepEqual(parseReplyActions('<push title="XEN-1: фильтр"/>').push, { title: "XEN-1: фильтр" });
  assert.equal(parseReplyActions("<push/>").push, undefined);
});

test("only pm may request a push; the request goes to the owner with the diffstat", async () => {
  assert.equal(loadRoles().find((r) => r.role === "pm")!.canRequestPush, true);
  assert.equal(loadRoles().find((r) => r.role === "dev-1")!.canRequestPush, false);
  const dir = tmp();
  try {
    const spool = new Spool(join(dir, "mail"));
    const stateDir = join(dir, "state");
    const pm = parseRole({ role: "pm", engine: "claude", model: "m", access: "read", canRequestPush: true }, "");
    const dev = parseRole({ role: "dev-1", engine: "claude", model: "m", access: "edit" }, "");
    const sup = new Supervisor({
      spool,
      roles: [pm, dev],
      repos: { backend: { kind: "backend", path: "/r", baseBranch: "dev", gates: [], gitlabProjectPath: "saqr/back-ai" }, frontend: undefined },
      stateDir,
      workspace: { ensure: async () => "/wt", commit: async () => false, gates: async () => ({ passed: true, output: "", gates: [] }), diffStat: async () => " a.ts | 1 +" },
      runSession: async (i) => {
        const t = `<push title="XEN-1"/><ack id="${i.batch.primary.id}"/>`;
        return { ok: true, actions: parseReplyActions(t), resultText: t, costUsd: 0 };
      },
    });
    const l = send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm", "xentra/dev-1"], subject: "go", body: "" });
    await sup.settle();
    const req = loadPush(stateDir, l.thread)!;
    assert.equal(req.status, "pending");
    assert.equal(req.requestedBy, "xentra/pm");
    const owner = readInbox(spool, OWNER_ADDRESS).filter((x) => x.subject.startsWith("Запрос на push"));
    assert.equal(owner.length, 1);
    assert.match(owner[0].body, /a\.ts \| 1 \+/);
    // dev-1 asked too, but has no right: it got a problem letter instead and acked it
    assert.equal(readInbox(spool, "xentra/dev-1").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

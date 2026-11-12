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
      headSha: async () => "sha1",
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
    const r = await approvePush(dir, "t1", { push: async () => { throw new Error("rejected by remote"); }, createMr: async () => ({ iid: 1, webUrl: "" }), headSha: async () => "sha1" });
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
    const auditor = parseRole({ role: "auditor", engine: "claude", model: "m", access: "read", auditor: true }, "");
    const auditorCodex = parseRole({ role: "auditor-codex", engine: "codex", model: "m", access: "read", auditor: true }, "");
    const sup = new Supervisor({
      spool,
      roles: [pm, dev, auditor, auditorCodex],
      repos: { backend: { kind: "backend", path: "/r", baseBranch: "dev", gates: [], gitlabProjectPath: "saqr/back-ai" }, frontend: undefined },
      stateDir,
      workspace: { ensure: async () => "/wt", commit: async () => false, gates: async () => ({ passed: true, output: "", gates: [{ name: "test", passed: true }] }), diffStat: async () => " a.ts | 1 +", headSha: async () => "sha1", changes: async () => ({ head: "sha1", stat: "", text: "" }), integrity: async () => [] },
      runSession: async (i) => {
        // dev asks for gates once (on the owner's letter), then just acks; pm asks for a push.
        const t =
          i.role.role === "pm"
            ? `<push title="XEN-1"/><ack id="${i.batch.primary.id}"/>`
            : `${i.batch.primary.from === OWNER_ADDRESS ? "<gates/>" : ""}<ack id="${i.batch.primary.id}"/>`;
        return { ok: true, actions: parseReplyActions(t), resultText: t, costUsd: 0 };
      },
    });
    const { recordVerdict } = await import("./mergeBot.js");
    const l = send(spool, { from: OWNER_ADDRESS, to: ["xentra/dev-1"], subject: "go", body: "" });
    await sup.settle(); // gates ran on sha1
    recordVerdict(stateDir, l.thread, "auditor", "sha1", "БЛОКИРУЮЩИЕ:\nНЕТ\n\nВЕРДИКТ: OK");
    recordVerdict(stateDir, l.thread, "auditor-codex", "old0", "БЛОКИРУЮЩИЕ:\n- x\n\nВЕРДИКТ: BLOCK");
    send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm", "xentra/dev-1"], subject: "push it", body: "", thread: l.thread });
    await sup.settle();
    const req = loadPush(stateDir, l.thread)!;
    assert.equal(req.status, "pending");
    assert.equal(req.requestedBy, "xentra/pm");
    assert.equal(req.headSha, "sha1", "the request is pinned to the head the owner sees");
    const owner = readInbox(spool, OWNER_ADDRESS).filter((x) => x.subject.startsWith("Запрос на push"));
    assert.equal(owner.length, 1);
    assert.match(owner[0].body, /a\.ts \| 1 \+/);
    assert.match(owner[0].body, /Коммит sha1/);
    assert.match(owner[0].body, /Гейты на sha1: зелёные \(test ✅\)/);
    assert.match(owner[0].body, /auditor: OK ✅ на sha1/);
    assert.match(owner[0].body, /auditor-codex: смотрел другой коммит \(old0: BLOCK\)/);
    // dev-1 asked too, but has no right: it got a problem letter instead and acked it
    assert.equal(readInbox(spool, "xentra/dev-1").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approve refuses when the branch head moved since the request, and asks for a new one", async () => {
  const dir = tmp();
  try {
    const pushed: string[] = [];
    const deps = { push: async (_d: string, b: string) => void pushed.push(b), createMr: async () => ({ iid: 1, webUrl: "https://g/mr/1" }), headSha: async () => "newhead1" };
    fileRequest(dir, { ...base, headSha: "oldhead1" });
    const r = await approvePush(dir, "t1", deps);
    assert.equal(r.status, "stale");
    assert.match(r.error!, /oldhead1 → newhead1/);
    assert.deepEqual(pushed, [], "nothing is pushed");
    await assert.rejects(approvePush(dir, "t1", deps), /уже обработан \(stale\)/);
    fileRequest(dir, { ...base, headSha: "newhead1" });
    assert.equal((await approvePush(dir, "t1", deps)).status, "pushed");
    assert.deepEqual(pushed, ["fleet/t1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

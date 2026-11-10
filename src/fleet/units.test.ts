import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoles, parseDuration, parseRole, senderAllowed, OWNER_ADDRESS } from "./roles.js";
import { parseReplyActions } from "./replyActions.js";
import { pickBatch, pendingOrder, BATCH_LIMIT } from "./gate.js";
import { Spool, send, readInbox, type Letter } from "./mail.js";
import { isHeld, placeHold, quarantine, recentRoleLetters, releaseHold, shouldHold, looksLikeEcho, HOLD_LIMIT } from "./loopGuard.js";

const L = (id: string, extra: Partial<Letter> = {}): Letter => ({
  id, from: "xentra/pm", to: ["xentra/dev-1"], subject: id, priority: "normal",
  date: "2026-11-10T10:00:00+0500", thread: "t1", body: "", ...extra,
});

// --- roles
test("the shipped roles load, with the shared protocol in every role's instructions", () => {
  const roles = loadRoles();
  assert.deepEqual(roles.map((r) => r.role).sort(), ["auditor", "auditor-codex", "dev-1", "dev-2", "pm", "tester"]);
  for (const r of roles) assert.match(r.instructions, /Протокол флота/);
  assert.equal(roles.find((r) => r.role === "auditor-codex")!.engine, "codex");
  assert.equal(roles.find((r) => r.role === "dev-1")!.access, "edit");
  assert.equal(roles.find((r) => r.role === "pm")!.sessionTimeoutMs, 40 * 60000);
});

test("parseRole rejects an editing codex role and bad fields", () => {
  const base = { role: "x", engine: "claude", model: "m", access: "read" };
  assert.throws(() => parseRole({ ...base, engine: "codex", access: "edit" }, ""), /read-only/);
  assert.throws(() => parseRole({ ...base, access: "admin" }, ""), /bad access/);
  assert.throws(() => parseRole({ ...base, acceptFrom: ["nope"] }, ""), /acceptFrom/);
  assert.equal(parseDuration("45m"), 2_700_000);
  assert.throws(() => parseDuration("2 days"));
});

test("senderAllowed: owner always, acceptFrom narrows the rest", () => {
  const r = parseRole({ role: "infra", engine: "claude", model: "m", access: "read", acceptFrom: ["xentra/pm"] }, "");
  assert.equal(senderAllowed(r, OWNER_ADDRESS), true);
  assert.equal(senderAllowed(r, "xentra/pm"), true);
  assert.equal(senderAllowed(r, "xentra/dev-1"), false);
});

// --- reply actions
test("parseReplyActions reads mail, ack and gates blocks", () => {
  const a = parseReplyActions([
    "Готово.",
    '<mail to="xentra/pm, xentra/owner" subject="Итог" priority="high">',
    "Сделал **X**.",
    "</mail>",
    "<ack id='1-abc' note='взял'/>",
    "<gates/>",
    '<mail to="" subject="no recipients">dropped</mail>',
  ].join("\n"));
  assert.equal(a.mails.length, 1);
  assert.deepEqual(a.mails[0].to, ["xentra/pm", "xentra/owner"]);
  assert.equal(a.mails[0].priority, "high");
  assert.equal(a.mails[0].body, "Сделал **X**.");
  assert.deepEqual(a.acks, [{ id: "1-abc", note: "взял" }]);
  assert.equal(a.gates, true);
});

test("parseReplyActions: new thread flag and nothing when there are no blocks", () => {
  assert.equal(parseReplyActions('<mail to="xentra/pm" subject="s" thread="new">b</mail>').mails[0].newThread, true);
  assert.deepEqual(parseReplyActions("просто текст"), { mails: [], acks: [], gates: false });
});

// --- gate
test("pendingOrder: acks out, urgent first, then arrival", () => {
  const out = pendingOrder([L("3-c"), L("1-a"), L("2-b", { priority: "urgent" }), L("0-ack", { kind: "ack" })]);
  assert.deepEqual(out.map((l) => l.id), ["2-b", "1-a", "3-c"]);
});

test("pickBatch takes one (thread, repo) group, primary = owner's letter", () => {
  const b = pickBatch([L("1-a"), L("2-b", { from: OWNER_ADDRESS }), L("3-c"), L("4-d", { thread: "t2" })])!;
  assert.equal(b.thread, "t1");
  assert.equal(b.primary.id, "2-b");
  assert.deepEqual(b.extras.map((l) => l.id), ["1-a", "3-c"]);
});

test("pickBatch caps at BATCH_LIMIT, keeping the newest", () => {
  const many = Array.from({ length: 8 }, (_, i) => L(`${i + 10}-x`));
  const b = pickBatch(many)!;
  assert.equal(1 + b.extras.length, BATCH_LIMIT);
  assert.equal(b.primary.id, "17-x");
  assert.ok(!b.extras.some((l) => l.id === "10-x"));
});

test("pickBatch honours skip and returns undefined when nothing is left", () => {
  assert.equal(pickBatch([L("1-a")], { skip: () => true }), undefined);
  assert.equal(pickBatch([L("1-a", { kind: "auto-ack" })]), undefined);
});

// --- loop guard
test("shouldHold: hard limit, and the early limit only for echo-like letters", () => {
  const short = Array.from({ length: 11 }, (_, i) => L(`${i}-x`, { body: "ok" }));
  const long = Array.from({ length: 11 }, (_, i) => L(`${i}-x`, { body: "x".repeat(400) }));
  assert.equal(shouldHold(short), true);
  assert.equal(shouldHold(long), false);
  assert.equal(shouldHold(Array.from({ length: HOLD_LIMIT + 1 }, (_, i) => L(`${i}-x`, { body: "x".repeat(400) }))), true);
  assert.equal(looksLikeEcho([]), false);
});

test("placeHold wins once; held thread letters are quarantined, owner letters stay", () => {
  const root = mkdtempSync(join(tmpdir(), "spool-"));
  try {
    const spool = new Spool(root);
    for (const a of [OWNER_ADDRESS, "xentra/pm", "xentra/dev-1"]) spool.register(a);
    assert.equal(placeHold(spool, "t1"), true);
    assert.equal(placeHold(spool, "t1"), false);
    assert.equal(isHeld(spool, "t1"), true);
    const fromRole = send(spool, { from: "xentra/pm", to: ["xentra/dev-1"], subject: "echo", body: "ok", thread: "t1" });
    const fromOwner = send(spool, { from: OWNER_ADDRESS, to: ["xentra/dev-1"], subject: "stop", body: "", thread: "t1" });
    quarantine(spool, "xentra/dev-1", fromRole);
    quarantine(spool, "xentra/dev-1", fromOwner);
    assert.deepEqual(readInbox(spool, "xentra/dev-1").map((l) => l.id), [fromOwner.id]);
    assert.ok(existsSync(join(root, "Quarantine")));
    assert.equal(readdirSync(join(root, "Quarantine")).length, 1);
    assert.equal(releaseHold(spool, "t1"), true);
    assert.equal(isHeld(spool, "t1"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recentRoleLetters counts role letters of the thread, not acks or other threads", () => {
  const root = mkdtempSync(join(tmpdir(), "spool-"));
  try {
    const spool = new Spool(root);
    for (const a of ["xentra/pm", "xentra/dev-1"]) spool.register(a);
    send(spool, { from: "xentra/pm", to: ["xentra/dev-1"], subject: "a", body: "", thread: "t1" });
    send(spool, { from: "xentra/dev-1", to: ["xentra/pm"], subject: "b", body: "", thread: "t1" });
    send(spool, { from: "xentra/pm", to: ["xentra/dev-1"], subject: "c", body: "", thread: "t2" });
    assert.equal(recentRoleLetters(spool, ["xentra/pm", "xentra/dev-1"], "t1").length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

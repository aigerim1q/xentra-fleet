import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spool, ack, archive, findInInbox, parseLetter, readInbox, send, serializeLetter, slugify, thread } from "./mail.js";

let root: string;
let spool: Spool;
const now = new Date("2026-11-10T10:00:00+05:00");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "spool-"));
  spool = new Spool(root);
  for (const a of ["xentra/owner", "xentra/pm", "xentra/dev-1"]) spool.register(a);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("slugify keeps ascii words, drops the rest, never returns empty", () => {
  assert.equal(slugify("Fix XEN-55: archive filter!"), "fix-xen-55-archive-filter");
  assert.equal(slugify("Привет"), "message");
  assert.ok(slugify("a".repeat(80)).length <= 50);
});

test("serialize/parse round-trips a letter and defaults thread to id", () => {
  const text = serializeLetter({
    id: "1-x", from: "xentra/pm", to: ["xentra/dev-1"], subject: "S: with colon", priority: "high",
    date: "2026-11-10T10:00:00+0500", thread: "1-x", repo: "back-ai", key: "XEN-55", body: "line1\nline2",
  });
  const l = parseLetter(text);
  assert.equal(l.subject, "S: with colon");
  assert.equal(l.priority, "high");
  assert.equal(l.repo, "back-ai");
  assert.equal(l.body, "line1\nline2");
  const noThread = parseLetter(text.replace("thread: 1-x\n", ""));
  assert.equal(noThread.thread, "1-x");
});

test("send delivers to every recipient's Inbox and keeps one copy in Sent", () => {
  const l = send(spool, { from: "xentra/owner", to: ["xentra/pm", "xentra/dev-1"], subject: "Task XEN-55", body: "do it" }, now);
  assert.match(l.id, /^\d+-task-xen-55$/);
  assert.equal(l.thread, l.id);
  assert.equal(readInbox(spool, "xentra/pm").length, 1);
  assert.equal(readInbox(spool, "xentra/dev-1").length, 1);
  assert.deepEqual(readdirSync(spool.dir("Sent", "xentra/owner")), [`${l.id}.md`]);
});

test("send refuses unknown mailboxes and bad header values before writing anything", () => {
  assert.throws(() => send(spool, { from: "xentra/owner", to: ["xentra/nobody"], subject: "x", body: "" }), /unknown mailbox/);
  assert.throws(() => send(spool, { from: "xentra/owner", to: ["xentra/pm"], subject: "x", body: "", key: "bad" }), /bad key/);
  assert.throws(() => send(spool, { from: "xentra/owner", to: ["xentra/pm"], subject: " ", body: "" }), /empty subject/);
  assert.equal(readInbox(spool, "xentra/pm").length, 0);
  assert.equal(readdirSync(spool.dir("Sent", "xentra/owner")).length, 0);
});

test("ids collide-safe within the same second", () => {
  const a = send(spool, { from: "xentra/owner", to: ["xentra/pm"], subject: "same", body: "" }, now);
  const b = send(spool, { from: "xentra/owner", to: ["xentra/pm"], subject: "same", body: "" }, now);
  assert.notEqual(a.id, b.id);
  assert.equal(b.id, `${a.id}-2`);
});

test("archive moves the letter into a dated folder", () => {
  const l = send(spool, { from: "xentra/owner", to: ["xentra/pm"], subject: "x", body: "" }, now);
  assert.equal(archive(spool, "xentra/pm", l.id, now), true);
  assert.equal(findInInbox(spool, "xentra/pm", l.id), undefined);
  assert.ok(existsSync(join(spool.dir("Archive", "xentra/pm"), "2026-11-10", `${l.id}.md`)));
  assert.equal(archive(spool, "xentra/pm", l.id, now), false);
});

test("ack lands in the sender's Acks, never an Inbox, and an ack can't be acked", () => {
  const l = send(spool, { from: "xentra/pm", to: ["xentra/dev-1"], subject: "x", body: "" }, now);
  const a = ack(spool, "xentra/dev-1", l, { note: "взял" }, now);
  assert.equal(a.kind, "ack");
  assert.equal(a.ackOf, l.id);
  assert.equal(a.thread, l.thread);
  assert.equal(readInbox(spool, "xentra/pm").length, 0);
  const files = readdirSync(spool.dir("Acks", "xentra/pm"));
  assert.equal(files.length, 1);
  assert.match(readFileSync(join(spool.dir("Acks", "xentra/pm"), files[0]), "utf8"), /kind: ack/);
  assert.throws(() => ack(spool, "xentra/pm", a), /cannot ack an ack/);
});

test("thread collects letters of one thread from every folder, ordered and de-duplicated", () => {
  const first = send(spool, { from: "xentra/owner", to: ["xentra/pm"], subject: "start", body: "" }, now);
  const reply = send(spool, { from: "xentra/pm", to: ["xentra/owner"], subject: "Re", body: "", thread: first.thread }, new Date(now.getTime() + 1000));
  send(spool, { from: "xentra/owner", to: ["xentra/pm"], subject: "other", body: "" }, now);
  archive(spool, "xentra/pm", first.id, now);
  const t = thread(spool, first.thread);
  assert.deepEqual(t.map((l) => l.id), [first.id, reply.id]);
});

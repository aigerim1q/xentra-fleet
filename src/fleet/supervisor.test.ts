import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spool, parseLetter, readInbox, send, thread } from "./mail.js";
import { parseRole, OWNER_ADDRESS, type Role } from "./roles.js";
import { Supervisor, FLEET_ADDRESS, MAX_ATTEMPTS, MAX_GATE_RUNS, type WorkspaceOps } from "./supervisor.js";
import { parseReplyActions } from "./replyActions.js";
import type { SessionInput, SessionOutcome } from "./session.js";
import { isHeld } from "./loopGuard.js";

let root: string;
let spool: Spool;
let stateDir: string;

const role = (name: string, access: "read" | "edit" = "read", acceptFrom: string[] = []): Role =>
  parseRole({ role: name, engine: "claude", model: "m", access, acceptFrom }, "instructions");

const ws = (calls: string[] = []): WorkspaceOps => ({
  ensure: async (_r, thread) => {
    calls.push(`ensure ${thread}`);
    return join(root, "wt", thread);
  },
  commit: async (dir) => {
    calls.push(`commit ${dir}`);
    return true;
  },
  gates: async () => {
    calls.push("gates");
    return { passed: false, output: "1 failing", gates: [{ name: "test", passed: false }] };
  },
});

const repos = { backend: { kind: "backend" as const, path: "/repo", baseBranch: "dev", gates: [] }, frontend: undefined };

function supervisor(roles: Role[], reply: (i: SessionInput) => string, calls: string[] = []): { sup: Supervisor; inputs: SessionInput[] } {
  const inputs: SessionInput[] = [];
  const sup = new Supervisor({
    spool,
    roles,
    repos,
    stateDir,
    workspace: ws(calls),
    runSession: async (input): Promise<SessionOutcome> => {
      inputs.push(input);
      const text = reply(input);
      return { ok: true, actions: parseReplyActions(text), resultText: text, costUsd: 0 };
    },
  });
  return { sup, inputs };
}

async function drain(sup: Supervisor): Promise<void> {
  await sup.settle();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fleet-"));
  spool = new Spool(join(root, "mail"));
  stateDir = join(root, "state");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("a reply mail is delivered into the same thread and the handled letter archived", async () => {
  const { sup, inputs } = supervisor([role("pm"), role("dev-1", "edit")], (i) =>
    i.role.role === "pm" ? '<mail to="xentra/dev-1" subject="Сделай XEN-1">план</mail>' : `<ack id="${i.batch.primary.id}" note="взял"/>`,
  );
  const task = send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: "XEN-1", body: "задача" });
  await drain(sup);
  assert.deepEqual(inputs.map((i) => i.role.role), ["pm", "dev-1"]);
  assert.equal(readInbox(spool, "xentra/pm").length, 0);
  assert.equal(readInbox(spool, "xentra/dev-1").length, 0);
  const t = thread(spool, task.thread).filter((l) => !l.kind);
  assert.deepEqual(t.map((l) => l.from), [OWNER_ADDRESS, "xentra/pm"]);
});

test("an edit role's session is followed by a commit of its worktree", async () => {
  const calls: string[] = [];
  const { sup } = supervisor([role("dev-1", "edit")], (i) => `<ack id="${i.batch.primary.id}"/>`, calls);
  send(spool, { from: OWNER_ADDRESS, to: ["xentra/dev-1"], subject: "x", body: "" });
  await drain(sup);
  assert.ok(calls.some((c) => c.startsWith("commit ")));
});

test("an unanswered letter is retried, then returned to the sender as not done", async () => {
  const { sup, inputs } = supervisor([role("pm")], () => "думаю…");
  const l = send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: "Вопрос", body: "" });
  await drain(sup);
  assert.equal(inputs.length, MAX_ATTEMPTS);
  assert.equal(readInbox(spool, "xentra/pm").length, 0);
  const back = readInbox(spool, OWNER_ADDRESS);
  assert.equal(back.length, 1);
  assert.equal(back[0].from, FLEET_ADDRESS);
  assert.match(back[0].subject, /^Не выполнено: Вопрос/);
  assert.equal(back[0].thread, l.thread);
});

test("a letter from a sender outside acceptFrom is refused without a session", async () => {
  const { sup, inputs } = supervisor([role("infra", "read", ["xentra/pm"]), role("dev-1", "edit")], (i) => `<ack id="${i.batch.primary.id}"/>`);
  send(spool, { from: "xentra/dev-1", to: ["xentra/infra"], subject: "deploy", body: "" });
  await drain(sup);
  assert.ok(!inputs.some((i) => i.role.role === "infra"));
  // dev-1 is a live role too, so it already handled the refusal; check what the fleet sent.
  const sent = readdirSync(spool.dir("Sent", FLEET_ADDRESS));
  assert.equal(sent.length, 1);
  const refusal = parseLetter(readFileSync(join(spool.dir("Sent", FLEET_ADDRESS), sent[0]), "utf8"));
  assert.deepEqual(refusal.to, ["xentra/dev-1"]);
  assert.match(refusal.body, /только от: xentra\/pm/);
});

test("<gates/> runs the gates and mails the result back to the role, capped per thread", async () => {
  const calls: string[] = [];
  let n = 0;
  const { sup } = supervisor(
    [role("dev-1", "edit")],
    (i) => (++n <= MAX_GATE_RUNS + 2 ? `<gates/><ack id="${i.batch.primary.id}"/>` : `<ack id="${i.batch.primary.id}"/>`),
    calls,
  );
  send(spool, { from: OWNER_ADDRESS, to: ["xentra/dev-1"], subject: "x", body: "" });
  await drain(sup);
  assert.equal(calls.filter((c) => c === "gates").length, MAX_GATE_RUNS);
  assert.equal(readInbox(spool, "xentra/dev-1").length, 0);
});

test("a bad address in a reply is reported back to the role instead of failing the session", async () => {
  let first = true;
  const { sup } = supervisor([role("pm")], (i) => {
    if (first) {
      first = false;
      return `<mail to="xentra/nobody" subject="x">y</mail><ack id="${i.batch.primary.id}"/>`;
    }
    return `<ack id="${i.batch.primary.id}"/>`;
  });
  send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: "x", body: "" });
  await drain(sup);
  const sent = readdirSync(spool.dir("Sent", FLEET_ADDRESS));
  assert.equal(sent.length, 1);
  assert.match(readInbox(spool, "xentra/pm").length === 0 ? "ok" : "left", /ok/);
});

test("two roles mailing each other in a loop get the thread put on hold and the owner told", async () => {
  const { sup, inputs } = supervisor([role("pm"), role("dev-1", "edit")], (i) =>
    i.role.role === "pm" ? '<mail to="xentra/dev-1" subject="ок">ок</mail>' : '<mail to="xentra/pm" subject="ок">ок</mail>',
  );
  const l = send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: "start", body: "" });
  await drain(sup);
  assert.equal(isHeld(spool, l.thread), true);
  assert.ok(inputs.length <= 14, `loop should stop early, ran ${inputs.length} sessions`);
  const alert = readInbox(spool, OWNER_ADDRESS).find((x) => /зацикливание/.test(x.subject));
  assert.ok(alert);
  assert.ok(existsSync(join(spool.root, "Quarantine")));
});

test("one thread never runs in two roles at once", async () => {
  const active = new Set<string>();
  let overlap = false;
  const sup = new Supervisor({
    spool,
    roles: [role("auditor"), role("tester")],
    repos,
    stateDir,
    workspace: ws(),
    runSession: async (i) => {
      if (active.has(i.batch.thread)) overlap = true;
      active.add(i.batch.thread);
      await new Promise((r) => setTimeout(r, 20));
      active.delete(i.batch.thread);
      const text = `<ack id="${i.batch.primary.id}"/>`;
      return { ok: true, actions: parseReplyActions(text), resultText: text, costUsd: 0 };
    },
  });
  send(spool, { from: OWNER_ADDRESS, to: ["xentra/auditor", "xentra/tester"], subject: "review", body: "" });
  await drain(sup);
  assert.equal(overlap, false);
  assert.equal(readInbox(spool, "xentra/auditor").length + readInbox(spool, "xentra/tester").length, 0);
});

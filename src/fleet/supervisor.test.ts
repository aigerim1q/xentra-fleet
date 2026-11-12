import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Spool, parseLetter, readInbox, send, thread } from "./mail.js";
import { parseRole, OWNER_ADDRESS, type Role } from "./roles.js";
import { Supervisor, FLEET_ADDRESS, MAX_ATTEMPTS, MAX_GATE_RUNS, isLimitError, retryDelayMs, type WorkspaceOps } from "./supervisor.js";
import { FleetLimits } from "./limits.js";
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
  diffStat: async () => " src/a.ts | 2 +-\n 1 file changed",
  headSha: async () => "sha1",
  changes: async () => ({ head: "sha1", stat: " src/a.ts | 2 +-\n 1 file changed", text: "diff --git a/src/a.ts b/src/a.ts\n+changed" }),
  integrity: async () => [],
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
    backoff: BACKOFF,
    runSession: async (input): Promise<SessionOutcome> => {
      inputs.push(input);
      const text = reply(input);
      return { ok: true, actions: parseReplyActions(text), resultText: text, costUsd: 0 };
    },
  });
  return { sup, inputs };
}

// Real retries pause 30 s → 10 min; tests pause milliseconds.
const BACKOFF = { baseMs: 1, maxMs: 5 };

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

test("a reply that only orders <gates/> takes the letter into work: no retry, the gate result continues the thread", async () => {
  const calls: string[] = [];
  const { sup, inputs } = supervisor(
    [role("dev-1", "edit")],
    (i) => (i.batch.primary.from === FLEET_ADDRESS ? `<ack id="${i.batch.primary.id}"/>` : "<gates/>"),
    calls,
  );
  const l = send(spool, { from: OWNER_ADDRESS, to: ["xentra/dev-1"], subject: "do it", body: "" });
  await drain(sup);
  assert.equal(inputs.filter((i) => i.batch.primary.id === l.id).length, 1, "the owner's letter is not re-run");
  assert.equal(calls.filter((c) => c === "gates").length, 1);
  assert.equal(readInbox(spool, "xentra/dev-1").length, 0);
  assert.ok(!readInbox(spool, OWNER_ADDRESS).some((x) => x.subject.startsWith("Не выполнено")));
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

test("a session that throws (e.g. the worktree cannot be created) counts as an attempt and is retried with a pause, then returned as not done", async () => {
  let ensures = 0;
  const sup = new Supervisor({
    spool,
    roles: [role("dev-1", "edit")],
    repos,
    stateDir,
    backoff: { baseMs: 30, maxMs: 1000 },
    workspace: {
      ...ws(),
      ensure: async () => {
        ensures++;
        throw new Error("fatal: '/repo' is not a git repository");
      },
    },
    runSession: async () => {
      throw new Error("must not run without a worktree");
    },
  });
  const l = send(spool, { from: OWNER_ADDRESS, to: ["xentra/dev-1"], subject: "x", body: "" });
  const t0 = Date.now();
  await drain(sup);
  const elapsed = Date.now() - t0;
  assert.equal(ensures, MAX_ATTEMPTS, "one attempt per try, no hot loop");
  assert.ok(elapsed >= 30 + 60, `retries must wait out the backoff (30 + 60 ms), took ${elapsed}ms`);
  assert.equal(readInbox(spool, "xentra/dev-1").length, 0);
  const back = readInbox(spool, OWNER_ADDRESS);
  assert.equal(back.length, 1);
  assert.match(back[0].subject, /^Не выполнено: x/);
  assert.match(back[0].body, /not a git repository/);
  assert.equal(back[0].thread, l.thread);
});

test("retry pauses grow exponentially and are capped; limit/auth errors are recognised", () => {
  assert.equal(retryDelayMs(1, { baseMs: 10, maxMs: 100 }), 10);
  assert.equal(retryDelayMs(2, { baseMs: 10, maxMs: 100 }), 20);
  assert.equal(retryDelayMs(3, { baseMs: 10, maxMs: 100 }), 40);
  assert.equal(retryDelayMs(9, { baseMs: 10, maxMs: 100 }), 100);
  assert.equal(retryDelayMs(1), 30_000);
  for (const m of ["You're out of usage credits", "Rate limit reached", "HTTP 429 Too Many Requests", "Not logged in · Please run /login", "Invalid API key"]) {
    assert.ok(isLimitError(m), m);
  }
  for (const m of ["TypeError: x is undefined", "No conversation found", "claude exited with code 1: boom", undefined]) {
    assert.ok(!isLimitError(m), String(m));
  }
});

test("an engine limit error pauses the fleet and tells the owner; the letter waits and burns no attempt", async () => {
  const limits = new FleetLimits(stateDir, { claudeUsd: 100, claudeSessions: 100, codexSessions: 100 });
  let sessions = 0;
  const sup = new Supervisor({
    spool,
    roles: [role("pm")],
    repos,
    stateDir,
    limits,
    backoff: BACKOFF,
    workspace: ws(),
    runSession: async () => {
      sessions++;
      return { ok: false, actions: parseReplyActions(""), resultText: "", error: "claude exited with code 1: You're out of usage credits", costUsd: 0 };
    },
  });
  send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: "Вопрос", body: "" });
  await drain(sup);
  assert.equal(sessions, 1, "no retry storm");
  assert.equal(limits.isFleetPaused(), true);
  assert.equal(readInbox(spool, "xentra/pm").length, 1, "the letter stays for after the pause");
  assert.ok(!existsSync(join(stateDir, "pm")) || !readdirSync(join(stateDir, "pm")).some((f) => f.startsWith("attempts.")), "no attempt counted");
  const owner = readInbox(spool, OWNER_ADDRESS);
  assert.equal(owner.length, 1);
  assert.match(owner[0].subject, /Флот на паузе/);
  assert.match(owner[0].body, /out of usage credits/);
});

test("roles without a shell get the thread's diff and head sha in their session input; editing roles don't", async () => {
  const { sup, inputs } = supervisor([role("auditor"), role("dev-1", "edit")], (i) => `<ack id="${i.batch.primary.id}"/>`);
  send(spool, { from: OWNER_ADDRESS, to: ["xentra/auditor", "xentra/dev-1"], subject: "review", body: "" });
  await drain(sup);
  const auditor = inputs.find((i) => i.role.role === "auditor")!;
  assert.equal(auditor.changes?.head, "sha1");
  assert.match(auditor.changes!.stat, /src\/a\.ts/);
  assert.match(auditor.changes!.text, /\+changed/);
  assert.equal(auditor.changes!.truncated, false);
  assert.equal(inputs.find((i) => i.role.role === "dev-1")!.changes, undefined);
});

test("<gates/> on a diff that weakens the checks (deleted test, .skip, gate config) is refused: the gates do not run and the role is told what to revert", async () => {
  const calls: string[] = [];
  let n = 0;
  const sup = new Supervisor({
    spool,
    roles: [role("dev-1", "edit")],
    repos,
    stateDir,
    backoff: BACKOFF,
    workspace: { ...ws(calls), integrity: async () => ["удалён тестовый файл: src/a.spec.ts", "добавлен skip/only/todo в тест: src/b.spec.ts"] },
    runSession: async (i) => {
      const text = ++n === 1 ? `<gates/><ack id="${i.batch.primary.id}"/>` : `<ack id="${i.batch.primary.id}"/>`;
      return { ok: true, actions: parseReplyActions(text), resultText: text, costUsd: 0 };
    },
  });
  send(spool, { from: OWNER_ADDRESS, to: ["xentra/dev-1"], subject: "x", body: "" });
  await drain(sup);
  assert.ok(!calls.includes("gates"), "gates must not run on a tampered diff");
  const sent = readdirSync(spool.dir("Sent", FLEET_ADDRESS)).map((f) => parseLetter(readFileSync(join(spool.dir("Sent", FLEET_ADDRESS), f), "utf8")));
  const verdict = sent.find((l) => l.subject === "Гейты: есть красные")!;
  assert.match(verdict.body, /ослаблены сами проверки/);
  assert.match(verdict.body, /удалён тестовый файл: src\/a\.spec\.ts/);
});

test("a commit that fails (hook) is reported to the role as uncommitted edits, not swallowed", async () => {
  let n = 0;
  const sup = new Supervisor({
    spool,
    roles: [role("dev-1", "edit")],
    repos,
    stateDir,
    backoff: BACKOFF,
    workspace: {
      ...ws(),
      commit: async () => {
        throw new Error("git commit failed: hook says no");
      },
    },
    runSession: async (i) => {
      const text = `<ack id="${i.batch.primary.id}"/>`;
      n++;
      return { ok: true, actions: parseReplyActions(text), resultText: text, costUsd: 0 };
    },
  });
  send(spool, { from: OWNER_ADDRESS, to: ["xentra/dev-1"], subject: "x", body: "" });
  await drain(sup);
  assert.ok(n >= 1);
  const sent = readdirSync(spool.dir("Sent", FLEET_ADDRESS)).map((f) => parseLetter(readFileSync(join(spool.dir("Sent", FLEET_ADDRESS), f), "utf8")));
  const problem = sent.find((l) => l.subject === "Не всё из ответа выполнено")!;
  assert.match(problem.body, /правки не закоммичены \(git commit failed: hook says no\)/);
});

test("the owner interrupts a running session: it is killed, edits are saved as a WIP checkpoint, the letter goes back as not done", async () => {
  const { requestKill } = await import("./lock.js");
  const calls: string[] = [];
  let abort: ((err: Error) => void) | undefined;
  const sup = new Supervisor({
    spool,
    roles: [role("dev-1", "edit")],
    repos,
    stateDir,
    backoff: BACKOFF,
    pollMs: 20,
    workspace: {
      ...ws(),
      commit: async (_d, message) => {
        calls.push(`commit ${message.split("\n")[0]}`);
        return true;
      },
    },
    killSession: () => {
      abort?.(new Error("claude killed by SIGTERM"));
      return true;
    },
    runSession: async () => {
      try {
        await new Promise<void>((_r, reject) => (abort = reject));
      } catch (err) {
        return { ok: false, actions: parseReplyActions(""), resultText: "", error: (err as Error).message, costUsd: 0.12 };
      }
      throw new Error("unreachable");
    },
  });
  const l = send(spool, { from: OWNER_ADDRESS, to: ["xentra/dev-1"], subject: "долгая задача", body: "" });
  sup.start();
  try {
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(existsSync(join(stateDir, "running.dev-1")), "a session is running");
    requestKill(stateDir, "dev-1");
    await new Promise((r) => setTimeout(r, 150));
  } finally {
    await sup.stop({ graceMs: 500 });
  }
  assert.ok(calls.some((c) => /^commit wip: checkpoint/.test(c)), `WIP checkpoint expected, got ${JSON.stringify(calls)}`);
  assert.equal(readInbox(spool, "xentra/dev-1").length, 0, "the letter is not retried");
  const back = readInbox(spool, OWNER_ADDRESS);
  assert.equal(back.length, 1);
  assert.match(back[0].subject, /^Не выполнено: долгая задача/);
  assert.match(back[0].body, /прервал владелец/);
  assert.equal(back[0].thread, l.thread);
  assert.ok(!existsSync(join(stateDir, "running.dev-1")));
});

test("stop() waits for sessions only up to the grace period, then kills them", async () => {
  let abort: ((err: Error) => void) | undefined;
  let killed = 0;
  const sup = new Supervisor({
    spool,
    roles: [role("pm")],
    repos,
    stateDir,
    backoff: BACKOFF,
    pollMs: 20,
    workspace: ws(),
    killSession: () => {
      killed++;
      abort?.(new Error("claude killed by SIGTERM"));
      return true;
    },
    runSession: async () => {
      try {
        await new Promise<void>((_r, reject) => (abort = reject));
      } catch (err) {
        return { ok: false, actions: parseReplyActions(""), resultText: "", error: (err as Error).message, costUsd: 0 };
      }
      throw new Error("unreachable");
    },
  });
  send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: "x", body: "" });
  sup.start();
  await new Promise((r) => setTimeout(r, 60));
  const t0 = Date.now();
  await sup.stop({ graceMs: 100 });
  assert.ok(Date.now() - t0 < 2000, "stop must not wait for the 5-hour session");
  assert.equal(killed, 1);
});

test("start() removes stale running markers left by a crashed supervisor", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "running.pm"), JSON.stringify({ thread: "old", startedAt: "x" }));
  const { sup } = supervisor([role("pm")], (i) => `<ack id="${i.batch.primary.id}"/>`);
  sup.start();
  try {
    assert.ok(!existsSync(join(stateDir, "running.pm")));
  } finally {
    await sup.stop({ graceMs: 100 });
  }
});

test("the per-thread gate budget starts over when new work arrives from the owner or another role", async () => {
  const calls: string[] = [];
  const { sup } = supervisor(
    [role("dev-1", "edit")],
    // gates on the owner's letters and on gate results; a "not done" problem notice is just acked
    (i) => (i.batch.primary.subject.startsWith("Не всё") ? `<ack id="${i.batch.primary.id}"/>` : `<gates/><ack id="${i.batch.primary.id}"/>`),
    calls,
  );
  const l = send(spool, { from: OWNER_ADDRESS, to: ["xentra/dev-1"], subject: "x", body: "" });
  await drain(sup);
  const first = calls.filter((c) => c === "gates").length;
  assert.equal(first, MAX_GATE_RUNS, "capped once the budget is spent");
  send(spool, { from: OWNER_ADDRESS, to: ["xentra/dev-1"], subject: "ещё правка", body: "", thread: l.thread });
  await drain(sup);
  assert.ok(calls.filter((c) => c === "gates").length > first, "a new owner letter re-opens the budget");
});

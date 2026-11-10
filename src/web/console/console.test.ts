import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
const old = { mail: process.env.FLEET_MAIL_DIR, home: process.env.FLEET_HOME };
before(() => {
  home = mkdtempSync(join(tmpdir(), "console-"));
  process.env.FLEET_HOME = home;
  process.env.FLEET_MAIL_DIR = join(home, "mail");
});
after(() => {
  process.env.FLEET_HOME = old.home;
  process.env.FLEET_MAIL_DIR = old.mail;
  rmSync(home, { recursive: true, force: true });
});

let ctxN = 0;
// Each test gets its own spool and state, so letters of one test never count in another.
async function ctx() {
  ctxN++;
  process.env.FLEET_MAIL_DIR = join(home, `mail-${ctxN}`);
  const { Spool } = await import("../../fleet/mail.js");
  const { FleetLimits } = await import("../../fleet/limits.js");
  const { parseRole } = await import("../../fleet/roles.js");
  const spool = new Spool();
  for (const a of ["xentra/owner", "xentra/pm", "xentra/dev-1", "xentra/fleet"]) spool.register(a);
  const stateDir = join(home, `state-${ctxN}`);
  mkdirSync(stateDir, { recursive: true });
  return {
    spool,
    stateDir,
    harnessDir: join(home, "harness"),
    roles: [
      parseRole({ role: "pm", engine: "claude", model: "opus", access: "read" }, ""),
      parseRole({ role: "dev-1", engine: "claude", model: "sonnet", access: "edit" }, ""),
    ],
    limits: new FleetLimits(stateDir),
  };
}

test("the page script parses as a module (no syntax errors reach the browser)", async () => {
  const { CONSOLE_JS } = await import("./assets.js");
  const f = join(home, "app.mjs");
  writeFileSync(f, CONSOLE_JS);
  execFileSync(process.execPath, ["--check", f]);
});

test("the page never injects data as HTML", async () => {
  const { CONSOLE_JS } = await import("./assets.js");
  assert.doesNotMatch(CONSOLE_JS, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
});

test("roles, decisions and tasks reflect the fleet's files, with plain names", async () => {
  const c = await ctx();
  const { send } = await import("../../fleet/mail.js");
  const { rolesView, decisionsView, tasksView, threadDetail } = await import("./data.js");
  const task = send(c.spool, { from: "xentra/owner", to: ["xentra/pm"], subject: "Фильтр архива", body: "сделай", key: "XEN-9" });
  send(c.spool, { from: "xentra/pm", to: ["xentra/owner"], subject: "Вопрос", body: "как быть?", thread: task.thread });
  writeFileSync(join(c.stateDir, "running.dev-1"), JSON.stringify({ thread: task.thread, startedAt: new Date().toISOString() }));

  const roles = rolesView(c);
  const dev = roles.find((r) => r.role === "dev-1")!;
  assert.equal(dev.state, "работает");
  assert.equal(dev.name, "Разработчик 1");
  assert.equal(dev.current!.title, "XEN-9 · Фильтр архива");

  const d = decisionsView(c, [{ kind: "approval", issueKey: "XEN-1", title: "t" }]);
  assert.equal(d.letters.length, 1);
  assert.equal(d.letters[0].fromName, "Зам. CTO");
  assert.equal(d.conveyor.length, 1);

  const tasks = tasksView(c);
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].working, ["Разработчик 1"]);
  assert.equal(tasks[0].waitingOwner, true);
  assert.equal(tasks[0].key, "XEN-9");

  const detail = threadDetail(c, task.thread);
  assert.deepEqual(detail.letters.map((l) => l.from), ["Ты", "Зам. CTO"]);
});

test("sessionTail serves listed journals only — no arbitrary file reads", async () => {
  const c = await ctx();
  const { sessionTail, sessionsView } = await import("./data.js");
  const dir = join(c.stateDir, "tasks", "XEN-1", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-11-10T08-00-00-000Z-dev.jsonl"), JSON.stringify({ type: "system", subtype: "init", session_id: "abcdefgh", model: "m" }) + "\n");
  const [s] = sessionsView(c);
  assert.deepEqual(sessionTail(c, s.id)!.lines, ["▶ сессия abcdefgh · m"]);
  assert.equal(sessionTail(c, s.id, 1)!.lines.length, 0);
  assert.equal(sessionTail(c, Buffer.from("/etc/passwd").toString("base64url")), undefined);
});

test("distribution: stats and the same time buckets as the CTO console", async () => {
  const { distribution } = await import("./data.js");
  const d = distribution([1, 4, 10, 45, 200, 300]);
  assert.equal(d.count, 6);
  assert.equal(d.median, 27.5);
  assert.equal(d.max, 300);
  assert.deepEqual(d.buckets.map((b) => b.n), [2, 1, 0, 1, 0, 1, 1]);
  assert.equal(distribution([]).median, undefined);
});

test("analytics: owner reply time is measured from a role's letter to the owner's next letter in the thread", async () => {
  const c = await ctx();
  const { send } = await import("../../fleet/mail.js");
  const { analyticsView } = await import("./data.js");
  const t0 = new Date(Date.now() - 3_600_000);
  const task = send(c.spool, { from: "xentra/owner", to: ["xentra/pm"], subject: "A", body: "" }, t0);
  send(c.spool, { from: "xentra/pm", to: ["xentra/owner"], subject: "Q", body: "", thread: task.thread }, new Date(t0.getTime() + 60_000));
  send(c.spool, { from: "xentra/owner", to: ["xentra/pm"], subject: "Re", body: "", thread: task.thread }, new Date(t0.getTime() + 11 * 60_000));
  send(c.spool, { from: "xentra/pm", to: ["xentra/owner"], subject: "Q2", body: "", thread: task.thread }, new Date(t0.getTime() + 20 * 60_000));
  const a = analyticsView(c, 14);
  assert.equal(a.ownerReply.count, 1);
  assert.equal(a.ownerReply.median, 10);
  assert.equal(a.ownerReply.unanswered, 1);
});

test("HTTP: page carries the token and a strict CSP; actions need the token; unknown session is 404", async () => {
  const { handleConsole, CSP } = await import("./routes.js");
  const TOKEN = "t".repeat(48);
  const server: Server = createServer((req, res) => {
    if (!handleConsole(req, res, { token: TOKEN, hasValidToken: (r) => r.headers["x-dashboard-token"] === TOKEN })) res.writeHead(418).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const page = await fetch(`${base}/console`);
    assert.equal(page.headers.get("content-security-policy"), CSP);
    assert.match(await page.text(), new RegExp(`content="${TOKEN}"`));
    assert.equal((await fetch(`${base}/api/console/pause`, { method: "POST" })).status, 403);
    assert.equal((await fetch(`${base}/api/console/session?id=${Buffer.from("/etc/passwd").toString("base64url")}`)).status, 404);
    const ok = await fetch(`${base}/api/console/pause`, { method: "POST", headers: { "x-dashboard-token": TOKEN } });
    assert.equal(ok.status, 200);
    const { FleetLimits } = await import("../../fleet/limits.js");
    assert.equal(new FleetLimits(join(home, "state")).isFleetPaused(), true);
    assert.equal((await fetch(`${base}/elsewhere`)).status, 418);
  } finally {
    server.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeMetrics, formatMetrics, readSessions } from "./metrics.js";
import { Spool, send } from "./mail.js";
import { OWNER_ADDRESS, parseRole } from "./roles.js";
import { fileRequest, savePush } from "./pushRequests.js";
import { CI_WATCH_ADDRESS } from "./watchers.js";

const roles = [
  parseRole({ role: "pm", engine: "claude", model: "opus", access: "read" }, ""),
  parseRole({ role: "dev-1", engine: "claude", model: "sonnet", access: "edit" }, ""),
  parseRole({ role: "auditor", engine: "claude", model: "opus", access: "read", auditor: true }, ""),
];

test("metrics: per role/model table, time to MR, returns, owner attention", () => {
  const dir = mkdtempSync(join(tmpdir(), "metrics-"));
  try {
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    const spool = new Spool(join(dir, "mail"));
    for (const a of [OWNER_ADDRESS, "xentra/pm", "xentra/dev-1", "xentra/auditor", CI_WATCH_ADDRESS, "xentra/fleet"]) spool.register(a);
    const t0 = new Date("2026-11-10T08:00:00Z");
    const task = send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: "XEN-1", body: "" }, t0);
    send(spool, { from: "xentra/auditor", to: ["xentra/pm"], subject: "Ревью", body: "БЛОКИРУЮЩИЕ:\n- a.ts:1 — дыра\n\nЗАМЕЧАНИЯ:\nНЕТ", thread: task.thread }, t0);
    send(spool, { from: CI_WATCH_ADDRESS, to: ["xentra/pm"], subject: "CI failed: MR !1", body: "", thread: task.thread }, t0);
    send(spool, { from: "xentra/pm", to: [OWNER_ADDRESS], subject: "Итог", body: "", thread: task.thread }, t0);
    const req = fileRequest(stateDir, { thread: task.thread, repo: "backend", dir: "/", branch: "b", baseBranch: "dev", gitlabProjectPath: "p", title: "t", requestedBy: "xentra/pm" });
    savePush(stateDir, { ...req, status: "pushed", mr: { iid: 1, webUrl: "u" }, firstPushedAt: "2026-11-10T09:30:00Z", decidedAt: "2026-11-10T09:30:00Z" });
    const rec = (role: string, model: string, ok: boolean, cost: number, min: number) =>
      appendFileSync(join(stateDir, "sessions.jsonl"), JSON.stringify({ at: "2026-11-10T08:10:00Z", role, engine: "claude", model, thread: task.thread, letters: 1, durationMs: min * 60000, costUsd: cost, ok }) + "\n");
    rec("dev-1", "sonnet", true, 1, 10);
    rec("dev-1", "sonnet", false, 3, 30);
    rec("pm", "opus", true, 0.5, 2);
    appendFileSync(join(stateDir, "sessions.jsonl"), "{torn\n");
    assert.equal(readSessions(stateDir).length, 3);

    const m = computeMetrics(spool, stateDir, roles, Date.parse("2026-11-01T00:00:00Z"));
    assert.equal(m.sessions, 3);
    assert.ok(Math.abs(m.costUsd - 4.5) < 1e-9);
    const dev = m.byRoleModel.find((r) => r.role === "dev-1")!;
    assert.equal(dev.okRate, 0.5);
    assert.equal(dev.avgDurationMin, 20);
    assert.equal(m.threads.length, 1);
    assert.equal(m.threads[0].timeToMrMin, 90);
    assert.equal(m.threads[0].auditReturns, 1);
    assert.equal(m.threads[0].ciFailures, 1);
    assert.equal(m.returnsPerThread, 2);
    assert.deepEqual(m.owner, { lettersReceived: 1, lettersWritten: 1, pushDecisions: 1 });
    const text = formatMetrics(m);
    assert.match(text, /до MR \(медиана\): 90 мин/);
    assert.match(text, /dev-1 \/ sonnet: 2, 50%/);

    const later = computeMetrics(spool, stateDir, roles, Date.parse("2026-12-01T00:00:00Z"));
    assert.equal(later.sessions, 0);
    assert.equal(later.threads.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSupervisorLock, cleanStaleRunning, requestKill, takeKillRequest, SUPERVISOR_LOCK } from "./lock.js";
import { pidAlive } from "../engine/processGroup.js";

function withDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("only one supervisor per state dir: a live lock refuses, a stale one (dead pid) is taken over, release clears it", withDir((dir) => {
  const release = acquireSupervisorLock(dir, process.pid);
  assert.equal(readFileSync(join(dir, SUPERVISOR_LOCK), "utf8"), String(process.pid));
  assert.throws(() => acquireSupervisorLock(dir, process.pid + 100_000), /another supervisor is running/);
  release();
  assert.ok(!existsSync(join(dir, SUPERVISOR_LOCK)));
  writeFileSync(join(dir, SUPERVISOR_LOCK), "999999"); // no such process
  const release2 = acquireSupervisorLock(dir, process.pid);
  assert.equal(readFileSync(join(dir, SUPERVISOR_LOCK), "utf8"), String(process.pid));
  release2();
}));

test("stale running.<role> markers are removed at start and the orphaned agent process group is killed", withDir(async (dir) => {
  // A detached shell whose child outlives the shell unless the whole group is killed.
  const child = spawn("sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 100));
  const pid = child.pid!;
  writeFileSync(join(dir, "running.dev-1"), JSON.stringify({ thread: "t1", startedAt: "x", pid }));
  writeFileSync(join(dir, "running.pm"), "not json");
  const log: string[] = [];
  const cleaned = cleanStaleRunning(dir, (l) => log.push(l));
  assert.deepEqual(cleaned.map((c) => c.role).sort(), ["dev-1", "pm"]);
  assert.ok(!existsSync(join(dir, "running.dev-1")));
  assert.ok(!existsSync(join(dir, "running.pm")));
  assert.ok(log.some((l) => /dev-1: killed orphaned agent process group/.test(l)), log.join("\n"));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(pidAlive(pid), false, "the orphan must be dead");
}));

test("a kill request is a file the supervisor consumes once", withDir((dir) => {
  assert.equal(takeKillRequest(dir, "dev-1"), false);
  requestKill(dir, "dev-1");
  assert.equal(takeKillRequest(dir, "dev-1"), true);
  assert.equal(takeKillRequest(dir, "dev-1"), false);
}));

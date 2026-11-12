import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonDir, readJsonOr, writeJsonAtomic } from "./atomic.js";
import { fileRequest, listPushes, loadPush } from "./pushRequests.js";
import { addCiWatch, listCiWatches } from "./watchers.js";
import { FleetLimits } from "./limits.js";

test("state is written tmp+rename with no leftovers, and readers tolerate a half-written or corrupt file", () => {
  const dir = mkdtempSync(join(tmpdir(), "atomic-"));
  try {
    writeJsonAtomic(join(dir, "a", "x.json"), { ok: 1 });
    assert.deepEqual(readdirSync(join(dir, "a")), ["x.json"], "no tmp files left behind");
    assert.deepEqual(readJsonOr(join(dir, "a", "x.json"), null), { ok: 1 });
    writeFileSync(join(dir, "a", "bad.json"), '{"thread": "t2", "stat');
    assert.deepEqual(readJsonOr(join(dir, "a", "bad.json"), "fallback"), "fallback");
    const bad: string[] = [];
    assert.deepEqual(readJsonDir(join(dir, "a"), (f) => bad.push(f)), [{ ok: 1 }]);
    assert.deepEqual(bad, ["bad.json"]);

    // push requests: a corrupt file does not take the whole list down
    const base = { thread: "t1", repo: "backend" as const, dir: "/wt", branch: "fleet/t1", baseBranch: "dev", gitlabProjectPath: "p", title: "XEN-1", requestedBy: "xentra/pm" };
    fileRequest(dir, base);
    writeFileSync(join(dir, "push", "broken.json"), "{not json");
    assert.deepEqual(listPushes(dir).map((p) => p.thread), ["t1"]);
    assert.equal(loadPush(dir, "broken"), undefined);
    assert.ok(!readdirSync(join(dir, "push")).some((f) => f.endsWith(".tmp")));

    // ci watches and the ledger: same
    addCiWatch(dir, { thread: "t1", requestedBy: "xentra/pm", projectPath: "p", mrIid: 1 });
    writeFileSync(join(dir, "watch-ci", "zzz.json"), "");
    assert.deepEqual(listCiWatches(dir).map((w) => w.thread), ["t1"]);
    const limits = new FleetLimits(join(dir, "state"), { claudeUsd: 10, claudeSessions: 10, codexSessions: 10 });
    mkdirSync(join(dir, "state", "ledger"), { recursive: true });
    limits.record("claude", 0.5);
    assert.equal(limits.ledger().claude.sessions, 1);
    assert.ok(!readdirSync(join(dir, "state", "ledger")).some((f) => f.endsWith(".tmp")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

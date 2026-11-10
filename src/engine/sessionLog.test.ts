import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskStreamLine, openSessionLog, pruneSessionLogs, sessionLogFileName, withTaskLogScope } from "./sessionLog.js";
import { buildTimeoutCheckpointNote, buildTimeoutResumePrompt } from "./prompts.js";

const secrets = { GITLAB_TOKEN: "glpat-SECRETVALUE123" };

test("maskStreamLine masks secret values inside JSON and keeps it valid JSON", () => {
  const line = JSON.stringify({ type: "user", message: { content: [{ text: "token glpat-SECRETVALUE123 here" }] } });
  const masked = maskStreamLine(line, secrets);
  assert.doesNotMatch(masked, /SECRETVALUE123/);
  assert.match(JSON.parse(masked).message.content[0].text, /\*\*\*cred:GITLAB_TOKEN\*\*\*/);
});

test("maskStreamLine masks a non-JSON line as a whole", () => {
  assert.doesNotMatch(maskStreamLine("raw glpat-SECRETVALUE123", secrets), /SECRETVALUE123/);
});

test("sessionLogFileName is sortable by time and sanitises the label", () => {
  const name = sessionLogFileName("dev/../x", new Date("2026-11-10T08:30:00.000Z"));
  assert.equal(name, "2026-11-10T08-30-00-000Z-dev____x.jsonl");
});

test("openSessionLog writes nothing outside a task scope", () => {
  assert.equal(openSessionLog("dev", secrets), undefined);
});

test("openSessionLog inside a scope writes masked lines to the task's sessions dir", async () => {
  const state = mkdtempSync(join(tmpdir(), "state-"));
  try {
    const path = await withTaskLogScope("XEN-1", state, async () => {
      const log = openSessionLog("pm", secrets)!;
      log.write('{"type":"system","x":"glpat-SECRETVALUE123"}');
      await new Promise<void>((r) => {
        log.close();
        setTimeout(r, 50);
      });
      return log.path;
    });
    assert.ok(path.startsWith(join(state, "tasks", "XEN-1", "sessions")));
    const { readFileSync } = await import("node:fs");
    assert.doesNotMatch(readFileSync(path, "utf8"), /SECRETVALUE123/);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("pruneSessionLogs deletes only old .jsonl journals", () => {
  const state = mkdtempSync(join(tmpdir(), "state-"));
  try {
    const dir = join(state, "tasks", "XEN-2", "sessions");
    mkdirSync(dir, { recursive: true });
    const oldF = join(dir, "old.jsonl");
    const newF = join(dir, "new.jsonl");
    const other = join(dir, "notes.md");
    for (const f of [oldF, newF, other]) writeFileSync(f, "x");
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    utimesSync(oldF, old, old);
    utimesSync(other, old, old);
    assert.equal(pruneSessionLogs(state, 14), 1);
    assert.deepEqual(readdirSync(dir).sort(), ["new.jsonl", "notes.md"]);
    assert.equal(pruneSessionLogs(state, 0), 0);
    assert.ok(existsSync(newF));
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("pruneSessionLogs tolerates a missing state dir", () => {
  assert.equal(pruneSessionLogs(join(tmpdir(), "does-not-exist-xyz"), 14), 0);
});

test("buildTimeoutResumePrompt names the cause and points at the checkpoint commit", () => {
  const idle = buildTimeoutResumePrompt({ kind: "idle", afterMs: 30 * 60000, checkpointCommitted: true });
  assert.match(idle, /no output for 30 min/);
  assert.match(idle, /wip: checkpoint/);
  const ceiling = buildTimeoutResumePrompt({ kind: "ceiling", afterMs: 300 * 60000, checkpointCommitted: false });
  assert.match(ceiling, /300-min time limit/);
  assert.match(ceiling, /no unfinished edits/);
});

test("buildTimeoutCheckpointNote mentions the checkpoint only when there is one", () => {
  assert.match(buildTimeoutCheckpointNote({ checkpointCommitted: true }), /wip: checkpoint/);
  assert.doesNotMatch(buildTimeoutCheckpointNote({ checkpointCommitted: false }), /wip: checkpoint/);
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeTurnLabels, estimateCostUsd, killTurnsByLabel, messageContextTokens, runClaudeTurn, TurnKilledError, TurnTimeoutError } from "./claudeEngine.js";

// A fake `claude` on PATH whose behaviour is picked by FAKE_CLAUDE_MODE.
const SCRIPT = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const mode = process.env.FAKE_CLAUDE_MODE;
out({ type: "system", subtype: "init", session_id: "11111111-2222-3333-4444-555555555555" });
if (mode === "silent") setInterval(() => {}, 1000);
if (mode === "usage-then-silent") {
  out({ type: "assistant", message: { content: [], usage: { input_tokens: 1000, cache_read_input_tokens: 50000, cache_creation_input_tokens: 2000, output_tokens: 500 } } });
  setInterval(() => {}, 1000);
}
if (mode === "chatty") setInterval(() => out({ type: "user", message: { content: [] } }), 20);
if (mode === "ok") {
  const u = (n) => ({ input_tokens: 10, cache_read_input_tokens: n, cache_creation_input_tokens: 5 });
  out({ type: "assistant", message: { content: [], usage: u(1000) } });
  out({ type: "assistant", message: { content: [], usage: u(3000) } });
  out({ type: "result", session_id: "s1", result: "done", is_error: false, total_cost_usd: 0.01,
        usage: { input_tokens: 20, cache_read_input_tokens: 4000, cache_creation_input_tokens: 10, output_tokens: 7 } });
}
`;

let dir: string;
let oldPath: string | undefined;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, SCRIPT);
  chmodSync(bin, 0o755);
  oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
});

after(() => {
  process.env.PATH = oldPath;
  delete process.env.FAKE_CLAUDE_MODE;
  rmSync(dir, { recursive: true, force: true });
});

const base = { cwd: process.cwd(), prompt: "x", permissionMode: "acceptEdits" };

test("a silent stream is killed by the idle watchdog, keeping the session id", async () => {
  process.env.FAKE_CLAUDE_MODE = "silent";
  const err = await runClaudeTurn({ ...base, idleTimeoutMs: 4000, turnTimeoutMs: 20_000 }).catch((e) => e);
  assert.ok(err instanceof TurnTimeoutError);
  assert.equal(err.kind, "idle");
  assert.equal(err.sessionId, "11111111-2222-3333-4444-555555555555");
});

test("a stream that keeps talking is still stopped by the turn ceiling", async () => {
  process.env.FAKE_CLAUDE_MODE = "chatty";
  const started = Date.now();
  const err = await runClaudeTurn({ ...base, idleTimeoutMs: 4000, turnTimeoutMs: 6000 }).catch((e) => e);
  assert.ok(err instanceof TurnTimeoutError);
  assert.equal(err.kind, "ceiling");
  assert.ok(Date.now() - started < 12_000);
});

test("contextTokens is the last model call's context, not the turn's summed usage", async () => {
  process.env.FAKE_CLAUDE_MODE = "ok";
  const turn = await runClaudeTurn({ ...base, idleTimeoutMs: 5000, turnTimeoutMs: 10_000 });
  assert.equal(turn.contextTokens, 10 + 3000 + 5);
  assert.equal(turn.usage.cacheReadInputTokens, 4000);
  assert.equal(turn.resultText, "done");
});

test("messageContextTokens sums input and both cache fields, tolerating gaps", () => {
  assert.equal(messageContextTokens({ input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 }), 6);
  assert.equal(messageContextTokens({ input_tokens: 4 }), 4);
  assert.equal(messageContextTokens(undefined), 0);
});

test("inside a task scope the turn's stream is journaled to sessions/*.jsonl", async () => {
  const { withTaskLogScope } = await import("./sessionLog.js");
  const { readdirSync, readFileSync } = await import("node:fs");
  const state = mkdtempSync(join(tmpdir(), "state-"));
  try {
    process.env.FAKE_CLAUDE_MODE = "ok";
    await withTaskLogScope("XEN-9", state, () => runClaudeTurn({ ...base, logLabel: "dev", idleTimeoutMs: 5000, turnTimeoutMs: 10_000 }));
    const dir = join(state, "tasks", "XEN-9", "sessions");
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /-dev\.jsonl$/);
    const lines = readFileSync(join(dir, files[0]), "utf8").trim().split("\n");
    assert.equal(lines.length, 4); // init, two assistant events, result
    assert.equal(JSON.parse(lines[3]).type, "result");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("a killed turn carries a usage-based cost estimate instead of $0", async () => {
  process.env.FAKE_CLAUDE_MODE = "usage-then-silent";
  const err = await runClaudeTurn({ ...base, model: "claude-sonnet-5-5", idleTimeoutMs: 1500, turnTimeoutMs: 20_000 }).catch((e) => e);
  assert.ok(err instanceof TurnTimeoutError);
  const expected = estimateCostUsd({ input: 1000, cacheRead: 50000, cacheCreation: 2000, output: 500 }, "claude-sonnet-5-5");
  assert.ok(expected > 0);
  assert.equal(err.costUsd, expected);
  assert.ok(estimateCostUsd({ input: 1000, cacheRead: 50000, cacheCreation: 2000, output: 500 }, "claude-opus-5-5") > expected, "opus costs more");
});

test("a turn can be killed by its label (the fleet's «прервать»), ending as TurnKilledError with the session id", async () => {
  process.env.FAKE_CLAUDE_MODE = "usage-then-silent";
  const turn = runClaudeTurn({ ...base, logLabel: "dev-1", idleTimeoutMs: 30_000, turnTimeoutMs: 60_000 });
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(activeTurnLabels().includes("dev-1"));
  assert.equal(killTurnsByLabel("nobody"), false);
  assert.equal(killTurnsByLabel("dev-1"), true);
  const err = await turn.catch((e) => e);
  assert.ok(err instanceof TurnKilledError, String(err));
  assert.equal(err.sessionId, "11111111-2222-3333-4444-555555555555");
  assert.ok(err.costUsd > 0);
  assert.ok(!activeTurnLabels().includes("dev-1"));
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageContextTokens, runClaudeTurn, TurnTimeoutError } from "./claudeEngine.js";

// A fake `claude` on PATH whose behaviour is picked by FAKE_CLAUDE_MODE.
const SCRIPT = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const mode = process.env.FAKE_CLAUDE_MODE;
out({ type: "system", subtype: "init", session_id: "11111111-2222-3333-4444-555555555555" });
if (mode === "silent") setInterval(() => {}, 1000);
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
  const err = await runClaudeTurn({ ...base, idleTimeoutMs: 1500, turnTimeoutMs: 10_000 }).catch((e) => e);
  assert.ok(err instanceof TurnTimeoutError);
  assert.equal(err.kind, "idle");
  assert.equal(err.sessionId, "11111111-2222-3333-4444-555555555555");
});

test("a stream that keeps talking is still stopped by the turn ceiling", async () => {
  process.env.FAKE_CLAUDE_MODE = "chatty";
  const started = Date.now();
  const err = await runClaudeTurn({ ...base, idleTimeoutMs: 1500, turnTimeoutMs: 2500 }).catch((e) => e);
  assert.ok(err instanceof TurnTimeoutError);
  assert.equal(err.kind, "ceiling");
  assert.ok(Date.now() - started < 6000);
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

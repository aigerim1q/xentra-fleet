import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSessionPrompt, describeChanges, type SessionInput } from "./session.js";
import { parseRole } from "./roles.js";
import type { Letter } from "./mail.js";

const letter: Letter = { id: "1-pm-x", from: "xentra/pm", to: ["xentra/auditor"], subject: "Ревью", priority: "normal", date: "2026-11-12T10:00:00+0500", thread: "t1", body: "посмотри" };

function input(changes: SessionInput["changes"]): SessionInput {
  return {
    role: parseRole({ role: "auditor", engine: "claude", model: "m", access: "read" }, "instr"),
    batch: { primary: letter, extras: [], thread: "t1" },
    cwd: "/wt",
    stateDir: "/state",
    history: [],
    changes,
  };
}

test("the prompt shows the thread diff with its head sha; a cut diff is marked as cut, with sizes", () => {
  const short = describeChanges({ head: "abcdef1234567890", stat: " a.ts | 1 +", text: "diff --git a/a.ts b/a.ts\n+x" }, "dev", 1000);
  const p1 = buildSessionPrompt(input(short), false);
  assert.match(p1, /относительно origin\/dev \(HEAD abcdef123456\)/);
  assert.match(p1, /a\.ts \| 1 \+/);
  assert.match(p1, /\+x/);
  assert.doesNotMatch(p1, /обрезан/);

  const long = describeChanges({ head: "abcdef1234567890", stat: " a.ts | 1 +", text: "y".repeat(5000) }, "dev", 1000);
  assert.equal(long.truncated, true);
  assert.equal(long.text.length, 1000);
  const p2 = buildSessionPrompt(input(long), false);
  assert.match(p2, /Diff обрезан: показаны первые 1000 из 5000 символов/);

  const none = describeChanges({ head: "abc", stat: "", text: "" }, "dev");
  assert.match(buildSessionPrompt(input(none), false), /изменений относительно базы нет/);
  assert.doesNotMatch(buildSessionPrompt(input(undefined), false), /Изменения треда/);
});

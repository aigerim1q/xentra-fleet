import { test } from "node:test";
import assert from "node:assert/strict";

// Secrets must be in process.env BEFORE config.ts is evaluated (it reads them at
// import time), so the modules under test are imported dynamically below.
const FAKE_PAT = "jira-pat-0123456789abcdef";
process.env.JIRA_PAT = FAKE_PAT;

const { runGates, establishBaselines } = await import("./verify.js");
const { buildDisallowedTools, withAlwaysDisallowed } = await import("./guardrails.js");

test("gates do not see harness tokens in their environment", async () => {
  // A test the agent wrote could read process.env and send it anywhere; the gate
  // process must not have the token at all.
  const gate = {
    name: "probe",
    command: `node -e "process.stdout.write('pat=' + (process.env.JIRA_PAT ?? 'absent')); process.exit(1)"`,
    strict: true,
  };
  const result = await runGates(".", [gate], await establishBaselines(".", []));
  assert.match(result.gates[0].output, /pat=absent/);
  assert.ok(!result.output.includes(FAKE_PAT));
});

test("gate output is scrubbed of known secret values", async () => {
  // Even if a secret reaches a gate some other way (a file, a fixture), its output is
  // fed back into the agent's prompt and to Telegram — it must not carry the value.
  const gate = { name: "echo", command: `echo leaked:${FAKE_PAT}; exit 1`, strict: true };
  const result = await runGates(".", [gate], []);
  assert.ok(!result.gates[0].output.includes(FAKE_PAT));
});

test("every file-writing tool gets the path deny rules", () => {
  const list = buildDisallowedTools().split(",");
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    assert.ok(list.includes(`${tool}(**/migrations/**)`), `${tool} not denied on migrations`);
    assert.ok(list.includes(`${tool}(**/package.json)`), `${tool} not denied on package.json`);
  }
});

test("network tools are disallowed by default and on read-only overrides", () => {
  const defaults = buildDisallowedTools().split(",");
  assert.ok(defaults.includes("WebFetch") && defaults.includes("WebSearch"));

  const override = withAlwaysDisallowed("Bash,Edit,Write,MultiEdit").split(",");
  assert.ok(override.includes("WebFetch") && override.includes("WebSearch"));
  assert.ok(override.includes("NotebookEdit"));
  // No duplicates when the override already names a tool.
  const dup = withAlwaysDisallowed("WebFetch,Bash").split(",");
  assert.equal(dup.filter((t) => t === "WebFetch").length, 1);
});

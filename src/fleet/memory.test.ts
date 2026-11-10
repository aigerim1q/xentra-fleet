import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMemory, memoryPromptBlock, readMemory, trimEntries } from "./memory.js";
import { parseReplyActions } from "./replyActions.js";
import { parseRole } from "./roles.js";
import { Spool, readInbox, send } from "./mail.js";
import { Supervisor } from "./supervisor.js";
import type { SessionInput } from "./session.js";

const tmp = () => mkdtempSync(join(tmpdir(), "mem-"));

test("appendMemory adds dated entries per role and scrubs secrets", () => {
  const dir = tmp();
  try {
    appendMemory(dir, "thread", "t1", { role: "pm", text: "Решили делать через фильтр" }, {}, new Date("2026-11-10T08:00:00Z"));
    appendMemory(dir, "thread", "t1", { role: "dev-1", text: "токен glpat-SECRETVALUE123" }, { GITLAB_TOKEN: "glpat-SECRETVALUE123" });
    const m = readMemory(dir, "thread", "t1");
    assert.match(m, /## 2026-11-10 08:00 · pm\nРешили делать через фильтр/);
    assert.match(m, /· dev-1/);
    assert.doesNotMatch(m, /SECRETVALUE123/);
    appendMemory(dir, "thread", "t1", { role: "pm", text: "   " });
    assert.equal(readMemory(dir, "thread", "t1"), m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trimEntries drops whole oldest entries first", () => {
  const text = ["## a\n" + "x".repeat(50), "## b\n" + "y".repeat(50), "## c\nz"].join("\n");
  const out = trimEntries(text, 70);
  assert.doesNotMatch(out, /## a/);
  assert.match(out, /## c/);
  assert.ok(out.length <= 70);
});

test("memoryPromptBlock shows thread and each task key, empty ones marked", () => {
  const dir = tmp();
  try {
    appendMemory(dir, "task", "XEN-1", { role: "pm", text: "факт" });
    const b = memoryPromptBlock(dir, "t9", ["XEN-1", "XEN-2", "XEN-1"]);
    assert.match(b, /Память треда t9\n\(пусто\)/);
    assert.match(b, /Память задачи XEN-1\n## .* · pm\nфакт/);
    assert.match(b, /Память задачи XEN-2\n\(пусто\)/);
    assert.equal(b.match(/XEN-1/g)!.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseReplyActions reads memory blocks", () => {
  const a = parseReplyActions('<memory scope="task" key="XEN-5">A</memory><memory>B</memory><memory scope="thread"> </memory>');
  assert.deepEqual(a.memory, [
    { scope: "task", key: "XEN-5", text: "A" },
    { scope: "thread", key: undefined, text: "B" },
  ]);
});

test("supervisor injects memory into the next session and writes the role's memory blocks", async () => {
  const dir = tmp();
  try {
    const spool = new Spool(join(dir, "mail"));
    const stateDir = join(dir, "state");
    const role = parseRole({ role: "pm", engine: "claude", model: "m", access: "read" }, "");
    const inputs: SessionInput[] = [];
    let n = 0;
    const sup = new Supervisor({
      spool,
      roles: [role],
      repos: { backend: { kind: "backend", path: "/r", baseBranch: "dev", gates: [] }, frontend: undefined },
      stateDir,
      workspace: { ensure: async () => dir, commit: async () => false, gates: async () => ({ passed: true, output: "", gates: [] }), diffStat: async () => "" },
      runSession: async (i) => {
        inputs.push(i);
        n++;
        const t =
          n === 1
            ? `<memory>Решение: через фильтр</memory><memory scope="task">Факт о задаче</memory><ack id="${i.batch.primary.id}"/>`
            : `<ack id="${i.batch.primary.id}"/>`;
        return { ok: true, actions: parseReplyActions(t), resultText: t, costUsd: 0 };
      },
    });
    const first = send(spool, { from: "xentra/owner", to: ["xentra/pm"], subject: "XEN-7", body: "", key: "XEN-7" });
    await sup.settle();
    send(spool, { from: "xentra/owner", to: ["xentra/pm"], subject: "ещё", body: "", thread: first.thread, key: "XEN-7" });
    await sup.settle();
    assert.equal(inputs.length, 2);
    assert.match(inputs[1].memory!, /Решение: через фильтр/);
    assert.match(inputs[1].memory!, /Память задачи XEN-7\n## .* · pm\nФакт о задаче/);
    assert.equal(readInbox(spool, "xentra/pm").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

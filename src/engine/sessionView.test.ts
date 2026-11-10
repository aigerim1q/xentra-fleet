import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatEvent, listJournals, sessionInfo, watchJournals } from "./sessionView.js";

const ev = (o: object) => JSON.stringify(o);

test("formatEvent turns stream events into readable lines", () => {
  assert.deepEqual(formatEvent(ev({ type: "system", subtype: "init", session_id: "1234567890", model: "claude-sonnet-5-5" })), ["▶ сессия 12345678 · claude-sonnet-5-5"]);
  assert.deepEqual(
    formatEvent(ev({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } }, { type: "text", text: "Нашёл\nпричину" }] } })),
    ["→ Чтение src/a.ts", "💬 Нашёл причину"],
  );
  assert.deepEqual(formatEvent(ev({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "denied" }] } })), ['  ✖ ошибка инструмента: "denied"']);
  assert.match(formatEvent(ev({ type: "result", is_error: false, total_cost_usd: 0.123, duration_ms: 9000, num_turns: 4 }))[0], /готово · ~\$0\.12 · 9 с · 4 ходов/);
  assert.deepEqual(formatEvent("not json"), []);
  assert.deepEqual(formatEvent(ev({ type: "rate_limit_event" })), []);
});

test("listJournals finds pipeline and fleet journals with task and role", () => {
  const root = mkdtempSync(join(tmpdir(), "view-"));
  try {
    const d = join(root, "a", "tasks", "XEN-5", "sessions");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "2026-11-10T08-00-00-000Z-dev.jsonl"), ev({ type: "system", subtype: "init", session_id: "s-1", cwd: "/wt", model: "m" }) + "\n");
    const f = join(root, "b", "tasks", "fleet-t1", "sessions");
    mkdirSync(f, { recursive: true });
    writeFileSync(join(f, "2026-11-10T09-00-00-000Z-dev-1.jsonl"), "");
    const js = listJournals([join(root, "a"), join(root, "b"), join(root, "missing")]);
    assert.deepEqual(js.map((j) => [j.task, j.label]).sort(), [["XEN-5", "dev"], ["fleet-t1", "dev-1"]]);
    assert.deepEqual(sessionInfo(js.find((j) => j.task === "XEN-5")!.path), { sessionId: "s-1", cwd: "/wt", model: "m" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("watchJournals prints history, then only new whole lines when following", async () => {
  const root = mkdtempSync(join(tmpdir(), "view-"));
  try {
    const d = join(root, "tasks", "XEN-5", "sessions");
    mkdirSync(d, { recursive: true });
    const p = join(d, "2026-11-10T08-00-00-000Z-dev.jsonl");
    writeFileSync(p, ev({ type: "system", subtype: "init", session_id: "abcdefgh", model: "m" }) + "\n");
    const out: string[] = [];
    const stop = watchJournals([root], { follow: true, print: (s) => out.push(s), pollMs: 20 });
    try {
      appendFileSync(p, ev({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "x.ts" } }] } }) + "\n");
      appendFileSync(p, '{"type":"assis'); // half-written line must wait
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(out.some((l) => l === "[XEN-5 dev] ▶ сессия abcdefgh · m"));
      assert.ok(out.some((l) => l === "[XEN-5 dev] → Правка x.ts"));
      assert.equal(out.filter((l) => l.includes("Правка x.ts")).length, 1);
    } finally {
      stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

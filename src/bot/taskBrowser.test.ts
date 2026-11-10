import { test } from "node:test";
import assert from "node:assert/strict";
import { CB, myOpenTasksJql, pageOf, statusIcon, taskButtonLabel, taskCardView, taskListView, transitionsView } from "./taskBrowser.js";
import type { JiraIssue } from "../jira/client.js";

const issue = (n: number, status = "В работе"): JiraIssue => ({ key: `XEN-${n}`, summary: `Task ${n}`, description: "", status });

function buttons(kb: { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> }) {
  return kb.inline_keyboard.flat();
}

test("JQL takes every open task of the owner, not only To Do / In Progress", () => {
  const jql = myOpenTasksJql("XEN");
  assert.match(jql, /assignee = currentUser\(\)/);
  assert.match(jql, /statusCategory != Done/);
  assert.match(jql, /project = XEN/);
});

test("paging clamps out-of-range pages and counts pages", () => {
  const items = Array.from({ length: 17 }, (_, i) => i);
  assert.deepEqual(pageOf(items, 0, 8), { items: [0, 1, 2, 3, 4, 5, 6, 7], page: 0, pages: 3 });
  assert.equal(pageOf(items, 99, 8).page, 2);
  assert.deepEqual(pageOf([], 0, 8), { items: [], page: 0, pages: 1 });
});

test("every callback payload fits Telegram's 64-byte limit", () => {
  for (const data of [CB.list(999), CB.card("XEN-123456"), CB.take("XEN-123456"), CB.statuses("XEN-123456"), CB.transition("XEN-123456", "12345")]) {
    assert.ok(Buffer.byteLength(data) <= 64, data);
  }
});

test("button labels are short and carry key and status icon", () => {
  const label = taskButtonLabel({ ...issue(5, "Review"), summary: "x".repeat(200) });
  assert.ok(label.length <= 60);
  assert.ok(label.startsWith(statusIcon("Review")));
  assert.ok(label.includes("XEN-5"));
});

test("list view: one button per task on the page, pager only when needed", () => {
  const few = taskListView([issue(1), issue(2)], 0);
  assert.match(few.text, /открытые задачи: 2/);
  assert.ok(!buttons(few.keyboard).some((b) => b.text === "▶️"));

  const many = taskListView(Array.from({ length: 10 }, (_, i) => issue(i)), 0);
  const all = buttons(many.keyboard);
  assert.equal(all.filter((b) => b.callback_data?.startsWith("task:")).length, 8);
  assert.ok(all.some((b) => b.text === "▶️" && b.callback_data === CB.list(1)));

  assert.match(taskListView([], 0).text, /нет открытых задач/);
});

test("card offers take/status/Jira link, and hides 'take' while the bot works on it", () => {
  const card = taskCardView(issue(7), "https://j.isaqr.kz/");
  const all = buttons(card.keyboard);
  assert.ok(all.some((b) => b.callback_data === CB.take("XEN-7")));
  assert.ok(all.some((b) => b.callback_data === CB.team("XEN-7")));
  assert.match(card.text, /🤖 Бот — .*\n👥 Команда — /);
  assert.ok(all.some((b) => b.callback_data === CB.statuses("XEN-7")));
  assert.ok(all.some((b) => b.url === "https://j.isaqr.kz/browse/XEN-7"));

  const busy = buttons(taskCardView(issue(7), "https://j.isaqr.kz", { botBusyWith: "XEN-7" }).keyboard);
  assert.ok(!busy.some((b) => b.callback_data === CB.take("XEN-7")));
});

test("transitions view lists only what Jira allows, by id", () => {
  const view = transitionsView("XEN-7", "В работе", [
    { id: "31", name: "Review", toStatus: "Review" },
    { id: "41", name: "Вернуть", toStatus: "Сделать" },
  ]);
  const all = buttons(view.keyboard);
  assert.ok(all.some((b) => b.callback_data === CB.transition("XEN-7", "31")));
  assert.ok(all.some((b) => b.callback_data === CB.transition("XEN-7", "41") && b.text.includes("Вернуть → Сделать")));
  assert.match(transitionsView("XEN-7", "Done", []).text, /переходов нет/);
});

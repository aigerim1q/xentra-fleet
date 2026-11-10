import { InlineKeyboard, Keyboard } from "grammy";
import type { JiraIssue, JiraTransition } from "../jira/client.js";

// Telegram task browser: every open task assigned to the owner, a card per task with
// a status change and "take it into work". Pure helpers here (testable); the bot
// wires them to Jira and callbacks.

export const PAGE_SIZE = 8;
// Telegram rejects callback_data over 64 bytes — every payload here stays well below.
export const CB = {
  list: (page: number) => `tasks:${page}`,
  card: (key: string) => `task:${key}`,
  take: (key: string) => `take:${key}`,
  statuses: (key: string) => `st:${key}`,
  transition: (key: string, id: string) => `tr:${key}:${id}`,
};

// Reply-keyboard labels double as the text the bot listens for (bot.hears).
export const MENU = {
  tasks: "📋 Мои задачи",
  queue: "🤖 Взять в работу",
  status: "📊 Статус",
  limits: "⚡️ Лимиты",
  stop: "⏹ Стоп",
  help: "❓ Помощь",
  fleet: "🛰 Флот",
  deputy: "🧑‍💼 Зам. CTO",
} as const;

export function mainMenuKeyboard(): Keyboard {
  return new Keyboard()
    .text(MENU.tasks)
    .text(MENU.queue)
    .row()
    .text(MENU.fleet)
    .text(MENU.deputy)
    .row()
    .text(MENU.status)
    .text(MENU.limits)
    .row()
    .text(MENU.stop)
    .text(MENU.help)
    .resized()
    .persistent();
}

/** Every task assigned to the owner that isn't done, most recently touched first. */
export function myOpenTasksJql(projectKey: string): string {
  return `project = ${projectKey} AND assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC`;
}

export function pageOf<T>(items: T[], page: number, size = PAGE_SIZE): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const safe = Math.min(Math.max(0, page), pages - 1);
  return { items: items.slice(safe * size, safe * size + size), page: safe, pages };
}

const STATUS_ICON: Array<[RegExp, string]> = [
  [/review|ревью|провер/i, "🔍"],
  [/progress|работ/i, "🔨"],
  [/test|тест|qa/i, "🧪"],
  [/block|блок|ожида/i, "⛔️"],
];

export function statusIcon(status: string | undefined): string {
  if (!status) return "•";
  return STATUS_ICON.find(([re]) => re.test(status))?.[1] ?? "📌";
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/** One button label: icon, key, summary — fits Telegram's button width. */
export function taskButtonLabel(issue: JiraIssue): string {
  return truncate(`${statusIcon(issue.status)} ${issue.key} · ${issue.summary}`, 60);
}

export function statusCounts(issues: JiraIssue[]): string {
  const counts = new Map<string, number>();
  for (const i of issues) counts.set(i.status ?? "—", (counts.get(i.status ?? "—") ?? 0) + 1);
  return [...counts.entries()].map(([s, n]) => `${statusIcon(s)} ${s}: ${n}`).join("\n");
}

export function taskListView(issues: JiraIssue[], page: number): { text: string; keyboard: InlineKeyboard } {
  const view = pageOf(issues, page);
  const keyboard = new InlineKeyboard();
  for (const issue of view.items) keyboard.text(taskButtonLabel(issue), CB.card(issue.key)).row();
  if (view.pages > 1) {
    if (view.page > 0) keyboard.text("◀️", CB.list(view.page - 1));
    keyboard.text(`${view.page + 1} / ${view.pages}`, CB.list(view.page));
    if (view.page < view.pages - 1) keyboard.text("▶️", CB.list(view.page + 1));
    keyboard.row();
  }
  keyboard.text("🔄 Обновить", CB.list(view.page));
  const text =
    issues.length === 0
      ? "У тебя нет открытых задач в Jira."
      : `Твои открытые задачи: ${issues.length}\n\n${statusCounts(issues)}\n\nНажми на задачу, чтобы открыть карточку.`;
  return { text, keyboard };
}

export function taskCardView(
  issue: JiraIssue,
  jiraBaseUrl: string,
  opts: { botBusyWith?: string } = {},
): { text: string; keyboard: InlineKeyboard } {
  const description = issue.description.trim() ? truncate(issue.description.trim(), 600) : "(без описания)";
  const text = [
    `${statusIcon(issue.status)} ${issue.key} — ${issue.summary}`,
    `Статус: ${issue.status ?? "—"}`,
    "",
    description,
  ].join("\n");
  const keyboard = new InlineKeyboard();
  if (opts.botBusyWith === issue.key) {
    keyboard.text("⏳ Бот уже работает над ней", CB.card(issue.key)).row();
  } else {
    keyboard.text("🤖 Взять в работу ботом", CB.take(issue.key)).row();
  }
  keyboard
    .text("🔀 Сменить статус", CB.statuses(issue.key))
    .url("↗️ Открыть в Jira", `${jiraBaseUrl.replace(/\/$/, "")}/browse/${issue.key}`)
    .row()
    .text("← К списку", CB.list(0));
  return { text, keyboard };
}

export function transitionsView(issueKey: string, current: string | undefined, transitions: JiraTransition[]): { text: string; keyboard: InlineKeyboard } {
  const keyboard = new InlineKeyboard();
  for (const t of transitions) {
    const label = t.name === t.toStatus ? t.toStatus : `${t.name} → ${t.toStatus}`;
    keyboard.text(`${statusIcon(t.toStatus)} ${truncate(label, 50)}`, CB.transition(issueKey, t.id)).row();
  }
  keyboard.text("← Назад", CB.card(issueKey));
  const text =
    transitions.length === 0
      ? `${issueKey}: из статуса «${current ?? "—"}» переходов нет (или у тебя нет на них прав).`
      : `${issueKey}: сейчас «${current ?? "—"}». Куда перевести?`;
  return { text, keyboard };
}

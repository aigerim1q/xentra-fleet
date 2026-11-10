import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Bot } from "grammy";
import type { Update } from "grammy/types";
import { formatForTelegram, installOwnerBridge, replyTarget } from "./telegramBridge.js";
import { Spool, readInbox, send } from "./mail.js";
import { OWNER_ADDRESS } from "./roles.js";
import { FLEET_ADDRESS } from "./supervisor.js";

let home: string;
const old = { mail: process.env.FLEET_MAIL_DIR, home: process.env.FLEET_HOME };

before(() => {
  home = mkdtempSync(join(tmpdir(), "bridge-"));
  process.env.FLEET_HOME = home;
  process.env.FLEET_MAIL_DIR = join(home, "mail");
});
after(() => {
  process.env.FLEET_HOME = old.home;
  process.env.FLEET_MAIL_DIR = old.mail;
  rmSync(home, { recursive: true, force: true });
});

test("formatForTelegram fits Telegram's limit and says how to answer", () => {
  const text = formatForTelegram({
    id: "1-x", from: "xentra/pm", to: [OWNER_ADDRESS], subject: "Итог", priority: "high",
    date: "d", thread: "t1", body: "x".repeat(10_000),
  });
  assert.ok(text.length <= 4096);
  assert.match(text, /❗/);
  assert.match(text, /реплаем/);
});

test("replyTarget sends answers to supervisor notices to pm", () => {
  assert.equal(replyTarget(FLEET_ADDRESS), "xentra/pm");
  assert.equal(replyTarget("xentra/dev-1"), "xentra/dev-1");
});

test("the bridge is installed after the bot's access guard", () => {
  const src = readFileSync(fileURLToPath(new URL("../bot/bot.ts", import.meta.url)), "utf8");
  const guard = src.indexOf("isAuthorizedSender(chatId, userId");
  const install = src.indexOf("installOwnerBridge(bot,");
  assert.ok(guard > 0 && install > guard, "installOwnerBridge must come after the access guard");
});

test("forwards owner mail to the chat, and a reply goes back into the thread", async () => {
  const sent: Array<{ text: string; id: number }> = [];
  let nextId = 100;
  const bot = new Bot("1:fake", { botInfo: { id: 1, is_bot: true, first_name: "b", username: "b", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never });
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "sendMessage") {
      const id = nextId++;
      sent.push({ text: (payload as { text: string }).text, id });
      return { ok: true, result: { message_id: id, date: 0, chat: { id: 7, type: "private" } } } as never;
    }
    return { ok: true, result: true } as never;
  });

  const spool = new Spool();
  spool.register(OWNER_ADDRESS);
  spool.register("xentra/pm");
  const letter = send(spool, { from: "xentra/pm", to: [OWNER_ADDRESS], subject: "Готово XEN-1", body: "сделано" });

  const stop = installOwnerBridge(bot, 7, { pollMs: 60_000 });
  try {
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Готово XEN-1/);

    const update = (text: string, replyTo?: number): Update =>
      ({
        update_id: nextId++,
        message: {
          message_id: nextId++, date: 0, chat: { id: 7, type: "private", first_name: "o" }, from: { id: 7, is_bot: false, first_name: "o" }, text,
          ...(replyTo ? { reply_to_message: { message_id: replyTo, date: 0, chat: { id: 7, type: "private", first_name: "o" } } } : {}),
          ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] } : {}),
        },
      }) as never;

    await bot.handleUpdate(update("Принимаю, мержу сам", sent[0].id));
    const back = readInbox(spool, "xentra/pm");
    assert.equal(back.length, 1);
    assert.equal(back[0].thread, letter.thread);
    assert.equal(back[0].body, "Принимаю, мержу сам");
    assert.equal(readInbox(spool, OWNER_ADDRESS).length, 0);

    await bot.handleUpdate(update("/fleet Почини фильтр XEN-55"));
    const fresh = readInbox(spool, "xentra/pm").find((l) => l.key === "XEN-55");
    assert.ok(fresh);
    assert.notEqual(fresh!.thread, letter.thread);
  } finally {
    stop();
  }
});

test("a push request shows Push/Decline buttons, and Push runs the push and tells the requester", async () => {
  const { fileRequest, loadPush } = await import("./pushRequests.js");
  const markups: unknown[] = [];
  let nextId = 500;
  const bot = new Bot("1:fake", { botInfo: { id: 1, is_bot: true, first_name: "b", username: "b", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never });
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "sendMessage") {
      markups.push((payload as { reply_markup?: unknown }).reply_markup);
      return { ok: true, result: { message_id: nextId++, date: 0, chat: { id: 7, type: "private" } } } as never;
    }
    return { ok: true, result: true } as never;
  });
  const spool = new Spool();
  spool.register(OWNER_ADDRESS);
  spool.register(FLEET_ADDRESS);
  spool.register("xentra/pm");
  const stateDir = join(home, "state");
  fileRequest(stateDir, { thread: "tp", repo: "backend", dir: "/wt", branch: "fleet/tp", baseBranch: "dev", gitlabProjectPath: "saqr/back-ai", title: "XEN-9", requestedBy: "xentra/pm" });
  send(spool, { from: FLEET_ADDRESS, to: [OWNER_ADDRESS], subject: "Запрос на push: XEN-9", body: "stat", thread: "tp" });

  const pushed: string[] = [];
  const stop = installOwnerBridge(bot, 7, {
    pollMs: 60_000,
    pushDeps: { push: async (_d, b) => void pushed.push(b), createMr: async () => ({ iid: 3, webUrl: "https://g/mr/3" }) },
  });
  try {
    await new Promise((r) => setTimeout(r, 50));
    const kb = JSON.stringify(markups.at(-1));
    const token = /fleet_push:(\d+)/.exec(kb)?.[1];
    assert.ok(token, `push button expected in ${kb}`);
    assert.match(kb, /fleet_nopush/);
    await bot.handleUpdate({
      update_id: nextId++,
      callback_query: { id: "q1", chat_instance: "c", from: { id: 7, is_bot: false, first_name: "o" }, data: `fleet_push:${token}`,
        message: { message_id: 1, date: 0, chat: { id: 7, type: "private", first_name: "o" } } },
    } as never);
    assert.deepEqual(pushed, ["fleet/tp"]);
    assert.equal(loadPush(stateDir, "tp")!.status, "pushed");
    const note = readInbox(spool, "xentra/pm").find((l) => l.subject === "Push выполнен");
    assert.match(note!.body, /mr\/3/);
  } finally {
    stop();
  }
});

function fakeBot() {
  const sent: Array<{ text: string; id: number; markup?: unknown; parseMode?: string }> = [];
  let nextId = 900;
  const bot = new Bot("1:fake", { botInfo: { id: 1, is_bot: true, first_name: "b", username: "b", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never });
  bot.api.config.use(async (_prev, method, payload) => {
    const p = payload as { text?: string; reply_markup?: unknown; parse_mode?: string };
    if (method === "sendMessage") {
      const id = nextId++;
      sent.push({ text: p.text ?? "", id, markup: p.reply_markup, parseMode: p.parse_mode });
      return { ok: true, result: { message_id: id, date: 0, chat: { id: 7, type: "private" } } } as never;
    }
    return { ok: true, result: true } as never;
  });
  const msg = (text: string): Update =>
    ({ update_id: nextId++, message: { message_id: nextId++, date: 0, chat: { id: 7, type: "private", first_name: "o" }, from: { id: 7, is_bot: false, first_name: "o" }, text,
      ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] } : {}) } }) as never;
  const tap = (data: string): Update =>
    ({ update_id: nextId++, callback_query: { id: String(nextId++), chat_instance: "c", from: { id: 7, is_bot: false, first_name: "o" }, data,
      message: { message_id: 1, date: 0, chat: { id: 7, type: "private", first_name: "o" } } } }) as never;
  return { bot, sent, msg, tap };
}

test("Зам. CTO: menu button turns the mode on, plain text goes to pm's deputy thread, menu taps pass through", async () => {
  const { MENU } = await import("../bot/taskBrowser.js");
  const { DEPUTY_THREAD } = await import("./deputy.js");
  const { bot, sent, msg, tap } = fakeBot();
  let fellThrough = 0;
  const stop = installOwnerBridge(bot, 7, { pollMs: 60_000 });
  bot.on("message:text", () => void fellThrough++);
  try {
    const spool = new Spool();
    await bot.handleUpdate(msg(MENU.deputy));
    assert.match(sent.at(-1)!.text, /Режим «Зам\. CTO»/);
    await bot.handleUpdate(msg("Что сейчас делает флот?"));
    const toPm = readInbox(spool, "xentra/pm").filter((l) => l.thread === DEPUTY_THREAD);
    assert.equal(toPm.length, 1);
    assert.equal(toPm[0].body, "Что сейчас делает флот?");
    await bot.handleUpdate(msg(MENU.tasks));
    assert.equal(fellThrough, 1, "menu labels must reach the bot's own handlers");
    assert.equal(readInbox(spool, "xentra/pm").filter((l) => l.thread === DEPUTY_THREAD).length, 1);

    // pm answers in the deputy thread -> shows as a conversation and is archived
    send(spool, { from: "xentra/pm", to: [OWNER_ADDRESS], subject: "Re", body: "Сейчас dev-1 делает XEN-55.", thread: DEPUTY_THREAD });
    stop();
    const stop2 = installOwnerBridge(bot, 7, { pollMs: 60_000 });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(sent.some((m) => m.text === "🧑‍💼 Зам. CTO\n\nСейчас dev-1 делает XEN-55."));
    assert.equal(readInbox(spool, OWNER_ADDRESS).filter((l) => l.thread === DEPUTY_THREAD).length, 0);
    stop2();

    await bot.handleUpdate(tap("fleet_dep:off"));
    await bot.handleUpdate(msg("просто текст"));
    assert.equal(fellThrough, 2);
  } finally {
    stop();
  }
});

test("🛰 Флот shows the status with buttons; Сессии lists journals and opens a readable card", async () => {
  const { MENU } = await import("../bot/taskBrowser.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const dir = join(home, "state", "tasks", "fleet-tview", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "2026-11-10T08-00-00-000Z-dev-1.jsonl"),
    [
      JSON.stringify({ type: "system", subtype: "init", session_id: "aaaaaaaa-1111", cwd: "/wt/x", model: "m" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/<a>.ts" } }] } }),
      "",
    ].join("\n"),
  );
  const { bot, sent, msg, tap } = fakeBot();
  const stop = installOwnerBridge(bot, 7, { pollMs: 60_000 });
  try {
    await bot.handleUpdate(msg(MENU.fleet));
    assert.match(sent.at(-1)!.text, /🛰 Флот ролей/);
    assert.match(JSON.stringify(sent.at(-1)!.markup), /fleet_st:sessions/);
    await bot.handleUpdate(tap("fleet_st:sessions"));
    const list = JSON.stringify(sent.at(-1)!.markup);
    const btn = /"text":"[^"]*tview[^"]*dev-1","callback_data":"(fleet_sess:\d+)"/.exec(list);
    assert.ok(btn, `session button expected in ${list}`);
    await bot.handleUpdate(tap(btn[1]));
    const card = sent.at(-1)!;
    assert.equal(card.parseMode, "HTML");
    assert.match(card.text, /→ Правка src\/&lt;a&gt;\.ts/);
    assert.match(card.text, /cd \/wt\/x &amp;&amp; claude --resume aaaaaaaa-1111 --fork-session/);
  } finally {
    stop();
  }
});

test("fleetSnapshot lists who works, queues and the week's threads, not the deputy thread itself", async () => {
  const { fleetSnapshot, DEPUTY_THREAD } = await import("./deputy.js");
  const { parseRole } = await import("./roles.js");
  const { mkdtempSync: mk, rmSync: rm, writeFileSync: wf, mkdirSync: md } = await import("node:fs");
  const dir = mk(join(tmpdir(), "snap-"));
  try {
    const spool = new Spool(join(dir, "mail"));
    for (const a of [OWNER_ADDRESS, "xentra/pm", "xentra/dev-1"]) spool.register(a);
    send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: "XEN-55 фильтр", body: "", key: "XEN-55" });
    send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: "привет", body: "", thread: DEPUTY_THREAD });
    md(join(dir, "state"), { recursive: true });
    wf(join(dir, "state", "running.dev-1"), JSON.stringify({ thread: "t9" }));
    const roles = [parseRole({ role: "pm", engine: "claude", model: "m", access: "read" }, "")];
    const snap = fleetSnapshot(spool, join(dir, "state"), roles);
    assert.match(snap, /Сейчас работают: dev-1 — тред t9/);
    assert.match(snap, /Очереди: pm 2/);
    assert.match(snap, /\[XEN-55\].*«XEN-55 фильтр»/);
    assert.doesNotMatch(snap, /«привет»/);
  } finally {
    rm(dir, { recursive: true, force: true });
  }
});

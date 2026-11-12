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
    stop.stop();
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
    pushDeps: { push: async (_d, b) => void pushed.push(b), createMr: async () => ({ iid: 3, webUrl: "https://g/mr/3" }), headSha: async () => "h1" },
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
    stop.stop();
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

test("Зам. CTO: while the team runs, plain text goes to pm's deputy thread; menu taps and a stopped team pass through", async () => {
  const { MENU } = await import("../bot/taskBrowser.js");
  const { DEPUTY_THREAD } = await import("./deputy.js");
  const { HEARTBEAT_FILE } = await import("./names.js");
  const { mkdirSync, writeFileSync, rmSync: rmf } = await import("node:fs");
  const { bot, sent, msg } = fakeBot();
  let fellThrough = 0;
  const stop = installOwnerBridge(bot, 7, { pollMs: 60_000 });
  bot.on("message:text", () => void fellThrough++);
  const beat = join(home, "state", HEARTBEAT_FILE);
  try {
    const spool = new Spool();
    await bot.handleUpdate(msg("Что сейчас делает команда?"));
    assert.equal(fellThrough, 1, "team down: the bot's own handler answers");

    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(beat, "now");
    await bot.handleUpdate(msg("Что сейчас делает команда?"));
    const toPm = readInbox(spool, "xentra/pm").filter((l) => l.thread === DEPUTY_THREAD);
    assert.equal(toPm.length, 1);
    assert.equal(toPm[0].body, "Что сейчас делает команда?");
    await bot.handleUpdate(msg(MENU.tasks));
    assert.equal(fellThrough, 2, "menu labels must reach the bot's own handlers");

    // pm answers in the deputy thread -> shows as a conversation and is archived
    send(spool, { from: "xentra/pm", to: [OWNER_ADDRESS], subject: "Re", body: "Сейчас Разработчик 1 делает XEN-55.", thread: DEPUTY_THREAD });
    stop.stop();
    const stop2 = installOwnerBridge(bot, 7, { pollMs: 60_000 });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(sent.some((m) => m.text === "🧑‍💼 Сейчас Разработчик 1 делает XEN-55."));
    assert.equal(readInbox(spool, OWNER_ADDRESS).filter((l) => l.thread === DEPUTY_THREAD).length, 0);
    stop2.stop();
  } finally {
    rmf(beat, { force: true });
    stop.stop();
  }
});

test("letters show plain role names and the task title, not internal ids", async () => {
  const spool = new Spool();
  const task = send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: "Фильтр архива", body: "", key: "XEN-77" });
  send(spool, { from: "xentra/dev-1", to: [OWNER_ADDRESS], subject: "Вопрос", body: "Как быть?", thread: task.thread });
  const { bot, sent } = fakeBot();
  const stop = installOwnerBridge(bot, 7, { pollMs: 60_000 });
  try {
    await new Promise((r) => setTimeout(r, 50));
    const m = sent.find((x) => x.text.includes("Как быть?"))!;
    assert.match(m.text, /^✉️ Разработчик 1 · XEN-77 · Фильтр архива/);
    assert.doesNotMatch(m.text, new RegExp(task.thread));
  } finally {
    stop.stop();
  }
});

test("/sessions lists journals with readable names and opens a card with the open command", async () => {
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
    await bot.handleUpdate(msg("/sessions"));
    const list = JSON.stringify(sent.at(-1)!.markup);
    const btn = /"text":"[^"]*Разработчик 1 · tview","callback_data":"(fleet_sess:\d+)"/.exec(list);
    assert.ok(btn, `session button expected in ${list}`);
    await bot.handleUpdate(tap(btn[1]));
    const card = sent.at(-1)!;
    assert.equal(card.parseMode, "HTML");
    assert.match(card.text, /→ Правка src\/&lt;a&gt;\.ts/);
    assert.match(card.text, /cd \/wt\/x &amp;&amp; claude --resume aaaaaaaa-1111 --fork-session/);
  } finally {
    stop.stop();
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

test("every button fits Telegram's 64-byte callback_data cap, and «Прочитано» archives the letter", async () => {
  const { CALLBACK_DATA_MAX_BYTES } = await import("./telegramBridge.js");
  const spool = new Spool();
  spool.register(OWNER_ADDRESS);
  spool.register(FLEET_ADDRESS);
  const subject = "Запрос на push: XEN-55 fix archived filter in documents list and pagination";
  const l = send(spool, { from: FLEET_ADDRESS, to: [OWNER_ADDRESS], subject, body: "stat" });
  assert.ok(Buffer.byteLength(`fleet_read:${l.id}`) > CALLBACK_DATA_MAX_BYTES, "the raw id must not fit, or this test proves nothing");
  const { bot, sent, tap } = fakeBot();
  const stop = installOwnerBridge(bot, 7, { pollMs: 60_000 });
  try {
    await new Promise((r) => setTimeout(r, 50));
    const m = sent.find((x) => x.text.includes(subject))!;
    const buttons = (m.markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard.flat();
    assert.ok(buttons.length > 0);
    for (const b of buttons) assert.ok(Buffer.byteLength(b.callback_data) <= CALLBACK_DATA_MAX_BYTES, b.callback_data);
    const read = buttons.find((b) => b.callback_data.startsWith("fleet_read:"))!;
    assert.ok(readInbox(spool, OWNER_ADDRESS).some((x) => x.id === l.id));
    await bot.handleUpdate(tap(read.callback_data));
    assert.ok(!readInbox(spool, OWNER_ADDRESS).some((x) => x.id === l.id), "tapping «Прочитано» archives the letter");
  } finally {
    stop.stop();
  }
});

test("a letter that cannot be forwarded is skipped after a few tries instead of blocking the queue", async () => {
  const { MAX_FORWARD_FAILURES } = await import("./telegramBridge.js");
  const spool = new Spool();
  spool.register(OWNER_ADDRESS);
  spool.register("xentra/dev-1");
  const bad = send(spool, { from: "xentra/dev-1", to: [OWNER_ADDRESS], subject: "BADLETTER", body: "x" });
  const good = send(spool, { from: "xentra/dev-1", to: [OWNER_ADDRESS], subject: "GOODLETTER", body: "y" }, new Date(Date.now() + 1000));
  const sent: string[] = [];
  let nextId = 700;
  const bot = new Bot("1:fake", { botInfo: { id: 1, is_bot: true, first_name: "b", username: "b", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never });
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "sendMessage") {
      const text = (payload as { text: string }).text;
      if (text.includes("«BADLETTER»")) throw new Error("Bad Request: BUTTON_DATA_INVALID");
      sent.push(text);
      return { ok: true, result: { message_id: nextId++, date: 0, chat: { id: 7, type: "private" } } } as never;
    }
    return { ok: true, result: true } as never;
  });
  const stop = installOwnerBridge(bot, 7, { pollMs: 20 });
  try {
    await new Promise((r) => setTimeout(r, 20 * (MAX_FORWARD_FAILURES + 3)));
    assert.ok(sent.some((t) => t.includes("GOODLETTER")), `the letter behind the bad one must get through: ${JSON.stringify(sent)}`);
    assert.ok(sent.some((t) => t.includes("Не смогла переслать") && t.includes(bad.id)), "the owner is told which letter was skipped");
    assert.ok(readInbox(spool, OWNER_ADDRESS).some((x) => x.id === bad.id), "the skipped letter stays in the mailbox");
    assert.ok(readInbox(spool, OWNER_ADDRESS).some((x) => x.id === good.id));
  } finally {
    stop.stop();
  }
});

test("«прервать» for a running role: listed with a token, and the tap files a kill request for the supervisor", async () => {
  const { mkdirSync, writeFileSync, existsSync: ex, rmSync: rmf } = await import("node:fs");
  const spool = new Spool();
  spool.register(OWNER_ADDRESS);
  spool.register("xentra/pm");
  const task = send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: "Фильтр", body: "", key: "XEN-3" });
  const stateDir = join(home, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "running.dev-2"), JSON.stringify({ thread: task.thread, startedAt: new Date().toISOString(), pid: 1 }));
  const { bot, sent, tap } = fakeBot();
  const bridge = installOwnerBridge(bot, 7, { pollMs: 60_000 });
  try {
    const running = bridge.running();
    assert.equal(running.length, 1);
    assert.equal(running[0].name, "Разработчик 2");
    assert.match(running[0].title, /XEN-3/);
    await bot.handleUpdate(tap(`fleet_kill:${running[0].token}`));
    assert.ok(ex(join(stateDir, "kill.dev-2")), "kill request filed");
    assert.match(sent.at(-1)!.text, /Прерываю сессию: Разработчик 2/);
    rmf(join(stateDir, "running.dev-2"), { force: true });
    await bot.handleUpdate(tap(`fleet_kill:${running[0].token}`)); // no longer running: refused, no crash
  } finally {
    rmf(join(stateDir, "kill.dev-2"), { force: true });
    bridge.stop();
  }
});

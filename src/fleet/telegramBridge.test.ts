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

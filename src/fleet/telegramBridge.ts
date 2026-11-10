import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { InlineKeyboard, type Bot, type Context } from "grammy";
import { listHolds, releaseHold } from "./loopGuard.js";
import { Spool, archive, findInInbox, readInbox, send, type Letter } from "./mail.js";
import { OWNER_ADDRESS, loadRoles } from "./roles.js";
import { FLEET_ADDRESS } from "./supervisor.js";
import { fleetHome } from "./workspace.js";

// The owner is a mailbox (xentra/owner) the fleet writes to; this bridge makes that
// mailbox live in Telegram, as the CTO is the human end of his fleet:
// - every new letter to xentra/owner is forwarded to the owner's chat;
// - a Telegram REPLY to such a message becomes a letter back into the same thread
//   (to the letter's sender; a supervisor notice is answered to pm);
// - /fleet <text> starts a new thread with pm; /holds and /release <thread> manage
//   threads stopped by the echo guard.
// Must be installed before the bot's free-text handler: it consumes only replies to
// its own forwarded messages and passes everything else on.

interface Forwarded {
  letterId: string;
  thread: string;
  from: string;
  repo?: string;
  subject: string;
}

interface BridgeState {
  forwarded: Record<string, Forwarded>; // telegram message id -> letter
  seen: string[]; // letter ids already forwarded
}

const MAX_TG = 3800;

function statePath(): string {
  return join(fleetHome(), "state", "owner-bridge.json");
}

function loadState(): BridgeState {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8"));
  } catch {
    return { forwarded: {}, seen: [] };
  }
}

function saveState(st: BridgeState): void {
  mkdirSync(dirname(statePath()), { recursive: true });
  // Bounded: old mappings only matter while someone might still reply to them.
  const keys = Object.keys(st.forwarded);
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete st.forwarded[k];
  st.seen = st.seen.slice(-2000);
  writeFileSync(statePath(), JSON.stringify(st, null, 2));
}

export function formatForTelegram(l: Letter): string {
  const head = `✉️ ${l.from}${l.priority === "high" || l.priority === "urgent" ? " ❗" : ""}\n«${l.subject}»`;
  const tail = `\n\nтред ${l.thread}\nОтветь реплаем на это сообщение — ответ уйдёт письмом в тред.`;
  const room = MAX_TG - head.length - tail.length - 4;
  const body = l.body.length > room ? `${l.body.slice(0, room)}…` : l.body;
  return `${head}\n\n${body}${tail}`;
}

// Who gets the owner's reply: the letter's sender, except a supervisor notice — the
// supervisor doesn't read mail, so the reply goes to pm, who runs the thread.
export function replyTarget(from: string): string {
  return from === FLEET_ADDRESS ? "xentra/pm" : from;
}

function spoolWithMailboxes(): Spool {
  const spool = new Spool();
  spool.register(OWNER_ADDRESS);
  spool.register(FLEET_ADDRESS);
  for (const r of loadRoles()) spool.register(r.mail);
  return spool;
}

export function installOwnerBridge(bot: Bot, chatId: number, opts: { pollMs?: number } = {}): () => void {
  const spool = spoolWithMailboxes();
  const st = loadState();

  async function forwardNew(): Promise<void> {
    for (const l of readInbox(spool, OWNER_ADDRESS)) {
      if (l.kind || st.seen.includes(l.id)) continue;
      const kb = new InlineKeyboard().text("✅ Прочитано", `fleet_read:${l.id}`);
      try {
        const msg = await bot.api.sendMessage(chatId, formatForTelegram(l), { reply_markup: kb });
        st.forwarded[String(msg.message_id)] = { letterId: l.id, thread: l.thread, from: l.from, repo: l.repo, subject: l.subject };
        st.seen.push(l.id);
        saveState(st);
      } catch (err) {
        console.error("[fleet-bridge] forward failed:", (err as Error).message);
        return; // try again next tick, keep order
      }
    }
  }

  const timer = setInterval(() => void forwardNew(), opts.pollMs ?? 10_000);
  void forwardNew();

  bot.callbackQuery(/^fleet_read:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    archive(spool, OWNER_ADDRESS, id);
    await ctx.answerCallbackQuery({ text: "Убрал в архив" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  bot.command("fleet", async (ctx) => {
    const text = ctx.match?.toString().trim();
    if (!text) {
      await ctx.reply("Напиши задачу после команды: /fleet <что сделать>. Уйдёт письмом pm, новым тредом.");
      return;
    }
    const subject = text.split("\n")[0].slice(0, 80);
    const key = /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(text)?.[1];
    const l = send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject, body: text, key });
    await ctx.reply(`📨 Отправил pm, тред ${l.thread}`);
  });

  bot.command("holds", async (ctx) => {
    const h = listHolds(spool);
    await ctx.reply(h.length ? `Остановленные треды:\n${h.join("\n")}\n\nСнять: /release <тред>` : "Остановленных тредов нет.");
  });

  bot.command("release", async (ctx) => {
    const t = ctx.match?.toString().trim();
    if (!t) {
      await ctx.reply("Укажи тред: /release <тред>");
      return;
    }
    await ctx.reply(releaseHold(spool, t) ? `▶️ Тред ${t} снова работает.` : `Тред ${t} не был остановлен.`);
  });

  bot.on("message:text", async (ctx: Context, next) => {
    const replyTo = ctx.message?.reply_to_message?.message_id;
    const fwd = replyTo !== undefined ? st.forwarded[String(replyTo)] : undefined;
    const text = ctx.message?.text?.trim() ?? "";
    if (!fwd || !text || text.startsWith("/")) return next();
    try {
      const l = send(spool, {
        from: OWNER_ADDRESS,
        to: [replyTarget(fwd.from)],
        subject: fwd.subject.startsWith("Re:") ? fwd.subject : `Re: ${fwd.subject}`,
        body: text,
        thread: fwd.thread,
        repo: fwd.repo,
      });
      if (findInInbox(spool, OWNER_ADDRESS, fwd.letterId)) archive(spool, OWNER_ADDRESS, fwd.letterId);
      await ctx.reply(`📨 Ответ ушёл ${replyTarget(fwd.from)} в тред ${l.thread}`);
    } catch (err) {
      await ctx.reply(`Не отправил: ${(err as Error).message}`);
    }
  });

  return () => clearInterval(timer);
}

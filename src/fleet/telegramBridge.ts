import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { InlineKeyboard, type Bot, type Context } from "grammy";
import { listHolds, releaseHold } from "./loopGuard.js";
import { Spool, archive, findInInbox, readInbox, send, type Letter } from "./mail.js";
import { OWNER_ADDRESS, loadRoles } from "./roles.js";
import { FLEET_ADDRESS } from "./supervisor.js";
import { fleetHome } from "./workspace.js";
import { FleetLimits } from "./limits.js";
import { WATCHER_ADDRESSES } from "./watchers.js";
import { approvePush, declinePush, loadPush, type PushDeps } from "./pushRequests.js";
import { createMergeRequest, pushBranch } from "../gitlab.js";
import { config } from "../config.js";
import { existsSync, readdirSync } from "node:fs";

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
  // Short tokens for button data (Telegram caps it at 64 bytes; thread ids are longer).
  tokens?: Record<string, string>;
  nextToken?: number;
}

export const realPushDeps: PushDeps = {
  push: (dir, branch) => pushBranch(dir, branch),
  createMr: async (r) => {
    const { webUrl } = await createMergeRequest({
      gitlabBaseUrl: config.gitlab.baseUrl,
      token: config.gitlab.token,
      projectPath: r.gitlabProjectPath,
      sourceBranch: r.branch,
      targetBranch: r.baseBranch,
      title: r.title,
      description: `Ветка треда флота ${r.thread}, запрос ${r.requestedBy}, одобрено владельцем.`,
    });
    return { iid: Number(/merge_requests\/(\d+)/.exec(webUrl)?.[1] ?? 0), webUrl };
  },
};

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
  return from === FLEET_ADDRESS || WATCHER_ADDRESSES.includes(from) ? "xentra/pm" : from;
}

function spoolWithMailboxes(): Spool {
  const spool = new Spool();
  spool.register(OWNER_ADDRESS);
  spool.register(FLEET_ADDRESS);
  for (const w of WATCHER_ADDRESSES) spool.register(w);
  for (const r of loadRoles()) spool.register(r.mail);
  return spool;
}

export function installOwnerBridge(bot: Bot, chatId: number, opts: { pollMs?: number; pushDeps?: PushDeps } = {}): () => void {
  const spool = spoolWithMailboxes();
  const st = loadState();
  const stateDir = join(fleetHome(), "state");
  const tokenFor = (thread: string): string => {
    st.tokens ??= {};
    st.nextToken ??= 1;
    const t = String(st.nextToken++);
    st.tokens[t] = thread;
    return t;
  };

  async function forwardNew(): Promise<void> {
    for (const l of readInbox(spool, OWNER_ADDRESS)) {
      if (l.kind || st.seen.includes(l.id)) continue;
      const kb = new InlineKeyboard();
      if (l.from === FLEET_ADDRESS && l.subject.startsWith("Запрос на push") && loadPush(stateDir, l.thread)?.status === "pending") {
        const t = tokenFor(l.thread);
        kb.text("🚀 Push и MR", `fleet_push:${t}`).text("✋ Не сейчас", `fleet_nopush:${t}`).row();
      }
      kb.text("✅ Прочитано", `fleet_read:${l.id}`);
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

  const notifyRequester = (thread: string, requestedBy: string, subject: string, body: string) => {
    try {
      send(spool, { from: FLEET_ADDRESS, to: [requestedBy], subject, body, thread });
    } catch (err) {
      console.error("[fleet-bridge] notify requester failed:", (err as Error).message);
    }
  };

  bot.callbackQuery(/^fleet_push:(\d+)$/, async (ctx) => {
    const thread = st.tokens?.[ctx.match[1]];
    if (!thread) return void (await ctx.answerCallbackQuery({ text: "Запрос устарел", show_alert: true }));
    await ctx.answerCallbackQuery({ text: "Пушу…" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    try {
      const r = await approvePush(stateDir, thread, opts.pushDeps ?? realPushDeps);
      if (r.status === "pushed") {
        await ctx.reply(`🚀 Запушено: ${r.branch}${r.mr ? `\nMR: ${r.mr.webUrl}` : ""}`);
        notifyRequester(thread, r.requestedBy, "Push выполнен", `Владелец одобрил. Ветка \`${r.branch}\` запушена.${r.mr ? ` MR: ${r.mr.webUrl}` : ""}`);
      } else {
        await ctx.reply(`❌ Push не удался: ${r.error}`);
        notifyRequester(thread, r.requestedBy, "Push не удался", `Владелец одобрил, но push/MR упал: ${r.error}`);
      }
    } catch (err) {
      await ctx.reply(`Не выполнено: ${(err as Error).message}`);
    }
  });

  bot.callbackQuery(/^fleet_nopush:(\d+)$/, async (ctx) => {
    const thread = st.tokens?.[ctx.match[1]];
    const r = thread ? declinePush(stateDir, thread) : undefined;
    await ctx.answerCallbackQuery({ text: r ? "Отклонено" : "Запрос устарел" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    if (r?.status === "declined") notifyRequester(r.thread, r.requestedBy, "Push отклонён", "Владелец не одобрил push. Если нужно — спроси у него, что изменить.");
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

  const limits = new FleetLimits(join(fleetHome(), "state"));
  const roleNames = loadRoles().map((r) => r.role);
  const roleArg = (ctx: Context): string | undefined | null => {
    const r = ctx.match?.toString().trim();
    if (!r) return undefined;
    return roleNames.includes(r) ? r : null;
  };

  bot.command("fleet_status", async (ctx) => {
    const stateDir = join(fleetHome(), "state");
    const running = existsSync(stateDir)
      ? readdirSync(stateDir)
          .filter((f) => f.startsWith("running."))
          .map((f) => {
            try {
              const r = JSON.parse(readFileSync(join(stateDir, f), "utf8"));
              return `▶️ ${f.slice(8)} — тред ${r.thread} с ${String(r.startedAt).slice(11, 16)}`;
            } catch {
              return `▶️ ${f.slice(8)}`;
            }
          })
      : [];
    const queue = loadRoles()
      .map((r) => [r.role, readInbox(spool, r.mail).filter((l) => !l.kind).length] as const)
      .filter(([, n]) => n > 0)
      .map(([r, n]) => `📥 ${r}: ${n}`);
    const holds = listHolds(spool);
    await ctx.reply(
      [
        "Флот ролей",
        limits.summary(),
        "",
        running.length ? running.join("\n") : "Сейчас никто не работает.",
        queue.length ? queue.join("\n") : "Очереди пусты.",
        holds.length ? `⛔ Остановлены треды: ${holds.join(", ")}` : "",
        "",
        "/fleet_pause [роль] · /fleet_resume [роль] · /fleet_override",
      ].filter((x, i, a) => x !== "" || a[i - 1] !== "").join("\n"),
    );
  });

  bot.command("fleet_pause", async (ctx) => {
    const r = roleArg(ctx);
    if (r === null) return void (await ctx.reply(`Нет такой роли. Роли: ${roleNames.join(", ")}`));
    limits.pause(r);
    await ctx.reply(r ? `⏸ ${r} на паузе: новые сессии не стартуют, идущая доработает.` : "⏸ Флот на паузе: новые сессии не стартуют, идущие доработают.");
  });

  bot.command("fleet_resume", async (ctx) => {
    const r = roleArg(ctx);
    if (r === null) return void (await ctx.reply(`Нет такой роли. Роли: ${roleNames.join(", ")}`));
    limits.resume(r);
    await ctx.reply(r ? `▶️ ${r} снова работает.` : "▶️ Флот снова работает.");
  });

  bot.command("fleet_override", async (ctx) => {
    limits.overrideToday();
    await ctx.reply("⚡️ Дневные лимиты сняты до конца дня. Пауза, если стоит, остаётся.");
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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { InlineKeyboard, type Bot, type Context } from "grammy";
import { listHolds, releaseHold } from "./loopGuard.js";
import { Spool, archive, findInInbox, readInbox, send, type Letter } from "./mail.js";
import { OWNER_ADDRESS, loadRoles, poolAddresses } from "./roles.js";
import { FLEET_ADDRESS } from "./supervisor.js";
import { fleetHome } from "./workspace.js";
import { FleetLimits } from "./limits.js";
import { WATCHER_ADDRESSES } from "./watchers.js";
import { computeMetrics, formatMetrics } from "./metrics.js";
import { approvePush, declinePush, loadPush, type PushDeps } from "./pushRequests.js";
import { createMergeRequest, getMergeRequestPipeline, mergeMergeRequest, pushBranch } from "../gitlab.js";
import { checkReadiness, setVeto, type MergeDeps } from "./mergeBot.js";
import { config } from "../config.js";
import { existsSync, readdirSync } from "node:fs";
import { MENU } from "../bot/taskBrowser.js";
import { DEPUTY_THREAD } from "./deputy.js";
import { formatEvent, listJournals, sessionInfo } from "../engine/sessionView.js";
import { HARNESS_STATE_DIR } from "../bot/liveState.js";

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
  // "Зам. CTO" mode: plain messages go to pm in the permanent deputy thread.
  deputyMode?: boolean;
}

const MENU_LABELS: string[] = Object.values(MENU);

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Readable tail of one session journal + the command to open it in Claude Code.
export function sessionCard(path: string, task: string, label: string, maxLines = 25): string {
  const lines = readFileSync(path, "utf8").split("\n").flatMap((l) => (l ? formatEvent(l, { textChars: 250 }) : []));
  const info = sessionInfo(path);
  const shown = lines.slice(-maxLines);
  const body = escapeHtml(shown.join("\n")).slice(-3000);
  const open =
    info.sessionId && info.cwd
      ? `\n\nОткрыть в терминале:\n<code>cd ${escapeHtml(info.cwd)} &amp;&amp; claude --resume ${info.sessionId} --fork-session</code>`
      : "";
  return `<b>${escapeHtml(task)} · ${escapeHtml(label)}</b>${lines.length > maxLines ? ` (последние ${maxLines} из ${lines.length})` : ""}\n\n${body || "(пусто)"}${open}`;
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
  if (st.tokens) {
    const tk = Object.keys(st.tokens);
    if (tk.length > 500) for (const k of tk.slice(0, tk.length - 500)) delete st.tokens[k];
  }
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
  const roles = loadRoles();
  for (const r of roles) spool.register(r.mail);
  for (const pool of poolAddresses(roles).keys()) spool.register(pool);
  return spool;
}

export const realMergeDeps: MergeDeps = {
  pipeline: (projectPath, iid) => getMergeRequestPipeline({ gitlabBaseUrl: config.gitlab.baseUrl, token: config.gitlab.token, projectPath, iid }),
  merge: (projectPath, iid, sha) => mergeMergeRequest({ gitlabBaseUrl: config.gitlab.baseUrl, token: config.gitlab.token, projectPath, iid, sha }),
};

export function installOwnerBridge(
  bot: Bot,
  chatId: number,
  opts: { pollMs?: number; pushDeps?: PushDeps; mergeDeps?: MergeDeps } = {},
): () => void {
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
      if (l.from === FLEET_ADDRESS && l.subject.startsWith("Готово к мержу") && loadPush(stateDir, l.thread)?.mr) {
        kb.text("🔀 Смержить", `fleet_merge:${tokenFor(l.thread)}`).row();
      }
      if (l.thread === DEPUTY_THREAD && l.from === "xentra/pm") {
        // The deputy chat reads like a conversation: no thread footer, no buttons, and the
        // letter is archived right away — the chat itself is the record.
        try {
          const text = `🧑‍💼 Зам. CTO\n\n${l.body}`.slice(0, MAX_TG);
          const msg = await bot.api.sendMessage(chatId, text);
          st.forwarded[String(msg.message_id)] = { letterId: l.id, thread: l.thread, from: l.from, repo: l.repo, subject: l.subject };
          st.seen.push(l.id);
          saveState(st);
          archive(spool, OWNER_ADDRESS, l.id);
        } catch (err) {
          console.error("[fleet-bridge] forward failed:", (err as Error).message);
          return;
        }
        continue;
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

  bot.callbackQuery(/^fleet_merge:(\d+)$/, async (ctx) => {
    const thread = st.tokens?.[ctx.match[1]];
    const p = thread ? loadPush(stateDir, thread) : undefined;
    if (!thread || !p?.mr) return void (await ctx.answerCallbackQuery({ text: "Запрос устарел", show_alert: true }));
    await ctx.answerCallbackQuery({ text: "Проверяю и мержу…" });
    const deps = opts.mergeDeps ?? realMergeDeps;
    try {
      // Re-checked at click time: CI, verdicts or the head may have changed since the letter.
      const auditors = loadRoles().filter((r) => r.isAuditor).map((r) => r.role);
      const r = checkReadiness(stateDir, p, await deps.pipeline(p.gitlabProjectPath, p.mr.iid), auditors);
      if (!r.ready || !r.sha) {
        await ctx.reply(`Не мержу: ${r.reasons.join("; ")}`);
        return;
      }
      await deps.merge(p.gitlabProjectPath, p.mr.iid, r.sha);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await ctx.reply(`🔀 Смержено: ${p.mr.webUrl}`);
      notifyRequester(thread, p.requestedBy, "Смержено", `Владелец смержил MR !${p.mr.iid}. ${p.mr.webUrl}`);
    } catch (err) {
      await ctx.reply(`Мерж не удался: ${(err as Error).message}`);
    }
  });

  bot.command("veto", async (ctx) => {
    const t = ctx.match?.toString().trim();
    if (!t) return void (await ctx.reply("Укажи тред: /veto <тред>"));
    setVeto(stateDir, t, true);
    await ctx.reply(`⛔ Вето на мерж треда ${t}. Снять — /unveto ${t}`);
  });

  bot.command("unveto", async (ctx) => {
    const t = ctx.match?.toString().trim();
    if (!t) return void (await ctx.reply("Укажи тред: /unveto <тред>"));
    setVeto(stateDir, t, false);
    await ctx.reply(`Вето с треда ${t} снято.`);
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

  function fleetStatusText(): string {
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
    return [
      `🛰 Флот ролей · ${new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`,
      limits.summary(),
      "",
      running.length ? running.join("\n") : "Сейчас никто не работает.",
      queue.length ? queue.join("\n") : "Очереди пусты.",
      holds.length ? `⛔ Остановлены треды: ${holds.join(", ")}` : "",
      "",
      "/fleet_pause [роль] · /fleet_resume [роль] · /fleet_override",
    ]
      .filter((x, i, a) => x !== "" || a[i - 1] !== "")
      .join("\n");
  }

  const statusKeyboard = () =>
    new InlineKeyboard()
      .text("🔄 Обновить", "fleet_st:refresh")
      .text("📜 Сессии", "fleet_st:sessions")
      .row()
      .text("📈 Метрики", "fleet_st:metrics")
      .text("🧑‍💼 Зам. CTO", "fleet_dep:on");

  const showStatus = (ctx: Context) => ctx.reply(fleetStatusText(), { reply_markup: statusKeyboard() });
  bot.command("fleet_status", showStatus);
  bot.hears(MENU.fleet, showStatus);

  bot.callbackQuery("fleet_st:refresh", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Обновлено" });
    await ctx.editMessageText(fleetStatusText(), { reply_markup: statusKeyboard() }).catch(() => {});
  });

  bot.callbackQuery("fleet_st:metrics", async (ctx) => {
    await ctx.answerCallbackQuery();
    const text = formatMetrics(computeMetrics(spool, stateDir, loadRoles(), Date.now() - 7 * 86_400_000));
    await ctx.reply(text.length > 3900 ? `${text.slice(0, 3900)}…` : text);
  });

  // Recent agent sessions of both the pipeline and the fleet, newest first, as buttons.
  const showSessions = async (ctx: Context) => {
    const journals = listJournals([HARNESS_STATE_DIR, stateDir]).slice(-10).reverse();
    if (journals.length === 0) {
      await ctx.reply("Сессий пока нет — агенты ещё не работали.");
      return;
    }
    const kb = new InlineKeyboard();
    for (const j of journals) {
      const when = new Date(j.mtimeMs).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      const task = j.task.startsWith("fleet-") ? j.task.slice(6, 30) : j.task;
      kb.text(`${when} · ${task} · ${j.label}`, `fleet_sess:${tokenFor(j.path)}`).row();
    }
    saveState(st);
    await ctx.reply("Последние сессии агентов — нажми, чтобы посмотреть:", { reply_markup: kb });
  };
  bot.command("sessions", showSessions);
  bot.callbackQuery("fleet_st:sessions", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showSessions(ctx);
  });

  bot.callbackQuery(/^fleet_sess:(\d+)$/, async (ctx) => {
    const path = st.tokens?.[ctx.match[1]];
    const j = path ? listJournals([HARNESS_STATE_DIR, stateDir]).find((x) => x.path === path) : undefined;
    if (!j) return void (await ctx.answerCallbackQuery({ text: "Сессия не найдена (журнал удалён?)", show_alert: true }));
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard().text("🔄 Обновить", `fleet_sess:${ctx.match[1]}`);
    await ctx.reply(sessionCard(j.path, j.task, j.label), { parse_mode: "HTML", reply_markup: kb });
  });

  // --- "Зам. CTO": a standing conversation with pm in one permanent thread.
  const deputyOn = async (ctx: Context) => {
    st.deputyMode = true;
    saveState(st);
    await ctx.reply(
      "🧑‍💼 Режим «Зам. CTO»: пиши как человеку — сообщения уходят pm в постоянный тред, он помнит прошлые разговоры и видит весь флот. Ответ придёт сюда.",
      { reply_markup: new InlineKeyboard().text("Выйти из режима", "fleet_dep:off") },
    );
  };
  bot.hears(MENU.deputy, deputyOn);
  bot.command("deputy", deputyOn);
  bot.callbackQuery("fleet_dep:on", async (ctx) => {
    await ctx.answerCallbackQuery();
    await deputyOn(ctx);
  });
  bot.callbackQuery("fleet_dep:off", async (ctx) => {
    st.deputyMode = false;
    saveState(st);
    await ctx.answerCallbackQuery({ text: "Режим выключен" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await ctx.reply("Вышла из режима «Зам. CTO». Свободный текст снова идёт обычному боту.");
  });

  bot.command("fleet_metrics", async (ctx) => {
    const days = Number(ctx.match?.toString().trim() || 7);
    const since = Date.now() - (Number.isFinite(days) && days > 0 ? days : 7) * 86_400_000;
    const text = formatMetrics(computeMetrics(spool, stateDir, loadRoles(), since));
    await ctx.reply(text.length > 3900 ? `${text.slice(0, 3900)}…` : text);
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
    if (!text || text.startsWith("/") || MENU_LABELS.includes(text)) return next();
    if (!fwd && st.deputyMode) {
      try {
        send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: text.split("\n")[0].slice(0, 60), body: text, thread: DEPUTY_THREAD });
        await ctx.react("👀").catch(() => {});
      } catch (err) {
        await ctx.reply(`Не отправил: ${(err as Error).message}`);
      }
      return;
    }
    if (!fwd) return next();
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

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { InlineKeyboard, type Bot, type Context } from "grammy";
import { ALL_MENU_LABELS } from "../bot/taskBrowser.js";
import { HARNESS_STATE_DIR } from "../bot/liveState.js";
import { config } from "../config.js";
import { formatEvent, listJournals, sessionInfo } from "../engine/sessionView.js";
import { createMergeRequest, getMergeRequestPipeline, mergeMergeRequest, pushBranch } from "../gitlab.js";
import { DEPUTY_THREAD } from "./deputy.js";
import { FleetLimits } from "./limits.js";
import { requestKill } from "./lock.js";
import { listHolds, releaseHold } from "./loopGuard.js";
import { Spool, archive, findInInbox, readInbox, send, type Letter } from "./mail.js";
import { checkReadiness, setVeto, type MergeDeps } from "./mergeBot.js";
import { computeMetrics, formatMetrics } from "./metrics.js";
import { fleetAlive, roleName, threadTitle } from "./names.js";
import { approvePush, declinePush, listPushes, loadPush, type PushDeps } from "./pushRequests.js";
import { OWNER_ADDRESS, loadRoles, poolAddresses } from "./roles.js";
import { FLEET_ADDRESS } from "./supervisor.js";
import { WATCHER_ADDRESSES } from "./watchers.js";
import { fleetHome, workspaceHead } from "./workspace.js";

// Everything about the team (role fleet) in Telegram. The owner is the mailbox
// xentra/owner; this bridge makes it a chat:
// - letters to the owner arrive as messages with plain names ("Разработчик 1 · XEN-55 ·
//   Фильтр архива"), a reply goes back into the same task;
// - free text goes to «Зам. CTO» (pm) in one permanent thread while the team is running;
// - push / merge decisions are buttons; sessions can be browsed; tasks handed to the team.
// The bot composes the menu from this (OwnerBridge) — see bot.ts.
// Installed AFTER the bot's access guard and BEFORE its free-text handler: it passes on
// commands, menu buttons and anything it doesn't own.

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
  // Short tokens for button data (Telegram caps it at 64 bytes; ids and paths are longer).
  tokens?: Record<string, string>;
  nextToken?: number;
  // letter id -> how many times forwarding it failed (see MAX_FORWARD_FAILURES)
  failed?: Record<string, number>;
}

// A letter whose forwarding keeps failing (Telegram rejects the message, network) is
// skipped after this many ticks so it can't block every letter behind it forever.
export const MAX_FORWARD_FAILURES = 3;
// Telegram's hard cap on inline button callback_data.
export const CALLBACK_DATA_MAX_BYTES = 64;

export interface OwnerBridge {
  stop(): void;
  alive(): boolean;
  statusLines(): string[];
  assignToTeam(issue: { key: string; summary: string; description: string }): Letter;
  showSessions(ctx: Context): Promise<void>;
  showMetrics(ctx: Context): Promise<void>;
  deputyIntro(ctx: Context): Promise<void>;
  isPaused(): boolean;
  pause(): void;
  resume(): void;
  overrideToday(): void;
  limitsSummary(): string;
  holds(): Array<{ title: string; token: string }>;
  // Roles with a session running now, with a token for the «прервать» button.
  running(): Array<{ role: string; name: string; title: string; token: string }>;
}

const MAX_TG = 3800;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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
  // Bounded: old mappings only matter while someone might still reply or tap.
  const keys = Object.keys(st.forwarded);
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete st.forwarded[k];
  st.seen = st.seen.slice(-2000);
  if (st.tokens) {
    const tk = Object.keys(st.tokens);
    if (tk.length > 500) for (const k of tk.slice(0, tk.length - 500)) delete st.tokens[k];
  }
  writeFileSync(statePath(), JSON.stringify(st, null, 2));
}

export function formatForTelegram(l: Letter, title = l.thread): string {
  const urgent = l.priority === "high" || l.priority === "urgent" ? " ❗" : "";
  const head = `✉️ ${roleName(l.from)}${urgent} · ${title}\n«${l.subject}»`;
  const tail = "\n\n↩️ Ответь реплаем — ответ уйдёт в эту задачу.";
  const room = MAX_TG - head.length - tail.length - 4;
  const body = l.body.length > room ? `${l.body.slice(0, room)}…` : l.body;
  return `${head}\n\n${body}${tail}`;
}

// Who gets the owner's reply: the letter's sender, except notices (system, CI, Jira) —
// those don't read mail, so the reply goes to Зам. CTO, who runs the task.
export function replyTarget(from: string): string {
  return from === FLEET_ADDRESS || WATCHER_ADDRESSES.includes(from) ? "xentra/pm" : from;
}

// Readable tail of one session journal + the command to open it in Claude Code.
export function sessionCard(path: string, title: string, role: string, maxLines = 25): string {
  const lines = readFileSync(path, "utf8").split("\n").flatMap((l) => (l ? formatEvent(l, { textChars: 250 }) : []));
  const info = sessionInfo(path);
  const body = escapeHtml(lines.slice(-maxLines).join("\n")).slice(-3000);
  const open =
    info.sessionId && info.cwd
      ? `\n\nОткрыть в терминале (копия, агенту не мешает):\n<code>cd ${escapeHtml(info.cwd)} &amp;&amp; claude --resume ${info.sessionId} --fork-session</code>`
      : "";
  const more = lines.length > maxLines ? ` (последние ${maxLines} из ${lines.length})` : "";
  return `<b>${escapeHtml(title)} · ${escapeHtml(role)}</b>${more}\n\n${body || "(пусто)"}${open}`;
}

export const realPushDeps: PushDeps = {
  push: (dir, branch) => pushBranch(dir, branch),
  headSha: (dir) => workspaceHead(dir),
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

export const realMergeDeps: MergeDeps = {
  pipeline: (projectPath, iid) => getMergeRequestPipeline({ gitlabBaseUrl: config.gitlab.baseUrl, token: config.gitlab.token, projectPath, iid }),
  merge: (projectPath, iid, sha) => mergeMergeRequest({ gitlabBaseUrl: config.gitlab.baseUrl, token: config.gitlab.token, projectPath, iid, sha }),
};

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

export function installOwnerBridge(
  bot: Bot,
  chatId: number,
  opts: { pollMs?: number; pushDeps?: PushDeps; mergeDeps?: MergeDeps } = {},
): OwnerBridge {
  const spool = spoolWithMailboxes();
  const st = loadState();
  const stateDir = join(fleetHome(), "state");
  const limits = new FleetLimits(stateDir);
  const title = (thread: string) => threadTitle(spool, thread);
  const tokenFor = (value: string): string => {
    st.tokens ??= {};
    st.nextToken ??= 1;
    const t = String(st.nextToken++);
    st.tokens[t] = value;
    return t;
  };
  const remember = (msgId: number, l: Letter) => {
    st.forwarded[String(msgId)] = { letterId: l.id, thread: l.thread, from: l.from, repo: l.repo, subject: l.subject };
    st.seen.push(l.id);
    saveState(st);
  };

  // --- letters to the owner -> chat
  async function forwardNew(): Promise<void> {
    for (const l of readInbox(spool, OWNER_ADDRESS)) {
      if (l.kind || st.seen.includes(l.id)) continue;
      try {
        if (l.thread === DEPUTY_THREAD && l.from === "xentra/pm") {
          // The deputy chat reads like a conversation: no footer, no buttons; archived at once.
          const msg = await bot.api.sendMessage(chatId, `🧑‍💼 ${l.body}`.slice(0, MAX_TG));
          remember(msg.message_id, l);
          archive(spool, OWNER_ADDRESS, l.id);
          continue;
        }
        const kb = new InlineKeyboard();
        if (l.from === FLEET_ADDRESS && l.subject.startsWith("Запрос на push") && loadPush(stateDir, l.thread)?.status === "pending") {
          const t = tokenFor(l.thread);
          kb.text("🚀 Push и MR", `fleet_push:${t}`).text("✋ Не сейчас", `fleet_nopush:${t}`).row();
        }
        if (l.from === FLEET_ADDRESS && l.subject.startsWith("Готово к мержу") && loadPush(stateDir, l.thread)?.mr) {
          kb.text("🔀 Смержить", `fleet_merge:${tokenFor(l.thread)}`).row();
        }
        // Letter ids carry the subject slug (up to ~80 bytes): a token, like every other button.
        kb.text("✅ Прочитано", `fleet_read:${tokenFor(l.id)}`);
        const msg = await bot.api.sendMessage(chatId, formatForTelegram(l, title(l.thread)), { reply_markup: kb });
        remember(msg.message_id, l);
      } catch (err) {
        const n = ((st.failed ??= {})[l.id] ?? 0) + 1;
        st.failed[l.id] = n;
        console.error(`[fleet-bridge] forward of ${l.id} failed (${n}/${MAX_FORWARD_FAILURES}):`, (err as Error).message);
        if (n < MAX_FORWARD_FAILURES) {
          saveState(st);
          return; // try again next tick, keep order
        }
        // Give up on this one: it stays in the owner's Inbox (fleet mail check / console),
        // the chat gets a short plain notice, and the letters behind it go through.
        st.seen.push(l.id);
        delete st.failed[l.id];
        saveState(st);
        await bot.api
          .sendMessage(chatId, `⚠️ Не смогла переслать письмо ${roleName(l.from)} · ${title(l.thread)} (${(err as Error).message.slice(0, 120)}). Оно лежит в почте: fleet mail read --keep ${l.id}`)
          .catch(() => {});
      }
    }
  }
  const timer = setInterval(() => void forwardNew(), opts.pollMs ?? 10_000);
  void forwardNew();

  bot.callbackQuery(/^fleet_read:(.+)$/, async (ctx) => {
    // Token (current messages) or a raw letter id (messages sent before tokens were used).
    const id = st.tokens?.[ctx.match[1]] ?? ctx.match[1];
    archive(spool, OWNER_ADDRESS, id);
    await ctx.answerCallbackQuery({ text: "Убрала в архив" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  const notifyRequester = (thread: string, requestedBy: string, subject: string, body: string) => {
    try {
      send(spool, { from: FLEET_ADDRESS, to: [requestedBy], subject, body, thread });
    } catch (err) {
      console.error("[fleet-bridge] notify requester failed:", (err as Error).message);
    }
  };

  // --- push / merge decisions
  bot.callbackQuery(/^fleet_push:(\d+)$/, async (ctx) => {
    const thread = st.tokens?.[ctx.match[1]];
    if (!thread) return void (await ctx.answerCallbackQuery({ text: "Запрос устарел", show_alert: true }));
    await ctx.answerCallbackQuery({ text: "Пушу…" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    try {
      const r = await approvePush(stateDir, thread, opts.pushDeps ?? realPushDeps);
      if (r.status === "pushed") {
        await ctx.reply(`🚀 Готово: ${title(thread)}${r.mr ? `\nMR: ${r.mr.webUrl}` : ""}`);
        notifyRequester(thread, r.requestedBy, "Push выполнен", `Владелец одобрил. Ветка \`${r.branch}\` запушена.${r.mr ? ` MR: ${r.mr.webUrl}` : ""}`);
      } else if (r.status === "stale") {
        await ctx.reply(`✋ Не пушу: ${r.error}. Зам. CTO пришлёт новый запрос с актуальным diff.`);
        notifyRequester(thread, r.requestedBy, "Push не выполнен: ветка изменилась", `Владелец одобрил, но ${r.error}. Проверь состояние ветки и, если всё ещё нужно, запроси <push/> заново.`);
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
      if (!r.ready || !r.sha) return void (await ctx.reply(`Не мержу: ${r.reasons.join("; ")}`));
      await deps.merge(p.gitlabProjectPath, p.mr.iid, r.sha);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await ctx.reply(`🔀 Смержено: ${p.mr.webUrl}`);
      notifyRequester(thread, p.requestedBy, "Смержено", `Владелец смержил MR !${p.mr.iid}. ${p.mr.webUrl}`);
    } catch (err) {
      await ctx.reply(`Мерж не удался: ${(err as Error).message}`);
    }
  });

  // Hidden power-user commands (not in help): veto by thread id.
  bot.command("veto", async (ctx) => {
    const t = ctx.match?.toString().trim();
    if (!t) return void (await ctx.reply("Укажи тред: /veto <тред>"));
    setVeto(stateDir, t, true);
    await ctx.reply(`⛔ Мерж запрещён: ${title(t)}. Снять — /unveto ${t}`);
  });
  bot.command("unveto", async (ctx) => {
    const t = ctx.match?.toString().trim();
    if (!t) return void (await ctx.reply("Укажи тред: /unveto <тред>"));
    setVeto(stateDir, t, false);
    await ctx.reply(`Запрет мержа снят: ${title(t)}.`);
  });

  // --- a task for the team
  const assignToTeam = (issue: { key: string; summary: string; description: string }): Letter =>
    send(spool, {
      from: OWNER_ADDRESS,
      to: ["xentra/pm"],
      subject: `${issue.key}: ${issue.summary}`.slice(0, 120),
      body: `${issue.description.trim() || "(без описания)"}\n\nЗадача из Jira ${issue.key}, передана команде владельцем.`,
      key: /^[A-Z][A-Z0-9]+-\d+$/.test(issue.key) ? issue.key : undefined,
    });

  bot.command("fleet", async (ctx) => {
    const text = ctx.match?.toString().trim();
    if (!text) return void (await ctx.reply("Напиши задачу после команды: /fleet <что сделать>."));
    const key = /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(text)?.[1];
    send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: text.split("\n")[0].slice(0, 80), body: text, key });
    await ctx.reply(`👥 Передала команде.${fleetAlive(stateDir) ? " Зам. CTO напишет план." : " Команда сейчас не запущена — задача подождёт."}`);
  });

  // --- sessions
  const sessionTitle = (task: string) => (task.startsWith("fleet-") ? title(task.slice(6)) : task);
  const showSessions = async (ctx: Context) => {
    const journals = listJournals([HARNESS_STATE_DIR, stateDir]).slice(-10).reverse();
    if (journals.length === 0) return void (await ctx.reply("Сессий пока нет — агенты ещё не работали."));
    const kb = new InlineKeyboard();
    for (const j of journals) {
      const when = new Date(j.mtimeMs).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      kb.text(`${when} · ${roleName(j.label)} · ${sessionTitle(j.task).slice(0, 30)}`, `fleet_sess:${tokenFor(j.path)}`).row();
    }
    saveState(st);
    await ctx.reply("Последние сессии агентов — нажми, чтобы посмотреть, что агент делал:", { reply_markup: kb });
  };
  bot.command("sessions", showSessions);

  bot.callbackQuery(/^fleet_sess:(\d+)$/, async (ctx) => {
    const path = st.tokens?.[ctx.match[1]];
    const j = path ? listJournals([HARNESS_STATE_DIR, stateDir]).find((x) => x.path === path) : undefined;
    if (!j) return void (await ctx.answerCallbackQuery({ text: "Сессия не найдена (журнал удалён?)", show_alert: true }));
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard().text("🔄 Обновить", `fleet_sess:${ctx.match[1]}`);
    await ctx.reply(sessionCard(j.path, sessionTitle(j.task), roleName(j.label)), { parse_mode: "HTML", reply_markup: kb });
  });

  const showMetrics = async (ctx: Context) => {
    const text = formatMetrics(computeMetrics(spool, stateDir, loadRoles(), Date.now() - 7 * 86_400_000));
    await ctx.reply(text.length > 3900 ? `${text.slice(0, 3900)}…` : text);
  };
  bot.command("fleet_metrics", showMetrics);

  // --- running sessions: the owner can interrupt one (state/kill.<role>, served by the supervisor)
  const runningRoles = (): Array<{ role: string; thread?: string }> =>
    existsSync(stateDir)
      ? readdirSync(stateDir)
          .filter((f) => f.startsWith("running."))
          .map((f) => {
            const role = f.slice(8);
            try {
              return { role, thread: JSON.parse(readFileSync(join(stateDir, f), "utf8")).thread as string | undefined };
            } catch {
              return { role };
            }
          })
      : [];
  const running = () => runningRoles().map((r) => ({ role: r.role, name: roleName(r.role), title: r.thread ? title(r.thread) : "", token: tokenFor(r.role) }));
  bot.callbackQuery(/^fleet_kill:(\d+)$/, async (ctx) => {
    const role = st.tokens?.[ctx.match[1]];
    if (!role || !runningRoles().some((r) => r.role === role)) return void (await ctx.answerCallbackQuery({ text: "Эта роль уже ничего не делает", show_alert: true }));
    requestKill(stateDir, role);
    await ctx.answerCallbackQuery({ text: "Прерываю…" });
    await ctx.reply(`⛔ Прерываю сессию: ${roleName(role)}. Незаконченные правки сохранятся WIP-коммитом, письмо вернётся отправителю как «Не выполнено».`);
  });

  // --- holds (threads stopped by the echo guard)
  const holds = () => listHolds(spool).map((t) => ({ title: title(t), token: tokenFor(t) }));
  bot.callbackQuery(/^fleet_rel:(\d+)$/, async (ctx) => {
    const t = st.tokens?.[ctx.match[1]];
    const ok = t ? releaseHold(spool, t) : false;
    await ctx.answerCallbackQuery({ text: ok ? "Снова работает" : "Уже не остановлен" });
    if (ok && t) await ctx.reply(`▶️ Снова работает: ${title(t)}`);
  });

  // --- «Зам. CTO»
  const alive = () => fleetAlive(stateDir);
  const deputyIntro = async (ctx: Context) => {
    await ctx.reply(
      alive()
        ? "🧑‍💼 Я здесь. Пиши как человеку — спросить, что происходит, обсудить или поставить задачу. Помню наши прошлые разговоры и вижу всю команду."
        : "🧑‍💼 Команда сейчас не запущена, поэтому я не отвечу. Запусти на ноутбуке `node dist/cli.js fleet run` — и пиши сюда.",
    );
  };
  bot.command("deputy", deputyIntro);

  // --- free text: a reply to a forwarded letter, or a message to Зам. CTO
  bot.on("message:text", async (ctx: Context, next) => {
    const text = ctx.message?.text?.trim() ?? "";
    if (!text || text.startsWith("/") || ALL_MENU_LABELS.includes(text)) return next();
    const replyTo = ctx.message?.reply_to_message?.message_id;
    const fwd = replyTo !== undefined ? st.forwarded[String(replyTo)] : undefined;
    try {
      if (fwd) {
        send(spool, {
          from: OWNER_ADDRESS,
          to: [replyTarget(fwd.from)],
          subject: fwd.subject.startsWith("Re:") ? fwd.subject : `Re: ${fwd.subject}`,
          body: text,
          thread: fwd.thread,
          repo: fwd.repo,
        });
        if (findInInbox(spool, OWNER_ADDRESS, fwd.letterId)) archive(spool, OWNER_ADDRESS, fwd.letterId);
        if (fwd.thread === DEPUTY_THREAD) await ctx.react("👀").catch(() => {});
        else await ctx.reply(`📨 Ответ ушёл: ${roleName(replyTarget(fwd.from))} · ${title(fwd.thread)}`);
        return;
      }
      if (!alive()) return next(); // the team is down: the bot answers as before
      send(spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: text.split("\n")[0].slice(0, 60), body: text, thread: DEPUTY_THREAD });
      await ctx.react("👀").catch(() => {});
    } catch (err) {
      await ctx.reply(`Не отправила: ${(err as Error).message}`);
    }
  });

  // --- status lines for the combined «Что происходит»
  const statusLines = (): string[] => {
    const lines: string[] = [];
    const paused = limits.isFleetPaused();
    lines.push(`👥 Команда: ${!alive() ? "не запущена" : paused ? "на паузе" : "работает"}`);
    const running = existsSync(stateDir)
      ? readdirSync(stateDir)
          .filter((f) => f.startsWith("running."))
          .map((f) => {
            try {
              const r = JSON.parse(readFileSync(join(stateDir, f), "utf8"));
              return `   ▶️ ${roleName(f.slice(8))} — ${title(r.thread)} (с ${new Date(r.startedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })})`;
            } catch {
              return `   ▶️ ${roleName(f.slice(8))}`;
            }
          })
      : [];
    lines.push(...running);
    const queue = loadRoles()
      .map((r) => [roleName(r.role), readInbox(spool, r.mail).filter((l) => !l.kind).length] as const)
      .filter(([, n]) => n > 0);
    if (queue.length) lines.push(`   📥 ждут очереди: ${queue.map(([r, n]) => `${r} ${n}`).join(", ")}`);
    const pendingPush = listPushes(stateDir).filter((p) => p.status === "pending");
    for (const p of pendingPush) lines.push(`   🙋 ждёт твоего решения: push «${title(p.thread)}»`);
    const held = listHolds(spool);
    if (held.length) lines.push(`   ⛔ остановлено (зацикливание): ${held.map(title).join("; ")}`);
    return lines;
  };

  return {
    stop: () => clearInterval(timer),
    alive,
    statusLines,
    assignToTeam,
    showSessions,
    showMetrics,
    deputyIntro,
    isPaused: () => limits.isFleetPaused(),
    pause: () => limits.pause(),
    resume: () => limits.resume(),
    overrideToday: () => limits.overrideToday(),
    limitsSummary: () => limits.summary(),
    holds: () => {
      const h = holds();
      saveState(st);
      return h;
    },
    running: () => {
      const r = running();
      saveState(st);
      return r;
    },
  };
}

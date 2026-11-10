import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { pickBatch, type Batch } from "./gate.js";
import { isHeld, placeHold, quarantine, recentRoleLetters, shouldHold } from "./loopGuard.js";
import { ack, archive, readInbox, send, thread as threadLetters, type Letter, type Spool } from "./mail.js";
import { OWNER_ADDRESS, senderAllowed, type Role } from "./roles.js";
import type { SessionRunner } from "./session.js";
import type { FleetLimits } from "./limits.js";
import { appendMemory, memoryPromptBlock } from "./memory.js";
import { branchFor } from "./workspace.js";
import { fileRequest, loadPush } from "./pushRequests.js";
import { WATCHER_ADDRESSES, addCiWatch } from "./watchers.js";
import { recordVerdict } from "./mergeBot.js";
import type { RepoTarget } from "./workspace.js";

// One supervisor process for the whole fleet (the CTO fleet runs one runner per role
// under systemd; on a Mac one Node process with a worker per role is simpler). Each
// role takes one batch at a time; each thread has at most one session at a time across
// all roles, because roles of a thread share its worktree.

export const FLEET_ADDRESS = "xentra/fleet"; // the supervisor's own mailbox (notices, gate results)
export const MAX_ATTEMPTS = 3;
// Gate runs per thread. A gate result is a letter from the supervisor, which wakes the
// role again and isn't counted by the echo guard (that one counts role letters only) —
// without a cap, a role asking <gates/> every session would loop forever.
export const MAX_GATE_RUNS = 8;
const NOT_DONE = "Не выполнено:";

export interface WorkspaceOps {
  ensure(repo: RepoTarget, thread: string, opts: { baselines: boolean }): Promise<string>;
  commit(dir: string, message: string): Promise<boolean>;
  gates(repo: RepoTarget, dir: string): Promise<{ passed: boolean; output: string; gates: Array<{ name: string; passed: boolean }> }>;
  diffStat(dir: string, baseBranch: string): Promise<string>;
  headSha(dir: string): Promise<string>;
}

export interface SupervisorOptions {
  spool: Spool;
  roles: Role[];
  repos: Record<RepoTarget["kind"], RepoTarget | undefined>;
  stateDir: string;
  runSession: SessionRunner;
  workspace: WorkspaceOps;
  log?: (line: string) => void;
  pollMs?: number;
  // Start gate (pause, daily caps, override). Absent = no limits (tests, `fleet once`).
  limits?: FleetLimits;
}

export class Supervisor {
  private busyRoles = new Set<string>();
  private lastBlock = new Map<string, string>();
  private busyThreads = new Set<string>();
  private running = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private watchers: FSWatcher[] = [];
  private stopped = false;

  constructor(private readonly o: SupervisorOptions) {
    o.spool.register(FLEET_ADDRESS);
    o.spool.register(OWNER_ADDRESS);
    for (const w of WATCHER_ADDRESSES) o.spool.register(w);
    for (const r of o.roles) o.spool.register(r.mail);
  }

  private log(line: string): void {
    this.o.log?.(`[fleet] ${line}`);
  }

  start(): void {
    const kick = () => {
      if (!this.stopped) this.tick();
    };
    for (const r of this.o.roles) {
      try {
        this.watchers.push(watch(this.o.spool.dir("Inbox", r.mail), kick));
      } catch {
        /* polling still covers it */
      }
    }
    this.timer = setInterval(kick, this.o.pollMs ?? 10_000);
    kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    for (const w of this.watchers) w.close();
    await Promise.all(this.running);
  }

  // Runs until no role has anything left to do (used by `fleet once` and tests).
  async settle(maxRounds = 200): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      this.tick();
      if (this.running.size === 0) return;
      await Promise.all([...this.running]);
    }
  }

  // Starts a batch for every idle role that has one. Returns the started sessions'
  // promises so tests (and `fleet once`) can wait for them.
  tick(): Promise<void>[] {
    const started: Promise<void>[] = [];
    for (const role of this.o.roles) {
      if (this.busyRoles.has(role.role)) continue;
      const batch = this.prepare(role);
      if (!batch) continue;
      const blocked = this.o.limits?.blockReason(role);
      if (blocked) {
        // Letters wait in the Inbox; no attempt is counted. Logged once per reason.
        if (this.lastBlock.get(role.role) !== blocked) this.log(`${role.role}: waiting — ${blocked}`);
        this.lastBlock.set(role.role, blocked);
        continue;
      }
      this.lastBlock.delete(role.role);
      this.busyRoles.add(role.role);
      this.busyThreads.add(batch.thread);
      const p = this.handle(role, batch)
        .catch((err) => this.log(`${role.role}: session failed hard: ${(err as Error).message}`))
        .finally(() => {
          this.busyRoles.delete(role.role);
          this.busyThreads.delete(batch.thread);
          this.running.delete(p);
          if (!this.stopped) setImmediate(() => this.tick());
        });
      this.running.add(p);
      started.push(p);
    }
    return started;
  }

  // Housekeeping on the Inbox, then the next batch (or nothing).
  private prepare(role: Role): Batch | undefined {
    const { spool } = this.o;
    const letters = readInbox(spool, role.mail);
    const live: Letter[] = [];
    for (const l of letters) {
      if (l.kind) {
        archive(spool, role.mail, l.id); // a stray ack never opens a session
      } else if (isHeld(spool, l.thread) && l.from !== OWNER_ADDRESS) {
        quarantine(spool, role.mail, l);
        this.log(`${role.role}: quarantined ${l.id} (thread ${l.thread} on hold)`);
      } else if (!senderAllowed(role, l.from)) {
        this.notifyOnce(l, `${NOT_DONE} ${l.subject}`, `Роль ${role.mail} принимает письма только от: ${role.acceptFrom.join(", ")}.`);
        archive(spool, role.mail, l.id);
      } else {
        live.push(l);
      }
    }
    return pickBatch(live, { skip: (l) => this.busyThreads.has(l.thread) });
  }

  private async handle(role: Role, batch: Batch): Promise<void> {
    const { spool } = this.o;
    const letters = [batch.primary, ...batch.extras];
    const repoKind = (batch.repo as RepoTarget["kind"] | undefined) ?? role.defaultRepo;
    const repo = this.o.repos[repoKind];
    if (!repo) {
      for (const l of letters) {
        this.notifyOnce(l, `${NOT_DONE} ${l.subject}`, `Репозиторий «${repoKind}» не настроен во флоте.`);
        archive(spool, role.mail, l.id);
      }
      return;
    }
    for (const l of letters) this.autoAck(role, l, "сессия начата");
    this.log(`${role.role}: thread ${batch.thread}, ${letters.length} letter(s), primary ${batch.primary.id}`);

    const cwd = await this.o.workspace.ensure(repo, batch.thread, { baselines: role.access === "edit" });
    const history = threadLetters(spool, batch.thread).filter((l) => !l.kind && !letters.some((x) => x.id === l.id));
    const runningFile = join(this.o.stateDir, `running.${role.role}`);
    mkdirSync(this.o.stateDir, { recursive: true });
    writeFileSync(runningFile, JSON.stringify({ thread: batch.thread, primary: batch.primary.id, startedAt: new Date().toISOString() }));
    const keys = [...new Set(letters.map((l) => l.key).filter((k): k is string => !!k))];
    const memory = memoryPromptBlock(this.o.stateDir, batch.thread, keys);
    let outcome;
    try {
      outcome = await this.o.runSession({ role, batch, cwd, stateDir: this.o.stateDir, history, memory });
    } finally {
      rmSync(runningFile, { force: true });
    }
    this.o.limits?.record(role.engine, outcome.costUsd);

    // Deliver what the role asked for. A bad block fails alone and is reported back.
    const answered = new Set<string>();
    const problems: string[] = [];
    for (const m of outcome.actions.mails) {
      const oneWay = m.to.filter((a) => WATCHER_ADDRESSES.includes(a) || a === FLEET_ADDRESS);
      if (oneWay.length > 0) {
        problems.push(`${oneWay.join(", ")} — уведомители, писем не читают; ставь им <ack>, а вопросы — pm или владельцу`);
        continue;
      }
      try {
        send(spool, {
          from: role.mail,
          to: m.to,
          subject: m.subject,
          body: m.body,
          priority: m.priority,
          thread: m.newThread ? undefined : batch.thread,
          repo: m.repo ?? batch.repo,
          key: m.key ?? keys[0],
        });
        if (!m.newThread) for (const l of letters) answered.add(l.id);
      } catch (err) {
        problems.push(`письмо «${m.subject}» не отправлено: ${(err as Error).message}`);
      }
    }
    for (const a of outcome.actions.acks) {
      const target = letters.find((l) => l.id === a.id);
      if (!target) {
        problems.push(`квитанция на ${a.id}: такого письма нет в этой сессии`);
        continue;
      }
      try {
        ack(spool, role.mail, target, { note: a.note });
        answered.add(target.id);
      } catch (err) {
        problems.push(`квитанция на ${a.id}: ${(err as Error).message}`);
      }
    }

    for (const m of outcome.actions.memory) {
      if (m.scope === "thread") {
        appendMemory(this.o.stateDir, "thread", batch.thread, { role: role.role, text: m.text });
      } else {
        const key = m.key ?? keys[0];
        if (key && /^[A-Z][A-Z0-9]+-\d+$/.test(key)) appendMemory(this.o.stateDir, "task", key, { role: role.role, text: m.text });
        else problems.push("память задачи не записана: у треда нет ключа Jira — укажи key=\"XEN-…\" в блоке <memory>");
      }
    }

    if (role.access === "edit") {
      const committed = await this.o.workspace.commit(cwd, `fleet(${role.role}): ${batch.primary.subject}\n\nThread ${batch.thread}.`);
      if (committed) this.log(`${role.role}: committed edits in ${cwd}`);
    }

    if (outcome.actions.gates && this.bumpCounter(`gates.${batch.thread}`) > MAX_GATE_RUNS) {
      problems.push(`гейты в этом треде уже запускались ${MAX_GATE_RUNS} раз — больше не запускаю; напиши pm или владельцу, что мешает`);
    } else if (outcome.actions.gates) {
      const g = await this.o.workspace.gates(repo, cwd);
      const summary = g.gates.map((x) => `- ${x.name}: ${x.passed ? "✅" : "❌"}`).join("\n");
      send(spool, {
        from: FLEET_ADDRESS,
        to: [role.mail],
        subject: `Гейты: ${g.passed ? "зелёные" : "есть красные"}`,
        body: `${summary}\n\n${g.passed ? "" : "```\n" + g.output.slice(-6000) + "\n```"}`.trim(),
        thread: batch.thread,
        repo: batch.repo,
      });
    }

    if (role.isAuditor && outcome.ok) {
      const sha = await this.o.workspace.headSha(cwd).catch(() => "");
      const v = sha ? recordVerdict(this.o.stateDir, batch.thread, role.role, sha, outcome.resultText) : undefined;
      if (v) this.log(`${role.role}: verdict on ${sha.slice(0, 8)} — ${v.blocking ? "blocking" : "clear"}`);
    }

    if (outcome.actions.watchCi) {
      const pushed = loadPush(this.o.stateDir, batch.thread);
      if (!pushed?.mr || !repo.gitlabProjectPath) {
        problems.push("наблюдать нечего: у треда ещё нет MR (сначала <push/> и одобрение владельца)");
      } else {
        addCiWatch(this.o.stateDir, { thread: batch.thread, requestedBy: role.mail, projectPath: repo.gitlabProjectPath, mrIid: pushed.mr.iid, repo: batch.repo });
        this.log(`${role.role}: watching CI of MR !${pushed.mr.iid} for thread ${batch.thread}`);
      }
    }

    if (outcome.actions.push) {
      if (!role.canRequestPush) {
        problems.push("push может запросить только роль с правом canRequestPush (pm) — напиши pm");
      } else if (!repo.gitlabProjectPath) {
        problems.push(`для репозитория ${repo.kind} не настроен проект GitLab`);
      } else {
        const stat = await this.o.workspace.diffStat(cwd, repo.baseBranch);
        if (!stat) {
          problems.push("в ветке треда нет изменений относительно базы — пушить нечего");
        } else {
          const req = fileRequest(this.o.stateDir, {
            thread: batch.thread,
            repo: repo.kind,
            dir: cwd,
            branch: branchFor(batch.thread),
            baseBranch: repo.baseBranch,
            gitlabProjectPath: repo.gitlabProjectPath,
            title: outcome.actions.push.title,
            requestedBy: role.mail,
          });
          send(spool, {
            from: FLEET_ADDRESS,
            to: [OWNER_ADDRESS],
            subject: `Запрос на push: ${req.title}`,
            body: [
              `${role.mail} просит запушить ветку \`${req.branch}\` (${repo.kind} → ${repo.baseBranch})${req.mr ? ` — обновит MR !${req.mr.iid}` : " и открыть MR"}.`,
              "",
              "```",
              stat.slice(0, 2500),
              "```",
            ].join("\n"),
            priority: "high",
            thread: batch.thread,
            repo: batch.repo,
          });
        }
      }
    }

    if (problems.length > 0) {
      send(spool, {
        from: FLEET_ADDRESS,
        to: [role.mail],
        subject: "Не всё из ответа выполнено",
        body: problems.map((p) => `- ${p}`).join("\n"),
        thread: batch.thread,
        repo: batch.repo,
      });
    }

    for (const l of letters) {
      if (answered.has(l.id)) {
        archive(spool, role.mail, l.id);
        this.clearAttempts(role, l.id);
        continue;
      }
      const n = this.bumpAttempts(role, l.id);
      if (n >= MAX_ATTEMPTS) {
        this.notifyOnce(
          l,
          `${NOT_DONE} ${l.subject}`,
          `Роль ${role.mail} не смогла обработать письмо за ${MAX_ATTEMPTS} попытки.${outcome.error ? ` Последняя ошибка: ${outcome.error}` : ""}`,
        );
        archive(spool, role.mail, l.id);
        this.clearAttempts(role, l.id);
      }
    }
    for (const l of letters) this.autoAck(role, l, `сессия завершена ${outcome.ok ? "ok" : "с ошибкой"}`);

    this.guardThread(batch.thread);
  }

  private guardThread(thread: string): void {
    const { spool } = this.o;
    // The supervisor's own letters count too: a role that repeats the same mistake gets a
    // problem letter each time, which wakes it again — a role<->supervisor loop.
    const letters = recentRoleLetters(spool, [...this.o.roles.map((r) => r.mail), FLEET_ADDRESS], thread);
    if (!shouldHold(letters)) return;
    if (!placeHold(spool, thread)) return;
    this.log(`thread ${thread} put on hold: ${letters.length} role letters in 30 min`);
    send(spool, {
      from: FLEET_ADDRESS,
      to: [OWNER_ADDRESS],
      subject: `Тред ${thread} остановлен: похоже на зацикливание`,
      body: `Роли и супервизор отправили ${letters.length} писем в треде за 30 минут. Новые письма ролей в этом треде откладываются в карантин. Снять остановку — /release ${thread} в Telegram или \`fleet hold release ${thread}\`.`,
      priority: "high",
      thread,
    });
  }

  private autoAck(role: Role, l: Letter, note: string): void {
    try {
      ack(this.o.spool, role.mail, l, { note, auto: true });
    } catch {
      /* the sender's mailbox may be gone — receipts are best-effort */
    }
  }

  // Never notifies about a "not done" letter (that's how two notifiers loop forever),
  // and at most once per letter.
  private notifyOnce(l: Letter, subject: string, body: string): void {
    if (l.subject.startsWith(NOT_DONE) || l.from === FLEET_ADDRESS) return;
    const marker = join(this.o.stateDir, "notified", l.id);
    if (existsSync(marker)) return;
    try {
      send(this.o.spool, { from: FLEET_ADDRESS, to: [l.from], subject, body, thread: l.thread, repo: l.repo });
      mkdirSync(join(this.o.stateDir, "notified"), { recursive: true });
      writeFileSync(marker, new Date().toISOString());
    } catch (err) {
      this.log(`notify ${l.from} about ${l.id} failed: ${(err as Error).message}`);
    }
  }

  private bumpCounter(name: string): number {
    const dir = join(this.o.stateDir, "counters");
    const p = join(dir, name.replace(/[^A-Za-z0-9_.-]/g, "_"));
    const n = (existsSync(p) ? Number(readFileSync(p, "utf8")) || 0 : 0) + 1;
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, String(n));
    return n;
  }

  private attemptsPath(role: Role, id: string): string {
    return join(this.o.stateDir, role.role, `attempts.${id}`);
  }

  private bumpAttempts(role: Role, id: string): number {
    const p = this.attemptsPath(role, id);
    const n = (existsSync(p) ? Number(readFileSync(p, "utf8")) || 0 : 0) + 1;
    mkdirSync(join(this.o.stateDir, role.role), { recursive: true });
    writeFileSync(p, String(n));
    return n;
  }

  private clearAttempts(role: Role, id: string): void {
    rmSync(this.attemptsPath(role, id), { force: true });
  }
}

import { join } from "node:path";
import type { Command } from "commander";
import { config } from "../config.js";
import { listHolds, releaseHold } from "./loopGuard.js";
import { Spool, archive, readInbox, send, thread, type Priority } from "./mail.js";
import { OWNER_ADDRESS, loadRoles, poolAddresses } from "./roles.js";
import { runRoleSession } from "./session.js";
import { DEFAULT_SHUTDOWN_GRACE_MS, FLEET_ADDRESS, Supervisor } from "./supervisor.js";
import { acquireSupervisorLock, cleanStaleRunning } from "./lock.js";
import { FleetLimits } from "./limits.js";
import { pollCi, pollJira, type WatcherDeps } from "./watchers.js";
import { JiraClient } from "../jira/client.js";
import { getFailedJobs, getMergeRequestPipeline } from "../gitlab.js";
import { secretValues } from "../config.js";
import { commitWorkspace, ensureWorkspace, fleetHome, runWorkspaceGates, workspaceChanges, workspaceDiff, workspaceHead, workspaceIntegrity, type RepoTarget } from "./workspace.js";
import { mergeModeFromEnv, pollMerges } from "./mergeBot.js";
import { computeMetrics, formatMetrics } from "./metrics.js";
import { DEPUTY_THREAD, fleetSnapshot } from "./deputy.js";
import { fleetAlive, roleName, threadTitle } from "./names.js";
import { mergeMergeRequest } from "../gitlab.js";

// `fleet …` commands: the supervisor (`run`, `once`), the owner's mailbox from the
// terminal, echo holds and the role list.

async function buildSupervisor(log: (l: string) => void, opts: { limits: boolean } = { limits: true }): Promise<Supervisor> {
  const repo = (kind: RepoTarget["kind"]): RepoTarget | undefined => {
    const r = config.repos[kind];
    return r.path
      ? { kind, path: r.path, baseBranch: config.gitlab.targetBranch, gates: r.gates, gitlabProjectPath: r.gitlabProjectPath }
      : undefined;
  };
  const spool = new Spool();
  const roles = loadRoles();
  const stateDir = join(fleetHome(), "state");
  return new Supervisor({
    spool,
    roles,
    threadContext: (thread) => (thread === DEPUTY_THREAD ? fleetSnapshot(spool, stateDir, roles) : undefined),
    repos: { backend: repo("backend"), frontend: repo("frontend") },
    stateDir,
    runSession: runRoleSession,
    workspace: { ensure: ensureWorkspace, commit: commitWorkspace, gates: runWorkspaceGates, diffStat: workspaceDiff, headSha: workspaceHead, changes: workspaceChanges, integrity: workspaceIntegrity },
    log,
    limits: opts.limits ? new FleetLimits(join(fleetHome(), "state")) : undefined,
  });
}

function realWatcherDeps(log: (l: string) => void): WatcherDeps {
  const jira = new JiraClient(config.jira.baseUrl, config.jira.token);
  const gl = { gitlabBaseUrl: config.gitlab.baseUrl, token: config.gitlab.token };
  return {
    pipeline: (projectPath, iid) => getMergeRequestPipeline({ ...gl, projectPath, iid }),
    failedJobs: (projectPath, pipelineId) => getFailedJobs({ ...gl, projectPath, pipelineId }),
    jiraCard: (key) => jira.getIssueCard(key),
    jiraComments: (key) => jira.getRecentComments(key, 5),
    knownSecrets: secretValues(),
    log: (l) => log(`[fleet] ${l}`),
  };
}

// ci-watch every 2 min, jira-watch every 5 min (FLEET_CI_POLL_MS / FLEET_JIRA_POLL_MS).
function startWatchers(log: (l: string) => void): () => void {
  const spool = new Spool();
  const stateDir = join(fleetHome(), "state");
  const deps = realWatcherDeps(log);
  let ciBusy = false;
  let jiraBusy = false;
  const ci = setInterval(async () => {
    if (ciBusy) return;
    ciBusy = true;
    await pollCi(spool, stateDir, deps).catch((e) => log(`[fleet] ci-watch: ${(e as Error).message}`));
    ciBusy = false;
  }, Number(process.env.FLEET_CI_POLL_MS ?? 120_000));
  const jira = setInterval(async () => {
    if (jiraBusy) return;
    jiraBusy = true;
    await pollJira(spool, stateDir, deps).catch((e) => log(`[fleet] jira-watch: ${(e as Error).message}`));
    jiraBusy = false;
  }, Number(process.env.FLEET_JIRA_POLL_MS ?? 300_000));
  const mode = mergeModeFromEnv();
  const auditors = loadRoles().filter((r) => r.isAuditor).map((r) => r.role);
  let mergeBusy = false;
  const merge =
    mode === "off"
      ? undefined
      : setInterval(async () => {
          if (mergeBusy) return;
          mergeBusy = true;
          await pollMerges(spool, stateDir, mode, auditors, {
            pipeline: deps.pipeline,
            merge: (projectPath, iid, sha) =>
              mergeMergeRequest({ gitlabBaseUrl: config.gitlab.baseUrl, token: config.gitlab.token, projectPath, iid, sha }),
            log: (l) => log(`[fleet] ${l}`),
          }).catch((e) => log(`[fleet] merge-bot: ${(e as Error).message}`));
          mergeBusy = false;
        }, Number(process.env.FLEET_MERGE_POLL_MS ?? 300_000));
  log(`[fleet] merge bot: ${mode}${mode === "off" ? "" : ` (auditors: ${auditors.join(", ")})`}`);
  return () => {
    clearInterval(ci);
    clearInterval(jira);
    clearInterval(merge);
  };
}

function printLetter(l: { id: string; from: string; to: string[]; subject: string; date: string; thread: string; priority: string; body: string }): void {
  console.log(`--- ${l.id}\nfrom: ${l.from}  to: ${l.to.join(",")}  ${l.date}  [${l.priority}]\nthread: ${l.thread}\nsubject: ${l.subject}\n\n${l.body}\n`);
}

export function registerFleetCommands(program: Command): void {
  const fleet = program.command("fleet").description("Role fleet: mail between roles, one supervisor");

  fleet
    .command("run")
    .description("Run the supervisor until stopped (Ctrl+C)")
    .action(async () => {
      // One supervisor per spool: two would run two sessions in one worktree.
      const release = acquireSupervisorLock(join(fleetHome(), "state"));
      const sup = await buildSupervisor((l) => console.log(l));
      sup.start();
      const stopWatchers = startWatchers((l) => console.log(l));
      console.log(`[fleet] supervisor started, spool ${new Spool().root}`);
      let stopping = false;
      const shutdown = async () => {
        if (stopping) {
          // Second Ctrl+C: don't wait for the grace period, kill now.
          console.log("[fleet] killing running sessions");
          sup.killAll();
          setTimeout(() => process.exit(1), 5000).unref();
          return;
        }
        stopping = true;
        console.log(`[fleet] stopping — waiting up to ${Math.round(DEFAULT_SHUTDOWN_GRACE_MS / 1000)}s for running sessions (Ctrl+C again to kill now)`);
        stopWatchers();
        await sup.stop({ graceMs: DEFAULT_SHUTDOWN_GRACE_MS });
        release();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });

  fleet
    .command("once")
    .description("Process every pending letter, then exit")
    .action(async () => {
      const stateDir = join(fleetHome(), "state");
      const release = acquireSupervisorLock(stateDir);
      try {
        cleanStaleRunning(stateDir, (l) => console.log(`[fleet] ${l}`));
        const sup = await buildSupervisor((l) => console.log(l));
        await sup.settle();
      } finally {
        release();
      }
    });

  const mail = fleet.command("mail").description("The owner's mailbox (xentra/owner) from the terminal");

  mail
    .command("send")
    .requiredOption("--to <addresses>", "comma-separated, e.g. xentra/pm")
    .requiredOption("--subject <text>")
    .requiredOption("--body <text>")
    .option("--thread <id>", "reply into an existing thread")
    .option("--priority <p>", "low|normal|high|urgent", "normal")
    .option("--repo <name>", "backend|frontend")
    .option("--key <KEY>", "Jira key, e.g. XEN-55")
    .action((o) => {
      const spool = new Spool();
      spool.register(OWNER_ADDRESS);
      const roles = loadRoles();
      for (const r of roles) spool.register(r.mail);
      for (const pool of poolAddresses(roles).keys()) spool.register(pool);
      const l = send(spool, {
        from: OWNER_ADDRESS,
        to: String(o.to).split(",").map((s: string) => s.trim()),
        subject: o.subject,
        body: o.body,
        thread: o.thread,
        priority: o.priority as Priority,
        repo: o.repo,
        key: o.key,
      });
      console.log(`sent ${l.id} (thread ${l.thread})`);
    });

  mail
    .command("check")
    .description("List the owner's unread letters")
    .action(() => {
      const letters = readInbox(new Spool(), OWNER_ADDRESS);
      if (letters.length === 0) console.log("(пусто)");
      for (const l of letters) console.log(`${l.id}  [${l.priority}] ${l.from}: ${l.subject}  (thread ${l.thread})`);
    });

  mail
    .command("read <id>")
    .description("Print a letter from the owner's Inbox and archive it")
    .option("--keep", "do not archive")
    .action((id: string, o) => {
      const spool = new Spool();
      const l = readInbox(spool, OWNER_ADDRESS).find((x) => x.id === id);
      if (!l) throw new Error(`no letter ${id} in ${OWNER_ADDRESS}`);
      printLetter(l);
      if (!o.keep) archive(spool, OWNER_ADDRESS, id);
    });

  mail
    .command("thread <id>")
    .description("Print a whole thread across all mailboxes")
    .action((id: string) => {
      for (const l of thread(new Spool(), id).filter((x) => !x.kind)) printLetter(l);
    });

  const hold = fleet.command("hold").description("Threads stopped by the echo guard");
  hold.command("list").action(() => {
    const h = listHolds(new Spool());
    console.log(h.length ? h.join("\n") : "(нет остановленных тредов)");
  });
  hold.command("release <thread>").action((t: string) => {
    console.log(releaseHold(new Spool(), t) ? `released ${t}` : `${t} was not on hold`);
  });

  fleet
    .command("status")
    .description("Snapshot of the team: who works on what, queues, pending decisions, the week's threads")
    .action(() => {
      const spool = new Spool();
      const stateDir = join(fleetHome(), "state");
      const alive = fleetAlive(stateDir);
      console.log(`Команда: ${alive ? "запущена" : "НЕ запущена (node dist/cli.js fleet run)"}`);
      console.log(new FleetLimits(stateDir).summary());
      console.log(fleetSnapshot(spool, stateDir, loadRoles()).replace(/^## .*\n/, ""));
      const owner = readInbox(spool, OWNER_ADDRESS).filter((l) => !l.kind);
      console.log(`\nПисем владельцу без ответа: ${owner.length}`);
      for (const l of owner) console.log(`- ${l.id}  ${roleName(l.from)} · ${threadTitle(spool, l.thread)} · «${l.subject}»`);
    });

  fleet
    .command("metrics")
    .description("Fleet metrics: time to MR, returns, owner attention, cost by role and model")
    .option("--days <n>", "window in days", "7")
    .action((o) => {
      const since = Date.now() - Number(o.days) * 86_400_000;
      console.log(formatMetrics(computeMetrics(new Spool(), join(fleetHome(), "state"), loadRoles(), since)));
    });

  fleet
    .command("roles")
    .description("List roles")
    .action(() => {
      for (const r of loadRoles()) console.log(`${r.mail.padEnd(22)} ${r.engine}/${r.model.padEnd(18)} ${r.access.padEnd(4)} ${r.description}`);
      console.log(`${OWNER_ADDRESS.padEnd(22)} владелец (Telegram)\n${FLEET_ADDRESS.padEnd(22)} супервизор (уведомления, гейты)`);
    });
}

import { join } from "node:path";
import type { Command } from "commander";
import { config } from "../config.js";
import { listHolds, releaseHold } from "./loopGuard.js";
import { Spool, archive, readInbox, send, thread, type Priority } from "./mail.js";
import { OWNER_ADDRESS, loadRoles } from "./roles.js";
import { runRoleSession } from "./session.js";
import { FLEET_ADDRESS, Supervisor } from "./supervisor.js";
import { commitWorkspace, ensureWorkspace, fleetHome, runWorkspaceGates, type RepoTarget } from "./workspace.js";

// `fleet …` commands: the supervisor (`run`, `once`), the owner's mailbox from the
// terminal, echo holds and the role list.

async function buildSupervisor(log: (l: string) => void): Promise<Supervisor> {
  const repo = (kind: RepoTarget["kind"]): RepoTarget | undefined => {
    const r = config.repos[kind];
    return r.path ? { kind, path: r.path, baseBranch: config.gitlab.targetBranch, gates: r.gates } : undefined;
  };
  return new Supervisor({
    spool: new Spool(),
    roles: loadRoles(),
    repos: { backend: repo("backend"), frontend: repo("frontend") },
    stateDir: join(fleetHome(), "state"),
    runSession: runRoleSession,
    workspace: { ensure: ensureWorkspace, commit: commitWorkspace, gates: runWorkspaceGates },
    log,
  });
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
      const sup = await buildSupervisor((l) => console.log(l));
      sup.start();
      console.log(`[fleet] supervisor started, spool ${new Spool().root}`);
      const shutdown = async () => {
        console.log("[fleet] stopping — waiting for running sessions");
        await sup.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });

  fleet
    .command("once")
    .description("Process every pending letter, then exit")
    .action(async () => {
      const sup = await buildSupervisor((l) => console.log(l));
      await sup.settle();
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
      for (const r of loadRoles()) spool.register(r.mail);
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
    .command("roles")
    .description("List roles")
    .action(() => {
      for (const r of loadRoles()) console.log(`${r.mail.padEnd(22)} ${r.engine}/${r.model.padEnd(18)} ${r.access.padEnd(4)} ${r.description}`);
      console.log(`${OWNER_ADDRESS.padEnd(22)} владелец (Telegram)\n${FLEET_ADDRESS.padEnd(22)} супервизор (уведомления, гейты)`);
    });
}

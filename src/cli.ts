#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { runCloseLoop } from "./engine/loop.js";
import { runQueueOnce } from "./queue.js";
import { registerFleetCommands } from "./fleet/cli.js";
import type { TaskSpec } from "./types.js";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function loadTask(taskArg: string): TaskSpec {
  const trimmed = taskArg.trim();
  const isInlineJson = trimmed.startsWith("{");
  const isFile = !isInlineJson && trimmed.endsWith(".json");
  const raw = isFile ? readFileSync(resolve(trimmed), "utf8") : trimmed;
  const parsed =
    isFile || isInlineJson
      ? JSON.parse(raw)
      : { id: "adhoc", title: "Ad-hoc task", description: raw, acceptanceCriteria: [] };
  if (!parsed.id || !parsed.title || !parsed.description) {
    throw new Error("Task JSON must have id, title, description, and optionally acceptanceCriteria[]");
  }
  return {
    id: String(parsed.id),
    title: String(parsed.title),
    description: String(parsed.description),
    acceptanceCriteria: Array.isArray(parsed.acceptanceCriteria) ? parsed.acceptanceCriteria : [],
  };
}

const program = new Command();

program
  .name("xentra-fleet")
  .description("Single-task close loop: run Claude Code against a task until verification passes");

program
  .command("run")
  .requiredOption("--repo <path>", "Path to the target git repository")
  .requiredOption("--task <taskOrFile>", "Inline task text, or a path to a .json task file")
  .requiredOption("--verify <command>", "Shell command to run for verification (e.g. \"pnpm test\")")
  .option("--branch <name>", "Branch name to work on (default derived from task id)")
  .option("--max-iterations <n>", "Max close-loop iterations", "5")
  .option("--max-budget-usd <n>", "Max total spend in USD", "5")
  .option("--permission-mode <mode>", "Claude permission mode", "acceptEdits")
  .action(async (opts) => {
    const task = loadTask(opts.task);
    const branchName = opts.branch ?? `harness/${slugify(task.id)}-${slugify(task.title)}`;

    console.log(`[xentra-fleet] task=${task.id} branch=${branchName} repo=${opts.repo}`);

    const result = await runCloseLoop(task, {
      repoPath: resolve(opts.repo),
      branchName,
      gates: [{ name: "test", command: opts.verify }],
      maxIterations: Number(opts.maxIterations),
      maxBudgetUsd: Number(opts.maxBudgetUsd),
      permissionMode: opts.permissionMode,
    });

    for (const [i, iter] of result.iterations.entries()) {
      console.log(`\n--- iteration ${i + 1} ---`);
      console.log(`claude: ${iter.turn.resultText.slice(0, 500)}`);
      console.log(`verify: ${iter.verify.passed ? "PASS" : "FAIL"}`);
      if (!iter.verify.passed) console.log(iter.verify.output.slice(0, 1000));
    }

    console.log(`\n[xentra-fleet] stopReason=${result.stopReason} success=${result.success} totalCostUsd=${result.totalCostUsd.toFixed(4)}`);
    console.log(`[xentra-fleet] worktree=${result.worktreeDir} branch=${branchName}`);
    process.exit(result.success ? 0 : 1);
  });

program
  .command("queue")
  .description(
    "Propose (not run) the next assigned ticket from Jira — requires a running `bot` (or the dashboard) " +
      "to actually approve it; no longer a safe thing to put on cron by itself. Prefer leaving `bot` running " +
      "continuously, which polls on its own — see docs/PIPELINE.md.",
  )
  .action(async () => {
    try {
      const outcome = await runQueueOnce();
      console.log(`[queue] ${JSON.stringify(outcome)}`);
      process.exit(0);
    } catch (err) {
      console.error(`[queue] failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("bot")
  .description("Start the Telegram bot that drives the queue")
  .action(async () => {
    const { startBot } = await import("./bot/bot.js");
    const { pruneSessionLogs } = await import("./engine/sessionLog.js");
    const { HARNESS_STATE_DIR } = await import("./bot/liveState.js");
    const { config } = await import("./config.js");
    const pruned = pruneSessionLogs(HARNESS_STATE_DIR, config.sessionLogRetentionDays);
    if (pruned > 0) console.log(`[bot] pruned ${pruned} session journal(s) older than ${config.sessionLogRetentionDays} days`);
    await startBot();
  });

program
  .command("eval")
  .description("Run the mini eval set (real historical bugs) against the current model/prompt config")
  .option("--case <id...>", "Run only these case ids (default: all cases in evals/cases/)")
  .option("--model <name>", "Override IMPLEMENT_MODEL for this run only, to compare models")
  .option("--k <n>", "Run each case this many times (pass@1/pass^k instead of a single pass/fail)", "1")
  .action(async (opts) => {
    const { config } = await import("./config.js");
    const { runEvalSuite } = await import("./evals/runSuite.js");
    const { formatSuiteReport } = await import("./evals/report.js");

    const model = opts.model ?? config.models.implement;
    const k = Number(opts.k);
    console.log(`[eval] running ${opts.case ? opts.case.join(", ") : "all cases"} with model=${model}, k=${k}...`);

    const { result, savedTo } = await runEvalSuite(opts.case, {
      repos: config.repos,
      model,
      k,
      maxIterations: config.maxIterations,
      maxBudgetUsd: config.maxBudgetUsd,
      onCaseStart: (id) => console.log(`[eval] ${id}: starting...`),
      onAttemptDone: (id, i, total, r) =>
        console.log(`[eval] ${id} (${i}/${total}): ${r.passed ? "PASS" : "FAIL"} (${r.stopReason}, $${r.costUsd.toFixed(4)})`),
      onCaseDone: (agg) => console.log(`[eval] ${agg.caseId}: ${agg.passAtK ? "PASS" : "FAIL"} (pass@1=${agg.passAtOneRate.toFixed(2)})`),
    });

    console.log("\n" + formatSuiteReport(result));
    console.log(`\n[eval] saved to ${savedTo}`);
    process.exit(result.passAtKCount === result.totalCount ? 0 : 1);
  });

program
  .command("dashboard")
  .description("Start only the dashboard web server (for testing without Telegram)")
  .action(async () => {
    const { config } = await import("./config.js");
    const { startDashboardServer, dashboardUrl } = await import("./web/server.js");
    startDashboardServer(config.dashboard.port);
    console.log(`[dashboard] ${dashboardUrl(config.dashboard.port)}`);
  });

program
  .command("eval-harvest")
  .description("Build eval cases from closed Jira tickets with a merged MR that changed tests and code")
  .option("--limit <n>", "stop after this many new cases", "20")
  .option("--scan <n>", "how many closed tickets to look at", "120")
  .option("--jql <jql>", "which tickets", "project = XEN AND statusCategory = Done ORDER BY resolved DESC")
  .option("--dry-run", "report only, write nothing")
  .action(async (opts) => {
    const { config } = await import("./config.js");
    const { JiraClient } = await import("./jira/client.js");
    const { listMergedMrs, getMergedMrDetails, mentionsKey } = await import("./gitlab.js");
    const { harvestOne, gitHasCommit, writeCase } = await import("./evals/harvest.js");
    const { CASES_DIR } = await import("./evals/loadCases.js");
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");

    for (const kind of ["backend", "frontend"] as const) {
      const r = config.repos[kind];
      if (r.path) await promisify(execFile)("git", ["fetch", "origin", config.gitlab.targetBranch], { cwd: r.path }).catch(() => {});
    }
    const jira = new JiraClient(config.jira.baseUrl, config.jira.token);
    const issues = await jira.searchIssues(opts.jql, Number(opts.scan));
    const gl = { gitlabBaseUrl: config.gitlab.baseUrl, token: config.gitlab.token };
    const index = {
      backend: await listMergedMrs({ ...gl, projectPath: config.repos.backend.gitlabProjectPath }),
      frontend: await listMergedMrs({ ...gl, projectPath: config.repos.frontend.gitlabProjectPath }),
    };
    console.log(`[harvest] merged MRs indexed: backend ${index.backend.length}, frontend ${index.frontend.length}`);
    const deps = {
      mergedMrs: async (repo: "backend" | "frontend", key: string) => {
        const hits = index[repo].filter((m) => mentionsKey(`${m.title}\n${m.sourceBranch}\n${m.description}`, key));
        // Details only when the match is unambiguous; harvestOne rejects several MRs anyway.
        if (hits.length !== 1) return hits.map((m) => ({ iid: m.iid, title: m.title, sourceBranch: m.sourceBranch, changedPaths: [], webUrl: "" }));
        const d = await getMergedMrDetails({ ...gl, projectPath: config.repos[repo].gitlabProjectPath, iid: hits[0].iid });
        const text = `${hits[0].title}\n${hits[0].sourceBranch}\n${hits[0].description}`;
        const keysMentioned = [...new Set((text.match(/\b[A-Z][A-Z0-9]+-\d+\b/gi) ?? []).map((k) => k.toUpperCase()))];
        return [{ ...d, keysMentioned }];
      },
      hasCommit: (repo: "backend" | "frontend", sha: string) => (config.repos[repo].path ? gitHasCommit(config.repos[repo].path, sha) : Promise.resolve(false)),
    };
    let made = 0;
    for (const i of issues) {
      if (made >= Number(opts.limit)) break;
      if (existsSync(join(CASES_DIR, `${i.key.toLowerCase()}.json`))) {
        console.log(`= ${i.key}: уже есть`);
        continue;
      }
      const out = await harvestOne({ key: i.key, title: i.summary, description: i.description }, deps);
      await new Promise((r) => setTimeout(r, Number(process.env.HARVEST_PAUSE_MS ?? 300))); // be gentle with GitLab
      if ("case" in out) {
        if (!opts.dryRun) writeCase(CASES_DIR, out.case);
        made++;
        console.log(`+ ${i.key}: ${out.case.repo}, тестов ${out.case.hiddenTestPaths.length}${opts.dryRun ? " (dry-run)" : ""}`);
      } else {
        console.log(`- ${i.key}: ${out.skipped}`);
      }
    }
    console.log(`\n${opts.dryRun ? "Подошло" : "Новых кейсов"}: ${made} из ${issues.length} просмотренных.`);
  });

program
  .command("watch")
  .description("Show agent sessions in a readable form: what they read, edit and say (live with -f)")
  .option("-f, --follow", "keep printing new activity")
  .option("--task <key>", "only this task (XEN-55) or fleet thread")
  .option("--role <role>", "only this role (dev, pm, reviewer, dev-1, auditor, …)")
  .option("--tail <n>", "how many recent sessions to print first", "3")
  .option("--list", "list recent sessions with their id and folder, to open one in Claude Code")
  .action(async (o) => {
    const { join } = await import("node:path");
    const { HARNESS_STATE_DIR } = await import("./bot/liveState.js");
    const { fleetHome } = await import("./fleet/workspace.js");
    const { listJournals, matches, sessionInfo, watchJournals } = await import("./engine/sessionView.js");
    const dirs = [HARNESS_STATE_DIR, join(fleetHome(), "state")];
    if (o.list) {
      const rows = listJournals(dirs).filter((j) => matches(j, o)).slice(-Number(o.tail === "3" ? 15 : o.tail));
      if (rows.length === 0) console.log("(сессий пока нет)");
      for (const j of rows) {
        const s = sessionInfo(j.path);
        console.log(`${new Date(j.mtimeMs).toLocaleString("ru-RU")}  ${j.task}  ${j.label}  ${s.model ?? ""}`);
        if (s.sessionId && s.cwd) console.log(`   cd ${s.cwd} && claude --resume ${s.sessionId} --fork-session`);
      }
      return;
    }
    watchJournals(dirs, { task: o.task, role: o.role, tail: Number(o.tail), follow: !!o.follow });
  });

program
  .command("open [n]")
  .description("Open a recent agent session in Claude Code (as a fork — the agent's own session is untouched)")
  .action(async (n?: string) => {
    const { join } = await import("node:path");
    const { spawn } = await import("node:child_process");
    const { createInterface } = await import("node:readline/promises");
    const { HARNESS_STATE_DIR } = await import("./bot/liveState.js");
    const { fleetHome } = await import("./fleet/workspace.js");
    const { listJournals, sessionInfo } = await import("./engine/sessionView.js");
    const rows = listJournals([HARNESS_STATE_DIR, join(fleetHome(), "state")])
      .map((j) => ({ j, s: sessionInfo(j.path) }))
      .filter((r) => r.s.sessionId && r.s.cwd)
      .slice(-15)
      .reverse();
    if (rows.length === 0) return void console.log("(сессий пока нет)");
    let pick = n;
    if (!pick) {
      rows.forEach((r, i) => console.log(`${String(i + 1).padStart(2)}. ${new Date(r.j.mtimeMs).toLocaleString("ru-RU")}  ${r.j.task}  ${r.j.label}`));
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      pick = (await rl.question("Номер сессии: ")).trim();
      rl.close();
    }
    const row = rows[Number(pick) - 1];
    if (!row) return void console.log("Нет такого номера.");
    console.log(`Открываю копию сессии ${row.s.sessionId} в ${row.s.cwd}…`);
    const child = spawn("claude", ["--resume", row.s.sessionId!, "--fork-session"], { cwd: row.s.cwd, stdio: "inherit" });
    await new Promise((r) => child.on("close", r));
  });

program
  .command("cto")
  .description("Open your standing CTO console: one Claude Code session that knows the fleet")
  .option("--new", "start a fresh conversation instead of continuing the last one")
  .action(async (o) => {
    const { spawn } = await import("node:child_process");
    const { prepareCtoWorkspace } = await import("./cto.js");
    const { dir, resume } = prepareCtoWorkspace();
    const cont = resume && !o.new;
    console.log(`Консоль CTO: ${dir} — ${cont ? "продолжаю прошлый разговор" : "новый разговор"}. Выход — /exit.`);
    const child = spawn("claude", cont ? ["--continue"] : [], { cwd: dir, stdio: "inherit" });
    await new Promise((r) => child.on("close", r));
  });

program
  .command("cto-statusline", { hidden: true })
  .description("Status line for the CTO console (reads Claude Code's status JSON on stdin)")
  .action(async () => {
    const { ctoStatusLine } = await import("./ctoStatus.js");
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    process.stdout.write(ctoStatusLine(input));
  });

registerFleetCommands(program);

program.parseAsync(process.argv);

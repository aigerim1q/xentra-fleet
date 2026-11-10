import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CI_WATCH_ADDRESS, CI_WATCH_MAX_MS, JIRA_WATCH_ADDRESS, addCiWatch, listCiWatches, pollCi, pollJira, recentKeys, type WatcherDeps } from "./watchers.js";
import { Spool, readInbox, send } from "./mail.js";
import { OWNER_ADDRESS, parseRole } from "./roles.js";
import { Supervisor } from "./supervisor.js";
import { parseReplyActions } from "./replyActions.js";
import { fileRequest, savePush, loadPush } from "./pushRequests.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "watch-"));
  const spool = new Spool(join(dir, "mail"));
  for (const a of [OWNER_ADDRESS, "xentra/pm", "xentra/dev-1", CI_WATCH_ADDRESS, JIRA_WATCH_ADDRESS]) spool.register(a);
  return { dir, spool, stateDir: join(dir, "state"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const deps = (over: Partial<WatcherDeps> = {}): WatcherDeps => ({
  pipeline: async () => ({ mrState: "opened", status: "running" }),
  failedJobs: async () => [],
  jiraCard: async () => ({ status: "В работе", labels: [] }),
  jiraComments: async () => [],
  ...over,
});

test("ci-watch stays quiet while running, then mails the result once with failed job logs", async () => {
  const s = setup();
  try {
    addCiWatch(s.stateDir, { thread: "t1", requestedBy: "xentra/pm", projectPath: "saqr/back-ai", mrIid: 7 });
    assert.equal(await pollCi(s.spool, s.stateDir, deps()), 0);
    const failing = deps({
      pipeline: async () => ({ mrState: "opened", status: "failed", pipelineId: 99, sha: "abcdef123456", webUrl: "https://g/p/99" }),
      failedJobs: async () => [{ name: "test", stage: "test", webUrl: "https://g/j/1", logTail: "FAIL src/a.spec.ts\nglpat-SECRETVALUE123" }],
      knownSecrets: { GITLAB_TOKEN: "glpat-SECRETVALUE123" },
    });
    assert.equal(await pollCi(s.spool, s.stateDir, failing), 1);
    const [l] = readInbox(s.spool, "xentra/pm");
    assert.equal(l.from, CI_WATCH_ADDRESS);
    assert.equal(l.thread, "t1");
    assert.equal(l.priority, "high");
    assert.match(l.body, /FAIL src\/a\.spec\.ts/);
    assert.doesNotMatch(l.body, /SECRETVALUE123/);
    assert.equal(listCiWatches(s.stateDir).length, 0);
    assert.equal(await pollCi(s.spool, s.stateDir, failing), 0);
  } finally {
    s.done();
  }
});

test("ci-watch gives up after the max wait with a letter", async () => {
  const s = setup();
  try {
    addCiWatch(s.stateDir, { thread: "t1", requestedBy: "xentra/pm", projectPath: "p", mrIid: 7 }, new Date(0));
    assert.equal(await pollCi(s.spool, s.stateDir, deps(), CI_WATCH_MAX_MS + 1000), 1);
    assert.match(readInbox(s.spool, "xentra/pm")[0].subject, /не завершился/);
  } finally {
    s.done();
  }
});

test("jira-watch: first look is silent, then status changes and new comments reach pm in the key's thread", async () => {
  const s = setup();
  try {
    const l = send(s.spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: "XEN-5", body: "", key: "XEN-5" });
    assert.deepEqual([...recentKeys(s.spool).keys()], ["XEN-5"]);
    let status = "В работе";
    let comments = [{ author: "QA", created: "2026-11-10T09:00:00.000+0500", body: "старый" }];
    const d = deps({ jiraCard: async () => ({ status, labels: [] }), jiraComments: async () => comments });
    assert.equal(await pollJira(s.spool, s.stateDir, d), 0);
    status = "Review";
    comments = [...comments, { author: "QA", created: "2026-11-10T10:00:00.000+0500", body: "на dev не работает" }];
    assert.equal(await pollJira(s.spool, s.stateDir, d), 1);
    const n = readInbox(s.spool, "xentra/pm").find((x) => x.from === JIRA_WATCH_ADDRESS)!;
    assert.equal(n.thread, l.thread);
    assert.equal(n.key, "XEN-5");
    assert.match(n.body, /В работе → \*\*Review\*\*/);
    assert.match(n.body, /на dev не работает/);
    assert.doesNotMatch(n.body, /старый/);
    assert.equal(await pollJira(s.spool, s.stateDir, d), 0);
  } finally {
    s.done();
  }
});

test("<watch-ci/> needs a pushed MR; mails to notifiers are refused", async () => {
  const s = setup();
  try {
    const pm = parseRole({ role: "pm", engine: "claude", model: "m", access: "read", canRequestPush: true }, "");
    let reply = "";
    const sup = new Supervisor({
      spool: s.spool,
      roles: [pm],
      repos: { backend: { kind: "backend", path: "/r", baseBranch: "dev", gates: [], gitlabProjectPath: "saqr/back-ai" }, frontend: undefined },
      stateDir: s.stateDir,
      workspace: { ensure: async () => "/wt", commit: async () => false, gates: async () => ({ passed: true, output: "", gates: [] }), diffStat: async () => "" },
      runSession: async (i) => {
        const t = reply.replace("ID", i.batch.primary.id);
        return { ok: true, actions: parseReplyActions(t), resultText: t, costUsd: 0 };
      },
    });
    reply = '<watch-ci/><ack id="ID"/>';
    const first = send(s.spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: "a", body: "" });
    await sup.settle();
    assert.equal(listCiWatches(s.stateDir).length, 0);

    const req = fileRequest(s.stateDir, { thread: first.thread, repo: "backend", dir: "/wt", branch: "b", baseBranch: "dev", gitlabProjectPath: "saqr/back-ai", title: "t", requestedBy: "xentra/pm" });
    savePush(s.stateDir, { ...req, status: "pushed", mr: { iid: 12, webUrl: "u" } });
    reply = '<watch-ci/><mail to="xentra/ci-watch" subject="спасибо">ок</mail><ack id="ID"/>';
    send(s.spool, { from: OWNER_ADDRESS, to: ["xentra/pm"], subject: "b", body: "", thread: first.thread });
    await sup.settle();
    assert.deepEqual(listCiWatches(s.stateDir).map((w) => w.mrIid), [12]);
    assert.equal(readInbox(s.spool, CI_WATCH_ADDRESS).length, 0);
    assert.equal(loadPush(s.stateDir, first.thread)!.mr!.iid, 12);
  } finally {
    s.done();
  }
});

test("cleanJobTrace strips timestamps, colours and the runner's cleanup tail", async () => {
  const { cleanJobTrace } = await import("../gitlab.js");
  const raw = [
    "2026-11-05T15:12:30.000001Z 00O \x1b[31mFAIL src/a.spec.ts\x1b[0m",
    "2026-11-05T15:12:30.000002Z 00O   expected 1, got 2",
    "2026-11-05T15:12:33.000003Z 00O+Cleaning up project directory and file based variables",
    "2026-11-05T15:12:33.000004Z 00O ERROR: Job failed: exit code 1",
  ].join("\n");
  assert.equal(cleanJobTrace(raw), "FAIL src/a.spec.ts\n  expected 1, got 2");
});

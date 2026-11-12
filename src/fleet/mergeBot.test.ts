import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReadiness, loadVerdicts, mergeModeFromEnv, pollMerges, recordVerdict, setVeto } from "./mergeBot.js";
import { fileRequest, savePush, type PushRequest } from "./pushRequests.js";
import { Spool, readInbox } from "./mail.js";
import { OWNER_ADDRESS, loadRoles, parseRole } from "./roles.js";
import { Supervisor } from "./supervisor.js";
import { parseReplyActions } from "./replyActions.js";

const CLEAR = "БЛОКИРУЮЩИЕ:\n- НЕТ\n\nЗАМЕЧАНИЯ:\n- a.ts:1 — мелочь\n\nВЕРДИКТ: OK";
const BLOCK = "БЛОКИРУЮЩИЕ:\n- a.ts:2 — SQL-инъекция\n\nЗАМЕЧАНИЯ:\nНЕТ\n\nВЕРДИКТ: BLOCK";
const AUDITORS = ["auditor", "auditor-codex"];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "merge-"));
  const stateDir = join(dir, "state");
  const spool = new Spool(join(dir, "mail"));
  for (const a of [OWNER_ADDRESS, "xentra/pm", "xentra/fleet"]) spool.register(a);
  const req = fileRequest(stateDir, { thread: "t1", repo: "backend", dir: "/wt", branch: "fleet/t1", baseBranch: "dev", gitlabProjectPath: "p", title: "XEN-1", requestedBy: "xentra/pm" });
  const pushed: PushRequest = { ...req, status: "pushed", mr: { iid: 9, webUrl: "https://g/mr/9" } };
  savePush(stateDir, pushed);
  return { dir, stateDir, spool, pushed, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const green = { mrState: "opened", status: "success", sha: "abc123" };

test("mode defaults to off; only notify/auto switch it on", () => {
  assert.equal(mergeModeFromEnv({}), "off");
  assert.equal(mergeModeFromEnv({ FLEET_MERGE_BOT: "yes" }), "off");
  assert.equal(mergeModeFromEnv({ FLEET_MERGE_BOT: "notify" }), "notify");
});

test("recordVerdict keeps the latest verdict per auditor, pinned to a sha; no ВЕРДИКТ line = no verdict", () => {
  const s = setup();
  try {
    assert.equal(recordVerdict(s.stateDir, "t1", "auditor", "abc123", "Посмотрел, всё ок"), undefined);
    assert.equal(recordVerdict(s.stateDir, "t1", "auditor", "abc123", "БЛОКИРУЮЩИЕ:\nНЕТ\n\nЗАМЕЧАНИЯ:\nНЕТ"), undefined, "headings alone are not a verdict");
    assert.equal(recordVerdict(s.stateDir, "t1", "auditor", "abc123", "БЛОКИРУЮЩИЕ:\n1. a.ts:4 — гонка\n\nВЕРДИКТ: BLOCK")!.blocking, true, "numbered list blocks");
    assert.equal(recordVerdict(s.stateDir, "t1", "auditor", "abc123", "БЛОКИРУЮЩИЕ:\nпроблема абзацем\n\nВЕРДИКТ: BLOCK")!.blocking, true, "BLOCK line blocks on its own");
    assert.equal(recordVerdict(s.stateDir, "t1", "auditor", "old", BLOCK)!.blocking, true);
    assert.equal(recordVerdict(s.stateDir, "t1", "auditor", "abc123", CLEAR)!.blocking, false);
    assert.deepEqual(Object.keys(loadVerdicts(s.stateDir, "t1")), ["auditor"]);
    assert.equal(loadVerdicts(s.stateDir, "t1").auditor.sha, "abc123");
  } finally {
    s.done();
  }
});

test("readiness needs open MR, green CI, every auditor clear on the head sha, no veto", () => {
  const s = setup();
  try {
    const r0 = checkReadiness(s.stateDir, s.pushed, green, AUDITORS);
    assert.deepEqual(r0.reasons, ["нет вердикта auditor", "нет вердикта auditor-codex"]);
    recordVerdict(s.stateDir, "t1", "auditor", "abc123", CLEAR);
    recordVerdict(s.stateDir, "t1", "auditor-codex", "older", CLEAR);
    assert.deepEqual(checkReadiness(s.stateDir, s.pushed, green, AUDITORS).reasons, ["auditor-codex смотрел другой коммит"]);
    recordVerdict(s.stateDir, "t1", "auditor-codex", "abc123", CLEAR);
    assert.equal(checkReadiness(s.stateDir, s.pushed, green, AUDITORS).ready, true);
    assert.match(checkReadiness(s.stateDir, s.pushed, { ...green, status: "failed" }, AUDITORS).reasons.join(), /CI failed/);
    setVeto(s.stateDir, "t1", true);
    assert.match(checkReadiness(s.stateDir, s.pushed, green, AUDITORS).reasons.join(), /вето/);
    setVeto(s.stateDir, "t1", false);
    assert.equal(checkReadiness(s.stateDir, s.pushed, green, AUDITORS).ready, true);
  } finally {
    s.done();
  }
});

test("notify mode mails the owner once per ready sha and never merges", async () => {
  const s = setup();
  try {
    for (const a of AUDITORS) recordVerdict(s.stateDir, "t1", a, "abc123", CLEAR);
    const merged: string[] = [];
    const deps = { pipeline: async () => green, merge: async (_p: string, iid: number) => void merged.push(String(iid)) };
    assert.equal(await pollMerges(s.spool, s.stateDir, "off", AUDITORS, deps), 0);
    assert.equal(await pollMerges(s.spool, s.stateDir, "notify", AUDITORS, deps), 1);
    assert.equal(await pollMerges(s.spool, s.stateDir, "notify", AUDITORS, deps), 0);
    assert.deepEqual(merged, []);
    assert.match(readInbox(s.spool, OWNER_ADDRESS)[0].subject, /Готово к мержу: MR !9/);
  } finally {
    s.done();
  }
});

test("auto mode merges pinned to the checked sha and tells owner and pm", async () => {
  const s = setup();
  try {
    for (const a of AUDITORS) recordVerdict(s.stateDir, "t1", a, "abc123", CLEAR);
    const merged: string[] = [];
    await pollMerges(s.spool, s.stateDir, "auto", AUDITORS, { pipeline: async () => green, merge: async (_p, iid, sha) => void merged.push(`${iid}@${sha}`) });
    assert.deepEqual(merged, ["9@abc123"]);
    assert.ok(readInbox(s.spool, "xentra/pm").some((l) => /Смержено/.test(l.subject)));
  } finally {
    s.done();
  }
});

test("the shipped auditors are flagged, and an auditor session records its verdict on the head sha", async () => {
  assert.deepEqual(loadRoles().filter((r) => r.isAuditor).map((r) => r.role).sort(), AUDITORS);
  const s = setup();
  try {
    const auditor = parseRole({ role: "auditor", engine: "claude", model: "m", access: "read", auditor: true }, "");
    const sup = new Supervisor({
      spool: s.spool,
      roles: [auditor],
      repos: { backend: { kind: "backend", path: "/r", baseBranch: "dev", gates: [] }, frontend: undefined },
      stateDir: s.stateDir,
      workspace: { ensure: async () => "/wt", commit: async () => false, gates: async () => ({ passed: true, output: "", gates: [] }), diffStat: async () => "", headSha: async () => "abc123", changes: async () => ({ head: "abc123", stat: "", text: "" }) },
      runSession: async (i) => {
        const t = `<mail to="xentra/pm" subject="Ревью">${CLEAR}</mail><ack id="${i.batch.primary.id}"/>`;
        return { ok: true, actions: parseReplyActions(t), resultText: t, costUsd: 0 };
      },
    });
    const { send } = await import("./mail.js");
    send(s.spool, { from: "xentra/pm", to: ["xentra/auditor"], subject: "ревью", body: "", thread: "t1" });
    await sup.settle();
    assert.deepEqual(loadVerdicts(s.stateDir, "t1").auditor, { ...loadVerdicts(s.stateDir, "t1").auditor, role: "auditor", sha: "abc123", blocking: false });
  } finally {
    s.done();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectDir, ctoClaudeMd, ctoSettings } from "./cto.js";
import { ctoStatusLine } from "./ctoStatus.js";
import { Spool, send } from "./fleet/mail.js";

test("claudeProjectDir encodes the folder like Claude Code does", () => {
  assert.match(claudeProjectDir("/Users/a/.xentra-fleet/cto"), /\.claude\/projects\/-Users-a--xentra-fleet-cto$/);
});

test("CLAUDE.md tells the session to start from fleet status and not to send mail unasked", () => {
  const md = ctoClaudeMd("node /x/dist/cli.js");
  assert.match(md, /node \/x\/dist\/cli\.js fleet status/);
  assert.match(md, /Отправляй только когда владелец явно попросил/);
});

test("settings allow only read-style fleet commands without asking; sending mail still asks", () => {
  const s = ctoSettings("node /x/dist/cli.js", "node /x/dist/cli.js cto-statusline") as { permissions: { allow: string[] } };
  assert.ok(s.permissions.allow.includes("Bash(node /x/dist/cli.js fleet status)"));
  assert.ok(!s.permissions.allow.some((r) => r.includes("mail send")));
  assert.ok(s.permissions.allow.includes("Bash(node /x/dist/cli.js fleet mail read --keep:*)"));
  assert.ok(!s.permissions.allow.some((r) => /mail read:\*/.test(r)), "reading without --keep archives the letter: must ask");
  assert.match(ctoClaudeMd("node /x/dist/cli.js"), /read --keep <id>/);
});

test("status line shows model, context, cost and the team; never throws on junk", () => {
  const dir = mkdtempSync(join(tmpdir(), "cto-"));
  try {
    const state = join(dir, "state");
    mkdirSync(state, { recursive: true });
    const spool = new Spool(join(dir, "mail"));
    spool.register("xentra/owner");
    spool.register("xentra/pm");
    send(spool, { from: "xentra/pm", to: ["xentra/owner"], subject: "q", body: "" });
    const transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 1000, cache_read_input_tokens: 83000 } } }) + "\n");
    const line = ctoStatusLine(JSON.stringify({ model: { display_name: "Opus 5.5" }, cost: { total_cost_usd: 3.214 }, transcript_path: transcript }), state, spool);
    assert.equal(line, "[Opus 5.5 · ctx 84k · $3.21] команда: не запущена · ✉️ 1");
    writeFileSync(join(state, "heartbeat"), "x");
    writeFileSync(join(state, "running.dev-1"), "{}");
    assert.match(ctoStatusLine("not json", state, spool), /^команда: ▶ 1 · ✉️ 1$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

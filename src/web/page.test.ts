import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DASHBOARD_CSS, DASHBOARD_JS, DASHBOARD_PAGE } from "./page.js";

test("the old dashboard runs under the strict CSP: no inline script/style/handlers, no HTML injection, script parses", () => {
  assert.doesNotMatch(DASHBOARD_PAGE, /<script>|<style>|\son[a-z]+=/i);
  assert.match(DASHBOARD_PAGE, /<script src="\/dashboard\.js">/);
  assert.match(DASHBOARD_PAGE, /<link rel="stylesheet" href="\/dashboard\.css">/);
  assert.doesNotMatch(DASHBOARD_JS, /innerHTML|insertAdjacentHTML|outerHTML|document\.write|onclick=/);
  assert.ok(DASHBOARD_CSS.includes(".ticket-row"));
  const dir = mkdtempSync(join(tmpdir(), "dash-"));
  try {
    const f = join(dir, "dashboard.js");
    writeFileSync(f, DASHBOARD_JS);
    execFileSync(process.execPath, ["--check", f]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

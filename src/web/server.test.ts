import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { hasValidToken, isAllowedHost } from "./server.js";

test("only loopback Host headers are served (DNS rebinding, LAN access)", () => {
  assert.ok(isAllowedHost("127.0.0.1:4790", 4790));
  assert.ok(isAllowedHost("localhost:4790", 4790));
  assert.ok(!isAllowedHost("evil.example:4790", 4790));
  assert.ok(!isAllowedHost("192.168.1.10:4790", 4790));
  assert.ok(!isAllowedHost("localhost:9999", 4790));
  assert.ok(!isAllowedHost(undefined, 4790));
});

test("the state-changing call requires the per-process token", () => {
  const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
  const token = "a".repeat(48);
  assert.ok(hasValidToken(req({ "x-dashboard-token": token }), token));
  assert.ok(!hasValidToken(req({}), token));
  assert.ok(!hasValidToken(req({ "x-dashboard-token": "b".repeat(48) }), token));
  assert.ok(!hasValidToken(req({ "x-dashboard-token": "short" }), token));
});

test("the dashboard page and its script carry the console's CSP; the script and stylesheet are served as files", async () => {
  const { dashboardAsset } = await import("./server.js");
  const { CSP } = await import("./console/routes.js");
  const page = dashboardAsset("/", "tok");
  assert.equal(page.headers["Content-Security-Policy"], CSP);
  assert.match(page.body, /content="tok"/);
  assert.equal(dashboardAsset("/dashboard.js", "tok").headers["Content-Security-Policy"], CSP);
  assert.match(dashboardAsset("/dashboard.css", "tok").headers["Content-Type"], /text\/css/);
});

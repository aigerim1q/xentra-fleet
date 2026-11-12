import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentEnv, buildRepoCodeEnv, runCost } from "./claudeEngine.js";

test("buildAgentEnv strips every harness secret, leaving everything else untouched", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    JIRA_PAT: "jira-secret",
    GITLAB_TOKEN: "gitlab-secret",
    TELEGRAM_BOT_TOKEN: "telegram-secret",
  };
  const env = buildAgentEnv(source);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/x");
  assert.equal(env.JIRA_PAT, undefined);
  assert.equal(env.GITLAB_TOKEN, undefined);
  assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
});

test("buildAgentEnv does not mutate the source object", () => {
  const source = { JIRA_PAT: "jira-secret" };
  buildAgentEnv(source);
  assert.equal(source.JIRA_PAT, "jira-secret");
});

test("buildAgentEnv works on an env with none of the secret keys present", () => {
  const env = buildAgentEnv({ PATH: "/usr/bin" });
  assert.deepEqual(env, { PATH: "/usr/bin" });
});

test("buildAgentEnv drops every credential-looking name, keeps the engines' own and the owner's explicit exceptions", () => {
  const env = buildAgentEnv({
    PATH: "/usr/bin",
    HOME: "/home/x",
    LANG: "ru_RU.UTF-8",
    NODE_OPTIONS: "--max-old-space-size=4096",
    AWS_SECRET_ACCESS_KEY: "aws",
    AWS_ACCESS_KEY_ID: "aws-id",
    DB_PASSWORD: "pw",
    NPM_TOKEN: "npm",
    SOME_API_KEY: "k",
    STRIPE_SECRET: "s",
    SSH_PRIVATE_KEY_PATH: "p",
    JIRA_BASE_URL: "https://jira",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-login",
    ANTHROPIC_API_KEY: "anthropic",
    OPENAI_API_KEY: "openai",
    MY_SERVICE_TOKEN: "keep-me",
    AGENT_ENV_KEEP: "MY_SERVICE_TOKEN",
  });
  for (const k of ["PATH", "HOME", "LANG", "NODE_OPTIONS", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MY_SERVICE_TOKEN"]) {
    assert.ok(k in env, `${k} must be kept`);
  }
  for (const k of ["AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "DB_PASSWORD", "NPM_TOKEN", "SOME_API_KEY", "STRIPE_SECRET", "SSH_PRIVATE_KEY_PATH", "JIRA_BASE_URL"]) {
    assert.ok(!(k in env), `${k} must be dropped`);
  }
});

test("buildRepoCodeEnv also drops engine credentials that agents keep, but not non-secret engine vars", () => {
  const source = { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CONFIG_DIR: "/c", PATH: "/bin", JIRA_PAT: "j" };
  assert.equal(buildAgentEnv(source).ANTHROPIC_API_KEY, "a");
  const env = buildRepoCodeEnv(source);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.JIRA_PAT, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, "/c");
  assert.equal(env.PATH, "/bin");
  assert.equal(buildRepoCodeEnv({ ...source, AGENT_ENV_KEEP: "OPENAI_API_KEY" }).OPENAI_API_KEY, "o");
});

test("runCost: a resumed turn costs its total minus what the session had cost before", () => {
  assert.equal(runCost(0.32, undefined, "s1", undefined), 0.32);
  assert.ok(Math.abs(runCost(0.46, "s1", "s1", 0.32) - 0.14) < 1e-9);
  // Unknown prior, a different (forked/fresh) session or a total that went down: the whole total.
  assert.equal(runCost(0.46, "s1", "s1", undefined), 0.46);
  assert.equal(runCost(0.2, "s1", "s2", 0.32), 0.2);
  assert.equal(runCost(0.1, "s1", "s1", 0.32), 0.1);
});

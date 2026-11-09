// Mechanical (not just prompt-based) limits on what the agent can touch,
// matching DEVBOT's own instinct: migrations/CI/secrets stay out of a model's
// hands regardless of what the task asks for. Enforced via Claude Code's own
// --disallowedTools path patterns, verified live: a denied path is refused at
// the tool-call level, the agent reports it couldn't touch it, and moves on.
export const DEFAULT_DENIED_PATHS = [
  "**/migrations/**",
  "**/.env*",
  "**/.gitlab-ci.yml",
  "**/.github/workflows/**",
  "**/yarn.lock",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/*.pem",
  "**/*.key",
  // Files that decide what a gate actually runs or checks: an agent that can edit
  // them can turn a gate into a no-op or make it run arbitrary code.
  "**/package.json",
  "**/tsconfig*.json",
  "**/jest.config.*",
  "**/vitest.config.*",
  "**/vitest.setup.*",
  "**/eslint.config.*",
  "**/.eslintrc*",
  "**/node_modules/**",
  "**/.githooks/**",
  "**/.husky/**",
  "**/.claude/**",
];

// Tools no role ever needs: network access is an exfiltration channel, and
// NotebookEdit is a file-writing tool the path rules below would not cover.
export const ALWAYS_DISALLOWED_TOOLS = ["WebFetch", "WebSearch", "NotebookEdit"];

// Every tool that writes files gets the same path rules — denying Edit/Write but not
// MultiEdit leaves the deny-list one tool name away from useless.
const FILE_WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/** Adds ALWAYS_DISALLOWED_TOOLS to any disallowed-tools list (default or override). */
export function withAlwaysDisallowed(list: string): string {
  const items = list.split(",").map((s) => s.trim()).filter(Boolean);
  for (const tool of ALWAYS_DISALLOWED_TOOLS) if (!items.includes(tool)) items.push(tool);
  return items.join(",");
}

export function buildDisallowedTools(extraDeniedPaths: string[] = []): string {
  const paths = [...DEFAULT_DENIED_PATHS, ...extraDeniedPaths];
  const pathRules = paths.flatMap((p) => FILE_WRITE_TOOLS.map((tool) => `${tool}(${p})`));
  return withAlwaysDisallowed(["Bash", ...pathRules].join(","));
}

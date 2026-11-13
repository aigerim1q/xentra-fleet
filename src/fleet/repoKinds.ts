// Repositories the role fleet works in. Kept in its own module: roles, push requests and
// cleanup need the list without pulling in the git/gate machinery of workspace.ts.
export const FLEET_REPO_KINDS = ["backend", "frontend", "mobile"] as const;
export type FleetRepoKind = (typeof FLEET_REPO_KINDS)[number];

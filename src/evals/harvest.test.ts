import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harvestOne, reposFor, writeCase, type HarvestDeps } from "./harvest.js";
import type { MergedMr } from "../gitlab.js";

const desc = "Пользователь не видит документы коллег в общей папке, хотя доступ к папке выдан.";
const mr = (over: Partial<MergedMr> = {}): MergedMr => ({
  iid: 5, title: "fix XEN-1", sourceBranch: "fix/XEN-1", baseSha: "base1", referenceSha: "merge1",
  changedPaths: ["src/a.service.ts", "src/a.service.spec.ts"], webUrl: "u", ...over,
});
const deps = (mrs: Partial<Record<"backend" | "frontend", MergedMr[]>>, has = true): HarvestDeps => ({
  mergedMrs: async (repo) => mrs[repo] ?? [],
  hasCommit: async () => has,
});

test("reposFor reads the title tag, untagged tries both", () => {
  assert.deepEqual(reposFor("[backend] X"), ["backend"]);
  assert.deepEqual(reposFor("[Web] X"), ["frontend"]);
  assert.deepEqual(reposFor("X"), ["backend", "frontend"]);
});

test("a merged MR with code and tests becomes a case with its tests hidden", async () => {
  const out = await harvestOne({ key: "XEN-1", title: "[backend] Папка", description: desc }, deps({ backend: [mr()] }));
  assert.ok("case" in out);
  assert.deepEqual(out.case, {
    id: "XEN-1", title: "[backend] Папка", description: desc, repo: "backend",
    baseCommit: "base1", referenceCommit: "merge1", hiddenTestPaths: ["src/a.service.spec.ts"],
  });
});

test("untagged ticket falls through to the frontend when the backend has no MR", async () => {
  const out = await harvestOne({ key: "XEN-1", title: "Папка", description: desc }, deps({ frontend: [mr({ changedPaths: ["src/A.tsx", "src/A.test.tsx"] })] }));
  assert.ok("case" in out && out.case.repo === "frontend");
});

test("skips: no tests, tests only, several MRs, missing commits, short description", async () => {
  const skip = async (d: HarvestDeps, description = desc) => {
    const out = await harvestOne({ key: "XEN-1", title: "[backend] X", description }, d);
    assert.ok("skipped" in out);
    return out.skipped;
  };
  assert.match(await skip(deps({ backend: [mr({ changedPaths: ["src/a.ts"] })] })), /без тестов/);
  assert.match(await skip(deps({ backend: [mr({ changedPaths: ["src/a.spec.ts", "README.md"] })] })), /только тесты/);
  assert.match(await skip(deps({ backend: [mr(), mr({ iid: 6 })] })), /2 смерженных MR/);
  assert.match(await skip(deps({ backend: [mr()] }, false)), /нет в локальном клоне/);
  assert.match(await skip(deps({ backend: [] })), /нет смерженного MR/);
  assert.match(await skip(deps({ backend: [mr()] }), "коротко"), /слишком короткое/);
});

test("writeCase never overwrites an existing case unless asked", () => {
  const dir = mkdtempSync(join(tmpdir(), "cases-"));
  try {
    const c = { id: "XEN-1", title: "t", description: "d", repo: "backend" as const, baseCommit: "b", referenceCommit: "r", hiddenTestPaths: ["a.spec.ts"] };
    assert.equal(writeCase(dir, c), true);
    assert.equal(writeCase(dir, { ...c, title: "changed" }), false);
    assert.equal(JSON.parse(readFileSync(join(dir, "xen-1.json"), "utf8")).title, "t");
    assert.equal(writeCase(dir, { ...c, title: "changed" }, true), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mentionsKey matches the key as a whole word only", async () => {
  const { mentionsKey } = await import("../gitlab.js");
  assert.equal(mentionsKey("fix/XEN-530-deal-link", "XEN-530"), true);
  assert.equal(mentionsKey("feat(sales): ... (XEN-530)", "XEN-530"), true);
  assert.equal(mentionsKey("XEN-5301 something", "XEN-530"), false);
  assert.equal(mentionsKey("PREXEN-530", "XEN-530"), false);
  assert.equal(mentionsKey("xen-530", "XEN-530"), true);
});

test("skips an MR closing several tickets and a feature-sized MR", async () => {
  const one = async (m: MergedMr) => {
    const out = await harvestOne({ key: "XEN-1", title: "[backend] X", description: desc }, deps({ backend: [m] }));
    assert.ok("skipped" in out);
    return out.skipped;
  };
  assert.match(await one(mr({ keysMentioned: ["XEN-1", "XEN-2"] })), /несколько тикетов \(XEN-2\)/);
  const many = Array.from({ length: 9 }, (_, i) => `src/t${i}.spec.ts`);
  assert.match(await one(mr({ changedPaths: ["src/a.ts", ...many] })), /размером с фичу/);
  const ok = await harvestOne({ key: "XEN-1", title: "[backend] X", description: desc }, deps({ backend: [mr({ keysMentioned: ["XEN-1"] })] }));
  assert.ok("case" in ok);
});

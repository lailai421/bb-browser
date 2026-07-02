import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSiteRecommendationResult,
  SiteUpdateError,
  updateCommunitySites,
} from "./index.js";

test("buildSiteRecommendationResult handles empty history", () => {
  const result = buildSiteRecommendationResult([], [], 7);
  assert.deepEqual(result, {
    days: 7,
    available: [],
    not_available: [],
  });
});

test("buildSiteRecommendationResult separates available and missing adapters", () => {
  const result = buildSiteRecommendationResult(
    [
      { domain: "example.com", visits: 12, titles: ["Example"] },
      { domain: "missing.com", visits: 8, titles: ["Missing"] },
      { domain: "localhost", visits: 10, titles: ["Local"] },
    ],
    [
      {
        name: "example/search",
        description: "Search Example",
        domain: "example.com",
        args: {},
        example: "bb-browser site example/search hello",
        filePath: "D:/tmp/example.js",
        source: "community",
      },
    ],
    30,
  );

  assert.equal(result.available.length, 1);
  assert.equal(result.available[0]?.domain, "example.com");
  assert.equal(result.available[0]?.adapterCount, 1);
  assert.equal(result.not_available.length, 1);
  assert.equal(result.not_available[0]?.domain, "missing.com");
});

test("updateCommunitySites returns clone result with shared JSON fields", () => {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const ensured: string[] = [];

  const result = updateCommunitySites({
    bbBrowserHome: "D:/tmp/home",
    communityDir: "D:/tmp/home/bb-sites",
    communityRepo: "https://example.com/bb-sites.git",
    hasGitDir: () => false,
    ensureDir: (dir) => {
      ensured.push(dir);
    },
    runGit: (args, cwd) => {
      calls.push({ args, cwd });
    },
    countSites: () => 42,
  });

  assert.deepEqual(calls, [
    {
      args: [
        "clone",
        "https://example.com/bb-sites.git",
        "D:/tmp/home/bb-sites",
      ],
      cwd: undefined,
    },
  ]);
  assert.ok(ensured.includes("D:/tmp/home"));
  assert.equal(result.success, true);
  assert.equal(result.updateMode, "clone");
  assert.equal(result.communityRepo, "https://example.com/bb-sites.git");
  assert.equal(result.communityDir, "D:/tmp/home/bb-sites");
  assert.equal(result.siteCount, 42);
});

test("updateCommunitySites returns pull result", () => {
  const calls: Array<{ args: string[]; cwd?: string }> = [];

  const result = updateCommunitySites({
    bbBrowserHome: "D:/tmp/home",
    communityDir: "D:/tmp/home/bb-sites",
    hasGitDir: () => true,
    ensureDir: () => {},
    runGit: (args, cwd) => {
      calls.push({ args, cwd });
    },
    countSites: () => 3,
  });

  assert.deepEqual(calls, [
    {
      args: ["pull", "--ff-only"],
      cwd: "D:/tmp/home/bb-sites",
    },
  ]);
  assert.equal(result.updateMode, "pull");
  assert.equal(result.siteCount, 3);
});

test("updateCommunitySites throws SiteUpdateError when git fails", () => {
  assert.throws(
    () =>
      updateCommunitySites({
        bbBrowserHome: "D:/tmp/home",
        communityDir: "D:/tmp/home/bb-sites",
        hasGitDir: () => true,
        ensureDir: () => {},
        runGit: () => {
          throw new Error("git failed");
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof SiteUpdateError);
      assert.equal(error.updateMode, "pull");
      assert.match(error.action, /git pull/);
      assert.match(error.message, /更新失败: git failed/);
      return true;
    },
  );
});

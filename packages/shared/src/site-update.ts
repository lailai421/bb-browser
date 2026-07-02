import { existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { BB_BROWSER_HOME } from "./daemon-client.js";
import { COMMUNITY_REPO, COMMUNITY_SITES_DIR, scanSiteDirectory } from "./site-adapters.js";

export interface SiteUpdateResult {
  success: true;
  updateMode: "clone" | "pull";
  communityRepo: string;
  communityDir: string;
  siteCount: number;
}

export class SiteUpdateError extends Error {
  action: string;
  updateMode: "clone" | "pull";

  constructor(
    message: string,
    options: { action: string; updateMode: "clone" | "pull" },
  ) {
    super(message);
    this.name = "SiteUpdateError";
    this.action = options.action;
    this.updateMode = options.updateMode;
  }
}

export interface SiteUpdateOptions {
  bbBrowserHome?: string;
  communityDir?: string;
  communityRepo?: string;
  runGit?: (args: string[], cwd?: string) => void;
  hasGitDir?: (dir: string) => boolean;
  ensureDir?: (dir: string) => void;
  countSites?: (dir: string) => number;
}

function defaultRunGit(args: string[], cwd?: string): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function updateCommunitySites(
  options: SiteUpdateOptions = {},
): SiteUpdateResult {
  const bbBrowserHome = options.bbBrowserHome ?? BB_BROWSER_HOME;
  const communityRepo = options.communityRepo ?? COMMUNITY_REPO;
  const communityDir = options.communityDir ?? COMMUNITY_SITES_DIR;
  const runGit = options.runGit ?? defaultRunGit;
  const hasGitDir = options.hasGitDir ?? ((dir: string) => existsSync(join(dir, ".git")));
  const ensureDir =
    options.ensureDir ??
    ((dir: string) => {
      mkdirSync(dir, { recursive: true });
    });
  const countSites =
    options.countSites ??
    ((dir: string) => scanSiteDirectory(dir, "community").length);

  ensureDir(bbBrowserHome);
  ensureDir(dirname(communityDir));

  const updateMode = hasGitDir(communityDir) ? "pull" : "clone";
  try {
    if (updateMode === "pull") {
      runGit(["pull", "--ff-only"], communityDir);
    } else {
      runGit(["clone", communityRepo, communityDir]);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const action =
      updateMode === "pull"
        ? `cd ${communityDir} && git pull`
        : `git clone ${communityRepo} ${communityDir}`;
    throw new SiteUpdateError(
      `${updateMode === "pull" ? "更新" : "克隆"}失败: ${detail}`,
      { action, updateMode },
    );
  }

  return {
    success: true,
    updateMode,
    communityRepo,
    communityDir,
    siteCount: countSites(communityDir),
  };
}

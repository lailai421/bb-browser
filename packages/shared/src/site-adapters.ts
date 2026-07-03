import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative } from "node:path";
import { BB_BROWSER_HOME } from "./daemon-client.js";

export interface ArgDef {
  required?: boolean;
  description?: string;
}

export interface SiteMeta {
  name: string;
  description: string;
  domain: string;
  args: Record<string, ArgDef>;
  capabilities?: string[];
  readOnly?: boolean;
  example?: string;
  filePath: string;
  source: "local" | "community";
}

export const LOCAL_SITES_DIR = join(BB_BROWSER_HOME, "sites");
export const COMMUNITY_SITES_DIR = join(BB_BROWSER_HOME, "bb-sites");
export const COMMUNITY_REPO = "https://github.com/epiral/bb-sites.git";

export function parseSiteMeta(
  filePath: string,
  source: "local" | "community",
): SiteMeta | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const sitesDir = source === "local" ? LOCAL_SITES_DIR : COMMUNITY_SITES_DIR;
  const relPath = relative(sitesDir, filePath);
  const defaultName = relPath.replace(/\.js$/, "").replace(/\\/g, "/");

  const metaMatch = content.match(/\/\*\s*@meta\s*\n([\s\S]*?)\*\//);
  if (metaMatch) {
    try {
      const metaJson = JSON.parse(metaMatch[1]);
      return {
        name: metaJson.name || defaultName,
        description: metaJson.description || "",
        domain: metaJson.domain || "",
        args: metaJson.args || {},
        capabilities: metaJson.capabilities,
        readOnly: metaJson.readOnly,
        example: metaJson.example,
        filePath,
        source,
      };
    } catch {
      // Fall through to legacy tag parsing.
    }
  }

  const meta: SiteMeta = {
    name: defaultName,
    description: "",
    domain: "",
    args: {},
    filePath,
    source,
  };

  const tagPattern = /\/\/\s*@(\w+)[ \t]+(.*)/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(content)) !== null) {
    const [, key, value] = match;
    switch (key) {
      case "name":
        meta.name = value.trim();
        break;
      case "description":
        meta.description = value.trim();
        break;
      case "domain":
        meta.domain = value.trim();
        break;
      case "args":
        for (const arg of value.trim().split(/[,\s]+/).filter(Boolean)) {
          meta.args[arg] = { required: true };
        }
        break;
      case "example":
        meta.example = value.trim();
        break;
    }
  }

  return meta;
}

export function scanSiteDirectory(
  dir: string,
  source: "local" | "community",
): SiteMeta[] {
  if (!existsSync(dir)) {
    return [];
  }

  const sites: SiteMeta[] = [];

  function walk(currentDir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        const meta = parseSiteMeta(fullPath, source);
        if (meta) {
          sites.push(meta);
        }
      }
    }
  }

  walk(dir);
  return sites;
}

export function getAllSites(): SiteMeta[] {
  const community = scanSiteDirectory(COMMUNITY_SITES_DIR, "community");
  const local = scanSiteDirectory(LOCAL_SITES_DIR, "local");
  const byName = new Map<string, SiteMeta>();

  for (const site of community) {
    byName.set(site.name, site);
  }
  for (const site of local) {
    byName.set(site.name, site);
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function findSiteByName(name: string): SiteMeta | undefined {
  return getAllSites().find((site) => site.name === name);
}

export function findLocalSiteFile(name: string): string | null {
  return findSiteByName(name)?.filePath ?? null;
}

export function getSiteHintForDomain(url: string): string | null {
  try {
    const hostname = new URL(url).hostname;
    const matched = getAllSites().filter(
      (site) =>
        site.domain &&
        (hostname === site.domain || hostname.endsWith(`.${site.domain}`)),
    );
    if (matched.length === 0) {
      return null;
    }
    const example = matched[0]?.example || `bb-browser site ${matched[0]?.name || ""}`;
    return `该网站有 ${matched.length} 个 site adapter 可直接获取数据，无需手动操作浏览器。试试: ${example}`;
  } catch {
    return null;
  }
}

export function mapCliSiteArgsToNamedArgs(
  siteArgs: Record<string, ArgDef>,
  rawArgs: string[],
): Record<string, string> {
  const argMap: Record<string, string> = {};
  const positionalArgs: string[] = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const current = rawArgs[index] || "";
    if (current.startsWith("--")) {
      const flagName = current.slice(2);
      if (flagName in siteArgs && rawArgs[index + 1]) {
        argMap[flagName] = rawArgs[index + 1] as string;
        index += 1;
      }
      continue;
    }
    positionalArgs.push(current);
  }

  let positionalIndex = 0;
  for (const argName of Object.keys(siteArgs)) {
    if (!argMap[argName] && positionalIndex < positionalArgs.length) {
      argMap[argName] = positionalArgs[positionalIndex] as string;
      positionalIndex += 1;
    }
  }

  return argMap;
}

export function mapMcpSiteArgsToNamedArgs(
  siteArgs: Record<string, ArgDef>,
  positionalArgs: string[] = [],
  namedArgs: Record<string, string> = {},
): Record<string, string> {
  const argMap = { ...namedArgs };
  let positionalIndex = 0;

  for (const argName of Object.keys(siteArgs)) {
    if (!argMap[argName] && positionalIndex < positionalArgs.length) {
      argMap[argName] = positionalArgs[positionalIndex] as string;
      positionalIndex += 1;
    }
  }

  return argMap;
}

export function validateRequiredSiteArgs(
  site: SiteMeta,
  args: Record<string, string>,
): void {
  for (const [argName, argDef] of Object.entries(site.args)) {
    if (argDef.required && !args[argName]) {
      const usage = Object.keys(site.args)
        .map((name) => (site.args[name]?.required ? `<${name}>` : `[${name}]`))
        .join(" ");
      throw new Error(
        `Missing required argument "${argName}". Usage: site_run ${site.name} ${usage}`,
      );
    }
  }
}

export function buildSiteAdapterScript(
  site: SiteMeta,
  args: Record<string, string>,
): string {
  const adapterDir = join(site.filePath, "..");
  const helperPath = join(adapterDir, "_helper.js");
  const helperScript = existsSync(helperPath)
    ? `${readFileSync(helperPath, "utf-8")}\n`
    : "";
  const jsContent = readFileSync(site.filePath, "utf-8");
  const jsBody = jsContent.replace(/\/\*\s*@meta[\s\S]*?\*\//, "").trim();
  const argsJson = JSON.stringify(args);
  return `(async function(){${helperScript}\nreturn (${jsBody})(${argsJson});})()`;
}

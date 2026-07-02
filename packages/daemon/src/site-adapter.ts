/**
 * Site adapter execution — loads and runs site adapters directly in the daemon.
 */

import {
  buildSiteAdapterScript,
  findSiteByName,
  getAllSites,
  type SiteMeta,
  validateRequiredSiteArgs,
} from "@bb-browser/shared";
import type { CdpConnection } from "./cdp-connection.js";

export type { SiteMeta } from "@bb-browser/shared";
export { getAllSites } from "@bb-browser/shared";

export interface SiteRunResult {
  tab?: string;
  result: unknown;
}

function matchTabOrigin(tabUrl: string, domain: string): boolean {
  try {
    const tabOrigin = new URL(tabUrl).hostname;
    return tabOrigin === domain || tabOrigin.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

export async function executeSiteAdapter(
  cdp: CdpConnection,
  name: string,
  args: Record<string, string>,
  tabId?: string | number,
): Promise<SiteRunResult> {
  const site = findSiteByName(name);
  if (!site) {
    const suggestions = getAllSites()
      .filter((candidate) => candidate.name.includes(name))
      .slice(0, 5)
      .map((candidate) => candidate.name);
    throw new Error(
      `Site adapter "${name}" not found` +
        (suggestions.length > 0 ? `. Did you mean: ${suggestions.join(", ")}` : ""),
    );
  }

  validateRequiredSiteArgs(site, args);

  let targetId: string | undefined;
  let shortId: string | undefined;

  if (tabId !== undefined) {
    const target = await cdp.ensurePageTarget(
      typeof tabId === "number" ? String(tabId) : tabId,
    );
    targetId = target.id;
    shortId = cdp.tabManager.getTab(target.id)?.shortId;
  } else if (site.domain) {
    const targets = (await cdp.getTargets()).filter((target) => target.type === "page");
    for (const target of targets) {
      if (matchTabOrigin(target.url, site.domain)) {
        await cdp.attachAndEnable(target.id);
        targetId = target.id;
        shortId = cdp.tabManager.getTab(target.id)?.shortId;
        break;
      }
    }

    if (!targetId) {
      const created = await cdp.browserCommand<{ targetId: string }>("Target.createTarget", {
        url: `https://${site.domain}`,
      });
      await cdp.attachAndEnable(created.targetId);
      targetId = created.targetId;
      shortId = cdp.tabManager.getTab(created.targetId)?.shortId;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  if (!targetId) {
    const target = await cdp.ensurePageTarget();
    targetId = target.id;
    shortId = cdp.tabManager.getTab(target.id)?.shortId;
  }

  const script = buildSiteAdapterScript(site, args);
  const result = await cdp.evaluate<unknown>(targetId, script, true);

  return {
    tab: shortId,
    result,
  };
}

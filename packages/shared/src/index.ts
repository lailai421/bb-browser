/**
 * @bb-browser/shared
 * 共享类型和工具函数
 */

export {
  type ActionType,
  type ConsoleMessageInfo,
  type DaemonStatus,
  type JSErrorInfo,
  type NetworkRequestInfo,
  type RefInfo,
  type Request,
  type Response,
  type ResponseData,
  type ResponseError,
  type SnapshotData,
  type TabInfo,
  type TraceEntry,
  type TraceAction,
  type TraceRequest,
  type TraceResponse,
  type TraceNavigation,
  type TraceStatus,
} from "./protocol.js";

export {
  COMMAND_TIMEOUT,
  DAEMON_HOST,
  DAEMON_PORT,
  SSE_HEARTBEAT_INTERVAL,
  SSE_MAX_RECONNECT_ATTEMPTS,
  SSE_RECONNECT_DELAY,
} from "./constants.js";

export {
  type CommandDef,
  type ParamDef,
  COMMANDS,
  commandToJsonSchema,
  getCommand,
  getCommandsByGroup,
} from "./commands.js";

export {
  BB_BROWSER_HOME,
  BROWSER_DIR,
  type DaemonInfo,
  DAEMON_DIR,
  DAEMON_JSON,
  resolveBbBrowserHomeDir,
  readDaemonJson,
  isProcessAlive,
  httpJson,
} from "./daemon-client.js";

export {
  type CdpEndpoint,
  discoverCdpPort,
  findBrowserExecutable,
  isManagedBrowserRunning,
  launchManagedBrowser,
} from "./cdp-discovery.js";

export {
  daemonCommand,
  ensureDaemon,
  ensureDaemonRunning,
  getDaemonPath,
  getDaemonStatus,
  isDaemonRunning,
  stopDaemon,
} from "./daemon-runtime.js";

export {
  buildOpenClawArgs,
  getOpenClawExecTimeout,
  ocEvaluate,
  ocFindTabByDomain,
  ocGetTabs,
  ocOpenTab,
  type OCTab,
} from "./openclaw-bridge.js";

export { parseOpenClawJson } from "./openclaw-json.js";

export {
  buildSiteAdapterScript,
  COMMUNITY_REPO,
  COMMUNITY_SITES_DIR,
  findLocalSiteFile,
  findSiteByName,
  getAllSites,
  getSiteHintForDomain,
  LOCAL_SITES_DIR,
  mapCliSiteArgsToNamedArgs,
  mapMcpSiteArgsToNamedArgs,
  parseSiteMeta,
  scanSiteDirectory,
  type ArgDef,
  type SiteMeta,
  validateRequiredSiteArgs,
} from "./site-adapters.js";

export {
  buildSiteRecommendationResult,
  getHistoryDomains,
  recommendSiteAdapters,
  searchHistory,
  type HistoryDomainResult,
  type HistorySearchResult,
  type SiteRecommendation,
  type SiteRecommendationResult,
} from "./site-recommend.js";

export {
  SiteUpdateError,
  updateCommunitySites,
  type SiteUpdateOptions,
  type SiteUpdateResult,
} from "./site-update.js";

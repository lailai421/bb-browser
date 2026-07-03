import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  buildSiteAdapterScript,
  COMMAND_TIMEOUT,
  DAEMON_JSON,
  ensureDaemon,
  findSiteByName,
  mapMcpSiteArgsToNamedArgs,
  ocEvaluate,
  ocFindTabByDomain,
  ocGetTabs,
  ocOpenTab,
  readDaemonJson,
  recommendSiteAdapters,
  SiteUpdateError,
  updateCommunitySites,
  type DaemonInfo,
  type ResponseData,
  type ResponseError,
} from "@bb-browser/shared";

declare const __BB_BROWSER_VERSION__: string;

type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

type DaemonCommandResponse = {
  id?: string;
  success?: boolean;
  data?: Record<string, unknown>;
  result?: ResponseData;
  error?: string | ResponseError;
};

type BrowserCommandDef = {
  name: string;
  action: string;
  description: string;
  args: Record<string, z.ZodTypeAny>;
};

const CHROME_NOT_CONNECTED_HINT = [
  "Chrome is not connected to the daemon.",
  "",
  "Make sure Chrome is running and the daemon can connect to it via CDP.",
  "Run: bb-browser daemon --help for details.",
].join("\n");

const SESSION_OPENED_TABS = new Set<string>();

function daemonBaseUrl(info: DaemonInfo): string {
  return `http://${info.host}:${info.port}`;
}

function daemonHeaders(info: DaemonInfo): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${info.token}`,
  };
}

async function sendCommand(
  request: Record<string, unknown>,
): Promise<DaemonCommandResponse> {
  let timeoutId: NodeJS.Timeout | null = null;

  try {
    await ensureDaemon();
    const info = await readDaemonJson();
    if (!info) {
      return {
        id: String(request.id ?? ""),
        success: false,
        error: `No daemon state found. State file: ${DAEMON_JSON}`,
      };
    }

    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), COMMAND_TIMEOUT);

    const response = await fetch(`${daemonBaseUrl(info)}/command`, {
      method: "POST",
      headers: daemonHeaders(info),
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    if (response.status === 503) {
      return {
        id: String(request.id ?? ""),
        success: false,
        error: CHROME_NOT_CONNECTED_HINT,
      };
    }

    return (await response.json()) as DaemonCommandResponse;
  } catch (error) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    return {
      id: String(request.id ?? ""),
      success: false,
      error: error instanceof Error ? error.message : "Failed to communicate with the daemon.",
    };
  }
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

function responseError(response: DaemonCommandResponse): ToolResult {
  if (typeof response.error === "string") {
    return errorResult(response.error);
  }
  if (response.error && typeof response.error === "object") {
    const lines = [response.error.message || "Unknown error"];
    if (response.error.hint) {
      lines.push(`Hint: ${response.error.hint}`);
    }
    return errorResult(lines.join("\n"));
  }
  return errorResult("Unknown error");
}

function textResult(value: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function normalizeTabId(tabId: unknown): string | undefined {
  if (typeof tabId === "string" && tabId) {
    return tabId;
  }
  if (typeof tabId === "number" && Number.isFinite(tabId)) {
    return String(tabId);
  }
  return undefined;
}

function rememberSessionTab(tabId: unknown): void {
  const normalized = normalizeTabId(tabId);
  if (normalized) {
    SESSION_OPENED_TABS.add(normalized);
  }
}

function forgetSessionTab(tabId: unknown): void {
  const normalized = normalizeTabId(tabId);
  if (normalized) {
    SESSION_OPENED_TABS.delete(normalized);
  }
}

function rememberSessionTabFromResponse(data: Record<string, unknown> | undefined): void {
  if (!data) {
    return;
  }
  rememberSessionTab(data.tabId ?? data.tab);
}

function isSuccessResponse(response: DaemonCommandResponse): boolean {
  if (typeof response.success === "boolean") {
    return response.success;
  }
  return response.error === undefined;
}

function responseData(response: DaemonCommandResponse): Record<string, unknown> | undefined {
  if (response.data && typeof response.data === "object") {
    return response.data;
  }
  if (response.result && typeof response.result === "object") {
    return response.result as Record<string, unknown>;
  }
  return undefined;
}

async function runCommand(
  request: Record<string, unknown>,
): Promise<DaemonCommandResponse> {
  return sendCommand({
    id: randomUUID(),
    ...request,
  });
}

function buildRequest(
  command: BrowserCommandDef,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const { tab, ...rest } = args;
  const request: Record<string, unknown> = {
    method: command.action,
    ...rest,
  };

  if (tab !== undefined) {
    request.tabId = tab;
  }

  return request;
}

function buildNamedSiteArgs(
  name: string,
  positionalArgs: string[] = [],
  namedArgs: Record<string, string> = {},
): Record<string, string> {
  const site = findSiteByName(name);
  if (!site) {
    return { ...namedArgs };
  }
  return mapMcpSiteArgsToNamedArgs(site.args, positionalArgs, namedArgs);
}

function formatAdapterResultError(
  name: string,
  parsed: { error: string; hint?: string },
  domain?: string,
  browserName = "browser",
): string {
  const checkText = `${parsed.error} ${parsed.hint || ""}`;
  const isAuthError = /401|403|unauthorized|forbidden|not.?logged|login.?required|sign.?in|auth/i.test(
    checkText,
  );
  const loginHint =
    isAuthError && domain
      ? `Please log in to https://${domain} in your ${browserName} first, then retry.`
      : undefined;
  const lines = [parsed.error];
  if (loginHint || parsed.hint) {
    lines.push(`Hint: ${loginHint || parsed.hint}`);
  }
  lines.push(
    `Report: gh issue create --repo epiral/bb-sites --title "[${name}] <description>"`,
  );
  return lines.join("\n");
}

async function runOpenClawSiteAdapter(
  name: string,
  positionalArgs: string[] = [],
  namedArgs: Record<string, string> = {},
): Promise<unknown> {
  const site = findSiteByName(name);
  if (!site) {
    throw new Error(`Site adapter "${name}" not found locally for OpenClaw mode`);
  }

  const argMap = mapMcpSiteArgsToNamedArgs(site.args, positionalArgs, namedArgs);
  const script = buildSiteAdapterScript(site, argMap);

  let targetId: string;
  if (site.domain) {
    const tabs = ocGetTabs();
    const existing = ocFindTabByDomain(tabs, site.domain);
    if (existing) {
      targetId = existing.targetId;
    } else {
      targetId = ocOpenTab(`https://${site.domain}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  } else {
    const tabs = ocGetTabs();
    if (tabs.length === 0) {
      throw new Error("No tabs open in OpenClaw browser");
    }
    targetId = tabs[0]?.targetId || "";
  }

  return ocEvaluate(targetId, `async () => { return await ${script}; }`);
}

const BROWSER_COMMANDS: BrowserCommandDef[] = [
  {
    name: "open",
    action: "open",
    description: "Navigate to a URL. Opens in a new tab if no tab is specified.",
    args: {
      url: z.string().describe("URL to open"),
      tab: z.string().optional().describe("Tab short ID to navigate in"),
    },
  },
  {
    name: "back",
    action: "back",
    description: "Navigate back in browser history.",
    args: {
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "forward",
    action: "forward",
    description: "Navigate forward in browser history.",
    args: {
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "reload",
    action: "reload",
    description: "Reload the current page.",
    args: {
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "close",
    action: "close",
    description: "Close the current tab.",
    args: {
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "snapshot",
    action: "snap",
    description: "Get an accessibility tree snapshot of the current page.",
    args: {
      tab: z.string().optional().describe("Tab short ID"),
      interactive: z.boolean().optional().describe("Only show interactive elements"),
      compact: z.boolean().optional().describe("Remove empty structural nodes"),
      maxDepth: z.number().optional().describe("Limit tree depth"),
      selector: z.string().optional().describe("CSS selector to limit scope"),
    },
  },
  {
    name: "screenshot",
    action: "screenshot",
    description: "Take a screenshot of the current page and return PNG data.",
    args: {
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "get",
    action: "get",
    description: "Get text, URL, title, value, or HTML from the page or an element.",
    args: {
      attribute: z
        .enum(["text", "url", "title", "value", "html"])
        .describe("Attribute to retrieve"),
      ref: z.string().optional().describe("Element ref from snapshot"),
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "click",
    action: "click",
    description: "Click an element by ref number from snapshot.",
    args: {
      ref: z.string().describe("Element ref from snapshot"),
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "hover",
    action: "hover",
    description: "Hover over an element by ref number from snapshot.",
    args: {
      ref: z.string().describe("Element ref from snapshot"),
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "fill",
    action: "fill",
    description: "Clear an input field and fill it with new text.",
    args: {
      ref: z.string().describe("Element ref from snapshot"),
      text: z.string().describe("Text to fill"),
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "type",
    action: "type",
    description: "Type text into an input field without clearing existing content.",
    args: {
      ref: z.string().describe("Element ref from snapshot"),
      text: z.string().describe("Text to type"),
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "check",
    action: "check",
    description: "Check a checkbox element.",
    args: {
      ref: z.string().describe("Element ref from snapshot"),
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "uncheck",
    action: "uncheck",
    description: "Uncheck a checkbox element.",
    args: {
      ref: z.string().describe("Element ref from snapshot"),
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "select",
    action: "select",
    description: "Select a value from a dropdown.",
    args: {
      ref: z.string().describe("Element ref from snapshot"),
      value: z.string().describe("Option value to select"),
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "press",
    action: "press",
    description: "Press a keyboard key such as Enter or Control+a.",
    args: {
      key: z.string().describe("Key to press"),
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "scroll",
    action: "scroll",
    description: "Scroll the page in a given direction.",
    args: {
      direction: z
        .enum(["up", "down", "left", "right"])
        .describe("Scroll direction"),
      pixels: z.number().default(300).describe("Scroll distance in pixels"),
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "eval",
    action: "eval",
    description: "Execute JavaScript in the page context and return the result.",
    args: {
      script: z.string().describe("JavaScript source to execute"),
      tab: z.string().optional().describe("Tab short ID"),
      domain: z.string().optional().describe("Target domain for auto-routing"),
      args: z.string().optional().describe("JSON string passed into the script"),
    },
  },
  {
    name: "tab_list",
    action: "tab_list",
    description: "List all open browser tabs with URLs, titles, and short IDs.",
    args: {},
  },
  {
    name: "tab_new",
    action: "tab_new",
    description: "Open a new browser tab, optionally navigating to a URL.",
    args: {
      url: z.string().optional().describe("URL to open in the new tab"),
    },
  },
  {
    name: "frame",
    action: "frame",
    description: "Switch context to an iframe by CSS selector.",
    args: {
      selector: z.string().describe("CSS selector for the iframe"),
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "frame_main",
    action: "frame_main",
    description: "Switch context back to the main frame.",
    args: {
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "dialog",
    action: "dialog",
    description: "Arm a handler for the next browser dialog.",
    args: {
      dialogResponse: z
        .enum(["accept", "dismiss"])
        .default("accept")
        .describe("How to respond to the dialog"),
      promptText: z.string().optional().describe("Optional prompt text"),
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "network",
    action: "network",
    description: "Inspect or manage network activity.",
    args: {
      action: z
        .enum(["requests", "route", "unroute", "clear"])
        .default("requests")
        .describe("Network sub-command"),
      filter: z.string().optional().describe("URL substring filter"),
      since: z
        .union([z.literal("last_action"), z.number()])
        .optional()
        .describe("Incremental query cursor"),
      method: z.string().optional().describe("HTTP method filter"),
      status: z.string().optional().describe("HTTP status filter"),
      limit: z.number().optional().describe("Max result count"),
      withBody: z.boolean().optional().describe("Include request/response bodies"),
      excludeStatic: z.boolean().optional().describe("Exclude static assets"),
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "console",
    action: "console",
    description: "Get or clear console messages from the page.",
    args: {
      action: z.enum(["get", "clear"]).default("get").describe("Console sub-command"),
      filter: z.string().optional().describe("Text filter"),
      since: z
        .union([z.literal("last_action"), z.number()])
        .optional()
        .describe("Incremental query cursor"),
      limit: z.number().optional().describe("Max result count"),
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "errors",
    action: "errors",
    description: "Get or clear JavaScript errors from the page.",
    args: {
      action: z.enum(["get", "clear"]).default("get").describe("Errors sub-command"),
      filter: z.string().optional().describe("Text filter"),
      since: z
        .union([z.literal("last_action"), z.number()])
        .optional()
        .describe("Incremental query cursor"),
      limit: z.number().optional().describe("Max result count"),
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "trace",
    action: "trace",
    description: "Inspect unified action and network tracing.",
    args: {
      action: z
        .enum(["start", "stop", "status", "events", "body"])
        .describe("Trace sub-command"),
      tab: z.string().optional().describe("Tab short ID"),
      since: z.number().optional().describe("Incremental cursor for events"),
      type: z
        .enum(["action", "request", "response", "navigation"])
        .optional()
        .describe("Event type filter"),
      filter: z.string().optional().describe("URL or text filter"),
      limit: z.number().optional().describe("Max result count"),
      requestId: z.string().optional().describe("Request ID for trace body"),
      excludeStatic: z.boolean().optional().describe("Exclude static assets"),
    },
  },
  {
    name: "cookies",
    action: "cookies",
    description: "List cookies for the current page.",
    args: {
      filter: z.string().optional().describe("Cookie name or domain filter"),
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
  {
    name: "source",
    action: "source",
    description: "Search loaded JavaScript sources.",
    args: {
      action: z.literal("grep").describe("Source sub-command"),
      pattern: z.string().describe("Search pattern"),
      tab: z.string().optional().describe("Tab short ID"),
    },
  },
];

const SPECIAL_HANDLERS: Record<
  string,
  (command: BrowserCommandDef) => (args: Record<string, unknown>) => Promise<ToolResult>
> = {
  snapshot:
    (command) =>
    async (args) => {
      const response = await runCommand(buildRequest(command, args));
      if (!isSuccessResponse(response)) {
        return responseError(response);
      }
      const data = responseData(response);
      return textResult(
        (data?.snapshotData as Record<string, unknown> | undefined)?.snapshot ??
          "(empty)",
      );
    },
  screenshot:
    (command) =>
    async (args) => {
      const response = await runCommand(buildRequest(command, args));
      if (!isSuccessResponse(response)) {
        return responseError(response);
      }
      const dataUrl = responseData(response)?.dataUrl;
      if (typeof dataUrl !== "string") {
        return errorResult("Screenshot data missing");
      }
      return {
        content: [
          {
            type: "image",
            data: dataUrl.replace(/^data:image\/png;base64,/, ""),
            mimeType: "image/png",
          },
        ],
      };
    },
  eval:
    (command) =>
    async (args) => {
      const response = await runCommand(buildRequest(command, args));
      if (!isSuccessResponse(response)) {
        return responseError(response);
      }
      return textResult(responseData(response)?.result ?? null);
    },
  get:
    (command) =>
    async (args) => {
      const response = await runCommand(buildRequest(command, args));
      if (!isSuccessResponse(response)) {
        return responseError(response);
      }
      return textResult(responseData(response)?.value ?? "");
    },
  tab_list:
    (command) =>
    async (args) => {
      const response = await runCommand(buildRequest(command, args));
      if (!isSuccessResponse(response)) {
        return responseError(response);
      }
      return textResult(responseData(response)?.tabs || []);
    },
  open:
    (command) =>
    async (args) => {
      const response = await runCommand(buildRequest(command, args));
      if (!isSuccessResponse(response)) {
        return responseError(response);
      }
      const data = responseData(response);
      if (args.tab === undefined) {
        rememberSessionTabFromResponse(data);
      }
      return textResult(data || `Opened ${String(args.url)}`);
    },
  tab_new:
    (command) =>
    async (args) => {
      const response = await runCommand(buildRequest(command, args));
      if (!isSuccessResponse(response)) {
        return responseError(response);
      }
      const data = responseData(response);
      rememberSessionTabFromResponse(data);
      return textResult(data || "Opened new tab");
    },
  close:
    () =>
    async (args) => {
      const { tab, ...rest } = args;
      const request: Record<string, unknown> = {
        method: "close",
        ...rest,
      };
      if (tab !== undefined) {
        request.tabId = tab;
      }
      const response = await runCommand(request);
      if (!isSuccessResponse(response)) {
        return responseError(response);
      }
      forgetSessionTab(tab);
      return textResult(responseData(response) || "Closed tab");
    },
  press:
    () =>
    async (args) => {
      const key = String(args.key);
      const parts = key.split("+");
      const modifiers = new Set(["Control", "Alt", "Shift", "Meta"]);
      const activeModifiers = parts.filter((part) => modifiers.has(part));
      const mainKey = parts.find((part) => !modifiers.has(part));
      if (!mainKey) {
        return errorResult("Invalid key format");
      }
      const { tab, ...rest } = args;
      const request: Record<string, unknown> = {
        method: "press",
        ...rest,
        key: mainKey,
        modifiers: activeModifiers,
      };
      if (tab !== undefined) {
        request.tabId = tab;
      }
      const response = await runCommand(request);
      if (!isSuccessResponse(response)) {
        return responseError(response);
      }
      return textResult(responseData(response) || `Pressed ${key}`);
    },
  network:
    (command) =>
    async (args) => {
      const { method, ...rest } = args;
      const request = buildRequest(command, rest);
      if (method !== undefined) {
        request.httpMethod = method;
      }
      const response = await runCommand(request);
      if (!isSuccessResponse(response)) {
        return responseError(response);
      }
      const data = responseData(response);
      if ((args.action ?? "requests") === "requests") {
        return textResult({
          requests:
            data?.networkRequests ||
            (data?.requests as unknown[]) ||
            [],
          cursor: data?.cursor,
        });
      }
      return textResult(data || "Done");
    },
  console:
    (command) =>
    async (args) => {
      const response = await runCommand(buildRequest(command, args));
      if (!isSuccessResponse(response)) {
        return responseError(response);
      }
      const data = responseData(response);
      if ((args.action ?? "get") === "get") {
        return textResult({
          messages:
            data?.consoleMessages ||
            (data?.messages as unknown[]) ||
            [],
          cursor: data?.cursor,
        });
      }
      return textResult(data || "Cleared");
    },
  errors:
    (command) =>
    async (args) => {
      const response = await runCommand(buildRequest(command, args));
      if (!isSuccessResponse(response)) {
        return responseError(response);
      }
      const data = responseData(response);
      if ((args.action ?? "get") === "get") {
        return textResult({
          errors:
            data?.jsErrors ||
            (data?.errors as unknown[]) ||
            [],
          cursor: data?.cursor,
        });
      }
      return textResult(data || "Cleared");
    },
};

function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "bb-browser",
      version: __BB_BROWSER_VERSION__,
    },
    {
      instructions: `bb-browser lets you control the user's real Chrome browser via CDP (Chrome DevTools Protocol).

Use browser_snapshot to inspect the page, then browser_click/fill/type/select with ref numbers.
Use browser_eval for direct DOM or fetch access in the page context.
Use browser_network, browser_console, browser_errors, and browser_trace for debugging and reverse engineering.
Use site_list/site_search/site_info/site_run/site_update for prebuilt site adapters.
Prefer the dedicated bb-browser-mcp command. bb-browser --mcp remains supported for compatibility.`,
    },
  );

  for (const command of BROWSER_COMMANDS) {
    const toolName = `browser_${command.name}`;
    const handler = SPECIAL_HANDLERS[command.name];
    if (handler) {
      server.tool(toolName, command.description, command.args, handler(command));
      continue;
    }

    server.tool(toolName, command.description, command.args, async (args) => {
      const response = await runCommand(buildRequest(command, args));
      if (!isSuccessResponse(response)) {
        return responseError(response);
      }
      return textResult(responseData(response) || "Done");
    });
  }

  server.tool(
    "browser_close_all",
    "Close tabs opened by bb-browser during the current MCP session.",
    {},
    async () => {
      const closedTabs: string[] = [];
      const alreadyClosedTabs: string[] = [];
      const failedTabs: Array<{ tabId: string; error: string }> = [];

      for (const tabId of Array.from(SESSION_OPENED_TABS)) {
        const response = await runCommand({ method: "close", tabId });
        if (isSuccessResponse(response)) {
          SESSION_OPENED_TABS.delete(tabId);
          closedTabs.push(tabId);
          continue;
        }

        const error =
          typeof response.error === "string"
            ? response.error
            : response.error?.message || "Unknown error";
        if (/tab not found/i.test(error)) {
          SESSION_OPENED_TABS.delete(tabId);
          alreadyClosedTabs.push(tabId);
          continue;
        }

        SESSION_OPENED_TABS.delete(tabId);
        failedTabs.push({ tabId, error });
      }

      return textResult({
        closedTabs,
        alreadyClosedTabs,
        failedTabs,
        remainingTrackedTabs: Array.from(SESSION_OPENED_TABS),
      });
    },
  );

  server.tool("site_list", "List installed site adapters.", {}, async () => {
    const response = await runCommand({ method: "site_list" });
    if (!isSuccessResponse(response)) {
      return responseError(response);
    }
    return textResult(responseData(response)?.sites || []);
  });

  server.tool(
    "site_search",
    "Search installed site adapters by name, description, or domain.",
    { query: z.string().describe("Search query") },
    async ({ query }) => {
      const response = await runCommand({
        method: "site_search",
        query,
      });
      if (!isSuccessResponse(response)) {
        return responseError(response);
      }
      return textResult(responseData(response)?.sites || []);
    },
  );

  server.tool(
    "site_info",
    "Get adapter metadata including args, example, and domain.",
    { name: z.string().describe("Adapter name, e.g. twitter/search") },
    async ({ name }) => {
      const response = await runCommand({
        method: "site_info",
        siteName: name,
      });
      if (!isSuccessResponse(response)) {
        return responseError(response);
      }
      return textResult(responseData(response) || {});
    },
  );

  server.tool(
    "site_recommend",
    "Recommend adapters based on recent browsing history.",
    {
      days: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("How many recent days of history to inspect"),
    },
    async ({ days }) => {
      return textResult(recommendSiteAdapters(days ?? 30));
    },
  );

  server.tool(
    "site_run",
    "Run a site adapter and return its structured data.",
    {
      name: z.string().describe("Adapter name, e.g. twitter/search"),
      args: z
        .array(z.string())
        .optional()
        .describe("Positional arguments in adapter-defined order"),
      namedArgs: z
        .record(z.string())
        .optional()
        .describe("Named adapter arguments passed as --key value"),
      tab: z.string().optional().describe("Optional tab short ID"),
      openclaw: z
        .boolean()
        .optional()
        .describe("Prefer the OpenClaw browser"),
    },
    async ({ name, args, namedArgs, tab, openclaw }) => {
      try {
        if (openclaw) {
          const parsed = await runOpenClawSiteAdapter(name, args || [], namedArgs || {});
          if (
            parsed &&
            typeof parsed === "object" &&
            "error" in parsed &&
            typeof parsed.error === "string"
          ) {
            const parsedError = parsed as { error: string; hint?: string };
            const site = findSiteByName(name);
            return errorResult(
              formatAdapterResultError(
                name,
                parsedError,
                site?.domain,
                "OpenClaw browser",
              ),
            );
          }
          return textResult(parsed);
        }

        const response = await runCommand({
          method: "site_run",
          siteName: name,
          siteArgs: buildNamedSiteArgs(name, args || [], namedArgs || {}),
          ...(tab !== undefined ? { tabId: tab } : {}),
        });
        if (!isSuccessResponse(response)) {
          return responseError(response);
        }

        const result = responseData(response)?.result ?? null;
        if (
          result &&
          typeof result === "object" &&
          "error" in result &&
          typeof result.error === "string"
        ) {
          const resultError = result as { error: string; hint?: string };
          const site = findSiteByName(name);
          return errorResult(
            formatAdapterResultError(
              name,
              resultError,
              site?.domain,
            ),
          );
        }

        return textResult(result);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.tool("site_update", "Pull or clone the community adapter repository.", {}, async () => {
    try {
      return textResult(updateCommunitySites());
    } catch (error) {
      if (error instanceof SiteUpdateError) {
        return errorResult(`${error.message}\nAction: ${error.action}`);
      }
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const entryPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (argvPath && entryPath === argvPath) {
  startMcpServer().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}

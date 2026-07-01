import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path, { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  COMMAND_TIMEOUT,
  DAEMON_JSON,
  readDaemonJson,
  type DaemonInfo,
  type DaemonStatus,
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

type SiteCliResult =
  | Record<string, unknown>
  | string
  | null;

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

function getCliPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const siblingCli = resolve(currentDir, "cli.js");
  if (existsSync(siblingCli)) {
    return siblingCli;
  }
  return resolve(currentDir, "../../cli/dist/index.js");
}

function daemonBaseUrl(info: DaemonInfo): string {
  return `http://${info.host}:${info.port}`;
}

function daemonHeaders(info: DaemonInfo): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${info.token}`,
  };
}

type ExecFileResult = {
  stdout: string;
  stderr: string;
};

function execFileAsync(command: string, args: string[], timeout: number): Promise<ExecFileResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise({
          stdout,
          stderr,
        });
      },
    );
  });
}

async function readDaemonStatus(info: DaemonInfo): Promise<DaemonStatus | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${daemonBaseUrl(info)}/status`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as DaemonStatus;
  } catch {
    return null;
  }
}

async function isDaemonHealthy(): Promise<boolean> {
  const info = await readDaemonJson();
  if (!info) {
    return false;
  }

  const status = await readDaemonStatus(info);
  if (!status?.running) {
    return false;
  }

  return status.cdpConnected !== false;
}

function trimOutput(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function formatCliStartFailure(error: unknown): string {
  const execError = error as NodeJS.ErrnoException & {
    stdout?: string | Buffer;
    stderr?: string | Buffer;
  };
  const stderr = trimOutput(
    typeof execError.stderr === "string" ? execError.stderr : execError.stderr?.toString("utf8"),
  );
  const stdout = trimOutput(
    typeof execError.stdout === "string" ? execError.stdout : execError.stdout?.toString("utf8"),
  );
  const detail = stderr || stdout || (error instanceof Error ? error.message : String(error));
  return [
    "bb-browser CLI failed to start the daemon.",
    detail,
    `State file: ${DAEMON_JSON}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatUnhealthyDaemonError(result: ExecFileResult): string {
  const stdout = trimOutput(result.stdout);
  const stderr = trimOutput(result.stderr);
  return [
    "bb-browser CLI returned, but the daemon is still unhealthy.",
    stdout ? `stdout:\n${stdout}` : "",
    stderr ? `stderr:\n${stderr}` : "",
    `State file: ${DAEMON_JSON}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function ensureDaemon(): Promise<void> {
  if (await isDaemonHealthy()) {
    return;
  }

  const cliPath = getCliPath();
  let result: ExecFileResult;
  try {
    result = await execFileAsync(
      process.execPath,
      [cliPath, "daemon", "start", "--json"],
      15000,
    );
  } catch (error) {
    throw new Error(formatCliStartFailure(error));
  }

  if (await isDaemonHealthy()) {
    return;
  }

  throw new Error(formatUnhealthyDaemonError(result));
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

function tryParseJson(raw: string): SiteCliResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as SiteCliResult;
  } catch {
    // Fall through to line-window parsing.
  }

  const lines = trimmed.split(/\r?\n/);
  for (let end = lines.length; end > 0; end -= 1) {
    for (let start = end - 1; start >= 0; start -= 1) {
      const candidate = lines.slice(start, end).join("\n").trim();
      if (!candidate) {
        continue;
      }
      try {
        return JSON.parse(candidate) as SiteCliResult;
      } catch {
        // Keep scanning.
      }
    }
  }

  return null;
}

function formatSiteCliError(
  value: SiteCliResult,
  stderr: string,
  stdout: string,
): string {
  if (
    value &&
    typeof value === "object" &&
    "error" in value &&
    typeof value.error === "string"
  ) {
    const lines = [value.error];
    if ("hint" in value && typeof value.hint === "string" && value.hint) {
      lines.push(`Hint: ${value.hint}`);
    }
    if ("action" in value && typeof value.action === "string" && value.action) {
      lines.push(`Action: ${value.action}`);
    }
    if (
      "reportHint" in value &&
      typeof value.reportHint === "string" &&
      value.reportHint
    ) {
      lines.push(`Report: ${value.reportHint}`);
    }
    if (
      "suggestions" in value &&
      Array.isArray(value.suggestions) &&
      value.suggestions.length > 0
    ) {
      lines.push(`Suggestions: ${value.suggestions.join(", ")}`);
    }
    return lines.join("\n");
  }

  const fallback = [stderr.trim(), stdout.trim()].find(Boolean);
  return fallback || "bb-browser site command failed";
}

async function runSiteCli(args: string[]): Promise<SiteCliResult> {
  const cliPath = getCliPath();
  const result = await new Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
  }>((resolvePromise) => {
    execFile(
      process.execPath,
      [cliPath, "site", ...args],
      {
        encoding: "utf8",
        timeout: COMMAND_TIMEOUT,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolvePromise({
          ok: !error,
          stdout,
          stderr,
        });
      },
    );
  });

  const parsed = tryParseJson(result.stdout);
  if (
    parsed &&
    typeof parsed === "object" &&
    "success" in parsed &&
    parsed.success === false
  ) {
    throw new Error(formatSiteCliError(parsed, result.stderr, result.stdout));
  }

  if (!result.ok) {
    throw new Error(formatSiteCliError(parsed, result.stderr, result.stdout));
  }

  return parsed ?? result.stdout.trim();
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
    try {
      return textResult(await runSiteCli(["list", "--json"]));
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  server.tool(
    "site_search",
    "Search installed site adapters by name, description, or domain.",
    { query: z.string().describe("Search query") },
    async ({ query }) => {
      try {
        return textResult(await runSiteCli(["search", query, "--json"]));
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.tool(
    "site_info",
    "Get adapter metadata including args, example, and domain.",
    { name: z.string().describe("Adapter name, e.g. twitter/search") },
    async ({ name }) => {
      try {
        return textResult(await runSiteCli(["info", name, "--json"]));
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
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
      try {
        const args = ["recommend", "--json"];
        if (days !== undefined) {
          args.push("--days", String(days));
        }
        return textResult(await runSiteCli(args));
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
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
        const cliArgs = ["run", name];
        for (const arg of args || []) {
          cliArgs.push(arg);
        }
        for (const [key, value] of Object.entries(namedArgs || {})) {
          cliArgs.push(`--${key}`, value);
        }
        if (tab !== undefined) {
          cliArgs.push("--tab", tab);
        }
        if (openclaw) {
          cliArgs.push("--openclaw");
        }
        cliArgs.push("--json");

        const result = await runSiteCli(cliArgs);
        const unwrapped =
          result &&
          typeof result === "object" &&
          "data" in result
            ? result.data
            : result;
        return textResult(unwrapped);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.tool("site_update", "Pull or clone the community adapter repository.", {}, async () => {
    try {
      return textResult(await runSiteCli(["update", "--json"]));
    } catch (error) {
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

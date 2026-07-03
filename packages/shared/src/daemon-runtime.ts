import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response, DaemonStatus } from "./protocol.js";
import {
  COMMAND_TIMEOUT,
} from "./constants.js";
import {
  DAEMON_JSON,
  type DaemonInfo,
  httpJson,
  isProcessAlive,
  readDaemonJson,
} from "./daemon-client.js";
import { discoverCdpPort } from "./cdp-discovery.js";

let cachedInfo: DaemonInfo | null = null;
let daemonReady = false;

function isHealthyStatus(status: Pick<DaemonStatus, "running" | "cdpConnected">): boolean {
  return status.running === true && status.cdpConnected !== false;
}

function daemonStateHint(): string {
  return `State file: ${DAEMON_JSON}`;
}

async function deleteDaemonJson(): Promise<void> {
  try {
    await unlink(DAEMON_JSON);
  } catch {}
}

export function getDaemonPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  const candidates = [
    resolve(currentDir, "daemon.js"),
    resolve(currentDir, "../daemon.js"),
    resolve(currentDir, "../../../dist/daemon.js"),
    resolve(currentDir, "../../daemon/dist/index.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[candidates.length - 1] as string;
}

export async function ensureDaemon(): Promise<void> {
  if (daemonReady && cachedInfo) {
    try {
      const status = await httpJson<DaemonStatus>(
        "GET",
        "/status",
        cachedInfo,
        undefined,
        2000,
      );
      if (isHealthyStatus(status)) {
        return;
      }
    } catch {}
    daemonReady = false;
    cachedInfo = null;
  }

  let info = await readDaemonJson();
  if (info && !isProcessAlive(info.pid)) {
    await deleteDaemonJson();
    info = null;
  }

  if (info) {
    try {
      const status = await httpJson<DaemonStatus>("GET", "/status", info, undefined, 2000);
      if (isHealthyStatus(status)) {
        cachedInfo = info;
        daemonReady = true;
        return;
      }
      await stopDaemon(info);
      info = null;
    } catch {
      await stopDaemon(info);
      info = null;
    }
  }

  const cdpInfo = await discoverCdpPort();
  if (!cdpInfo) {
    throw new Error(
      "bb-browser: Cannot find a Chromium-based browser.\n\n" +
        "Please do one of the following:\n" +
        "  1. Install Google Chrome, Edge, or Brave\n" +
        "  2. Start Chrome with: google-chrome --remote-debugging-port=9222\n" +
        "  3. Set BB_BROWSER_CDP_URL=http://host:port",
    );
  }

  const daemonPath = getDaemonPath();
  const daemonArgs = [daemonPath, "--cdp-host", cdpInfo.host, "--cdp-port", String(cdpInfo.port)];
  const daemonPort = Number.parseInt(process.env.BB_BROWSER_DAEMON_PORT ?? "", 10);
  if (Number.isInteger(daemonPort) && daemonPort > 0) {
    daemonArgs.push("--port", String(daemonPort));
  }

  const hubUrl = process.env.BB_BROWSER_HUB_URL || process.env.PINIX_HUB_URL;
  const hubToken =
    process.env.BB_BROWSER_HUB_TOKEN ||
    process.env.PINIX_HUB_TOKEN ||
    process.env.PINIX_TOKEN;
  if (hubUrl) {
    daemonArgs.push("--hub", hubUrl);
    if (hubToken) {
      daemonArgs.push("--hub-token", hubToken);
    }
  }

  const child = spawn(process.execPath, daemonArgs, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let childExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let daemonStderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    daemonStderr += chunk;
    if (daemonStderr.length > 16000) {
      daemonStderr = daemonStderr.slice(-16000);
    }
  });
  child.once("exit", (code, signal) => {
    childExit = { code, signal };
  });
  child.unref();

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    info = await readDaemonJson();
    if (!info) {
      if (childExit) {
        break;
      }
      continue;
    }

    try {
      const status = await httpJson<DaemonStatus>("GET", "/status", info, undefined, 2000);
      if (isHealthyStatus(status)) {
        cachedInfo = info;
        daemonReady = true;
        child.stderr?.destroy();
        return;
      }
    } catch {}

    if (childExit) {
      break;
    }
  }

  child.stderr?.destroy();
  if (info) {
    await stopDaemon(info);
  }

  throw new Error(
    "bb-browser: Daemon did not start in time.\n\n" +
      "Chrome CDP is reachable, but the daemon process failed to initialize or reconnect.\n" +
      (childExit
        ? `Daemon exit: code=${(childExit as { code: number | null; signal: NodeJS.Signals | null }).code ?? "null"} signal=${(childExit as { code: number | null; signal: NodeJS.Signals | null }).signal ?? "null"}\n`
        : "") +
      (daemonStderr.trim() ? `Daemon stderr:\n${daemonStderr.trim()}\n` : "") +
      `${daemonStateHint()}\n` +
      "Try: bb-browser daemon status",
  );
}

export async function daemonCommand(request: Request): Promise<Response> {
  if (!cachedInfo) {
    cachedInfo = await readDaemonJson();
  }
  if (!cachedInfo) {
    throw new Error(`No daemon state found. ${daemonStateHint()}`);
  }
  return httpJson<Response>("POST", "/command", cachedInfo, request, COMMAND_TIMEOUT);
}

export async function stopDaemon(infoOverride?: DaemonInfo | null): Promise<boolean> {
  const info = infoOverride ?? cachedInfo ?? (await readDaemonJson());
  if (!info) {
    return false;
  }

  daemonReady = false;
  cachedInfo = null;

  try {
    await httpJson("POST", "/shutdown", info, undefined, 3000);
  } catch {}

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!existsSync(DAEMON_JSON)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  if (isProcessAlive(info.pid)) {
    try {
      process.kill(info.pid, "SIGKILL");
    } catch {}
  }
  await deleteDaemonJson();
  return true;
}

export async function isDaemonRunning(): Promise<boolean> {
  const info = cachedInfo ?? (await readDaemonJson());
  if (!info) {
    return false;
  }
  try {
    const status = await httpJson<DaemonStatus>("GET", "/status", info, undefined, 2000);
    return isHealthyStatus(status);
  } catch {
    return false;
  }
}

export async function getDaemonStatus(): Promise<Record<string, unknown> | null> {
  const info = cachedInfo ?? (await readDaemonJson());
  if (!info) {
    return null;
  }
  try {
    return await httpJson<Record<string, unknown>>("GET", "/status", info, undefined, 2000);
  } catch {
    return null;
  }
}

export const ensureDaemonRunning = ensureDaemon;

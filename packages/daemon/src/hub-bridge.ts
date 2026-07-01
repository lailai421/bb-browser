/**
 * Hub bridge — connects daemon directly to Pinix Hub via gRPC ProviderStream.
 *
 * Extracted from bin/bb-browser-provider.ts and adapted to call
 * dispatchRequest() directly instead of HTTP round-tripping to daemon.
 */

import { readFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { join, dirname, resolve, extname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { platform, arch } from "node:os";
import { create } from "@bufbuild/protobuf";
import { createClient, type CallOptions } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import {
  HubService,
  type ProviderMessage,
  type HubMessage,
  type InvokeCommand,
  ProviderMessageSchema,
  RegisterRequestSchema,
  ClipRegistrationSchema,
  InvokeResultSchema,
  HeartbeatSchema,
  HubErrorSchema,
} from "@pinixai/hub-client";
// GetClipWebResultSchema is not re-exported from @pinixai/hub-client index;
// import directly from the gen file via relative path to node_modules.
import { GetClipWebResultSchema, type GetClipWebCommand } from "../../../node_modules/@pinixai/hub-client/src/gen/hub_pb.ts";

import { COMMANDS, commandToJsonSchema } from "@bb-browser/shared";
import { COMMAND_TIMEOUT } from "@bb-browser/shared";
import type { Request } from "@bb-browser/shared";
import { DAEMON_DIR as SHARED_DAEMON_DIR } from "@bb-browser/shared";

import { CdpConnection } from "./cdp-connection.js";
import { dispatchRequest } from "./command-dispatch.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_PREFIX = "[hub-bridge]";
const PROVIDER_NAME = "bb-browser";
const BROWSER_CLIP_ALIAS = "browser";
const BROWSER_CLIP_PACKAGE = "browser";
const BROWSER_CLIP_DOMAIN = "\u6d4f\u89c8\u5668";
const RECONNECT_DELAY_MS = 5000;
const REGISTER_TIMEOUT_MS = 10000;
const HEARTBEAT_INTERVAL_MS = 15000;

const STREAMER_PORT = "3334";
const STREAMER_API_BASE = `http://127.0.0.1:${STREAMER_PORT}`;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Package version
// ---------------------------------------------------------------------------

function readPackageVersion(): string {
  try {
    // Resolve relative to this file — works for both dev and built paths
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(currentDir, "../../../package.json"),   // dev: packages/daemon/src/
      resolve(currentDir, "../../package.json"),       // built: packages/daemon/dist/
      resolve(currentDir, "../package.json"),           // release bundle: dist/
    ];
    for (const p of candidates) {
      try {
        const pkg = JSON.parse(readFileSync(p, "utf-8")) as { version?: string };
        if (pkg.version) return pkg.version.trim();
      } catch {}
    }
    return "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const CLIP_VERSION = readPackageVersion();

// ---------------------------------------------------------------------------
// Streamer (viewer) sidecar management
// ---------------------------------------------------------------------------

let streamerProcess: ChildProcess | null = null;
let activeHubUrl: string | null = null;

interface TurnCredentials {
  url: string;
  username: string;
  password: string;
}

async function fetchTurnCredentials(): Promise<TurnCredentials | null> {
  // 1. Try Hub API (secret stays server-side)
  if (activeHubUrl) {
    try {
      const hubBase = activeHubUrl.replace(/\/$/, "");
      const resp = await fetch(`${hubBase}/turn/credentials`, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const data = await resp.json() as TurnCredentials;
        if (data.url && data.username && data.password) return data;
      }
    } catch {}
  }

  // 2. Fall back to env vars (standalone / no-hub mode)
  const turnUrl = process.env.TURN_URL;
  const turnSecret = process.env.TURN_SECRET;
  if (turnUrl && turnSecret) {
    const { username, password } = generateTurnCredentials(turnSecret);
    return { url: turnUrl, username, password };
  }

  return null;
}

const BB_VIEWER_COS_BASE = "https://pinix-blobs-1251447449.cos.ap-beijing.myqcloud.com/releases/bb-viewer/latest";

function viewerPlatformKey(): string | null {
  const p = platform();
  const a = arch();
  if (p === "darwin" && a === "arm64") return "darwin-arm64";
  if (p === "darwin" && a === "x64") return "darwin-x64";
  if (p === "linux" && a === "x64") return "linux-amd64";
  return null;
}

async function downloadStreamerBinary(destPath: string): Promise<void> {
  const key = viewerPlatformKey();
  if (!key) throw new Error(`No pre-built bb-viewer for ${platform()}/${arch()}`);

  const url = `${BB_VIEWER_COS_BASE}/bb-viewer-${key}`;
  console.error(`${LOG_PREFIX} Downloading bb-viewer from ${url}...`);

  const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok || !resp.body) throw new Error(`Failed to download bb-viewer: ${resp.status}`);

  mkdirSync(dirname(destPath), { recursive: true });
  const tmpPath = destPath + ".tmp";
  // @ts-expect-error ReadableStream vs NodeJS.ReadableStream
  await pipeline(resp.body, createWriteStream(tmpPath));

  const { renameSync } = await import("node:fs");
  renameSync(tmpPath, destPath);
  chmodSync(destPath, 0o755);
  console.error(`${LOG_PREFIX} bb-viewer installed at ${destPath}`);
}

async function ensureStreamerBinary(): Promise<string> {
  // 1. Check local install
  const localPath = join(SHARED_DAEMON_DIR, "bin", "bb-viewer");
  if (existsSync(localPath)) return localPath;

  // 2. Check PATH
  try {
    const { execSync } = await import("node:child_process");
    const which = execSync("which bb-viewer 2>/dev/null", { encoding: "utf8", timeout: 3000 }).trim();
    if (which && existsSync(which)) return which;
  } catch {}

  // 3. Auto-download
  await downloadStreamerBinary(localPath);
  return localPath;
}

function generateTurnCredentials(secret: string, ttlSeconds = 86400): { username: string; password: string } {
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = `${expiry}:bbviewer`;
  const password = createHmac("sha1", secret).update(username).digest("base64");
  return { username, password };
}

async function ensureStreamer(): Promise<void> {
  if (streamerProcess && !streamerProcess.killed) {
    try {
      const resp = await fetch(`${STREAMER_API_BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) return;
    } catch {}
    try { streamerProcess.kill(); } catch {}
    streamerProcess = null;
  }

  const bin = await ensureStreamerBinary();

  // Streamer no longer needs --cdp-port; daemon provides CDP WebSocket URLs
  // via the /command endpoint.
  const args = ["--api-only", "--port", STREAMER_PORT];

  // TURN relay for WebRTC NAT traversal.
  // Fetch temporary credentials from Hub API (secret stays server-side).
  // Fall back to env vars for standalone (no-hub) mode.
  const turnCreds = await fetchTurnCredentials();
  if (turnCreds) {
    args.push("--turn-url", turnCreds.url, "--turn-user", turnCreds.username, "--turn-cred", turnCreds.password);
  }

  console.error(`${LOG_PREFIX} Spawning streamer: ${bin} ${args.join(" ")}`);
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  streamerProcess = child;

  child.on("error", (err) => {
    console.error(`${LOG_PREFIX} [streamer] spawn error: ${err.message}`);
    if (streamerProcess === child) streamerProcess = null;
  });
  child.stdout?.on("data", (d: Buffer) => {
    for (const line of d.toString().trim().split("\n")) console.error(`${LOG_PREFIX} [streamer] ${line}`);
  });
  child.stderr?.on("data", (d: Buffer) => {
    for (const line of d.toString().trim().split("\n")) console.error(`${LOG_PREFIX} [streamer] ${line}`);
  });
  child.on("exit", (code) => {
    console.error(`${LOG_PREFIX} [streamer] exited with code ${code}`);
    if (streamerProcess === child) streamerProcess = null;
  });

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const resp = await fetch(`${STREAMER_API_BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        console.error(`${LOG_PREFIX} Streamer ready at port ${STREAMER_PORT}`);
        return;
      }
    } catch {}
  }
  throw new Error("Streamer did not become healthy in 10s");
}

async function streamerCommand(path: string, body?: unknown): Promise<unknown> {
  const url = `${STREAMER_API_BASE}${path}`;
  const opts: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15000),
  };
  const resp = await fetch(url, opts);
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Streamer ${path} failed (${resp.status}): ${text}`);
  try { return JSON.parse(text); } catch { return { output: text }; }
}

export function stopStreamer(): void {
  if (streamerProcess && !streamerProcess.killed) {
    console.error(`${LOG_PREFIX} Stopping streamer`);
    try { streamerProcess.kill(); } catch {}
    streamerProcess = null;
  }
}

// ---------------------------------------------------------------------------
// Build clip registrations
// ---------------------------------------------------------------------------

const BROWSER_COMMANDS = COMMANDS.filter((c) => c.group !== "site");

const STREAM_COMMANDS = [
  {
    name: "stream.start",
    description: "Start remote viewing: creates a WebRTC peer and returns offer SDP + ICE candidates",
    inputSchema: JSON.stringify({ type: "object", properties: {}, additionalProperties: true }),
  },
  {
    name: "stream.answer",
    description: "Complete WebRTC connection: accepts answer SDP + ICE candidates, starts video streaming",
    inputSchema: JSON.stringify({
      type: "object",
      properties: {
        answer_sdp: { type: "string", description: "Answer SDP from the remote peer" },
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: { candidate: { type: "string" }, sdpMLineIndex: { type: "number" } },
            required: ["candidate", "sdpMLineIndex"],
          },
          description: "ICE candidates from the remote peer",
        },
      },
      required: ["answer_sdp"],
      additionalProperties: true,
    }),
  },
  {
    name: "stream.close",
    description: "Stop remote viewing and close the WebRTC peer",
    inputSchema: JSON.stringify({ type: "object", properties: {}, additionalProperties: true }),
  },
  {
    name: "stream.switch",
    description: "Switch the streaming tab: tell the streamer to connect to a different tab's CDP WebSocket",
    inputSchema: JSON.stringify({
      type: "object",
      properties: {
        tab: { type: "string", description: "Short tab ID to switch streaming to" },
      },
      required: ["tab"],
      additionalProperties: true,
    }),
  },
];

const BROWSER_COMMAND_NAMES = [
  ...BROWSER_COMMANDS.map((c) => c.method),
  "stream.start",
  "stream.answer",
  "stream.close",
  "stream.switch",
];

function buildClipRegistrations() {
  const browserCommands = [
    ...BROWSER_COMMANDS.map((cmd) => ({
      name: cmd.method,
      description: cmd.description,
      input: commandToJsonSchema(cmd),
      output: JSON.stringify({ type: "object", additionalProperties: true }),
    })),
    ...STREAM_COMMANDS.map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      input: cmd.inputSchema,
      output: JSON.stringify({ type: "object", additionalProperties: true }),
    })),
  ];

  const browserClip = create(ClipRegistrationSchema, {
    alias: BROWSER_CLIP_ALIAS,
    package: BROWSER_CLIP_PACKAGE,
    version: CLIP_VERSION,
    domain: BROWSER_CLIP_DOMAIN,
    commands: browserCommands,
    hasWeb: true,
    dependencies: [],
    tokenProtected: false,
  });

  return { browserClip };
}

// ---------------------------------------------------------------------------
// Input/output encoding
// ---------------------------------------------------------------------------

type InputObject = Record<string, unknown>;

function decodeInput(data: Uint8Array | undefined): InputObject {
  if (!data || data.length === 0) return {};
  let raw = textDecoder.decode(data).trim();
  if (!raw) return {};
  raw = raw.replace(
    /"(?:[^"\\]|\\.)*"|\d{16,}/g,
    (m) => m.startsWith('"') ? m : `"${m}"`,
  );
  try { return JSON.parse(raw) as InputObject; }
  catch { throw new Error("Invoke input must be valid JSON"); }
}

function encodeOutput(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value ?? {}));
}

// ---------------------------------------------------------------------------
// AsyncMessageQueue
// ---------------------------------------------------------------------------

class AsyncMessageQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{ resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }> = [];
  private closed = false;
  private failed: Error | null = null;

  push(value: T): void {
    if (this.closed) throw new Error("queue is closed");
    if (this.failed) throw this.failed;
    const w = this.waiters.shift();
    if (w) { w.resolve({ done: false, value }); return; }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!.resolve({ done: true, value: undefined as never });
  }

  fail(error: unknown): void {
    if (this.failed) return;
    this.failed = error instanceof Error ? error : new Error(String(error));
    while (this.waiters.length) this.waiters.shift()!.reject(this.failed);
  }

  next(): Promise<IteratorResult<T>> {
    if (this.values.length) return Promise.resolve({ done: false, value: this.values.shift()! });
    if (this.failed) return Promise.reject(this.failed);
    if (this.closed) return Promise.resolve({ done: true, value: undefined as never });
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); });
  }

  return(): Promise<IteratorResult<T>> { this.close(); return Promise.resolve({ done: true, value: undefined as never }); }
  throw(e?: unknown): Promise<IteratorResult<T>> { this.fail(e ?? new Error("aborted")); return Promise.reject(this.failed); }
  [Symbol.asyncIterator](): AsyncIterator<T> { return this; }
}

// ---------------------------------------------------------------------------
// ProviderStream bridge
// ---------------------------------------------------------------------------

interface ProviderClient {
  providerStream(request: AsyncIterable<ProviderMessage>, options?: CallOptions): AsyncIterable<HubMessage>;
}

export interface HubBridgeOptions {
  hubUrl: string;
  hubToken?: string;
  cdp: CdpConnection;
  /** @deprecated No longer used by streamer; kept for backward compat. */
  cdpPort?: number;
}

export class HubBridge {
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly hubUrl: string;
  private readonly hubToken: string | undefined;
  private readonly cdp: CdpConnection;

  constructor(options: HubBridgeOptions) {
    this.hubUrl = options.hubUrl;
    this.hubToken = options.hubToken;
    this.cdp = options.cdp;
    activeHubUrl = options.hubUrl;
  }

  start(): void { this.connect(); }

  stop(): void {
    this.stopped = true;
    this.clearReconnect();
    this.abortController?.abort();
    stopStreamer();
  }

  private connect(): void {
    if (this.stopped) return;
    this.runStream().catch((err) => {
      if (this.stopped) return;
      console.error(`${LOG_PREFIX} Stream error: ${err instanceof Error ? err.message : err}`);
      this.scheduleReconnect();
    });
  }

  private async runStream(): Promise<void> {
    console.error(`${LOG_PREFIX} Connecting to ${this.hubUrl}`);
    const transport = createGrpcTransport({ baseUrl: this.hubUrl, httpVersion: "2" });
    const client = createClient(HubService, transport) as unknown as ProviderClient;

    const ac = new AbortController();
    this.abortController = ac;

    const queue = new AsyncMessageQueue<ProviderMessage>();
    const heartbeat = setInterval(() => {
      if (ac.signal.aborted) return;
      try {
        queue.push(create(ProviderMessageSchema, {
          payload: { case: "ping", value: create(HeartbeatSchema, { sentAtUnixMs: BigInt(Date.now()) }) },
        }));
      } catch {}
    }, HEARTBEAT_INTERVAL_MS);

    let registerAccepted = false;
    const registerTimeout = setTimeout(() => {
      if (registerAccepted || ac.signal.aborted) return;
      ac.abort();
    }, REGISTER_TIMEOUT_MS);

    try {
      const callOpts = this.getCallOptions(ac.signal);
      const stream = client.providerStream(queue, callOpts);

      // Send register message — only the browser clip (site adapters
      // have been migrated to standalone Bun Clips).
      const { browserClip } = buildClipRegistrations();
      queue.push(create(ProviderMessageSchema, {
        payload: {
          case: "register",
          value: create(RegisterRequestSchema, {
            providerName: PROVIDER_NAME,
            clips: [browserClip],
          }),
        },
      }));

      for await (const msg of stream) {
        if (ac.signal.aborted && this.stopped) return;
        switch (msg.payload.case) {
          case "registerResponse": {
            clearTimeout(registerTimeout);
            if (!msg.payload.value.accepted) {
              throw new Error(msg.payload.value.message || "Registration rejected");
            }
            registerAccepted = true;
            this.clearReconnect();
            console.error(`${LOG_PREFIX} Registered browser clip (${BROWSER_COMMAND_NAMES.length} commands) at ${this.hubUrl}`);
            break;
          }
          case "invokeCommand": {
            void this.handleInvoke(queue, msg.payload.value);
            break;
          }
          case "invokeInput": break;
          case "pong": break;
          case "getClipWebCommand": {
            void this.handleGetClipWeb(queue, msg.payload.value);
            break;
          }
          default: break;
        }
      }
      throw new Error("Provider stream closed");
    } catch (err) {
      if (this.stopped) return;
      throw err;
    } finally {
      clearInterval(heartbeat);
      clearTimeout(registerTimeout);
      queue.close();
      if (this.abortController === ac) this.abortController = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Invoke handling — calls dispatchRequest() directly (no HTTP round-trip)
  // ---------------------------------------------------------------------------

  private async handleInvoke(queue: AsyncMessageQueue<ProviderMessage>, inv: InvokeCommand): Promise<void> {
    const requestId = inv.requestId?.trim();
    if (!requestId) return;

    try {
      const clipName = inv.clipName?.trim() || "";
      const command = inv.command?.trim() || "";
      const input = decodeInput(inv.input);
      let result: unknown;

      // stream.* commands → streamer sidecar (Protocol 2: /command)
      // Streamer returns {result: {...}} — unwrap to pass the inner result to Hub.
      if (clipName === BROWSER_CLIP_ALIAS && command === "stream.start") {
        await ensureStreamer();
        const cdpUrl = await this.getCurrentTabCdpUrl();
        const resp = await streamerCommand("/command", {
          method: "connect",
          params: { cdpUrl },
        }) as any;
        result = resp?.result ?? resp;
      } else if (clipName === BROWSER_CLIP_ALIAS && command === "stream.answer") {
        const resp = await streamerCommand("/command", {
          method: "answer",
          params: input,
        }) as any;
        result = resp?.result ?? resp;
      } else if (clipName === BROWSER_CLIP_ALIAS && command === "stream.close") {
        if (!streamerProcess || streamerProcess.killed) {
          result = { ok: true };
        } else {
          const resp = await streamerCommand("/command", {
            method: "stop",
          }) as any;
          result = resp?.result ?? resp;
        }
      } else if (clipName === BROWSER_CLIP_ALIAS && command === "stream.switch") {
        const tabRef = (input as Record<string, unknown>).tab;
        if (!tabRef) throw new Error("Missing tab parameter");
        const cdpUrl = await this.getTabCdpUrl(String(tabRef));
        const resp = await streamerCommand("/command", {
          method: "switch",
          params: { cdpUrl },
        }) as any;
        result = resp?.result ?? resp;
      } else if (clipName === BROWSER_CLIP_ALIAS) {
        // Browser commands — dispatch directly via CDP (no HTTP round-trip!)
        result = await this.executeBrowserCommand(command, input);
      } else {
        throw new Error(`Unknown clip: ${clipName}`);
      }

      this.send(queue, requestId, encodeOutput(result), undefined);
    } catch (err) {
      this.send(queue, requestId, undefined, err);
    }
  }

  /**
   * Build the CDP WebSocket URL for the current (or first) page target.
   * Used by stream.start to tell the streamer which tab to connect to.
   */
  private async getCurrentTabCdpUrl(): Promise<string> {
    if (!this.cdp.connected) {
      await Promise.race([
        this.cdp.waitUntilReady(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("CDP connection timeout")), COMMAND_TIMEOUT),
        ),
      ]);
    }
    const targets = await this.cdp.getTargets();
    const current = this.cdp.currentTargetId
      ? targets.find((t) => t.id === this.cdp.currentTargetId && t.type === "page")
      : undefined;
    const page = current ?? targets.find((t) => t.type === "page");
    if (!page) throw new Error("No page target found for streamer");
    return `ws://${this.cdp.host}:${this.cdp.port}/devtools/page/${page.id}`;
  }

  /**
   * Resolve a short tab ID to a CDP WebSocket URL.
   * Used by stream.switch to tell the streamer which tab to connect to.
   */
  private async getTabCdpUrl(tabRef: string): Promise<string> {
    if (!this.cdp.connected) {
      await Promise.race([
        this.cdp.waitUntilReady(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("CDP connection timeout")), COMMAND_TIMEOUT),
        ),
      ]);
    }
    // Resolve short ID to full target ID
    const resolvedId = this.cdp.tabManager.resolveShortId(tabRef);
    const targetId = resolvedId || tabRef;
    const targets = await this.cdp.getTargets();
    const page = targets.find((t) => t.id === targetId && t.type === "page");
    if (!page) throw new Error(`Tab not found: ${tabRef}`);
    return `ws://${this.cdp.host}:${this.cdp.port}/devtools/page/${page.id}`;
  }

  /**
   * Execute a browser command by calling dispatchRequest() directly.
   * This is the key improvement over the standalone provider which
   * had to HTTP POST to the daemon.
   */
  private async executeBrowserCommand(cmdName: string, input: InputObject): Promise<unknown> {
    const cmd = BROWSER_COMMANDS.find((c) => c.method === cmdName);
    if (!cmd) throw new Error(`Unknown browser command: ${cmdName}`);

    // Wait for CDP to be ready
    if (!this.cdp.connected) {
      await Promise.race([
        this.cdp.waitUntilReady(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("CDP connection timeout")), COMMAND_TIMEOUT),
        ),
      ]);
    }

    const { tab, ...rest } = input;
    const request: Request = {
      method: cmd.method as Request["method"],
      ...rest,
      ...(tab !== undefined ? { tabId: tab } : {}),
    } as Request;

    const response = await dispatchRequest(this.cdp, request);
    if (response.error) throw new Error(response.error.message || "Command failed");
    return response.result ?? {};
  }


  // ---------------------------------------------------------------------------
  // GetClipWeb handling — serve files from web/ directory
  // ---------------------------------------------------------------------------

  private async handleGetClipWeb(queue: AsyncMessageQueue<ProviderMessage>, cmd: GetClipWebCommand): Promise<void> {
    const requestId = cmd.requestId?.trim();
    if (!requestId) return;

    try {
      let filePath = cmd.path?.trim() || "";
      if (!filePath || filePath === "/" || filePath === "index.html") filePath = "view.html";
      if (filePath.startsWith("/")) filePath = filePath.slice(1);

      if (filePath.includes("..") || filePath.startsWith("/")) {
        throw new Error("Invalid path");
      }

      // Resolve web/ directory relative to this file
      const currentDir = dirname(fileURLToPath(import.meta.url));
      // Dev: packages/daemon/src/ -> ../../../web
      // Built (package): packages/daemon/dist/ -> ../../../web
      // Release bundle: dist/ -> ../web
      const webDirCandidates = [
        resolve(currentDir, "../../../web"),
        resolve(currentDir, "../../web"),
        resolve(currentDir, "../web"),
      ];
      let webDir: string | null = null;
      for (const candidate of webDirCandidates) {
        if (existsSync(candidate)) {
          webDir = candidate;
          break;
        }
      }
      if (!webDir) throw new Error("web directory not found");

      const fullPath = join(webDir, filePath);
      const resolvedFull = resolve(fullPath);
      const resolvedWeb = resolve(webDir);
      if (!resolvedFull.startsWith(resolvedWeb)) {
        throw new Error("Invalid path");
      }

      const content = await readFileAsync(fullPath);

      const ext = extname(filePath).toLowerCase();
      const MIME_MAP: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".mjs": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".ico": "image/x-icon",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".ttf": "font/ttf",
      };
      const contentType = MIME_MAP[ext] || "application/octet-stream";
      const etag = `"${content.length.toString(16)}"`;

      if (cmd.ifNoneMatch && cmd.ifNoneMatch === etag) {
        queue.push(create(ProviderMessageSchema, {
          payload: {
            case: "getClipWebResult",
            value: create(GetClipWebResultSchema, {
              requestId,
              notModified: true,
              etag,
              totalSize: BigInt(content.length),
            }),
          },
        }));
        return;
      }

      const offset = Number(cmd.offset || 0n);
      const length = Number(cmd.length || 0n);
      let slice: Uint8Array;
      if (length > 0) {
        slice = new Uint8Array(content.buffer, content.byteOffset + offset, Math.min(length, content.length - offset));
      } else if (offset > 0) {
        slice = new Uint8Array(content.buffer, content.byteOffset + offset);
      } else {
        slice = new Uint8Array(content);
      }

      queue.push(create(ProviderMessageSchema, {
        payload: {
          case: "getClipWebResult",
          value: create(GetClipWebResultSchema, {
            requestId,
            content: slice,
            contentType,
            etag,
            totalSize: BigInt(content.length),
          }),
        },
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message === "Invalid path" ? "invalid_argument" : "not_found";
      queue.push(create(ProviderMessageSchema, {
        payload: {
          case: "getClipWebResult",
          value: create(GetClipWebResultSchema, {
            requestId,
            error: create(HubErrorSchema, { code, message }),
          }),
        },
      }));
    }
  }

  // ---------------------------------------------------------------------------
  // Result senders
  // ---------------------------------------------------------------------------

  private send(queue: AsyncMessageQueue<ProviderMessage>, requestId: string, output: Uint8Array | undefined, error: unknown): void {
    try {
      const hubError = error
        ? create(HubErrorSchema, { code: "internal", message: error instanceof Error ? error.message : String(error) })
        : undefined;
      queue.push(create(ProviderMessageSchema, {
        payload: {
          case: "invokeResult",
          value: create(InvokeResultSchema, { requestId, output, error: hubError, done: true }),
        },
      }));
    } catch (e) {
      if (!this.stopped) console.error(`${LOG_PREFIX} Failed to send result: ${e instanceof Error ? e.message : e}`);
    }
  }

  private getCallOptions(signal: AbortSignal): CallOptions {
    const token = this.hubToken || process.env.PINIX_HUB_TOKEN?.trim() || process.env.PINIX_TOKEN?.trim();
    const opts: CallOptions = { signal, timeoutMs: 0 };
    if (token) opts.headers = { Authorization: `Bearer ${token}` };
    return opts;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    console.error(`${LOG_PREFIX} Reconnecting in ${RECONNECT_DELAY_MS}ms`);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, RECONNECT_DELAY_MS);
  }

  private clearReconnect(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

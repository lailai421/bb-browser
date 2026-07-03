import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

type SpawnedMcp = {
  child: ChildProcessWithoutNullStreams;
  messages: JsonRpcMessage[];
  rawStdout: string[];
  stdoutWaiters: Array<() => void>;
};

type FakeDaemon = {
  server: Server;
  port: number;
  requests: Array<Record<string, unknown>>;
};

type FakeCdpServer = {
  closeBrowser: () => Promise<void>;
  stop: () => Promise<void>;
};

const rootDir = path.resolve(import.meta.dirname, "../../..");
const cliEntry = path.resolve(rootDir, "dist/cli.js");
const mcpEntry = path.resolve(rootDir, "packages/mcp/dist/index.js");

const children = new Set<ChildProcessWithoutNullStreams>();
const fakeDaemons = new Set<Server>();
const fakeCdps = new Set<FakeCdpServer>();
const tempDirs = new Set<string>();

function createLineCollector(child: ChildProcessWithoutNullStreams, target: SpawnedMcp): void {
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      target.rawStdout.push(line);
      try {
        target.messages.push(JSON.parse(line) as JsonRpcMessage);
      } catch {
        // Non-JSON stdout is captured separately for assertions.
      }
      const waiter = target.stdoutWaiters.shift();
      waiter?.();
    }
  });
}

function spawnMcp(args: string[], env?: NodeJS.ProcessEnv): SpawnedMcp {
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  children.add(child);

  const target: SpawnedMcp = {
    child,
    messages: [],
    rawStdout: [],
    stdoutWaiters: [],
  };

  createLineCollector(child, target);
  return target;
}

async function waitForMessage(
  target: SpawnedMcp,
  predicate: (message: JsonRpcMessage) => boolean,
  timeoutMs = 5000,
): Promise<JsonRpcMessage> {
  const existing = target.messages.find(predicate);
  if (existing) {
    return existing;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        const index = target.stdoutWaiters.indexOf(resolvePromise);
        if (index >= 0) {
          target.stdoutWaiters.splice(index, 1);
        }
        reject(new Error("Timed out waiting for MCP stdout"));
      }, Math.min(200, deadline - Date.now()));
      target.stdoutWaiters.push(() => {
        clearTimeout(timer);
        resolvePromise();
      });
    }).catch(() => undefined);

    const message = target.messages.find(predicate);
    if (message) {
      return message;
    }
  }

  throw new Error("Timed out waiting for MCP message");
}

function sendMessage(target: SpawnedMcp, message: JsonRpcMessage): void {
  target.child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function callTool(
  target: SpawnedMcp,
  id: number,
  name: string,
  args: Record<string, unknown> = {},
): Promise<JsonRpcMessage> {
  sendMessage(target, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
    },
  });

  return waitForMessage(
    target,
    (message) => message.id === id && (message.result !== undefined || message.error !== undefined),
  );
}

function createBbBrowserHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bb-browser-mcp-test-"));
  tempDirs.add(dir);
  return dir;
}

function writeDaemonJson(
  bbBrowserHome: string,
  info: { host: string; port: number; token: string; pid?: number },
): void {
  mkdirSync(bbBrowserHome, { recursive: true });
  writeFileSync(
    path.join(bbBrowserHome, "daemon.json"),
    JSON.stringify({
      pid: info.pid ?? process.pid,
      host: info.host,
      port: info.port,
      token: info.token,
    }),
    "utf8",
  );
}

function writeManagedPortFile(bbBrowserHome: string, port: number): void {
  const browserDir = path.join(bbBrowserHome, "browser");
  mkdirSync(browserDir, { recursive: true });
  writeFileSync(path.join(browserDir, "cdp-port"), String(port), "utf8");
}

function writeSiteAdapter(
  bbBrowserHome: string,
  name: string,
  meta: Record<string, unknown>,
  body = "async (_args) => ({ ok: true })",
): void {
  const parts = name.split("/");
  const fileName = `${parts.pop()}.js`;
  const dir = path.join(bbBrowserHome, "sites", ...parts);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, fileName),
    `/* @meta\n${JSON.stringify(meta, null, 2)}\n*/\n${body}\n`,
    "utf8",
  );
}

function readDaemonJsonFromHome(
  bbBrowserHome: string,
): { pid: number; host: string; port: number; token: string } | null {
  try {
    return JSON.parse(readFileSync(path.join(bbBrowserHome, "daemon.json"), "utf8"));
  } catch {
    return null;
  }
}

async function waitForDaemonJsonDeleted(
  bbBrowserHome: string,
  timeoutMs = 8000,
): Promise<void> {
  const daemonJson = path.join(bbBrowserHome, "daemon.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(daemonJson)) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("daemon.json not deleted in time");
}

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate TCP port")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function startFakeCdpServer(port: number): Promise<FakeCdpServer> {
  return new Promise((resolve, reject) => {
    const targets = new Map<string, { targetId: string; type: string; title: string; url: string }>();
    targets.set("TARGET_1", {
      targetId: "TARGET_1",
      type: "page",
      title: "about:blank",
      url: "about:blank",
    });
    const sessionToTarget = new Map<string, string>();
    let nextTargetId = 2;
    let nextSessionId = 1;
    let closed = false;

    const server = createServer((req, res) => {
      if (req.url === "/json/version" && req.method === "GET") {
        sendJson(res, 200, {
          Browser: "FakeChrome/1.0",
          "Protocol-Version": "1.3",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`,
        });
        return;
      }

      if ((req.url === "/json/list" || req.url === "/json") && req.method === "GET") {
        sendJson(res, 200, Array.from(targets.values()));
        return;
      }

      sendJson(res, 404, { error: { message: "Not found" } });
    });

    const wsServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      if (req.url !== "/devtools/browser/fake") {
        socket.destroy();
        return;
      }
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        wsServer.emit("connection", ws, req);
      });
    });

    wsServer.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
          sessionId?: string;
        };
        const reply = (result: Record<string, unknown>, sessionId?: string) => {
          ws.send(JSON.stringify({
            id: message.id,
            ...(sessionId ? { sessionId } : {}),
            result,
          }));
        };

        if (message.sessionId) {
          const targetId = sessionToTarget.get(message.sessionId);
          if (message.method === "Page.navigate" && targetId) {
            const target = targets.get(targetId);
            const url = String(message.params?.url ?? target?.url ?? "about:blank");
            if (target) {
              target.url = url;
              target.title = url;
            }
          }
          reply({}, message.sessionId);
          return;
        }

        switch (message.method) {
          case "Target.setDiscoverTargets":
            reply({});
            return;
          case "Target.getTargets":
            reply({ targetInfos: Array.from(targets.values()) });
            return;
          case "Target.attachToTarget": {
            const targetId = String(message.params?.targetId ?? "");
            const sessionId = `session-${nextSessionId++}`;
            sessionToTarget.set(sessionId, targetId);
            reply({ sessionId });
            return;
          }
          case "Target.createTarget": {
            const targetId = `TARGET_${nextTargetId++}`;
            const url = String(message.params?.url ?? "about:blank");
            targets.set(targetId, {
              targetId,
              type: "page",
              title: url,
              url,
            });
            reply({ targetId });
            return;
          }
          case "Target.closeTarget": {
            const targetId = String(message.params?.targetId ?? "");
            targets.delete(targetId);
            reply({ success: true });
            return;
          }
          case "Browser.getVersion":
            reply({ product: "Chrome/149.0.0.0" });
            return;
          default:
            reply({});
        }
      });
    });

    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const fake: FakeCdpServer = {
        closeBrowser: async () => {
          if (closed) {
            return;
          }
          closed = true;
          for (const client of wsServer.clients) {
            client.close();
          }
          await new Promise<void>((resolveClose) => {
            wsServer.close(() => resolveClose());
          });
          await new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          });
        },
        stop: async () => {
          if (closed) {
            return;
          }
          closed = true;
          for (const client of wsServer.clients) {
            client.close();
          }
          await new Promise<void>((resolveClose) => {
            wsServer.close(() => resolveClose());
          });
          await new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          });
        },
      };
      fakeCdps.add(fake);
      resolve(fake);
    });
  });
}

async function startFakeDaemon(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    body: Record<string, unknown>,
    requests: Array<Record<string, unknown>>,
  ) => void | Promise<void>,
): Promise<FakeDaemon> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/status" && req.method === "GET") {
      sendJson(res, 200, { running: true, cdpConnected: true, tabs: [] });
      return;
    }

    if (req.url === "/command" && req.method === "POST") {
      const body = await readJsonBody(req);
      requests.push(body);
      await handler(req, res, body, requests);
      return;
    }

    sendJson(res, 404, { error: { message: "Not found" } });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  fakeDaemons.add(server);

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve fake daemon port");
  }

  return {
    server,
    port: address.port,
    requests,
  };
}

async function initializeAndListTools(target: SpawnedMcp): Promise<JsonRpcMessage> {
  sendMessage(target, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "bb-browser-test", version: "1.0.0" },
    },
  });

  const initializeResponse = await waitForMessage(
    target,
    (message) => message.id === 1 && message.result !== undefined,
  );

  sendMessage(target, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });

  sendMessage(target, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });

  const toolsResponse = await waitForMessage(
    target,
    (message) => message.id === 2 && message.result !== undefined,
  );

  assert.equal(initializeResponse.jsonrpc, "2.0");
  return toolsResponse;
}

async function closeStdinAndWait(target: SpawnedMcp, timeoutMs = 5000): Promise<number | null> {
  target.child.stdin.end();
  return new Promise<number | null>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Process did not exit in time")), timeoutMs);
    target.child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });
}

afterEach(async () => {
  await Promise.all(
    Array.from(children).map(
      (child) =>
        new Promise<void>((resolvePromise) => {
          if (child.exitCode !== null) {
            children.delete(child);
            resolvePromise();
            return;
          }

          child.once("exit", () => {
            children.delete(child);
            resolvePromise();
          });
          child.kill();
        }),
    ),
  );

  await Promise.all(
    Array.from(fakeCdps).map(async (fakeCdp) => {
      await fakeCdp.stop();
      fakeCdps.delete(fakeCdp);
    }),
  );

  await Promise.all(
    Array.from(fakeDaemons).map(
      (server) =>
        new Promise<void>((resolvePromise) => {
          server.close(() => {
            fakeDaemons.delete(server);
            resolvePromise();
          });
        }),
    ),
  );

  for (const dir of Array.from(tempDirs)) {
    const daemonInfo = readDaemonJsonFromHome(dir);
    if (daemonInfo && daemonInfo.pid !== process.pid) {
      try {
        process.kill(daemonInfo.pid, "SIGKILL");
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
    tempDirs.delete(dir);
  }
});

describe("mcp entrypoints", () => {
  it("node packages/mcp/dist/index.js stays alive, initializes, lists tools, and exits after stdin closes", async () => {
    const target = spawnMcp([mcpEntry]);
    const toolsResponse = await initializeAndListTools(target);

    const tools = (toolsResponse.result?.tools as Array<{ name: string }>) || [];
    assert.ok(tools.length > 0, "tools/list should return tools");
    assert.ok(
      tools.some((tool) => tool.name === "browser_snapshot"),
      "browser_snapshot should be registered",
    );
    assert.ok(
      target.rawStdout.every((line) => {
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      }),
      "stdout should only contain JSON-RPC messages",
    );

    const exitCode = await closeStdinAndWait(target);
    assert.equal(exitCode, 0);
  });

  it("node dist/cli.js --mcp stays alive, initializes, lists tools, and exits after stdin closes", async () => {
    const target = spawnMcp([cliEntry, "--mcp"]);
    const toolsResponse = await initializeAndListTools(target);

    const tools = (toolsResponse.result?.tools as Array<{ name: string }>) || [];
    assert.ok(tools.length > 0, "tools/list should return tools");
    assert.ok(
      tools.some((tool) => tool.name === "site_run"),
      "site_run should be registered",
    );
    assert.ok(
      target.rawStdout.every((line) => {
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      }),
      "stdout should only contain JSON-RPC messages",
    );

    const exitCode = await closeStdinAndWait(target);
    assert.equal(exitCode, 0);
  });

  it("browser_open sends method-based requests and accepts daemon result responses", async () => {
    const daemon = await startFakeDaemon(async (_req, res, body) => {
      assert.equal(body.method, "open");
      assert.equal(body.action, undefined);
      assert.equal(body.url, "https://baidu.com");
      sendJson(res, 200, {
        result: {
          url: "https://baidu.com",
          tabId: "TARGET_1",
          tab: "6f3f",
          seq: 1,
        },
      });
    });
    const bbBrowserHome = createBbBrowserHome();
    writeDaemonJson(bbBrowserHome, {
      host: "127.0.0.1",
      port: daemon.port,
      token: "test-token",
    });

    const target = spawnMcp([mcpEntry], { BB_BROWSER_HOME: bbBrowserHome });
    await initializeAndListTools(target);

    const response = await callTool(target, 3, "browser_open", {
      url: "https://baidu.com",
    });

    assert.equal(response.error, undefined);
    const content = response.result?.content as Array<{ type: string; text?: string }> | undefined;
    assert.ok(content?.[0]?.text?.includes("\"tab\": \"6f3f\""));

    const exitCode = await closeStdinAndWait(target);
    assert.equal(exitCode, 0);
  });

  it("browser_open recovers in the same MCP session after the managed browser is closed", async () => {
    const bbBrowserHome = createBbBrowserHome();
    const daemonPort = await allocatePort();
    const firstPort = await allocatePort();
    writeManagedPortFile(bbBrowserHome, firstPort);
    const firstCdp = await startFakeCdpServer(firstPort);

    const target = spawnMcp([mcpEntry], {
      BB_BROWSER_HOME: bbBrowserHome,
      BB_BROWSER_DAEMON_PORT: String(daemonPort),
    });
    await initializeAndListTools(target);

    const firstOpen = await callTool(target, 3, "browser_open", {
      url: "https://example.com/first",
    });
    assert.equal(firstOpen.error, undefined);

    const firstDaemon = readDaemonJsonFromHome(bbBrowserHome);
    assert.ok(firstDaemon, "first daemon should have been created");

    await firstCdp.closeBrowser();
    fakeCdps.delete(firstCdp);
    await waitForDaemonJsonDeleted(bbBrowserHome);

    const secondPort = await allocatePort();
    writeManagedPortFile(bbBrowserHome, secondPort);
    await startFakeCdpServer(secondPort);

    const secondOpen = await callTool(target, 4, "browser_open", {
      url: "https://example.com/second",
    });
    assert.equal(secondOpen.error, undefined);

    const secondDaemon = readDaemonJsonFromHome(bbBrowserHome);
    assert.ok(secondDaemon, "second daemon should have been recreated");
    assert.notEqual(secondDaemon!.pid, firstDaemon!.pid, "daemon pid should change after recovery");

    const content = secondOpen.result?.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.[0]?.text ?? "";
    assert.ok(!text.includes("Chrome is not connected to the daemon"));
    assert.ok(text.includes("\"url\": \"https://example.com/second\""));

    const exitCode = await closeStdinAndWait(target);
    assert.equal(exitCode, 0);
  });

  it("browser_close_all uses close method for tracked tabs", async () => {
    const daemon = await startFakeDaemon(async (_req, res, body, requests) => {
      if (body.method === "open") {
        sendJson(res, 200, {
          result: {
            url: "https://example.com",
            tabId: "TARGET_2",
            tab: "8260",
            seq: 1,
          },
        });
        return;
      }

      if (body.method === "close") {
        assert.equal(body.tabId, "TARGET_2");
        sendJson(res, 200, {
          result: {
            tab: "8260",
            seq: requests.length,
          },
        });
        return;
      }

      sendJson(res, 400, { error: { message: `Unexpected method: ${String(body.method)}` } });
    });
    const bbBrowserHome = createBbBrowserHome();
    writeDaemonJson(bbBrowserHome, {
      host: "127.0.0.1",
      port: daemon.port,
      token: "test-token",
    });

    const target = spawnMcp([mcpEntry], { BB_BROWSER_HOME: bbBrowserHome });
    await initializeAndListTools(target);

    const openResponse = await callTool(target, 3, "browser_open", {
      url: "https://example.com",
    });
    assert.equal(openResponse.error, undefined);

    const closeAllResponse = await callTool(target, 4, "browser_close_all");
    assert.equal(closeAllResponse.error, undefined);

    const requestMethods = daemon.requests.map((request) => request.method);
    assert.deepEqual(requestMethods, ["open", "close"]);

    const closeContent = closeAllResponse.result?.content as Array<{ type: string; text?: string }> | undefined;
    assert.ok(closeContent?.[0]?.text?.includes("\"closedTabs\""));
    assert.ok(closeContent?.[0]?.text?.includes("\"TARGET_2\""));

    const exitCode = await closeStdinAndWait(target);
    assert.equal(exitCode, 0);
  });

  it("site_list sends a direct site_list daemon command", async () => {
    const daemon = await startFakeDaemon(async (_req, res, body) => {
      assert.equal(body.method, "site_list");
      sendJson(res, 200, {
        result: {
          sites: [
            {
              name: "twitter/search",
              description: "Search Twitter",
              domain: "twitter.com",
              source: "community",
            },
          ],
        },
      });
    });
    const bbBrowserHome = createBbBrowserHome();
    writeDaemonJson(bbBrowserHome, {
      host: "127.0.0.1",
      port: daemon.port,
      token: "test-token",
    });

    const target = spawnMcp([mcpEntry], { BB_BROWSER_HOME: bbBrowserHome });
    await initializeAndListTools(target);

    const response = await callTool(target, 3, "site_list");
    assert.equal(response.error, undefined);
    const content = response.result?.content as Array<{ type: string; text?: string }> | undefined;
    assert.ok(content?.[0]?.text?.includes("twitter/search"));
    assert.deepEqual(daemon.requests.map((request) => request.method), ["site_list"]);
  });

  it("site_search and site_info call daemon site methods directly", async () => {
    const daemon = await startFakeDaemon(async (_req, res, body) => {
      if (body.method === "site_search") {
        assert.equal(body.query, "twitter");
        sendJson(res, 200, {
          result: {
            sites: [
              {
                name: "twitter/search",
                description: "Search Twitter",
                domain: "twitter.com",
                source: "community",
              },
            ],
          },
        });
        return;
      }

      if (body.method === "site_info") {
        assert.equal(body.siteName, "twitter/search");
        sendJson(res, 200, {
          result: {
            name: "twitter/search",
            description: "Search Twitter",
            domain: "twitter.com",
            args: { query: { required: true, description: "Search query" } },
            example: "bb-browser site twitter/search ai",
            readOnly: true,
          },
        });
        return;
      }

      sendJson(res, 400, { error: { message: `Unexpected method: ${String(body.method)}` } });
    });
    const bbBrowserHome = createBbBrowserHome();
    writeDaemonJson(bbBrowserHome, {
      host: "127.0.0.1",
      port: daemon.port,
      token: "test-token",
    });

    const target = spawnMcp([mcpEntry], { BB_BROWSER_HOME: bbBrowserHome });
    await initializeAndListTools(target);

    const searchResponse = await callTool(target, 3, "site_search", { query: "twitter" });
    assert.equal(searchResponse.error, undefined);
    const infoResponse = await callTool(target, 4, "site_info", { name: "twitter/search" });
    assert.equal(infoResponse.error, undefined);

    const requestMethods = daemon.requests.map((request) => request.method);
    assert.deepEqual(requestMethods, ["site_search", "site_info"]);
  });

  it("site_run sends site_run with named siteArgs instead of shelling out CLI", async () => {
    const daemon = await startFakeDaemon(async (_req, res, body) => {
      assert.equal(body.method, "site_run");
      assert.equal(body.siteName, "twitter/search");
      assert.deepEqual(body.siteArgs, { query: "ai agents" });
      sendJson(res, 200, {
        result: {
          tab: "6f3f",
          result: {
            items: [{ title: "hello" }],
          },
        },
      });
    });
    const bbBrowserHome = createBbBrowserHome();
    writeSiteAdapter(
      bbBrowserHome,
      "twitter/search",
      {
        name: "twitter/search",
        description: "Search Twitter",
        domain: "twitter.com",
        args: {
          query: { required: true, description: "Search query" },
        },
      },
    );
    writeDaemonJson(bbBrowserHome, {
      host: "127.0.0.1",
      port: daemon.port,
      token: "test-token",
    });

    const target = spawnMcp([mcpEntry], { BB_BROWSER_HOME: bbBrowserHome });
    await initializeAndListTools(target);

    const response = await callTool(target, 3, "site_run", {
      name: "twitter/search",
      args: ["ai agents"],
    });
    assert.equal(response.error, undefined);
    const content = response.result?.content as Array<{ type: string; text?: string }> | undefined;
    assert.ok(content?.[0]?.text?.includes("\"title\": \"hello\""));
    assert.deepEqual(daemon.requests.map((request) => request.method), ["site_run"]);
  });
});

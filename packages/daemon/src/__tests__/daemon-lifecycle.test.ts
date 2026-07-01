/**
 * Daemon lifecycle integration tests — daemon.json + HTTP server.
 *
 * These tests verify the daemon.json file lifecycle WITHOUT requiring Chrome.
 * Each test uses unique ports to avoid EADDRINUSE conflicts.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Use isolated temp dir to avoid conflicts with parallel test suites
const TEST_HOME = path.join(os.tmpdir(), `bb-browser-test-lifecycle-${process.pid}`);
mkdirSync(TEST_HOME, { recursive: true });
process.env.BB_BROWSER_HOME = TEST_HOME;
const DAEMON_JSON = path.join(TEST_HOME, "daemon.json");

type FakeCdpServer = {
  closeBrowser: () => Promise<void>;
  stop: () => Promise<void>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findTsx(): string {
  const candidates = [
    path.resolve(__dirname, "../../../../node_modules/tsx/dist/cli.mjs"),
    path.resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs"),
    path.resolve(__dirname, "../../../../node_modules/.bin/tsx"),
    path.resolve(__dirname, "../../../node_modules/.bin/tsx"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "tsx";
}

function spawnTsx(args: string[], options: Parameters<typeof spawn>[2] = {}): ChildProcess {
  const tsx = findTsx();
  if (tsx.endsWith(".mjs")) {
    return spawn(process.execPath, [tsx, ...args], options);
  }
  return spawn(tsx, args, options);
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
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function nextPorts(): Promise<{ daemonPort: number; cdpPort: number }> {
  while (true) {
    const daemonPort = await allocatePort();
    const cdpPort = await allocatePort();
    if (daemonPort !== cdpPort) {
      return { daemonPort, cdpPort };
    }
  }
}

function startFakeCdp(port: number): Promise<FakeCdpServer> {
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
        const body = JSON.stringify({
          Browser: "FakeChrome/0.0",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`,
        });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
      } else {
        res.writeHead(404);
        res.end();
      }
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
    server.listen(port, "127.0.0.1", () => resolve({
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
    }));
  });
}

function spawnDaemon(port: number, cdpPort: number): ChildProcess {
  const sourceEntry = path.resolve(__dirname, "../index.ts");
  return spawnTsx(
    [sourceEntry, "--port", String(port), "--cdp-port", String(cdpPort)],
    { stdio: "pipe", env: { ...process.env } },
  );
}

async function waitForDaemonJson(timeoutMs = 8000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(DAEMON_JSON, "utf8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("daemon.json not created in time");
}

async function waitForStatus(
  host: string, port: number, token: string, timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${host}:${port}/status`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return (await res.json()) as Record<string, unknown>;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("daemon /status not reachable in time");
}

async function waitForHealthyStatus(
  host: string, port: number, token: string, timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await waitForStatus(host, port, token, 1000).catch(() => null);
    if (status?.cdpConnected === true) {
      return status;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("daemon never reported cdpConnected=true");
}

async function requestShutdown(
  host: string,
  port: number,
  token: string,
): Promise<void> {
  const response = await fetch(`http://${host}:${port}/shutdown`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.ok, true, "daemon /shutdown should return success");
}

async function waitForDaemonJsonDeleted(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(DAEMON_JSON)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("daemon.json not deleted in time");
}

async function waitForPortReleased(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      });
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`port ${port} was not released in time`);
}

function waitForChildExit(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }

    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("daemon process did not exit in time"));
    }, timeoutMs);

    child.once("exit", onExit);
  });
}

function killDaemon(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.killed || child.exitCode !== null) { resolve(); return; }
    child.on("exit", () => resolve());
    child.kill("SIGTERM");
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
    child.on("exit", () => clearTimeout(timer));
  });
}

async function cleanupDaemonJson(): Promise<void> {
  try { await unlink(DAEMON_JSON); } catch {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("daemon lifecycle (no Chrome needed)", () => {
  let daemon: ChildProcess | null = null;
  let fakeCdp: FakeCdpServer | null = null;

  afterEach(async () => {
    // Kill the actual daemon process (from daemon.json PID, not tsx wrapper PID)
    try {
      const raw = await readFile(DAEMON_JSON, "utf8");
      const info = JSON.parse(raw);
      if (info.pid) {
        try { process.kill(info.pid, "SIGKILL"); } catch {}
      }
    } catch {}

    // Also kill the tsx wrapper
    if (daemon && !daemon.killed && daemon.exitCode === null) {
      await killDaemon(daemon);
    }
    daemon = null;
    if (fakeCdp) {
      await fakeCdp.stop();
      fakeCdp = null;
    }
    await cleanupDaemonJson();
    // Wait for ports to release
    await new Promise((r) => setTimeout(r, 500));
  });

  it("writes daemon.json on startup with pid/host/port/token", async () => {
    const { daemonPort, cdpPort } = await nextPorts();
    await cleanupDaemonJson();
    fakeCdp = await startFakeCdp(cdpPort);
    daemon = spawnDaemon(daemonPort, cdpPort);

    const info = await waitForDaemonJson();

    assert.equal(typeof info.pid, "number");
    assert.equal(typeof info.host, "string");
    assert.equal(info.port, daemonPort);
    assert.equal(typeof info.token, "string");
    assert.ok((info.token as string).length > 0);
    // Note: daemon.pid is tsx wrapper PID, info.pid is the actual daemon PID
    assert.ok(info.pid as number > 0, "daemon PID should be positive");
  });

  it("GET /status returns running: true", async () => {
    const { daemonPort, cdpPort } = await nextPorts();
    await cleanupDaemonJson();
    fakeCdp = await startFakeCdp(cdpPort);
    daemon = spawnDaemon(daemonPort, cdpPort);

    const info = await waitForDaemonJson();
    const status = await waitForStatus(
      info.host as string, info.port as number, info.token as string,
    );

    assert.equal(status.running, true);
    assert.equal(typeof status.uptime, "number");
  });

  it("daemon.json is deleted on graceful shutdown (/shutdown)", async () => {
    const { daemonPort, cdpPort } = await nextPorts();
    await cleanupDaemonJson();
    fakeCdp = await startFakeCdp(cdpPort);
    daemon = spawnDaemon(daemonPort, cdpPort);
    const info = await waitForDaemonJson();

    assert.ok(existsSync(DAEMON_JSON));

    await requestShutdown(info.host as string, info.port as number, info.token as string);
    await waitForChildExit(daemon);
    daemon = null;
    await waitForDaemonJsonDeleted();

    assert.ok(!existsSync(DAEMON_JSON), "daemon.json should be deleted after graceful shutdown");
  });

  it("browser-level CDP close makes daemon self-clean and exit", async () => {
    const { daemonPort, cdpPort } = await nextPorts();
    await cleanupDaemonJson();
    fakeCdp = await startFakeCdp(cdpPort);
    daemon = spawnDaemon(daemonPort, cdpPort);

    const info = await waitForDaemonJson();
    await waitForHealthyStatus(
      info.host as string,
      info.port as number,
      info.token as string,
    );

    await fakeCdp.closeBrowser();
    fakeCdp = null;

    await waitForChildExit(daemon, 8000);
    daemon = null;
    await waitForDaemonJsonDeleted(8000);
    await waitForPortReleased(info.port as number, 8000);

    assert.ok(!existsSync(DAEMON_JSON), "daemon.json should be deleted after CDP disconnect");
  });

  it("stale daemon.json survives kill -9", async () => {
    const { daemonPort, cdpPort } = await nextPorts();
    await cleanupDaemonJson();
    fakeCdp = await startFakeCdp(cdpPort);
    daemon = spawnDaemon(daemonPort, cdpPort);
    const info = await waitForDaemonJson();
    const oldPid = info.pid;

    // Kill the actual daemon PID (not tsx wrapper)
    try { process.kill(oldPid as number, "SIGKILL"); } catch {}
    daemon.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 1000));
    daemon = null;

    assert.ok(existsSync(DAEMON_JSON), "daemon.json should survive SIGKILL");
    const staleInfo = JSON.parse(await readFile(DAEMON_JSON, "utf8"));
    assert.equal(staleInfo.pid, oldPid);
  });

  it("new daemon after kill -9 gets new PID and token", async () => {
    const ports1 = await nextPorts();
    const ports2 = await nextPorts(); // completely separate ports for second daemon
    await cleanupDaemonJson();
    fakeCdp = await startFakeCdp(ports1.cdpPort);

    // First daemon
    daemon = spawnDaemon(ports1.daemonPort, ports1.cdpPort);
    const info1 = await waitForDaemonJson();
    const pid1 = info1.pid;
    const token1 = info1.token;

    // Force kill the actual daemon process
    try { process.kill(pid1 as number, "SIGKILL"); } catch {}
    daemon.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 1500));
    daemon = null;

    assert.ok(existsSync(DAEMON_JSON));

    // Stop old fake CDP server and wait for port release
    await fakeCdp.stop();
    await new Promise((r) => setTimeout(r, 500));

    // Start new fake CDP on different port
    fakeCdp = await startFakeCdp(ports2.cdpPort);

    // Delete stale daemon.json so waitForDaemonJson detects the NEW one
    await cleanupDaemonJson();

    // Second daemon on completely new ports
    daemon = spawnDaemon(ports2.daemonPort, ports2.cdpPort);
    const info2 = await waitForDaemonJson();

    assert.notEqual(info2.pid, pid1, "new daemon should have different PID");
    assert.notEqual(info2.token, token1, "new daemon should have different token");
    assert.equal(info2.port, ports2.daemonPort);
  });
});

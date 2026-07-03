import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { resolveBbBrowserHomeDir } from "@bb-browser/shared";

const children = new Set<ChildProcess>();
const servers = new Set<Server>();
const tempDirs = new Set<string>();

function findTsx(): string {
  const candidates = [
    path.resolve(import.meta.dirname, "../../../../node_modules/tsx/dist/cli.mjs"),
    path.resolve(import.meta.dirname, "../../../../node_modules/.bin/tsx"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
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
  return await new Promise((resolve, reject) => {
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

async function startFakeCdpServer(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url === "/json/version" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        Browser: "Chrome/123.0.0.0",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/fake",
      }));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, "127.0.0.1", (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  servers.add(server);
  return server;
}

async function waitForFile(filePath: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`file not created in time: ${filePath}`);
}

afterEach(async () => {
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  children.clear();

  await Promise.all(
    Array.from(servers, (server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })),
  );
  servers.clear();

  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("bb-browser home resolution", () => {
  it("falls back to temp when preferred directories are not writable", () => {
    const tempRoot = path.join(os.tmpdir(), `bb-browser-home-unit-${process.pid}`);
    const expected = path.resolve(tempRoot, "bb-browser");

    const actual = resolveBbBrowserHomeDir({
      envHome: path.join(tempRoot, "env-home"),
      homeDir: path.join(tempRoot, "user-home", ".bb-browser"),
      tempRoot,
      isWritable: (dir) => dir === expected,
    });

    assert.equal(actual, expected);
  });

  it("daemon writes daemon.json into temp fallback when home is unusable", async () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "bb-browser-home-it-"));
    tempDirs.add(rootDir);

    const fakeHomeFile = path.join(rootDir, "fake-home.txt");
    writeFileSync(fakeHomeFile, "not-a-directory");

    const tempRoot = path.join(rootDir, "tmp-root");
    mkdirSync(tempRoot, { recursive: true });

    const daemonPort = await allocatePort();
    const cdpPort = await allocatePort();
    await startFakeCdpServer(cdpPort);

    const daemonEntry = path.resolve(import.meta.dirname, "../index.ts");
    const fallbackDaemonJson = path.join(tempRoot, "bb-browser", "daemon.json");

    const child = spawnTsx(
      [
        daemonEntry,
        "--host",
        "127.0.0.1",
        "--port",
        String(daemonPort),
        "--cdp-port",
        String(cdpPort),
      ],
      {
        env: {
          ...process.env,
          BB_BROWSER_HOME: "",
          HOME: fakeHomeFile,
          USERPROFILE: fakeHomeFile,
          TEMP: tempRoot,
          TMP: tempRoot,
        },
        stdio: "ignore",
      },
    );
    children.add(child);

    await waitForFile(fallbackDaemonJson);

    const daemonInfo = JSON.parse(readFileSync(fallbackDaemonJson, "utf8")) as {
      host: string;
      port: number;
      cdpPort: number;
    };

    assert.equal(daemonInfo.host, "127.0.0.1");
    assert.equal(daemonInfo.port, daemonPort);
    assert.equal(daemonInfo.cdpPort, cdpPort);
  });
});

import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  entry: {
    index: "src/index.ts",
    daemon: "../daemon/src/index.ts",
  },
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  target: "node18",
  banner: {
    js: "#!/usr/bin/env node",
  },
  define: {
    __BB_BROWSER_VERSION__: JSON.stringify(packageJson.version),
  },
  noExternal: [/^(?!ws$).*/],
  external: ["ws"],
});

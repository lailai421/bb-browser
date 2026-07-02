import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(currentDir, "..");
const source = path.resolve(packageDir, "../shared/buildDomTree.js");
const outDir = path.resolve(packageDir, "dist");
const target = path.resolve(outDir, "buildDomTree.js");

mkdirSync(outDir, { recursive: true });
copyFileSync(source, target);

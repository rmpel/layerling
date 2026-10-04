import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The desktop app for development: the dev server with hot reload, shown in
// the Electron shell instead of a browser. The packaged app is built by
// scripts/build-desktop.mjs.

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const electronBinary = require("electron");
const port = process.env.LAYERLING_DESKTOP_DEV_PORT ?? "47616";
const url = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, [nextBin, "dev", "apps/web", "--port", port, "--hostname", "127.0.0.1"], {
  cwd: repositoryRoot,
  stdio: "inherit",
  env: { ...process.env, LAYERLING_DESKTOP_DEV: "true" },
});

async function waitForServer() {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`The dev server at ${url} did not start.`);
}

function stop(code) {
  server.kill();
  process.exit(code);
}

server.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

await waitForServer();
const shell = spawn(electronBinary, [...process.argv.slice(2), join(repositoryRoot, "apps", "desktop")], {
  cwd: repositoryRoot,
  stdio: "inherit",
  env: { ...process.env, LAYERLING_DESKTOP_URL: url },
});
shell.on("exit", (code) => stop(code ?? 0));

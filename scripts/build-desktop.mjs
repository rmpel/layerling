import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Builds the desktop app for one target:
//
//   node scripts/build-desktop.mjs mac-arm64
//   node scripts/build-desktop.mjs win-x64 --dir     (unpacked folder only, no installer)
//
// Without a target it builds for the machine it runs on. The result lands in
// dist-desktop/. The app carries the web app as a self-contained server
// (Next's "standalone" output) and shows it in an Electron window; see
// apps/desktop/main.cjs for what the shell adds.
//
// Everything is started as `node <entry point>` for the same reason as in
// build-static-export.mjs: npm and npx are batch files on Windows.

const TARGETS = {
  "mac-arm64": { platform: "MAC", arch: "arm64", formats: ["dmg", "zip"] },
  "mac-x64": { platform: "MAC", arch: "x64", formats: ["dmg", "zip"] },
  "linux-x64": { platform: "LINUX", arch: "x64", formats: ["AppImage", "tar.gz"] },
  "linux-arm64": { platform: "LINUX", arch: "arm64", formats: ["AppImage", "tar.gz"] },
  "win-x64": { platform: "WINDOWS", arch: "x64", formats: ["nsis", "zip"] },
  "win-arm64": { platform: "WINDOWS", arch: "arm64", formats: ["nsis", "zip"] },
};

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

const args = process.argv.slice(2);
const dirOnly = args.includes("--dir");
const skipWebBuild = args.includes("--skip-web-build");
const hostTarget = `${{ darwin: "mac", win32: "win", linux: "linux" }[process.platform]}-${process.arch}`;
const targetName = args.find((argument) => !argument.startsWith("-")) ?? hostTarget;
const target = TARGETS[targetName];
if (!target) {
  console.error(`Unknown target "${targetName}". Known targets: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}

function run(commandArgs, extraEnvironment = {}) {
  const result = spawnSync(process.execPath, commandArgs, {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: { ...process.env, ...extraEnvironment },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// 1. The web app as a server that needs nothing but Node - which Electron brings.
const webDir = join(repositoryRoot, "apps", "web");
const standaloneDir = join(webDir, ".next-desktop", "standalone");
if (!skipWebBuild) {
  run(["scripts/copy-occt-wasm.mjs"]);
  run(["scripts/build-guide.mjs"]);
  run([nextBin, "build", "apps/web"], { DESKTOP_BUILD: "true" });
}
if (!existsSync(join(standaloneDir, "apps", "web", "server.js"))) {
  console.error("The standalone server is missing; run without --skip-web-build.");
  process.exit(1);
}

// 2. Next leaves the static files out of the standalone folder; put them where its server looks.
const serverStage = join(repositoryRoot, "apps", "desktop", ".build", "server");
rmSync(serverStage, { recursive: true, force: true });
mkdirSync(dirname(serverStage), { recursive: true });
cpSync(standaloneDir, serverStage, { recursive: true, dereference: true });
cpSync(join(webDir, "public"), join(serverStage, "apps", "web", "public"), { recursive: true, dereference: true });
cpSync(join(webDir, ".next-desktop", "static"), join(serverStage, "apps", "web", ".next-desktop", "static"), { recursive: true });
// sharp only serves Next's image optimizer, which the app has switched off. It
// is the one native module in the server; without it the same server runs on
// every target, whichever machine built it.
for (const nativeOnly of ["sharp", "@img"]) {
  rmSync(join(serverStage, "node_modules", nativeOnly), { recursive: true, force: true });
}

// 3. The app itself.
const { build, Platform, Arch } = require("electron-builder");
const appVersion = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).version;
const electronVersion = JSON.parse(readFileSync(require.resolve("electron/package.json"), "utf8")).version;

await build({
  // The shell has no dependencies of its own. Pointing the packager at its
  // folder keeps it from collecting the web app's node_modules instead.
  projectDir: join(repositoryRoot, "apps", "desktop"),
  targets: Platform[target.platform].createTarget(dirOnly ? ["dir"] : target.formats, Arch[target.arch]),
  publish: "never",
  config: {
    appId: "app.layerling.desktop",
    productName: "Layerling",
    electronVersion,
    directories: {
      app: join(repositoryRoot, "apps", "desktop"),
      output: join(repositoryRoot, "dist-desktop"),
    },
    files: ["main.cjs", "preload.cjs", "storageCodec.cjs", "package.json"],
    extraMetadata: { version: appVersion },
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    artifactName: "Layerling-${version}-${os}-${arch}.${ext}",
    // No update feed: the app does not update itself.
    publish: null,
    icon: join(webDir, "public", "assets", "layerling", "layerling-icon-512.png"),
    fileAssociations: [
      { ext: "lyl", name: "Layerling Design", description: "Layerling design", role: "Editor", mimeType: "application/vnd.layerling.project+zip" },
    ],
    // The server goes in by hand: it has a node_modules folder of its own,
    // which the packager would filter if it were listed as a resource.
    afterPack: async (context) => {
      const resourcesDir = context.electronPlatformName === "darwin"
        ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
        : join(context.appOutDir, "resources");
      cpSync(serverStage, join(resourcesDir, "server"), { recursive: true });
    },
    mac: {
      category: "public.app-category.graphics-design",
      // Signed for this machine only ("ad hoc"). Handing the app to others
      // without a Gatekeeper warning takes an Apple Developer ID and notarization.
      identity: "-",
      hardenedRuntime: false,
      gatekeeperAssess: false,
    },
    linux: { category: "Graphics" },
    nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  },
});

console.log(`Desktop app for ${targetName} ready in dist-desktop/`);

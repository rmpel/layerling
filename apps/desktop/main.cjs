"use strict";

// The desktop shell. It runs the web app's own server inside the app, shows it
// in one window, and gives it what a browser cannot: designs as .lyl files on
// disk, preferences in a readable file, and a native File menu.
//
// Where things live (on a Mac under ~/Library/Application Support/Layerling):
//   settings.json   preferences, one entry per setting
//   documents.json  the designs shown on the start page and the file each belongs to
//   drafts/         changes not saved to their file yet, one .lyl per design
//   thumbnails/     the pictures on the start page

const { app, BrowserWindow, Menu, dialog, ipcMain, shell, utilityProcess } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { PROJECTS_KEY, persistable, decodeValue, encodeValue } = require("./storageCodec.cjs");

const APP_NAME = "Layerling";
/** Fixed, so the MCP bridge finds the app; another port is taken when it is busy. */
const DEFAULT_PORT = 47615;
const DOCUMENT_EXTENSIONS = [".lyl", ".skf"];
const STORAGE_FLUSH_DELAY_MS = 400;
const CLOSE_GRACE_MS = 4000;
const SERVER_START_TIMEOUT_MS = 30000;

app.setName(APP_NAME);
if (process.env.LAYERLING_DESKTOP_DATA_DIR) {
  app.setPath("userData", path.resolve(process.env.LAYERLING_DESKTOP_DATA_DIR));
}

const userDataDir = app.getPath("userData");
// Chromium's own caches go into a folder of their own, so the files that matter stay easy to find.
app.setPath("sessionData", path.join(userDataDir, "cache"));
const settingsFile = path.join(userDataDir, "settings.json");
const documentsFile = path.join(userDataDir, "documents.json");
const draftsDir = path.join(userDataDir, "drafts");
const thumbnailsDir = path.join(userDataDir, "thumbnails");

let mainWindow = null;
let serverProcess = null;
let rendererReady = false;
let closeConfirmed = false;
let closeTimer = null;
/** Files asked for before the window could take them: a double-click that started the app. */
const pendingOpenPaths = [];
/** Files the user chose, in a dialog or in Finder. Nothing else is read or written. */
const approvedPaths = new Set();
let currentDocumentPath = "";
let lastDialogDir = "";

// ---------------------------------------------------------------------------
// Files

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Writes beside the target and renames, so a crash never leaves half a file. */
function writeFileAtomicSync(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, file);
}

async function writeFileAtomic(file, data) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temporary, data);
  await fs.promises.rename(temporary, file);
}

function isDocumentPath(filePath) {
  return typeof filePath === "string" && DOCUMENT_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

function approvePath(filePath) {
  if (isDocumentPath(filePath)) approvedPaths.add(path.resolve(filePath));
}

function isApproved(filePath) {
  return isDocumentPath(filePath) && approvedPaths.has(path.resolve(filePath));
}

function draftPath(projectId) {
  const safeId = String(projectId).replace(/[^a-zA-Z0-9_-]/g, "");
  return safeId ? path.join(draftsDir, `${safeId}.lyl`) : null;
}

// ---------------------------------------------------------------------------
// Preferences and the list of designs

let settings = {};
let documents = [];
const storageDirty = { settings: false, documents: false };
let storageFlushTimer = null;

function approveListedDocuments() {
  for (const entry of documents) {
    if (entry && entry.documentFile && typeof entry.documentFile.path === "string") approvePath(entry.documentFile.path);
  }
}

function loadStorage() {
  const storedSettings = readJson(settingsFile, {});
  settings = storedSettings && typeof storedSettings === "object" && !Array.isArray(storedSettings) ? storedSettings : {};
  const storedDocuments = readJson(documentsFile, []);
  documents = Array.isArray(storedDocuments) ? storedDocuments : [];
  approveListedDocuments();
}

function storageSnapshot() {
  const snapshot = {};
  for (const [key, value] of Object.entries(settings)) {
    if (persistable(key) && key !== PROJECTS_KEY) snapshot[key] = encodeValue(value);
  }
  snapshot[PROJECTS_KEY] = JSON.stringify(documents);
  return snapshot;
}

function flushStorage() {
  if (storageFlushTimer !== null) {
    clearTimeout(storageFlushTimer);
    storageFlushTimer = null;
  }
  try {
    if (storageDirty.settings) {
      const sorted = Object.fromEntries(Object.keys(settings).sort().map((key) => [key, settings[key]]));
      writeFileAtomicSync(settingsFile, `${JSON.stringify(sorted, null, 2)}\n`);
      storageDirty.settings = false;
    }
    if (storageDirty.documents) {
      writeFileAtomicSync(documentsFile, `${JSON.stringify(documents, null, 2)}\n`);
      storageDirty.documents = false;
    }
  } catch (error) {
    console.error("Could not write Layerling settings:", error);
  }
}

function storageSet(key, value) {
  if (!persistable(key)) return;
  if (key === PROJECTS_KEY) {
    let parsed = [];
    if (value !== null) {
      try {
        parsed = JSON.parse(String(value));
      } catch {
        return;
      }
    }
    if (!Array.isArray(parsed)) return;
    documents = parsed;
    approveListedDocuments();
    storageDirty.documents = true;
  } else {
    if (value === null) delete settings[key];
    else settings[key] = decodeValue(String(value));
    storageDirty.settings = true;
  }
  if (storageFlushTimer === null) storageFlushTimer = setTimeout(flushStorage, STORAGE_FLUSH_DELAY_MS);
}

// ---------------------------------------------------------------------------
// The web app's server

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

function anyFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitForServer(url) {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });
      request.on("error", () => {
        if (Date.now() > deadline) reject(new Error("The Layerling server did not start."));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

/** Starts the bundled server and answers with its address; in development an already running one is used. */
async function startServer() {
  if (process.env.LAYERLING_DESKTOP_URL) return process.env.LAYERLING_DESKTOP_URL;
  const serverEntry = path.join(process.resourcesPath, "server", "apps", "web", "server.js");
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`The bundled server is missing (${serverEntry}). For development, start it with "npm run desktop:dev".`);
  }
  const port = (await portIsFree(DEFAULT_PORT)) ? DEFAULT_PORT : await anyFreePort();
  serverProcess = utilityProcess.fork(serverEntry, [], {
    cwd: path.dirname(serverEntry),
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      LAYERLING_THUMBNAIL_DIR: thumbnailsDir,
    },
    stdio: "ignore",
    serviceName: "Layerling server",
  });
  const url = `http://127.0.0.1:${port}`;
  await waitForServer(url);
  return url;
}

// ---------------------------------------------------------------------------
// The window

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function sendCommand(command) {
  if (rendererReady) sendToRenderer("desktop:command", command);
}

function openPathInRenderer(filePath) {
  if (!isDocumentPath(filePath)) return;
  const resolved = path.resolve(filePath);
  approvePath(resolved);
  if (rendererReady) {
    sendToRenderer("desktop:open-path", resolved);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  } else {
    pendingOpenPaths.push(resolved);
  }
}

async function showOpenDialog() {
  if (!mainWindow) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath: lastDialogDir || app.getPath("documents"),
    filters: [{ name: "Layerling designs", extensions: ["lyl", "skf"] }],
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled) return;
  for (const filePath of result.filePaths) {
    lastDialogDir = path.dirname(filePath);
    openPathInRenderer(filePath);
  }
}

function createWindow(url) {
  const appOrigin = new URL(url).origin;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: "#fbf8f0",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // No "persist:" prefix: this session lives in memory, so nothing of the
      // user's work is left in browser storage. The files above are the truth.
      partition: "layerling",
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    // The guide is part of the app and opens in a window of its own; the rest is the browser's business.
    if (target.startsWith(appOrigin)) return { action: "allow" };
    if (/^https?:|^mailto:/i.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (target.startsWith(appOrigin)) return;
    event.preventDefault();
    if (/^https?:|^mailto:/i.test(target)) void shell.openExternal(target);
  });
  mainWindow.webContents.on("did-start-navigation", (_event, _target, isInPlace, isMainFrame) => {
    // A reload starts the page over; it says so again once it listens.
    if (isMainFrame && !isInPlace) rendererReady = false;
  });
  // The page asks to stay open while a save is running. By the time the window
  // really closes it has been given the chance to finish, so let it go.
  mainWindow.webContents.on("will-prevent-unload", (event) => event.preventDefault());

  mainWindow.on("close", (event) => {
    if (closeConfirmed || !rendererReady) return;
    event.preventDefault();
    sendToRenderer("desktop:before-close");
    if (closeTimer === null) {
      closeTimer = setTimeout(() => {
        closeConfirmed = true;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
      }, CLOSE_GRACE_MS);
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(url);
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac
      ? [{
          label: APP_NAME,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        }]
      : []),
    {
      label: "File",
      submenu: [
        { id: "new", label: "New Design", accelerator: "CmdOrCtrl+N", click: () => sendCommand("new") },
        { id: "open", label: "Open…", accelerator: "CmdOrCtrl+O", click: () => void showOpenDialog() },
        ...(isMac
          ? [{ label: "Open Recent", role: "recentDocuments", submenu: [{ label: "Clear Menu", role: "clearRecentDocuments" }] }]
          : []),
        { type: "separator" },
        { id: "save", label: "Save", accelerator: "CmdOrCtrl+S", click: () => sendCommand("save") },
        { id: "save-as", label: "Save As…", accelerator: "CmdOrCtrl+Shift+S", click: () => sendCommand("save-as") },
        { id: "revert", label: "Revert to Saved", click: () => sendCommand("revert") },
        { type: "separator" },
        {
          label: isMac ? "Show in Finder" : "Show in Folder",
          click: () => {
            if (currentDocumentPath && fs.existsSync(currentDocumentPath)) shell.showItemInFolder(currentDocumentPath);
          },
        },
        { id: "home", label: "All Designs", accelerator: "CmdOrCtrl+Shift+H", click: () => sendCommand("home") },
        ...(isMac ? [] : [{ type: "separator" }, { role: "quit" }]),
      ],
    },
    {
      // No Undo/Redo here: the editor has its own history on the same keys,
      // and a menu entry would take the keystroke away from it.
      label: "Edit",
      submenu: [{ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// What the page may ask for

function registerIpc() {
  ipcMain.on("storage:load", (event) => {
    event.returnValue = storageSnapshot();
  });
  ipcMain.on("storage:set", (_event, key, value) => storageSet(key, value));

  ipcMain.on("app:ready", () => {
    rendererReady = true;
    for (const filePath of pendingOpenPaths.splice(0)) sendToRenderer("desktop:open-path", filePath);
  });
  ipcMain.on("window:close-confirmed", () => {
    closeConfirmed = true;
    if (closeTimer !== null) clearTimeout(closeTimer);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
  ipcMain.on("document:approve", (_event, filePath) => approvePath(filePath));
  ipcMain.on("window:document-state", (_event, state) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const title = state && typeof state.title === "string" ? state.title : "";
    const edited = Boolean(state && state.edited);
    currentDocumentPath = state && typeof state.path === "string" ? state.path : "";
    mainWindow.setTitle(title ? `${title}${edited ? " — Edited" : ""}` : APP_NAME);
    if (process.platform === "darwin") {
      mainWindow.setRepresentedFilename(currentDocumentPath);
      mainWindow.setDocumentEdited(edited);
    }
  });

  // A design's bytes when the window has none yet: its unsaved draft if there
  // is one, otherwise the file it belongs to.
  ipcMain.handle("project:read-source", async (_event, projectId) => {
    const draft = draftPath(projectId);
    if (draft && fs.existsSync(draft)) {
      return { bytes: await fs.promises.readFile(draft), source: "draft" };
    }
    const entry = documents.find((candidate) => candidate && candidate.id === projectId);
    const filePath = entry && entry.documentFile && entry.documentFile.path;
    if (typeof filePath === "string" && isApproved(filePath) && fs.existsSync(filePath)) {
      return { bytes: await fs.promises.readFile(filePath), source: "document" };
    }
    return null;
  });
  ipcMain.handle("draft:write", async (_event, projectId, bytes) => {
    const draft = draftPath(projectId);
    if (!draft) return false;
    await writeFileAtomic(draft, Buffer.from(bytes));
    return true;
  });
  ipcMain.handle("draft:delete", async (_event, projectId) => {
    const draft = draftPath(projectId);
    if (draft) await fs.promises.rm(draft, { force: true });
    return true;
  });
  ipcMain.handle("document:read", async (_event, filePath) => {
    if (!isApproved(filePath)) throw new Error("This file was not opened through Layerling.");
    return fs.promises.readFile(filePath);
  });
  ipcMain.handle("document:save", async (_event, request) => {
    if (!mainWindow) return null;
    let target = request && typeof request.path === "string" ? request.path : "";
    // Saving always writes the current format; an old .skf gets a new name.
    if (target && (path.extname(target).toLowerCase() !== ".lyl" || !isApproved(target))) target = "";
    if (!target) {
      const suggested = String((request && request.suggestedName) || "Untitled design")
        .replace(/\.(lyl|skf)$/i, "")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
        .trim() || "Untitled design";
      const startDir = request && typeof request.path === "string" && request.path
        ? path.dirname(request.path)
        : lastDialogDir || app.getPath("documents");
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: path.join(startDir, `${suggested}.lyl`),
        filters: [{ name: "Layerling design", extensions: ["lyl"] }],
      });
      if (result.canceled || !result.filePath) return null;
      target = path.extname(result.filePath).toLowerCase() === ".lyl" ? result.filePath : `${result.filePath}.lyl`;
      lastDialogDir = path.dirname(target);
    }
    target = path.resolve(target);
    await writeFileAtomic(target, Buffer.from(request.bytes));
    approvePath(target);
    app.addRecentDocument(target);
    return { path: target, name: path.basename(target, path.extname(target)) };
  });
}

// ---------------------------------------------------------------------------
// Start

function documentPathsFromArguments(argv) {
  return argv.slice(1).filter((argument) => !argument.startsWith("-") && isDocumentPath(argument) && fs.existsSync(argument));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // macOS hands over a double-clicked file this way, possibly before the app is ready.
  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    openPathInRenderer(filePath);
  });
  app.on("second-instance", (_event, argv) => {
    for (const filePath of documentPathsFromArguments(argv)) openPathInRenderer(filePath);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => {
    flushStorage();
    if (serverProcess) serverProcess.kill();
  });

  app.whenReady().then(async () => {
    loadStorage();
    registerIpc();
    buildMenu();
    for (const filePath of documentPathsFromArguments(process.argv)) openPathInRenderer(filePath);
    try {
      createWindow(await startServer());
    } catch (error) {
      dialog.showErrorBox(APP_NAME, error instanceof Error ? error.message : String(error));
      app.quit();
    }
  });
}

"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

// The window starts with empty browser storage every time (its session lives
// in memory only). Before the page runs, hand it the preferences and the list
// of designs from the files the app keeps them in.
try {
  const snapshot = ipcRenderer.sendSync("storage:load");
  for (const [key, value] of Object.entries(snapshot ?? {})) {
    window.localStorage.setItem(key, value);
  }
} catch {
  // Without them the app starts with defaults, which beats not starting.
}

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("layerlingDesktop", {
  platform: process.platform,
  storageSet: (key, value) => ipcRenderer.send("storage:set", key, value),
  readProjectSource: (projectId) => ipcRenderer.invoke("project:read-source", projectId),
  writeDraft: (projectId, bytes) => ipcRenderer.invoke("draft:write", projectId, bytes),
  deleteDraft: (projectId) => ipcRenderer.invoke("draft:delete", projectId),
  readDocument: (filePath) => ipcRenderer.invoke("document:read", filePath),
  saveDocument: (request) => ipcRenderer.invoke("document:save", request),
  /** The path of a file the user picked or dropped, or null for one made in memory. */
  pathForFile: (file) => {
    const filePath = webUtils.getPathForFile(file);
    if (!filePath) return null;
    ipcRenderer.send("document:approve", filePath);
    return filePath;
  },
  setDocumentState: (state) => ipcRenderer.send("window:document-state", state),
  onCommand: (callback) => subscribe("desktop:command", callback),
  onOpenPath: (callback) => subscribe("desktop:open-path", callback),
  onBeforeClose: (callback) => subscribe("desktop:before-close", callback),
  ready: () => ipcRenderer.send("app:ready"),
  confirmClose: () => ipcRenderer.send("window:close-confirmed"),
});

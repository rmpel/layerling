/**
 * The desktop app around the page, when there is one.
 *
 * In a browser this is all absent and the app keeps its designs in the
 * browser's storage. Inside the desktop app the same page runs, but designs
 * are .lyl files on disk and preferences live in a settings file: the shell
 * (apps/desktop) offers the handful of calls below for that.
 */

export type DesktopCommand = "new" | "save" | "save-as" | "revert" | "home";

export type DesktopProjectSource = {
  bytes: Uint8Array;
  /** "draft": changes not saved to their file yet. "document": the file itself. */
  source: "draft" | "document";
};

export type DesktopHost = {
  platform: string;
  storageSet: (key: string, value: string | null) => void;
  readProjectSource: (projectId: string) => Promise<DesktopProjectSource | null>;
  writeDraft: (projectId: string, bytes: Uint8Array) => Promise<boolean>;
  deleteDraft: (projectId: string) => Promise<boolean>;
  readDocument: (path: string) => Promise<Uint8Array>;
  /** Writes to `path`, or asks where when there is none. Null when the user cancelled. */
  saveDocument: (request: { path: string | null; suggestedName: string; bytes: Uint8Array }) => Promise<{ path: string; name: string } | null>;
  pathForFile: (file: File) => string | null;
  /** Shows the Open dialog; what the user picks arrives through `onOpenPath`. */
  showOpenDialog: () => void;
  setDocumentState: (state: { title: string; path: string; edited: boolean }) => void;
  onCommand: (callback: (command: DesktopCommand) => void) => () => void;
  onOpenPath: (callback: (path: string) => void) => () => void;
  onBeforeClose: (callback: () => void) => () => void;
  ready: () => void;
  confirmClose: () => void;
};

declare global {
  interface Window {
    layerlingDesktop?: DesktopHost;
  }
}

export function desktopHost(): DesktopHost | null {
  return typeof window === "undefined" ? null : window.layerlingDesktop ?? null;
}

/** The file name without folder and extension: what a design is called on screen. */
export function documentNameFromPath(path: string) {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  return fileName.replace(/\.[^.]+$/, "").trim() || fileName;
}

let storageMirrorInstalled = false;

/**
 * Passes every preference the page stores on to the desktop app, which keeps
 * them in its settings file. The page goes on using localStorage as before;
 * in the desktop app that storage starts empty and is filled from the file.
 */
export function installDesktopStorageMirror() {
  const host = desktopHost();
  if (!host || storageMirrorInstalled) return;
  storageMirrorInstalled = true;
  const { setItem, removeItem } = Storage.prototype;
  Storage.prototype.setItem = function mirroredSetItem(key: string, value: string) {
    setItem.call(this, key, value);
    if (this === window.localStorage) host.storageSet(key, String(value));
  };
  Storage.prototype.removeItem = function mirroredRemoveItem(key: string) {
    removeItem.call(this, key);
    if (this === window.localStorage) host.storageSet(key, null);
  };
}

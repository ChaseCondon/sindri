import { invoke } from "@tauri-apps/api/core";

// ── Data types ────────────────────────────────────────────────────────────────

export interface OpenedFile {
  /** Absolute path (Tauri) or root-relative path (browser FSA / webkitdirectory), or null for unsaved. */
  path: string | null;
  name: string;
  contents: string;
}

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

// ── CoreClient — ADR-0017 §2, seam #2 (the core-transport boundary) ──────────
//
// Routes all capability access through one explicit transport boundary,
// replacing the scattered isTauri() branches that were seam #2 in disguise.
//
//   TauriCoreClient   — Tauri IPC, in-process Rust core (Tier A)
//   BrowserCoreClient — browser shims, no core (Tier B)
//   (reserved)        — network channel to hosted core (Tier C, additive)
//
// Symmetry with ADR-0009: that ADR makes the core's notion of "where things
// run" pluggable; this seam makes the frontend's notion of "which core, if any"
// pluggable. Tier C is the composition of both.
//
export interface CoreClient {
  /** Transport tier identifier. */
  readonly transport: "tauri" | "browser";
  /** True when saves write to real disk (Tauri: always; browser: only when FSA is active). */
  readonly hasDiskWrites: boolean;

  openFile(): Promise<OpenedFile | null>;
  openFolder(): Promise<string | null>;
  openFilePath(path: string): Promise<OpenedFile>;
  listDir(path: string): Promise<DirEntry[]>;
  createFile(path: string): Promise<void>;
  createDir(path: string): Promise<void>;
  saveFile(file: OpenedFile): Promise<OpenedFile | null>;
  deleteFile(path: string): Promise<void>;
  deleteDir(path: string): Promise<void>;
  renameFile(oldPath: string, newPath: string): Promise<void>;
  renameDir(oldPath: string, newPath: string): Promise<void>;
}

// ── FSA local interface types (DOM lib coverage is incomplete in TS 5.5) ──────

interface FsaWritable {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}
interface FsaFileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<FsaWritable>;
}
interface FsaDirHandle {
  kind: "directory";
  name: string;
  entries(): AsyncIterableIterator<[string, FsaDirHandle | FsaFileHandle]>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FsaDirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsaFileHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function sortEntries(a: DirEntry, b: DirEntry): number {
  if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

function downloadFile(file: OpenedFile): void {
  const blob = new Blob([file.contents], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name === "untitled" ? "untitled.txt" : file.name;
  a.click();
  URL.revokeObjectURL(url);
}

function openFileViaInput(): Promise<OpenedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      resolve({ path: null, name: f.name, contents: await f.text() });
    };
    input.click();
  });
}

// ── TauriCoreClient ───────────────────────────────────────────────────────────

class TauriCoreClient implements CoreClient {
  readonly transport = "tauri" as const;
  readonly hasDiskWrites = true;

  async openFile(): Promise<OpenedFile | null> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ multiple: false, directory: false });
    if (typeof selected !== "string") return null;
    const contents = await invoke<string>("read_file", { path: selected });
    return { path: selected, name: basename(selected), contents };
  }

  async openFolder(): Promise<string | null> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === "string" ? selected : null;
  }

  async openFilePath(path: string): Promise<OpenedFile> {
    const contents = await invoke<string>("read_file", { path });
    return { path, name: basename(path), contents };
  }

  async listDir(path: string): Promise<DirEntry[]> {
    return invoke<DirEntry[]>("list_dir", { path });
  }

  async createFile(path: string): Promise<void> {
    return invoke("create_file", { path });
  }

  async createDir(path: string): Promise<void> {
    return invoke("create_dir", { path });
  }

  async saveFile(file: OpenedFile): Promise<OpenedFile | null> {
    let path = file.path;
    if (!path) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const picked = await save({ defaultPath: file.name });
      if (!picked) return null;
      path = picked;
    }
    await invoke("write_file", { path, contents: file.contents });
    return { ...file, path, name: basename(path) };
  }

  async deleteFile(path: string): Promise<void> {
    return invoke("delete_file", { path });
  }

  async deleteDir(path: string): Promise<void> {
    return invoke("delete_dir", { path });
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    return invoke("rename_file", { old_path: oldPath, new_path: newPath });
  }

  async renameDir(oldPath: string, newPath: string): Promise<void> {
    return invoke("rename_dir", { old_path: oldPath, new_path: newPath });
  }
}

// ── BrowserCoreClient ─────────────────────────────────────────────────────────
//
// Tier B (ADR-0017 §3): no Rust core. FS is served by the three-tier in-page
// implementation:
//   - FSA (real disk, Chromium/Edge) when _fsaRoot is set
//   - webkitdirectory in-memory tree otherwise (Firefox/Brave/fallback)
//
class BrowserCoreClient implements CoreClient {
  readonly transport = "browser" as const;

  // FSA state — null until a folder is successfully opened via showDirectoryPicker
  private _fsaRoot: FsaDirHandle | null = null;
  private _fsaDirs  = new Map<string, FsaDirHandle>();
  private _fsaFiles = new Map<string, FsaFileHandle>();

  // webkitdirectory in-memory fallback
  private _browserTree  = new Map<string, DirEntry[]>();
  private _browserFiles = new Map<string, File>();

  get hasDiskWrites(): boolean { return this._fsaRoot !== null; }

  // ── FSA helpers ─────────────────────────────────────────────────────────────

  private async _openFolderViaFSA(): Promise<string> {
    const handle = await (window as unknown as {
      showDirectoryPicker(o: { mode: string }): Promise<FsaDirHandle>;
    }).showDirectoryPicker({ mode: "readwrite" });
    this._fsaRoot = handle;
    this._fsaDirs.clear();
    this._fsaFiles.clear();
    this._fsaDirs.set(handle.name, handle);
    return handle.name;
  }

  // Navigate from the FSA root down to the directory that owns `parts[-1]`.
  private async _fsaParentDir(parts: string[]): Promise<FsaDirHandle> {
    const root = this._fsaDirs.get(parts[0]);
    if (!root) throw new Error(`FSA: root handle missing — open the folder first`);
    let dir: FsaDirHandle = root;
    for (let i = 1; i < parts.length - 1; i++) {
      const next: FsaDirHandle = await dir.getDirectoryHandle(parts[i]);
      this._fsaDirs.set(parts.slice(0, i + 1).join("/"), next);
      dir = next;
    }
    return dir;
  }

  private async _listDirFSA(path: string): Promise<DirEntry[]> {
    const handle = this._fsaDirs.get(path);
    if (!handle) return [];
    const entries: DirEntry[] = [];
    for await (const [name, h] of handle.entries()) {
      const childPath = `${path}/${name}`;
      if (h.kind === "directory") this._fsaDirs.set(childPath, h);
      else this._fsaFiles.set(childPath, h as FsaFileHandle);
      entries.push({ name, path: childPath, is_dir: h.kind === "directory" });
    }
    return entries.sort(sortEntries);
  }

  private async _openFilePathFSA(path: string): Promise<OpenedFile> {
    let handle = this._fsaFiles.get(path);
    if (!handle) {
      const parts = path.split("/");
      const dir = await this._fsaParentDir(parts);
      handle = await dir.getFileHandle(parts[parts.length - 1]);
      this._fsaFiles.set(path, handle);
    }
    const file = await handle.getFile();
    return { path, name: basename(path), contents: await file.text() };
  }

  private async _createFileFSA(path: string): Promise<void> {
    const parts = path.split("/");
    const dir = await this._fsaParentDir(parts);
    const handle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await handle.createWritable();
    await w.close();
    this._fsaFiles.set(path, handle);
  }

  private async _createDirFSA(path: string): Promise<void> {
    const parts = path.split("/");
    const dir = await this._fsaParentDir(parts);
    const handle = await dir.getDirectoryHandle(parts[parts.length - 1], { create: true });
    this._fsaDirs.set(path, handle);
  }

  private async _saveFileFSA(file: OpenedFile): Promise<OpenedFile | null> {
    if (!file.path) { downloadFile(file); return file; }
    let handle = this._fsaFiles.get(file.path);
    if (!handle) {
      const parts = file.path.split("/");
      const dir = await this._fsaParentDir(parts);
      handle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      this._fsaFiles.set(file.path, handle);
    }
    const w = await handle.createWritable();
    await w.write(file.contents);
    await w.close();
    return file;
  }

  private async _deleteFileFSA(path: string): Promise<void> {
    const parts = path.split("/");
    const dir = await this._fsaParentDir(parts);
    await dir.removeEntry(parts[parts.length - 1]);
    this._fsaFiles.delete(path);
  }

  private async _deleteDirFSA(path: string): Promise<void> {
    const parts = path.split("/");
    const dir = await this._fsaParentDir(parts);
    await dir.removeEntry(parts[parts.length - 1], { recursive: true });
    for (const [key] of this._fsaDirs) {
      if (key === path || key.startsWith(path + "/")) this._fsaDirs.delete(key);
    }
    for (const [key] of this._fsaFiles) {
      if (key.startsWith(path + "/")) this._fsaFiles.delete(key);
    }
  }

  private async _renameFileFSA(oldPath: string, newPath: string): Promise<void> {
    const oldParts = oldPath.split("/");
    const newParts = newPath.split("/");
    const oldDir = await this._fsaParentDir(oldParts);
    const newDir = await this._fsaParentDir(newParts);

    // FSA has no rename — create new then remove old
    const oldHandle = this._fsaFiles.get(oldPath);
    if (!oldHandle) throw new Error(`FSA: file handle missing: ${oldPath}`);
    const file = await oldHandle.getFile();
    const newHandle = await newDir.getFileHandle(newParts[newParts.length - 1], { create: true });
    const w = await newHandle.createWritable();
    await w.write(await file.text());
    await w.close();
    this._fsaFiles.set(newPath, newHandle);
    await oldDir.removeEntry(oldParts[oldParts.length - 1]);
    this._fsaFiles.delete(oldPath);
  }

  private async _renameDirFSA(oldPath: string, newPath: string): Promise<void> {
    const oldParts = oldPath.split("/");
    const newParts = newPath.split("/");
    const oldDir = await this._fsaParentDir(oldParts);
    const newDir = await this._fsaParentDir(newParts);

    const oldHandle = this._fsaDirs.get(oldPath);
    if (!oldHandle) throw new Error(`FSA: directory handle missing: ${oldPath}`);

    const newHandle = await newDir.getDirectoryHandle(newParts[newParts.length - 1], { create: true });
    await this._copyDirFSA(oldHandle, newHandle);
    this._fsaDirs.set(newPath, newHandle);

    await oldDir.removeEntry(oldParts[oldParts.length - 1], { recursive: true });
    for (const [key] of this._fsaDirs) {
      if (key === oldPath || key.startsWith(oldPath + "/")) this._fsaDirs.delete(key);
    }
    for (const [key] of this._fsaFiles) {
      if (key.startsWith(oldPath + "/")) this._fsaFiles.delete(key);
    }
  }

  private async _copyDirFSA(srcHandle: FsaDirHandle, dstHandle: FsaDirHandle): Promise<void> {
    for await (const [name, handle] of srcHandle.entries()) {
      if (handle.kind === "file") {
        const file = await (handle as FsaFileHandle).getFile();
        const w = await (await dstHandle.getFileHandle(name, { create: true })).createWritable();
        await w.write(await file.text());
        await w.close();
      } else {
        const subDst = await dstHandle.getDirectoryHandle(name, { create: true });
        await this._copyDirFSA(handle as FsaDirHandle, subDst);
      }
    }
  }

  // ── webkitdirectory helpers ──────────────────────────────────────────────────

  private _buildBrowserTree(files: FileList): void {
    this._browserTree.clear();
    this._browserFiles.clear();
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const rel = file.webkitRelativePath;
      this._browserFiles.set(rel, file);
      const parts = rel.split("/");
      for (let d = 0; d < parts.length; d++) {
        const parentKey = parts.slice(0, d).join("/");
        const entryPath = parts.slice(0, d + 1).join("/");
        const isDir = d < parts.length - 1;
        if (!this._browserTree.has(parentKey)) this._browserTree.set(parentKey, []);
        const siblings = this._browserTree.get(parentKey)!;
        if (!siblings.some((e) => e.path === entryPath)) {
          siblings.push({ name: parts[d], path: entryPath, is_dir: isDir });
          if (isDir && !this._browserTree.has(entryPath)) this._browserTree.set(entryPath, []);
        }
      }
    }
    for (const entries of this._browserTree.values()) {
      entries.sort(sortEntries);
    }
  }

  private _openFolderViaInput(): Promise<string | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      (input as unknown as { webkitdirectory: boolean }).webkitdirectory = true;
      input.addEventListener("change", () => {
        const files = input.files;
        if (!files || files.length === 0) return resolve(null);
        this._buildBrowserTree(files);
        resolve(files[0].webkitRelativePath.split("/")[0] || null);
      });
      input.addEventListener("cancel", () => resolve(null));
      input.click();
    });
  }

  // ── CoreClient implementation ────────────────────────────────────────────────

  async openFile(): Promise<OpenedFile | null> {
    return openFileViaInput();
  }

  async openFolder(): Promise<string | null> {
    if ("showDirectoryPicker" in (window as object)) {
      try {
        return await this._openFolderViaFSA();
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return null;
        // NotAllowedError, SecurityError, browser blocks API → fall through
      }
    }
    return this._openFolderViaInput();
  }

  async openFilePath(path: string): Promise<OpenedFile> {
    if (this._fsaRoot) return this._openFilePathFSA(path);
    const file = this._browserFiles.get(path);
    if (!file) throw new Error(`File not in browser cache: ${path}`);
    return { path, name: basename(path), contents: await file.text() };
  }

  async listDir(path: string): Promise<DirEntry[]> {
    if (this._fsaRoot) return this._listDirFSA(path);
    // Fresh copy — SolidJS resource equality-checks resolved values; same ref suppresses updates.
    return [...(this._browserTree.get(path) ?? [])];
  }

  async createFile(path: string): Promise<void> {
    if (this._fsaRoot) return this._createFileFSA(path);
    const parts = path.split("/");
    const name = parts[parts.length - 1];
    const parentKey = parts.slice(0, -1).join("/");
    const prev = this._browserTree.get(parentKey) ?? [];
    if (!prev.some((e) => e.path === path)) {
      this._browserTree.set(parentKey, [...prev, { name, path, is_dir: false }].sort(sortEntries));
      this._browserFiles.set(path, new File([""], name));
    }
  }

  async createDir(path: string): Promise<void> {
    if (this._fsaRoot) return this._createDirFSA(path);
    const parts = path.split("/");
    const name = parts[parts.length - 1];
    const parentKey = parts.slice(0, -1).join("/");
    const prev = this._browserTree.get(parentKey) ?? [];
    if (!prev.some((e) => e.path === path)) {
      this._browserTree.set(parentKey, [...prev, { name, path, is_dir: true }].sort(sortEntries));
      this._browserTree.set(path, []);
    }
  }

  async saveFile(file: OpenedFile): Promise<OpenedFile | null> {
    if (this._fsaRoot) return this._saveFileFSA(file);
    downloadFile(file);
    return file;
  }

  async deleteFile(path: string): Promise<void> {
    if (this._fsaRoot) return this._deleteFileFSA(path);
    this._browserFiles.delete(path);
    const parts = path.split("/");
    const parentKey = parts.slice(0, -1).join("/");
    const prev = this._browserTree.get(parentKey) ?? [];
    this._browserTree.set(parentKey, prev.filter((e) => e.path !== path));
  }

  async deleteDir(path: string): Promise<void> {
    if (this._fsaRoot) return this._deleteDirFSA(path);
    const parts = path.split("/");
    const parentKey = parts.slice(0, -1).join("/");
    const prev = this._browserTree.get(parentKey) ?? [];
    this._browserTree.set(parentKey, prev.filter((e) => e.path !== path));
    this._browserTree.delete(path);
    for (const [key] of this._browserFiles) {
      if (key.startsWith(path + "/")) this._browserFiles.delete(key);
    }
    for (const [key] of this._browserTree) {
      if (key === path || key.startsWith(path + "/")) this._browserTree.delete(key);
    }
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    if (this._fsaRoot) return this._renameFileFSA(oldPath, newPath);
    const file = this._browserFiles.get(oldPath);
    if (file) {
      this._browserFiles.set(newPath, file);
      this._browserFiles.delete(oldPath);
    }
    const oldParts = oldPath.split("/");
    const newParts = newPath.split("/");
    const oldParentKey = oldParts.slice(0, -1).join("/");
    const newParentKey = newParts.slice(0, -1).join("/");
    const oldParent = this._browserTree.get(oldParentKey) ?? [];
    this._browserTree.set(oldParentKey, oldParent.filter((e) => e.path !== oldPath));
    const newParent = this._browserTree.get(newParentKey) ?? [];
    if (!newParent.some((e) => e.path === newPath)) {
      this._browserTree.set(newParentKey, [...newParent, { name: newParts[newParts.length - 1], path: newPath, is_dir: false }].sort(sortEntries));
    }
  }

  async renameDir(oldPath: string, newPath: string): Promise<void> {
    if (this._fsaRoot) return this._renameDirFSA(oldPath, newPath);
    const oldParts = oldPath.split("/");
    const newParts = newPath.split("/");
    const oldParentKey = oldParts.slice(0, -1).join("/");
    const newParentKey = newParts.slice(0, -1).join("/");
    const oldParent = this._browserTree.get(oldParentKey) ?? [];
    this._browserTree.set(oldParentKey, oldParent.filter((e) => e.path !== oldPath));
    const newParent = this._browserTree.get(newParentKey) ?? [];
    if (!newParent.some((e) => e.path === newPath)) {
      this._browserTree.set(newParentKey, [...newParent, { name: newParts[newParts.length - 1], path: newPath, is_dir: true }].sort(sortEntries));
    }
    for (const [key, entries] of this._browserTree) {
      if (key === oldPath) {
        this._browserTree.set(newPath, entries);
        this._browserTree.delete(key);
      } else if (key.startsWith(oldPath + "/")) {
        const newKey = newPath + key.substring(oldPath.length);
        this._browserTree.set(newKey, entries);
        this._browserTree.delete(key);
      }
    }
    for (const [key] of Array.from(this._browserFiles)) {
      if (key.startsWith(oldPath + "/")) {
        const newKey = newPath + key.substring(oldPath.length);
        this._browserFiles.set(newKey, this._browserFiles.get(key)!);
        this._browserFiles.delete(key);
      }
    }
  }
}

// ── Module-level singleton ────────────────────────────────────────────────────

const _coreClient: CoreClient = (
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
) ? new TauriCoreClient() : new BrowserCoreClient();

/** Returns the active CoreClient (ADR-0017 §2). Prefer this over isTauri() for new code. */
export function getCoreClient(): CoreClient { return _coreClient; }

// ── Compat shims — preserve existing call sites unchanged ────────────────────

export function isTauri(): boolean { return _coreClient.transport === "tauri"; }
export function isFsaActive(): boolean { return _coreClient.transport === "browser" && _coreClient.hasDiskWrites; }

export async function openFile(): Promise<OpenedFile | null> { return _coreClient.openFile(); }
export async function openFolder(): Promise<string | null> { return _coreClient.openFolder(); }
export async function openFilePath(path: string): Promise<OpenedFile> { return _coreClient.openFilePath(path); }
export async function listDir(path: string): Promise<DirEntry[]> { return _coreClient.listDir(path); }
export async function createFile(path: string): Promise<void> { return _coreClient.createFile(path); }
export async function createDir(path: string): Promise<void> { return _coreClient.createDir(path); }
export async function saveFile(file: OpenedFile): Promise<OpenedFile | null> { return _coreClient.saveFile(file); }
export async function deleteFile(path: string): Promise<void> { return _coreClient.deleteFile(path); }
export async function deleteDir(path: string): Promise<void> { return _coreClient.deleteDir(path); }
export async function renameFile(oldPath: string, newPath: string): Promise<void> { return _coreClient.renameFile(oldPath, newPath); }
export async function renameDir(oldPath: string, newPath: string): Promise<void> { return _coreClient.renameDir(oldPath, newPath); }

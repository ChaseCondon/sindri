import { createStore } from "solid-js/store";

interface WorkspaceState {
  /** Absolute path of the open folder, or null if none. */
  folderPath: string | null;
  /** Last segment of folderPath — used for display. */
  folderName: string | null;
  /** Incremented whenever the filesystem is mutated so tree nodes re-fetch. */
  refreshTick: number;
}

const [workspace, setWorkspace] = createStore<WorkspaceState>({
  folderPath: null,
  folderName: null,
  refreshTick: 0,
});

export { workspace };

/** Signal that the filesystem changed — causes all open tree nodes to re-fetch. */
export function bumpRefresh(): void {
  setWorkspace("refreshTick", (n) => n + 1);
}

export function setFolder(path: string): void {
  const parts = path.split(/[\\/]/);
  const name = parts[parts.length - 1] || path;
  setWorkspace({ folderPath: path, folderName: name });
}

// ---------------------------------------------------------------------------
// File-open bridge: FileExplorer calls requestOpenFile; App.tsx registers the
// handler that actually updates the editor state.  A simple callback is enough
// here — no store needed for a single sink.
// ---------------------------------------------------------------------------

type OpenFileHandler = (path: string) => void;
let _openFileHandler: OpenFileHandler | null = null;

export function registerOpenFileHandler(fn: OpenFileHandler): void {
  _openFileHandler = fn;
}

export function requestOpenFile(path: string): void {
  _openFileHandler?.(path);
}

// Persists the open folder and editor tabs across sessions via localStorage.
//
// Usage (App.tsx onMount):
//   restoreSession().then(() => initSession());
//
// restoreSession() must complete before initSession() is called — the reactive
// effect in initSession() runs immediately, and if it fires before restore it
// would overwrite the persisted session with empty state.
import { createRoot, createEffect } from "solid-js";
import { workspace, setFolder } from "../workspace/store";
import { groupStore, openOrActivatePathInActiveGroup, openCustomEditorInActiveGroup } from "./groups";
import { matchDefaultCustomEditor } from "./custom-editor-registry";
import { registry } from "./buffers";
import { openFilePath, isTauri } from "../lib/tauri";

const SESSION_KEY = "sindri:session";

interface Session {
  folderPath: string | null;
  openPaths: string[];
  activePath: string | null;
}

/** Start watching for changes and auto-saving the session. Call after restoreSession(). */
export function initSession(): void {
  createRoot(() => {
    createEffect(() => {
      const folderPath = workspace.folderPath;
      const group = groupStore.groups[groupStore.activeGroup];
      const bufferIds = group?.bufferIds ?? [];
      const activeBufferId = group?.activeBufferId ?? "";

      const openPaths: string[] = [];
      let activePath: string | null = null;
      for (const bufferId of bufferIds) {
        const buf = registry.buffers[bufferId];
        if (buf?.path) openPaths.push(buf.path);
        if (bufferId === activeBufferId && buf?.path) activePath = buf.path;
      }

      localStorage.setItem(SESSION_KEY, JSON.stringify({ folderPath, openPaths, activePath } satisfies Session));
    });
  });
}

/** Restore the previous session: folder path + open files. Only runs in Tauri. */
export async function restoreSession(): Promise<void> {
  if (!isTauri()) return;

  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return;

  let session: Session;
  try {
    session = JSON.parse(raw) as Session;
  } catch {
    return;
  }

  if (session.folderPath) {
    const { invoke } = await import("@tauri-apps/api/core");
    setFolder(session.folderPath);
    invoke("set_workspace_root", { path: session.folderPath }).catch(() => {});
  }

  const { openPaths, activePath } = session;
  if (!openPaths?.length) return;

  // Open non-active files first so the active file ends up on top.
  const toOpen = [
    ...openPaths.filter((p) => p !== activePath),
    ...(activePath ? [activePath] : []),
  ];

  for (const path of toOpen) {
    try {
      const customEditor = matchDefaultCustomEditor(path);
      if (customEditor) {
        const name = path.split(/[/\\]/).pop() ?? path;
        openCustomEditorInActiveGroup(path, name, customEditor.viewType);
      } else {
        const opened = await openFilePath(path);
        if (opened?.path) {
          openOrActivatePathInActiveGroup(opened.path, opened.name, opened.contents);
        }
      }
    } catch {
      // File moved or deleted — skip silently.
    }
  }
}

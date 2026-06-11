import { createResource, createSignal, createEffect, For, Match, Show, Switch, type JSX } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { listDir, createFile, createDir, deleteFile, deleteDir, renameFile, renameDir, type DirEntry } from "../../lib/tauri";
import { workspace, requestOpenFile, bumpRefresh } from "../../workspace/store";
import { openMenu } from "../ContextMenu";
import { resolveIconSvg } from "../../icons/manifest";

// Module-level ref — lets FileExplorerHeaderActions trigger creation without
// being a child of FileExplorer (mirrors the registerOpenFileHandler pattern).
let _startCreate: ((mode: "file" | "dir", parentPath: string) => void) | null = null;

export function FileExplorerHeaderActions() {
  return (
    <Show when={workspace.folderPath}>
      <button
        class="panel-action-btn"
        title="New File"
        onClick={() => _startCreate?.("file", workspace.folderPath!)}
      >+</button>
      <button
        class="panel-action-btn"
        title="New Folder"
        onClick={() => _startCreate?.("dir", workspace.folderPath!)}
      >+/</button>
      <button class="panel-action-btn" title="Refresh" onClick={bumpRefresh}>↻</button>
    </Show>
  );
}

interface CreatingState {
  mode: "file" | "dir";
  parentPath: string;
}

interface TreeOps {
  isExpanded: (path: string) => boolean;
  toggleExpanded: (path: string) => void;
  creating: () => CreatingState | null;
  onStartCreate: (mode: "file" | "dir", parentPath: string) => void;
  CreationRow: (p: { depth: number }) => JSX.Element;
  renamingPath: () => string | null;
  onStartRename: (path: string) => void;
  RenameRow: (p: { entry: DirEntry; depth: number }) => JSX.Element;
  onDelete: (path: string, isDir: boolean) => Promise<void>;
}

export function FileExplorer() {
  // Hoisted expanded state — lives outside individual TreeNodes so it survives
  // <For> reconciliation when the entries list is refreshed.
  const [expandedStore, setExpandedStore] = createStore<Record<string, boolean>>({});

  const [creating, setCreating] = createSignal<CreatingState | null>(null);
  const [renamingPath, setRenamingPath] = createSignal<string | null>(null);
  let creatingInputRef: HTMLInputElement | undefined;
  let renamingInputRef: HTMLInputElement | undefined;

  const [rootEntries] = createResource(
    () => (workspace.folderPath ? ([workspace.folderPath, workspace.refreshTick] as const) : null),
    ([path]) => listDir(path),
  );

  // reconcile(new, { key }) updates this store in-place, preserving DirEntry
  // object references for unchanged paths so <For> never recreates those TreeNodes.
  const [stableEntries, setStableEntries] = createStore<DirEntry[]>([]);
  createEffect(() => {
    const e = rootEntries();
    if (e != null) setStableEntries(reconcile(e, { key: "path" }));
  });

  createEffect(() => {
    if (creating()) requestAnimationFrame(() => creatingInputRef?.focus());
    if (renamingPath()) requestAnimationFrame(() => renamingInputRef?.focus());
  });

  async function commitCreate() {
    const state = creating();
    if (!state) return;
    const name = creatingInputRef?.value.trim() ?? "";
    setCreating(null);
    if (!name) return;
    try {
      if (state.mode === "file") await createFile(`${state.parentPath}/${name}`);
      else await createDir(`${state.parentPath}/${name}`);
      bumpRefresh();
    } catch (e) {
      alert(String(e));
    }
  }

  async function commitRename(entry: DirEntry) {
    const newName = renamingInputRef?.value.trim() ?? "";
    setRenamingPath(null);
    if (!newName || newName === entry.name) return;
    try {
      const parts = entry.path.split("/");
      const parentPath = parts.slice(0, -1).join("/");
      const newPath = `${parentPath}/${newName}`;
      if (entry.is_dir) await renameDir(entry.path, newPath);
      else await renameFile(entry.path, newPath);
      bumpRefresh();
    } catch (e) {
      alert(String(e));
    }
  }

  async function handleDelete(path: string, isDir: boolean) {
    if (!window.confirm(`Delete ${isDir ? "folder" : "file"}?`)) return;
    try {
      if (isDir) await deleteDir(path);
      else await deleteFile(path);
      bumpRefresh();
    } catch (e) {
      alert(String(e));
    }
  }

  function startCreate(mode: "file" | "dir", parentPath: string) {
    if (parentPath !== (workspace.folderPath ?? "")) {
      setExpandedStore(parentPath, true);
    }
    setCreating({ mode, parentPath });
  }

  function startRename(path: string) {
    setRenamingPath(path);
  }

  // Expose to header actions component.
  _startCreate = startCreate;

  // Defined once in the component scope; closes over creating/commitCreate/setCreating.
  function CreationRow(p: { depth: number }): JSX.Element {
    return (
      <div
        class="tree-node tree-create-row"
        style={{ "padding-left": `${p.depth * 14 + 10}px` }}
      >
        <span class="tree-chevron" />
        <input
          ref={(el) => (creatingInputRef = el)}
          class="tree-create-input"
          placeholder={creating()?.mode === "file" ? "filename.ext" : "foldername"}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitCreate();
            if (e.key === "Escape") setCreating(null);
          }}
        />
      </div>
    );
  }

  function RenameRow(p: { entry: DirEntry; depth: number }): JSX.Element {
    return (
      <div
        class="tree-node tree-rename-row"
        style={{ "padding-left": `${p.depth * 14 + 10}px` }}
      >
        <span class="tree-chevron" />
        <input
          ref={(el) => (renamingInputRef = el)}
          class="tree-rename-input"
          value={p.entry.name}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename(p.entry);
            if (e.key === "Escape") setRenamingPath(null);
          }}
        />
      </div>
    );
  }

  const ops: TreeOps = {
    isExpanded: (path) => !!expandedStore[path],
    toggleExpanded: (path) => setExpandedStore(path, (v: boolean) => !v),
    creating,
    onStartCreate: startCreate,
    CreationRow,
    renamingPath,
    onStartRename: startRename,
    RenameRow,
    onDelete: handleDelete,
  };

  const rootPath = () => workspace.folderPath ?? "";

  return (
    <div class="file-explorer">
      <Switch>
        <Match when={!workspace.folderPath}>
          <div class="explorer-empty">
            <p>No folder open</p>
            <p class="panel-hint">Use Open Folder in the toolbar to get started.</p>
          </div>
        </Match>
        <Match when={rootEntries.error}>
          <div class="explorer-empty">
            <p class="panel-hint">Could not read folder.</p>
          </div>
        </Match>
        <Match when={workspace.folderPath}>
          <div class="tree">
            <Show when={creating()?.parentPath === rootPath()}>
              <CreationRow depth={0} />
            </Show>
            <For each={stableEntries}>
              {(entry) => <TreeNode entry={entry} depth={0} ops={ops} />}
            </For>
          </div>
        </Match>
      </Switch>
    </div>
  );
}

interface TreeNodeProps {
  entry: DirEntry;
  depth: number;
  ops: TreeOps;
}

function TreeNode(props: TreeNodeProps) {
  const isExpanded = () => props.ops.isExpanded(props.entry.path);

  const [children] = createResource(
    () =>
      props.entry.is_dir && isExpanded()
        ? ([props.entry.path, workspace.refreshTick] as const)
        : null,
    ([path]) => listDir(path),
  );

  // Same reconcile pattern for children: new/deleted entries update reactively
  // while unchanged sibling references are preserved (no subtree collapse).
  const [stableChildren, setStableChildren] = createStore<DirEntry[]>([]);
  createEffect(() => {
    const c = children();
    if (c != null) setStableChildren(reconcile(c, { key: "path" }));
  });

  function handleClick() {
    if (props.entry.is_dir) {
      props.ops.toggleExpanded(props.entry.path);
    } else {
      requestOpenFile(props.entry.path);
    }
  }

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    const targetDir = props.entry.is_dir ? props.entry.path : parentDir(props.entry.path);
    openMenu(e.clientX, e.clientY, [
      { label: "New File Here", action: () => props.ops.onStartCreate("file", targetDir) },
      { label: "New Folder Here", action: () => props.ops.onStartCreate("dir", targetDir) },
      { label: "Rename", action: () => props.ops.onStartRename(props.entry.path) },
      { label: "Delete", action: () => props.ops.onDelete(props.entry.path, props.entry.is_dir) },
    ]);
  }

  const indent = () => `${props.depth * 14 + 10}px`;

  return (
    <>
      <Show when={props.ops.renamingPath() === props.entry.path} fallback={
        <div
          class={`tree-node${props.entry.is_dir ? " tree-dir" : " tree-file"}`}
          style={{ "padding-left": indent() }}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
        >
          <span class={`tree-chevron${props.entry.is_dir ? "" : " tree-chevron-hidden"}${(props.entry.is_dir && isExpanded()) ? " tree-chevron-open" : ""}`}>
            <svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg" width="10" height="10" aria-hidden="true">
              <path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/>
            </svg>
          </span>
          <span
            class="tree-icon"
            innerHTML={resolveIconSvg(props.entry.name, props.entry.is_dir, isExpanded())}
          />
          <span class="tree-name">{props.entry.name}</span>
          <Show when={props.entry.is_dir}>
            <div class="tree-dir-actions">
              <button
                class="tree-dir-action-btn"
                title="New File Here"
                onClick={(e) => {
                  e.stopPropagation();
                  props.ops.onStartCreate("file", props.entry.path);
                }}
              >
                +
              </button>
              <button
                class="tree-dir-action-btn"
                title="New Folder Here"
                onClick={(e) => {
                  e.stopPropagation();
                  props.ops.onStartCreate("dir", props.entry.path);
                }}
              >
                _/
              </button>
            </div>
          </Show>
          <Show when={!props.entry.is_dir}>
            <div class="tree-file-actions">
              <button
                class="tree-file-action-btn"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  props.ops.onDelete(props.entry.path, props.entry.is_dir);
                }}
              >
                ✕
              </button>
            </div>
          </Show>
        </div>
      }>
        <props.ops.RenameRow entry={props.entry} depth={props.depth} />
      </Show>

      <Show when={props.entry.is_dir && isExpanded()}>
        <Show when={props.ops.creating()?.parentPath === props.entry.path}>
          <props.ops.CreationRow depth={props.depth + 1} />
        </Show>
        <For each={stableChildren}>
          {(child) => <TreeNode entry={child} depth={props.depth + 1} ops={props.ops} />}
        </For>
      </Show>
    </>
  );
}

function parentDir(path: string): string {
  const sep = path.includes("/") ? "/" : "\\";
  return path.substring(0, path.lastIndexOf(sep));
}

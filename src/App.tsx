import { createSignal, createMemo, onMount, Show, For } from "solid-js";
import { EditorArea } from "./editor/EditorArea";
import {
  groupStore,
  getActiveEditorView,
  openLooseInActiveGroup,
  openOrActivatePathInActiveGroup,
  openCustomEditorInActiveGroup,
} from "./editor/groups";
import { matchDefaultCustomEditor } from "./editor/custom-editor-registry";
import { registry, markSaved, registerSaveHandler } from "./editor/buffers";
import { openFile, openFolder, openFilePath, saveFile, isFsaActive, isTauri } from "./lib/tauri";
import { invoke } from "@tauri-apps/api/core";
import { Workbench } from "./workbench/Workbench";
import { registerBuiltins } from "./workbench/builtins";
import { workspace, setFolder, registerOpenFileHandler } from "./workspace/store";
import { registerBuiltinThemes } from "./theme/builtins";
import { registerBuiltinIconThemes } from "./icons/manifest";
import { registerBuiltinUiPack } from "./icons/ui-icons";
import { applyTheme, validateSelections, themeList, iconThemeList, uiPackList, uiThemeId, iconThemeId, uiPackId, setUiTheme, setIconTheme, setUiPack, setUiThemeId, setIconThemeId, setUiPackId } from "./theme/registry";
import { SettingsModal } from "./workbench/settings/SettingsModal";
import { rehydrateInstalledExtensions } from "./workbench/settings/marketplace/store";
import { initExtensionActivation } from "./extensions/activation";
import { checkAndInstallUpdates, checkUpdatesOnly, pendingUpdateCount } from "./extensions/update-checker";
import { startDevWatcher } from "./extensions/dev-watcher";
import { statusBarItems } from "./statusbar/store";
import { toggleToolWindow } from "./workbench/layout";
import { QuickPickOverlay } from "./quick-pick/QuickPickOverlay";
import { PopupPanel } from "./workbench/PopupPanel";
import "./editor/features"; // sets up configStore→decoration-registry subscription (ADR-0024)
import "./editor/editor-state-bridge"; // sets up sindri.editor webview↔host bridge (ADR-0034)
import { restoreSession, initSession } from "./editor/session";

// Register + apply themes before first render (avoids flash of default state).
registerBuiltinThemes();
registerBuiltinIconThemes();
registerBuiltinUiPack();
applyTheme();

// Re-register installed extensions, then silently auto-update any that have newer versions.
rehydrateInstalledExtensions()
  .then(() => { validateSelections(); applyTheme(); })
  .then(() => checkAndInstallUpdates().then(() => { validateSelections(); applyTheme(); }))
  .catch(() => { validateSelections(); applyTheme(); });

// Poll for updates every 4 hours and surface a badge on the Settings button.
setInterval(() => { checkUpdatesOnly().catch(() => {}); }, 4 * 60 * 60 * 1000);

registerBuiltins();
initExtensionActivation();
startDevWatcher();

// Welcome screen shows when the editor is empty — no untitled seed needed.

// Exported so ActivityBar and any keybinding can open settings.
export const [settingsOpen, setSettingsOpen] = createSignal(false);

function ThemePicker(props: {
  label: string;
  items: () => Array<{ id: string; name: string }>;
  currentId: () => string;
  onPreview: (id: string) => void;
  onCommit: (id: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  let savedId = "";

  const currentName = createMemo(() =>
    props.items().find((i) => i.id === props.currentId())?.name ?? props.label
  );

  function openPicker() {
    savedId = props.currentId();
    setOpen(true);
  }

  function closePicker(revert: boolean) {
    if (revert) props.onPreview(savedId);
    setOpen(false);
  }

  return (
    <div class="theme-picker">
      <button
        class="theme-picker-trigger"
        title={props.label}
        onClick={() => (open() ? closePicker(true) : openPicker())}
      >
        {currentName()} ▾
      </button>
      <Show when={open()}>
        <div class="theme-picker-backdrop" onClick={() => closePicker(true)} />
        <div class="theme-picker-list" onMouseLeave={() => props.onPreview(savedId)}>
          <For each={props.items()}>
            {(item) => (
              <button
                class="theme-picker-item"
                classList={{ "is-active": item.id === props.currentId() }}
                onMouseEnter={() => props.onPreview(item.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  savedId = item.id;
                  props.onCommit(item.id);
                  setOpen(false);
                }}
              >
                {item.name}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export function App() {
  const [status, setStatus] = createSignal("Ready");

  async function handleSave() {
    const groupId = groupStore.activeGroup;
    const group = groupStore.groups[groupId];
    const bufferId = group?.activeBufferId;
    if (!bufferId || !group) return;

    const buf = registry.buffers[bufferId];
    if (!buf) return;

    const view = getActiveEditorView();
    const text = view ? view.state.doc.toString() : "";

    try {
      const saved = await saveFile({ path: buf.path, name: buf.name, contents: text });
      if (saved?.path) {
        markSaved(bufferId, saved.path, saved.name, saved.contents);
        setStatus(`Saved ${saved.name}`);
      }
    } catch (err) {
      setStatus(`Save failed: ${String(err)}`);
    }
  }

  async function handleToggleDevTools() {
    if (!isTauri()) return;
    try {
      await invoke("toggle_devtools");
    } catch { /* not a debug build */ }
  }

  onMount(() => {
    // Cmd/Ctrl+, opens Settings
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
      // Cmd+Option+I (macOS) or Ctrl+Shift+I (Windows/Linux) toggles DevTools
      if (isTauri() && e.key.toLowerCase() === "i" && (
        (e.metaKey && e.altKey) ||
        (e.ctrlKey && e.shiftKey)
      )) {
        e.preventDefault();
        void handleToggleDevTools();
      }
    }
    document.addEventListener("keydown", onKeyDown);

    registerSaveHandler(handleSave);

    registerOpenFileHandler(async (path) => {
      try {
        const customEditor = matchDefaultCustomEditor(path);
        if (customEditor) {
          const name = path.split(/[/\\]/).pop() ?? path;
          openCustomEditorInActiveGroup(path, name, customEditor.viewType);
          setStatus(`Opened ${name}`);
        } else {
          const opened = await openFilePath(path);
          openOrActivatePathInActiveGroup(opened.path!, opened.name, opened.contents);
          setStatus(`Opened ${opened.name}`);
        }
      } catch (err) {
        setStatus(`Open failed: ${String(err)}`);
      }
    });

    restoreSession().then(() => initSession());
  });

  async function handleOpenFolder() {
    try {
      const path = await openFolder();
      if (path) {
        setFolder(path);
        if (isTauri()) invoke("set_workspace_root", { path }).catch(() => {});
        const tier = isTauri() ? "Tauri" : isFsaActive() ? "real FS" : "virtual (no disk writes)";
        setStatus(`Opened: ${workspace.folderName} · ${tier}`);
      }
    } catch (err) {
      setStatus(`Open folder failed: ${String(err)}`);
    }
  }

  async function handleOpenFile() {
    try {
      const opened = await openFile();
      if (opened) {
        if (opened.path) {
          openOrActivatePathInActiveGroup(opened.path, opened.name, opened.contents);
        } else {
          openLooseInActiveGroup(opened.name, opened.contents);
        }
        setStatus(`Opened ${opened.name}`);
      }
    } catch (err) {
      setStatus(`Open failed: ${String(err)}`);
    }
  }

  const titleParts = () => {
    const folder = workspace.folderName;
    const group = groupStore.groups[groupStore.activeGroup];
    const bufferId = group?.activeBufferId;
    const buf = bufferId ? registry.buffers[bufferId] : null;
    const fileName = buf ? buf.name + (buf.dirty ? " •" : "") : "Sindri";
    return folder ? `${folder} / ${fileName}` : fileName;
  };

  return (
    <div class="app">
      <header class="titlebar">
        <span class="brand">Sindri</span>
        <span class="filename">{titleParts()}</span>
        <div class="actions">
          <button onClick={handleOpenFolder}>Open Folder</button>
          <button onClick={handleOpenFile}>Open File</button>
          <button onClick={handleSave}>Save</button>
          <Show when={themeList().length > 1}>
            <ThemePicker
              label="Color Theme"
              items={themeList}
              currentId={uiThemeId}
              onPreview={(id) => { setUiThemeId(id); applyTheme(); }}
              onCommit={setUiTheme}
            />
          </Show>
          <Show when={iconThemeList().length > 1}>
            <ThemePicker
              label="Icon Theme"
              items={iconThemeList}
              currentId={iconThemeId}
              onPreview={setIconThemeId}
              onCommit={setIconTheme}
            />
          </Show>
          <Show when={uiPackList().length > 1}>
            <ThemePicker
              label="UI Icons"
              items={uiPackList}
              currentId={uiPackId}
              onPreview={setUiPackId}
              onCommit={setUiPack}
            />
          </Show>
          <Show when={isTauri()}>
            <button onClick={handleToggleDevTools} title="Toggle Developer Tools (⌘⌥I / Ctrl+Shift+I)">
              Dev Tools
            </button>
          </Show>
          <button onClick={() => setSettingsOpen(true)} title="Settings (Ctrl+,)">
            Settings{pendingUpdateCount() > 0 ? ` (${pendingUpdateCount()})` : ""}
          </button>
        </div>
      </header>
      <Workbench>
        <div class="editor-area">
          <EditorArea />
        </div>
      </Workbench>
      <footer class="statusbar">
        <span class="statusbar-status">{status()}</span>
        <div class="statusbar-ext-items">
          <For each={Object.values(statusBarItems).filter((item) => item.visible)}>
            {(item) => (
              <span
                class={`statusbar-item${item.popupPanelId ? " statusbar-item-clickable" : ""}`}
                title={item.tooltip}
                onClick={item.popupPanelId ? () => toggleToolWindow(item.popupPanelId!) : undefined}
              >{item.text}</span>
            )}
          </For>
        </div>
      </footer>
      <PopupPanel />
      <Show when={settingsOpen()}>
        <SettingsModal onClose={() => setSettingsOpen(false)} />
      </Show>
      <QuickPickOverlay />
    </div>
  );
}

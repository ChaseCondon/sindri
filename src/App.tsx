import { createSignal, onMount, Show, For } from "solid-js";
import { EditorArea } from "./editor/EditorArea";
import {
  groupStore,
  getActiveEditorView,
  openLooseInActiveGroup,
  openOrActivatePathInActiveGroup,
} from "./editor/groups";
import { registry, markSaved, registerSaveHandler } from "./editor/buffers";
import { openFile, openFolder, openFilePath, saveFile, isFsaActive, isTauri } from "./lib/tauri";
import { invoke } from "@tauri-apps/api/core";
import { Workbench } from "./workbench/Workbench";
import { registerBuiltins } from "./workbench/builtins";
import { workspace, setFolder, registerOpenFileHandler } from "./workspace/store";
import { registerBuiltinThemes } from "./theme/builtins";
import { registerBuiltinIconThemes } from "./icons/manifest";
import { registerBuiltinUiPack } from "./icons/ui-icons";
import { applyTheme, validateSelections } from "./theme/registry";
import { SettingsModal } from "./workbench/settings/SettingsModal";
import { rehydrateInstalledExtensions } from "./workbench/settings/MarketplaceSection";
import { initExtensionActivation } from "./extensions/activation";
import { statusBarItems } from "./statusbar/store";
import { QuickPickOverlay } from "./quick-pick/QuickPickOverlay";
import "./editor/features"; // sets up configStore→decoration-registry subscription (ADR-0024)

// Register + apply themes before first render (avoids flash of default state).
registerBuiltinThemes();
registerBuiltinIconThemes();
registerBuiltinUiPack();
applyTheme();

// Re-register any installed remote extensions in the background.
// When complete, applyTheme() picks up the newly available themes.
rehydrateInstalledExtensions()
  .then(() => { validateSelections(); applyTheme(); })
  .catch(() => { validateSelections(); applyTheme(); });

registerBuiltins();
initExtensionActivation();

// Welcome screen shows when the editor is empty — no untitled seed needed.

// Exported so ActivityBar and any keybinding can open settings.
export const [settingsOpen, setSettingsOpen] = createSignal(false);

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

  onMount(() => {
    // Cmd/Ctrl+, opens Settings
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    }
    document.addEventListener("keydown", onKeyDown);

    registerSaveHandler(handleSave);

    registerOpenFileHandler(async (path) => {
      try {
        const opened = await openFilePath(path);
        openOrActivatePathInActiveGroup(opened.path!, opened.name, opened.contents);
        setStatus(`Opened ${opened.name}`);
      } catch (err) {
        setStatus(`Open failed: ${String(err)}`);
      }
    });
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
          <button onClick={() => setSettingsOpen(true)} title="Settings (Ctrl+,)">Settings</button>
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
              <span class="statusbar-item" title={item.tooltip}>{item.text}</span>
            )}
          </For>
        </div>
      </footer>
      <Show when={settingsOpen()}>
        <SettingsModal onClose={() => setSettingsOpen(false)} />
      </Show>
      <QuickPickOverlay />
    </div>
  );
}

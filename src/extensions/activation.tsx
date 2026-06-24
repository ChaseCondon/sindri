// Extension activation glue (ADR-0026 Tier 1).
// Listens for runtime UI registration events emitted by extension JS and
// translates them into workbench ToolWindowDef registrations.
//
// Manifest-reading flow: activateExtensionWithManifest() reads contributes.treeViews
// from the manifest before calling ext_activate so panel slots have real metadata
// (title, icon, defaultDock). handleTreeViewRegistered is then a no-op for those IDs.
import { invoke } from "@tauri-apps/api/core";
import { listenExtEvent, activateExtension, activateSinxtExtension } from "./host";
import { getAllValues } from "../workbench/settings/configStore";
import { registerToolWindow } from "../workbench/layout";
import { TreeViewHost } from "../workbench/panels/TreeViewHost";
import { WebviewPanelHost } from "../workbench/panels/WebviewPanelHost";
import { registerWebviewPanelHtml } from "../workbench/panels/webview-panel-store";
import { addCustomEditorRegistration } from "../editor/custom-editor-registry";
import { registerStatusBarItem, updateStatusBarItem, removeStatusBarItem } from "../statusbar/store";
import { openQuickPick, updateQuickPickItems, closeQuickPick, type QuickPickItem } from "../quick-pick/store";
import {
  registerExtension as registerLogChannel,
  addChannel,
  appendLine,
  clearChannel,
  removeChannel,
  requestChannelShow,
} from "../workbench/panels/ext-logs-store";

const ICON_TREE_VIEW = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
  <path d="M3 5h4v2H3zm0 6h4v2H3zm0 6h4v2H3zm6-12h12v2H9zm0 6h12v2H9zm0 6h12v2H9z"/>
</svg>`;

interface TreeViewContrib {
  id: string;
  title: string;
  icon?: string;
  defaultDock?: "left-top" | "left-bottom" | "right-top" | "right-bottom" | "bottom";
}

interface WebviewPanelContrib {
  id: string;
  title: string;
  icon?: string;
  defaultDock?: "left-top" | "left-bottom" | "right-top" | "right-bottom" | "bottom";
}

interface CustomEditorSelectorLocal {
  scheme?: string;
  language?: string;
  pattern?: string;
}
interface CustomEditorContrib {
  viewType: string;
  displayName?: string;
  selector?: CustomEditorSelectorLocal[];
  priority?: "default" | "option";
}

interface ExtensionManifest {
  id?: string;
  name?: string;
  categories?: string[];
  contributes?: {
    treeViews?: TreeViewContrib[];
    webviewPanels?: WebviewPanelContrib[];
    customEditors?: CustomEditorContrib[];
  };
}

// IDs pre-registered from the manifest so dynamic registration events can skip them.
const preRegisteredTreeViews = new Set<string>();
const preRegisteredWebviewPanels = new Set<string>();
const preRegisteredCustomEditors = new Set<string>();

// Bundle dirs keyed by ext_id so dynamic icon paths can be resolved after activation.
const extBundleDirs = new Map<string, string>();

/**
 * Resolve an icon field from a manifest or dynamic registration event.
 * If `raw` starts with '<' it is already SVG markup and is returned as-is.
 * Otherwise it is treated as a path relative to `bundleDir` and read from disk.
 * Falls back to `fallback` on any failure.
 */
async function resolveIcon(raw: string | undefined, bundleDir: string, fallback: string): Promise<string> {
  if (!raw) return fallback;
  if (raw.trimStart().startsWith("<")) return raw;
  try {
    return await invoke<string>("read_file", { path: `${bundleDir}/${raw}` });
  } catch {
    return fallback;
  }
}

function registerTreeViewPanel(id: string, title: string, icon: string, defaultDock: "left-top" | "left-bottom" | "right-top" | "right-bottom" | "bottom"): void {
  registerToolWindow({
    id,
    title,
    icon,
    defaultDock,
    render: () => <TreeViewHost treeId={id} />,
  });
}

function titleFromId(id: string): string {
  const local = id.includes(".") ? id.slice(id.indexOf(".") + 1) : id;
  return local.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function handleTreeViewRegistered(id: string): void {
  if (preRegisteredTreeViews.has(id)) return; // already registered from manifest
  // Fallback: no manifest or extension omits treeViews contribution.
  registerTreeViewPanel(id, titleFromId(id), ICON_TREE_VIEW, "left-top");
}

function registerWebviewPanel(
  id: string,
  title: string,
  icon: string,
  defaultDock: "left-top" | "left-bottom" | "right-top" | "right-bottom" | "bottom",
): void {
  registerToolWindow({
    id,
    title,
    icon,
    defaultDock,
    render: () => <WebviewPanelHost panelId={id} />,
  });
}

interface WebviewPanelRegisteredPayload {
  id: string;
  title: string;
  icon: string;
  extId?: string;
  defaultDock: "left-top" | "left-bottom" | "right-top" | "right-bottom" | "bottom";
  html: string;
}

async function handleWebviewPanelRegistered(payload: string): Promise<void> {
  const data = JSON.parse(payload) as WebviewPanelRegisteredPayload;
  registerWebviewPanelHtml(data.id, data.html);
  if (!preRegisteredWebviewPanels.has(data.id)) {
    const bundleDir = (data.extId ? extBundleDirs.get(data.extId) : undefined) ?? "";
    const icon = await resolveIcon(data.icon, bundleDir, ICON_TREE_VIEW);
    registerWebviewPanel(
      data.id,
      data.title || titleFromId(data.id),
      icon,
      data.defaultDock || "right-top",
    );
  }
}

async function readManifest(bundlePath: string): Promise<ExtensionManifest | null> {
  const sep = Math.max(bundlePath.lastIndexOf("/"), bundlePath.lastIndexOf("\\"));
  const bundleDir = sep >= 0 ? bundlePath.slice(0, sep) : ".";
  // Try manifest next to the bundle first (installed/packaged layout),
  // then one level up (dev layout: bundle lives in dist/, manifest at extension root).
  for (const dir of [bundleDir, `${bundleDir}/..`]) {
    try {
      const raw = await invoke<string>("read_file", { path: `${dir}/manifest.json` });
      return JSON.parse(raw) as ExtensionManifest;
    } catch {
      // try next candidate
    }
  }
  return null;
}

export async function activateExtensionWithManifest(bundlePath: string): Promise<void> {
  const manifest = await readManifest(bundlePath);

  // Compute and store bundle directory for later icon resolution.
  const sep = Math.max(bundlePath.lastIndexOf("/"), bundlePath.lastIndexOf("\\"));
  const bundleDir = sep >= 0 ? bundlePath.slice(0, sep) : ".";
  const extId = manifest?.id;
  if (extId) {
    extBundleDirs.set(extId, bundleDir);
    // Register the extension in the logs store so its Console channel exists immediately.
    registerLogChannel(
      extId,
      manifest?.name ?? extId,
      manifest?.categories ?? ["Other"],
    );
  }

  for (const tv of manifest?.contributes?.treeViews ?? []) {
    preRegisteredTreeViews.add(tv.id);
    const icon = await resolveIcon(tv.icon, bundleDir, ICON_TREE_VIEW);
    registerTreeViewPanel(tv.id, tv.title, icon, tv.defaultDock ?? "left-top");
  }
  for (const wp of manifest?.contributes?.webviewPanels ?? []) {
    preRegisteredWebviewPanels.add(wp.id);
    const icon = await resolveIcon(wp.icon, bundleDir, ICON_TREE_VIEW);
    registerWebviewPanel(wp.id, wp.title, icon, wp.defaultDock ?? "right-top");
  }
  for (const ce of manifest?.contributes?.customEditors ?? []) {
    preRegisteredCustomEditors.add(ce.viewType);
    addCustomEditorRegistration({
      viewType: ce.viewType,
      displayName: ce.displayName ?? ce.viewType,
      selector: ce.selector ?? [],
      priority: ce.priority ?? "default",
      extId: extId ?? "",
    });
  }

  await activateExtension(bundlePath, extId, bundleDir, JSON.stringify(getAllValues()));
}

/**
 * Activate a code extension from an installed .sinxt archive.
 * Used by marketplace download and local-file install (1.5e / 1.5f).
 * The manifest is already known (from the registry entry or the archive's manifest.json),
 * so panel registration runs immediately without a disk/network read.
 */
export async function activateExtensionFromSinxt(
  sinxtPath: string,
  manifest: {
    id?: string;
    name?: string;
    categories?: string[];
    contributes?: {
      treeViews?: TreeViewContrib[];
      webviewPanels?: WebviewPanelContrib[];
      customEditors?: CustomEditorContrib[];
    };
  },
): Promise<void> {
  const extId = manifest.id;
  if (!extId) return;

  extBundleDirs.set(extId, sinxtPath); // store sinxtPath as the "dir" key for icon resolution fallback
  registerLogChannel(extId, manifest.name ?? extId, manifest.categories ?? ["Other"]);

  for (const tv of manifest.contributes?.treeViews ?? []) {
    preRegisteredTreeViews.add(tv.id);
    // Only use the icon if it's inline SVG; path-based icons can't be resolved pre-activation.
    const tvIcon = tv.icon?.trimStart().startsWith("<") ? tv.icon : ICON_TREE_VIEW;
    registerTreeViewPanel(tv.id, tv.title, tvIcon, tv.defaultDock ?? "left-top");
  }
  for (const wp of manifest.contributes?.webviewPanels ?? []) {
    preRegisteredWebviewPanels.add(wp.id);
    const wpIcon = wp.icon?.trimStart().startsWith("<") ? wp.icon : ICON_TREE_VIEW;
    registerWebviewPanel(wp.id, wp.title, wpIcon, wp.defaultDock ?? "right-top");
  }
  for (const ce of manifest.contributes?.customEditors ?? []) {
    preRegisteredCustomEditors.add(ce.viewType);
    addCustomEditorRegistration({
      viewType: ce.viewType,
      displayName: ce.displayName ?? ce.viewType,
      selector: ce.selector ?? [],
      priority: ce.priority ?? "default",
      extId,
    });
  }

  await activateSinxtExtension(sinxtPath, extId, JSON.stringify(getAllValues()));
}

/**
 * Synchronously pre-register tool windows from an already-known manifest.
 *
 * Called at the very start of rehydrateInstalledExtensions (before any await)
 * so activity bar icons appear on the FIRST render, not after async activation.
 * The full activateExtensionFromSinxt / activateExtensionWithManifest calls will
 * later overwrite the registry entry with the real render functions — that's fine
 * because registerToolWindow preserves the persisted window position.
 */
export function preRegisterManifestPanels(manifest: ExtensionManifest): void {
  for (const tv of manifest.contributes?.treeViews ?? []) {
    if (preRegisteredTreeViews.has(tv.id)) continue;
    preRegisteredTreeViews.add(tv.id);
    const icon = tv.icon?.trimStart().startsWith("<") ? tv.icon : ICON_TREE_VIEW;
    registerTreeViewPanel(tv.id, tv.title, icon, tv.defaultDock ?? "left-top");
  }
  for (const wp of manifest.contributes?.webviewPanels ?? []) {
    if (preRegisteredWebviewPanels.has(wp.id)) continue;
    preRegisteredWebviewPanels.add(wp.id);
    const icon = wp.icon?.trimStart().startsWith("<") ? wp.icon : ICON_TREE_VIEW;
    registerWebviewPanel(wp.id, wp.title, icon, wp.defaultDock ?? "right-top");
  }
  for (const ce of manifest.contributes?.customEditors ?? []) {
    if (preRegisteredCustomEditors.has(ce.viewType)) continue;
    preRegisteredCustomEditors.add(ce.viewType);
    addCustomEditorRegistration({
      viewType: ce.viewType,
      displayName: ce.displayName ?? ce.viewType,
      selector: ce.selector ?? [],
      priority: ce.priority ?? "default",
      extId: manifest.id ?? "",
    });
  }
}

export function initExtensionActivation(): void {
  // ADR-0030 — extension output log events
  listenExtEvent("__sindri.output.line", (payload) => {
    const d = JSON.parse(payload) as {
      extId: string; channelId: string; level: "log" | "warn" | "error" | "info"; msg: string; ts: number;
    };
    appendLine(d.extId, d.channelId, d.level, d.msg, d.ts);
  });
  listenExtEvent("__sindri.output.channelCreated", (payload) => {
    const d = JSON.parse(payload) as { extId: string; channelId: string; name: string };
    addChannel(d.extId, d.channelId, d.name);
  });
  listenExtEvent("__sindri.output.channelClear", (payload) => {
    const d = JSON.parse(payload) as { extId: string; channelId: string };
    clearChannel(d.extId, d.channelId);
  });
  listenExtEvent("__sindri.output.channelShow", (payload) => {
    const d = JSON.parse(payload) as { extId: string; channelId: string };
    requestChannelShow(d.extId, d.channelId);
  });
  listenExtEvent("__sindri.output.channelDisposed", (payload) => {
    const d = JSON.parse(payload) as { extId: string; channelId: string };
    removeChannel(d.extId, d.channelId);
  });

  listenExtEvent("__sindri.ui.treeViewRegistered", handleTreeViewRegistered);
  listenExtEvent("__sindri.ui.webviewPanelRegistered", handleWebviewPanelRegistered);
  listenExtEvent("__sindri.ui.statusBarItemCreated", (payload) => {
    const { id, text, tooltip, popupPanelId } = JSON.parse(payload) as { id: string; text: string; tooltip: string; popupPanelId?: string };
    registerStatusBarItem(id, text ?? "", tooltip ?? "", popupPanelId);
  });
  listenExtEvent("__sindri.ui.statusBarItemUpdated", (payload) => {
    const { id, ...patch } = JSON.parse(payload) as { id: string; text?: string; tooltip?: string; visible?: boolean };
    updateStatusBarItem(id, patch);
  });
  listenExtEvent("__sindri.ui.statusBarItemDisposed", (id) => {
    removeStatusBarItem(id);
  });

  listenExtEvent("__sindri.ui.quickPickShow", (payload) => {
    const data = JSON.parse(payload) as {
      requestId: string;
      items: QuickPickItem[];
      placeholder?: string | null;
      title?: string | null;
      streaming?: boolean;
    };
    openQuickPick({
      requestId: data.requestId,
      items: data.items ?? [],
      placeholder: data.placeholder ?? null,
      title: data.title ?? null,
      streaming: data.streaming ?? false,
    });
  });
  listenExtEvent("__sindri.ui.quickPickUpdate", (payload) => {
    const { requestId, items } = JSON.parse(payload) as { requestId: string; items: QuickPickItem[] };
    updateQuickPickItems(requestId, items ?? []);
  });
  listenExtEvent("__sindri.ui.quickPickHide", (requestId) => {
    closeQuickPick(requestId);
  });

  // ADR-0028 — runtime custom editor registration (extension called registerEditor).
  listenExtEvent("__sindri.ui.editorRegistered", (payload) => {
    const data = JSON.parse(payload) as {
      viewType: string;
      selector?: Array<{ scheme?: string; language?: string; pattern?: string }>;
      priority?: "default" | "option";
      extId?: string;
    };
    if (preRegisteredCustomEditors.has(data.viewType)) return;
    addCustomEditorRegistration({
      viewType: data.viewType,
      displayName: data.viewType,
      selector: data.selector ?? [],
      priority: data.priority ?? "default",
      extId: data.extId ?? "",
    });
  });
}

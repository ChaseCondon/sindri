// Extension host bridge — ADR-0025
// Mirrors the CoreClient / RegistryClient seam pattern (ADR-0017).
//
//   TauriExtHostClient   — wires to exthost Rust commands over Tauri IPC
//   BrowserExtHostClient — no-op (extension host requires native runtime)
//
// Two directions:
//   dispatch(id, payload)      — frontend → Rust → extension JS handlers
//   listenExtEvent(id, fn)     — extension JS → Rust channel → frontend listener
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "../lib/tauri";

export interface ExtHostClient {
  /** Push an event into extension JS handlers registered via sindri.events.on(id, …). */
  dispatch(id: string, payload: string): Promise<void>;
  /** Subscribe to events emitted by extensions via sindri.events.emit(id, payload). */
  listen(id: string, handler: (payload: string) => void): Promise<UnlistenFn>;
  /** Activate an extension bundle at the given absolute path. extId is the manifest id for log attribution (ADR-0030); bundleDir is its parent directory for sindri-resource:// serving (ADR-0031). */
  activate(bundlePath: string, extId?: string, bundleDir?: string): Promise<void>;
  /** Activate an extension from an installed .sinxt archive. Rust reads bundle.js from the zip; sindri-resource:// is served from zip entries on demand. */
  activateSinxt(sinxtPath: string, extId: string): Promise<void>;
  /** Execute a command registered by the active extension. */
  executeCommand(commandId: string): Promise<string>;
  /** Call getChildren on a registered tree-view provider; returns JSON-encoded TreeItem[]. */
  treeViewGetChildren(treeId: string, elementId?: string): Promise<string>;
  /** Deliver a quick-pick result to the awaiting showQuickPick op. item is the chosen item JSON or null. */
  quickPickResult(requestId: string, item: string | null): Promise<void>;
  /** Forward a postMessage from a webview iframe to the extension provider's onMessage handler. */
  webviewPanelMessage(panelId: string, payload: string): Promise<void>;
}

// ── Tauri implementation ──────────────────────────────────────────────────────

class TauriExtHostClient implements ExtHostClient {
  async dispatch(id: string, payload: string): Promise<void> {
    await invoke("ext_dispatch_event", { id, payload });
  }

  async listen(id: string, handler: (payload: string) => void): Promise<UnlistenFn> {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<{ id: string; payload: string }>("ext-event", (event) => {
      if (event.payload.id === id) handler(event.payload.payload);
    });
  }

  async activate(bundlePath: string, extId?: string, bundleDir?: string): Promise<void> {
    await invoke("ext_activate", { bundlePath, extId: extId ?? null, bundleDir: bundleDir ?? null });
  }

  async activateSinxt(sinxtPath: string, extId: string): Promise<void> {
    await invoke("ext_activate_sinxt", { sinxtPath, extId });
  }

  async executeCommand(commandId: string): Promise<string> {
    return invoke<string>("ext_execute_command", { commandId });
  }

  async treeViewGetChildren(treeId: string, elementId?: string): Promise<string> {
    return invoke<string>("ext_tree_view_get_children", {
      id: treeId,
      element: elementId ?? null,
    });
  }

  async quickPickResult(requestId: string, item: string | null): Promise<void> {
    await invoke("ext_quick_pick_result", { request_id: requestId, item });
  }

  async webviewPanelMessage(panelId: string, payload: string): Promise<void> {
    await invoke("ext_webview_panel_message", { panel_id: panelId, payload });
  }
}

// ── Browser no-op ─────────────────────────────────────────────────────────────

class BrowserExtHostClient implements ExtHostClient {
  async dispatch(_id: string, _payload: string): Promise<void> {}
  async listen(_id: string, _handler: (payload: string) => void): Promise<UnlistenFn> {
    return () => {};
  }
  async activate(_bundlePath: string, _extId?: string, _bundleDir?: string): Promise<void> {}
  async activateSinxt(_sinxtPath: string, _extId: string): Promise<void> {}
  async executeCommand(_commandId: string): Promise<string> { return ""; }
  async treeViewGetChildren(_treeId: string, _elementId?: string): Promise<string> { return "[]"; }
  async quickPickResult(_requestId: string, _item: string | null): Promise<void> {}
  async webviewPanelMessage(_panelId: string, _payload: string): Promise<void> {}
}

// ── Singleton + convenience exports ──────────────────────────────────────────

const _extHostClient: ExtHostClient = isTauri()
  ? new TauriExtHostClient()
  : new BrowserExtHostClient();

export function getExtHostClient(): ExtHostClient { return _extHostClient; }

export function dispatch(id: string, payload: string): Promise<void> {
  return _extHostClient.dispatch(id, payload);
}

export function listenExtEvent(id: string, handler: (payload: string) => void): Promise<UnlistenFn> {
  return _extHostClient.listen(id, handler);
}

export function activateExtension(bundlePath: string, extId?: string, bundleDir?: string): Promise<void> {
  return _extHostClient.activate(bundlePath, extId, bundleDir);
}

export function activateSinxtExtension(sinxtPath: string, extId: string): Promise<void> {
  return _extHostClient.activateSinxt(sinxtPath, extId);
}

export function executeExtCommand(commandId: string): Promise<string> {
  return _extHostClient.executeCommand(commandId);
}

export function deliverQuickPickResult(requestId: string, item: string | null): Promise<void> {
  return _extHostClient.quickPickResult(requestId, item);
}

export function deliverWebviewPanelMessage(panelId: string, payload: string): Promise<void> {
  return _extHostClient.webviewPanelMessage(panelId, payload);
}

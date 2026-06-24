// ADR-0028 — per-instance HTML store for custom editor webviews.
// HTML is pushed here when the extension's resolveCustomEditor fires editorHtml:{instanceId};
// WebviewEditorHost reads it reactively and renders once it arrives.
import { createSignal } from "solid-js";

const _html = new Map<string, string>();

const [_rev, _setRev] = createSignal(0);

export function registerCustomEditorHtml(instanceId: string, html: string): void {
  _html.set(instanceId, html);
  _setRev((v) => v + 1);
}

export function getCustomEditorHtml(instanceId: string): string | undefined {
  _rev(); // subscribe
  return _html.get(instanceId);
}

export function removeCustomEditorHtml(instanceId: string): void {
  _html.delete(instanceId);
}

// ---------------------------------------------------------------------------
// Refresh callbacks — called after a version switch to re-request HTML for
// all open instances of a given viewType.
// ---------------------------------------------------------------------------

const _refreshCallbacks = new Map<string, Set<() => void>>();

export function onCustomEditorRefresh(viewType: string, cb: () => void): () => void {
  if (!_refreshCallbacks.has(viewType)) _refreshCallbacks.set(viewType, new Set());
  _refreshCallbacks.get(viewType)!.add(cb);
  return () => _refreshCallbacks.get(viewType)?.delete(cb);
}

export function refreshCustomEditorsByViewType(viewType: string): void {
  _refreshCallbacks.get(viewType)?.forEach((cb) => cb());
}

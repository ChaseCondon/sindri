// Reactive store for webview panel HTML (ADR-0026 §4 Tier 2).
// HTML is pushed here when an extension calls registerWebviewPanel; the
// WebviewPanelHost component reads it reactively so it renders once the HTML arrives.
import { createSignal } from "solid-js";

const _html = new Map<string, string>();

// A bump counter that reactive contexts subscribe to; increments on any write.
const [_rev, _setRev] = createSignal(0);

export function registerWebviewPanelHtml(id: string, html: string): void {
  _html.set(id, html);
  _setRev((v) => v + 1);
}

export function getWebviewPanelHtml(id: string): string | undefined {
  _rev(); // subscribe
  return _html.get(id);
}

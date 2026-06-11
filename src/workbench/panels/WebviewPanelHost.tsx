// ADR-0026 §4 Tier 2 — Webview panel host.
// Renders extension HTML in a sandboxed null-origin iframe, injects theme CSS vars
// and the acquireSindriApi() bridge, then brokers bidirectional postMessage traffic.
import { onCleanup, onMount, Show } from "solid-js";
import { getWebviewPanelHtml } from "./webview-panel-store";
import { listenExtEvent, deliverWebviewPanelMessage } from "../../extensions/host";

// Injected into every webview before the closing </head> tag.
// Provides acquireSindriApi() — the only surface the webview can reach.
const ACQUIRE_API_SCRIPT = `<script>
window.acquireSindriApi = function() {
  var listeners = [];
  window.addEventListener('message', function(e) {
    if (e.source !== window.parent) return;
    listeners.forEach(function(fn) { try { fn(e.data); } catch (err) {} });
  });
  return {
    postMessage: function(msg) {
      window.parent.postMessage({ __sindri_wp: true, payload: msg }, '*');
    },
    onMessage: function(handler) {
      listeners.push(handler);
    }
  };
};
</` + `script>`;

function buildThemeCssVars(): string {
  const el = document.documentElement;
  const get = (v: string) =>
    el.style.getPropertyValue(v) || getComputedStyle(el).getPropertyValue(v).trim();
  return `<style>:root {
  --sindri-bg: ${get("--bg")};
  --sindri-bg-panel: ${get("--bg-panel")};
  --sindri-fg: ${get("--text")};
  --sindri-text-dim: ${get("--text-dim")};
  --sindri-accent: ${get("--accent")};
  --sindri-border: ${get("--border")};
  --sindri-font-ui: ${get("--font-ui") || "system-ui, sans-serif"};
  --sindri-font-mono: ${get("--font-mono") || "monospace"};
}</style>`;
}

function injectIntoHtml(html: string): string {
  const injection = buildThemeCssVars() + ACQUIRE_API_SCRIPT;
  const i = html.indexOf("</head>");
  if (i >= 0) return html.slice(0, i) + injection + html.slice(i);
  const j = html.indexOf("<body");
  if (j >= 0) return html.slice(0, j) + injection + html.slice(j);
  return injection + html;
}

export function WebviewPanelHost(props: { panelId: string }) {
  let iframeRef!: HTMLIFrameElement;

  const html = () => getWebviewPanelHtml(props.panelId);
  const srcdoc = () => {
    const h = html();
    return h !== undefined ? injectIntoHtml(h) : undefined;
  };

  onMount(() => {
    // Extension → webview: listen for outbound messages on the event bus.
    let unlisten: (() => void) | undefined;
    listenExtEvent(`__sindri.ui.webviewMessage:${props.panelId}`, (payload) => {
      if (!iframeRef?.contentWindow) return;
      try {
        iframeRef.contentWindow.postMessage(JSON.parse(payload), "*");
      } catch {
        iframeRef.contentWindow.postMessage(payload, "*");
      }
    }).then((fn) => {
      unlisten = fn;
    });

    // Webview → extension: forward postMessage calls to the Tauri command.
    function handleMessage(e: MessageEvent) {
      if (e.source !== iframeRef?.contentWindow) return;
      if (!e.data || !e.data.__sindri_wp) return;
      const payload =
        typeof e.data.payload === "string"
          ? e.data.payload
          : JSON.stringify(e.data.payload);
      deliverWebviewPanelMessage(props.panelId, payload).catch(console.error);
    }

    window.addEventListener("message", handleMessage);

    onCleanup(() => {
      window.removeEventListener("message", handleMessage);
      unlisten?.();
    });
  });

  return (
    <Show
      when={srcdoc() !== undefined}
      fallback={
        <div
          style={{
            padding: "16px",
            color: "var(--text-dim)",
            "font-size": "13px",
          }}
        >
          Loading panel…
        </div>
      }
    >
      <iframe
        ref={iframeRef}
        srcdoc={srcdoc()!}
        sandbox="allow-scripts"
        style={{
          width: "100%",
          height: "100%",
          border: "none",
          background: "var(--bg-panel)",
          display: "block",
        }}
      />
    </Show>
  );
}

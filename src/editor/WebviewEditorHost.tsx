// ADR-0028 — per-occurrence webview host for custom editor surface B.
// One instance per occurrence (groupId×bufferId); kept alive via show/hide CSS.
// On mount, triggers resolveCustomEditor via ext_dispatch_event if HTML not yet available.
import { onCleanup, onMount, Show } from "solid-js";
import { getCustomEditorHtml, registerCustomEditorHtml, removeCustomEditorHtml, onCustomEditorRefresh } from "./custom-editor-store";
import { registry, setBufferDirty } from "./buffers"; // setBufferDirty used by dirty listener
import { listenExtEvent, dispatch } from "../extensions/host";

// Shared with WebviewPanelHost — injected into every webview before </head>.
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

interface Props {
  instanceId: string; // occKey(groupId, bufferId)
  bufferId: string;
  viewType: string;
}

export function WebviewEditorHost(props: Props) {
  let iframeRef!: HTMLIFrameElement;

  const html = () => getCustomEditorHtml(props.instanceId);
  const srcdoc = () => {
    const h = html();
    return h !== undefined ? injectIntoHtml(h) : undefined;
  };

  function requestHtml() {
    const uri = registry.buffers[props.bufferId]?.path ?? "";
    dispatch(
      `__sindri.ui.editorOpenRequest:${props.viewType}`,
      JSON.stringify({ uri, instanceId: props.instanceId }),
    ).catch(console.error);
  }

  onMount(() => {
    console.log(`[WebviewEditorHost] mount instanceId=${props.instanceId} viewType=${props.viewType}`);

    // Register ALL listeners before dispatching the request.
    // The editorHtml event can fire very quickly (extension has no async work before
    // setting webview.html), so we must be subscribed before we send the request —
    // especially on reopen where the extension is already warm and responds faster.

    let unlistenHtml: (() => void) | undefined;
    let unlistenRegistered: (() => void) | undefined;

    // Dispatch only after editorHtml listener is confirmed subscribed.
    listenExtEvent(`__sindri.ui.editorHtml:${props.instanceId}`, (html) => {
      console.log(`[WebviewEditorHost] received editorHtml instanceId=${props.instanceId} length=${html.length}`);
      registerCustomEditorHtml(props.instanceId, html);
    }).then((fn) => {
      unlistenHtml = fn;
      // NOW it is safe to request — we will not miss the response.
      if (!getCustomEditorHtml(props.instanceId)) {
        console.log(`[WebviewEditorHost] dispatching editorOpenRequest viewType=${props.viewType}`);
        requestHtml();
      } else {
        console.log(`[WebviewEditorHost] HTML already cached for instanceId=${props.instanceId}`);
      }
    });

    // Startup race: extension registers AFTER we mount — re-request if still no HTML.
    listenExtEvent("__sindri.ui.editorRegistered", (payload) => {
      try {
        const data = JSON.parse(payload) as { viewType: string };
        if (data.viewType === props.viewType && !getCustomEditorHtml(props.instanceId)) {
          console.log(`[WebviewEditorHost] extension registered late — re-requesting`);
          requestHtml();
        }
      } catch { /* ignore malformed payload */ }
    }).then((fn) => { unlistenRegistered = fn; });

    // Version-switch refresh: re-request after upgrade/downgrade.
    const unsubRefresh = onCustomEditorRefresh(props.viewType, () => {
      console.log(`[WebviewEditorHost] version-switch refresh for instanceId=${props.instanceId}`);
      removeCustomEditorHtml(props.instanceId);
      requestHtml();
    });

    // Ext → webview: route outbound messages into the iframe.
    let unlisten: (() => void) | undefined;
    listenExtEvent(`__sindri.ui.editorOutbound:${props.instanceId}`, (payload) => {
      if (!iframeRef?.contentWindow) return;
      try {
        iframeRef.contentWindow.postMessage(JSON.parse(payload), "*");
      } catch {
        iframeRef.contentWindow.postMessage(payload, "*");
      }
    }).then((fn) => { unlisten = fn; });

    // Webview → ext: forward postMessage to extension inbound channel.
    function handleMessage(e: MessageEvent) {
      if (e.source !== iframeRef?.contentWindow) return;
      if (!e.data?.__sindri_wp) return;
      const payload =
        typeof e.data.payload === "string"
          ? e.data.payload
          : JSON.stringify(e.data.payload);
      dispatch(`__sindri.ui.editorInbound:${props.instanceId}`, payload).catch(console.error);
    }

    window.addEventListener("message", handleMessage);

    // Dirty state from extension — update the buffer's dirty flag.
    let unlistenDirty: (() => void) | undefined;
    listenExtEvent(`__sindri.ui.editorDirty:${props.instanceId}`, (payload) => {
      const isDirty = payload === "true" || payload === JSON.stringify(true);
      setBufferDirty(props.bufferId, isDirty);
    }).then((fn) => { unlistenDirty = fn; });

    onCleanup(() => {
      window.removeEventListener("message", handleMessage);
      unlisten?.();
      unlistenHtml?.();
      unlistenRegistered?.();
      unlistenDirty?.();
      unsubRefresh();
      removeCustomEditorHtml(props.instanceId);
      // Do NOT call setBufferDirty here — closeBufferInGroup already called
      // removeBuffer() before this cleanup fires, so writing to the store would
      // recreate an orphaned stub entry that blocks future opens of the same file.
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
            "font-family": "var(--font-mono, monospace)",
          }}
        >
          Loading editor… (waiting for {props.viewType} · check F12 console)
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
          background: "var(--bg)",
          display: "block",
        }}
      />
    </Show>
  );
}

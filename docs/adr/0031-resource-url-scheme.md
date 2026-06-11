# ADR-0031: Resource URL scheme — `sindri-resource://` custom Tauri protocol

- **Status:** Accepted — 2026-06-11
- **Follows from:** [ADR-0025](0025-js-extension-host-deno-v8.md) (Deno/V8 isolate) · [ADR-0026](0026-ui-panel-api.md) (webview panels) · [ADR-0027](0027-exec-capability-security.md) (capability security)
- **Phase:** 1.5a — Extension author DX (unblocks 1.5b dual build pipeline)

---

## Context

Webview panels (ADR-0026 Tier 2) render extension-authored HTML in a sandboxed null-origin `srcdoc` iframe. Currently, `getHtml()` must return all HTML, CSS, and JavaScript as a single inline string. This forces any framework app (React, Svelte, Vue) to inline its entire compiled bundle:

```ts
// Current: 150 KB of React inlined as a template literal
getHtml() {
  return `<!DOCTYPE html><html>...<script>${ENTIRE_BUNDLE}</script></html>`;
}
```

Problems:
1. **DX**: compiled JS can't reference companion files (`webview.css`, split chunks, assets).
2. **Dual build pipeline** (1.5b): esbuild can produce a separate `dist/webview.js` alongside the extension bundle, but there's no URL scheme to reference it from `getHtml()`.
3. **Framework overhead**: React DevTools, HMR, and standard tooling assume file-system-backed URLs.

Two extensions are blocked on this: `sindri-csv-grid` (tabular data panel) and `sindri-color-swatches` (theme preview panel).

### Constraints

- Extension host (V8 isolate) has no DOM; this is purely a webview concern.
- The webview iframe runs at null origin (`srcdoc`). Standard `http://localhost` fetch would require the Tauri dev server to serve dynamic extension assets — coupling dev and prod paths and leaking the dev server into bundled builds.
- Must not allow path traversal out of an extension's registered bundle directory.
- Must not require CSP changes — `tauri.conf.json` already has `"csp": null`; the iframe's `sandbox="allow-scripts"` attribute does not restrict custom URI schemes for `<script src>` / `<link href>`.

---

## Decision

### §1. URL scheme

```
sindri-resource://<ext-id>/<relative/path>
```

Examples:

| URL | Resolves to |
|---|---|
| `sindri-resource://sindri.commit-streak/dist/webview.js` | `<bundle-dir>/dist/webview.js` |
| `sindri-resource://sindri.csv-grid/style.css` | `<bundle-dir>/style.css` |
| `sindri-resource://sindri.csv-grid/assets/logo.svg` | `<bundle-dir>/assets/logo.svg` |

This is the clean pattern for `getHtml()`:

```ts
getHtml() {
  return `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="sindri-resource://sindri.csv-grid/dist/webview.css">
</head>
<body>
  <div id="root"></div>
  <script src="sindri-resource://sindri.csv-grid/dist/webview.js"></script>
</body>
</html>`;
}
```

### §2. Rust implementation

A Tauri custom URI scheme handler registered at startup via `Builder::register_uri_scheme_protocol`.

**Shared state:**

```rust
type ExtBundleDirs = Arc<Mutex<HashMap<String, PathBuf>>>;
```

Managed as Tauri state (`app.manage(ext_bundle_dirs)`). Populated during `ext_activate`.

**Registration at activation time:**

`ext_activate` gains an optional `bundle_dir: Option<String>` parameter. When both `ext_id` and `bundle_dir` are present, the mapping is written into `ExtBundleDirs` before the extension JS runs. This mirrors how the TS side already computes and stores `bundleDir` for icon resolution.

**Handler logic:**

```
1. Parse ext-id from URL host component.
2. Parse relative path from URL path component (strip leading '/').
3. Validate path: reject any component that is '..', absolute, or contains '%'
   (percent-encoding bypass guard; extension bundle files don't use '%').
4. Look up ext-id in ExtBundleDirs → 404 if not registered.
5. Construct absolute path: bundle_dir.join(rel_path).
6. Read file from disk → 404 on I/O error.
7. Infer MIME type from file extension.
8. Return 200 response with Content-Type header.
```

**MIME type inference** (extension → Content-Type):

| Extension | Content-Type |
|---|---|
| `.js`, `.mjs` | `application/javascript` |
| `.css` | `text/css` |
| `.html`, `.htm` | `text/html; charset=utf-8` |
| `.json` | `application/json` |
| `.svg` | `image/svg+xml` |
| `.png` | `image/png` |
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.gif` | `image/gif` |
| `.wasm` | `application/wasm` |
| `.txt` | `text/plain; charset=utf-8` |
| (other) | `application/octet-stream` |

**Security properties:**
- **Read-only**: handler never writes to disk.
- **Registered extensions only**: ext-ids not in `ExtBundleDirs` return 404.
- **No path traversal**: `..` and absolute path components are rejected at the component level before any filesystem access.
- **No URL-decode traversal**: paths containing `%` are rejected to prevent encoded `..` bypass.
- **Synchronous disk read**: acceptable for Phase 1 (dev-speed assets); async I/O can be added in Phase 7 if needed.

### §3. TypeScript exposure

```ts
// @sindri/api — extension authors use this constant in getHtml()
export const SINDRI_RESOURCE_SCHEME = "sindri-resource";
```

`activateExtension(bundlePath, extId?, bundleDir?)` gains the `bundleDir` parameter. `activateExtensionWithManifest` already computes `bundleDir` and passes it through to the Tauri command.

### §4. CSP & sandbox

No CSP changes needed:
- `tauri.conf.json`: `"csp": null` (already no restriction).
- Webview iframe: `sandbox="allow-scripts"` permits subresource loads from custom schemes — it restricts JS capabilities, not URL schemes.

### §5. What this does NOT enable (scope boundary)

- **ES modules with `type="module"`**: module scripts enforce CORS. The `sindri-resource` handler does not set `Access-Control-Allow-Origin`; module loading from this scheme is untested and deferred. Classic scripts and stylesheets work.
- **Fetch API from within the webview**: `fetch("sindri-resource://...")` would be a cross-origin request from null origin and would fail without CORS headers. If needed, add `Access-Control-Allow-Origin: *` to the handler response in a future ADR addendum.
- **HMR / watch mode**: `sindri-resource://` is a static file server, not a dev server. Live-reload during dual build pipeline development (1.5b) requires a separate watch mechanism.

---

## Consequences

### What changes

- **`lib.rs`**: adds `ExtBundleDirs` state type; `ext_activate` gains `bundle_dir: Option<String>`; `Builder::register_uri_scheme_protocol("sindri-resource", ...)` registered at startup.
- **`host.ts`**: `ExtHostClient.activate` and `activateExtension` gain optional `bundleDir` parameter; `TauriExtHostClient` passes it to the Tauri command.
- **`activation.tsx`**: `activateExtensionWithManifest` passes `bundleDir` to `activateExtension`.
- **`@sindri/api` types**: `SINDRI_RESOURCE_SCHEME` constant exported.

### What does NOT change

- Extension bootstrap, event bus, exthost runtime — zero new ops.
- Existing extensions (`sindri-now-playing`, `sindri-commit-streak`) — inline HTML still works; `sindri-resource://` is opt-in.
- Webview bridge (`acquireSindriApi`, `postMessage`) — unchanged.
- `tauri.conf.json` — no new entries needed.

### Costs accepted

- **Synchronous disk I/O in the protocol handler.** Blocking the protocol handler thread for a disk read is a known Tauri limitation. At extension-bundle file sizes (< 500 KB typically), latency is imperceptible at load time. Can be revisited in Phase 7.
- **No CORS headers.** `fetch()` from the webview to `sindri-resource://` will fail. This is an acceptable limitation for Phase 1.5a; the primary use case is `<script src>` and `<link href>`.

### Deferred

- **CORS support** for `fetch()` inside webview panels — add `Access-Control-Allow-Origin: *` if needed.
- **ES module support** — requires CORS headers + `type="module"` verification across WebKit/WebView2.
- **Async I/O** in the protocol handler — Phase 7 if file sizes grow.
- **Installed extension path** (`app_data_dir/extensions/<ext-id>/`, resolved via `app.path().app_data_dir()`) — Phase 1.3 install pipeline will register the installed bundle dir at install time the same way.

---

## See also

- [ADR-0025](0025-js-extension-host-deno-v8.md) — Deno/V8 isolate; no DOM in extension host
- [ADR-0026](0026-ui-panel-api.md) — webview panel Tier 2; `getHtml()` contract
- [ADR-0027](0027-exec-capability-security.md) — capability model; why `sindri-resource` requires no permission gate (read-only, own bundle only)
- [ADR-0030](0030-extension-output-logging.md) — `ext_activate` chain; `bundle_dir` registration follows the same pattern as `ext_id` attribution

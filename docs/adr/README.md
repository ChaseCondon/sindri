# Architecture Decision Records

Each ADR captures one significant decision: the context, the choice, and the consequences we accept. They're append-only history — when a decision changes, write a new ADR that supersedes the old one rather than rewriting it.

Format: lightweight [MADR](https://adr.github.io/madr/).

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-shell-tauri.md) | Shell: Tauri 2 (web UI + Rust core) | Accepted |
| [0002](0002-human-first-not-ai-native.md) | Human-first, not AI-native | Accepted |
| [0003](0003-editor-surface-cm6-plus-webgl2.md) | Editor surface: CodeMirror 6 + tiered WebGL2 | Accepted |
| [0004](0004-frontend-solidjs.md) | Frontend framework: SolidJS | Accepted |
| [0005](0005-builtin-ide-frameworks.md) | Built-in IDE frameworks via protocols (LSP/DAP/Tree-sitter + Sindri Adapter Protocol) | Accepted |
| [0006](0006-extension-api-from-day-one.md) | Extension API from day one (dogfooded JS host; everything is an extension) | Accepted |
| [0007](0007-webgl2-not-webgpu.md) | Rendering API: WebGL2 baseline, WebGPU only as enhancement | Accepted |
| [0008](0008-workspace-model.md) | Workspace model: loose files + projects coexist; polyglot projects are primary | Accepted |
| [0009](0009-remote-execution-environments.md) | Remote execution environments (WSL / containers / SSH) from day one | Accepted |
| [0010](0010-dockable-panel-layout.md) | Dockable, movable panel layout (JetBrains-style) | Accepted |
| [0011](0011-inline-completion-and-suggestions.md) | Inline completion + suggestions (the one day-one AI, as a provider) | Accepted |
| [0012](0012-project-file-format.md) | Project-file format — `sindri.toml` | Accepted |
| [0013](0013-product-identity-and-polyglot-thesis.md) | Product identity (Sindri) and polyglot-first founding thesis | Accepted |
| [0014](0014-sindri-adapter-protocol.md) | Sindri Adapter Protocol (SAP) — run/test adapter interface | Accepted |
| [0015](0015-js-extension-host-runtime.md) | JS extension host runtime — QuickJS Tier 1 + API surface + event bus | Accepted · §1–2 superseded by [0025](0025-js-extension-host-deno-v8.md) |
| [0016](0016-editor-buffer-and-tab-model.md) | Editor buffer & tab model (one view + per-tab EditorState) | Accepted |
| [0017](0017-browser-pwa-target.md) | Browser / PWA target — distribution scope & the core-transport seam | Accepted |
| [0018](0018-split-panes-docking-floating.md) | Editor split panes, advanced sidebar docking, and floating windows | Accepted |
| [0019](0019-theme-and-icon-system.md) | Theme & icon system (theme-as-data, dual UI/editor themes, extension-contributed) | Accepted |
| [0020](0020-extension-distribution-and-marketplace.md) | Extension distribution, manifest & marketplace (git-repo registries) | Accepted · §3 index superseded by [0038](0038-manifest-type-and-id-resolution.md) |
| [0021](0021-settings-surface.md) | Settings surface — core modal overlay over merged plugin config | Accepted |
| [0022](0022-sidebar-panels-as-extensions.md) | Sidebar panels as extensions — all panels except Explorer/Terminal/Output are extension-contributed | Accepted · 2026-06-17 (Phase 1 review) |
| [0023](0023-extension-configuration-contract.md) | Extension configuration contract — `contributes.configuration`, settings storage & generic renderer | Accepted |
| [0024](0024-editor-decorations-api.md) | `sindri.editor` decorations API — static bundled features now, host decoration-providers later | Accepted |
| [0025](0025-js-extension-host-deno-v8.md) | JS extension host runtime — Deno/V8, uniform per-isolate (supersedes 0015 §1–2) | Accepted |
| [0026](0026-ui-panel-api.md) | `sindri.ui` panel & UI surface API — declarative APIs + webview escape hatch; surface taxonomy (A/B/C) | Revised — 2026-06-09 (VNode model → hybrid declarative + webview) |
| [0027](0027-exec-capability-security.md) | Extension capability & exec security model — brokered spawn, arg-vector rule, declared-binary allowlist | Accepted |
| [0028](0028-custom-editor-api.md) | `sindri.ui.registerEditor` — custom editor surface (surface B) | Accepted |
| [0029](0029-editor-overlay-api.md) | Editor overlay & widget API — surface C (extends ADR-0024) | Reserved — seam only |
| [0030](0030-extension-output-logging.md) | Extension output & logging — `sindri.output` API, console auto-capture, Extension Logs panel | Accepted |
| [0031](0031-resource-url-scheme.md) | Resource URL scheme — `sindri-resource://` custom Tauri protocol for extension bundle files | Accepted |
| [0032](0032-extension-templates-inheritance.md) | Extension templates & inheritance — `extends` + `variables`, CSS-custom-property SVG templates | Accepted · §6 superseded by [0038](0038-manifest-type-and-id-resolution.md) |
| [0033](0033-sindri-cli.md) | The `sindri` CLI — Rust binary, `src-tauri` workspace, `sindri-core`, and the `ext` release engine | Accepted |
| [0034](0034-sindri-editor-namespace.md) | `sindri.editor` namespace — document/selection/visible-range proxy + events; hosts ADR-0024 decorations; writes deferred | Accepted |
| [0035](0035-wasm-module-execution.md) | WASM module execution — `sindri.wasm.load()` op + `contributes.wasm` | Accepted |
| [0036](0036-native-binary-bundling.md) | Native binary bundling — `contributes.binaries` + brokered exec resolution | Accepted |
| [0037](0037-extension-inspector-debugging.md) | Extension debugging — V8 Inspector / CDP gateway (on-demand, dev-gated, loopback) | Accepted |
| [0038](0038-manifest-type-and-id-resolution.md) | Manifest `type` taxonomy & id-based registry resolution (supersedes 0020 §3, 0032 §6) | Accepted |
| [0039](0039-project-license.md) | Project license — MIT OR Apache-2.0 (permissive, dual) | Accepted |
| [0040](0040-extension-api-version-gate.md) | Extension API-version gate — `engines.sindri` range check at activate time | Accepted |
| [0041](0041-tree-sitter-syntax-engine.md) | Tree-sitter syntax engine — WASM grammars (wasmtime), single-threaded Rust-core worker, stale-then-reconcile CM6 bridge | Accepted · 2026-06-17 (Phase 2 kickoff) |

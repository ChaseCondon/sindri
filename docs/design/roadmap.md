# Sindri — Feature Roadmap

> Living doc — last updated 2026-06-09. Structured around the end goal from [vision.md](vision.md): **Sindri builds Sindri**, then **Sindri is the best polyglot IDE on the market**. Each phase goes one layer deeper before spreading breadth.

---

## The full arc

```
Phase 1  Extension infrastructure          (current — critical path for everything)
Phase 2  Tree-sitter syntax
Phase 3  Project model + core IDE surfaces
Phase 4  LSP host
Phase 5  SAP / Test runner
Phase 6  DAP / Debug
Phase 7  Extension trust & security hardening   ← must land before self-hosting
Phase 8  sindri.lang.rust + self-hosting        ← "Sindri builds Sindri"
──────── North star reached ──────────────────────────────────────────
Phase 9  Go language support
Phase 10 Git integration + remote environments
Phase 11 Python language support
Phase 12 Java language support
Phase 13 Web / TypeScript / React          (last — web tooling is a mess)
Phase 14 Ecosystem, platform, distribution
```

---

## Phase 1 — Extension infrastructure (current)

> **Why first:** Everything — LSP, test runners, debug, panels, language packs — ships as an extension on the public API. None of Phase 2+ can be done correctly until the exthost API is complete enough to carry them (ADR-0006).

### 1.1 Editor polish (quick wins — do now)

- **Rainbow brackets** — `Decoration.mark` needs `attributes: { style: 'color: <hex>' }` instead of a CSS class. Diagnosed, 30 min.
- **Indent guide opacity** — space-indent branch in `indent-guides.ts:43–48` missing `attributes: { style: 'opacity:...' }`. Same fix. 15 min.

### 1.2 Complete the exthost API

- **`sindri.env.exec` op** — `exec(cmd, args[]) → { stdout, stderr, code }` in the extension JS API. New Rust op + test. Prerequisite for any extension that shells out (cargo test, gopls, pylsp, …).
- **`sindri.env.exec` timeout + kill** — add `{ timeout?: number }` option (auto-kill + error on expiry) and return a `{ stdout, stderr, code, kill() }` handle. Without this, a stalled subprocess hangs the extension host indefinitely.
- **`sindri.ui` panel API (ADR-0026)** — two-tier hybrid, both land this phase: **Tier 1** declarative APIs (`registerTreeView`, `createStatusBarItem` with hover, `showQuickPick`/`createQuickPick`); **Tier 2** webview escape hatch (`registerWebviewPanel` — extension ships HTML/CSS/JS, host injects theme CSS vars). Prerequisite for all ADR-0022 contributed panels and first-party extensions below.
- **`registerTreeView` exthost binding** ⚠️ — the manifest type and ADR-0026 Tier 1 shape are declared but the JS↔Rust Deno op is not wired. `sindri.ui.registerTreeView(id, provider)` needs a Deno op + Rust handler that populates the tree panel from provider callbacks. High severity — blocks every sidebar panel extension until done.
- **`sindri.workspace` API** — `sindri.workspace.readFile(path): Promise<string>`, `writeFile(path, content): Promise<void>`, `listDir(path): Promise<string[]>`. Extensions currently have no direct file access; the only filesystem path is `exec`. Every non-trivial extension (code generators, config writers, file templaters) will need this before it can be built without workarounds.
- **`sindri.ui` notification primitives** ⚠️ — **gap: no toast/notification API exists today.** Add `sindri.ui.showInformationMessage(msg, ...actions)` / `showWarningMessage` / `showErrorMessage`, returning the chosen action (VSCode-shaped). Transient toasts + a notification surface in the chrome. Foundational — every extension that reports success/failure/progress needs it. **Dogfood:** `sindri-ferris-says` fires a startup toast with its saying (see 1.4). Design the toast-vs-persistent-notification-center split when built; extend the ADR-0026 `sindri.ui` surface.
- **`sindri.ui` input/modal primitives** ⚠️ — **gap: only `showQuickPick` exists.** Add `showInputBox(options): Promise<string | undefined>` (text input + validation callback) and a blocking confirm/modal (`showMessageBox` style, returns the chosen action), both modeled on the existing `showQuickPick` blocking + `PendingQuickPicks` pattern. Needed before any extension can prompt for free-form input (rename, new-file name, API key). **Dogfood:** `sindri-rune-oracle` (see 1.4) — validated input box + multi-button modal in one flow.
- **`sindri.events` typed contribution channel** — the generic `sindri.events` bus (`on`/`emit`, untyped string ids) is the current extension↔extension coupling. **Open question for the backlog:** how core surfaces expose *typed* contribution points to extensions (beyond the SAP adapter pattern). For run/test this is already answered by SAP (ADR-0014) — extensions feed the core Test Explorer via `contributes.taskAdapters`, not by touching panel internals. Generalising that "provider registration into a core surface" pattern to other core components is flagged at Phase 5 below; revisit as an ADR when the second core-surface-with-hooks lands.

### 1.3 Extension install pipeline

- **`downloadExtension` — git clone → local bundle path** — implement the `TauriRegistryClient` stub. Shallow-clone tagged extension folder to ``app_data_dir/extensions/<id>/<version>/``, return the absolute bundle path. Unblocks Marketplace one-click install for code extensions.
- **Extension re-activation on startup** — persist `activeBundlePath`; re-call `activateExtension` in `App.tsx` init.

### 1.4 First real extensions (ADR-0006 dogfood)

The extension API is not real until first-party features are built on it. Each sample below is a **"fun extra"** — a standalone POC that exercises one capability tier. They are not core features; core features live in their respective phases. Build each sample as its capability unlocks.

| Sample | Status | API tier validated | What it proves |
|---|---|---|---|
| **`sindri-now-playing`** | ✅ done | `sindri.env.exec` + Tier 1 UI | exec + events + status-bar chip + hover |
| **`sindri-commit-streak`** | ✅ done | Tier 1 + Tier 2 (webview) | `git log` via exec → streak chip (Tier 1) + Svelte heatmap webview (Tier 2) |
| **`sindri-csv-grid`** | ✅ done | Tier 2 + resource URL scheme | React 18 webview loaded via `sindri-resource://`; exercises the 1.5b dual-build pipeline |
| **`sindri-color-swatches`** | ⏳ scaffolded | `sindri.editor` decorator API | Inline CSS color swatch decorations — **validation for 1.5g** `sindri.editor.registerDecorationProvider` |
| **`sindri-token-counter`** | ⏳ scaffolded | WASM module execution | Counts LLM tokens in the active document using a bundled WASM module — **validation for 1.5h** |
| **`sindri-ferris-says`** | ⏳ scaffolded | Native binary bundling **+ notification API** | Calls a bundled Rust binary; renders output in a webview panel (**validation for 1.5i**) **and fires a startup toast with the saying — dogfoods `sindri.ui.showInformationMessage` (1.2)** |
| **`sindri-en-gb`** | ⏳ scaffolded | Localisation API | British English locale — **validation for 1.5j** `sindri.ui.registerLocale` |
| **`sindri-rune-oracle`** | 💡 idea | Input/modal API | Magic-8-ball: validated `showInputBox` ("ask the rune-stone…", must end in `?`) → multi-button `showMessageBox` reveals a mystical answer with **[Ask again] [Accept fate]** — **validation for 1.2 input/modal primitives.** Host-only, no webview, on-brand with the rune-stone identity (ADR-0019) |

> **Minimap is not a sample.** It is a **core-rendered category C overlay** (ADR-0026 §1) — it needs direct CM6 `ViewPlugin` access to doc text, syntax tree, and viewport. It is a first-party core feature (see Phase 3.3 below), not an extension.

### 1.5 Extension author DX

**1.5a — Resource URL scheme (ADR-0031)** — Tauri custom protocol (`sindri-resource://ext-id/path`) that serves files from an extension's bundle directory. Enables webview panels to reference compiled framework apps (`<script src="sindri-resource://...">`) instead of inlining entire bundles as strings. Required for clean React/Svelte/Vue authoring.

**1.5b — Dual build pipeline** — `build-extension.ts` detects a `webview/` directory alongside `src/`, compiles it as a separate bundle to `dist/webview.js`, and puts both outputs in `dist/`. Extensions with only a host `src/` continue to build as today.

**1.5c — Port existing extensions** — Rewrite `sindri-now-playing` and `sindri-commit-streak` webview panels using the dual build pipeline and resource URL scheme. These become the reference implementations for future extensions.

**1.5d — `.sinxt` packaging format** — define the `.sinxt` bundle: `esbuild` output + `manifest.json` + assets zipped (deflate), with no hash in the filename (`<id>-<version>.sinxt`). No signing yet (that's Phase 7) — just a deterministic, self-contained bundle format that can be installed locally. Gives extensions a real artifact to ship. This unblocks 1.5e and 1.5f.

> **Future upgrade (post-Phase 7):** swap deflate entries for zstd compression inside the zip container — better ratio, faster decompression. Blocked on `fflate` zstd support or a JS-side builder swap.

**1.5e — Marketplace download + install pipeline** — implement `TauriRegistryClient.downloadExtension` as a two-stage fallback: (1) fetch pre-built `.sinxt` from the registry's GitHub Release asset for the matching version tag; (2) `gix` sparse-checkout of just the extension's subfolder to retrieve a committed `dist/<id>-<version>.sinxt`, no runtime build step. Installed artifact lives at `app_data_dir/extensions/<id>/<version>/<id>-<version>.sinxt`. Runtime reads directly from the zip — no disk extraction. New Rust command `ext_activate_sinxt` + zip-aware `sindri-resource://` handler. Release tag convention: `{id}-v{semver}` per extension; nightly uses a rolling `nightly` release with `{id}-nightly.sinxt` assets.

**1.5f — Local `.sinxt` install UI** — replace the current "Active Extension" dev-only `.js` file picker in Settings with a proper "Install from file…" flow that accepts a `.sinxt` package. This is the first real user-facing install surface and the direct path for developers to test their own extensions without publishing.

**1.5g — `sindri.editor` decoration provider API (ADR-0024 Model B)** — implement `sindri.editor.registerDecorationProvider` in the V8 host and the generic core `ViewPlugin` that paints marshalled `DecorationDatum[]`. Validation: `sindri-color-swatches` contributes inline color swatch decorations on CSS property values. Reach for **Opus** for the IPC boundary / snapshot design.

> **Surface B note — editor view extensions (custom tabs):** The `registerEditor` seam (ADR-0028) reserves the API for extensions that open in an editor tab alongside code files (e.g. image viewer, markdown preview, CSV editor). There is no sample extension for this yet — the first one (`sindri-markdown-preview` or similar) will be built when the `registerEditor` API lands in Phase 3.3. Until then, all extension-contributed panels use the dock-panel surface (`registerWebviewPanel`).

**1.5h — WASM module execution** — V8 host can load and instantiate a `.wasm` file bundled in the extension's `dist/` directory via `sindri.env.loadWasm(path)` (or native `WebAssembly.instantiate` if V8/deno_core exposes it already). Validation: `sindri-token-counter` bundles a tiktoken WASM module, counts tokens in the active document, shows count in a status-bar chip.

**1.5i — Native binary bundling** — extension ships a platform-native binary in `bin/<target>/`, declares it in the manifest under `contributes.binaries`, and the runtime resolves `sindri.env.exec` calls to the declared binary path. Validation: `sindri-ferris-says` bundles a compiled `ferris-says` Rust binary and renders its ASCII art in a webview panel.

**1.5j — Localisation API** — `sindri.ui.registerLocale(locale, translations)` — extension provides a partial `Record<string, string>` keyed to Sindri UI string IDs; untranslated keys fall back to `en-us`. Validation: `sindri-en-gb` translates US English strings to British English spelling. This is also the reference for third-party language packs.

**1.5k — V8 Inspector / DevTools attach** — wire `deno_core`'s inspector to a WebSocket (`ws://localhost:9229`). Has real unknowns in the `deno_core` inspector API — reach for **Opus** if it goes hairy.

**1.5l — Extension CLI: `sindri ext`** — `sindri ext create --template <host-only|react-webview|svelte-webview>` generates the directory structure, `tsconfig.json`, `manifest.json`, and `package.json` with `bun run build` and `bun run dev` scripts. `sindri ext build [path]` wraps `build-extension.ts` as a proper named command. The ported extensions from 1.5c are the reference implementations; every generated extension ships `bun run build` and `bun run dev` as first-class scripts so authors never have to read the build internals.

**1.5m — Extension hot-reload / watch mode** — `sindri ext build --watch` (equivalently `bun run dev` in the generated `package.json`) recompiles on source change and sends a reload signal to the running extension host, triggering a `deactivate` → `activateExtension` cycle on the affected extension without an IDE restart. The Rust side needs a small file-watcher event → reload command. This is the inner loop for extension authoring — without it, the edit→test cycle requires a full IDE restart every time.

**1.5n — Icon theme inheritance: `extends` + `variables` (ADR-0032)** — runtime reads `extends` and `variables` from a child icon theme's manifest; the extension registry resolves the base, deep-merges `icons.json` (child-wins), and injects `<style>:root { --folder-base: …; --semantic-N: … }</style>` at activation. Renderer must inline template SVGs (not `<img>`) for CSS vars to resolve across the shadow boundary. Collapses the community icon themes from ~750 generated SVGs to 46 shared SVGs + per-theme palette manifests.

**1.5o — `folderNamesExpanded` icon theme field** — file tree renderer reads `folderNamesExpanded` (alongside `folderNames`) from `icons.json`; when a folder is expanded it uses the per-type open icon ID rather than always falling back to `defaults.folderOpen`. Required for per-type open folder icons (e.g. an expanded `tests/` folder shows a red outline folder, not the default blue). One schema field + one renderer lookup. Unblocks the full filled-closed / outline-open folder type system in sindri-file-icons.

**1.5p — Icon theme marketplace previewer** — the extension detail panel in the Marketplace shows a grid of representative icons from the set with a search bar that filters by icon name/keyword (e.g. typing "ts" highlights the TypeScript file icon, "folder" shows all folder variants). Sourced from `icons.json` at preview time; no runtime install required to browse. The grid should show file icons, folder icons (closed and open), and UI icons (if a UI pack is bundled). Pairs with 1.5n (inheritance) so inherited themes also render correctly in the previewer.

**1.5q — Extended colour theme previewer** — colour theme manifests gain an optional `previews` field (already on `ThemeContribution`) allowing per-language sample code to be supplied directly in the manifest. Additionally, the detail panel exposes a language dropdown so users can switch the preview snippet between all contributed languages (TypeScript, Rust, Python, etc.) without the theme author having to hardcode them all. Default baked-in snippets remain as fallback. Complements 1.5p — both theme and icon themes get rich preview surfaces.

> **Webview sandbox — by design:** Extension webviews run in a null-origin `<iframe>` with no access to `sindri.*` APIs. All data exchange goes through `postMessage`. This is intentional: the sandboxed iframe is the security boundary that keeps webview code out of the host process. It also means `sindri.env.exec` is deliberately unavailable inside webviews — extensions that need exec results in their webview must call exec in the host script and relay the output via `postMessage`. Document this pattern clearly in CONTRIBUTING.md and the scaffold template's generated README.

---

## Phase 2 — Tree-sitter syntax

> **Why here:** Language-agnostic means syntax works for *any* language without a per-language extension. Tree-sitter is the unlock for the grammar long tail beyond what CM6/Lezer ships.

- **Tree-sitter Rust binding** — embed `tree-sitter` crate in Rust core. Incremental `parse(languageId, text, edits[]) → highlights[]` over Tauri IPC.
- **CM6 decoration bridge** — inject highlight spans as CM6 decorations. Async: render stale tokens immediately, reparse in Rust, reconcile. Never blocks a scroll frame (ADR-0003 hard constraint).
- **Grammars: TypeScript + Rust first** — validates the bridge. TypeScript because Sindri itself is TypeScript; Rust because it's the first language pack.
- **Grammar loader** — extension contributes a grammar via `contributes.grammars[].path`; the loader fetches the WASM and registers it with the Rust bridge.

---

## Phase 3 — Project model + core IDE surfaces

> **Why here:** `sindri.toml` scopes settings, auto-installs extensions, and defines environments. Terminal, search, and a real dockable layout are needed before the IDE is usable for real development work.

- **`sindri.toml` detection and parsing** (ADR-0012) — detect at folder open; parse `[project]`, `[environments]`, `[toolchains]`, `[run]`, `[test]`, `[extensions]`. Auto-write `.sindri/.gitignore`. Implicit projects (no `sindri.toml`) stay valid.
- **Terminal panel** — OS shell via Tauri PTY. Profiles: WSL, bash, zsh, PowerShell, fish. Tab bar, multiple sessions. Needed for the build loop.
- **Split panes v0.2** (ADR-0018) — `DockId` migration to support left/right primary + secondary rails, bottom + top dock. Tool-window drag between all zones.
- **Content search** — `grep-searcher` + `grep-regex` in Rust core, streamed to a Search panel. File-glob + regex filter. Results click-to-navigate.
- **Fuzzy file finder** — indexed file-name search across the workspace tree (`cmd+P` / `ctrl+P`). Separate from symbol search (which needs LSP); this is a pure filesystem scan with fuzzy ranking.
- **Symbol search** — workspace symbol index (fed by LSP `workspace/symbol` once Phase 4 lands). Command-palette integration.

### 3.3 Core built-in features (surfaces B + C)

These are **first-party core features expected of an IDE** — not extension samples. They ship when the relevant surface APIs and infrastructure are ready; they are listed here so they are in the north-star scope and not accidentally punted to "maybe someday."

**Surface B — editor-area / custom editors** (ADR-0028 `registerEditor` seam):

| Feature | File type / trigger | Notes |
|---|---|---|
| **Image viewer** | `.png`, `.jpg`, `.gif`, `.svg`, `.webp`, `.ico` | Zoom, fit-to-panel; no edit needed |
| **Markdown preview** | `.md`, `.mdx` | Side-by-side or split; GFM + syntax highlighting |
| **SQLite browser** | `.db`, `.sqlite`, `.sqlite3` | Table explorer + read-only query; `sindri.env.exec` → sqlite3 CLI or Rust binding |

**Surface C — editor overlays** (ADR-0029 / ADR-0024 decoration extension):

| Feature | What |
|---|---|
| **Minimap** | Core-rendered viewport overview (Canvas 2D v0; WebGL2 later — ADR-0003). Category C per ADR-0026 §1 |
| **Git blame gutter** | Per-line author + commit date, inline on hover. Feeds Phase 10 Git integration |
| **TODO / FIXME highlight** | Regex-matched inline annotations; configurable patterns |

**Compute features:**

| Feature | What |
|---|---|
| **Diff engine** | Structural text diff; feeds Git integration (Phase 10) merge views and diff panels |

---

## Phase 4 — LSP host

> **Why here:** Intelligence (completions, hover, diagnostics, go-to-def) is the single biggest reason people choose an IDE over a text editor. One language end-to-end before generalizing.

- **LSP host in Rust** — `async-lsp` / `lsp-types`. Manages language-server processes; owns the JSON-RPC hot path.
- **`sindri.lsp.registerServer` op** — extension calls this; Rust core owns spawning + routing.
- **rust-analyzer end-to-end** — `textDocument/completion`, `hover`, `definition`, `references`, `rename`, `publishDiagnostics`, `signatureHelp`, `workspace/symbol`.
- **IntelliSense popup** — CM6 completion system, non-blocking, debounced. Icons per item kind. Docs side-panel on hover (ADR-0011).
- **Diagnostics panel** — problem list, gutter markers, squiggles.
- **Inline completion / ghost text** — `InlineCompletionProvider` interface; first provider is LSP-driven (ADR-0011). AI provider is a later opt-in drop-in, not a core dependency.

---

## Phase 5 — SAP / Test runner

> **Why here:** "Built-in IDE frameworks for run/test" is the product wedge (vision §3). A beautiful, consistent test UI that works identically across languages is the thing neither VSCode nor Zed delivers.

- **SAP implementation** (ADR-0014) — `discover`, `plan`, `onOutput`, `onExit`, `debugConfig` adapter contract. Rust core owns process spawning; adapters are pure JS.
- **`sindri.tasks.registerAdapter` op** — extension registers a SAP adapter.
- **Test runner UI panel** — tree of suites + cases, run / run-all / run-failed, live streaming output, pass/fail gutter markers, click-to-jump on failure, timing.
- **Run configurations UI** — launch config picker, environment variable editor, working directory.
- **`cargo-test-adapter`** — `cargo test -- --list` discovery, streaming output, inline gutter results. **Rust end-to-end: edit → run tests → see results inline.** (This is the real adapter; there is no Phase 1 skeleton — `sindri-now-playing` is the Phase 1 exec smoke test.)

> **Contribution-point pattern — generalize when the second case lands.** The Test Explorer is the **canonical example of "core-rendered surface, extension-fed via a typed provider contract."** An extension hooks into it by contributing a SAP adapter (`contributes.taskAdapters`), never by reaching into panel internals — the panel is core, the *provider* is the extension. SAP (ADR-0014) is the run/test-specific instance of this. DAP (Phase 6, `registerAdapter`) will be the second. **When the third core-surface-with-extension-hooks appears, write an ADR generalizing the "provider registration into a core surface" pattern** so each new core panel doesn't reinvent its own contribution shape. Until then, SAP + DAP are the reference instances; don't over-abstract early.

---

## Phase 6 — DAP / Debug

- **DAP host in Rust** — parallel to the LSP host. Manages debug adapter processes, JSON-RPC routing, breakpoint registry.
- **`sindri.dap.registerAdapter` op** — extension registers an adapter.
- **Debug UI** — call stack panel, variables + watch panel, breakpoints panel, gutter breakpoint markers (click to toggle), step over / into / out / continue controls, exception display.
- **CodeLLDB integration** — Rust + C/C++ debug end-to-end via `sindri.lang.rust`.

---

## Phase 7 — Extension trust & security hardening

> **Why before self-hosting:** Sindri self-hosting (Phase 8) is the moment the extension ecosystem becomes real and credible. Shipping a marketplace-ready trust model *before* that milestone means the architecture is honest at the north-star, not patched in after. All three pillars — OS sandbox, signing, Workspace Trust — must be in place before community extensions exist. Extracted from the original Phase 13 scope.

- **Untrusted-process OS sandbox** (ADR-0025 §4) — each community extension runs in its own isolated child process with a seccomp syscall filter, PID namespace, and resource limits. The Deno/V8 isolate remains the language sandbox; the OS process is the system-level sandbox. First-party extensions are exempt (trusted path); the enforcement kicks in for unsigned/community code.
- **Extension signing + verification** (ADR-0020) — publisher keypairs, `SHA-256` bundle signing, verifier on install. Trust levels: Sindri-signed (first-party) → community TOFU → unsigned warning. The `.sinxt` packaging pipeline groundwork lands here (the full marketplace backend is Phase 14).
- **Workspace Trust UI** — "Do you trust the extensions in this workspace?" prompt on first open of an unrecognized workspace. Restricts exec and net permissions for untrusted workspaces until the user grants trust.
- **Marketplace trust chain** — the broker's allowlist enforcement (ADR-0027) is validated against the signed manifest; a tampered `manifest.json` fails signature verification before the allowlist is even consulted.

---

## Phase 8 — `sindri.lang.rust` + self-hosting

> **Why here:** The language pack is the forcing function that proves the full stack is real. `sindri.lang.rust` must ship as a true first-party extension using only the public API — no private shortcuts (ADR-0006). If it works, the architecture is proven.

- **`sindri.lang.rust`** — bundled extension pack containing:
  - `sindri.rust.lsp` — rust-analyzer, registered via `sindri.lsp.registerServer`
  - `sindri.rust.dap` — CodeLLDB, registered via `sindri.dap.registerAdapter`
  - `sindri.rust.grammar` — tree-sitter-rust WASM, contributed via `contributes.grammars`
  - `sindri.rust.tasks` — cargo build / test / run SAP adapter
  - `sindri.rust.config` — Clippy, rustfmt settings wired to `configStore`
- **Project setup wizard** — launch screen: recent projects, "New project" templates (contributed by extensions), "Clone from git". Floating window (ADR-0018 v0.3).
- **`sindri` CLI** — `sindri open [path]` opens a project from the terminal (`code .` equivalent). `sindri ext create/build/install` are the extension authoring tools (scaffold and build land in 1.5l; `install <url-or-path>` lands here, consuming the `.sinxt` pipeline from 1.5d/e). Distributed with every platform package; shell integration added to macOS/Linux/Windows installers. This is the terminal-native entry point for the daily loop — no Finder/Explorer required.
- **`sindri ext init-ci`** — scaffolds `.github/workflows/{pr-check,release,nightly}.yml` in an extension repo, configured to call the Sindri-owned reusable workflow (see 14.1). Detects single-extension vs. monorepo layout, installs Changesets, sets branch protection via `gh`. Zero config for the author: run once, push, done. Ships bundled in the Phase 8 `sindri` CLI.
- **🏁 Self-hosting milestone** — Sindri's own codebase (Rust + TypeScript) developed entirely inside Sindri: rust-analyzer LSP on both layers, `cargo test` in the test panel, push via Git integration. **Proof of the polyglot promise.**

---

## Phase 8.5 — Release pipeline (north-star closure)

> **Why here:** Phase 8 proves the architecture — Sindri can develop itself. This phase closes the loop: a change committed and tagged from within Sindri propagates as a signed, auto-updating release to every running instance. Without this, self-hosting is a demo. With it, it's a product.
>
> **The milestone:** `git push --tag v0.x.y` from inside Sindri → CI builds and signs all platform packages → update manifest published → every running Sindri prompts to update and applies it without manual intervention.

### Platform installers

Tauri 2 `tauri build` in a CI matrix (macOS / Windows / Linux runners) produces:

| Platform | Artifact |
| --- | --- |
| macOS arm64 + x64 | Signed + notarized `.dmg` |
| Windows x64 | Signed `.msi` (silent upgrades) + `.exe` NSIS installer |
| Linux | `.deb`, `.rpm`, `.AppImage` (universal, no root) |

### Code signing

Required before any installer can be distributed without OS security warnings:

- **macOS** — Apple Developer ID certificate + notarization via `notarytool`. Gatekeeper blocks unsigned `.dmg` downloads outright.
- **Windows** — EV code signing certificate. Avoids SmartScreen "Windows protected your PC" warning on first run.
- **Tauri updater** — Ed25519 keypair (`tauri signer generate`). Private key stored as a CI secret; public key embedded in the binary at build time. All update bundles must pass signature verification before being applied.

### Auto-update infrastructure (`tauri-plugin-updater`)

1. App calls `updater.check(endpoint)` on startup (and periodically in the background).
2. Endpoint returns a JSON manifest — auto-generated by CI after each release tag:
   ```json
   {
     "version": "0.2.0",
     "pub_date": "2026-09-01T00:00:00Z",
     "platforms": {
       "darwin-aarch64": { "signature": "…", "url": "https://…/Sindri_0.2.0_aarch64.dmg" },
       "windows-x86_64": { "signature": "…", "url": "https://…/Sindri_0.2.0_x64-setup.exe" },
       "linux-x86_64":   { "signature": "…", "url": "https://…/Sindri_0.2.0_amd64.AppImage" }
     }
   }
   ```
3. App shows update toast → user accepts → downloads bundle → verifies Ed25519 signature → applies:
   - **macOS** — replaces `.app` via a privileged helper, relaunches.
   - **Windows** — launches new NSIS installer, exits current process.
   - **Linux AppImage** — replaces binary in-place, relaunches.

### CI/CD release pipeline

```
developer: git tag v0.x.y && git push --tags   (from within Sindri)
    ↓
GitHub Actions: matrix [macos-latest · windows-latest · ubuntu-latest]
    ↓ each runner:
    bun run build          ← Vite frontend
    bun tauri build        ← Rust binary + OS installer
    sign artifact          ← OS-level signing (Apple ID / Windows cert)
    upload to GitHub Release
    ↓ post-matrix:
    generate update.json   ← version + per-platform URLs + Ed25519 signatures
    publish to CDN / GitHub Pages
    ↓
running Sindri instances:  poll → see new version → prompt → apply → relaunch
```

### App directory contract

Before public beta, the settings format must be versioned so future breaking changes can be migrated rather than silently corrupting user config. Define a `"sindriVersion"` field in `settings.json`; migration functions run on startup when the stored version is older than the current one.

Extension install path: `app_data_dir/extensions/<id>/<version>/` (resolved via `app.path().app_data_dir()` — see CLAUDE.md for platform breakdown).

### `sindri` CLI packaging

The CLI (`sindri open`, `sindri ext`) built in Phase 8 ships bundled into every platform installer. The installer registers it as a shell command: `$PATH` entry on macOS/Linux, `%PATH%` on Windows. No separate download.

---

## Phase 9 — Go language support

> **Why Go next:** Go is the closest mental model to Rust — static, compiled, excellent tooling, strong CLI culture. `gopls` and `Delve` are both mature and well-documented. The SAP pattern maps cleanly from `cargo test` → `go test`. Low infrastructure surprises; validates that the language pack pattern generalises.

- **`sindri.lang.go`** — bundled extension pack:
  - `sindri.go.lsp` — gopls (`gopls` binary on PATH). `textDocument/completion`, hover, definition, references, rename, `workspace/symbol`, inlay hints.
  - `sindri.go.dap` — Delve via `dlv dap`. Goroutine-aware call stack.
  - `sindri.go.grammar` — tree-sitter-go + tree-sitter-gomod WASM.
  - `sindri.go.tasks` — `go test ./...` discovery + streaming, `go build`, `go run`. Module-aware: detects `go.mod`.
  - `sindri.go.config` — `gofmt` on save, `staticcheck` / `golangci-lint` integration.
- **Multi-root workspace validation** — Go workspaces (`go.work`) often span multiple modules. Validates that `sindri.toml` + the LSP host handle multi-root correctly.

---

## Phase 10 — Git integration + remote environments

> **Why here (between Go and Python):** By Phase 9 we're doing real multi-language development inside Sindri. The missing pieces for a complete dev loop are committing/pushing and working in non-local environments (WSL is huge for Windows developers targeting Linux). These are cross-language and unblock all remaining language packs.

### 10.1 Git integration panel

- **Status + staging** — file-level diff view, stage/unstage hunks, discard.
- **Commit** — commit message editor, amend, sign-off.
- **Branch management** — create, checkout, merge, rebase (basic). Branch list sidebar.
- **Push / pull / fetch** — remote tracking, ahead/behind indicator in status bar.
- **Blame + log** — inline blame gutter, file log, `git log --oneline` timeline.
- **Conflict resolution** — three-way diff view for merge conflicts; accept-ours / accept-theirs / manual.

> Git integration ships as a contributed panel extension (`contributes.panels`) — exercises ADR-0022 on a first-party panel.

### 10.2 Remote environments — WSL (ADR-0009)

- **WSL `Environment` impl** — second implementation of the `Environment` trait after `LocalEnvironment`. File IO, process spawning, path translation all run inside the WSL distro.
- **`sindri.toml` environment declaration** — `[environments.dev] type = "wsl" distro = "Ubuntu-22.04"`.
- **Path seam** — Windows ↔ WSL path translation (`/mnt/c/...` ↔ `C:\...`). Already reserved in the trait; implementation lands here.
- **UX** — environment picker in status bar, indicator of active environment in title bar.

---

## Phase 11 — Python language support

> **Why Python third:** Python has excellent, mature LSP (`basedpyright`) and DAP (`debugpy`) tooling. The main complexity is virtual environment management — detecting `venv`, `conda`, `uv`, `poetry` — which exercises project-model integration more deeply than Rust or Go did.

- **`sindri.lang.python`** — bundled extension pack:
  - `sindri.python.lsp` — basedpyright (preferred) or pylsp fallback. Type checking, imports, hover, completions.
  - `sindri.python.dap` — debugpy. Launch configs: script, module, Django/Flask server.
  - `sindri.python.grammar` — tree-sitter-python WASM.
  - `sindri.python.tasks` — pytest discovery (`pytest --collect-only -q`), streaming run, parametrized test support. Also: `uv run`, `python -m`, script runner.
  - `sindri.python.config` — `ruff` (format + lint), `mypy` / `pyright` type error integration, interpreter selector.
- **Virtual environment detection** — `venv/`, `.venv/`, `conda`, `poetry.lock`, `uv.lock`. Auto-select interpreter per project. Exposed via `sindri.toml` `[toolchains.python]`.
- **REPL integration** — `python -i` / `ipython` in a dedicated terminal tab, send-selection-to-REPL keybind.

---

## Phase 12 — Java language support

> **Why Java fourth:** Java has mature LSP and DAP tooling, but the build system complexity (Maven multi-module, Gradle) is meaningfully higher than the systems languages. Eclipse JDT LS has quirks (slow first import, classpath management). Worth validating Python's simpler model before tackling this.

- **`sindri.lang.java`** — bundled extension pack:
  - `sindri.java.lsp` — Eclipse JDT Language Server. Completions, hover, go-to-def, rename, organize imports, `workspace/symbol`. Classpath + SDK management surface in settings.
  - `sindri.java.dap` — java-debug (vscode-java-debug adapter). Launch + attach modes.
  - `sindri.java.grammar` — tree-sitter-java WASM.
  - `sindri.java.tasks.maven` — Maven adapter: goal discovery from `pom.xml`, `mvn test` streaming, `mvn package`. Multi-module aware.
  - `sindri.java.tasks.gradle` — Gradle adapter: task discovery via `./gradlew tasks`, `gradle test`, streaming. Gradle wrapper detection.
  - `sindri.java.config` — `google-java-format` / `palantir-java-format` on save, Checkstyle integration.
- **JDK management** — detect installed JDKs, allow pinning per-project in `sindri.toml`. Surfaces a "Install JDK" prompt when missing.
- **Multi-module project validation** — Maven multi-module and Gradle multi-project are common in Java. Validates that the project model and LSP host handle cross-module go-to-def correctly.

---

## Phase 13 — Web / TypeScript / React

> **Why last:** The user said so, and they're right. Web tooling is fragmented across package managers (npm / yarn / pnpm / bun), bundlers (vite / webpack / esbuild / rollup), test runners (vitest / jest / playwright / cypress), and framework flavours (React / Vue / Svelte / Solid — ironic given Sindri itself uses Solid). The LSP and DAP stories are good (`vtsls`, `js-debug`); the task adapter story requires covering multiple combinatorial paths. Worth having all the infrastructure solid before tackling the surface area.

- **`sindri.lang.web`** — bundled extension pack:
  - `sindri.web.lsp` — vtsls (TypeScript language server wrapper). JavaScript + TypeScript + JSX/TSX. ESLint LSP integration (inline lint errors without a separate pass).
  - `sindri.web.dap` — js-debug (Microsoft's JS/TS debugger). Chrome, Node, Deno launch configs. Source map support (already proven in the exthost).
  - `sindri.web.grammar` — tree-sitter-typescript + tree-sitter-tsx + tree-sitter-javascript WASM. CSS/SCSS grammar as a bonus.
  - `sindri.web.tasks.npm` — `npm test` / `npm run build` task adapter. `package.json` scripts discovery.
  - `sindri.web.tasks.bun` — `bun test` adapter. Bun's test runner output format.
  - `sindri.web.tasks.vitest` — vitest adapter. `vitest --reporter=json` streaming, watch mode.
  - `sindri.web.tasks.jest` — jest adapter. `--testNamePattern`, `--testPathPattern`, watch mode.
  - `sindri.web.config` — Prettier / ESLint / Biome on save, TSConfig awareness, `tsconfig.json` path alias resolution surfaced in LSP.
- **Framework-specific niceties** — React JSX prop completions, Svelte component completion (via vtsls plugins). Vue deferred (separate grammar + LSP).
- **Browser debug launch** — `js-debug` + Chrome DevTools Protocol for browser-side debugging, not just Node.

---

## Phase 14 — Ecosystem, platform, distribution

> **Why here:** By Phase 13 Sindri supports the five most common polyglot stacks. This phase expands platform reach, opens the extension ecosystem to the community at scale, and targets additional environments. Extension trust & security (signing, sandboxing, Workspace Trust) landed in Phase 7 — this phase adds the marketplace backend and community-pack curation on top of that foundation.

### 14.1 Full extension marketplace backend

- **Marketplace backend** — first-party hosted index with install counts, ratings, verified publisher badges. Replaces the current git-repo-only model for the main marketplace. (`.sinxt` signing + the trust chain itself landed in Phase 7.)
- **Sindri-owned reusable GitHub Actions workflow** — `sindri-labs/sindri-ext-pipeline/.github/workflows/release.yml`. Extension authors call it with a single `uses:` line; all detection, Changesets version bumping, `.sinxt` building, and Release creation is centralised. Pipeline model: single `main` branch, Changesets for explicit bump declarations, PR-based prereleases, Changesets version PR as the stable release gate. Nightly: one rolling repo-level release, per-extension assets. Called by `sindri ext init-ci`.
- **Extension update notifications + auto-update** — on startup: silently download and install any newer `.sinxt` for installed extensions (two-stage: Release asset → committed artifact). On a 4-hour timer: check only, surface an "updates available" badge in Marketplace settings. Nightly update check compares Release asset `Last-Modified` header against local file mtime. Old versioned `.sinxt` files GC'd on startup (keep latest two, delete older).
- **Community pack curation** — featured packs, editorial collections, verified publisher tier.

### 14.2 Remote environments (containers + SSH)

- **Docker / devcontainer `Environment` impl** — spin up a container from `devcontainer.json` or a `sindri.toml` `[environments]` block. All toolchain execution (LSP servers, test runners, debug adapters) runs inside the container.
- **SSH `Environment` impl** — connect to a remote host; file IO and process spawning tunnel over SSH. Targets cloud VMs, bare-metal dev boxes.
- **Environment indicator + switcher** — status bar shows active environment; click to switch or open a new terminal in a different environment.

### 14.3 Platform maturity

- **Floating windows v0.3** (ADR-0018 §4) — tool windows tear off into native Tauri OS windows. Settings modal promotes to float.
- **WebGL2 glyph-atlas renderer** (ADR-0003) — GPU overlay for large-file scroll past a size/velocity threshold. Minimap rendered on GPU surface. Switches back to CM6 for interactive editing.
- **Workspace-recommended extensions** — `.sindri/extensions.json` auto-prompt on folder open.
- **AI assistant panel** — opt-in, extension-contributed, provider-agnostic. Ships after the extension API is proven real and solid. Claude Code CLI in a terminal tab is the quick win; a native `@anthropic-ai/sdk` extension is the target (ADR-0002, ADR-0006).
- **Mobile (Tauri mobile)** — resolve the `cdylib` / V8 TLS incompatibility noted in HANDOVER. iOS + Android targets. Deferred until the desktop story is complete.

### 14.4 Additional language packs (community + first-party)

Once the template is proven and the marketplace is open, additional language packs follow the same pattern. Ordered by ecosystem size and tooling maturity:

| Language | LSP | DAP | Tree-sitter | SAP adapter |
|---|---|---|---|---|
| **C / C++** | clangd | CodeLLDB / cpptools | tree-sitter-c + tree-sitter-cpp | CMake, make |
| **Kotlin** | kotlin-language-server | kotlin-debug-adapter | tree-sitter-kotlin | Gradle, Maven |
| **Swift** | sourcekit-lsp | lldb-dap | tree-sitter-swift | swift test, Xcode |
| **Ruby** | ruby-lsp / solargraph | rdbg | tree-sitter-ruby | RSpec, Minitest |
| **C#** | OmniSharp / roslyn | netcoredbg | tree-sitter-c-sharp | dotnet test |
| **Zig** | zls | lldb-dap | tree-sitter-zig | zig build, zig test |
| **Lua** | lua-language-server | local-lua-debugger | tree-sitter-lua | busted |
| **Vue** | Volar / vue-language-server | js-debug | tree-sitter-vue | vitest |

---

## Language pack anatomy (reference)

Every language pack follows this structure — established in Phase 8, replicated in every phase after:

```
sindri.lang.<name>/
  manifest.json          — extension pack, lists member extension IDs
  sindri.<name>.lsp/     — LSP adapter (sindri.lsp.registerServer)
  sindri.<name>.dap/     — DAP adapter (sindri.dap.registerAdapter)
  sindri.<name>.grammar/ — contributes.grammars[] WASM
  sindri.<name>.tasks/   — SAP task adapters (sindri.tasks.registerAdapter)
  sindri.<name>.config/  — contributes.configuration schema
```

No pack gets a private API shortcut. If the public API can't express what a first-party pack needs, the API is wrong — fix the API (ADR-0006).

---

## Editor polish (any time — no phase dependency)

| Feature | What | Effort |
|---|---|---|
| Dirty tab indicator | `buf.dirty → "•"` in tab strip (already in titlebar) | Trivial |
| Fold / collapse | CM6 `foldGutter` extension | Low |
| Styled dirty-close confirm | Replace `window.confirm` with a modal (ADR-0016) | Low |
| Breadcrumbs | File path + symbol path bar above editor | Low |
| Minimap (static) | Canvas 2D overview; no GPU path needed for v0 | Medium |
| Sticky scroll | Keep the enclosing scope header visible while scrolling | Medium |
| Multi-cursor enhancements | Column select, find-all-occurrences → cursors | Medium |

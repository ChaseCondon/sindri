# ADR-0019: Theme & icon system (theme-as-data, dual UI/editor themes, extension-contributed)

- Status: Accepted
- Date: 2026-06-03
- Extends: [ADR-0006](0006-extension-api-from-day-one.md), [ADR-0015](0015-js-extension-host-runtime.md)
- Companion guide: [docs/design/theming.md](../design/theming.md) — the standing token rules all UI work follows

## Context

Sindri needs first-class **color themes** (light + dark, plus syntax theming) and a **file/folder icon set with full language recognition** (monochrome + coloured). Per ADR-0006 these cannot be hard-coded internals: "everything is an extension," and the day-one themes/icons must ship through the *same* contract a third party would use, or the contract isn't real.

Three product requirements shape the design:

1. **Pluggable from day one.** Users pick themes and icon themes; third parties contribute more. The registry + selection model is built correctly now even though only the built-ins ship first.
2. **Decoupled UI vs. editor theming.** Many developers love a chrome theme but dislike its editor syntax colors (and vice-versa). The editor surface must be independently themeable, defaulting to the UI theme but unlock-able to any other theme.
3. **Icon themes are a peer of color themes**, not a one-off. The same data-contract + registry + extension-API treatment applies. The contract must *also* reserve room for theming the product/UI icons (activity bar, dock bars, toolbar glyphs) later — the shape is defined now; UI-icon theming is **not implemented in this ADR**.

The visual identity is anchored by the Sindri rune-stone mark (`sindri_icons.png`): an electric **azure rune-blue** with a luminous **glow**, on cool **stone** neutrals over an **indigo-tinted** dark base. That palette and the glow treatment are lifted into the token system so the UI echoes the brand.

## Decision

### 1. A theme is **data, not code**

A theme is a flat, serializable token map — never a function. This is the linchpin:

- It crosses the QuickJS ↔ webview JSON-RPC boundary (ADR-0015) with zero ceremony: a theme extension calls `sindri.themes.register(manifest)`; the core forwards the plain object; the webview applies it.
- The built-in **Sindri Dark / Sindri Light** use the *identical* manifest a third party would → the dogfood rule (ADR-0006) holds by construction.
- Applying a theme reduces to two mechanical steps: **(a)** set CSS custom properties on the document root; **(b)** rebuild the CodeMirror 6 `HighlightStyle` + surface theme inside a `Compartment`. Because `styles.css` already consumes `var(--*)` everywhere, the entire chrome re-themes for free.

```ts
interface ThemeDef {
  id: string;                 // "sindri-dark"  (namespaced "publisher.id" for extensions)
  name: string;               // "Sindri Dark"
  kind: "light" | "dark";     // drives [data-theme-kind] + sensible fallbacks
  ui: Record<UiToken, string>;          // chrome: --bg, --accent, --border, …
  glow: Record<GlowToken, string>;      // first-class glow tokens (brand identity)
  editor: Record<EditorToken, string>;  // CM6 surface: bg, fg, caret, selection, gutter…
  syntax: Record<SyntaxToken, TokenStyle>; // keyword/string/comment/… → { color, fontStyle? }
}
```

The exact token catalog lives in [docs/design/theming.md](../design/theming.md) (the single source of truth for token names) so it can evolve without editing this append-only ADR.

### 2. Registry + store mirrors the tool-window pattern

The theme store mirrors `src/workbench/layout.ts` exactly — the proven contribution pattern in this codebase:

- `registerTheme(def)` / `registerIconTheme(def)` populate a `createStore` registry.
- A `src/theme/builtins.ts` registers the day-one themes (peer of `workbench/builtins.ts`).
- Selection state is persisted to `localStorage` (key `sindri:theme`) and restored on startup.

### 3. Dual theme slots: independent UI and editor themes

Selection state carries **two** theme references plus a link flag:

```ts
interface ThemeSelection {
  uiThemeId: string;           // drives the chrome (root CSS vars)
  editorThemeId: string;       // drives the CM6 surface + syntax
  linkEditorToUi: boolean;     // default true → editor follows uiThemeId
  iconThemeId: string;         // drives the file tree (and later, UI icons)
}
// resolved:
const editorTheme = linkEditorToUi ? uiThemeId : editorThemeId;
```

- **Linked (default):** the editor uses the UI theme's `editor` + `syntax` halves. One choice themes everything.
- **Unlinked:** the editor's surface + syntax come from `editorThemeId`; the chrome keeps `uiThemeId`. The CM6 surface tokens (`editor.*`) make the editor self-contained — it does **not** depend on the root CSS vars — so the two can diverge cleanly.

Application mechanics:

- Root: set `[data-theme-kind]` + all `ui`/`glow` CSS vars from `uiThemeId`.
- Editor: build `EditorView.theme(editorTokens)` + `syntaxHighlighting(HighlightStyle.define(syntax))` from the resolved editor theme, held in a `themeCompartment`. On any change, dispatch a `Compartment.reconfigure` to **every open `EditorView`** (the split-pane model already keeps a `Map<GroupId, EditorView>`).

### 4. Icon themes — a peer system, same treatment

An icon theme is likewise **data**: matching rules (in priority order) + SVG sources.

```ts
interface IconThemeDef {
  id: string; name: string;
  kind: "color" | "mono";              // mono renders via CSS mask + currentColor → theme-aware
  fileNames?:   Record<string, IconId>; // exact, e.g. "Cargo.toml", "Dockerfile"
  fileExtensions?: Record<string, IconId>; // "rs", "tsx", "py"
  languageIds?: Record<string, IconId>;    // fallback by language id
  folderNames?: Record<string, IconId>;    // ".git", "node_modules", "src"
  defaults: { file: IconId; folder: IconId; folderOpen: IconId };
  icons: Record<IconId, IconSource>;       // inline SVG or asset ref
  // RESERVED, not implemented in this ADR:
  ui?: Record<UiIconId, IconSource>;       // activity bar / dock / toolbar glyphs (future)
}
```

- **Resolution order** for a file: exact `fileNames` → `fileExtensions` → `languageIds` → `defaults.file`. Folders: `folderNames` → `defaults.folder`/`folderOpen`.
- **Hybrid sourcing** (per the product decision): vendor an MIT-licensed SVG set for broad language brand-mark recognition, *plus* hand-authored Sindri folder + generic icons in the rune aesthetic. Licensing/attribution is tracked with the vendored assets.
- **Monochrome ↔ colour** ships as two registered icon themes ("Sindri Mono" / "Sindri Color"); the toggle switches the active `iconThemeId`. Mono icons render via CSS `mask` + `currentColor`, so they inherit the active theme's text color automatically — theme-aware with no per-theme icon work.
- **UI/product icons are reserved, not built.** The `ui?` field documents where activity-bar / dock / toolbar glyph theming will live so the contract doesn't need a breaking change later. Wiring those glyphs to it is explicitly out of scope here.

### 5. Extension API surface (extends ADR-0015 §4)

Two namespaces are added to the `sindri.*` surface, injected per-manifest like the rest:

```
sindri.themes       register(ThemeDef) · onDidChangeTheme(handler)
                    getActive() · list()
sindri.iconThemes   register(IconThemeDef) · onDidChangeIconTheme(handler)
                    getActive() · list()
```

Consistent with the VSCode `contributes.themes` model, themes/icon-themes are also declarable **statically in the extension manifest** (pure-data contributions need no `activate()` code path) — the host reads the manifest and registers them. Dynamic registration via the API remains available for generated/computed themes. No new permission is required: themes contribute view-model data only, never DOM or `env` access.

### 6. Glow is a first-class token, not ad-hoc CSS

The rune mark's luminance is part of the brand, so glow is tokenized (`--glow-accent`, `--glow-accent-strong`, raw `--glow-color`) rather than sprinkled as literal `box-shadow`s. Active tabs, focus rings, the split-preview, and the welcome logo consume the glow tokens, so a theme tunes (or disables) glow uniformly.

## Consequences

### What we gain

- **Real pluggability, dogfooded.** Built-in themes and icon themes ride the exact public contract; shipping them *is* the proof the API works.
- **UI/editor independence** is a first-class, persisted toggle — a differentiating comfort feature with no architectural cost (two slots + a compartment reconfigure).
- **Live theme switching** across all open editors and the whole chrome, no reload.
- **Theme-aware icons for free** in mono mode via `currentColor`.
- **Forward-compatible icon contract** — UI-icon theming slots in later without breaking existing icon themes.

### Costs / things we accept

- A small vendored SVG icon set enters the repo (with its license) — the hybrid trade for breadth of language recognition.
- Geometry tokens (`--radius`, `--gap`) stay **constant**, not themeable, in this ADR — keeps the contract to color/appearance. Revisit only if a real need appears.
- Two themes must be authored and kept at light/dark parity (enforced by the guide), a standing maintenance item for every new token.

### Deferred

- **UI/product icon theming** (activity bar, dock bars, toolbar) — contract reserved (`IconThemeDef.ui?`), implementation later.
- High-contrast / accessibility theme variants beyond the day-one light/dark.
- Per-workspace theme overrides (selection is global for now; the store seam allows per-workspace later).
- Theme marketplace / discovery UX.

## See also

- [ADR-0006](0006-extension-api-from-day-one.md) — everything-is-an-extension; the dogfood rule this satisfies
- [ADR-0015](0015-js-extension-host-runtime.md) — the `sindri.*` API surface §4 these namespaces extend
- [ADR-0010](0010-dockable-panel-layout.md) — the tool-window registry pattern the theme store mirrors
- [docs/design/theming.md](../design/theming.md) — the token catalog + standing rules for all UI work

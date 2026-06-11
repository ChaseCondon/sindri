# Theming — standing rules & token catalog

> Status: living document. The **single source of truth** for token names and the rules every piece of Sindri UI follows. Decision rationale lives in [ADR-0019](../adr/0019-theme-and-icon-system.md); this is the practical reference you consult when building any UI element.

## The one rule

**Never hard-code an appearance value. Always reference a token.** A color, a glow, a border — if it's visible, it comes from a `var(--*)` (chrome) or a `ThemeDef` field (editor). A literal hex in a component or `styles.css` is a bug: it won't light/dark-switch, won't re-theme, and breaks the UI/editor split.

If you reach for a color that has no token, **add the token to every theme** first (see "Adding a token"), then use it. Do not inline "just this once."

## Token model

A theme has four token groups. Chrome groups become CSS custom properties on the document root; editor groups are applied to the CodeMirror surface via a compartment.

```ts
interface ThemeDef {
  id: string; name: string; kind: "light" | "dark";
  ui:     Record<UiToken, string>;       // → :root CSS vars, consumed by styles.css
  glow:   Record<GlowToken, string>;     // → :root CSS vars, the brand luminance
  editor: Record<EditorToken, string>;   // → CM6 EditorView.theme()
  syntax: Record<SyntaxToken, TokenStyle>; // → CM6 HighlightStyle (lezer tags)
}
type TokenStyle = { color: string; fontStyle?: "italic"; fontWeight?: string };
```

### UI tokens (chrome) → `--<token>`

| Token | Role |
|---|---|
| `--bg` | App canvas (indigo-tinted in dark) |
| `--bg-panel` | Dock panels / menus / raised surfaces |
| `--bg-chrome` | Titlebar, statusbar, tab strip |
| `--bg-hover` | Hover wash (translucent) |
| `--border` | Default 1px separators / panel edges |
| `--border-subtle` | Quieter dividers (chrome edges) |
| `--text` | Primary foreground |
| `--text-dim` | Secondary / inactive foreground |
| `--accent` | Rune-blue — active/selected/brand |
| `--accent-tint` | Translucent accent fill (active chips, selection wash) |
| `--danger` | Destructive actions (delete) |

> Geometry tokens `--radius` and `--gap` are **design constants, not themeable** (per ADR-0019). They live in `:root` but are not part of `ThemeDef`.

### Glow tokens → `--glow-*`

The rune mark's luminance is brand identity, so glow is tokenized, never inlined.

| Token | Role |
|---|---|
| `--glow-color` | Raw RGB triplet for composing custom glows |
| `--glow-accent` | Standard accent glow (active tab underline, focus ring) |
| `--glow-accent-strong` | Emphasised glow (welcome logo, primary CTA, split-preview) |

A theme may set glow values to `none` to ship a flat, glow-free look. Consumers must degrade gracefully when glow is `none`.

### Editor tokens → CM6 surface

| Token | Role |
|---|---|
| `editor.bg` / `editor.fg` | Surface background / default text |
| `editor.caret` | Cursor color |
| `editor.selection` | Selection background |
| `editor.activeLine` | Active line highlight |
| `editor.gutter.bg` / `editor.gutter.fg` | Gutter background / line numbers |
| `editor.gutter.activeFg` | Active line number |
| `editor.matchingBracket` | Matching-bracket highlight |

These make the editor **self-contained**: it renders correctly from its own tokens without reading root CSS vars, which is what lets the editor theme diverge from the UI theme (the UI/editor split below).

### Syntax tokens → lezer highlight tags

Map to `@lezer/highlight` tags. Minimum set every theme must define:

`keyword` · `controlKeyword` · `string` · `number` · `bool`/`null` · `comment` · `function` · `type`/`class` · `variable`/`property` · `operator`/`punctuation` · `tag` · `attribute` · `heading` · `link` · `regexp` · `escape`

Any tag a theme omits falls back to `editor.fg`.

## The UI ↔ editor split

Selection carries two theme slots and a link flag ([ADR-0019](../adr/0019-theme-and-icon-system.md) §3):

- **Linked (default):** editor uses the UI theme's `editor` + `syntax`. One choice themes everything.
- **Unlinked:** chrome stays on `uiThemeId`; the CM6 surface + syntax switch to `editorThemeId`.

**Rule:** chrome components read `--*` vars (the UI theme). Editor-surface appearance comes only from `editor.*`/`syntax` (the resolved editor theme). Never let chrome leak into the editor surface or vice-versa — that coupling breaks the split.

## Light/dark parity

- Every token defined in one built-in theme must be defined in **all** built-in themes. A missing token is a build/review failure, not a runtime fallback we rely on.
- Author for **contrast**: body text aims for WCAG AA (≥ 4.5:1) against its background; large/dim text ≥ 3:1. The accent must be legible on both `--bg` and `--bg-panel`.
- Test both themes whenever you touch UI. A change that only looks right in dark mode is half-done.

## Adding a token

1. Add the key to the relevant group's type in `src/theme/tokens.ts`.
2. Give it a value in **every** built-in `ThemeDef` (`src/theme/builtins.ts`).
3. Add a row to the catalog above.
4. Consume it via `var(--token)` (chrome) or the theme field (editor). Never inline.

## Icons

- Icon themes are **data**, peer to color themes ([ADR-0019](../adr/0019-theme-and-icon-system.md) §4): matching rules (`fileNames` → `fileExtensions` → `languageIds` → `defaults`) + SVG sources.
- **Monochrome** icons render via CSS `mask` + `currentColor` → they inherit the surrounding text token automatically and stay theme-aware with no per-theme work. **Coloured** icons use their own SVG fills.
- Mono vs colour is a theme choice: switch the active `iconThemeId` (we ship "Sindri Mono" / "Sindri Color").
- **UI/product icons** (activity bar, dock bars, toolbar) are **reserved** in the contract (`IconThemeDef.ui?`) but not yet themed — they remain literal glyphs for now. When that lands, the same token-first rule applies: no hard-coded UI glyphs once `ui` icons exist.

## Brand palette (rune-stone, starting values)

Derived from `sindri_icons.png`. Starting points — tune for parity/contrast, don't treat as frozen.

| Token | Dark | Light |
|---|---|---|
| `--accent` | `#5BA9FF` | `#2E6FD6` |
| `--glow-accent` | `0 0 8px rgba(91,169,255,.45)` | `0 0 6px rgba(46,111,214,.30)` |
| `--bg` | `#0A0D16` | `#F7F8FB` |
| `--bg-panel` | `#12172B` | `#FFFFFF` |
| `--border` | `#1E2433` | `#DDE1E8` |
| `--text` | `#CDD3DE` | `#1B2230` |
| `--text-dim` | `#6B7585` | `#6B7585` |

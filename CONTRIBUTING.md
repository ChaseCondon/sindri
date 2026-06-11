# Contributing to Sindri

## Extension system overview

Sindri is built on a dogfood rule (ADR-0006): every IDE capability ships as an extension on the same public API available to third parties. This document explains the two parts of that system that are relevant for contributors today: **configuration** (ADR-0023) and **editor decorations** (ADR-0024).

---

## Where extensions live

### Bundled (first-party, compiled into the app)

Located in [`core-extensions/`](core-extensions/). Each sub-folder is an extension:

```
core-extensions/
  bundled-extensions.json          ← index consumed by the app at startup
  sindri-dark/                     ← colour theme extension
    manifest.json
    dark.json
  sindri-editor-decorations/       ← rainbow brackets + indent guides
    manifest.json
  …
```

Bundled extensions have no runtime JS of their own — they contribute **data** (theme JSON, configuration schemas, editor decoration IDs) that the core app wires up directly. There is no code to execute: the implementation lives in the core TypeScript source.

### Installed (third-party, fetched from a registry)

Installed extensions are fetched from git registries (ADR-0020). They are stored in `localStorage` as `InstalledRecord[]` in the `sindri:settings` key. Code-bearing extensions (those with a `main` field in their manifest) will be executed by the QuickJS host once that lands — for now they can only contribute data (themes, icons, configuration schemas).

---

## The manifest contract

Every extension — bundled or installed — is described by an `ExtensionManifest` (see [`src/extensions/manifest.ts`](src/extensions/manifest.ts)). The relevant `contributes` keys are:

| Key | Requires host? | Description |
|---|---|---|
| `themes` | No | Colour theme definitions |
| `iconThemes` | No | File icon theme definitions |
| `uiIconPacks` | No | Activity bar / toolbar icon packs |
| `configuration` | No | Settings schema — rendered generically by the Settings modal |
| `editorDecorations` | No (Model A) / Yes (Model B) | CodeMirror decoration features |
| `lsp`, `dap`, `grammars`, `taskAdapters`, `panels` | Yes | Future (requires QuickJS host) |

---

## `contributes.configuration` — settings schema (ADR-0023)

### Schema shape

```jsonc
"contributes": {
  "configuration": {
    // Where in the Settings nav this section appears.
    // Omit → "Extensions > <extension name>"
    "navSection": { "group": "Appearance", "label": "Editor", "order": 1 },

    // Flat map of fully-qualified dotted setting IDs → field definitions.
    // Key namespace: first-party core extensions may use reserved roots
    // (editor.*, workbench.*, files.*); third-party must use <extensionId>.*
    "schema": {
      "editor.rainbowBrackets": {
        "type": "boolean",         // "boolean" | "string" | "number" | "enum"
        "default": true,           // REQUIRED — the value when no user override exists
        "groupTitle": "Rainbow Brackets",  // renders a <h3> before this field
        "title": "Enabled",        // row label (overrides auto-generated key label)
        "description": "Colour bracket pairs by nesting depth.",
        "order": 0                 // sort order within the section
      },
      "editor.indentGuides.style": {
        "type": "enum",
        "default": "monochrome",
        "title": "Style",
        "enum": ["monochrome", "rainbow"],
        "enumLabels": ["Monochrome", "Rainbow"],
        "presentation": "radio",   // "dropdown" (default) | "radio"
        "when": "editor.indentGuides.enabled",  // show only if this key is truthy
        "order": 2
      }
    }
  }
}
```

### Field types and controls

| `type` | Extra fields | Rendered as |
|---|---|---|
| `boolean` | — | Checkbox |
| `enum` | `enum`, `enumLabels`, `presentation` | `<select>` or radio group |
| `string` | — | Text input |
| `number` | `minimum`, `maximum`, `step` | Number input |

### `groupTitle` — visual sub-sections

When a field has `groupTitle`, the Settings modal renders a `<h3>` heading before that field. A new heading is only rendered when `groupTitle` **changes** between consecutive fields (sorted by `order`). Use this to group related settings under a clear label:

```
## Editor
### Rainbow Brackets
  [✓] Enabled — "Colour bracket pairs..."
### Indent Guides
  [✓] Enabled — "Show vertical..."
       ● Monochrome  ○ Rainbow
```

### Storage contract

- All user overrides are stored flat in `localStorage["sindri:config"]` keyed by fully-qualified setting ID.
- Only **overrides** are stored — a key absent from the map resolves to its `default`.
- Setting a value equal to its `default` removes the override (keeps storage clean).
- Read: `configStore.get<T>("editor.rainbowBrackets")` → reactive in SolidJS components.
- Write: `configStore.set("editor.rainbowBrackets", false)` → persists + emits change event.

---

## `contributes.editorDecorations` — CodeMirror features (ADR-0024)

### Model A — static bundled features (today)

Each entry in `editorDecorations` names a feature that the **core factory table** in [`src/editor/decoration-registry.ts`](src/editor/decoration-registry.ts) knows how to build:

```jsonc
"editorDecorations": [
  {
    "id": "rainbow-brackets",          // must match a key in DECORATION_FACTORIES
    "title": "Rainbow Brackets",
    "configKeys": ["editor.rainbowBrackets"]  // which config keys rebuild this feature
  }
]
```

The factory table maps `id → (configReader) → CM6 Extension`:

```ts
// src/editor/decoration-registry.ts
const DECORATION_FEATURES = [
  {
    id: "rainbow-brackets",
    compartment: new Compartment(),
    configKeys: ["editor.rainbowBrackets"],
    build() {
      return configStore.get<boolean>("editor.rainbowBrackets")
        ? Prec.lowest(rainbowBrackets)
        : [];
    },
  },
  // …
];
```

**Adding a new bundled decoration feature:**
1. Write the CM6 `ViewPlugin` (e.g., `src/editor/my-feature.ts`).
2. Add a config schema entry to `EDITOR_DECORATIONS_SCHEMA` in `configStore.ts`.
3. Add a `DecorationFeature` entry to `DECORATION_FEATURES` in `decoration-registry.ts`.
4. Add an `editorDecorations` entry in `core-extensions/sindri-editor-decorations/manifest.json`.
5. `bun run build` to verify.

### Model B — host decoration-providers (future, requires QuickJS)

For installed code-bearing extensions, the `sindri.editor` API will expose `registerDecorationProvider`. This passes **decoration data** (ranges + CSS classes) over IPC to a single generic core `ViewPlugin` — extensions never touch CodeMirror or the DOM directly. This is not built yet.

---

## The config-change → editor wiring

```
User changes a setting
  → configStore.set(key, value)
    → _setOverrides(key, value)   (reactive Solid store → UI updates)
    → persist() to localStorage
    → emit([key])
      → features.ts subscription fires
        → applyChangedDecorations(changedKeys, getAllEditorViews())
          → for each feature whose configKeys ∩ changedKeys ≠ ∅:
              compartment.reconfigure(feature.build())
            dispatched to every open EditorView
```

`features.ts` is imported as a side-effect from `App.tsx` to register the subscription at startup. The subscription persists for the app's lifetime.

---

## Adding a new setting to an existing extension

1. Add the field to `contributes.configuration.schema` in the extension's `manifest.json`.
2. If it's the bundled editor-decorations extension, also update `EDITOR_DECORATIONS_SCHEMA` in [`src/workbench/settings/configStore.ts`](src/workbench/settings/configStore.ts) (the two must stay in sync — the manifest is the source of truth for documentation; the TypeScript constant is what the running app uses).
3. Read it anywhere with `configStore.get<MyType>("my.setting.key")`.
4. The Settings modal auto-renders the new field — no UI code needed.

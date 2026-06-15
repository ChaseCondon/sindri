# ADR-0032: Extension templates & inheritance — `extends` + `variables`, CSS-custom-property SVG templates

- **Status:** Accepted — 2026-06-11 · §6 superseded by [ADR-0038](0038-manifest-type-and-id-resolution.md); §5 reaffirmed there
- **Follows from:** [ADR-0019](0019-theme-and-icon-system.md) (theme/icon-as-data) · [ADR-0020](0020-extension-distribution-and-marketplace.md) (manifest, packs, registries) · [ADR-0031](0031-resource-url-scheme.md) (bundle-dir registration)
- **Phase:** 1.5n — Extension author DX (community-theme-icons as reference implementation)

> **Addendum (2026-06-15, [ADR-0038](0038-manifest-type-and-id-resolution.md)):** §6's typed `{id,path}` buckets are replaced by a flat `entries: [{ id, path, type }]` list, and "the base is a standalone installable entry" is reversed — a base is now `type: "template"` (resolvable by id, **not** installable, hidden from browse). §5's by-id resolution is reaffirmed and finally implemented (the shipped `discoverMembers` path-guessing is removed).

---

## Context

The community theme collection ships **15 icon-theme extensions** (`sindri-dracula-icons`, `sindri-nord-icons`, …). Today each is fully **self-contained**: every one carries its own `icons/` directory (~50 generated SVGs) and a ~300-line `icons.json` mapping. The *only* difference between them is the **palette** — `generate-icons.ts` stamps identical geometry across all 15 from a per-theme `palette.json` (see [scripts/generate-icons.ts](../../../sindri-extensions/scripts/generate-icons.ts) `IconPalette` + `SLOT`).

This is duplication by construction:

- ~50 SVGs × 15 themes = **~750 generated SVG files**, byte-identical in shape, differing only in hard-coded `fill` hex values.
- A geometry fix (one folder-path tweak) must be regenerated into all 15.
- Adding one folder-name mapping edits 15 copies of `icons.json`.

Two product forces make this worth fixing now rather than tolerating:

1. **A theme is data, not code (ADR-0019 §1).** The same DNA should let an icon theme *derive* from a shared base instead of copy-pasting it. This is the icon-theme analogue of "theme-as-data."
2. **`extends` is the natural author DX.** A third party who wants "Dracula but my brand purple" should write a 10-line manifest declaring a palette, not fork 50 SVGs. The contract must make derivation first-class.

### Constraints

- **Previewability must survive.** An SVG asset in a repo must still render correctly when opened standalone (GitHub preview, Finder Quick Look, a browser). A template that renders as a blank/black icon outside Sindri is unacceptable.
- **One active icon theme at a time** (ADR-0019 §3 `iconThemeId`) — variable injection can be global; it doesn't need per-icon scoping.
- **Pack references already exist** (ADR-0020 §2 `extensionPack`) and may point at extensions in *other* registries; `extends` adds a second kind of cross-extension reference and must resolve the same way.
- **No host dependency.** Icon themes are data-only (ADR-0019 §5, ADR-0020 §7) — templating must stay in the data/activation path, not require the JS extension host.

---

## Decision

### §1. `extends` — base-extension inheritance

A new optional manifest field declares a parent extension:

```jsonc
{
  "id": "sindri.dracula-icons",
  "extends": "sindri.community-icons-base",   // publisher.extensionName (ADR-0013/0020)
  "variables": { /* §2 */ },
  "contributes": { "iconThemes": [{ "id": "sindri-dracula-icons", "name": "Dracula Icons", "kind": "color", "path": "icons.json" }] }
}
```

- `extends` is a single extension **id**, resolved through the registry index exactly like a pack member (§5).
- The child **inherits all assets** of the base (its `icons/` SVGs and `icons.json`), then applies its own `variables` and any local overrides (§3).
- **Single inheritance, depth-1.** A base may not itself `extends` another extension. Chains are rejected at validation. (Revisit only if a real need appears — multi-level inheritance multiplies merge ambiguity for no current use case.)
- **Scope:** `extends` is honoured **only for icon-theme extensions** in this ADR (§8). The field is reserved-but-inert elsewhere.

### §2. `variables` — palette/token inputs

A new optional manifest field supplies a flat map of token → value:

```jsonc
"variables": {
  "folder-base": "#44475a",
  "semantic-1":  "#8be9fd",
  "semantic-2":  "#50fa7b",
  "semantic-3":  "#ff5555",
  "semantic-4":  "#ffb86c"
}
```

- Keys are **CSS-custom-property names without the `--` prefix**; values are any valid CSS color.
- The **base extension declares the schema + defaults** (the canonical set of variable keys and their fallback values); a child supplies overrides. A child variable whose key is not declared by the base is a validation warning (ignored at runtime).
- This is the only input a derived icon theme *needs* — geometry and mappings come from the base.

> **Palette narrowing vs. today's generator.** The current `IconPalette` has nine semantic color slots (`blue`, `yellow`, … `amber`) because *every* language icon is theme-tinted. The new model (§ below + Step 3 generator redesign) tints **only folders and semantic/system file icons** from the palette; **language-logo icons use fixed canonical brand colors** and take no variable input. So the base's `variables` schema collapses to `folder-base` + a small `semantic-*` set, not the full nine-slot palette.

### §3. Template format & merge rules

**SVG templates use CSS custom properties with a fallback:**

```svg
<!-- base icons/folder.svg -->
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.17l2 3H20a2 2 0 0 1 2 2z"
        fill="var(--folder-base, #6272a4)"/>
</svg>
```

- The `var(--token, #fallback)` form is a **valid, previewable SVG**: opened standalone (no variable defined) it renders the fallback color. This satisfies the previewability constraint — the template *is* a real icon, not a placeholder.
- **Language-logo SVGs carry hard-coded brand colors**, no `var()` — TypeScript `#3178c6`, Rust `#ce4a1f`, etc. They are not templated.

**Asset merge (child-wins, whole-file override):**

| Asset | Rule |
|---|---|
| SVG file with the same filename present in both base and child | **child fully replaces** the base file (no per-path SVG merging) |
| SVG file present only in base | inherited as-is |
| `icons.json` | **deep-merged, child-wins on field conflicts** (child can add/override `fileExtensions`, `folderNames`, `icons`, etc.) |

Whole-file override (not SVG-internal patching) keeps the rule trivially predictable: an author who wants a different folder shape drops a `folder.svg` into the child; everything else stays inherited.

### §4. Variable injection mechanics

At icon-theme **activation**, the runtime resolves the effective variable map (`base defaults ⊕ child variables`) and injects it as a global stylesheet:

```html
<style id="sindri-icon-vars">:root { --folder-base:#44475a; --semantic-1:#8be9fd; … }</style>
```

Because exactly one icon theme is active (ADR-0019 §3), a single global `:root` block is sufficient; switching themes replaces the block's contents.

> **⚠️ Templated SVGs must be inlined, not `<img src>`.** CSS custom properties cascade through the DOM but **do not** cross into an image document loaded via `<img>` / `background-image`. For `var(--folder-base, …)` to pick up the injected value, the file-tree color icons must be **inlined `<svg>` in the DOM** (mono icons already inline-via-mask per ADR-0019 §4). Any icon delivered as a detached image resource would only ever show its fallback color. This is the one real implementation constraint the template model imposes on the renderer.

### §5. Cross-extension reference resolution (`extends` + pack members)

`extends` and `extensionPack` entries resolve identically against the configured registries (ADR-0020 §3 index):

- **String id** (`"sindri.community-icons-base"`) = search **all configured registries in priority order**; first match wins. Within a single registry, ids are **unique** (ADR-0013/0020 `publisher.extensionName` namespacing makes collisions across publishers impossible; within a publisher the author owns uniqueness).
- **Object pin** (`{ "id": "acme.base", "registry": "https://…" }`) = resolve **only** in the named registry. Use when an id legitimately exists in multiple registries and the author wants a specific one.
- **Unresolved remote reference** is serialised into the generated `index.json` as `{ "id": "acme.base", "remote": true }`. The marketplace UI **warns** ("requires acme.base from another registry") rather than hard-failing the listing.

### §6. `index.json` shape — typed buckets

The flat `extensionFolders` array is replaced by **classified buckets** so the marketplace and the resolver don't re-derive structure by tree-walking:

```jsonc
{
  "name": "Sindri Sample Extensions",
  "extensions": [                                  // standalone leaf extensions (NOT pack members)
    { "id": "sindri.community-icons-base", "path": "community-theme-collection/sindri-community-icons-base" }
  ],
  "packs": [                                        // have extensionPack; members resolved by id
    { "id": "sindri.community-theme-collection", "path": "community-theme-collection" }
  ],
  "collections": []                                 // reserved: packs-of-packs (e.g. a curated bundle)
}
```

- `extensions`: standalone leaves only. Pack members are **not** listed here.
- `packs`: anything with `extensionPack` in its manifest; members are discovered by following the ids, resolved via §5. Sub-extensions are not duplicated as top-level entries.
- The base extension (`sindri.community-icons-base`) **is** a standalone `extensions` entry — it is installable on its own and is the `extends` target of the 15 derived themes.
- `build-index.ts` walks **top-level dirs only**, classifies by `manifest.categories` / presence of `extensionPack`, and emits this shape. `index.json` stays generated, never hand-edited.

> **Relation to ADR-0020 §3.** ADR-0020 assumed "each extension is a top-level folder." The community collection nests members under a pack folder. This ADR makes the **`index.json` buckets authoritative** for listing/resolution; the on-disk folder nesting is an authoring convenience the generator flattens into ids. No tree-walk at runtime — the index is the contract.

### §7. `sindri.extensionHost.relaxedPackValidation` — dev flag

A dev-only setting (default **off**):

- **Off (default / production):** a missing `extends` target or pack member is a **hard validation error** — the extension fails to load.
- **On (development):** missing members **degrade to a warning**; the extension loads with what's resolvable. Lets an author iterate on one theme without every sibling present.

### §8. Scope boundary

**Community theme-**icon** extensions are the sole reference implementation.** `extends` / `variables` / template SVGs are honoured for **icon-theme** extensions only. Color themes, code extensions, and every other type are **unchanged** — they ignore these fields. Generalising inheritance to other extension types is explicitly deferred until a second concrete use case exists.

---

## Consequences

### What we gain

- **~750 generated SVGs → ~50.** One base set of templates; 15 children carry only a ~10-line palette each. A geometry fix lives in one place.
- **First-class author DX for derived themes** — "X but my palette" is a manifest, not a fork. Dogfooded by the 15-theme collection riding the exact public `extends` contract.
- **Previewable templates** — the `var(--token, #fallback)` form renders correctly in any SVG viewer, so the repo's icons stay browsable on GitHub.
- **Predictable merges** — whole-file override + child-wins `icons.json` has no surprising partial-merge semantics.
- **One resolution model** for both `extends` and pack members (§5), reused from ADR-0020.

### Costs / things we accept

- **Renderer constraint:** templated color icons **must be inlined** in the DOM (§4). Any future "load icon as `<img>`" optimization is incompatible with templated icons and would silently fall back to default colors.
- **Activation-time resolution:** the child's effective `icons.json` + asset set is materialised at activation (base ⊕ child), a small extra step versus reading a self-contained theme.
- **Single-level inheritance only** — no base-extends-base chains; revisit if needed.
- **`index.json` schema change** — `extensionFolders` consumers (the rehydrate/marketplace path) must read the new buckets. One-time migration.

### Deferred

- **Inheritance for non-icon extension types** (§8) — until a second use case.
- **Multi-level / multiple inheritance** — depth-1, single-parent for now.
- **`variables` typing beyond color** (numbers, sizes, enums) — current need is palette colors only.
- **Per-workspace variable overrides** — global, mirroring ADR-0019's global selection.
- **A Theme Creator UX** (live palette editor writing `variables`) — roadmap Phase 2; this ADR is the data contract it would target.

---

## See also

- [ADR-0019](0019-theme-and-icon-system.md) — theme/icon-as-data; `IconThemeDef`, resolution order, one-active-icon-theme, mono-via-mask (why inlining already exists)
- [ADR-0020](0020-extension-distribution-and-marketplace.md) — manifest `contributes`/`categories`, `extensionPack`, git-repo registries + generated `index.json` (§3 this ADR amends), `publisher.extensionName` namespacing
- [ADR-0031](0031-resource-url-scheme.md) — bundle-dir registration at activation, the same hook where the resolved variable map is computed
- [scripts/generate-icons.ts](../../../sindri-extensions/scripts/generate-icons.ts) — the generator that Step 3 redesigns to emit base templates instead of 15 stamped copies
